// B2-17 execution of a form that links recon diffs (claude-independent): BR-FUND-24 ⑨ 「关联差错单的
// 调账单执行时，在批准的同一事务内锁定所关联的每张差错单，以 CAS 把它从 open / processing 置为
// adjusted；任一张已不在 open / processing 即整单拒绝（20902，data.resource=recon_diff），不写凭证；同一
// 差错单对同一受益用户至多关联一张已执行、未被红冲的调账单，差错单涉及的全部受益用户都已有这样一张时，
// 由最后一张的执行事务 CAS 置为 adjusted，其间差错单保持 processing」 and 细则「对外差错单的调账」, with
// §9.3 ①②③④ of the task (涉及用户 = involved_user_ids, NULL / empty → only the member filed for;
// 本次会员不在名单里照常受理 is 本线补全的默认, D10-3191). Every refusal leaves no trace (kit footprint).
import { expect, it } from 'vitest';
import {
  expectAdjusted,
  fixture,
  member,
  moneyOf,
  newForm,
  seedWithdrawal,
  suite,
  withAdjustAdmin,
  type AdjustAdmin,
  type AdjustFixture,
  type Adjusted,
  type Ref,
} from '../admin-adjustments/kit.ts';
import {
  diffConflict,
  diffNow,
  diffRef,
  expectNowAdjusted,
  expectNowProcessing,
  expectUnchanged,
  fileOk,
  fixBody,
  footprint,
  linkOf,
  linksOf,
  schemaReady,
  seedTicket,
  send,
  sortedLinks,
  tick,
  type LinkRow,
} from './kit.ts';

const s = suite();

const RECOVERY_NOTE = '迟到成功重复出款，追回';

/** A manual PAYOUT_RECOVERY decrease (the system takes CASH_ALIPAY from the alipay withdrawal). */
function recoveryBody(userId: string, refs: readonly Ref[]): Record<string, unknown> {
  return newForm({
    userId,
    direction: 'decrease',
    amount: 10_000n,
    reason: 'PAYOUT_RECOVERY',
    refs,
    note: RECOVERY_NOTE,
  });
}

/**
 * The member's manual PAYOUT_RECOVERY of 10000 against the member's own (fresh) alipay withdrawal
 * and the diff; checks it took effect as the trunk's submission does (CASH_ALIPAY).
 */
async function recoverOk(
  f: AdjustFixture,
  h: AdjustAdmin,
  userId: string,
  diff: { readonly id: string },
): Promise<Adjusted> {
  const withdrawal: Ref = { ref_type: 'withdrawal', ref_id: await seedWithdrawal(f, userId) };
  const refs = [withdrawal, diffRef(diff)];
  const before = await moneyOf(f, userId);
  return expectAdjusted(f, await h.create(recoveryBody(userId, refs)), {
    caller: h.maker,
    userId,
    direction: 'decrease',
    amount: 10_000n,
    reason: 'PAYOUT_RECOVERY',
    contra: 'CASH_ALIPAY',
    refs,
    note: RECOVERY_NOTE,
    before,
  });
}

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

it('[AC-B2-17#27] 迁移与关联不分原因码：关联一张 open R3 差错单的 OTHER 调减 120，与关联支付宝提现单 + 一张 open R3 差错单的 PAYOUT_RECOVERY 调减 10000（2880 → −7120），都 200、记账照主干，各自的差错单置 adjusted、各一行关联；之后同一会员对其中任一张再提交 RECON_FIX、OTHER 或 PAYOUT_RECOVERY → 20902 recon_diff，不留痕', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const userId = await member(f, { available: 3000n });
    const forOther = await seedTicket(f);
    const other = await fileOk(f, h, {
      userId,
      refs: [diffRef(forOther)],
      reason: 'OTHER',
      direction: 'decrease',
      amount: 120n,
    });
    const otherAt = f.clock.now();
    await expectNowAdjusted(f, forOther, h.maker.id);
    tick(f);

    const forRecovery = await seedTicket(f);
    const withdrawal: Ref = { ref_type: 'withdrawal', ref_id: await seedWithdrawal(f, userId) };
    const refs = [withdrawal, diffRef(forRecovery)];
    const recovered = await expectAdjusted(f, await h.create(recoveryBody(userId, refs)), {
      caller: h.maker,
      userId,
      direction: 'decrease',
      amount: 10_000n,
      reason: 'PAYOUT_RECOVERY',
      contra: 'CASH_ALIPAY',
      refs,
      note: RECOVERY_NOTE,
      before: { available: 2880n, frozen: 0n },
    });
    expect(recovered.after).toBe(-7120n);
    await expectNowAdjusted(f, forRecovery, h.maker.id);
    const linked = sortedLinks([
      linkOf(f, other.row.adjust_id, forOther.id, userId, null, otherAt),
      linkOf(f, recovered.row.adjust_id, forRecovery.id, userId),
    ]);
    expect(await linksOf(f)).toEqual(linked);
    tick(f);

    for (const diff of [forOther, forRecovery]) {
      const again = [diffRef(diff)];
      const fresh: Ref = { ref_type: 'withdrawal', ref_id: await seedWithdrawal(f, userId) };
      const bodies = [
        fixBody({ userId, refs: again }),
        fixBody({ userId, refs: again, reason: 'OTHER', direction: 'decrease', amount: 120n }),
        recoveryBody(userId, [fresh, diffRef(diff)]),
      ];
      const settled = await diffNow(f, diff.id);
      expect(settled.status).toBe('adjusted');
      for (const body of bodies) {
        const before = await footprint(f);
        await diffConflict(await h.create(body));
        expect(await footprint(f), `${diff.id} ${String(body['reason_code'])}`).toEqual(before);
      }
      await expectUnchanged(f, settled);
    }
  });
});

it('[AC-B2-17#28] refs 里任一张差错单已有本会员未红冲的关联（名单 U1、U2，U1 已调过、差错单仍 processing）→ 整单 20902 recon_diff（不是唯一冲突透出的 50001），不论它排在第几个；同单里可受理的 open / processing 差错单保持原状、没有关联行，不留痕；U2 以同样的 refs 提交照常受理', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const u1 = await member(f, { available: 1000n });
    const u2 = await member(f, { available: 1000n });
    const shared = await seedTicket(f, { users: [u1, u2] });
    await fileOk(f, h, { userId: u1, refs: [diffRef(shared)] });
    const processing = await expectNowProcessing(f, shared);
    tick(f);

    const open = await seedTicket(f);
    const busy = await seedTicket(f, { status: 'processing' });
    const orders = [
      [diffRef(open), diffRef(shared)],
      [diffRef(shared), diffRef(open)],
      [diffRef(open), diffRef(busy), diffRef(shared)],
    ];
    for (const refs of orders) {
      for (const direction of ['increase', 'decrease'] as const) {
        const before = await footprint(f);
        await diffConflict(await send(h, { userId: u1, direction, refs }));
        const label = `${refs.map((ref) => ref.ref_id).join(',')} ${direction}`;
        expect(await footprint(f), label).toEqual(before);
      }
    }
    await expectUnchanged(f, processing);
    await expectUnchanged(f, open);
    await expectUnchanged(f, busy);

    await fileOk(f, h, { userId: u2, refs: [diffRef(open), diffRef(shared)] });
    await expectNowAdjusted(f, open, h.maker.id);
    await expectNowAdjusted(f, processing, h.maker.id);
    await expectUnchanged(f, busy);
  });
});

it('[AC-B2-17#37] 涉及用户与结案判定不分原因码：名单为 U1、U2 的 open R3 差错单，U1 以 OTHER 调减 120 → 差错单 processing（handler_id、closed_at 为空），U1 再提交 → 20902 不留痕，U2 以 OTHER 调减 120 后才 adjusted；另一张名单 U1、U2 的，U1 以 PAYOUT_RECOVERY（U1 自己的支付宝提现单 + 该差错单）调减 10000 → processing，U2 以 PAYOUT_RECOVERY（U2 自己的提现单 + 该差错单）后才 adjusted；每张差错单两条未红冲关联', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const u1 = await member(f, { available: 3000n });
    const u2 = await member(f, { available: 3000n });
    const forOther = await seedTicket(f, { users: [u1, u2] });
    const forRecovery = await seedTicket(f, { users: [u1, u2] });
    const expected: LinkRow[] = [];
    const otherOf = (userId: string) =>
      ({
        userId,
        refs: [diffRef(forOther)],
        reason: 'OTHER',
        direction: 'decrease',
        amount: 120n,
      }) as const;

    const first = await fileOk(f, h, otherOf(u1));
    const otherProcessing = await expectNowProcessing(f, forOther);
    expected.push(linkOf(f, first.row.adjust_id, forOther.id, u1));
    tick(f);
    const waitingOther = await footprint(f);
    await diffConflict(await send(h, otherOf(u1)));
    expect(await footprint(f), 'U1 的第二张 OTHER 不留痕').toEqual(waitingOther);
    const second = await fileOk(f, h, otherOf(u2));
    await expectNowAdjusted(f, otherProcessing, h.maker.id);
    expected.push(linkOf(f, second.row.adjust_id, forOther.id, u2));
    tick(f);

    const third = await recoverOk(f, h, u1, forRecovery);
    expect(third.after).toBe(3000n - 120n - 10_000n);
    const recoveryProcessing = await expectNowProcessing(f, forRecovery);
    expected.push(linkOf(f, third.row.adjust_id, forRecovery.id, u1));
    tick(f);
    const waitingRecovery = await footprint(f);
    const fresh: Ref = { ref_type: 'withdrawal', ref_id: await seedWithdrawal(f, u1) };
    const seeded = await footprint(f);
    await diffConflict(await h.create(recoveryBody(u1, [fresh, diffRef(forRecovery)])));
    expect(await footprint(f), 'U1 的第二张 PAYOUT_RECOVERY 不留痕').toEqual(seeded);
    expect(seeded.diffs, '种提现单不动差错单').toEqual(waitingRecovery.diffs);
    const fourth = await recoverOk(f, h, u2, forRecovery);
    await expectNowAdjusted(f, recoveryProcessing, h.maker.id);
    expected.push(linkOf(f, fourth.row.adjust_id, forRecovery.id, u2));

    expect(await linksOf(f)).toEqual(sortedLinks(expected));
  });
});
