// B2-17 execution of a form that links recon diffs (claude-independent): BR-FUND-24 ⑨ 「关联差错单的
// 调账单执行时，在批准的同一事务内锁定所关联的每张差错单，以 CAS 把它从 open / processing 置为
// adjusted；任一张已不在 open / processing 即整单拒绝（20902，data.resource=recon_diff），不写凭证；同一
// 差错单对同一受益用户至多关联一张已执行、未被红冲的调账单，差错单涉及的全部受益用户都已有这样一张时，
// 由最后一张的执行事务 CAS 置为 adjusted，其间差错单保持 processing」 and 细则「对外差错单的调账」, with
// §9.3 ①②③④ of the task (涉及用户 = involved_user_ids, NULL / empty → only the member filed for;
// 本次会员不在名单里照常受理 is 本线补全的默认, D10-3191). Every refusal leaves no trace (kit footprint).
import { expect, it } from 'vitest';
import { fixture, member, suite, withAdjustAdmin } from '../admin-adjustments/kit.ts';
import {
  diffConflict,
  diffNow,
  diffRef,
  expectNowAdjusted,
  expectNowProcessing,
  expectUnchanged,
  fileOk,
  footprint,
  linkOf,
  linksOf,
  schemaReady,
  seedTicket,
  send,
  sortedLinks,
  tick,
} from './kit.ts';

const s = suite();

it('[AC-B2-17#1] 新单关联一张 open（没有名单）或 processing 的差错单 → 200，应答、单、凭证、余额照主干；同一事务里差错单置 adjusted（handler_id = 提交人，closed_at = updated_at = 时钟，其余列不变），关联表多一行（会员、未红冲、created_at = 时钟）', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    for (const status of ['open', 'processing'] as const) {
      const userId = await member(f, { available: 1000n });
      const diff = await seedTicket(f, { status });
      const done = await fileOk(f, h, { userId, refs: [diffRef(diff)] });
      await expectNowAdjusted(f, diff, h.maker.id);
      const links = (await linksOf(f)).filter((row) => row.recon_diff_id === diff.id);
      expect(links, status).toEqual([linkOf(f, done.row.adjust_id, diff.id, userId)]);
      tick(f);
    }
  });
});

it('[AC-B2-17#2] 名单为空数组的差错单按只涉及正在调账的会员：执行后即 adjusted，一行关联', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const userId = await member(f, { available: 1000n });
    const diff = await seedTicket(f, { users: [] });
    const done = await fileOk(f, h, { userId, refs: [diffRef(diff)] });
    await expectNowAdjusted(f, diff, h.maker.id);
    expect(await linksOf(f)).toEqual([linkOf(f, done.row.adjust_id, diff.id, userId)]);
  });
});

it('[AC-B2-17#3] 新单 refs 里有三张差错单（open、processing、open）：同一事务各自置 adjusted、各有一行关联', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const userId = await member(f, { available: 1000n });
    const diffs = [await seedTicket(f), await seedTicket(f, { status: 'processing' })];
    diffs.push(await seedTicket(f));
    const done = await fileOk(f, h, { userId, refs: diffs.map(diffRef) });
    for (const diff of diffs) await expectNowAdjusted(f, diff, h.maker.id);
    const id = done.row.adjust_id;
    const expected = diffs.map((diff) => linkOf(f, id, diff.id, userId));
    expect(await linksOf(f)).toEqual(sortedLinks(expected));
  });
});

it('[AC-B2-17#4] 新单 refs 里有多张差错单，其中一张是 adjusted / written_off / closed → 整单 20902（data 恰为 resource=recon_diff），不留痕：没有单、凭证、余额变动、审计、站内信、关联行，其余几张差错单也不变', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const userId = await member(f, { available: 1000n });
    for (const status of ['adjusted', 'written_off', 'closed'] as const) {
      const fine = [await seedTicket(f), await seedTicket(f, { status: 'processing' })];
      const concluded = await seedTicket(f, { status });
      const refs = [diffRef(fine[0]!), diffRef(concluded), diffRef(fine[1]!)];
      for (const direction of ['increase', 'decrease'] as const) {
        const before = await footprint(f);
        await diffConflict(await send(h, { userId, direction, refs }));
        expect(await footprint(f), `${status} ${direction}`).toEqual(before);
      }
      for (const diff of [...fine, concluded]) await expectUnchanged(f, diff);
    }
  });
});

it('[AC-B2-17#5] 名单为 U1、U2 的差错单：U1 的调账执行后差错单置 processing（handler_id、closed_at 仍为空）；U2 的执行后置 adjusted（handler 为 U2 那张的提交人）；两张调账单各一行关联', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const u1 = await member(f, { available: 1000n });
    const u2 = await member(f, { available: 1000n });
    const diff = await seedTicket(f, { users: [u1, u2] });
    const colleague = await h.caller(['fund.adjust']);

    const first = await fileOk(f, h, { userId: u1, refs: [diffRef(diff)] });
    const processing = await expectNowProcessing(f, diff);
    const firstAt = f.clock.now();
    tick(f);

    const refs = [diffRef(diff)];
    const second = await fileOk(f, h, { userId: u2, refs, caller: colleague });
    await expectNowAdjusted(f, processing, colleague.id);
    const expected = [
      linkOf(f, first.row.adjust_id, diff.id, u1, null, firstAt),
      linkOf(f, second.row.adjust_id, diff.id, u2),
    ];
    expect(await linksOf(f)).toEqual(sortedLinks(expected));
  });
});

it('[AC-B2-17#6] 本次提交的会员不在名单里（名单 U1、U2，先调 U3）→ 照常受理、照（差错单，会员）唯一；名单里的人没调完之前差错单是 processing，U1、U2 都调过后才 adjusted', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const u1 = await member(f, { available: 1000n });
    const u2 = await member(f, { available: 1000n });
    const u3 = await member(f, { available: 1000n });
    const diff = await seedTicket(f, { users: [u1, u2] });
    const refs = [diffRef(diff)];

    await fileOk(f, h, { userId: u3, refs });
    const row = await expectNowProcessing(f, diff);
    tick(f);
    const before = await footprint(f);
    await diffConflict(await send(h, { userId: u3, refs }));
    expect(await footprint(f), 'U3 的第二张不留痕').toEqual(before);

    await fileOk(f, h, { userId: u1, refs });
    await expectUnchanged(f, row);
    tick(f);
    await fileOk(f, h, { userId: u2, refs });
    await expectNowAdjusted(f, row, h.maker.id);
    const linked = (await linksOf(f)).map((link) => link.user_id).sort();
    expect(linked).toEqual([u1, u2, u3].sort());
  });
});

it('[AC-B2-17#7] 同一会员对同一张差错单的第二张（前一张未红冲）→ 20902 recon_diff，不留痕：差错单已是 adjusted 的情形（没有名单），与名单 U1、U2 时 U1 再提交一张（差错单仍是 processing、保持 processing）', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const userId = await member(f, { available: 1000n });
    const single = await seedTicket(f);
    await fileOk(f, h, { userId, refs: [diffRef(single)] });
    expect((await diffNow(f, single.id)).status).toBe('adjusted');
    tick(f);
    const settled = await footprint(f);
    await diffConflict(await send(h, { userId, refs: [diffRef(single)], amount: 200n }));
    expect(await footprint(f), '已 adjusted').toEqual(settled);

    const u2 = await member(f, { available: 1000n });
    const shared = await seedTicket(f, { users: [userId, u2] });
    await fileOk(f, h, { userId, refs: [diffRef(shared)] });
    const processing = await expectNowProcessing(f, shared);
    tick(f);
    const before = await footprint(f);
    for (const direction of ['increase', 'decrease'] as const) {
      await diffConflict(await send(h, { userId, direction, refs: [diffRef(shared)] }));
    }
    expect(await footprint(f), '仍 processing').toEqual(before);
    await expectUnchanged(f, processing);
  });
});
