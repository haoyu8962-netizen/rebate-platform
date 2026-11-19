// B2-02z rule-test expectations (claude-independent), written out from the rules, never from the
// code: D10-2092 / D10-2093 (BALANCE_CORRECTED: inbox only, category service, default title
// inbox.title.BALANCE_CORRECTED「余额更正」of contracts/texts.default.json, default body below),
// contracts/openapi.yaml recalcBalanceAdminReconDiff「Member notice」({before} / {after} per
// BR-TEXT-10: '-' before '¥' for a negative balance, no '+' for a positive one), 08 BR-TEXT-10 细则
// App table and algorithm (inbox messages are outside the admin exception: no thousands separator,
// no forced two decimals; 0 → 「¥0」, D10-2115). Pure module: imported by unit and integration tests.

export const CODE = 'BALANCE_CORRECTED';
export const TITLE = '余额更正';
export const TEMPLATE =
  '核对账目时发现你的余额显示与流水明细不一致，已按流水明细更正：可用余额由 {before} 调整为 {after}。如有疑问，请联系客服。';

/** The default body with both variables filled in (already formatted). */
export function bodyOf(before: string, after: string): string {
  return `核对账目时发现你的余额显示与流水明细不一致，已按流水明细更正：可用余额由 ${before} 调整为 ${after}。如有疑问，请联系客服。`;
}

/** 「¥」 and the yuan of a non-negative amount, per the BR-TEXT-10 algorithm. */
function unsigned(magnitude: bigint): string {
  const yuan = magnitude / 100n;
  const cent = magnitude % 100n;
  if (cent === 0n) return `¥${yuan.toString()}`;
  if (cent % 10n === 0n) return `¥${yuan.toString()}.${(cent / 10n).toString()}`;
  return `¥${yuan.toString()}.${cent < 10n ? '0' : ''}${cent.toString()}`;
}

/**
 * BR-TEXT-10 细则「算法」(App format), written from the rule text: yuan = abs(fen) div 100,
 * cent = abs(fen) mod 100; cent = 0 → 「¥{yuan}」; cent mod 10 = 0 → 「¥{yuan}.{cent/10}」; otherwise
 * 「¥{yuan}.{two-digit cent}」; a negative amount puts ASCII '-' before '¥'; no '+' here.
 */
export function appYuan(fen: bigint): string {
  return fen < 0n ? `-${unsigned(-fen)}` : unsigned(fen);
}

/**
 * [label, before fen, after fen, before text, after text] of the default body, each text formatted
 * by hand from the BR-TEXT-10 App table (990 → ¥9.9, 1000 → ¥10, 1 → ¥0.01, 0 → ¥0,
 * 123456 → ¥1234.56, -150 → -¥1.5) and its algorithm.
 */
export const AMOUNT_VECTORS: [string, bigint, bigint, string, string][] = [
  ['调增', 990n, 123_456n, '¥9.9', '¥1234.56'],
  ['调减', 1000n, 1n, '¥10', '¥0.01'],
  ['调减到负数', 500n, -1234n, '¥5', '-¥12.34'],
  ['由负数调增为正数（正数不带 +，末尾 0 去掉）', -150n, 600n, '-¥1.5', '¥6'],
  ['调到 0（App 表「¥0」，不是后台「¥0.00」）', -120n, 0n, '-¥1.2', '¥0'],
  ['由 0 调增（不加千分位）', 0n, 2_000_000n, '¥0', '¥20000'],
  ['大额调减到负数（不加千分位）', 123_456_789n, -2_000_000n, '¥1234567.89', '-¥20000'],
  ['负数之间调减', -1n, -100n, '-¥0.01', '-¥1'],
];

// B2-02za (D10-2132 / D10-2146; couli#8): the default body says 「可提现余额」 (BR-TEXT-01 user
// term). From B2-02za on the expectations of the default body use this template; TEMPLATE and
// bodyOf above keep the old wording and are no longer used for the default body (FU: remove them
// once the gate lets a support file drop a constant with the owner's label).
export const TEMPLATE_WITHDRAWABLE =
  '核对账目时发现你的余额显示与流水明细不一致，已按流水明细更正：可提现余额由 {before} 调整为 {after}。如有疑问，请联系客服。';
