// B2-12c: the in-app message BALANCE_ADJUSTED of a manual balance adjustment (08 BR-FUND-24 ⑦,
// BR-TEXT-19 站内信 BALANCE_ADJUSTED: only on a decrease, inbox only, category service; 「你的余额调减
// {amount}，原因：{adjust_reason}。如有疑问，请联系客服。」, {amount} per BR-TEXT-10 with ¥, {adjust_reason}
// the reason code's name of BR-TEXT-19; never the internal note, the operator or a document
// number). null for a form that sends nothing. Operators may reword the title and body
// (notify_templates override); the variables are replaced the same way.
//
// Pure renderer: erasable syntax only, no database, no platform import (the writer that records it
// is ./balance-adjusted-message-record.ts).
import { formatYuan } from '@couli/money';

export type BalanceAdjustedDirection = 'increase' | 'decrease';

/** The executed form as the adjustment flow hands it over. */
export interface BalanceAdjustedFacts {
  readonly direction: BalanceAdjustedDirection;
  /** The form's amount, integer fen above 0. */
  readonly amount_fen: bigint;
  /** The form's reason code (the ADMIN_ADJUST sub_type). */
  readonly reason_code: string;
}

/** notify_templates title_override / body_override of the app, code and variant. */
export interface BalanceAdjustedOverride {
  readonly title_override: string | null;
  readonly body_override: string | null;
}

export interface BalanceAdjustedMessage {
  readonly code: 'BALANCE_ADJUSTED';
  readonly variant: 'default';
  readonly category: 'service';
  readonly title: string;
  readonly body: string;
}

export const BALANCE_ADJUSTED_CODE = 'BALANCE_ADJUSTED';

/** inbox.title.BALANCE_ADJUSTED (contracts/texts.default.json). */
const DEFAULT_TITLE = '余额调整';
/** BR-TEXT-19 站内信模板, verbatim. */
const DEFAULT_BODY = '你的余额调减 {amount}，原因：{adjust_reason}。如有疑问，请联系客服。';

/** BR-TEXT-19「ADMIN_ADJUST 原因码文案」名称列 ({adjust_reason}). */
const REASON_NAMES: Readonly<Record<string, string>> = Object.freeze({
  RESTORE: '订单恢复补发',
  RECON_FIX: '结算核对更正',
  PAYOUT_RECOVERY: '重复到账追回',
  ACCOUNT_CLOSED: '注销放弃余额',
  OTHER: '人工调账',
});

/** A reason code outside the dictionary reads as OTHER's name (never the code itself). */
function reasonName(code: string): string {
  return Object.hasOwn(REASON_NAMES, code) ? (REASON_NAMES[code] as string) : '人工调账';
}

export function renderBalanceAdjustedMessage(
  facts: BalanceAdjustedFacts,
  override: BalanceAdjustedOverride | null,
): BalanceAdjustedMessage | null {
  if (facts.direction !== 'decrease') return null;
  const title = override?.title_override ?? DEFAULT_TITLE;
  const template = override?.body_override ?? DEFAULT_BODY;
  // Function replacers: the substituted text is taken literally (no `$` patterns).
  const magnitude = facts.amount_fen < 0n ? -facts.amount_fen : facts.amount_fen;
  const body = template
    .replaceAll('{amount}', () => formatYuan(magnitude))
    .replaceAll('{adjust_reason}', () => reasonName(facts.reason_code));
  return { code: BALANCE_ADJUSTED_CODE, variant: 'default', category: 'service', title, body };
}
