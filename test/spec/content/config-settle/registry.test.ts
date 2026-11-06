import { expect, it } from 'vitest';
import {
  configItemSpecOf,
  configRegistry,
  configValueFits,
  type ConfigItemSpec,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import { EXPECTED, INVITE_CFG, inviteNow, presentOf } from '../config-items/kit.ts';
import { SETTLE } from './oracle.ts';

function registered(key: string): ConfigItemSpec {
  const found = configItemSpecOf(key);
  // Fail missing registration as an assertion, before calling configValueFits.
  expect(found, key).not.toBeNull();
  return found!;
}

it.each(SETTLE)('[AC-F1-02zj#1] BR-FUND-04：$key 的类型、选项、权限及整数范围', (expected) => {
  const actual = registered(expected.key);
  expect(actual).toStrictEqual(expected);
  expect(configRegistry().filter((entry) => entry.key === expected.key)).toStrictEqual([actual]);
});

it('[AC-F1-02zj#2] 16 项按裁定顺序追加；原 29 项及其无 range 行为保持不变', () => {
  const registry = configRegistry();
  // F1-02zv / F1-02zw: the CT-25 invite reward group inviteNow() (F1-02zn's five keys followed by
  // F1-02zx's growth.invite_reward.eligibility_days) follows SETTLE; nothing else may follow.
  // F1-02zt：过渡已收紧, the group must be present. B2-06bz (D10-244 ②、D10-296): the eight
  // payout.* keys follow the invite group, in this order; B2-11z (D10-368): then the six
  // risk.withdraw.* keys, in this order; B2-11y (D10-373): then the seventeen
  // withdraw.auto_payout.* keys, in this order; B2-11dz (D10-392 / D10-394): then the four
  // payout.auto_enable_check.* keys, in this order; B1-28g (D10-419): then
  // rank.cache_ttl_seconds; B1-05l (D10-419 (a)): then search.hot_words and
  // search.keyword_routes, in this order; B1-15zd (D10-454): then the seven retention.* keys, in
  // this order; B2-08cz (D10-456 ④): then the three tax.SERVICE_FEE.* keys, in this order; B1-05s
  // (D10-480): then feed.fallback_pool_id and the two pool.* keys, in this order; B1-02zs: then
  // withdraw.dormant_reverify_days; B1-06ze (D10-510): then the three Taobao promotion link keys,
  // in this order; B1-04zq (D10-543): then the four order_sync.rescan.* keys, in this order;
  // B2-04zo: then ledger.advance_alert_fen; B2-03t (D10-605 (a)): then tech_fee_bp and
  // rebate.taobao.compare_rate_ratio_bp, in this order; B2-03u (D10-608): then share_domains;
  // B2-03v (D10-610): then bridge_origins; B2-03w (D10-637): then me.default_avatar_url; B2-03x
  // (D10-646): then the six legal.labor_agreement.* / legal.operator_entity.* keys, in this order;
  // B1-28q (D10-698): then feedback.enabled and feedback.daily_limit_per_device, in this order;
  // B2-12e (D10-590): then ledger.bad_debt_days and ledger.bad_debt_min_fen, in this order;
  // nothing else may follow.
  presentOf(INVITE_CFG, 'growth.invite_reward.*');
  const invite = inviteNow();
  expect(registry.map((entry) => entry.key)).toStrictEqual([
    ...EXPECTED.map((entry) => entry.key),
    ...SETTLE.map((entry) => entry.key),
    ...invite.map((entry) => entry.key),
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
    'legal.labor_agreement.version',
    'legal.labor_agreement.text_url',
    'legal.labor_agreement.text_sha256',
    'legal.labor_agreement.resign_from_version',
    'legal.operator_entity.name',
    'legal.operator_entity.credit_code',
    'feedback.enabled',
    'feedback.daily_limit_per_device',
    'ledger.bad_debt_days',
    'ledger.bad_debt_min_fen',
  ]);
  expect(registry.slice(0, 29)).toStrictEqual(
    EXPECTED.map((entry) => ({ ...entry, options: null })),
  );
  for (const expected of EXPECTED) {
    const spec = registered(expected.key);
    if (expected.valueType !== 'number') continue;
    // Extending number validation must not add business bounds or integer checks to old keys.
    for (const value of [-1, 0, 0.5, 24.5, 2147483648, Number.MAX_VALUE]) {
      expect(configValueFits(spec, value), `${spec.key}: ${value}`).toBe(true);
    }
    for (const value of [NaN, Infinity, -Infinity, '24', null, true, [], {}]) {
      expect(configValueFits(spec, value), spec.key).toBe(false);
    }
  }
});

it.each(SETTLE)('[AC-F1-02zj#3] $key 的共享登记、range 与 enum options 均冻结', (expected) => {
  const actual = registered(expected.key);
  expect(Object.isFrozen(configRegistry())).toBe(true);
  expect(Object.isFrozen(actual)).toBe(true);
  if (expected.range !== undefined) {
    const range: unknown = Reflect.get(actual, 'range');
    expect(range).toStrictEqual(expected.range);
    expect(Object.isFrozen(range)).toBe(true);
  }
  if (expected.options !== null) {
    expect(actual.options).toStrictEqual(expected.options);
    expect(Object.isFrozen(actual.options)).toBe(true);
  }
});

it.each(SETTLE.filter((entry) => entry.valueType === 'number'))(
  '[AC-F1-02zj#4] $key 拒绝非整数、类型转换和越界；接受闭区间两端',
  (expected) => {
    const spec = registered(expected.key);
    const { min, max } = expected.range!;
    for (const value of [min, min + 1, max - 1, max]) {
      expect(configValueFits(spec, value), `${spec.key}: ${value}`).toBe(true);
    }
    for (const value of [
      min - 1,
      max + 1,
      -1,
      min + 0.5,
      max - 0.5,
      NaN,
      Infinity,
      -Infinity,
      String(min),
      '24',
      null,
      undefined,
      true,
      false,
      [min],
      { value: min },
    ]) {
      expect(configValueFits(spec, value), `${spec.key}: ${String(value)}`).toBe(false);
    }
  },
);

it.each(SETTLE.filter((entry) => entry.valueType === 'enum'))(
  '[AC-F1-02zj#5] $key 仅接受对应的精确枚举字符串',
  (expected) => {
    const spec = registered(expected.key);
    for (const value of expected.options!) expect(configValueFits(spec, value)).toBe(true);
    const invalid = [
      'settled_at',
      'RECEIVED_AT',
      'API',
      'UPLOAD',
      '',
      ' api',
      'received_at\n',
      null,
      0,
      true,
      ['api'],
      { value: 'received_at' },
      ...(expected.options!.includes('api') ? ['received_at'] : ['api', 'upload']),
    ];
    for (const value of invalid) expect(configValueFits(spec, value), spec.key).toBe(false);
  },
);

it('[AC-F1-02zj#6] 仅登记四个平台的字面键；无后缀、错大小写及旧 wait_days 均查不到', () => {
  for (const platform of ['taobao', 'jd', 'pdd', 'meituan']) {
    expect(registered(`settle.period_basis.${platform}`).valueType).toBe('enum');
  }
  for (const key of [
    'settle.period_basis',
    'settle.period_basis.vip',
    'settle.period_basis.TAOBAO',
    'settle.period_basis.<platform>',
    'settle.period_basis.taobao.extra',
    'settle.statement_source.vip',
    'settle.period_offset_months.vip',
    'settle.bill_day.taobao',
    'settle.wait_days.taobao',
  ]) {
    expect(configItemSpecOf(key), key).toBeNull();
    expect(
      configRegistry().some((entry) => entry.key === key),
      key,
    ).toBe(false);
  }
});

it('[AC-F1-02zj#14] number 校验使用传入的 range；没有 range 时维持有限数语义', () => {
  // Structural typing keeps this red-stage test compilable before ConfigItemSpec gains range.
  const spec: ConfigItemSpec & {
    readonly range: { readonly integer: true; readonly min: number; readonly max: number };
  } = {
    key: 'test.number',
    valueType: 'number',
    options: null,
    permission: 'config.business',
    adminEditable: true,
    range: { integer: true, min: 2, max: 5 },
  };
  for (const value of [1, 6, 2.5]) expect(configValueFits(spec, value)).toBe(false);
  for (const value of [2, 3, 5]) expect(configValueFits(spec, value)).toBe(true);
  const withoutRange: ConfigItemSpec = {
    key: spec.key,
    valueType: spec.valueType,
    options: null,
    permission: spec.permission,
    adminEditable: true,
  };
  for (const value of [-1, 2.5, 2147483648]) {
    expect(configValueFits(withoutRange, value)).toBe(true);
  }
});
