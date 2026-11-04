// B2-09m edge rule tests, review r1 (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchManualPaid, 08 BR-WDR-16, BR-WDR-05 (a), BR-WDR-17.
//   A kind=transfer attempt with result pending, success or unknown stops W8 whatever came after it: a later
//   query that failed says nothing about that transfer, so looking only at the latest attempt pays twice.
//   payout_attempts_transfer_once_key allows one transfer per withdrawal, so each case has exactly one.
//   available below 0 is judged on the value read under the balance row lock. member-blocked.int.test.ts
//   holds the users row, which cannot see a read made between the users lock and lockBalances; here the
//   holder has only the balance row, the request gets past the users row and waits there, and another
//   transaction's voucher commits in between.
//   withdraw.enabled gates new applications only: existing withdrawals are not affected (BR-WDR-17).
//   channel_order_id does not take U+0000: PostgreSQL text cannot store it, so it is a 20001 of the route
//   schema and never a 5xx.
// Requests go through the real admin entry (manual-paid-harness.ts). Top-level it() only (规划/11 §4.3).
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { readWithdrawEnabled } from '../../../../apps/api/src/modules/payout/application/withdraw-rules.ts';
import { configPort } from '../proven-success/kit.ts';
import {
  ACTION,
  AFTER_FREEZE,
  AMOUNT,
  PAYER_SIDE,
  adjustOn,
  ago,
  approved,
  asPaidManual,
  audits,
  balanceOf,
  changes,
  entries,
  entryOf,
  expectItems,
  expectNothingWritten,
  fieldsError,
  fixture,
  frozenMismatches,
  paid,
  payee,
  platformLine,
  rowOf,
  seedAttempt,
  seedQueries,
  setSwitch,
  skipped,
  state,
  stepUpRequired,
  suite,
  taxOf,
  userLine,
  voucherOf,
  whileHeld,
  withManualAdmin,
  type Held,
  type Member,
  type ReviewFixture,
  type WithdrawalRow,
} from './manual-paid-harness.ts';

const s = suite();

/** One transfer attempt of each result at T−20, then a failed query at T−10. */
async function failedQueryAfterTransfer(seed: { readonly hold_reason?: string }): Promise<void> {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const rows: WithdrawalRow[] = [];
    for (const result of ['pending', 'success', 'unknown'] as const) {
      const row = await approved(f, h, who, seed);
      await seedAttempt(f, row, { kind: 'transfer', result, at: ago(f, 20) });
      await seedQueries(f, row, [['fail', 10]]);
      rows.push(row);
    }
    const before = await state(f);

    await expectItems(
      await h.manualPaid(rows.map((row) => entryOf(f, row))),
      rows.map((row) => skipped(row.id, 'has_transfer_attempt')),
    );
    expectNothingWritten(before, await state(f));

    const free = await approved(f, h, who);
    await expectItems(await h.manualPaid([entryOf(f, rows[0]!), entryOf(f, free)]), [
      skipped(rows[0]!.id, 'has_transfer_attempt'),
      paid(free.id),
    ]);
    expect(await rowOf(f, rows[0]!)).toEqual(rows[0]);
    expect(await voucherOf(f.db, f.appId, `wd:${rows[0]!.id}:PAID`)).toEqual([]);
  });
}

it('[AC-B2-09m#77] 不能只看最新一条尝试（BR-WDR-16，会重复打款）：没有 hold，转账 pending、success、unknown 在 T−20，之后 T−10 一条 query fail → 都是 has_transfer_attempt，状态、凭证、tax_ytd、事件、审计都不写；同请求可补的照常 paid', async () => {
  await failedQueryAfterTransfer({});
});

it('[AC-B2-09m#78] 不能只看最新一条尝试（BR-WDR-16，会重复打款）：hold_reason=payer_side_after_transfer，转账 pending、success、unknown 在 T−20，之后 T−10 一条 query fail → 也是 has_transfer_attempt，最新查询 fail 放行不了；什么都不写；同请求可补的照常 paid', async () => {
  await failedQueryAfterTransfer({ hold_reason: PAYER_SIDE });
});

interface HeldBalance extends Held {
  /** The backend of the holding transaction, which has locked nothing but the balance row. */
  readonly pid: number;
}

/** Holds the member's balance row only; the users row is proven free while the lock is held. */
async function holdBalanceRowOnly(f: ReviewFixture, who: Member): Promise<HeldBalance> {
  type During = ((trx: Transaction<DB>) => Promise<void>) | undefined;
  let openGate!: (during: During) => void;
  const gate = new Promise<During>((resolve) => {
    openGate = resolve;
  });
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  let pid = 0;
  const done = f.db.transaction().execute(async (trx) => {
    const rows = await f.ledger.lockBalances(trx, { appId: who.appId, userIds: [who.userId] });
    expect(rows, `balance of ${who.userId}`).toHaveLength(1);
    const free = await sql`SELECT id FROM app.users
      WHERE app_id = ${who.appId} AND id = ${who.userId} FOR NO KEY UPDATE NOWAIT`.execute(f.db);
    expect(free.rows, `users ${who.userId} must stay free`).toHaveLength(1);
    const backend = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
    pid = backend.rows[0]!.pid;
    locked();
    const during = await gate;
    if (during !== undefined) await during(trx);
  });
  await Promise.race([ready, done]);
  return {
    pid,
    async release(during) {
      openGate(during);
      await done;
    },
  };
}

/** How many backends wait on a lock held by `pid` (read outside its transaction). */
async function blockedBy(f: ReviewFixture, pid: number): Promise<number> {
  const result = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'
      AND ${pid}::integer = ANY(pg_blocking_pids(pid))`.execute(f.db);
  return Number(result.rows[0]?.n ?? '0');
}

it('[AC-B2-09m#79] 负余额读锁内的值（BR-WDR-05 (a)，确定性交错）：外部只持余额行、不碰 users 行，补录在余额行上等待（pg_blocking_pids 指向持锁方）时写一张让 available 变 −1,003 的凭证并提交 → member_blocked；单不动，没有成功凭证、tax_ytd、事件、审计，frozen 不动；先读余额再拿锁的实现会被打红', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h, AMOUNT);
    const w = await approved(f, h, who);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: 0n,
      frozen_fen: AMOUNT,
    });
    const lock = await holdBalanceRowOnly(f, who);
    let blocked = 0;

    const sent = await whileHeld(
      f,
      lock,
      () => h.manualPaid([entryOf(f, w)]),
      '补录应在余额行锁上等待',
      async (trx) => {
        blocked = await blockedBy(f, lock.pid);
        await adjustOn(trx, f, who, -1_003n);
      },
    );

    expect(blocked, '等待的必须是外部持有的余额行锁').toBe(1);
    await expectItems(sent, [skipped(w.id, 'member_blocked')]);
    expect(await rowOf(f, w)).toEqual(w);
    expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toEqual([]);
    expect(await taxOf(f, who)).toEqual([]);
    expect(await changes(f.db, f.appId)).toEqual([]);
    expect(await audits(f, ACTION)).toEqual([]);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: -1_003n,
      frozen_fen: AMOUNT,
    });
    expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
  });
});

it('[AC-B2-09m#80] withdraw.enabled 不挡（BR-WDR-17「已有单不受影响」）：开关关（真实读取器读到 off），APPROVED 单补录照常 paid；单据、凭证、余额、tax_ytd、事件、审计和平常一样', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    await setSwitch(f, 'withdraw.enabled', false);
    const switchOn = () =>
      readWithdrawEnabled(f.db, f.appId, {
        config: configPort(),
        logger: { warn: () => undefined },
      });
    expect(await switchOn()).toBe(false);
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    const entry = entryOf(f, w);

    await expectItems(await h.manualPaid([entry]), [paid(w.id)]);

    expect(await switchOn()).toBe(false);
    expect(await rowOf(f, w)).toEqual(asPaidManual(f, w, entry, h.entry.id));
    const key = `wd:${w.id}:PAID`;
    expect(await voucherOf(f.db, f.appId, key)).toEqual([
      { uniq_key: key, biz_type: 'withdrawal', biz_id: w.id, operator: `admin:${h.entry.id}` },
    ]);
    expect(await entries(f.db, f.appId, key)).toEqual([
      userLine(88n, 'TAX_WITHHOLD'),
      platformLine('TAX_PAYABLE', -88n, 'TAX_WITHHOLD'),
      userLine(125n, 'WITHDRAW_FEE'),
      platformLine('FEE_INCOME', -125n, 'WITHDRAW_FEE'),
      userLine(12_347n, 'WITHDRAW_PAID'),
      platformLine('CASH_ALIPAY', -12_347n, 'WITHDRAW_PAID'),
    ]);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: AFTER_FREEZE,
      frozen_fen: 0n,
    });
    expect(await taxOf(f, who)).toEqual([
      {
        year: 2026,
        income_type: 'SERVICE_FEE',
        identity_hmac: who.hmac,
        cum_income_fen: 12_560n,
        cum_withheld_fen: 88n,
      },
    ]);
    expect(await changes(f.db, f.appId)).toEqual([
      { withdrawal_id: w.id, user_id: who.userId, status: 'PAID_MANUAL' },
    ]);
    expect(await audits(f, ACTION)).toHaveLength(1);
    expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
  });
});

it('[AC-B2-09m#81] 流水号含 NUL：U+0000 在中间、开头、结尾或只有它 → 路由层 20001，data.fields 指向该字段（无权限、不带 step-up 也是），不是 5xx；什么都不写，同请求里合法的项也不执行；去掉 NUL 后两项都能补', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const nobody = await h.caller([]);
    const good = await approved(f, h, await payee(f, h));
    const bad = await approved(f, h, await payee(f, h));
    const goodEntry = entryOf(f, good);
    const before = await state(f);

    for (const value of ['2026\u00001103', '\u000020261103', '20261103\u0000', '\u0000']) {
      const items = [goodEntry, entryOf(f, bad, { channel_order_id: value })];
      const field = ['items.1.channel_order_id'];
      await fieldsError(await h.manualPaid(items), field);
      await fieldsError(await h.manualPaid(items, { stepUp: null }), field);
      await fieldsError(await h.manualPaid(items, { caller: h.viewer }), field);
      await fieldsError(await h.manualPaid(items, { caller: nobody, stepUp: null }), field);
    }

    expect(await state(f)).toEqual(before);
    await stepUpRequired(await h.manualPaid([goodEntry], { stepUp: null }));
    expect(await rowOf(f, good)).toEqual(good);
    expect(await rowOf(f, bad)).toEqual(bad);

    await expectItems(await h.manualPaid([goodEntry, entryOf(f, bad)]), [
      paid(good.id),
      paid(bad.id),
    ]);
  });
});
