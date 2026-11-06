// Helpers of the F1-10e rule tests: the admin configuration center (contracts/openapi.yaml
// adminListConfigItems, adminGetConfigItem, adminListConfigItemVersions, adminUpdateConfigItem,
// adminBatchUpdateConfigItems, adminRollbackConfigItem). Built on the frozen admin kits
// (test/spec/admin/auth, accounts), which are only imported here.
//
// Readings fixed by this kit (contract text and orchestrator rulings 7, 14～16):
// - the registry oracle below is ruling 14 verbatim: key, JSON value type of the seed, permission
//   point, admin_editable; options is null for every key (no enum among them);
// - F1-02zi: F1-02zj appends the BR-FUND-04 settle.* group (SETTLE below, 16 literal keys) to
//   the registry and the 0001 seed; EXPECTED itself stays ruling 14 verbatim;
// - F1-02zm / F1-02zz: F1-02zn appends the BR-INV-24 growth.invite_reward.* group (INVITE_CFG
//   below, 5 literal keys) after SETTLE, and F1-02zx appends INVITE_ELIG after it; expectedNow is
//   EXPECTED + SETTLE + INVITE_CFG + INVITE_ELIG. F1-02zt：过渡已收紧, every group must be present;
// - audit rows: action config_item_change / config_item_rollback, admin_id = the caller, at = the
//   injected clock; `before.value` / `after.value` are the old and new values (an item never
//   written may have before = null); key, from_version, to_version and reason are facts of
//   `before` ∪ `after` (the key may instead be the row's `target`);
// - alert: one pino warn line (level 40) with msg config_change_alert per changed key that names
//   the key as one of its string values; none when nothing changed or the transaction failed.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { configRegistry } from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { grant, seed, type Seed } from '../../admin/accounts/kit.ts';
import {
  apiRequire,
  factory,
  fixture,
  signedIn,
  totp,
  type Harness,
  type HttpApp,
  type Response,
} from '../../admin/auth/kit.ts';

export type Item = Schema<'AdminConfigItem'>;
export type Version = Schema<'AdminConfigItemVersion'>;
export type ItemPage = Schema<'AdminConfigItemPage'>;
export type VersionPage = Schema<'AdminConfigItemVersionPage'>;
export type Permission = 'config.general' | 'config.risk' | 'config.business';
// 'enum' only for the F1-02zi SETTLE group.
export type ValueType = 'boolean' | 'number' | 'string' | 'object' | 'enum';

export const LIST = '/admin/v1/config-items';
export const OPERATIONS = ['list', 'get', 'versions', 'update', 'batch', 'rollback'] as const;
export type Operation = (typeof OPERATIONS)[number];
export const ROUTES = {
  list: { method: 'GET', path: LIST },
  get: { method: 'GET', path: `${LIST}/{key}` },
  versions: { method: 'GET', path: `${LIST}/{key}/versions` },
  update: { method: 'PUT', path: `${LIST}/{key}` },
  batch: { method: 'POST', path: `${LIST}/batch` },
  rollback: { method: 'POST', path: `${LIST}/{key}/rollback` },
} as const;
export const READS = ['list', 'get', 'versions'] as const;
export const WRITES = ['update', 'batch', 'rollback'] as const;
export const ALL_POINTS: readonly Permission[] = [
  'config.general',
  'config.risk',
  'config.business',
];

export interface Expected {
  readonly key: string;
  readonly valueType: ValueType;
  readonly permission: Permission;
  readonly adminEditable: boolean;
  /** F1-02zi: options of an enum item; absent means null. */
  readonly options?: readonly string[];
}
const row = (
  key: string,
  valueType: ValueType,
  permission: Permission,
  adminEditable = true,
): Expected => ({ key, valueType, permission, adminEditable });

/** Ruling 14 (couli-runs/F1-10a/decision-orchestrator.md 裁定 14), key by key. */
export const EXPECTED: readonly Expected[] = [
  row('withdraw.payout_account_verify_per_day', 'number', 'config.business'),
  row('withdraw.payout_account_verify_inflight_timeout_sec', 'number', 'config.business'),
  row('withdraw.payout_account_verify_recheck_minutes', 'number', 'config.business'),
  row('withdraw.payout_account_verify_reuse_hours', 'number', 'config.business'),
  row('rebate.pdd.compare_precheck.enabled', 'boolean', 'config.business'),
  row('settle.estimate_change_diff.enabled', 'boolean', 'config.business', false),
  row('settle.adjust.void_on_clawback.enabled', 'boolean', 'config.business', false),
  row('order_sync.regression_hold.enabled', 'boolean', 'config.business', false),
  row('order_sync.unmapped_status_hold.enabled', 'boolean', 'config.business', false),
  row('ledger.bad_debt_require_no_frozen.enabled', 'boolean', 'config.business', false),
  row('payout.proven_success_writeoff.enabled', 'boolean', 'config.business', false),
  row('risk.merge_tombstone_dedupe', 'boolean', 'config.risk'),
  row('auth.oauth_attempt_ttl_sec', 'number', 'config.risk'),
  row('push.token_conflict_window_hours', 'number', 'config.risk'),
  row('attr.track_complete_tolerance_sec', 'number', 'config.risk'),
  row('external_page.union_host_block', 'boolean', 'config.risk'),
  row('union.taobao.auth_methods.ios', 'object', 'config.general'),
  row('union.taobao.auth_methods.android', 'object', 'config.general'),
  row('union.taobao.auth_methods.harmony', 'object', 'config.general'),
  row('external_page.nav_host_sample_bp', 'number', 'config.general'),
  row('share.open_in_app.enabled', 'boolean', 'config.general'),
  row('invite.bind_phone_guide', 'boolean', 'config.general'),
  row('invite.before_buy_tip', 'boolean', 'config.general'),
  row('earnings.dashboard.enabled', 'boolean', 'config.general'),
  row('earnings.dashboard.referral_visible', 'boolean', 'config.general'),
  row('order.user_query_months', 'number', 'config.general'),
  row('app_update.recheck_interval_sec', 'number', 'config.general'),
  row('agent.page_guide.routes', 'object', 'config.general', false),
  row('external_hosts', 'object', 'config.general', false),
];

// F1-02zi (F1-02zt：过渡已收紧, always registered).
// The BR-FUND-04 细则 settle.* parameters as F1-02zj registers them (couli-runs/F1-02zj
// excerpt 9.2-1/2): appended after external_hosts in this order, platforms taobao / jd / pdd /
// meituan, every one config.business and editable.
const PLATFORMS = ['taobao', 'jd', 'pdd', 'meituan'] as const;
const enumRow = (key: string, options: readonly string[], adminEditable = true): Expected => ({
  ...row(key, 'enum', 'config.business', adminEditable),
  options,
});
export const SETTLE: readonly Expected[] = [
  row('settle.bill_day', 'number', 'config.business'),
  ...PLATFORMS.map((p) => enumRow(`settle.period_basis.${p}`, ['received_at'])),
  ...PLATFORMS.map((p) => enumRow(`settle.statement_source.${p}`, ['api', 'upload'])),
  row('settle.batch.match_tolerance_fen', 'number', 'config.business'),
  row('settle.batch.max_orders', 'number', 'config.business'),
  ...PLATFORMS.map((p) => row(`settle.period_offset_months.${p}`, 'number', 'config.business')),
  row('settle.statement.grace_days', 'number', 'config.business'),
];
// F1-02zm (F1-02zt：过渡已收紧, always registered).
// The BR-INV-24 细则 invite reward parameters as F1-02zn registers them (couli-runs/F1-02zn
// excerpt 9.2-1): appended after the SETTLE group in this order, every one an editable number;
// the four money amounts config.business (04 §10.1), the same-IP window config.risk (D-C1).
export const INVITE_CFG: readonly Expected[] = [
  row('growth.invite_reward.amount_fen', 'number', 'config.business'),
  row('growth.invite_reward.daily_budget_fen', 'number', 'config.business'),
  row('growth.invite_reward.total_budget_fen', 'number', 'config.business'),
  row('growth.invite_reward.min_paid_fen', 'number', 'config.business'),
  row('growth.invite_reward.ip_window_hours', 'number', 'config.risk'),
];
/**
 * How many keys of `group` the registry under test holds; F1-02zt：过渡已收紧, it must be all of
 * them (the 0 branch is gone).
 */
export function presentOf(group: readonly Expected[], name: string): number {
  const registered = new Set(configRegistry().map((spec) => spec.key));
  const present = group.filter((entry) => registered.has(entry.key)).length;
  expect(present, `${name} group registered whole`).toBe(group.length);
  return present;
}
/**
 * F1-02zi / F1-02zm / F1-02zw: the registry oracle, EXPECTED followed by SETTLE and the invite
 * reward group inviteNow(). F1-02zt：过渡已收紧, the oracle is fixed.
 */
export function expectedNow(): readonly Expected[] {
  return [...EXPECTED, ...SETTLE, ...inviteNow()];
}
// F1-02zz (F1-02zt：过渡已收紧, always registered). The BR-INV-24 细则 eligibility period
// (08 l.560, SPEC_REF ac4d993) as F1-02zx registers it (couli-runs/F1-02zx excerpt 9.2-1, D-E2):
// one editable number, config.business, appended right after ip_window_hours as the last item.
export const INVITE_ELIG: readonly Expected[] = [
  row('growth.invite_reward.eligibility_days', 'number', 'config.business'),
];
/**
 * F1-02zz: the invite reward group, in order: the five INVITE_CFG keys followed by INVITE_ELIG.
 * F1-02zt：过渡已收紧, the none and five-keys-only branches are gone.
 */
export function inviteNow(): readonly Expected[] {
  return [...INVITE_CFG, ...INVITE_ELIG];
}
// B2-06bz (D10-244 ②、D10-296): the B2-06b payout channel keys, registered right after the growth
// group in this order. The two caps and the watermark are integers (number), biz_scene a string,
// the other four JSON (object); all config.business, editable, options null. Not part of
// expectedNow(), which stays the three groups before them.
export const PAYOUT: readonly Expected[] = [
  row('payout.single_cap_fen', 'number', 'config.business'),
  row('payout.daily_cap_fen', 'number', 'config.business'),
  row('payout.watermark_usable_bp', 'number', 'config.business'),
  row('payout.biz_scene', 'string', 'config.business'),
  row('payout.query_schedule', 'object', 'config.business'),
  row('payout.definite_fail_codes', 'object', 'config.business'),
  row('payout.payer_side_codes', 'object', 'config.business'),
  row('payout.query_status_map', 'object', 'config.business'),
];
// B2-11z (D10-368): the BR-WDR-29 audit risk-flag thresholds of B2-11a, registered right after
// PAYOUT in this order. All integers (number), config.risk, editable, options null. Not part of
// expectedNow() either.
export const RISK_WITHDRAW: readonly Expected[] = [
  row('risk.withdraw.invalid_ratio_bp', 'number', 'config.risk'),
  row('risk.withdraw.invalid_min_count', 'number', 'config.risk'),
  row('risk.withdraw.high_commission_rate_bp', 'number', 'config.risk'),
  row('risk.withdraw.high_commission_ratio_bp', 'number', 'config.risk'),
  row('risk.withdraw.min_orders', 'number', 'config.risk'),
  row('risk.withdraw.withdraw_received_ratio_bp', 'number', 'config.risk'),
];
// B2-11y (D10-373): the BR-WDR-30 细则 auto-payout rule group, registered right after
// RISK_WITHDRAW in this order (withdraw.auto_payout.enabled is a switch, not here). All
// config.business and editable except the two policies, which 08 has the console show read only
// (「不自动到账」); the two windows and two policies are enums with exactly 08's options, the two
// limit flags booleans, risk_block_flags a JSON array (object), the rest
// integers (number) with options null. Not part of expectedNow() either.
const AUTO = 'withdraw.auto_payout.';
export const AUTO_PAYOUT: readonly Expected[] = [
  row(`${AUTO}max_amount_fen`, 'number', 'config.business'),
  enumRow(`${AUTO}window_start`, [
    '09:00:00',
    '10:00:00',
    '11:00:00',
    '12:00:00',
    '13:00:00',
    '14:00:00',
    '15:00:00',
    '16:00:00',
    '17:00:00',
    '18:00:00',
    '19:00:00',
    '20:00:00',
    '21:00:00',
    '22:00:00',
  ]),
  enumRow(`${AUTO}window_end`, [
    '09:59:59',
    '10:59:59',
    '11:59:59',
    '12:59:59',
    '13:59:59',
    '14:59:59',
    '15:59:59',
    '16:59:59',
    '17:59:59',
    '18:59:59',
    '19:59:59',
    '20:59:59',
    '21:59:59',
    '22:59:59',
  ]),
  row(`${AUTO}window_limit_enabled`, 'boolean', 'config.business'),
  row(`${AUTO}first_withdrawal_limit_enabled`, 'boolean', 'config.business'),
  enumRow(`${AUTO}frozen_balance_policy`, ['no_auto'], false),
  enumRow(`${AUTO}same_day_policy`, ['no_auto'], false),
  row(`${AUTO}payee_daily_max_count`, 'number', 'config.business'),
  row(`${AUTO}payee_monthly_max_count`, 'number', 'config.business'),
  row(`${AUTO}user_daily_max_count`, 'number', 'config.business'),
  row(`${AUTO}user_monthly_max_count`, 'number', 'config.business'),
  row(`${AUTO}warn.high_commission_rate_bp`, 'number', 'config.business'),
  row(`${AUTO}warn.high_commission_order_ratio_bp`, 'number', 'config.business'),
  row(`${AUTO}warn.invalid_ratio_bp`, 'number', 'config.business'),
  row(`${AUTO}warn.withdraw_received_ratio_bp`, 'number', 'config.business'),
  row(`${AUTO}platform_daily_max_fen`, 'number', 'config.business'),
  row(`${AUTO}risk_block_flags`, 'object', 'config.business'),
];
// B2-11dz (D10-392 / D10-394): the BR-WDR-30 细则「开启前置检查」keys the owner fills when enabling,
// registered right after AUTO_PAYOUT in this order: BR-WDR-22 ② ⑤ ⑧ as booleans (seeded false)
// and the reconciliation days the owner requires, an integer with no seed row (unset = not
// passed; AUTO_ENABLE_UNSEEDED). All config.business and editable, options null. Not part of
// expectedNow() either.
const ENABLE_CHECK = 'payout.auto_enable_check.';
export const AUTO_ENABLE_CHECK: readonly Expected[] = [
  row(`${ENABLE_CHECK}limits_supported`, 'boolean', 'config.business'),
  row(`${ENABLE_CHECK}status_codes_supported`, 'boolean', 'config.business'),
  row(`${ENABLE_CHECK}bill_out_biz_no_supported`, 'boolean', 'config.business'),
  row(`${ENABLE_CHECK}recon_required_days`, 'number', 'config.business'),
];
/** B2-11dz (D10-392 / D10-394): registered items that 08 leaves unset by default, hence no seed row. */
export const AUTO_ENABLE_UNSEEDED: readonly string[] = [`${ENABLE_CHECK}recon_required_days`];
// B1-28g (D10-419): the server-side cache lifetime of the hot-sales rank (规划/04 §10.1 服务端业务
// 配置键, seeded 600), registered right after AUTO_ENABLE_CHECK: an editable config.business
// integer, options null. Not part of expectedNow() either.
export const RANK: readonly Expected[] = [
  row('rank.cache_ttl_seconds', 'number', 'config.business'),
];
// B1-05l (D10-419 (a)): the search hot words and keyword direct routes, registered right after
// RANK in this order: editable config.business objects, options null, seeded as empty lists
// (empty = no hot words, no direct route). Not part of expectedNow() either.
export const SEARCH: readonly Expected[] = [
  row('search.hot_words', 'object', 'config.business'),
  row('search.keyword_routes', 'object', 'config.business'),
];
// B1-15zd (D10-454, BR-ID-30): the retention purge master switch (an ordinary item, not a 04
// §10.2 kill switch) and each table's retention in whole days, registered right after SEARCH in
// this order: editable config.risk, options null. Not part of expectedNow() either.
export const RETENTION: readonly Expected[] = [
  row('retention.purge.enabled', 'boolean', 'config.risk'),
  row('retention.login_logs_days', 'number', 'config.risk'),
  row('retention.device_registrations_days', 'number', 'config.risk'),
  row('retention.sms_send_attempts_days', 'number', 'config.risk'),
  row('retention.inbox_messages_days', 'number', 'config.risk'),
  row('retention.notify_logs_days', 'number', 'config.risk'),
  row('retention.union_raw_payloads_days', 'number', 'config.risk'),
];
// B2-08cz (D10-456 ④, BR-WDR-20): the tax configuration of commission income (SERVICE_FEE),
// registered right after RETENTION in this order: the withholding method (enum none / flat_rate /
// cumulative), the flat rate in bp and the progressive rate table, all editable config.business.
// Not part of expectedNow() either.
export const TAX: readonly Expected[] = [
  enumRow('tax.SERVICE_FEE.method', ['none', 'flat_rate', 'cumulative']),
  row('tax.SERVICE_FEE.rate_bp', 'number', 'config.business'),
  row('tax.SERVICE_FEE.rate_table', 'object', 'config.business'),
];
// B1-05s (D10-480): the feed's union fall-back pool (规划/02 §14) and the BR-PRICE-11 pool price age
// limit and refresh interval, registered right after TAX in this order: editable config.business,
// options null. Not part of expectedNow() either.
export const POOL: readonly Expected[] = [
  row('feed.fallback_pool_id', 'string', 'config.business'),
  row('pool.max_age_sec', 'number', 'config.business'),
  row('pool.refresh_interval_sec', 'number', 'config.business'),
];
/** B1-05s (D10-480): the fall-back pool is unset by default, hence no seed row. */
export const POOL_UNSEEDED: readonly string[] = ['feed.fallback_pool_id'];
// B1-02zs (B1-02zp prerequisite, BR-WDR-01 细则): the old-account re-verification days of a
// withdrawal, registered right after POOL: editable config.business, options null. Not part of
// expectedNow() either.
export const REVERIFY: readonly Expected[] = [
  row('withdraw.dormant_reverify_days', 'number', 'config.business'),
];
// B1-06ze (B1-06zd prerequisite, D10-510): the Taobao promotion link share switch, prefetch switch
// and prefetch cap per minute, registered right after REVERIFY in this order: editable
// config.business, options null. Not part of expectedNow() either.
export const PROMO_LINK: readonly Expected[] = [
  row('share.taobao_enabled', 'boolean', 'config.business'),
  row('convert.taobao_prefetch.enabled', 'boolean', 'config.business'),
  row('convert.taobao_prefetch.rate_per_min', 'number', 'config.business'),
];
/** B1-06ze (D10-510): all three are unset by default (off, off, 60), hence no seed rows. */
export const PROMO_LINK_UNSEEDED: readonly string[] = [
  'share.taobao_enabled',
  'convert.taobao_prefetch.enabled',
  'convert.taobao_prefetch.rate_per_min',
];
// B1-04zq (B1-04zm prerequisite, D10-543): the order rescan switches and days of JD and PDD,
// registered right after PROMO_LINK in this order: editable config.business, options null. Not
// part of expectedNow() either.
export const ORDER_RESCAN: readonly Expected[] = [
  row('order_sync.rescan.jd.enabled', 'boolean', 'config.business'),
  row('order_sync.rescan.pdd.enabled', 'boolean', 'config.business'),
  row('order_sync.rescan.jd.days', 'number', 'config.business'),
  row('order_sync.rescan.pdd.days', 'number', 'config.business'),
];
/** B1-04zq (D10-543): all four are unset by default (on, off, 30, 90), hence no seed rows. */
export const ORDER_RESCAN_UNSEEDED: readonly string[] = [
  'order_sync.rescan.jd.enabled',
  'order_sync.rescan.pdd.enabled',
  'order_sync.rescan.jd.days',
  'order_sync.rescan.pdd.days',
];
// B2-04zo (BR-FUND-20 细则): the advance alert threshold in fen, registered right after
// ORDER_RESCAN: editable config.business, options null, with no seed row (unset = no alert, the
// super admin fills it in; ADVANCE_ALERT_UNSEEDED). Not part of expectedNow() either.
export const ADVANCE_ALERT: readonly Expected[] = [
  row('ledger.advance_alert_fen', 'number', 'config.business'),
];
/** B2-04zo (BR-FUND-20 细则): unset by default (no alert until filled in), hence no seed row. */
export const ADVANCE_ALERT_UNSEEDED: readonly string[] = ['ledger.advance_alert_fen'];
// B2-03t (D10-605 (a)): the two keys the rebate quoter reads, registered right after ADVANCE_ALERT
// in this order: editable config.business, options null. Not part of expectedNow() either.
export const QUOTE: readonly Expected[] = [
  row('tech_fee_bp', 'object', 'config.business'),
  row('rebate.taobao.compare_rate_ratio_bp', 'number', 'config.business'),
];
/** B2-03t (D10-605): BR-CALC-20 / BR-PRICE-07 are still placeholders, hence no seed rows. */
export const QUOTE_UNSEEDED: readonly string[] = [
  'tech_fee_bp',
  'rebate.taobao.compare_rate_ratio_bp',
];
// B2-03u (D10-608): share_domains, registered right after QUOTE: editable config.business, its
// value an array of strings (recorded as object), options null. Not part of expectedNow() either.
export const SHARE: readonly Expected[] = [row('share_domains', 'object', 'config.business')];
/** B2-03u (D10-608): domains differ per environment, hence no seed row. */
export const SHARE_UNSEEDED: readonly string[] = ['share_domains'];
// B2-03v (D10-610): bridge_origins, registered right after SHARE: editable config.risk, its value
// the unsigned {origins} object, options null. Not part of expectedNow() either.
export const BRIDGE: readonly Expected[] = [row('bridge_origins', 'object', 'config.risk')];
/** B2-03v (D10-610): unset means F1-02zzzb signs the h5_base_url origin, hence no seed row. */
export const BRIDGE_UNSEEDED: readonly string[] = ['bridge_origins'];
// B2-03w (D10-637): me.default_avatar_url, registered right after BRIDGE: editable
// config.business, its value a string, options null. Not part of expectedNow() either.
export const AVATAR: readonly Expected[] = [
  row('me.default_avatar_url', 'string', 'config.business'),
];
/** B2-03w (D10-637): addresses differ per environment, hence no seed row. */
export const AVATAR_UNSEEDED: readonly string[] = ['me.default_avatar_url'];
// B2-03x (D10-646): the six keys identity's labor agreement reads, registered right after AVATAR
// in this order: editable config.business, the two versions numbers and the other four strings,
// options null. Not part of expectedNow() either.
export const LABOR: readonly Expected[] = [
  row('legal.labor_agreement.version', 'number', 'config.business'),
  row('legal.labor_agreement.text_url', 'string', 'config.business'),
  row('legal.labor_agreement.text_sha256', 'string', 'config.business'),
  row('legal.labor_agreement.resign_from_version', 'number', 'config.business'),
  row('legal.operator_entity.name', 'string', 'config.business'),
  row('legal.operator_entity.credit_code', 'string', 'config.business'),
];
/** B2-03x (D10-646): the values are the owner's, hence no seed rows. */
export const LABOR_UNSEEDED: readonly string[] = LABOR.map((entry) => entry.key);
// B1-28q (D10-698): the two product feedback keys, registered right after LABOR in this order:
// editable config.business, the switch a boolean and the per-device daily cap a number, options
// null; both seeded (true and 20). Not part of expectedNow() either.
export const FEEDBACK: readonly Expected[] = [
  row('feedback.enabled', 'boolean', 'config.business'),
  row('feedback.daily_limit_per_device', 'number', 'config.business'),
];
// B2-12e (D10-590, 08 BR-FUND-12): the two bad debt write-off thresholds, registered right after
// FEEDBACK in this order: editable config.business numbers, options null; both seeded (90 days and
// 0 fen, placeholders the super admin fills in before launch). Not part of expectedNow() either.
export const BAD_DEBT: readonly Expected[] = [
  row('ledger.bad_debt_days', 'number', 'config.business'),
  row('ledger.bad_debt_min_fen', 'number', 'config.business'),
];
export const expectedOf = (key: string): Expected => {
  const found = [
    ...expectedNow(),
    ...PAYOUT,
    ...RISK_WITHDRAW,
    ...AUTO_PAYOUT,
    ...AUTO_ENABLE_CHECK,
    ...RANK,
    ...SEARCH,
    ...RETENTION,
    ...TAX,
    ...POOL,
    ...REVERIFY,
    ...PROMO_LINK,
    ...ORDER_RESCAN,
    ...ADVANCE_ALERT,
    ...QUOTE,
    ...SHARE,
    ...BRIDGE,
    ...AVATAR,
    ...LABOR,
    ...FEEDBACK,
    ...BAD_DEBT,
  ].find((entry) => entry.key === key);
  expect(found, key).toBeDefined();
  return found!;
};
/** The six money-rule flags of ruling 14 (admin_editable=false). */
export const FUND_FLAGS = [
  'settle.estimate_change_diff.enabled',
  'settle.adjust.void_on_clawback.enabled',
  'order_sync.regression_hold.enabled',
  'order_sync.unmapped_status_hold.enabled',
  'ledger.bad_debt_require_no_frozen.enabled',
  'payout.proven_success_writeoff.enabled',
] as const;

/** Keys the tests write, one editable number / boolean key per point. */
export const KEYS = {
  general: 'order.user_query_months',
  generalFlag: 'share.open_in_app.enabled',
  generalFlag2: 'invite.bind_phone_guide',
  risk: 'auth.oauth_attempt_ttl_sec',
  riskFlag: 'risk.merge_tombstone_dedupe',
  business: 'withdraw.payout_account_verify_per_day',
  business2: 'withdraw.payout_account_verify_reuse_hours',
} as const;
export const POINT_KEYS: Readonly<Record<Permission, string>> = {
  'config.general': KEYS.general,
  'config.risk': KEYS.risk,
  'config.business': KEYS.business,
};
/** Not configuration items: 04 §10.1 keys outside ruling 14, switch keys, prototype names. */
export const UNREGISTERED = [
  'invite.fail_limit_per_day',
  'level.default',
  'landing.ip_register_limit',
  'growth.invite_bind.enabled',
  'parse.tpwd.enabled',
  'convert.enabled.taobao',
  'agent.page_guide.enabled',
  'order.user_query_months.x',
  'order.user_query',
  'constructor',
  '__proto__',
  'toString',
] as const;

/** Every row of db/seeds/0001_config-defaults.sql: key → JSON value. */
export function seedRows(): ReadonlyMap<string, unknown> {
  const text = readFileSync(
    fileURLToPath(new URL('../../../../db/seeds/0001_config-defaults.sql', import.meta.url)),
    'utf8',
  );
  const result = new Map<string, unknown>();
  for (const match of text.matchAll(/\('couli', '([^']+)', '([^']*)'::jsonb/g)) {
    result.set(match[1]!, JSON.parse(match[2]!));
  }
  return result;
}
export function jsonTypeOf(value: unknown): ValueType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return 'object';
}

// ---- HTTP ---------------------------------------------------------------------------------

interface AnyApp {
  inject(input: {
    method: 'GET' | 'PUT' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<Response>;
}

export function hasRoute(app: HttpApp, op: Operation): boolean {
  const server = app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(input: { method: string; url: string }): boolean;
  };
  const route = ROUTES[op];
  return server.hasRoute({ method: route.method, url: route.path.replace(/\{(\w+)\}/g, ':$1') });
}

export async function setup(h: Harness) {
  const f = await fixture(h);
  // Missing business routes must fail every test as an assertion, never a 404 false green.
  for (const op of OPERATIONS) expect(hasRoute(f.app, op), ROUTES[op].path).toBe(true);
  const appId = `f1-10e-${randomUUID()}`;
  const actor = await seed(h, appId, { isSuper: true });
  const session = await signedIn(f, actor);
  return { ...f, appId, actor, token: session.admin_token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

/** A non-super account of the same app with exactly `grants`. */
export async function member(h: Harness, f: Setup, grants: readonly string[]) {
  const who = await seed(h, f.appId);
  if (grants.length > 0) await grant(h, who, f.actor, grants);
  const session = await signedIn(f, who);
  return { who, token: session.admin_token };
}

/** A fresh totp-tier step-up token for `who` (moves the clock to a new TOTP window). */
export async function stepUp(f: Setup, who: Seed = f.actor, token: string = f.token) {
  f.clock.advanceMs(30_000);
  const response = await f.post(
    '/step-up',
    { tier: 'totp', code: totp(who.secret, f.clock) },
    { authorization: `Bearer ${token}` },
  );
  expect(response.statusCode).toBe(200);
  const data = response.json<{ data: { step_up_token: string } }>().data;
  expect(typeof data.step_up_token).toBe('string');
  return data.step_up_token;
}

export interface Call {
  key?: string;
  query?: string;
  body?: unknown;
  token?: string | null;
  stepUp?: string;
  app?: HttpApp;
}
export function call(f: Pick<Setup, 'app' | 'token'>, op: Operation, c: Call = {}) {
  const route = ROUTES[op];
  const token = c.token === undefined ? f.token : c.token;
  const url =
    route.path.replace('{key}', encodeURIComponent(c.key ?? KEYS.general)) + (c.query ?? '');
  return ((c.app ?? f.app) as unknown as AnyApp).inject({
    method: route.method,
    url,
    headers: {
      ...(route.method === 'GET' ? {} : { 'content-type': 'application/json' }),
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(c.stepUp === undefined ? {} : { 'x-step-up-token': c.stepUp }),
    },
    ...(route.method === 'GET' ? {} : { payload: JSON.stringify(c.body ?? {}) }),
    remoteAddress: '127.0.0.1',
  });
}
export const update = (
  f: Pick<Setup, 'app' | 'token'>,
  key: string,
  body: Record<string, unknown>,
  extra: Omit<Call, 'key' | 'body'> = {},
) => call(f, 'update', { ...extra, key, body });
export const batch = (
  f: Pick<Setup, 'app' | 'token'>,
  body: Record<string, unknown>,
  extra: Omit<Call, 'key' | 'body'> = {},
) => call(f, 'batch', { ...extra, body });
export const rollback = (
  f: Pick<Setup, 'app' | 'token'>,
  key: string,
  body: Record<string, unknown>,
  extra: Omit<Call, 'key' | 'body'> = {},
) => call(f, 'rollback', { ...extra, key, body });

type Validator = ReturnType<ReturnType<typeof createValidatorCompiler>>;
let validators: Promise<Map<string, Validator>> | undefined;
async function responseValidators() {
  validators ??= (async () => {
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(
        path: string,
        options: object,
      ): Promise<{
        paths: Record<
          string,
          Record<
            string,
            { responses: Record<string, { content: Record<string, { schema: JsonSchema }> }> }
          >
        >;
      }>;
    };
    const doc = await parser.dereference(
      fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
      { resolve: { external: false } },
    );
    const compile = createValidatorCompiler();
    const result = new Map<string, Validator>();
    for (const op of OPERATIONS) {
      const { method, path } = ROUTES[op];
      for (const status of ['200', '4XX', '5XX']) {
        const responses = doc.paths[path]![method.toLowerCase()]!.responses;
        result.set(
          `${op}:${status}`,
          compile({
            schema: responses[status]!.content['application/json']!.schema,
            httpPart: 'body',
          }),
        );
      }
    }
    return result;
  })();
  return validators;
}
export async function validate(response: Response, op: Operation) {
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const check = (await responseValidators()).get(`${op}:${status}`)!;
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}
export async function success<T>(response: Response, op: Operation): Promise<T> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  await validate(response, op);
  return response.json<{ data: T }>().data;
}
export async function rejected(response: Response, op: Operation, code: number, data?: object) {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(
    code === 10001
      ? 401
      : code === 10003 || code === 10403
        ? 403
        : code === 20902
          ? 409
          : code >= 50000
            ? 500
            : 400,
  );
  expect(response.json()).toMatchObject({ code });
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(response, op);
}
export const keyInvalid = (response: Response, op: Operation) =>
  rejected(response, op, 20001, { fields: ['key'] });
export const valueInvalid = (response: Response, op: Operation) =>
  rejected(response, op, 20001, { fields: ['value'] });
export const conflict = (response: Response, op: Operation) =>
  rejected(response, op, 20902, { resource: 'config_item' });
export const needsTotp = (response: Response, op: Operation) =>
  rejected(response, op, 10003, { tier: 'totp' });
export const denied = (response: Response, op: Operation) =>
  rejected(response, op, 10403, { reason: 'admin_permission_denied' });

export async function getItem(f: Pick<Setup, 'app' | 'token'>, key: string): Promise<Item> {
  return success<Item>(await call(f, 'get', { key }), 'get');
}
export async function listPage(f: Pick<Setup, 'app' | 'token'>, query = ''): Promise<ItemPage> {
  return success<ItemPage>(await call(f, 'list', { query }), 'list');
}
export async function listAll(f: Pick<Setup, 'app' | 'token'>): Promise<Item[]> {
  const page = await listPage(f, '?page=1&page_size=200');
  expect(page.total).toBe(page.items.length);
  return page.items;
}
export async function historyPage(
  f: Pick<Setup, 'app' | 'token'>,
  key: string,
  query = '',
): Promise<VersionPage> {
  return success<VersionPage>(await call(f, 'versions', { key, query }), 'versions');
}

/** The item as the contract describes it, timestamps normalised to ISO. */
export function normalized(item: Item): Item {
  return {
    ...item,
    updated_at: item.updated_at === null ? null : new Date(item.updated_at).toISOString(),
  };
}
export function normalizedVersion(version: Version): Version {
  return { ...version, created_at: new Date(version.created_at).toISOString() };
}
/** The full expected item for a registered key. */
export function itemOf(
  key: string,
  state: { value: unknown; version: number; updated_by: string | null; updated_at: string | null },
): Item {
  const spec = expectedOf(key);
  return {
    key,
    value: state.value as Item['value'],
    value_type: spec.valueType,
    options: spec.options === undefined ? null : [...spec.options], // F1-02zi: null for EXPECTED
    permission: spec.permission,
    admin_editable: spec.adminEditable,
    version: state.version,
    updated_by: state.updated_by,
    updated_at: state.updated_at,
  };
}
export const unwritten = (key: string): Item =>
  itemOf(key, { value: null, version: 0, updated_by: null, updated_at: null });

// ---- database --------------------------------------------------------------------------------

export const ROW_AT = '2026-10-05T01:02:03.000Z';

/** A current-value row as a seed or an earlier write left it (no history row is added). */
export async function putRow(
  h: Harness,
  appId: string,
  key: string,
  value: unknown,
  version = 1,
  updatedBy = 'seed',
) {
  await h.db
    .insertInto('config_items')
    .values({
      app_id: appId,
      key,
      value: JSON.stringify(value),
      version,
      updated_by: updatedBy,
      created_at: ROW_AT,
      updated_at: ROW_AT,
    })
    .execute();
}
/** A stored history version. */
export async function putVersion(
  h: Harness,
  appId: string,
  key: string,
  version: number,
  value: unknown,
  by: Seed | null,
  reason: string | null = null,
  createdAt = ROW_AT,
) {
  await h.db
    .insertInto('config_item_versions')
    .values({
      app_id: appId,
      key,
      version,
      value: JSON.stringify(value),
      updated_by: by === null ? 'system' : 'history-snapshot',
      updated_by_admin_id: by === null ? null : by.id,
      reason,
      created_at: createdAt,
    })
    .execute();
}
/** Current row and stored history 1..values.length of one key (values[i] is version i + 1). */
export async function written(
  h: Harness,
  appId: string,
  key: string,
  values: readonly unknown[],
  by: Seed,
) {
  for (const [index, value] of values.entries()) {
    await putVersion(h, appId, key, index + 1, value, by, `r${index + 1}`);
  }
  await putRow(h, appId, key, values.at(-1), values.length, 'history-snapshot');
}

export async function snapshot(h: Harness, appId: string) {
  return {
    items: await h.db
      .selectFrom('config_items')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('key')
      .execute(),
    versions: await h.db
      .selectFrom('config_item_versions')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('key')
      .orderBy('version')
      .execute(),
    audits: await h.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  };
}
export type Snapshot = Awaited<ReturnType<typeof snapshot>>;
export const current = (h: Harness, appId: string, key: string) =>
  h.db
    .selectFrom('config_items')
    .selectAll()
    .where('app_id', '=', appId)
    .where('key', '=', key)
    .executeTakeFirst();
export const versionsOf = (h: Harness, appId: string, key: string) =>
  h.db
    .selectFrom('config_item_versions')
    .selectAll()
    .where('app_id', '=', appId)
    .where('key', '=', key)
    .orderBy('version')
    .execute();

/** The audit rows written since `before`. */
export async function auditsSince(h: Harness, appId: string, before: Snapshot) {
  const ids = new Set(before.audits.map((audit) => audit.id));
  return (await snapshot(h, appId)).audits.filter((audit) => !ids.has(audit.id));
}

export interface Change {
  key: string;
  from: number;
  to: number;
  before: unknown;
  after: unknown;
  reason?: string;
}
type AuditRow = Snapshot['audits'][number];
const objectOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
/** Checks one audit row against a change (the kit's header fixes the reading). */
export function expectAudit(
  audit: AuditRow,
  f: Pick<Setup, 'clock'>,
  actor: Seed,
  action: 'config_item_change' | 'config_item_rollback',
  change: Change,
) {
  expect(audit).toMatchObject({ app_id: actor.appId, admin_id: actor.id, action });
  expect(audit.at.toISOString()).toBe(f.clock.now().toISOString());
  const before = objectOf(audit.before);
  const after = objectOf(audit.after);
  expect(after.value).toStrictEqual(change.after);
  expect(before.value ?? null).toStrictEqual(change.before);
  const facts = { ...before, ...after };
  expect(audit.target === change.key || facts.key === change.key, 'audit names the key').toBe(true);
  expect(facts.from_version).toBe(change.from);
  if (action === 'config_item_change') expect(facts.to_version).toBe(change.to);
  if (change.reason !== undefined) expect(facts.reason).toBe(change.reason);
}
export const auditOfKey = (audits: readonly AuditRow[], key: string) => {
  const found = audits.filter(
    (audit) =>
      audit.target === key ||
      objectOf(audit.after).key === key ||
      objectOf(audit.before).key === key,
  );
  expect(found, `one audit row for ${key}`).toHaveLength(1);
  return found[0]!;
};

// ---- alert log -------------------------------------------------------------------------------

function mentions(node: unknown, key: string): boolean {
  if (node === key) return true;
  if (Array.isArray(node)) return node.some((item) => mentions(item, key));
  if (typeof node === 'object' && node !== null) {
    return Object.values(node).some((item) => mentions(item, key));
  }
  return false;
}
export function alerts(lines: readonly string[]): Record<string, unknown>[] {
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter((line) => line.msg === 'config_change_alert');
}
/** Alert lines added since `seen` lines; every one a warn line. */
export function alertsSince(lines: readonly string[], seen: number) {
  const added = alerts(lines.slice(seen));
  for (const line of added) expect(line.level).toBe(40);
  return added;
}
export function expectAlerted(lines: readonly string[], seen: number, keys: readonly string[]) {
  const added = alertsSince(lines, seen);
  expect(added.length).toBeGreaterThan(0);
  for (const key of keys) {
    expect(
      added.filter((line) => mentions(line, key)),
      `one config_change_alert for ${key}`,
    ).toHaveLength(1);
  }
}

/** An admin-entry app on another database handle (fault injection or statement capture). */
export async function appWith(h: Harness, f: Setup, db: Harness['db']) {
  const app = await (
    await factory()
  )('admin', {
    ...f.overrides,
    dbHandles: { db, dbRead: null, close: async () => undefined },
  });
  h.apps.push(app);
  await app.init();
  return app;
}
