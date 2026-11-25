// B2-17 diffs that have their own handling entry (claude-independent): BR-FUND-24 ⑨ and 细则「对外差错单的
// 调账」 with §12.3 of the task (编排 D10-3237 (五), D10-3239): only ledger_mismatch diffs take part in
// plan B (status CAS, link rows, 20902 recon_diff, one form per (diff, member)); platform_restore and
// appeal_restore (handled by the restore entry, BR-FUND-22) and blacklist_after_credit (the
// blacklist clawback) keep the behaviour from before: a manual adjustment only checks that such a
// diff exists in the app, changes none of its columns, takes no link row for it and is never
// refused for its status or for earlier adjustments; afterwards the restore entry still handles a
// platform_restore diff as if it had never been linked. Each request also links a ledger_mismatch
// diff, which goes adjusted with one link row (§9.3 ①). Fixtures: ../admin-adjustments/kit.ts and,
// for the restore entry, ../../settlement/platform-restore/kit.ts (imported, unchanged).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  executed,
  fixture,
  member,
  suite,
  withAdjustAdmin,
  type AdjustFixture,
  type Ref,
} from '../admin-adjustments/kit.ts';
import {
  expectAdjusted as expectPlatformRestored,
  fixture as restoreFixture,
  orderRow,
  platformRestored,
  seedBareOrder,
  seedPlatformDiff,
  withRestoreAdmin,
} from '../../settlement/platform-restore/kit.ts';
import {
  diffRef,
  expectNowAdjusted,
  expectSentBack,
  expectUnchanged,
  fileOk,
  linkOf,
  linksOf,
  reverseOk,
  schemaReady,
  seedTicket,
  send,
  sortedLinks,
  tick,
  type DiffStatus,
  type Filing,
  type LinkRow,
} from './kit.ts';

const s = suite();

/** The types with an entry of their own, with the source of their registrar. */
const SPECIAL = [
  { type: 'platform_restore', source: 'R1' },
  { type: 'appeal_restore', source: 'R3' },
  { type: 'blacklist_after_credit', source: 'R3' },
] as const;
type Special = (typeof SPECIAL)[number];

/** A diff of such a type on a sub-order of the fixture's app. */
function seedSpecial(f: AdjustFixture, kind: Special, status: DiffStatus = 'open') {
  return seedTicket(f, {
    type: kind.type,
    source: kind.source,
    refType: 'order',
    refId: `taobao:${randomUUID()}`,
    status,
  });
}

/** An OTHER increase of 100 (COMMISSION_REVENUE) of the member linking `refs`. */
function otherOf(userId: string, refs: readonly Ref[]): Filing {
  return { userId, refs, reason: 'OTHER' };
}

it('[AC-B2-17#44] OTHER 调账关联一张 open 的 platform_restore（R1）、appeal_restore（R3）、blacklist_after_credit（R3）差错单与一张 ledger_mismatch → 200、记账照主干；这类差错单整行不变、没有关联行，ledger_mismatch 那张置 adjusted、一行关联；同一会员对同一张这类差错单再提交一张（另配一张 ledger_mismatch）→ 仍 200（不是 20902），它仍整行不变', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const expected: LinkRow[] = [];
    for (const kind of SPECIAL) {
      const userId = await member(f, { available: 1000n });
      const target = await seedSpecial(f, kind);
      for (const round of [1, 2]) {
        const fix = await seedTicket(f);
        const pair = [diffRef(target), diffRef(fix)];
        const refs = round === 1 ? pair : [...pair].reverse();
        const done = await fileOk(f, h, otherOf(userId, refs));
        await expectUnchanged(f, target);
        await expectNowAdjusted(f, fix, h.maker.id);
        expected.push(linkOf(f, done.row.adjust_id, fix.id, userId));
        const label = `${kind.type} #${round}`;
        expect(await linksOf(f), label).toEqual(sortedLinks(expected));
        tick(f);
      }
    }
  });
});

it('[AC-B2-17#45] 关联一张已 closed（或已 adjusted）的 platform_restore / appeal_restore / blacklist_after_credit 差错单（同请求另关联一张 open 的 ledger_mismatch）→ 200（只核它存在），它整行不变、没有关联行；ledger_mismatch 那张置 adjusted', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const expected: LinkRow[] = [];
    for (const kind of SPECIAL) {
      for (const status of ['closed', 'adjusted'] as const) {
        const userId = await member(f, { available: 1000n });
        const target = await seedSpecial(f, kind, status);
        const fix = await seedTicket(f);
        const done = await fileOk(f, h, otherOf(userId, [diffRef(target), diffRef(fix)]));
        await expectUnchanged(f, target);
        await expectNowAdjusted(f, fix, h.maker.id);
        expected.push(linkOf(f, done.row.adjust_id, fix.id, userId));
        const label = `${kind.type} ${status}`;
        expect(await linksOf(f), label).toEqual(sortedLinks(expected));
        tick(f);
      }
    }
  });
});

it('[AC-B2-17#46] 同一请求关联一张这类差错单与一张 ledger_mismatch → 200，ledger_mismatch 置 adjusted、一行关联，这类差错单整行不变、没有关联行；红冲这张调账单 → ledger_mismatch 那张退回 processing、关联行写上红冲单号，这类差错单仍不变', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    for (const kind of SPECIAL) {
      const userId = await member(f, { available: 1000n });
      const target = await seedSpecial(f, kind);
      const fix = await seedTicket(f);
      const original = await fileOk(f, h, otherOf(userId, [diffRef(fix), diffRef(target)]));
      const filedAt = f.clock.now();
      const adjusted = await expectNowAdjusted(f, fix, h.maker.id);
      await expectUnchanged(f, target);
      tick(f);

      const reversal = await reverseOk(f, h, original.row);
      await expectSentBack(f, adjusted);
      await expectUnchanged(f, target);
      const mark = reversal.row.adjust_id;
      const ids = [fix.id, target.id];
      const links = (await linksOf(f)).filter((row) => ids.includes(row.recon_diff_id));
      const expected = [linkOf(f, original.row.adjust_id, fix.id, userId, mark, filedAt)];
      expect(links, kind.type).toEqual(expected);
      tick(f);
    }
  });
});

it('[AC-B2-17#47] 人工调账关联过一张 platform_restore 差错单（同请求另关联一张 ledger_mismatch，后者 adjusted）之后，恢复入口照常处理它：VOID（PAID）订单回到 ESTIMATED、restored_fen 0、差错单由恢复入口置 adjusted（handler 为恢复操作人），与没有被关联过时相同，不是 20902 recon_diff', async () => {
  const rf = await restoreFixture(s);
  await schemaReady(rf.db);
  const order = await seedBareOrder(rf, { platformStatus: 'PAID' });
  const userId = order.userId!;
  const target = await seedPlatformDiff(rf, order);
  const fix = await seedTicket(rf);

  await withAdjustAdmin(rf, async (h) => {
    const filing = otherOf(userId, [diffRef(target), diffRef(fix)]);
    const done = await executed(await send(h, filing));
    await expectUnchanged(rf, target);
    await expectNowAdjusted(rf, fix, h.maker.id);
    const adjustId = String(done.adjustment['adjust_id']);
    expect(await linksOf(rf)).toEqual([linkOf(rf, adjustId, fix.id, userId)]);
  });
  tick(rf);

  await withRestoreAdmin(rf, async (h) => {
    const data = await platformRestored(await h.restore(target.id));
    expect(data.restored_fen).toBe(0);
    expect(data.rebate_status_after).toBe('ESTIMATED');
    await expectPlatformRestored(rf, target, {
      adminId: h.operator.id,
      from: 'VOID',
      to: 'ESTIMATED',
      restoredFen: 0n,
    });
    expect((await orderRow(rf, order.orderId)).rebate_status).toBe('ESTIMATED');
  });
});
