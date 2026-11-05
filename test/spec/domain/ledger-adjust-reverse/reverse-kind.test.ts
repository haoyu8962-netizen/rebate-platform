// B2-12b (BR-FUND-10, BR-FUND-16, BR-FUND-24 细则「红冲只按原单整笔」; 编排 D10-590 ①):
// the whole reversal `ADJ:{adjust_id}:REVERSE` of an executed ADMIN_ADJUST may leave available
// below zero, but only with the trusted reversal_kind ADMIN_ADJUST_REV that the ledger passes for
// the adjustment flow. Without it, with another key, type or sub type, it stays refused.
// Every test first checks the opened channel, so on the current code each one is red by assertion.
import { mayGoNegative, type NegativeBalanceInput } from '@couli/domain';
import { expect, it } from 'vitest';

const KIND = 'ADMIN_ADJUST_REV' as const;
/** The manual reason codes whose increase can be reversed into a negative balance (BR-FUND-24 ②). */
const MANUAL_SUB_TYPES = ['RECON_FIX', 'PAYOUT_RECOVERY', 'OTHER'] as const;
const CREDIT_TYPES = ['REBATE_CREDIT', 'SHARE_CREDIT', 'REFERRAL_CREDIT'] as const;

/**
 * Adjustment 9001 credited +500; the user then withdrew 300 (available 200). Its whole reversal
 * debits 500: available 200 -> -300. No reversal_kind here.
 */
function untrusted(overrides: Partial<NegativeBalanceInput> = {}): NegativeBalanceInput {
  return {
    ledger_type: 'ADMIN_ADJUST',
    sub_type: 'RECON_FIX',
    uniq_key: 'ADJ:9001:REVERSE',
    resulting_available_fen: -300n,
    available_delta_fen: -500n,
    ...overrides,
  };
}

/** The same write with the trusted context of the adjustment reversal. */
function trusted(overrides: Partial<NegativeBalanceInput> = {}): NegativeBalanceInput {
  return { ...untrusted(overrides), reversal_kind: KIND };
}

/** The opened channel: red on the current code, where every ':REVERSE' decrease is refused. */
function expectChannelOpen(): void {
  expect(mayGoNegative(trusted())).toBe(true);
}

it.each(MANUAL_SUB_TYPES)(
  '[AC-B2-12b#1] BR-FUND-24：ADMIN_ADJUST/%s 增方向调账单整笔红冲带受信 kind 可扣至负数',
  (sub_type) => {
    expect(mayGoNegative(trusted({ sub_type }))).toBe(true);
    // Already negative before the reversal: -100 -> -600 is still the same whole reversal.
    expect(
      mayGoNegative(
        trusted({ sub_type, resulting_available_fen: -600n, available_delta_fen: -500n }),
      ),
    ).toBe(true);
    // adjust_id as the UUIDv7 the platform generates.
    expect(
      mayGoNegative(
        trusted({ sub_type, uniq_key: 'ADJ:01933b6e-8f1a-7c3d-9a2b-4c5d6e7f8091:REVERSE' }),
      ),
    ).toBe(true);
  },
);

it('[AC-B2-12b#2] 没带受信 kind：同一 ADJ:*:REVERSE 扣负仍被拒绝，写后不为负照常放行', () => {
  expectChannelOpen();
  expect(mayGoNegative(untrusted())).toBe(false);
  for (const sub_type of MANUAL_SUB_TYPES) {
    expect(mayGoNegative(untrusted({ sub_type }))).toBe(false);
  }
  expect(mayGoNegative(untrusted({ resulting_available_fen: 0n }))).toBe(true);
});

it.each([
  'ADJ:9001',
  'ADJ:9001:REVERSE:REVERSE',
  'ADJ::REVERSE',
  'ADJ:9001:extra:REVERSE',
  'ADJ:9001:REVERSED',
  'ADJ:9001:reverse',
  'adj:9001:REVERSE',
  'XADJ:9001:REVERSE',
  ' ADJ:9001:REVERSE',
  'ADJ:9001:REVERSE ',
  'ADJ:9001:REVERSE\n',
  '9001:REVERSE',
  'taobao:1234567:42:self:ADJ:3:REVERSE',
  'taobao:1234567:42:self:CREDIT:REVERSE',
  'wd:w2026:PAID:REVERSE',
  '',
])('[AC-B2-12b#3] 受信 kind 只认 ADJ:{adjust_id}:REVERSE，其他键扣负一律拒绝：%j', (uniq_key) => {
  expectChannelOpen();
  expect(mayGoNegative(trusted({ uniq_key }))).toBe(false);
});

it.each([
  'CLAWBACK',
  'SETTLE_ADJUST',
  ...CREDIT_TYPES,
  'WITHDRAW_FREEZE',
  'WITHDRAW_PAID',
  'WITHDRAW_RETURN',
  'WITHDRAW_FEE',
  'TAX_WITHHOLD',
  'REWARD',
  'BAD_DEBT_WRITEOFF',
  'PAY_FEE',
  'ADMIN_ADJUST_REV',
  'admin_adjust',
  'UNKNOWN',
])('[AC-B2-12b#4] ledger_type=%s 冒用调账红冲 kind 与 ADJ 键扣负一律拒绝', (ledger_type) => {
  expectChannelOpen();
  expect(mayGoNegative(trusted({ ledger_type }))).toBe(false);
  expect(mayGoNegative(trusted({ ledger_type, sub_type: null }))).toBe(false);
});

it.each([
  'RESTORE',
  null,
  'ADMIN_ADJUST_REV',
  'REASSIGN_REV',
  'recon_fix',
  'FULL',
  'SETTLE_DIFF',
  'UNKNOWN',
])('[AC-B2-12b#5] ADMIN_ADJUST sub_type=%j 不走调账红冲通道，扣负拒绝', (sub_type) => {
  expectChannelOpen();
  expect(mayGoNegative(trusted({ sub_type }))).toBe(false);
});

it('[AC-B2-12b#6] 两种受信 kind 互不借用：REASSIGN_REV 不放行调账红冲，调账 kind 不放行改派红冲', () => {
  expectChannelOpen();
  expect(mayGoNegative({ ...untrusted(), reversal_kind: 'REASSIGN_REV' })).toBe(false);
  for (const ledger_type of CREDIT_TYPES) {
    const reassign = untrusted({ ledger_type, sub_type: null, uniq_key: 'opaque-reassign-key' });
    expect(mayGoNegative({ ...reassign, reversal_kind: 'REASSIGN_REV' })).toBe(true);
    expect(mayGoNegative({ ...reassign, reversal_kind: KIND })).toBe(false);
  }
});

it.each([
  'admin_adjust_rev',
  'ADMIN_ADJUST',
  'ADJ_REVERSE',
  'REVERSE',
  'ADMIN_ADJUST_REV ',
  '',
  true,
  1,
])('[AC-B2-12b#7] reversal_kind=%j 不是受信值，一律按失败关闭', (reversal_kind) => {
  expectChannelOpen();
  expect(mayGoNegative({ ...untrusted(), reversal_kind } as unknown as NegativeBalanceInput)).toBe(
    false,
  );
});

it.each([
  { ledger_type: 'ADMIN_ADJUST_REV' },
  { sub_type: 'ADMIN_ADJUST_REV' },
  { uniq_key: 'ADJ:ADMIN_ADJUST_REV:REVERSE' },
  { ledger_type: 'ADMIN_ADJUST_REV', sub_type: 'ADMIN_ADJUST_REV' },
] satisfies Partial<NegativeBalanceInput>[])(
  '[AC-B2-12b#8] 受信 kind 不从类型名、子类型或键推断：%j 不带 kind 扣负拒绝',
  (overrides) => {
    expectChannelOpen();
    expect(mayGoNegative(untrusted(overrides))).toBe(false);
  },
);

it.each([
  ['REBATE_CREDIT', null, 'taobao:1234567:42:self:CREDIT'],
  ['SHARE_CREDIT', null, 'taobao:1234567:42:share:CREDIT'],
  ['REFERRAL_CREDIT', 'DIRECT', 'taobao:1234567:42:direct:CREDIT'],
  ['SETTLE_ADJUST', 'SETTLE_DIFF', 'taobao:1234567:42:self:ADJ:3'],
  ['ADMIN_ADJUST', 'RESTORE', 'taobao:1234567:42:self:RESTORE:R7'],
] as const)(
  '[AC-B2-12b#9] BR-FUND-10：%s/%s 入账类红冲带不带调账 kind 都须写后 ≥0',
  (ledger_type, sub_type, original) => {
    expectChannelOpen();
    const reversal = untrusted({ ledger_type, sub_type, uniq_key: `${original}:REVERSE` });
    expect(mayGoNegative(reversal)).toBe(false);
    expect(mayGoNegative({ ...reversal, reversal_kind: KIND })).toBe(false);
    expect(mayGoNegative({ ...reversal, resulting_available_fen: -1n })).toBe(false);
    expect(mayGoNegative({ ...reversal, resulting_available_fen: 0n })).toBe(true);
  },
);

it('[AC-B2-12b#10] 带受信 kind 的红冲写后为零或正、或使负余额回升，照常放行', () => {
  for (const sub_type of [...MANUAL_SUB_TYPES, 'ACCOUNT_CLOSED']) {
    // Reversing an increase down to exactly zero, or to a positive balance.
    expect(mayGoNegative(trusted({ sub_type, resulting_available_fen: 0n }))).toBe(true);
    expect(mayGoNegative(trusted({ sub_type, resulting_available_fen: 1n }))).toBe(true);
    // Reversing a decrease (e.g. -500 ACCOUNT_CLOSED / PAYOUT_RECOVERY): -800 -> -300.
    expect(
      mayGoNegative(
        trusted({ sub_type, available_delta_fen: 500n, resulting_available_fen: -300n }),
      ),
    ).toBe(true);
  }
});

it.each([
  { resulting_available_fen: -300 },
  { resulting_available_fen: '-300' },
  { available_delta_fen: -500 },
  { available_delta_fen: '-500' },
  { uniq_key: 9001 },
  { ledger_type: null },
  { sub_type: 7 },
])('[AC-B2-12b#11] 带受信 kind 的畸形输入不隐式转型放行：%j', (overrides) => {
  expectChannelOpen();
  expect(mayGoNegative({ ...trusted(), ...overrides } as unknown as NegativeBalanceInput)).toBe(
    false,
  );
});
