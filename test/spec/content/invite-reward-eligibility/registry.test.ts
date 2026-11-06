import { expect, it } from 'vitest';
import {
  configItemSpecOf,
  configRegistry,
  configValueFits,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import {
  CLIENT_CONFIG_KEYS,
  buildClientConfig,
} from '../../../../apps/api/src/modules/content/domain/client-config.ts';
import {
  INVITE_REWARD_POSITIVE_KEYS,
  inviteRewardGuardedKey,
  inviteRewardOpenRefused,
} from '../../../../apps/api/src/modules/content/domain/invite-reward.ts';
import { switchSpecOf } from '../../../../apps/api/src/modules/content/domain/switch-registry.ts';
import { AMOUNT, DAILY, DEFAULTS, ENABLED, KEY, SPEC, TOTAL, WINDOW } from './oracle.ts';

it('[AC-F1-02zx#1] 资格天数是唯一的可改业务配置，整数范围 1–3650，不是开关', () => {
  const spec = configItemSpecOf(KEY);
  expect(spec).toStrictEqual(SPEC);
  expect(configRegistry().filter((entry) => entry.key === KEY)).toStrictEqual([SPEC]);
  expect(switchSpecOf(KEY)).toBeNull();
  expect(Object.isFrozen(configRegistry())).toBe(true);
  expect(Object.isFrozen(spec)).toBe(true);
  expect(Object.isFrozen(spec!.range)).toBe(true);
});

// B2-06bz (D10-244 ②、D10-296): the six keys stay contiguous, now followed directly by the eight
// payout.* keys in this order (and nothing else), instead of ending the registry. B2-11z
// (D10-368): the six risk.withdraw.* keys follow payout.* in this order. B2-11y (D10-373): the
// seventeen withdraw.auto_payout.* keys follow risk.withdraw.* in this order. B2-11dz (D10-392 /
// D10-394): the four payout.auto_enable_check.* keys follow withdraw.auto_payout.* in this order.
// B1-28g (D10-419): rank.cache_ttl_seconds follows payout.auto_enable_check.*. B1-05l (D10-419
// (a)): search.hot_words and search.keyword_routes follow it in this order. B1-15zd (D10-454): the
// seven retention.* keys follow search.* in this order. B2-08cz (D10-456 ④): the three
// tax.SERVICE_FEE.* keys follow retention.* in this order. B1-05s (D10-480):
// feed.fallback_pool_id and the two pool.* keys follow tax.SERVICE_FEE.* in this order. B1-02zs:
// withdraw.dormant_reverify_days follows pool.*. B1-06ze (D10-510): the three Taobao promotion
// link keys follow it in this order. B1-04zq (D10-543): the four order_sync.rescan.* keys follow
// them in this order. B2-04zo: ledger.advance_alert_fen follows them. B2-03t (D10-605 (a)):
// tech_fee_bp and rebate.taobao.compare_rate_ratio_bp follow it in this order. B2-03u (D10-608):
// share_domains follows them. B2-03v (D10-610): bridge_origins follows it. B2-03w (D10-637):
// me.default_avatar_url follows it. B2-03x (D10-646): the six legal.labor_agreement.* /
// legal.operator_entity.* keys follow it in this order. B1-28q (D10-698): feedback.enabled and
// feedback.daily_limit_per_device follow them in this order, ending the tail.
const PAYOUT_KEYS = [
  'payout.single_cap_fen',
  'payout.daily_cap_fen',
  'payout.watermark_usable_bp',
  'payout.biz_scene',
  'payout.query_schedule',
  'payout.definite_fail_codes',
  'payout.payer_side_codes',
  'payout.query_status_map',
];
const RISK_WITHDRAW_KEYS = [
  'risk.withdraw.invalid_ratio_bp',
  'risk.withdraw.invalid_min_count',
  'risk.withdraw.high_commission_rate_bp',
  'risk.withdraw.high_commission_ratio_bp',
  'risk.withdraw.min_orders',
  'risk.withdraw.withdraw_received_ratio_bp',
];
const AUTO_PAYOUT_KEYS = [
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
];
const AUTO_ENABLE_CHECK_KEYS = [
  'payout.auto_enable_check.limits_supported',
  'payout.auto_enable_check.status_codes_supported',
  'payout.auto_enable_check.bill_out_biz_no_supported',
  'payout.auto_enable_check.recon_required_days',
];
const RANK_KEYS = ['rank.cache_ttl_seconds'];
const SEARCH_KEYS = ['search.hot_words', 'search.keyword_routes'];
const RETENTION_KEYS = [
  'retention.purge.enabled',
  'retention.login_logs_days',
  'retention.device_registrations_days',
  'retention.sms_send_attempts_days',
  'retention.inbox_messages_days',
  'retention.notify_logs_days',
  'retention.union_raw_payloads_days',
];
const TAX_KEYS = [
  'tax.SERVICE_FEE.method',
  'tax.SERVICE_FEE.rate_bp',
  'tax.SERVICE_FEE.rate_table',
];
const POOL_KEYS = ['feed.fallback_pool_id', 'pool.max_age_sec', 'pool.refresh_interval_sec'];
const REVERIFY_KEYS = ['withdraw.dormant_reverify_days'];
const PROMO_LINK_KEYS = [
  'share.taobao_enabled',
  'convert.taobao_prefetch.enabled',
  'convert.taobao_prefetch.rate_per_min',
];
const ORDER_RESCAN_KEYS = [
  'order_sync.rescan.jd.enabled',
  'order_sync.rescan.pdd.enabled',
  'order_sync.rescan.jd.days',
  'order_sync.rescan.pdd.days',
];
const ADVANCE_ALERT_KEYS = ['ledger.advance_alert_fen'];
const QUOTE_KEYS = ['tech_fee_bp', 'rebate.taobao.compare_rate_ratio_bp'];
const SHARE_KEYS = ['share_domains'];
const BRIDGE_KEYS = ['bridge_origins'];
const AVATAR_KEYS = ['me.default_avatar_url'];
const LABOR_KEYS = [
  'legal.labor_agreement.version',
  'legal.labor_agreement.text_url',
  'legal.labor_agreement.text_sha256',
  'legal.labor_agreement.resign_from_version',
  'legal.operator_entity.name',
  'legal.operator_entity.credit_code',
];
const FEEDBACK_KEYS = ['feedback.enabled', 'feedback.daily_limit_per_device'];

it('[AC-F1-02zx#2] 六项邀请奖励配置连续位于 growth 组，资格天数紧接 IP 窗口，其后紧接 payout.* 八项、risk.withdraw.* 六项、withdraw.auto_payout.* 十七项、payout.auto_enable_check.* 四项、rank.cache_ttl_seconds、search.* 两项、retention.* 七项、tax.* 三项、feed.fallback_pool_id 与 pool.* 两项', () => {
  const registry = configRegistry();
  expect(
    registry
      .filter((entry) => entry.key.startsWith('growth.invite_reward.'))
      .map((entry) => entry.key),
  ).toStrictEqual(DEFAULTS.map((row) => row.key));
  const tail = [
    ...PAYOUT_KEYS,
    ...RISK_WITHDRAW_KEYS,
    ...AUTO_PAYOUT_KEYS,
    ...AUTO_ENABLE_CHECK_KEYS,
    ...RANK_KEYS,
    ...SEARCH_KEYS,
    ...RETENTION_KEYS,
    ...TAX_KEYS,
    ...POOL_KEYS,
    ...REVERIFY_KEYS,
    ...PROMO_LINK_KEYS,
    ...ORDER_RESCAN_KEYS,
    ...ADVANCE_ALERT_KEYS,
    ...QUOTE_KEYS,
    ...SHARE_KEYS,
    ...BRIDGE_KEYS,
    ...AVATAR_KEYS,
    ...LABOR_KEYS,
    ...FEEDBACK_KEYS,
  ];
  const end = registry.length - tail.length;
  expect(registry.slice(end).map((entry) => entry.key)).toStrictEqual(tail);
  expect(registry.slice(end - 6, end).map((entry) => entry.key)).toStrictEqual(
    DEFAULTS.map((row) => row.key),
  );
  expect(registry.at(end - 2)?.key).toBe(WINDOW);
  expect(registry.at(end - 1)?.key).toBe(KEY);
});

it.each([1, 2, 30, 3649, 3650])('[AC-F1-02zx#3] 资格天数接受整数 %s', (value) => {
  const spec = configItemSpecOf(KEY);
  expect(spec, '必须先登记；缺键不能当作校验结果').not.toBeNull();
  expect(configValueFits(spec!, value)).toBe(true);
});

it.each([
  { label: '零', value: 0 },
  { label: '负数', value: -1 },
  { label: '超过十年', value: 3651 },
  { label: 'int32 上限', value: 2147483647 },
  { label: '非整数', value: 30.5 },
  { label: 'NaN', value: NaN },
  { label: '正无穷', value: Infinity },
  { label: '负无穷', value: -Infinity },
  { label: '字符串', value: '30' },
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
  { label: '布尔', value: true },
  { label: '数组', value: [] },
  { label: '对象', value: {} },
])('[AC-F1-02zx#4] 资格天数拒绝 $label', ({ value }) => {
  const spec = configItemSpecOf(KEY);
  expect(spec, '必须先登记；避免把 null 传入校验器造成 TypeError').not.toBeNull();
  expect(configValueFits(spec!, value)).toBe(false);
});

it('[AC-F1-02zx#5] 登记资格天数不扩大活动正数校验，客户端读取并下发派生天数（F1-02zze；F1-02zzf 收紧）', () => {
  expect(configItemSpecOf(KEY)).toStrictEqual(SPEC);
  expect(INVITE_REWARD_POSITIVE_KEYS).toStrictEqual([AMOUNT, DAILY, TOTAL]);
  expect(inviteRewardGuardedKey(KEY)).toBe(false);
  expect(
    inviteRewardOpenRefused(
      new Map([
        [AMOUNT, 100],
        [DAILY, 100],
        [TOTAL, 100],
      ]),
    ),
  ).toBe(false);
  // F1-02zzd: F1-02zze makes the client config read KEY and deliver invite.eligibility_days
  // (missing row: BR-INV-24 细则 30). F1-02zzf：过渡已收紧, it must read and deliver.
  expect(CLIENT_CONFIG_KEYS).toContain(KEY);
  for (const days of [undefined, 45]) {
    const values = new Map<string, unknown>([
      [ENABLED, true],
      [AMOUNT, 1000],
      ['h5_base_url', 'https://h5.example.test/'],
      ['h5_release.stable', 'stable'],
      ['kf', { url: 'https://kf.example.test/' }],
      ['legal.privacy.version', 1],
      ['legal.privacy.min_version', 1],
      ['legal.agreement.version', 1],
    ]);
    if (days !== undefined) values.set(KEY, days);
    const reports: string[] = [];
    const config = buildClientConfig({
      values,
      viewer: { appId: 'f1-02zx-client', userId: null },
      deviceId: null,
      linkPatterns: { version: '1', rules: [] },
      rankPlatforms: [],
      inviteRewardBudgetFen: 2000,
      report: {
        missing: (key) => {
          reports.push(key);
        },
        invalid: (key) => {
          reports.push(key);
        },
      },
    });
    expect(config).toBeDefined();
    const invite = {
      required: false,
      backfill_hours: 168,
      bind_phone_guide: true,
      before_buy_tip: true,
      reward_enabled: true,
      reward_amount_fen: 1000,
    };
    expect(config!.invite).toStrictEqual({ ...invite, eligibility_days: days ?? 30 });
    expect(reports).toStrictEqual([]);
  }
});
