// 「自动到账设置」页签（F1-08ap，BR-WDR-30 细则「后台配置页」；规格 admin-withdrawals.md）的纯函数骨架。
// 规则测试阶段只放 NotImplemented 骨架，实现阶段补全：
// - 持 config.business（超管持有全部点）才出第四个页签；进入页签时才读 GET /admin/v1/config-items
//   （取 withdraw.auto_payout.*，逐页读完、page_size ≤ 200）与 GET /admin/v1/kill-switches（持 switch.* 任一时，
//   只读 withdraw.auto_payout.enabled 的状态）。
// - 草稿：金额以元显示、以分提交，换算只经 @couli/money；value 为 null 的键显示未设置、输入框为空。
// - 保存前校验：window_end > window_start；金额 0–10000 元、至多两位小数；次数为 ≥ 0 的整数；
//   risk_block_flags 只取 BR-WDR-29 标签 code（blacklist_hit 固定检查、不可移除）。
// - 保存：一次 POST /admin/v1/config-items/batch，只含改过的键 {key, value, expected_version}。
import type { AccessControl } from '../../providers/access-control/index.ts';

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

/** The checked draft: the changed entries, or the message of each wrong key. */
export type AutoPayoutCheck =
  | { readonly entries: readonly AutoPayoutEntry[] }
  | { readonly errors: Readonly<Partial<Record<AutoPayoutKey, string>>> };

/** The master switch as the tab shows it: on / off, or not readable without a switch point. */
export type AutoPayoutMaster = 'on' | 'off' | 'forbidden';

/** Whether the account sees the 「自动到账设置」 tab (config.business). */
export function canSeeAutoPayout(access: AccessControl): boolean {
  void access;
  throw new Error('NotImplemented: canSeeAutoPayout');
}

/** Whether the account may read the master switch (switch.all / switch.payout / switch.pay). */
export function canReadMaster(access: AccessControl): boolean {
  void access;
  throw new Error('NotImplemented: canReadMaster');
}

/** The tab's items of a config-items answer, in registry order (other keys dropped). */
export function autoPayoutItems(items: readonly AutoPayoutItem[]): AutoPayoutItem[] {
  void items;
  throw new Error('NotImplemented: autoPayoutItems');
}

/** The form's starting draft of `items` (a null value: an empty field, never a default). */
export function draftOf(items: readonly AutoPayoutItem[]): AutoPayoutDraft {
  void items;
  throw new Error('NotImplemented: draftOf');
}

/** Checks `draft` against `items` (BR-WDR-30 save checks) and lists the changed entries. */
export function checkDraft(
  items: readonly AutoPayoutItem[],
  draft: AutoPayoutDraft,
): AutoPayoutCheck {
  void items;
  void draft;
  throw new Error('NotImplemented: checkDraft');
}

/** The master switch state from a kill-switches answer (value null: its default). */
export function masterOf(switches: readonly unknown[]): AutoPayoutMaster {
  void switches;
  throw new Error('NotImplemented: masterOf');
}
