// Task F1-10e: registry of the configuration items the admin console lists and changes
// (规划/04 §10, §11.2; orchestrator ruling 14), as pure data plus lookups. Disjoint from the
// emergency switch registry (./switch-registry.ts): a switch key is never a configuration item.
// Every key is literal (no patterns); lookups never infer an item from a prefix.
// F1-02zzj: a dedicated-port key (./dedicated-config-keys.ts) is never an item, even if listed.

import { isDedicatedConfigKey } from './dedicated-config-keys.ts';

/** Admin permission points that guard changing a configuration item (规划/04 §11.2). */
export type ConfigPermission = 'config.general' | 'config.risk' | 'config.business';

/** The contract's AdminConfigValueType. */
export type ConfigValueType = 'boolean' | 'enum' | 'object' | 'number' | 'string';

/** One registered configuration item. */
export interface ConfigItemSpec {
  readonly key: string;
  readonly valueType: ConfigValueType;
  /** Allowed values when valueType is enum; null for every other type. */
  readonly options: readonly string[] | null;
  /** The one point that guards changing it, and so its step-up tier. */
  readonly permission: ConfigPermission;
  /** false: listed read only, a change is 20001 [key]. */
  readonly adminEditable: boolean;
  /**
   * Inclusive integer bounds for a number item (F1-02zj, BR-FUND-04). Absent on every item
   * that predates it, whose number check stays "any finite number".
   */
  readonly range?: ConfigNumberRange;
}

/** Inclusive bounds; `integer` requires Number.isInteger. */
export interface ConfigNumberRange {
  readonly integer: true;
  readonly min: number;
  readonly max: number;
}

function spec(
  key: string,
  valueType: ConfigValueType,
  permission: ConfigPermission,
  adminEditable = true,
): ConfigItemSpec {
  return Object.freeze({ key, valueType, options: null, permission, adminEditable });
}

/** Upper bound where 08 gives none (orchestrator ruling D-S2): int4 max, not a business cap. */
const INT4_MAX = 2147483647;

/** F1-02zj: an editable config.business integer item with inclusive bounds. */
function businessInteger(key: string, min: number, max = INT4_MAX): ConfigItemSpec {
  return Object.freeze({
    key,
    valueType: 'number' as const,
    options: null,
    permission: 'config.business' as const,
    adminEditable: true,
    range: Object.freeze({ integer: true as const, min, max }),
  });
}

/** F1-02zn: an editable config.risk integer item with inclusive bounds. */
function riskInteger(key: string, min: number, max = INT4_MAX): ConfigItemSpec {
  return Object.freeze({
    key,
    valueType: 'number' as const,
    options: null,
    permission: 'config.risk' as const,
    adminEditable: true,
    range: Object.freeze({ integer: true as const, min, max }),
  });
}

/** F1-02zj: a config.business enum item (B2-11y: read only when adminEditable is false). */
function businessEnum(
  key: string,
  options: readonly string[],
  adminEditable = true,
): ConfigItemSpec {
  return Object.freeze({
    key,
    valueType: 'enum' as const,
    options: Object.freeze([...options]),
    permission: 'config.business' as const,
    adminEditable,
  });
}

/** Platform codes of contracts/enums/platform.yaml, expanded into literal keys. */
const SETTLE_PLATFORMS = ['taobao', 'jd', 'pdd', 'meituan'] as const;

function perPlatform(prefix: string, make: (key: string) => ConfigItemSpec): ConfigItemSpec[] {
  return SETTLE_PLATFORMS.map((platform) => make(`${prefix}.${platform}`));
}

/** BR-WDR-30 ③: the whole hours 09 to 22 followed by `suffix` (window_start / window_end). */
function autoPayoutHours(suffix: string): string[] {
  return Array.from({ length: 14 }, (_, i) => `${String(9 + i).padStart(2, '0')}${suffix}`);
}

// F1-10e ruling 14: explicit entries, including the read-only money-rule flags.
const REGISTRY: readonly ConfigItemSpec[] = Object.freeze([
  spec('withdraw.payout_account_verify_per_day', 'number', 'config.business'),
  spec('withdraw.payout_account_verify_inflight_timeout_sec', 'number', 'config.business'),
  spec('withdraw.payout_account_verify_recheck_minutes', 'number', 'config.business'),
  spec('withdraw.payout_account_verify_reuse_hours', 'number', 'config.business'),
  spec('rebate.pdd.compare_precheck.enabled', 'boolean', 'config.business'),
  spec('settle.estimate_change_diff.enabled', 'boolean', 'config.business', false),
  spec('settle.adjust.void_on_clawback.enabled', 'boolean', 'config.business', false),
  spec('order_sync.regression_hold.enabled', 'boolean', 'config.business', false),
  spec('order_sync.unmapped_status_hold.enabled', 'boolean', 'config.business', false),
  spec('ledger.bad_debt_require_no_frozen.enabled', 'boolean', 'config.business', false),
  spec('payout.proven_success_writeoff.enabled', 'boolean', 'config.business', false),
  spec('risk.merge_tombstone_dedupe', 'boolean', 'config.risk'),
  spec('auth.oauth_attempt_ttl_sec', 'number', 'config.risk'),
  spec('push.token_conflict_window_hours', 'number', 'config.risk'),
  spec('attr.track_complete_tolerance_sec', 'number', 'config.risk'),
  spec('external_page.union_host_block', 'boolean', 'config.risk'),
  spec('union.taobao.auth_methods.ios', 'object', 'config.general'),
  spec('union.taobao.auth_methods.android', 'object', 'config.general'),
  spec('union.taobao.auth_methods.harmony', 'object', 'config.general'),
  spec('external_page.nav_host_sample_bp', 'number', 'config.general'),
  spec('share.open_in_app.enabled', 'boolean', 'config.general'),
  spec('invite.bind_phone_guide', 'boolean', 'config.general'),
  spec('invite.before_buy_tip', 'boolean', 'config.general'),
  spec('earnings.dashboard.enabled', 'boolean', 'config.general'),
  spec('earnings.dashboard.referral_visible', 'boolean', 'config.general'),
  spec('order.user_query_months', 'number', 'config.general'),
  spec('app_update.recheck_interval_sec', 'number', 'config.general'),
  spec('agent.page_guide.routes', 'object', 'config.general', false),
  spec('external_hosts', 'object', 'config.general', false),
  // F1-02zj: BR-FUND-04 细则 settlement process parameters (08 06_FUND at SPEC_REF 5ecafb3),
  // appended after the F1-10e items in the ruled order; per-platform keys are literal.
  businessInteger('settle.bill_day', 22, 28),
  ...perPlatform('settle.period_basis', (key) => businessEnum(key, ['received_at'])),
  ...perPlatform('settle.statement_source', (key) => businessEnum(key, ['api', 'upload'])),
  businessInteger('settle.batch.match_tolerance_fen', 0),
  businessInteger('settle.batch.max_orders', 1),
  ...perPlatform('settle.period_offset_months', (key) => businessInteger(key, 0)),
  businessInteger('settle.statement.grace_days', 0),
  // F1-02zn: BR-INV-24 细则 invite reward campaign (08 11_INV at SPEC_REF 5ecafb3; ruling
  // D10-94 ⑥), appended after SETTLE in the ruled order. Amounts are integer fen; the IP
  // window is in hours and at least 1 (0 would compare nothing).
  businessInteger('growth.invite_reward.amount_fen', 0),
  businessInteger('growth.invite_reward.daily_budget_fen', 0),
  businessInteger('growth.invite_reward.total_budget_fen', 0),
  businessInteger('growth.invite_reward.min_paid_fen', 0),
  riskInteger('growth.invite_reward.ip_window_hours', 1),
  // F1-02zx: BR-INV-24 细则 eligibility period in whole days (08 11_INV l.560 / l.571 at
  // SPEC_REF ac4d993), the group's (and registry's) last item. Minimum 1 (0 would never
  // trigger); maximum 3650 is a technical cap (ruling D-E1: claimed-at plus days must not
  // overflow a timestamp), not a business value. config.business like the amounts (D-E2).
  // Not one of INVITE_REWARD_POSITIVE_KEYS: the enable check does not read it.
  businessInteger('growth.invite_reward.eligibility_days', 1, 3650),
  // B2-06b payout channel keys (规划/08 BR-WDR-18 / 22 / 28; the conservative defaults live in
  // payout's reader, readPayoutChannelConfig): caps as integer fen / bp, the business scene, the
  // query schedule and the three BR-WDR-28 lists (empty until the sandbox run, D10-230).
  businessInteger('payout.single_cap_fen', 1),
  businessInteger('payout.daily_cap_fen', 1),
  businessInteger('payout.watermark_usable_bp', 0, 10000),
  spec('payout.biz_scene', 'string', 'config.business'),
  spec('payout.query_schedule', 'object', 'config.business'),
  spec('payout.definite_fail_codes', 'object', 'config.business'),
  spec('payout.payer_side_codes', 'object', 'config.business'),
  spec('payout.query_status_map', 'object', 'config.business'),
  // B2-11z (D10-368): BR-WDR-29 audit risk-flag thresholds read by payout's snapshot (B2-11a),
  // after payout.*: ratios in bp, counts in orders; only non-negative integers, no business cap.
  riskInteger('risk.withdraw.invalid_ratio_bp', 0),
  riskInteger('risk.withdraw.invalid_min_count', 0),
  riskInteger('risk.withdraw.high_commission_rate_bp', 0),
  riskInteger('risk.withdraw.high_commission_ratio_bp', 0),
  riskInteger('risk.withdraw.min_orders', 0),
  riskInteger('risk.withdraw.withdraw_received_ratio_bp', 0),
  // B2-11y (D10-373): BR-WDR-30 细则 auto-payout rule group (08 07_WDR at SPEC_REF 736d24c),
  // after risk.withdraw.*, all config.business; withdraw.auto_payout.enabled stays a switch
  // (./switch-registry.ts). Ranges as 08 gives them, int4 max where 08 gives no upper bound.
  // Cross-key save checks of 08 are not expressible here (each item is checked alone):
  // max_amount_fen <= withdraw.max_amount_fen, window_end > window_start,
  // platform_daily_max_fen <= payout.daily_cap_fen, and risk_block_flags only holding
  // BR-WDR-29 label codes (an object item only checks for a JSON array / object).
  businessInteger('withdraw.auto_payout.max_amount_fen', 0, 1000000),
  businessEnum('withdraw.auto_payout.window_start', autoPayoutHours(':00:00')),
  businessEnum('withdraw.auto_payout.window_end', autoPayoutHours(':59:59')),
  spec('withdraw.auto_payout.window_limit_enabled', 'boolean', 'config.business'),
  spec('withdraw.auto_payout.first_withdrawal_limit_enabled', 'boolean', 'config.business'),
  // 08: the console shows ⑤ and ⑥ read only (「不自动到账」).
  businessEnum('withdraw.auto_payout.frozen_balance_policy', ['no_auto'], false),
  businessEnum('withdraw.auto_payout.same_day_policy', ['no_auto'], false),
  businessInteger('withdraw.auto_payout.payee_daily_max_count', 0),
  businessInteger('withdraw.auto_payout.payee_monthly_max_count', 0),
  businessInteger('withdraw.auto_payout.user_daily_max_count', 0),
  businessInteger('withdraw.auto_payout.user_monthly_max_count', 0),
  businessInteger('withdraw.auto_payout.warn.high_commission_rate_bp', 0, 10000),
  businessInteger('withdraw.auto_payout.warn.high_commission_order_ratio_bp', 0, 10000),
  businessInteger('withdraw.auto_payout.warn.invalid_ratio_bp', 0, 10000),
  businessInteger('withdraw.auto_payout.warn.withdraw_received_ratio_bp', 0, 10000),
  businessInteger('withdraw.auto_payout.platform_daily_max_fen', 0),
  spec('withdraw.auto_payout.risk_block_flags', 'object', 'config.business'),
  // B2-11dz (D10-392 / D10-394): BR-WDR-30 细则「开启前置检查」 keys the owner fills when
  // enabling, after withdraw.auto_payout.*, all config.business: whether BR-WDR-22 ② ⑤ ⑧ are
  // judged supported in 规划/09 (seeded false), and the days of daily channel reconciliation
  // (BR-WDR-23) the owner requires, at least 1 and with no seed row (unset = not passed).
  // Registration only; nothing reads them yet.
  spec('payout.auto_enable_check.limits_supported', 'boolean', 'config.business'),
  spec('payout.auto_enable_check.status_codes_supported', 'boolean', 'config.business'),
  spec('payout.auto_enable_check.bill_out_biz_no_supported', 'boolean', 'config.business'),
  businessInteger('payout.auto_enable_check.recon_required_days', 1),
  // B1-28g (D10-419): the server-side cache lifetime of GET /v1/rank/hot in seconds (规划/04
  // §10.1 服务端业务配置键, seeded 600), config.business, at least 1. Registration only;
  // B1-28h reads it.
  businessInteger('rank.cache_ttl_seconds', 1),
  // B1-05l (D10-419 (a)): the search hot words and keyword direct routes, edited through the
  // general configuration center, config.business objects seeded as empty lists (empty = no hot
  // words, no direct route). Registration only; B1-05m checks their shape on save and reads them.
  spec('search.hot_words', 'object', 'config.business'),
  spec('search.keyword_routes', 'object', 'config.business'),
  // B1-15zd (D10-454, BR-ID-30 ⑥⑦⑮⑯⑱): the purge master switch (an ordinary item, not a 04 §10.2
  // kill switch) and each table's retention in whole days, config.risk. D10-458: each lower bound
  // equals the key's value in 08, so a key can only be lengthened; shortening needs 08 changed first.
  spec('retention.purge.enabled', 'boolean', 'config.risk'),
  riskInteger('retention.login_logs_days', 180),
  riskInteger('retention.device_registrations_days', 180),
  riskInteger('retention.sms_send_attempts_days', 190),
  riskInteger('retention.inbox_messages_days', 180),
  riskInteger('retention.notify_logs_days', 190),
  riskInteger('retention.union_raw_payloads_days', 180),
  // B2-08cz (D10-456 ④): BR-WDR-20 tax.SERVICE_FEE.* — the withholding method of commission income
  // (none until the rate table is in force, 拍板第二批 FUND-04; then flat_rate / cumulative), the
  // flat rate in bp and the progressive rate table (shape checked on save by B2-08c), all
  // config.business. Registration only; B2-08c computes tax_fen from them.
  businessEnum('tax.SERVICE_FEE.method', ['none', 'flat_rate', 'cumulative']),
  businessInteger('tax.SERVICE_FEE.rate_bp', 0, 10000),
  spec('tax.SERVICE_FEE.rate_table', 'object', 'config.business'),
  // B1-05s (D10-480): the pool the feed falls back to when the union fails (规划/02 §14), unset by
  // default (no seed row; unset = the empty list), then the BR-PRICE-11 pool price age limit and
  // refresh interval in seconds, at least 1, all config.business. Registration only.
  spec('feed.fallback_pool_id', 'string', 'config.business'),
  businessInteger('pool.max_age_sec', 1),
  businessInteger('pool.refresh_interval_sec', 1),
  // B1-02zs (B1-02zp prerequisite): BR-WDR-01 细则 old-account re-verification — the days without
  // activity after which a withdrawal needs re-verification, a whole number of at least 0,
  // config.business like the other withdrawal items; seeded 0 = off until the three re-verification
  // pages ship (08 gives 180, set by the owner in the console then). Registration only.
  businessInteger('withdraw.dormant_reverify_days', 0),
  // B1-06ze (B1-06zd prerequisite, D10-510): the Taobao promotion link items — the share switch,
  // the prefetch switch and the prefetch cap per minute, a whole number of at least 1, all
  // config.business. No seed rows; unset = off, off and 60, the readers' defaults. Registration
  // only.
  spec('share.taobao_enabled', 'boolean', 'config.business'),
  spec('convert.taobao_prefetch.enabled', 'boolean', 'config.business'),
  businessInteger('convert.taobao_prefetch.rate_per_min', 1),
  // B1-04zq (B1-04zm prerequisite, D10-543): the order rescan items — the JD and PDD switches and
  // the JD and PDD rescan days, a whole number of at least 1, all config.business. No seed rows;
  // unset = JD on, PDD off, 30 and 90 days, the reader's defaults. Registration only.
  spec('order_sync.rescan.jd.enabled', 'boolean', 'config.business'),
  spec('order_sync.rescan.pdd.enabled', 'boolean', 'config.business'),
  businessInteger('order_sync.rescan.jd.days', 1),
  businessInteger('order_sync.rescan.pdd.days', 1),
  // B2-04zo (BR-FUND-20 细则): the advance alert threshold in fen, a whole number of at least 0,
  // config.business. Unset by default (no seed row; unset = the board shows but nothing alerts),
  // the super admin fills it in before launch; 0 is a valid threshold, not off. Registration only.
  businessInteger('ledger.advance_alert_fen', 0),
]);

const VISIBLE: readonly ConfigItemSpec[] = Object.freeze(
  REGISTRY.filter((entry) => !isDedicatedConfigKey(entry.key)),
);
const BY_KEY = new Map(VISIBLE.map((entry) => [entry.key, entry]));

/** Every registered configuration item, in registry (list) order. */
export function configRegistry(): readonly ConfigItemSpec[] {
  return VISIBLE;
}

/** The registered item `key` names, or null when it is not a configuration item. */
export function configItemSpecOf(key: string): ConfigItemSpec | null {
  if (isDedicatedConfigKey(key)) return null;
  return BY_KEY.get(key) ?? null;
}

/** Whether `value` is of the item's registered type (an enum value must be one of options). */
export function configValueFits(spec: ConfigItemSpec, value: unknown): boolean {
  switch (spec.valueType) {
    case 'enum':
      return typeof value === 'string' && (spec.options?.includes(value) ?? false);
    case 'object':
      return typeof value === 'object' && value !== null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && fitsRange(spec.range, value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
  }
}

function fitsRange(range: ConfigNumberRange | undefined, value: number): boolean {
  if (range === undefined) return true;
  return (!range.integer || Number.isInteger(value)) && value >= range.min && value <= range.max;
}
