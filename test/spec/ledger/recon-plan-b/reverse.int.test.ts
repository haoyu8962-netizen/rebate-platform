// B2-17 reversal of a form that linked recon diffs (claude-independent): BR-FUND-24 ⑨ 「红冲该调账单时同一
// 事务把差错单退回 processing」 and 细则「对外差错单的调账」(红冲某张调账单时，同一事务把差错单由 adjusted
// 退回 processing（已是 processing 的不变），之后可为该用户再按本条另开新单), with §9.3 ⑥⑦⑧⑯ of the task:
// the reversal marks every link row of the original (reversed_by_adjust_id = the reversal), takes no
// link of its own (its refs stay []); an original without link rows (filed before the migration;
// kit seedForm) touches no diff (台账补丁 1 and 本线补全的默认); when another open / processing
// ledger_mismatch of the same (app, type, ref_id) exists the earlier diff stays adjusted (D10-3191 ⑤,
// index recon_diffs_unresolved_internal_key of migration 0152).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  fixture,
  member,
  seedForm,
  suite,
  withAdjustAdmin,
  type AdjustFixture,
} from '../admin-adjustments/kit.ts';
import type { DiffRow } from '../admin-recon-diffs/kit.ts';
import {
  diffNow,
  diffRef,
  expectNowAdjusted,
  expectNowProcessing,
  expectSentBack,
  expectUnchanged,
  fileOk,
  linkOf,
  linksOf,
  reverseOk,
  schemaReady,
  seedTicket,
  sortedLinks,
  tick,
} from './kit.ts';

const s = suite();

/** Concludes a processing diff the way closing or writing off leaves it. */
async function conclude(
  f: AdjustFixture,
  id: string,
  status: 'closed' | 'written_off',
): Promise<void> {
  const at = f.clock.now();
  const result = await f.db
    .updateTable('recon_diffs')
    .set({ status, closed_at: at, updated_at: at })
    .where('app_id', '=', f.appId)
    .where('id', '=', id)
    .where('status', '=', 'processing')
    .executeTakeFirst();
  expect(result.numUpdatedRows, `差错单 ${id} → ${status}`).toBe(1n);
}

it('[AC-B2-17#12] 红冲一张关联了两张差错单的调账单 → 200；同一事务里它的每行关联写上 reversed_by_adjust_id = 红冲单号，两张 adjusted 的差错单退回 processing（closed_at 置空、updated_at = 时钟、handler_id 不变）；红冲单 refs 仍为 []、没有关联行；之后同一会员再提交一张 → 再次 adjusted', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const userId = await member(f, { available: 1000n });
    const diffs = [await seedTicket(f), await seedTicket(f, { status: 'processing' })];
    const original = await fileOk(f, h, { userId, refs: diffs.map(diffRef) });
    const filedAt = f.clock.now();
    const adjusted: DiffRow[] = [];
    for (const diff of diffs) adjusted.push(await expectNowAdjusted(f, diff, h.maker.id));
    tick(f);

    const colleague = await h.caller(['fund.adjust']);
    const reversal = await reverseOk(f, h, original.row, colleague);
    expect(reversal.row.refs).toEqual([]);
    const id = original.row.adjust_id;
    const mark = reversal.row.adjust_id;
    const marked = diffs.map((diff) => linkOf(f, id, diff.id, userId, mark, filedAt));
    expect(await linksOf(f)).toEqual(sortedLinks(marked));
    const back: DiffRow[] = [];
    for (const row of adjusted) back.push(await expectSentBack(f, row));
    expect(back.map((row) => row.handler_id)).toEqual([h.maker.id, h.maker.id]);
    tick(f);

    const refs = [diffRef(diffs[0]!)];
    const again = await fileOk(f, h, { userId, refs, caller: colleague });
    await expectNowAdjusted(f, back[0]!, colleague.id);
    await expectUnchanged(f, back[1]!);
    const fresh = linkOf(f, again.row.adjust_id, diffs[0]!.id, userId);
    expect(await linksOf(f)).toEqual(sortedLinks([...marked, fresh]));
  });
});

it('[AC-B2-17#13] 红冲时关联的差错单不在 adjusted（processing、closed、written_off）→ 红冲照常 200、关联行照常写上 reversed_by_adjust_id，差错单整行不变', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    for (const status of ['processing', 'closed', 'written_off'] as const) {
      const u1 = await member(f, { available: 1000n });
      const u2 = await member(f, { available: 1000n });
      const diff = await seedTicket(f, { users: [u1, u2] });
      const original = await fileOk(f, h, { userId: u1, refs: [diffRef(diff)] });
      const filedAt = f.clock.now();
      await expectNowProcessing(f, diff);
      tick(f);
      if (status !== 'processing') await conclude(f, diff.id, status);
      const before = await diffNow(f, diff.id);
      expect(before.status, status).toBe(status);

      const reversal = await reverseOk(f, h, original.row);
      await expectUnchanged(f, before);
      const id = original.row.adjust_id;
      const mark = reversal.row.adjust_id;
      const links = (await linksOf(f)).filter((row) => row.recon_diff_id === diff.id);
      expect(links, status).toEqual([linkOf(f, id, diff.id, u1, mark, filedAt)]);
      tick(f);
    }
  });
});

it('[AC-B2-17#14] 名单 U1、U2 都调过（adjusted）后红冲 U1 那张：差错单 adjusted → processing，U2 的关联行不变；U1 再提交一张 → 再次 adjusted', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const u1 = await member(f, { available: 1000n });
    const u2 = await member(f, { available: 1000n });
    const diff = await seedTicket(f, { users: [u1, u2] });
    const refs = [diffRef(diff)];
    const first = await fileOk(f, h, { userId: u1, refs });
    const firstAt = f.clock.now();
    tick(f);
    const second = await fileOk(f, h, { userId: u2, refs });
    const secondAt = f.clock.now();
    const adjusted = await diffNow(f, diff.id);
    expect(adjusted.status).toBe('adjusted');
    tick(f);

    const reversal = await reverseOk(f, h, first.row);
    const back = await expectSentBack(f, adjusted);
    const mark = reversal.row.adjust_id;
    const u1Link = linkOf(f, first.row.adjust_id, diff.id, u1, mark, firstAt);
    const u2Link = linkOf(f, second.row.adjust_id, diff.id, u2, null, secondAt);
    expect(await linksOf(f)).toEqual(sortedLinks([u1Link, u2Link]));
    tick(f);

    const again = await fileOk(f, h, { userId: u1, refs });
    await expectNowAdjusted(f, back, h.maker.id);
    const fresh = linkOf(f, again.row.adjust_id, diff.id, u1);
    expect(await linksOf(f)).toEqual(sortedLinks([u1Link, u2Link, fresh]));
  });
});

it('[AC-B2-17#15] 没有关联行的原单（迁移前执行的调账单，直接种入）被红冲：照主干成功，refs 里的差错单号在库里不存在、存在且 adjusted、存在且 open 三种情形都不动任何差错单，也不产生关联行', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const userId = await member(f, { available: 1000n });
    const adjusted = await seedTicket(f, { status: 'adjusted' });
    const open = await seedTicket(f);
    for (const refId of [randomUUID(), adjusted.id, open.id]) {
      const original = await seedForm(f, {
        userId,
        direction: 'increase',
        amount: 200n,
        refs: [{ ref_type: 'recon_diff', ref_id: refId }],
      });
      await reverseOk(f, h, original);
      await expectUnchanged(f, adjusted);
      await expectUnchanged(f, open);
      expect(await linksOf(f), refId).toEqual([]);
      tick(f);
    }
  });
});

it('[AC-B2-17#16] 红冲时同一（app、type、ref_id）已另有未解决的 ledger_mismatch 差错单（open 或 processing）：红冲照常 200、关联行照常写上 reversed_by_adjust_id，前一张保持 adjusted（整行不变），新的那张不变；没有这样的另一张时照常退回 processing', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    for (const next of ['open', 'processing', null] as const) {
      const userId = await member(f, { available: 1000n });
      const refId = `01:${randomUUID()}`;
      const ref = { refType: 'ledger_account', refId } as const;
      const earlier = await seedTicket(f, { ...ref, period: '2026-11-27' });
      const original = await fileOk(f, h, { userId, refs: [diffRef(earlier)] });
      const filedAt = f.clock.now();
      const adjusted = await expectNowAdjusted(f, earlier, h.maker.id);
      const period = '2026-11-28';
      const newer = next === null ? null : await seedTicket(f, { ...ref, status: next, period });
      tick(f);

      const reversal = await reverseOk(f, h, original.row);
      if (newer === null) {
        await expectSentBack(f, adjusted);
      } else {
        await expectUnchanged(f, adjusted);
        await expectUnchanged(f, newer);
      }
      const id = original.row.adjust_id;
      const mark = reversal.row.adjust_id;
      const links = (await linksOf(f)).filter((row) => row.recon_diff_id === earlier.id);
      expect(links, String(next)).toEqual([linkOf(f, id, earlier.id, userId, mark, filedAt)]);
      tick(f);
    }
  });
});
