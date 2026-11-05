// B2-12b (BR-FUND-24 细则「红冲只按原单整笔」, BR-FUND-10, BR-FUND-16; 编排 D10-590 ①): the
// adjustment flow's own whole reversal `ADJ:{adjust_id}:REVERSE`, posted through ledger.post with
// the trusted voucher kind, may leave available below zero. The generic ledger.reverse keeps the
// frozen AC-B2-02i#10 behaviour for ADMIN_ADJUST.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { accountingDate } from '@couli/domain';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Ledger } from '../../../../apps/api/src/modules/ledger/index.ts';
import { INSTANT } from '../posting/kit.ts';
import {
  DAY,
  KIND,
  MAKER,
  REVERSER,
  TIMEOUT,
  account,
  adjustment,
  close,
  context,
  expectChannelOpen,
  expectNoTrace,
  freeze,
  increasedThenFrozen,
  open,
  outcome,
  post,
  reversalOf,
  snapshot,
  type AdjustLine,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

/** ledger.reverse in its own transaction, after locking the user's balance row. */
function genericReverse(
  db: Kysely<DB>,
  ledger: Ledger,
  appId: string,
  userId: string,
  key: string,
) {
  return outcome(
    db.transaction().execute(async (trx) => {
      await ledger.lockBalances(trx, { appId, userIds: [userId] });
      return ledger.reverse(trx, { appId, originalUniqKey: key });
    }),
  );
}

/**
 * A stored voucher's accounting date (PostgreSQL date rendered as text, independent of the runner
 * timezone) and the booked_at of every one of its entries, as ISO instants.
 */
async function dating(db: Kysely<DB>, appId: string, voucherId: string) {
  const [vouchers, entries] = await Promise.all([
    db
      .selectFrom('ledger_vouchers')
      .select((eb) => eb.cast<string>('accounting_date', 'text').as('day'))
      .where('app_id', '=', appId)
      .where('id', '=', voucherId)
      .execute(),
    db
      .selectFrom('ledger_entries')
      .select('booked_at')
      .where('app_id', '=', appId)
      .where('voucher_id', '=', voucherId)
      .orderBy('id')
      .execute(),
  ]);
  return {
    days: vouchers.map((v) => v.day),
    bookedAt: entries.map((e) => e.booked_at.toISOString()),
  };
}

it.each([
  { subType: 'RECON_FIX', counter: 'COMMISSION_REVENUE' },
  { subType: 'RECON_FIX', counter: 'UNION_RECEIVABLE:taobao' },
  { subType: 'PAYOUT_RECOVERY', counter: 'CASH_ALIPAY' },
  { subType: 'PAYOUT_RECOVERY', counter: 'CASH_WECHAT' },
  { subType: 'OTHER', counter: 'MKT_EXPENSE' },
] satisfies AdjustLine[])(
  '[AC-B2-12b#12] 调增 +500 已冻结 300 后带受信 kind 整笔红冲：available 200→−300，凭证借贷平衡：%j',
  async (line) => {
    const { ledger, appId } = context();
    const { a, original } = await increasedThenFrozen(h.db, ledger, appId, line);
    const reversal = reversalOf(original);
    expect(await outcome(post(h.db, ledger, [a.user_id], reversal))).toMatchObject({
      kind: 'posted',
    });
    expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
      { ...a, available_fen: -300n, frozen_fen: 300n, version: 3n, negative_since: DAY },
    ]);
    const after = await snapshot(h.db, appId);
    const stored = after.vouchers.filter((v) => v.uniq_key === reversal.uniqKey);
    expect(stored).toHaveLength(1);
    // The reversal carries its own operator, never the original's (D10-590 ①: not ledger.reverse).
    expect(stored[0]).toMatchObject({
      operator: REVERSER,
      voucher_kind: KIND,
      biz_type: 'ADMIN_ADJUST',
    });
    const counter = after.accounts.find(
      (row) => row.owner_type === 'platform' && row.subject === line.counter,
    );
    const lines = after.entries.filter((e) => e.voucher_id === stored[0]?.id);
    expect(lines).toHaveLength(2);
    expect(lines.find((e) => e.account_id === a.account_id)).toMatchObject({
      sub_account: 'available',
      amount_fen: 500n,
      ledger_type: 'ADMIN_ADJUST',
      sub_type: line.subType,
      balance_after_fen: -300n,
      account_version: 3n,
    });
    expect(lines.find((e) => e.account_id === counter?.id)).toMatchObject({
      sub_account: 'available',
      amount_fen: -500n,
      ledger_type: 'ADMIN_ADJUST',
      sub_type: line.subType,
      balance_after_fen: null,
    });
    // The original is untouched (insert-only): still its own operator and amounts.
    expect(after.vouchers.find((v) => v.uniq_key === original.uniqKey)).toMatchObject({
      operator: MAKER,
    });
    expect(after.vouchers).toHaveLength(3);
    expect(after.entries).toHaveLength(6);
  },
  TIMEOUT,
);

it(
  '[AC-B2-12b#13] 增方向调账单已被提走后红冲到负数成功；重放与通用 reverse 都返回同一凭证，红冲单不能再红冲',
  async () => {
    const { ledger, clock, appId } = context();
    const { a, original } = await increasedThenFrozen(h.db, ledger, appId);
    clock.set('2032-06-30T16:00:00.000Z');
    const reversal = reversalOf(original);
    const first = await outcome(post(h.db, ledger, [a.user_id], reversal));
    expect(first).toMatchObject({ kind: 'posted' });
    const balance = {
      ...a,
      available_fen: -300n,
      frozen_fen: 300n,
      version: 3n,
      negative_since: '2032-07-01',
    };
    expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([balance]);
    const posted = await snapshot(h.db, appId);
    const voucherId = 'voucherId' in first ? first.voucherId : null;

    // Cross-month (BR-FUND-16: accounting date = the injected Clock's +08:00 day at write time):
    // the reversal is dated 2032-07-01 and booked at the Clock's instant; the original keeps its own.
    const reversalAt = clock.now();
    expect(reversalAt.toISOString()).toBe('2032-06-30T16:00:00.000Z');
    expect(accountingDate(reversalAt)).toBe('2032-07-01');
    expect(voucherId).toEqual(expect.any(String));
    expect(await dating(h.db, appId, String(voucherId))).toEqual({
      days: [accountingDate(reversalAt)],
      bookedAt: [reversalAt.toISOString(), reversalAt.toISOString()],
    });
    const originalId = posted.vouchers.find((v) => v.uniq_key === original.uniqKey)?.id;
    expect(originalId).toEqual(expect.any(String));
    expect(await dating(h.db, appId, String(originalId))).toEqual({
      days: [DAY],
      bookedAt: [INSTANT, INSTANT],
    });

    // One reversal per original (BR-FUND-24 细则): a replay is the same voucher, no second write.
    expect(await outcome(post(h.db, ledger, [a.user_id], reversal))).toEqual({
      kind: 'duplicate',
      voucherId,
    });
    expect(
      await outcome(
        post(h.db, ledger, [a.user_id], { ...reversal, bizId: randomUUID(), memo: 'again' }),
      ),
    ).toEqual({ kind: 'duplicate', voucherId });
    expect(await genericReverse(h.db, ledger, appId, a.user_id, original.uniqKey)).toEqual({
      kind: 'duplicate',
      voucherId,
    });
    expect(await genericReverse(h.db, ledger, appId, a.user_id, reversal.uniqKey)).toEqual({
      refused: 'CANNOT_REVERSE_REVERSAL',
    });
    expect(await snapshot(h.db, appId)).toEqual(posted);
    expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([balance]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-12b#14] 红冲前已为负（−100）时整笔红冲到 −600，负起始日保留首次变负的会计日',
  async () => {
    const { ledger, clock, appId } = context();
    const a = await account(h.db, ledger, appId);
    const original = adjustment(appId, a.account_id, `ADJ:${randomUUID()}`, -500n);
    expect(await outcome(post(h.db, ledger, [a.user_id], original))).toMatchObject({
      kind: 'posted',
    });
    // A later 600 clawback leaves -100 (BR-FUND-10 allows it); first negative day 2032-06-15.
    const clawback = adjustment(appId, a.account_id, `taobao:${randomUUID()}:CLAWBACK`, 600n, {
      subType: 'FULL',
      counter: 'UNION_RECEIVABLE:taobao',
    });
    expect(
      await outcome(
        post(h.db, ledger, [a.user_id], {
          ...clawback,
          bizType: 'CLAWBACK',
          voucherKind: null,
          entries: clawback.entries.map((e) => ({ ...e, ledger_type: 'CLAWBACK' })),
        }),
      ),
    ).toMatchObject({ kind: 'posted' });
    clock.set('2032-07-02T16:00:00.000Z');
    const reversal = reversalOf(original);
    expect(await outcome(post(h.db, ledger, [a.user_id], reversal))).toMatchObject({
      kind: 'posted',
    });
    expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
      { ...a, available_fen: -600n, version: 3n, negative_since: DAY },
    ]);
    const after = await snapshot(h.db, appId);
    const id = after.vouchers.find((v) => v.uniq_key === reversal.uniqKey)?.id;
    expect(
      after.entries.find((e) => e.voucher_id === id && e.account_id === a.account_id),
    ).toMatchObject({ amount_fen: 500n, balance_after_fen: -600n, account_version: 3n });
  },
  TIMEOUT,
);

it.each(['ADMIN_ADJUST', null])(
  '[AC-B2-12b#15] 通用 ledger.reverse 对 ADMIN_ADJUST 仍拒绝扣负且不留痕（原凭证 voucher_kind=%j）；调账自己的受信红冲可记账',
  async (kind) => {
    const { ledger, appId } = context();
    const a = await account(h.db, ledger, appId);
    const original = {
      ...adjustment(appId, a.account_id, `ADJ:${randomUUID()}`, -500n),
      voucherKind: kind,
    };
    expect(await outcome(post(h.db, ledger, [a.user_id], original))).toMatchObject({
      kind: 'posted',
    });
    expect(
      await outcome(post(h.db, ledger, [a.user_id], freeze(appId, a.account_id, 300n))),
    ).toMatchObject({ kind: 'posted' });
    const key = `${original.uniqKey}:REVERSE`;
    const before = await snapshot(h.db, appId);
    expect(await genericReverse(h.db, ledger, appId, a.user_id, original.uniqKey)).toEqual({
      refused: 'NEGATIVE_BALANCE',
    });
    await expectNoTrace(h.db, appId, before, key);

    expect(await outcome(post(h.db, ledger, [a.user_id], reversalOf(original)))).toMatchObject({
      kind: 'posted',
    });
    expect((await snapshot(h.db, appId)).vouchers.find((v) => v.uniq_key === key)).toMatchObject({
      operator: REVERSER,
      voucher_kind: KIND,
    });
    expect((await ledger.getBalances(h.db, { appId, userIds: [a.user_id] }))[0]).toMatchObject({
      available_fen: -300n,
      frozen_fen: 300n,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12b#16] 调减方向原单（PAYOUT_RECOVERY / ACCOUNT_CLOSED）的整笔红冲使余额回升，带受信 kind 照常记账',
  async () => {
    await expectChannelOpen(h.db);
    const { ledger, clock, appId } = context();
    const a = await account(h.db, ledger, appId);
    const credit = adjustment(appId, a.account_id, `ADJ:${randomUUID()}`, -3000n);
    expect(await outcome(post(h.db, ledger, [a.user_id], credit))).toMatchObject({
      kind: 'posted',
    });
    // BR-FUND-24 例（追回重复打款）：调减 10000，available 3000 -> -7000.
    const recovery = adjustment(appId, a.account_id, `ADJ:${randomUUID()}`, 10000n, {
      subType: 'PAYOUT_RECOVERY',
      counter: 'CASH_ALIPAY',
    });
    expect(await outcome(post(h.db, ledger, [a.user_id], recovery))).toMatchObject({
      kind: 'posted',
    });
    clock.set('2032-06-16T16:00:00.000Z');
    expect(await outcome(post(h.db, ledger, [a.user_id], reversalOf(recovery)))).toMatchObject({
      kind: 'posted',
    });
    expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
      { ...a, available_fen: 3000n, version: 3n, negative_since: null },
    ]);
    // ACCOUNT_CLOSED 调减 3000 to zero, then its reversal brings the balance back (D10-590).
    const closed = adjustment(appId, a.account_id, `ADJ:${randomUUID()}`, 3000n, {
      subType: 'ACCOUNT_CLOSED',
      counter: 'COMMISSION_REVENUE',
    });
    expect(await outcome(post(h.db, ledger, [a.user_id], closed))).toMatchObject({
      kind: 'posted',
    });
    expect(await outcome(post(h.db, ledger, [a.user_id], reversalOf(closed)))).toMatchObject({
      kind: 'posted',
    });
    expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
      { ...a, available_fen: 3000n, version: 5n, negative_since: null },
    ]);
  },
  TIMEOUT,
);
