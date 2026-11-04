// B2-09m concurrency rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchManualPaid, 08 BR-WDR-16 (EXECUTE and MANUAL_PAID both require APPROVED, the first to commit
// wins); payout AGENTS.md 硬规则 1, 3. No timing: every interleaving is made with a lock held from outside and
// each waiter is proven waiting (pg_stat_activity) before the lock is let go.
//   EXECUTE vs W8: the withdrawal row is held. EXECUTE takes the balance row, then waits on the withdrawal
//   row (payout-execute.ts); W8 takes the users row, the balance row, then the withdrawal row. Whoever
//   is sent first owns the balance row, so the other waits behind it and goes on only after it committed.
//   Same serial number: the first request's tax_ytd row is held. It has passed its CAS and written the
//   number, uncommitted, when it reaches that row; the second, another member's, finds no committed number
//   and waits on the unique index for the first's transaction. Or another transaction holds the number,
//   uncommitted, and commits or rolls back.
// Requests go through the real admin entry (manual-paid-harness.ts); EXECUTE is the real
// adminCreatePayoutBatch. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  ACTION,
  AFTER_FREEZE,
  AMOUNT,
  PLENTY,
  approved,
  asPaidManual,
  auditFacts,
  audits,
  balanceOf,
  bothWaiting,
  changes,
  entryOf,
  expectExecuted,
  expectItems,
  expectNothingWritten,
  fixture,
  frozenMismatches,
  holdSerial,
  holdTaxRow,
  item,
  itemsIn,
  itemsOf,
  lockUsersRow,
  lockWithdrawal,
  moveToPaying,
  paid,
  payee,
  payoutJobs,
  rowOf,
  seedTaxRow,
  seedW,
  serial,
  skipped,
  state,
  suite,
  taxOf,
  track,
  transferJob,
  voucherOf,
  waiting,
  whileHeld,
  withManualAdmin,
} from './manual-paid-harness.ts';

const s = suite();

it('[AC-B2-09m#70] 和 EXECUTE 互斥（确定性）：EXECUTE 先提交 → 补录 not_approved；单 PAYING，只有转账任务，没有成功凭证、tax_ytd、补录审计，钱不动', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    await seedW(f, { fen: PLENTY });
    const entry = entryOf(f, w);
    const lock = await lockWithdrawal(f, w);

    const [executed, manual] = await bothWaiting(
      f,
      lock,
      () => h.execute([w.id]),
      () => h.manualPaid([entry]),
      'EXECUTE 应在单据行锁上等待',
      '补录应排在持有余额行锁的 EXECUTE 之后',
    );

    await expectExecuted(executed, { paying: [w.id] });
    await expectItems(manual, [skipped(w.id, 'not_approved')]);
    expect(await rowOf(f, w)).toMatchObject({
      status: 'PAYING',
      execute_seq: w.execute_seq + 1,
      executor_id: h.executor.id,
      channel_order_id: null,
      paid_at: null,
      manual_entry_by: null,
      manual_confirm_by: null,
    });
    expect(await payoutJobs(f)).toEqual([transferJob(f, w, 1)]);
    expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toEqual([]);
    expect(await taxOf(f, who)).toEqual([]);
    expect(await audits(f, ACTION)).toEqual([]);
    expect(await changes(f.db, f.appId)).toEqual([
      { withdrawal_id: w.id, user_id: who.userId, status: 'PAYING' },
    ]);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: AFTER_FREEZE,
      frozen_fen: AMOUNT,
    });
  });
});

it('[AC-B2-09m#71] 和 EXECUTE 互斥（确定性）：补录先提交 → EXECUTE 的 left 是 not_approved；没有转账任务，execute_seq 不变，批次只记一条 skipped；凭证恰一张，钱只动一次', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    await seedW(f, { fen: PLENTY });
    const entry = entryOf(f, w);
    const lock = await lockWithdrawal(f, w);

    const [manual, executed] = await bothWaiting(
      f,
      lock,
      () => h.manualPaid([entry]),
      () => h.execute([w.id]),
      '补录应在单据行锁上等待',
      'EXECUTE 应排在持有余额行锁的补录之后',
    );

    await expectItems(manual, [paid(w.id)]);
    const batchId = await expectExecuted(executed, { left: [[w.id, 'not_approved']] });
    expect(await rowOf(f, w)).toEqual(asPaidManual(f, w, entry, h.entry.id));
    expect(await payoutJobs(f)).toEqual([]);
    expect(await itemsOf(f)).toEqual([item(batchId, w, 'skipped', 'not_approved')]);
    expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toHaveLength(1);
    expect(await changes(f.db, f.appId)).toEqual([
      { withdrawal_id: w.id, user_id: who.userId, status: 'PAID_MANUAL' },
    ]);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: AFTER_FREEZE,
      frozen_fen: 0n,
    });
    expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
  });
});

it('[AC-B2-09m#72] 状态 CAS（确定性）：补录在单据行锁上等待时，别的事务把这一单改成 PAYING → 这一单 not_approved，同请求另一单照常 paid；这一单什么都没写', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const taken = await approved(f, h, who);
    const free = await approved(f, h, await payee(f, h));
    const freeEntry = entryOf(f, free);
    const lock = await lockWithdrawal(f, taken);

    const sent = await whileHeld(
      f,
      lock,
      () => h.manualPaid([entryOf(f, taken), freeEntry]),
      '补录应在单据行锁上等待',
      (trx) => moveToPaying(trx, taken, f.clock.now()),
    );

    await expectItems(sent, [skipped(taken.id, 'not_approved'), paid(free.id)]);
    expect(await rowOf(f, taken)).toMatchObject({
      status: 'PAYING',
      channel_order_id: null,
      paid_at: null,
      manual_entry_by: null,
    });
    expect(await voucherOf(f.db, f.appId, `wd:${taken.id}:PAID`)).toEqual([]);
    expect(await taxOf(f, who)).toEqual([]);
    expect(await rowOf(f, free)).toEqual(asPaidManual(f, free, freeEntry, h.entry.id));
    expect(await audits(f, ACTION)).toHaveLength(1);
  });
});

it('[AC-B2-09m#73] 并发同流水号（确定性，靠唯一索引）：两个请求用同一流水号补录两张单：一张 paid；另一张 channel_order_id_taken，不是 5xx，什么都没写（状态、凭证、余额、tax_ytd、事件、审计），它请求里的下一项照常 paid', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const winnerMember = await payee(f, h);
    const loserMember = await payee(f, h);
    const thirdMember = await payee(f, h);
    const won = await approved(f, h, winnerMember);
    const lost = await approved(f, h, loserMember);
    const next = await approved(f, h, thirdMember);
    await seedTaxRow(f, winnerMember, 2026, 1_009n, 13n);
    const number = serial();
    const wonEntry = entryOf(f, won, { channel_order_id: number });
    const nextEntry = entryOf(f, next);
    const lock = await holdTaxRow(f, winnerMember);

    const [first, second] = await bothWaiting(
      f,
      lock,
      () => h.manualPaid([wonEntry]),
      () => h.manualPaid([entryOf(f, lost, { channel_order_id: number }), nextEntry]),
      '第一个请求应写好流水号、停在 tax_ytd 行锁上',
      '第二个请求应在流水号唯一索引上等第一个提交',
    );

    await expectItems(first, [paid(won.id)]);
    await expectItems(second, [skipped(lost.id, 'channel_order_id_taken'), paid(next.id)]);
    expect(await rowOf(f, won)).toEqual(asPaidManual(f, won, wonEntry, h.entry.id));
    expect(await rowOf(f, next)).toEqual(asPaidManual(f, next, nextEntry, h.entry.id));
    expect(await rowOf(f, lost)).toEqual(lost);
    expect(await voucherOf(f.db, f.appId, `wd:${lost.id}:PAID`)).toEqual([]);
    expect(await taxOf(f, loserMember)).toEqual([]);
    expect(await balanceOf(f.db, f.ledger, f.appId, loserMember.userId)).toEqual({
      available_fen: AFTER_FREEZE,
      frozen_fen: AMOUNT,
    });
    expect((await taxOf(f, winnerMember)).map((row) => row.cum_income_fen)).toEqual([13_569n]);
    expect((await changes(f.db, f.appId)).map((data) => data['withdrawal_id']).sort()).toEqual(
      [won.id, next.id].sort(),
    );
    const texts = (await audits(f, ACTION)).map((record) => auditFacts(record).text);
    expect(texts).toHaveLength(2);
    expect(texts.filter((text) => text.includes(lost.id))).toEqual([]);
    expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
  });
});

it('[AC-B2-09m#74] 唯一索引兜底（确定性）：别的事务写了同一流水号未提交，读不到；补录在唯一索引上等它，它提交 → channel_order_id_taken，不是 5xx，什么都没写', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const holderRow = await approved(f, h, await payee(f, h));
    const w = await approved(f, h, await payee(f, h));
    const number = serial();
    const before = await state(f);
    const holder = await holdSerial(f, holderRow, number);

    const request = track(h.manualPaid([entryOf(f, w, { channel_order_id: number })]));
    let proven = false;
    try {
      expect(await waiting(f, 1, [request]), '补录应在流水号唯一索引上等待').toBe(true);
      proven = true;
    } finally {
      await (proven ? holder.commit() : holder.rollback());
      await Promise.allSettled([request.promise]);
    }

    await expectItems(await request.promise, [skipped(w.id, 'channel_order_id_taken')]);
    expect(await rowOf(f, holderRow)).toEqual({ ...holderRow, channel_order_id: number });
    const after = await state(f);
    expectNothingWritten(before, {
      ...after,
      withdrawals: after.withdrawals.map((row) =>
        row.id === holderRow.id ? { ...row, channel_order_id: null } : row,
      ),
    });
  });
});

it('[AC-B2-09m#75] 唯一索引只认提交（确定性）：别的事务写了同一流水号又回滚 → 补录等完照常 paid，等待不算占用', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const holderRow = await approved(f, h, await payee(f, h));
    const w = await approved(f, h, await payee(f, h));
    const number = serial();
    const entry = entryOf(f, w, { channel_order_id: number });
    const holder = await holdSerial(f, holderRow, number);

    const request = track(h.manualPaid([entry]));
    try {
      expect(await waiting(f, 1, [request]), '补录应在流水号唯一索引上等待').toBe(true);
    } finally {
      await holder.rollback();
      await Promise.allSettled([request.promise]);
    }

    await expectItems(await request.promise, [paid(w.id)]);
    expect(await rowOf(f, w)).toEqual(asPaidManual(f, w, entry, h.entry.id));
    expect(await rowOf(f, holderRow)).toEqual(holderRow);
  });
});

it('[AC-B2-09m#76] 并发同一张（确定性）：两个请求补录同一张单（流水号不同），都在 users 行锁上等待：一个 paid，另一个 not_approved；凭证恰一张，流水号是赢家的，钱、tax_ytd、事件、审计都只一次', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const colleague = await h.caller(['payout.manual_entry']);
    const w = await approved(f, h, who);
    const one = entryOf(f, w);
    const other = entryOf(f, w);
    const lock = await lockUsersRow(f.db, f.appId, who.userId);

    const [firstSent, secondSent] = await bothWaiting(
      f,
      lock,
      () => h.manualPaid([one]),
      () => h.manualPaid([other], { caller: colleague }),
      '第一个补录应在 users 行锁上等待',
      '第二个补录也应在 users 行锁上等待',
    );

    const firstItems = await itemsIn(firstSent);
    const secondItems = await itemsIn(secondSent);
    const results = [...firstItems, ...secondItems];
    expect(results.filter((row) => row.result === 'paid')).toEqual([paid(w.id)]);
    expect(results.filter((row) => row.result === 'skipped')).toEqual([
      skipped(w.id, 'not_approved'),
    ]);
    const firstWon = firstItems[0]?.result === 'paid';
    expect(await rowOf(f, w)).toEqual(
      asPaidManual(f, w, firstWon ? one : other, firstWon ? h.entry.id : colleague.id),
    );
    expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toHaveLength(1);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: AFTER_FREEZE,
      frozen_fen: 0n,
    });
    expect((await taxOf(f, who)).map((row) => row.cum_income_fen)).toEqual([12_560n]);
    expect(await changes(f.db, f.appId)).toHaveLength(1);
    expect(await audits(f, ACTION)).toHaveLength(1);
  });
});
