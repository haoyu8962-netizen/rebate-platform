// B2-09m member block rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchManualPaid, 08 BR-WDR-16, BR-WDR-05. member_blocked: blocked_reason set; an effective withdraw
// hold; available below 0; risk frozen (an expired freeze does not count) or banned; appealing over either
// (prev_risk_state). Judged under the member's locks: the interleaving holds the users row, first in the
// lock order, proves the request waits on it, commits another transaction's change, and the request must
// see the new value. Requests go through the real admin entry (manual-paid-harness.ts). Top-level it() only
// (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  AMOUNT,
  adjust,
  adjustOn,
  ago,
  approved,
  balanceOf,
  entryOf,
  expectItems,
  expectNothingWritten,
  fixture,
  holdOn,
  lockUsersRow,
  paid,
  payee,
  rowOf,
  seedAppeal,
  seedHold,
  seedRisk,
  seedRiskState,
  skipped,
  state,
  suite,
  voucherOf,
  whileHeld,
  withManualAdmin,
} from './manual-paid-harness.ts';

const s = suite();

it('[AC-B2-09m#32] member_blocked（BR-WDR-05）：blocked_reason 非空、有效 withdraw hold（无期限、未到期）、available < 0、风控 frozen（无期限、未到期）、banned、appealing（申诉前 frozen、banned）各一，什么都不写；同请求可补的照常 paid', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const later = new Date(f.clock.now().getTime() + 1);
    const blocked = await approved(f, h, await payee(f, h), { blocked_reason: 'NEGATIVE_BALANCE' });

    const held = await payee(f, h);
    await seedHold(f, held, { reason: 'manual', hold_until: null });
    const onHold = await approved(f, h, held);

    const heldUntil = await payee(f, h);
    await seedHold(f, heldUntil, { reason: 'manual', hold_until: later });
    const onTimedHold = await approved(f, h, heldUntil);

    const poor = await payee(f, h, AMOUNT);
    const negative = await approved(f, h, poor);
    await adjust(f, poor, -1_001n);

    const frozenMember = await payee(f, h);
    await seedRiskState(f, frozenMember, 'frozen');
    const frozen = await approved(f, h, frozenMember);

    const thawing = await payee(f, h);
    await seedRisk(f, thawing, 'frozen', later);
    const timedFrozen = await approved(f, h, thawing);

    const bannedMember = await payee(f, h);
    await seedRiskState(f, bannedMember, 'banned');
    const banned = await approved(f, h, bannedMember);

    const appealFrozen = await payee(f, h);
    await seedRisk(f, appealFrozen, 'appealing');
    await seedAppeal(f, appealFrozen, 'frozen');
    const appealingFrozen = await approved(f, h, appealFrozen);

    const appealBanned = await payee(f, h);
    await seedRisk(f, appealBanned, 'appealing');
    await seedAppeal(f, appealBanned, 'banned');
    const appealingBanned = await approved(f, h, appealBanned);

    const stopped = [
      blocked,
      onHold,
      onTimedHold,
      negative,
      frozen,
      timedFrozen,
      banned,
      appealingFrozen,
      appealingBanned,
    ];
    const before = await state(f);

    await expectItems(
      await h.manualPaid(stopped.map((row) => entryOf(f, row))),
      stopped.map((row) => skipped(row.id, 'member_blocked')),
    );
    expectNothingWritten(before, await state(f));

    const free = await approved(f, h, await payee(f, h));
    await expectItems(await h.manualPaid([entryOf(f, frozen), entryOf(f, free)]), [
      skipped(frozen.id, 'member_blocked'),
      paid(free.id),
    ]);
  });
});

it('[AC-B2-09m#33] 不算阻断的都照常 paid：已释放的 hold、到期的 hold（hold_until 等于现在）、到期的冻结（frozen_until 等于现在）、available 恰好为 0、appealing 但没有进行中的账号申诉', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const released = await payee(f, h);
    await seedHold(f, released, { reason: 'manual', released_at: ago(f, 5) });
    const expiredHold = await payee(f, h);
    await seedHold(f, expiredHold, { reason: 'manual', hold_until: f.clock.now() });
    const thawed = await payee(f, h);
    await seedRisk(f, thawed, 'frozen', f.clock.now());
    const zero = await payee(f, h, AMOUNT);
    const appealing = await payee(f, h);
    await seedRisk(f, appealing, 'appealing');
    const rows = [
      await approved(f, h, released),
      await approved(f, h, expiredHold),
      await approved(f, h, thawed),
      await approved(f, h, zero),
      await approved(f, h, appealing),
    ];

    await expectItems(
      await h.manualPaid(rows.map((row) => entryOf(f, row))),
      rows.map((row) => paid(row.id)),
    );

    expect(await balanceOf(f.db, f.ledger, f.appId, zero.userId)).toEqual({
      available_fen: 0n,
      frozen_fen: 0n,
    });
  });
});

it('[AC-B2-09m#34] 负余额在锁内读（确定性交错）：补录在 users 行锁上等待时，另一个事务把 available 改成 −1,001 并提交 → member_blocked，读到的是新值；单不动、没有成功凭证、frozen 不动', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h, AMOUNT);
    const w = await approved(f, h, who);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: 0n,
      frozen_fen: AMOUNT,
    });
    const lock = await lockUsersRow(f.db, f.appId, who.userId);

    const sent = await whileHeld(
      f,
      lock,
      () => h.manualPaid([entryOf(f, w)]),
      '补录应在 users 行锁上等待',
      (trx) => adjustOn(trx, f, who, -1_001n),
    );

    await expectItems(sent, [skipped(w.id, 'member_blocked')]);
    expect(await rowOf(f, w)).toEqual(w);
    expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toEqual([]);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: -1_001n,
      frozen_fen: AMOUNT,
    });
  });
});

it('[AC-B2-09m#35] 提现冻结也在锁内读（确定性交错）：补录在 users 行锁上等待时，另一个事务新增有效 hold 并提交 → member_blocked，单不动、没有成功凭证', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    const lock = await lockUsersRow(f.db, f.appId, who.userId);

    const sent = await whileHeld(
      f,
      lock,
      () => h.manualPaid([entryOf(f, w)]),
      '补录应在 users 行锁上等待',
      (trx) => holdOn(trx, f, who),
    );

    await expectItems(sent, [skipped(w.id, 'member_blocked')]);
    expect(await rowOf(f, w)).toEqual(w);
    expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toEqual([]);
  });
});
