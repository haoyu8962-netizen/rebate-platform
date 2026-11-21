// 「自动到账设置」页签（F1-08ap，BR-WDR-30 细则「后台配置页」；规格 admin-withdrawals.md）的纯函数：
// - 持 config.business（超管持有全部点）才出第四个页签；进入页签时才读 GET /admin/v1/config-items
//   （取 withdraw.auto_payout.*，逐页读完、page_size ≤ 200）与 GET /admin/v1/kill-switches（持 switch.* 任一时，
//   只读 withdraw.auto_payout.enabled 的状态）。
// - 草稿：金额以元显示、以分提交，换算只经 @couli/money；⑧ 预警以百分比显示与输入、以整数 bp 提交；
//   value 为 null 的键显示未设置、输入框为空，前端不写默认数值。
// - 保存前校验：window_end > window_start；金额 0–10000 元、至多两位小数；次数为 ≥ 0 的整数；预警 0–100%、
//   至多两位小数；risk_block_flags 只取 BR-WDR-29 标签 code（blacklist_hit 固定检查、不可移除）。
//   两条跨键上限（max_amount_fen ≤ withdraw.max_amount_fen、platform_daily_max_fen ≤ payout.daily_cap_fen）
//   由服务端校验（D10-2416），前端不做。
// - 保存：一次 POST /admin/v1/config-items/batch，只含改过的键 {key, value, expected_version}。
import { fenToJsonNumber, formatFen, parseFen, pctStrToBp, yuanStrToFen } from '@couli/money';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { RISK_FLAGS } from './model.ts';

/** A setting key of the tab (withdraw.auto_payout.* without the master switch). */
export type AutoPayoutKey =
  | 'withdraw.auto_payout.max_amount_fen'
  | 'withdraw.auto_payout.window_start'
  | 'withdraw.auto_payout.window_end'
  | 'withdraw.auto_payout.window_limit_enabled'
  | 'withdraw.auto_payout.first_withdrawal_limit_enabled'
  | 'withdraw.auto_payout.frozen_balance_policy'
  | 'withdraw.auto_payout.same_day_policy'
  | 'withdraw.auto_payout.payee_daily_max_count'
  | 'withdraw.auto_payout.payee_monthly_max_count'
  | 'withdraw.auto_payout.user_daily_max_count'
  | 'withdraw.auto_payout.user_monthly_max_count'
  | 'withdraw.auto_payout.warn.high_commission_rate_bp'
  | 'withdraw.auto_payout.warn.high_commission_order_ratio_bp'
  | 'withdraw.auto_payout.warn.invalid_ratio_bp'
  | 'withdraw.auto_payout.warn.withdraw_received_ratio_bp'
  | 'withdraw.auto_payout.platform_daily_max_fen'
  | 'withdraw.auto_payout.risk_block_flags';

/** One config item as adminListConfigItems answers it (only the members the tab uses). */
export interface AutoPayoutItem {
  readonly key: string;
  /** null = never written; the server's built-in default applies (shown as unset). */
  readonly value: unknown;
  readonly value_type: 'boolean' | 'enum' | 'object' | 'number' | 'string';
  readonly options: readonly string[] | null;
  readonly admin_editable: boolean;
  readonly version: number;
}

/** What the form holds per key: typed text (amounts in yuan, counts, percentages), a flag or codes. */
export type AutoPayoutField = string | boolean | readonly string[];
export type AutoPayoutDraft = Readonly<Partial<Record<AutoPayoutKey, AutoPayoutField>>>;

/** One entry of AdminConfigItemBatchRequest.items. */
export interface AutoPayoutEntry {
  readonly key: AutoPayoutKey;
  readonly value: unknown;
  readonly expected_version: number;
}

/** Why a field was refused before sending (the page maps it to its text). */
export type AutoPayoutError =
  'amount' | 'platformAmount' | 'count' | 'percent' | 'required' | 'window' | 'option';

/** The checked draft: the changed entries, or the message of each wrong key. */
export type AutoPayoutCheck =
  | { readonly entries: readonly AutoPayoutEntry[] }
  | { readonly errors: Readonly<Partial<Record<AutoPayoutKey, AutoPayoutError>>> };

/** The master switch as the tab shows it: on / off, or not readable without a switch point. */
export type AutoPayoutMaster = 'on' | 'off' | 'forbidden';

export const CONFIG_ITEMS_URL = '/admin/v1/config-items';
export const CONFIG_BATCH_URL = '/admin/v1/config-items/batch';
/** The largest page_size of adminListConfigItems. */
export const CONFIG_PAGE_SIZE = 200;
/** The permission point of the tab and of its batch (totp step-up). */
export const AUTO_PAYOUT_PERMISSION = 'config.business';
/** Any of these reads adminListKillSwitches (the master switch's state). */
export const MASTER_READ_PERMISSIONS: readonly string[] = [
  'switch.all',
  'switch.payout',
  'switch.pay',
];
/** The master switch (a kill switch, read only on this tab). */
export const MASTER_KEY = 'withdraw.auto_payout.enabled';
/** The route of the emergency switch page (menu `switches`). */
export const SWITCHES_ROUTE = '/switches';

const P = 'withdraw.auto_payout.';
export const AUTO_KEY = {
  maxAmount: `${P}max_amount_fen`,
  windowStart: `${P}window_start`,
  windowEnd: `${P}window_end`,
  windowLimit: `${P}window_limit_enabled`,
  firstLimit: `${P}first_withdrawal_limit_enabled`,
  frozen: `${P}frozen_balance_policy`,
  sameDay: `${P}same_day_policy`,
  payeeDaily: `${P}payee_daily_max_count`,
  payeeMonthly: `${P}payee_monthly_max_count`,
  userDaily: `${P}user_daily_max_count`,
  userMonthly: `${P}user_monthly_max_count`,
  warnRate: `${P}warn.high_commission_rate_bp`,
  warnOrders: `${P}warn.high_commission_order_ratio_bp`,
  warnInvalid: `${P}warn.invalid_ratio_bp`,
  warnReceived: `${P}warn.withdraw_received_ratio_bp`,
  platformDaily: `${P}platform_daily_max_fen`,
  riskFlags: `${P}risk_block_flags`,
} as const satisfies Record<string, AutoPayoutKey>;

/** Every key of the tab, in BR-WDR-30 order (①–⑧, then ⑨ ⑫). */
export const AUTO_PAYOUT_KEYS: readonly AutoPayoutKey[] = Object.values(AUTO_KEY);

type Kind = 'yuan' | 'count' | 'percent' | 'flag' | 'time' | 'fixed' | 'flags';
const KIND: Readonly<Record<AutoPayoutKey, Kind>> = {
  [AUTO_KEY.maxAmount]: 'yuan',
  [AUTO_KEY.windowStart]: 'time',
  [AUTO_KEY.windowEnd]: 'time',
  [AUTO_KEY.windowLimit]: 'flag',
  [AUTO_KEY.firstLimit]: 'flag',
  [AUTO_KEY.frozen]: 'fixed',
  [AUTO_KEY.sameDay]: 'fixed',
  [AUTO_KEY.payeeDaily]: 'count',
  [AUTO_KEY.payeeMonthly]: 'count',
  [AUTO_KEY.userDaily]: 'count',
  [AUTO_KEY.userMonthly]: 'count',
  [AUTO_KEY.warnRate]: 'percent',
  [AUTO_KEY.warnOrders]: 'percent',
  [AUTO_KEY.warnInvalid]: 'percent',
  [AUTO_KEY.warnReceived]: 'percent',
  [AUTO_KEY.platformDaily]: 'yuan',
  [AUTO_KEY.riskFlags]: 'flags',
};

/** BR-WDR-30 ② max_amount_fen: 0–1000000 fen (0–10000 yuan). */
const MAX_AMOUNT_FEN = 1_000_000n;
/** The registry's integer range of the other number keys (int4). */
const INT_MAX = 2_147_483_647n;
/** blacklist_hit is checked on every decision and cannot be removed (BR-WDR-30 ⑫). */
export const FIXED_FLAG = 'blacklist_hit';
/** The BR-WDR-29 labels a save may choose, in the order of the list filter (one shared mapping). */
export const OPTIONAL_FLAGS: readonly string[] = RISK_FLAGS.filter((code) => code !== FIXED_FLAG);
/** The whole hours window_start / window_end offer when the registry gives no options (09–22). */
const HOURS = Array.from({ length: 14 }, (_, index) => String(9 + index).padStart(2, '0'));
export const DEFAULT_STARTS: readonly string[] = HOURS.map((hour) => `${hour}:00:00`);
export const DEFAULT_ENDS: readonly string[] = HOURS.map((hour) => `${hour}:59:59`);

const YUAN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/;
const COUNT = /^[0-9]+$/;
const PERCENT = /^[0-9]+(?:\.[0-9]{1,2})?$/;

export function isAutoPayoutKey(key: string): key is AutoPayoutKey {
  return (AUTO_PAYOUT_KEYS as readonly string[]).includes(key);
}

/** Whether the account sees the 「自动到账设置」 tab (config.business). */
export function canSeeAutoPayout(access: AccessControl): boolean {
  return access.can(AUTO_PAYOUT_PERMISSION);
}

/** Whether the account may read the master switch (switch.all / switch.payout / switch.pay). */
export function canReadMaster(access: AccessControl): boolean {
  return MASTER_READ_PERMISSIONS.some((point) => access.can(point));
}

/** The tab's items of a config-items answer, in registry order (other keys dropped). */
export function autoPayoutItems(items: readonly AutoPayoutItem[]): AutoPayoutItem[] {
  return items.filter((item) => isAutoPayoutKey(item.key));
}

/** Integer fen of a stored amount, as the yuan text of an input (e.g. 25050 → "250.50"). */
export function yuanTextOf(fen: unknown): string {
  try {
    return formatFen(parseFen(fen));
  } catch {
    return '';
  }
}

/** A stored ratio in bp as the percentage text of an input (integer arithmetic: 1234 → "12.34"). */
export function percentTextOf(bp: unknown): string {
  if (typeof bp !== 'number' || !Number.isSafeInteger(bp) || bp < 0) return '';
  return `${Math.trunc(bp / 100)}.${String(bp % 100).padStart(2, '0')}`;
}

function countTextOf(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
}

/** The stored risk_block_flags codes (anything else read as none). */
export function storedFlags(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((code): code is string => typeof code === 'string')
    : [];
}

/** The draft field of one stored item; undefined for a value never written (null) or unreadable. */
function fieldOf(key: AutoPayoutKey, value: unknown): AutoPayoutField | undefined {
  if (value === null || value === undefined) return undefined;
  switch (KIND[key]) {
    case 'yuan':
      return yuanTextOf(value);
    case 'count':
      return countTextOf(value);
    case 'percent':
      return percentTextOf(value);
    case 'flag':
      return typeof value === 'boolean' ? value : undefined;
    case 'time':
      return typeof value === 'string' ? value : undefined;
    case 'flags':
      return storedFlags(value).filter((code) => OPTIONAL_FLAGS.includes(code));
    case 'fixed':
      return undefined;
  }
}

/** The form's starting draft of `items` (a null value: an empty field, never a default). */
export function draftOf(items: readonly AutoPayoutItem[]): AutoPayoutDraft {
  const draft: Partial<Record<AutoPayoutKey, AutoPayoutField>> = {};
  for (const item of items) {
    if (!isAutoPayoutKey(item.key)) continue;
    const field = fieldOf(item.key, item.value);
    if (field !== undefined) draft[item.key] = field;
  }
  return draft;
}

type Parsed =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: AutoPayoutError };

/** The value of a typed text, or why it is refused. */
function parseText(key: AutoPayoutKey, text: string): Parsed {
  const typed = text.trim();
  const kind = KIND[key];
  if (kind === 'yuan') {
    const error: AutoPayoutError = key === AUTO_KEY.maxAmount ? 'amount' : 'platformAmount';
    if (!YUAN.test(typed)) return { ok: false, error };
    let fen: bigint;
    try {
      fen = yuanStrToFen(typed);
    } catch {
      return { ok: false, error };
    }
    const max = key === AUTO_KEY.maxAmount ? MAX_AMOUNT_FEN : INT_MAX;
    if (fen < 0n || fen > max) return { ok: false, error };
    return { ok: true, value: fenToJsonNumber(fen) };
  }
  if (kind === 'count') {
    if (!COUNT.test(typed) || BigInt(typed) > INT_MAX) return { ok: false, error: 'count' };
    return { ok: true, value: Number(typed) };
  }
  // percent: 0–100 with at most two decimals, as integer bp (0–10000).
  if (!PERCENT.test(typed)) return { ok: false, error: 'percent' };
  try {
    const bp = pctStrToBp(typed);
    if (bp < 0n || bp > 10_000n) return { ok: false, error: 'percent' };
    return { ok: true, value: Number(bp) };
  } catch {
    return { ok: false, error: 'percent' };
  }
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((code) => b.includes(code));

/** Checks `draft` against `items` (BR-WDR-30 save checks) and lists the changed entries. */
export function checkDraft(
  items: readonly AutoPayoutItem[],
  draft: AutoPayoutDraft,
): AutoPayoutCheck {
  const errors: Partial<Record<AutoPayoutKey, AutoPayoutError>> = {};
  const entries: AutoPayoutEntry[] = [];
  const byKey = new Map<AutoPayoutKey, AutoPayoutItem>();
  for (const item of items) if (isAutoPayoutKey(item.key)) byKey.set(item.key, item);

  for (const key of AUTO_PAYOUT_KEYS) {
    const item = byKey.get(key);
    const field = draft[key];
    const kind = KIND[key];
    if (item === undefined || !item.admin_editable || kind === 'fixed' || field === undefined)
      continue;
    const stored = item.value;
    const entry = (value: unknown) => entries.push({ key, value, expected_version: item.version });

    if (kind === 'flag') {
      if (typeof field === 'boolean' && field !== stored) entry(field);
      continue;
    }
    if (kind === 'time') {
      if (typeof field !== 'string' || field === stored) continue;
      const options =
        item.options ?? (key === AUTO_KEY.windowStart ? DEFAULT_STARTS : DEFAULT_ENDS);
      if (!options.includes(field)) errors[key] = 'option';
      else entry(field);
      continue;
    }
    if (kind === 'flags') {
      if (!Array.isArray(field)) continue;
      const chosen = OPTIONAL_FLAGS.filter((code) => (field as readonly string[]).includes(code));
      const before = storedFlags(stored);
      const beforeOptional = before.filter((code) => OPTIONAL_FLAGS.includes(code));
      if (stored !== null && sameSet(chosen, beforeOptional)) continue;
      if (stored === null && chosen.length === 0) continue;
      // Codes of the stored set this page does not offer (blacklist_hit) stay as they were.
      const kept = before.filter((code) => !OPTIONAL_FLAGS.includes(code));
      entry([...chosen, ...kept]);
      continue;
    }
    if (typeof field !== 'string') continue;
    if (field.trim() === '') {
      // An unset key left empty is unchanged; clearing a stored value is not a value.
      if (stored !== null) errors[key] = 'required';
      continue;
    }
    const parsed = parseText(key, field);
    if (!parsed.ok) {
      errors[key] = parsed.error;
      continue;
    }
    if (parsed.value !== stored) entry(parsed.value);
  }

  // ③ window_end > window_start, on the values the save would leave (typed or stored).
  const timeOf = (key: AutoPayoutKey): string | undefined => {
    const field = draft[key];
    if (typeof field === 'string' && field !== '') return field;
    const stored = byKey.get(key)?.value;
    return typeof stored === 'string' ? stored : undefined;
  };
  const start = timeOf(AUTO_KEY.windowStart);
  const end = timeOf(AUTO_KEY.windowEnd);
  if (start !== undefined && end !== undefined && !(end > start)) {
    errors[AUTO_KEY.windowStart] ??= 'window';
    errors[AUTO_KEY.windowEnd] ??= 'window';
  }

  if (Object.keys(errors).length > 0) return { errors };
  return { entries };
}

/** The master switch state from a kill-switches answer (value null: its default). */
export function masterOf(switches: readonly unknown[]): AutoPayoutMaster {
  for (const row of switches) {
    if (typeof row !== 'object' || row === null) continue;
    const item = row as { key?: unknown; value?: unknown; default?: unknown };
    if (item.key !== MASTER_KEY) continue;
    const value = item.value === null || item.value === undefined ? item.default : item.value;
    return value === true ? 'on' : 'off';
  }
  return 'off';
}
