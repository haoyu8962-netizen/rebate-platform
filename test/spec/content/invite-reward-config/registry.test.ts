import { expect, it } from 'vitest';
import {
  configItemSpecOf,
  configRegistry,
  configValueFits,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import {
  switchRegistry,
  switchSpecOf,
} from '../../../../apps/api/src/modules/content/domain/switch-registry.ts';
import { CONFIGS, ENABLED, PAUSED, PREFIX } from './oracle.ts';

// F1-02zw: BR-INV-24 细则 (08 l.560).
const ELIGIBILITY = `${PREFIX}eligibility_days`;

it.each(CONFIGS)('[AC-F1-02zn#1] $key：类型、权限、可编辑性与整数范围', (row) => {
  expect(configItemSpecOf(row.key)).toStrictEqual({
    key: row.key,
    valueType: 'number',
    options: null,
    permission: row.permission,
    adminEditable: true,
    range: { integer: true, min: row.min, max: 2147483647 },
  });
  expect(configRegistry().filter((entry) => entry.key === row.key)).toHaveLength(1);
  expect(switchSpecOf(row.key)).toBeNull();
});

// F1-02zw: F1-02zx appends growth.invite_reward.eligibility_days right after the five keys as the
// sixth key; the five keys still follow settle.statement.grace_days directly. F1-02zt：过渡已收紧,
// the sixth key must be present. B2-06bz (D10-244 ②、D10-296): the eight payout.* keys follow
// eligibility_days in this order, then B2-11z (D10-368) the six risk.withdraw.* keys in this
// order, then B2-11y (D10-373) the seventeen withdraw.auto_payout.* keys in this order, then
// B2-11dz (D10-392 / D10-394) the four payout.auto_enable_check.* keys in this order, then
// B1-28g (D10-419) rank.cache_ttl_seconds, then B1-05l (D10-419 (a)) search.hot_words and
// search.keyword_routes in this order, then B1-15zd (D10-454) the seven retention.* keys in this
// order, then B2-08cz (D10-456 ④) the three tax.SERVICE_FEE.* keys in this order, then B1-05s
// (D10-480) feed.fallback_pool_id and the two pool.* keys in this order, then B1-02zs
// withdraw.dormant_reverify_days, then B1-06ze (D10-510) the three Taobao promotion link keys in
// this order, then B1-04zq (D10-543) the four order_sync.rescan.* keys in this order, then B2-04zo
// ledger.advance_alert_fen, then B2-03t (D10-605 (a)) tech_fee_bp and
// rebate.taobao.compare_rate_ratio_bp in this order, then B2-03u (D10-608) share_domains, then
// B2-03v (D10-610) bridge_origins, then B2-03w (D10-637) me.default_avatar_url, and nothing else.
it('[AC-F1-02zn#2] 五项按指定顺序追加在 SETTLE 之后', () => {
  const keys = configRegistry().map((entry) => entry.key);
  const i = keys.indexOf('settle.statement.grace_days');
  expect(i).toBeGreaterThanOrEqual(0);
  expect(keys.slice(i, i + 6)).toStrictEqual([
    'settle.statement.grace_days',
    ...CONFIGS.map((row) => row.key),
  ]);
  expect(keys.slice(i + 6)).toStrictEqual([
    ELIGIBILITY,
    'payout.single_cap_fen',
    'payout.daily_cap_fen',
    'payout.watermark_usable_bp',
    'payout.biz_scene',
    'payout.query_schedule',
    'payout.definite_fail_codes',
    'payout.payer_side_codes',
    'payout.query_status_map',
    'risk.withdraw.invalid_ratio_bp',
    'risk.withdraw.invalid_min_count',
    'risk.withdraw.high_commission_rate_bp',
    'risk.withdraw.high_commission_ratio_bp',
    'risk.withdraw.min_orders',
    'risk.withdraw.withdraw_received_ratio_bp',
    'withdraw.auto_payout.max_amount_fen',
    'withdraw.auto_payout.window_start',
    'withdraw.auto_payout.window_end',
    'withdraw.auto_payout.window_limit_enabled',
    'withdraw.auto_payout.first_withdrawal_limit_enabled',
    'withdraw.auto_payout.frozen_balance_policy',
    'withdraw.auto_payout.same_day_policy',
    'withdraw.auto_payout.payee_daily_max_count',
    'withdraw.auto_payout.payee_monthly_max_count',
    'withdraw.auto_payout.user_daily_max_count',
    'withdraw.auto_payout.user_monthly_max_count',
    'withdraw.auto_payout.warn.high_commission_rate_bp',
    'withdraw.auto_payout.warn.high_commission_order_ratio_bp',
    'withdraw.auto_payout.warn.invalid_ratio_bp',
    'withdraw.auto_payout.warn.withdraw_received_ratio_bp',
    'withdraw.auto_payout.platform_daily_max_fen',
    'withdraw.auto_payout.risk_block_flags',
    'payout.auto_enable_check.limits_supported',
    'payout.auto_enable_check.status_codes_supported',
    'payout.auto_enable_check.bill_out_biz_no_supported',
    'payout.auto_enable_check.recon_required_days',
    'rank.cache_ttl_seconds',
    'search.hot_words',
    'search.keyword_routes',
    'retention.purge.enabled',
    'retention.login_logs_days',
    'retention.device_registrations_days',
    'retention.sms_send_attempts_days',
    'retention.inbox_messages_days',
    'retention.notify_logs_days',
    'retention.union_raw_payloads_days',
    'tax.SERVICE_FEE.method',
    'tax.SERVICE_FEE.rate_bp',
    'tax.SERVICE_FEE.rate_table',
    'feed.fallback_pool_id',
    'pool.max_age_sec',
    'pool.refresh_interval_sec',
    'withdraw.dormant_reverify_days',
    'share.taobao_enabled',
    'convert.taobao_prefetch.enabled',
    'convert.taobao_prefetch.rate_per_min',
    'order_sync.rescan.jd.enabled',
    'order_sync.rescan.pdd.enabled',
    'order_sync.rescan.jd.days',
    'order_sync.rescan.pdd.days',
    'ledger.advance_alert_fen',
    'tech_fee_bp',
    'rebate.taobao.compare_rate_ratio_bp',
    'share_domains',
    'bridge_origins',
    'me.default_avatar_url',
  ]);
});

it.each(CONFIGS)('[AC-F1-02zn#3] $key：闭区间、默认值、拒绝浮点与隐式转换', (row) => {
  const spec = configItemSpecOf(row.key);
  expect(spec, row.key).not.toBeNull();
  for (const value of [row.min, row.min + 1, row.seed, 1000, 2147483647]) {
    expect(configValueFits(spec!, value), String(value)).toBe(true);
  }
  for (const value of [
    row.min - 1,
    -1,
    2147483648,
    10.5,
    NaN,
    Infinity,
    -Infinity,
    '1000',
    '24',
    null,
    undefined,
    true,
    false,
    [],
    {},
  ]) {
    expect(configValueFits(spec!, value), String(value)).toBe(false);
  }
});

it.each([ENABLED, PAUSED])('[AC-F1-02zn#4] %s：默认 off、switch.all、可改且非系统写', (key) => {
  expect(switchSpecOf(key)).toStrictEqual({
    pattern: key,
    valueType: { kind: 'boolean' },
    defaultValue: false,
    defaultOverrides: {},
    permissions: ['switch.all'],
    adminEditable: true,
    systemWritten: false,
  });
  expect(configItemSpecOf(key)).toBeNull();
  expect(switchRegistry().filter((entry) => entry.pattern === key)).toHaveLength(1);
});

it('[AC-F1-02zn#5] 两个开关按顺序追加在 watch.enabled.<platform> 之后', () => {
  expect(
    switchRegistry()
      .slice(-3)
      .map((entry) => entry.pattern),
  ).toStrictEqual(['watch.enabled.<platform>', ENABLED, PAUSED]);
});
