// B2-12b (BR-FUND-10, BR-FUND-24 细则; 编排 D10-590 ① 第 2、4、6 条): everything except the trusted
// ADMIN_ADJUST `ADJ:{adjust_id}:REVERSE` stays refused when it would leave available below zero,
// with no voucher, entry, account or balance written. Each test first checks the opened channel
// in an app of its own (expectChannelOpen), so on the skeleton it is red by that assertion.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PostingVoucher } from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  KIND,
  RECON_FIX,
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

/**
 * Adjustment +500, 300 frozen (available 200), then `tamper` turns its whole reversal into the
 * write under test: it must be refused with `code` and leave this app exactly as it was.
 */
async function expectRefused(
  tamper: (reversal: PostingVoucher, adjustId: string) => PostingVoucher,
  code: RegExp = /^NEGATIVE_BALANCE$/,
  line: AdjustLine = RECON_FIX,
): Promise<void> {
  const { ledger, appId } = context();
  const { a, original } = await increasedThenFrozen(h.db, ledger, appId, line);
  const v = tamper(reversalOf(original), original.uniqKey.slice('ADJ:'.length));
  const before = await snapshot(h.db, appId);
  expect(await outcome(post(h.db, ledger, [a.user_id], v))).toMatchObject({
    refused: expect.stringMatching(code),
  });
  await expectNoTrace(h.db, appId, before, v.uniqKey);
  expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
    { ...a, available_fen: 200n, frozen_fen: 300n, version: 2n },
  ]);
}

it.each([null, 'ADMIN_ADJUST', 'REASSIGN_REV', 'CLAWBACK', 'PAY_FEE'])(
  '[AC-B2-12b#17] 没带受信 kind（voucherKind=%j）的 ADJ:*:REVERSE 扣负一律拒绝且不留痕',
  async (voucherKind) => {
    await expectChannelOpen(h.db);
    await expectRefused((v) => ({ ...v, voucherKind }));
  },
  TIMEOUT,
);

it.each(['admin_adjust_rev', 'ADMIN_ADJUST_REV ', ' ADMIN_ADJUST_REV', 'ADJ_REVERSE', 'REVERSE'])(
  '[AC-B2-12b#18] voucherKind=%j 不是受信值，扣负拒绝且不留痕',
  async (voucherKind) => {
    await expectChannelOpen(h.db);
    await expectRefused((v) => ({ ...v, voucherKind }), /^(NEGATIVE_BALANCE|INVALID_INPUT)$/);
  },
  TIMEOUT,
);

it.each([
  'ADJ:{other}',
  'ADJ:{id}:REVERSE:REVERSE',
  'ADJ:{id}:x:REVERSE',
  'ADJ:{id}:REVERSED',
  'adj:{id}:REVERSE',
  'XADJ:{id}:REVERSE',
  '{id}:REVERSE',
  'taobao:1234567:42:self:ADJ:{id}:REVERSE',
  'wd:{id}:PAID:REVERSE',
])(
  '[AC-B2-12b#19] 受信 kind 配上不是 ADJ:{adjust_id}:REVERSE 的键（%s）扣负一律拒绝且不留痕',
  async (template) => {
    await expectChannelOpen(h.db);
    await expectRefused((v, id) => ({
      ...v,
      uniqKey: template.replaceAll('{id}', id).replaceAll('{other}', randomUUID()),
    }));
  },
  TIMEOUT,
);

it.each([
  'CLAWBACK',
  'SETTLE_ADJUST',
  'REBATE_CREDIT',
  'SHARE_CREDIT',
  'REFERRAL_CREDIT',
  'WITHDRAW_FREEZE',
  'WITHDRAW_PAID',
  'WITHDRAW_FEE',
  'TAX_WITHHOLD',
  'REWARD',
  'BAD_DEBT_WRITEOFF',
])(
  '[AC-B2-12b#20] %s 冒用调账红冲的受信 kind 与 ADJ 键扣负一律拒绝且不留痕',
  async (ledgerType) => {
    await expectChannelOpen(h.db);
    await expectRefused((v) => ({
      ...v,
      entries: v.entries.map((e) => ({ ...e, ledger_type: ledgerType })),
    }));
  },
  TIMEOUT,
);

it.each([
  { subType: 'RESTORE', counter: 'UNION_RECEIVABLE:taobao' },
  { subType: null, counter: 'COMMISSION_REVENUE' },
  { subType: 'ADMIN_ADJUST_REV', counter: 'COMMISSION_REVENUE' },
  { subType: 'REASSIGN_REV', counter: 'COMMISSION_REVENUE' },
  { subType: 'FULL', counter: 'UNION_RECEIVABLE:taobao' },
])(
  '[AC-B2-12b#21] ADMIN_ADJUST sub_type 不是人工原因码（%j）时受信 kind 不放行，扣负拒绝且不留痕',
  async (line) => {
    await expectChannelOpen(h.db);
    await expectRefused((v) => v, /^NEGATIVE_BALANCE$/, line);
  },
  TIMEOUT,
);

it.each(['WITHDRAW_FEE', 'TAX_WITHHOLD', 'WITHDRAW_FREEZE', 'CLAWBACK'])(
  '[AC-B2-12b#22] 红冲凭证里夹带 %s 分录借受信 kind 扣负：整单拒绝且不留痕',
  async (ledgerType) => {
    await expectChannelOpen(h.db);
    await expectRefused((v) => {
      const user = v.entries[0]!;
      return {
        ...v,
        entries: [
          { ...user, amount_fen: 100n },
          { ...user, amount_fen: 400n, ledger_type: ledgerType, sub_type: null },
          v.entries[1]!,
        ],
      };
    });
  },
  TIMEOUT,
);

const NAMED_FIELDS: readonly Partial<PostingVoucher>[] = [
  { bizType: KIND },
  { bizId: KIND },
  { memo: KIND },
  { operator: KIND },
];

it.each(NAMED_FIELDS)(
  '[AC-B2-12b#23] 受信 kind 只由服务端经 voucherKind 传入，不从其他字段推断：%j',
  async (fields) => {
    await expectChannelOpen(h.db);
    await expectRefused((v) => ({ ...v, ...fields, voucherKind: null }));
  },
  TIMEOUT,
);

it.each([
  ['REBATE_CREDIT', null, 'self', 'CREDIT'],
  ['SHARE_CREDIT', null, 'share', 'CREDIT'],
  ['REFERRAL_CREDIT', 'DIRECT', 'direct', 'CREDIT'],
  ['SETTLE_ADJUST', 'SETTLE_DIFF', 'self', 'ADJ:3'],
  ['ADMIN_ADJUST', 'RESTORE', 'self', 'RESTORE:R7'],
] as const)(
  '[AC-B2-12b#24] BR-FUND-10：%s/%s 入账类红冲带不带受信 kind 都须写后 ≥0，扣负拒绝且不留痕',
  async (ledgerType, subType, role, suffix) => {
    await expectChannelOpen(h.db);
    const { ledger, appId } = context();
    const a = await account(h.db, ledger, appId);
    const base = adjustment(
      appId,
      a.account_id,
      `taobao:${randomUUID()}:${a.user_id}:${role}:${suffix}`,
      -500n,
      { subType, counter: 'UNION_RECEIVABLE:taobao' },
    );
    const original: PostingVoucher = {
      ...base,
      bizType: 'ORDER_CREDIT',
      voucherKind: null,
      entries: base.entries.map((e) => ({ ...e, ledger_type: ledgerType })),
    };
    expect(await outcome(post(h.db, ledger, [a.user_id], original))).toMatchObject({
      kind: 'posted',
    });
    expect(
      await outcome(post(h.db, ledger, [a.user_id], freeze(appId, a.account_id, 300n))),
    ).toMatchObject({ kind: 'posted' });
    const before = await snapshot(h.db, appId);
    for (const voucherKind of [KIND, null]) {
      const v = reversalOf(original, { voucherKind });
      expect(await outcome(post(h.db, ledger, [a.user_id], v))).toEqual({
        refused: 'NEGATIVE_BALANCE',
      });
      await expectNoTrace(h.db, appId, before, v.uniqKey);
    }
    expect(
      await outcome(
        h.db.transaction().execute(async (trx) => {
          await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
          return ledger.reverse(trx, { appId, originalUniqKey: original.uniqKey });
        }),
      ),
    ).toEqual({ refused: 'NEGATIVE_BALANCE' });
    await expectNoTrace(h.db, appId, before, `${original.uniqKey}:REVERSE`);
  },
  TIMEOUT,
);
