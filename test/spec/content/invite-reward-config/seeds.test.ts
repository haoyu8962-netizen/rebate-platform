import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  configItemSpecOf,
  configValueFits,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import { CONFIGS, ENABLED, PAUSED, PREFIX } from './oracle.ts';

// F1-02zw: F1-02zx appends the BR-INV-24 细则 eligibility period seed right after the five rows as
// the last row; its value is 30 days (08 l.560), written here independently of the registry and
// the seed file. F1-02zt：过渡已收紧, the sixth row must be present.
const ELIGIBILITY = { key: `${PREFIX}eligibility_days`, value: 30 };
// B2-06bz (D10-244 ②、D10-296): the eight payout.* seed rows follow eligibility_days, in
// registration order, and nothing else (values are not this test's concern; each must fit its spec,
// checked below with the other extra rows). B2-11z (D10-368): the six risk.withdraw.* rows follow
// payout.* in registration order, under the same checks. B2-11y (D10-373): the seventeen
// withdraw.auto_payout.* rows follow risk.withdraw.* in registration order, under the same checks.
// B2-11dz (D10-392 / D10-394): the three payout.auto_enable_check.* boolean rows follow
// withdraw.auto_payout.* in registration order, under the same checks; recon_required_days is
// unset by default and has no seed row. B1-28g (D10-419): the rank.cache_ttl_seconds row follows
// payout.auto_enable_check.* in registration order, under the same checks. B1-05l (D10-419 (a)):
// the search.hot_words and search.keyword_routes rows follow it in registration order, under the
// same checks, each seeded as an empty list (no invented hot words or routes). B1-15zd (D10-454):
// the seven retention.* rows follow search.* in registration order, under the same checks, with
// the master switch on and the BR-ID-30 days of 08. B2-08cz (D10-456 ④): the three
// tax.SERVICE_FEE.* rows follow retention.* in registration order, under the same checks, seeded
// as BR-WDR-20 细则 reads before the rate table is in force: method none, rate 0 bp, empty table.
// B1-05s (D10-480): the two pool.* rows follow tax.SERVICE_FEE.* in registration order, under the
// same checks, seeded with the BR-PRICE-11 values; feed.fallback_pool_id is unset by default and
// has no seed row. B1-02zs: the withdraw.dormant_reverify_days row follows pool.*, under the same
// checks, seeded 0 (old-account re-verification off until the re-verification pages ship).
// B1-06ze (D10-510): the three Taobao promotion link keys are unset by default and have no seed
// rows. B1-04zq (D10-543): nor have the four order_sync.rescan.* keys. B2-04zo (BR-FUND-20 细则):
// ledger.advance_alert_fen is unset by default and has no seed row (the super admin fills it in).
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
const AUTO_ENABLE_CHECK_SEEDED_KEYS = [
  'payout.auto_enable_check.limits_supported',
  'payout.auto_enable_check.status_codes_supported',
  'payout.auto_enable_check.bill_out_biz_no_supported',
];
const RANK_KEYS = ['rank.cache_ttl_seconds'];
const SEARCH_KEYS = ['search.hot_words', 'search.keyword_routes'];
const RETENTION_SEEDS = [
  { key: 'retention.purge.enabled', value: true },
  { key: 'retention.login_logs_days', value: 180 },
  { key: 'retention.device_registrations_days', value: 180 },
  { key: 'retention.sms_send_attempts_days', value: 190 },
  { key: 'retention.inbox_messages_days', value: 180 },
  { key: 'retention.notify_logs_days', value: 190 },
  { key: 'retention.union_raw_payloads_days', value: 180 },
];
const RETENTION_KEYS = RETENTION_SEEDS.map((row) => row.key);
const TAX_SEEDS = [
  { key: 'tax.SERVICE_FEE.method', value: 'none' },
  { key: 'tax.SERVICE_FEE.rate_bp', value: 0 },
  { key: 'tax.SERVICE_FEE.rate_table', value: [] },
];
const TAX_KEYS = TAX_SEEDS.map((row) => row.key);
const POOL_SEEDS = [
  { key: 'pool.max_age_sec', value: 7200 },
  { key: 'pool.refresh_interval_sec', value: 3600 },
];
const POOL_KEYS = POOL_SEEDS.map((row) => row.key);
const REVERIFY_SEEDS = [{ key: 'withdraw.dormant_reverify_days', value: 0 }];
const REVERIFY_KEYS = REVERIFY_SEEDS.map((row) => row.key);
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
const ADVANCE_ALERT_KEY = 'ledger.advance_alert_fen';

it('[AC-F1-02zn#6] BR-INV-24 种子为 1000/0/0/0/24，开关缺行默认 off；重跑不覆盖', () => {
  const sql = readFileSync(
    new URL('../../../../db/seeds/0001_config-defaults.sql', import.meta.url),
    'utf8',
  );
  const rows = [...sql.matchAll(/\('couli',\s*'([^']+)',\s*'([^']*)'::jsonb/g)].map((match) => ({
    key: match[1]!,
    value: JSON.parse(match[2]!) as unknown,
  }));
  const five = CONFIGS.map((row) => ({ key: row.key, value: row.seed }));
  expect(rows.filter((row) => row.key.startsWith(PREFIX))).toStrictEqual([...five, ELIGIBILITY]);
  const i = rows.findIndex((row) => row.key === 'settle.statement.grace_days');
  expect(i).toBeGreaterThanOrEqual(0);
  expect(rows.slice(i, i + 6).map((row) => row.key)).toStrictEqual([
    'settle.statement.grace_days',
    ...CONFIGS.map((row) => row.key),
  ]);
  const extra = rows.slice(i + 6);
  expect(extra[0]).toStrictEqual(ELIGIBILITY);
  expect(extra.map((row) => row.key)).toStrictEqual([
    ELIGIBILITY.key,
    ...PAYOUT_KEYS,
    ...RISK_WITHDRAW_KEYS,
    ...AUTO_PAYOUT_KEYS,
    ...AUTO_ENABLE_CHECK_SEEDED_KEYS,
    ...RANK_KEYS,
    ...SEARCH_KEYS,
    ...RETENTION_KEYS,
    ...TAX_KEYS,
    ...POOL_KEYS,
    ...REVERIFY_KEYS,
  ]);
  for (const key of SEARCH_KEYS) {
    expect(
      rows.filter((row) => row.key === key),
      key,
    ).toStrictEqual([{ key, value: [] }]);
  }
  expect(rows.filter((row) => RETENTION_KEYS.includes(row.key))).toStrictEqual(RETENTION_SEEDS);
  expect(rows.filter((row) => TAX_KEYS.includes(row.key))).toStrictEqual(TAX_SEEDS);
  expect(rows.filter((row) => POOL_KEYS.includes(row.key))).toStrictEqual(POOL_SEEDS);
  expect(rows.filter((row) => REVERIFY_KEYS.includes(row.key))).toStrictEqual(REVERIFY_SEEDS);
  expect(rows.some((row) => row.key === 'feed.fallback_pool_id')).toBe(false);
  expect(rows.some((row) => row.key === ADVANCE_ALERT_KEY)).toBe(false);
  expect(sql).not.toContain(ADVANCE_ALERT_KEY);
  for (const key of [...PROMO_LINK_KEYS, ...ORDER_RESCAN_KEYS]) {
    expect(
      rows.some((row) => row.key === key),
      key,
    ).toBe(false);
  }
  for (const row of CONFIGS) {
    const spec = configItemSpecOf(row.key);
    expect(spec, row.key).not.toBeNull();
    expect(configValueFits(spec!, rows.find((entry) => entry.key === row.key)?.value)).toBe(true);
  }
  for (const row of extra) {
    const spec = configItemSpecOf(row.key);
    expect(spec, row.key).not.toBeNull();
    expect(configValueFits(spec!, row.value), row.key).toBe(true);
  }
  expect(rows.some((row) => row.key === ENABLED || row.key === PAUSED)).toBe(false);
  // Check the INSERT containing each new row, not an unrelated batch's ON CONFLICT.
  for (const row of [...CONFIGS, ...extra]) {
    const statement = sql.split(';').find((part) => part.includes(`'${row.key}'`));
    expect(statement).toMatch(/ON\s+CONFLICT\s*(?:\(\s*app_id\s*,\s*key\s*\))?\s+DO\s+NOTHING/iu);
  }
});

it('[AC-F1-02zn#18] 种子：payout.auto_enable_check.* 三项支持状态缺省 false（重跑不覆盖）；recon_required_days 与 recon_passed_days 没有种子行，全文不含 recon_passed_days（B2-11dzb，D10-400）', () => {
  const sql = readFileSync(
    new URL('../../../../db/seeds/0001_config-defaults.sql', import.meta.url),
    'utf8',
  );
  const rows = [...sql.matchAll(/\('couli',\s*'([^']+)',\s*'([^']*)'::jsonb/g)].map((match) => ({
    key: match[1]!,
    value: JSON.parse(match[2]!) as unknown,
  }));
  for (const key of AUTO_ENABLE_CHECK_SEEDED_KEYS) {
    expect(
      rows.filter((row) => row.key === key),
      key,
    ).toStrictEqual([{ key, value: false }]);
    const statement = sql.split(';').find((part) => part.includes(`'${key}'`));
    expect(statement, key).toMatch(
      /ON\s+CONFLICT\s*(?:\(\s*app_id\s*,\s*key\s*\))?\s+DO\s+NOTHING/iu,
    );
  }
  const required = 'payout.auto_enable_check.recon_required_days';
  const retired = 'payout.auto_enable_check.recon_passed_days';
  expect(rows.some((row) => row.key === required)).toBe(false);
  expect(rows.some((row) => row.key === retired)).toBe(false);
  expect(sql).not.toContain(retired);
});
