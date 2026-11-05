// 单元测试：BR-FUND-05/10/16 补充例；规则测试在 test/spec/domain/ledger 与 test/properties/domain/ledger。
import { expect, it } from 'vitest';
import { applyEntries, mayGoNegative, uniqKey, validateVoucher } from './ledger.ts';
import type { LedgerEntry, NegativeBalanceInput } from './ledger.ts';

const user = (
  amount_fen: bigint,
  sub_account: 'available' | 'frozen' = 'available',
): LedgerEntry => ({
  account_id: 'user-42',
  account_code: 'USER_BALANCE',
  sub_account,
  amount_fen,
});

const negative = (overrides: Partial<NegativeBalanceInput>): NegativeBalanceInput => ({
  ledger_type: 'CLAWBACK',
  sub_type: null,
  uniq_key: 'taobao:1234567:42:self:CLAWBACK:rights-1',
  resulting_available_fen: -1n,
  available_delta_fen: -1n,
  ...overrides,
});

it('[AC-B2-01h#33] BR-FUND-10：增加类红冲（冲回记错的扣回 −800 → −400）写后仍为负放行', () => {
  expect(
    mayGoNegative(
      negative({
        uniq_key: 'taobao:1234567:42:self:CLAWBACK:rights-1:REVERSE',
        available_delta_fen: 400n,
        resulting_available_fen: -400n,
      }),
    ),
  ).toBe(true);
});

it('[AC-B2-01h#34] BR-FUND-10：余额为负时 WITHDRAW_FEE 继续下降拒绝，写后非负放行', () => {
  const fee = negative({
    ledger_type: 'WITHDRAW_FEE',
    uniq_key: 'WDR:1:FEE',
    available_delta_fen: -100n,
    resulting_available_fen: -500n,
  });
  expect(mayGoNegative(fee)).toBe(false);
  expect(mayGoNegative({ ...fee, resulting_available_fen: 0n })).toBe(true);
});

it('[AC-B2-01h#35] BR-FUND-10：未知 reversal_kind 一律拒绝，不当作普通写入', () => {
  const input = { ...negative({}), reversal_kind: 'OTHER' } as unknown as NegativeBalanceInput;
  expect(mayGoNegative(input)).toBe(false);
});

it('[AC-B2-01h#36] BR-FUND-16：总借方超出 PG bigint 时报凭证级金额错误而不是抛出', () => {
  const max = 9223372036854775807n;
  const platform = (amount_fen: bigint): LedgerEntry => ({
    account_id: 'union-taobao',
    account_code: 'UNION_RECEIVABLE',
    sub_account: null,
    amount_fen,
  });
  expect(validateVoucher([platform(max), platform(1n), user(-max), user(-1n)])).toEqual({
    ok: false,
    errors: [{ code: 'INVALID_AMOUNT', entry_index: null }],
  });
});

it('[AC-B2-01h#37] BR-FUND-16：同账户 ID 但科目不是 USER_BALANCE 的分录拒绝而非跳过', () => {
  const balance = { account_id: 'user-42', available_fen: 0n, frozen_fen: 0n };
  const wrong: LedgerEntry = { ...user(1n), account_code: 'UNION_RECEIVABLE', sub_account: null };
  expect(() => applyEntries(balance, [wrong])).toThrow(RangeError);
});

it('[AC-B2-01h#38] BR-FUND-16：余额溢出 PG bigint 时抛 RangeError', () => {
  const balance = { account_id: 'user-42', available_fen: 9223372036854775807n, frozen_fen: 0n };
  expect(() => applyEntries(balance, [user(-1n)])).toThrow(RangeError);
});

it('[AC-B2-01h#39] REVERSE 原键含空分量拒绝，PLATFORM_FORFEIT 不带改派号时不加 REASSIGN 段', () => {
  expect(() => uniqKey({ kind: 'REVERSE', original_uniq_key: 'ADJ::1' })).toThrow(RangeError);
  expect(() => uniqKey({ kind: 'REVERSE', original_uniq_key: ':ADJ' })).toThrow(RangeError);
  expect(
    uniqKey({ kind: 'PLATFORM_FORFEIT', order_key: 'jd:9', user_id: '7', role: 'indirect' }),
  ).toBe('jd:9:PLATFORM:FORFEIT:7:indirect');
});

const adjustReverse = (overrides: Partial<NegativeBalanceInput>): NegativeBalanceInput =>
  negative({
    ledger_type: 'ADMIN_ADJUST',
    sub_type: 'OTHER',
    uniq_key: 'ADJ:9001:REVERSE',
    resulting_available_fen: -300n,
    available_delta_fen: -500n,
    reversal_kind: 'ADMIN_ADJUST_REV',
    ...overrides,
  });

it('[AC-B2-12b#1] BR-FUND-24：受信调账红冲 kind 只放行 ADJ:{id}:REVERSE 的人工原因码扣负', () => {
  expect(mayGoNegative(adjustReverse({}))).toBe(true);
  expect(mayGoNegative(adjustReverse({ sub_type: 'PAYOUT_RECOVERY' }))).toBe(true);
  expect(mayGoNegative(adjustReverse({ sub_type: 'RESTORE' }))).toBe(false);
  expect(mayGoNegative(adjustReverse({ sub_type: null }))).toBe(false);
  expect(mayGoNegative(adjustReverse({ uniq_key: 'ADJ:9001' }))).toBe(false);
  expect(mayGoNegative(adjustReverse({ uniq_key: 'ADJ:a:b:REVERSE' }))).toBe(false);
  expect(mayGoNegative(adjustReverse({ ledger_type: 'CLAWBACK' }))).toBe(false);
});

it('[AC-B2-12b#6] 两种受信 kind 不互借：REASSIGN_REV 不放行调账红冲，没带 kind 的调账红冲扣负拒绝', () => {
  expect(mayGoNegative(adjustReverse({ reversal_kind: 'REASSIGN_REV' }))).toBe(false);
  expect(
    mayGoNegative(
      negative({
        ledger_type: 'ADMIN_ADJUST',
        sub_type: 'OTHER',
        uniq_key: 'ADJ:9001:REVERSE',
        resulting_available_fen: -300n,
        available_delta_fen: -500n,
      }),
    ),
  ).toBe(false);
  expect(
    mayGoNegative(
      negative({ ledger_type: 'REBATE_CREDIT', uniq_key: 'k', reversal_kind: 'ADMIN_ADJUST_REV' }),
    ),
  ).toBe(false);
});
