// B2-02z: the in-app message BALANCE_CORRECTED of a balance recalculation that corrected the
// member's available balance (D10-2092 ⑤, D10-2093; contracts/openapi.yaml recalcBalanceAdminReconDiff
// 「Member notice」): inbox only, category service, sent for an increase and a decrease alike, none
// when the available balance is unchanged. Default title inbox.title.BALANCE_CORRECTED「余额更正」
// (contracts/texts.default.json); default body 「核对账目时发现你的余额显示与流水明细不一致，已按流水明细
// 更正：可用余额由 {before} 调整为 {after}。如有疑问，请联系客服。」, {before} / {after} per BR-TEXT-10
// (App format: '-' before '¥' for a negative balance, no '+' for a positive one, no thousands
// separator). Operators may reword the title and body (notify_templates override); the variables are
// replaced the same way.
//
// Pure renderer: erasable syntax only, no database, no platform import (the writer that records it
// is ./balance-corrected-message-record.ts).
import { formatYuan } from '@couli/money';

/** The available balance read under the lock and the one written, integer fen (may be negative). */
export interface BalanceCorrectedFacts {
  readonly before_fen: bigint;
  readonly after_fen: bigint;
}

/** notify_templates title_override / body_override of the app, code and variant. */
export interface BalanceCorrectedOverride {
  readonly title_override: string | null;
  readonly body_override: string | null;
}

export interface BalanceCorrectedMessage {
  readonly code: 'BALANCE_CORRECTED';
  readonly variant: 'default';
  readonly category: 'service';
  readonly title: string;
  readonly body: string;
}

export const BALANCE_CORRECTED_CODE = 'BALANCE_CORRECTED';

/** inbox.title.BALANCE_CORRECTED (contracts/texts.default.json, D10-2093). */
const DEFAULT_TITLE = '余额更正';
/** D10-2092 default body, verbatim. */
const DEFAULT_BODY =
  '核对账目时发现你的余额显示与流水明细不一致，已按流水明细更正：可用余额由 {before} 调整为 {after}。如有疑问，请联系客服。';

/** null when the available balance is unchanged (nothing is sent). */
export function renderBalanceCorrectedMessage(
  facts: BalanceCorrectedFacts,
  override: BalanceCorrectedOverride | null,
): BalanceCorrectedMessage | null {
  if (facts.before_fen === facts.after_fen) return null;
  const title = override?.title_override ?? DEFAULT_TITLE;
  const template = override?.body_override ?? DEFAULT_BODY;
  // BR-TEXT-10 App format, unsigned option: '-' before '¥' for a negative balance, no '+'.
  const before = formatYuan(facts.before_fen);
  const after = formatYuan(facts.after_fen);
  // Function replacers: the substituted text is taken literally (no `$` patterns).
  const body = template.replaceAll('{before}', () => before).replaceAll('{after}', () => after);
  return { code: BALANCE_CORRECTED_CODE, variant: 'default', category: 'service', title, body };
}
