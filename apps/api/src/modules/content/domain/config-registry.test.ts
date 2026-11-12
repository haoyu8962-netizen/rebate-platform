import { expect, it } from 'vitest';
import { configItemSpecOf, configRegistry, configValueFits } from './config-registry.ts';

const SETTLE_KEYS = [
  'settle.bill_day',
  'settle.period_basis.taobao',
  'settle.period_basis.jd',
  'settle.period_basis.pdd',
  'settle.period_basis.meituan',
  'settle.statement_source.taobao',
  'settle.statement_source.jd',
  'settle.statement_source.pdd',
  'settle.statement_source.meituan',
  'settle.batch.match_tolerance_fen',
  'settle.batch.max_orders',
  'settle.period_offset_months.taobao',
  'settle.period_offset_months.jd',
  'settle.period_offset_months.pdd',
  'settle.period_offset_months.meituan',
  'settle.statement.grace_days',
];

function spec(key: string) {
  const found = configItemSpecOf(key);
  expect(found, key).not.toBeNull();
  return found!;
}

it('[AC-F1-02zj#2] settle.* items are appended after the 29 earlier items, editable config.business', () => {
  const registry = configRegistry();
  expect(registry).toHaveLength(176);
  expect(registry[28]!.key).toBe('external_hosts');
  expect(registry.slice(29, 45).map((entry) => entry.key)).toStrictEqual(SETTLE_KEYS);
  for (const entry of registry.slice(29, 45)) {
    expect(entry.permission).toBe('config.business');
    expect(entry.adminEditable).toBe(true);
  }
  for (const entry of registry.slice(0, 29)) expect('range' in entry, entry.key).toBe(false);
});

it('[AC-F1-02zj#4] settle.bill_day accepts integers 22..28 only', () => {
  const billDay = spec('settle.bill_day');
  for (const value of [22, 24, 28]) expect(configValueFits(billDay, value)).toBe(true);
  for (const value of [21, 29, 24.5, '24', null, Number.NaN]) {
    expect(configValueFits(billDay, value)).toBe(false);
  }
});

it('[AC-F1-02zj#4] lower-bounded settle.* integers stop at the int4 maximum', () => {
  const maxOrders = spec('settle.batch.max_orders');
  expect(configValueFits(maxOrders, 0)).toBe(false);
  expect(configValueFits(maxOrders, 1)).toBe(true);
  expect(configValueFits(maxOrders, 2147483647)).toBe(true);
  expect(configValueFits(maxOrders, 2147483648)).toBe(false);
  const tolerance = spec('settle.batch.match_tolerance_fen');
  expect(configValueFits(tolerance, 0)).toBe(true);
  expect(configValueFits(tolerance, -1)).toBe(false);
  expect(configValueFits(tolerance, 0.5)).toBe(false);
  expect(configValueFits(spec('settle.period_offset_months.pdd'), -1)).toBe(false);
  expect(configValueFits(spec('settle.statement.grace_days'), 0)).toBe(true);
});

it('[AC-F1-02zj#5] settle.* enum items accept their exact options only', () => {
  const basis = spec('settle.period_basis.jd');
  expect(basis.options).toStrictEqual(['received_at']);
  expect(configValueFits(basis, 'received_at')).toBe(true);
  expect(configValueFits(basis, 'settled_at')).toBe(false);
  const source = spec('settle.statement_source.meituan');
  expect(configValueFits(source, 'api')).toBe(true);
  expect(configValueFits(source, 'upload')).toBe(true);
  expect(configValueFits(source, 'API')).toBe(false);
  expect(configValueFits(source, '')).toBe(false);
});

it('[AC-F1-02zj#6] lookups are literal: no pattern, suffix-less or removed keys', () => {
  for (const key of [
    'settle.period_basis',
    'settle.period_basis.vip',
    'settle.period_basis.TAOBAO',
    'settle.bill_day.taobao',
    'settle.wait_days.taobao',
  ]) {
    expect(configItemSpecOf(key), key).toBeNull();
  }
});

it('[AC-F1-02zj#2] number items without a range keep the finite-number check', () => {
  const sample = spec('external_page.nav_host_sample_bp');
  for (const value of [-1, 0.5, 2147483648]) expect(configValueFits(sample, value)).toBe(true);
  expect(configValueFits(sample, Number.POSITIVE_INFINITY)).toBe(false);
});

it('[AC-F1-02zn#2] growth.invite_reward.* items follow SETTLE as editable integers', () => {
  expect(
    configRegistry()
      .slice(45, 51)
      .map((entry) => [entry.key, entry.permission, entry.range?.min, entry.adminEditable]),
  ).toStrictEqual([
    ['growth.invite_reward.amount_fen', 'config.business', 0, true],
    ['growth.invite_reward.daily_budget_fen', 'config.business', 0, true],
    ['growth.invite_reward.total_budget_fen', 'config.business', 0, true],
    ['growth.invite_reward.min_paid_fen', 'config.business', 0, true],
    ['growth.invite_reward.ip_window_hours', 'config.risk', 1, true],
    ['growth.invite_reward.eligibility_days', 'config.business', 1, true],
  ]);
  const window = spec('growth.invite_reward.ip_window_hours');
  expect(configValueFits(window, 0)).toBe(false);
  expect(configValueFits(window, 24)).toBe(true);
  expect(configValueFits(spec('growth.invite_reward.amount_fen'), 2147483648)).toBe(false);
});

it('[AC-F1-02zx#1] growth.invite_reward.eligibility_days is the last item, whole days 1 to 3650', () => {
  const registry = configRegistry();
  // B2-06b (D10-244 ②): the eight payout.* keys follow growth.*; the growth group ends at index 50.
  expect(registry[50]!.key).toBe('growth.invite_reward.eligibility_days');
  expect(registry[49]!.key).toBe('growth.invite_reward.ip_window_hours');
  const days = spec('growth.invite_reward.eligibility_days');
  expect(days).toStrictEqual({
    key: 'growth.invite_reward.eligibility_days',
    valueType: 'number',
    options: null,
    permission: 'config.business',
    adminEditable: true,
    range: { integer: true, min: 1, max: 3650 },
  });
  for (const value of [1, 30, 3650]) expect(configValueFits(days, value), String(value)).toBe(true);
  for (const value of [0, 3651, 30.5, '30', Number.NaN]) {
    expect(configValueFits(days, value), String(value)).toBe(false);
  }
});

// B1-22y (D10-1306 / D10-1307): the Agent keys, appended last in this order, all editable.
const AGENT_A10: readonly (readonly [string, string, string, unknown])[] = [
  ['agent.member_daily_quota', 'number', 'config.risk', [0, 2147483647]],
  ['agent.guest_daily_quota', 'number', 'config.risk', [0, 2147483647]],
  ['agent.guest_ip_daily_quota', 'number', 'config.risk', [0, 2147483647]],
  ['agent.explain_order.order_no_daily_max', 'number', 'config.risk', [1, 2147483647]],
  ['agent.whitelist_user_ids', 'object', 'config.risk', null],
  ['agent.safety.block_level.input', 'enum', 'config.risk', ['low', 'medium', 'high']],
  ['agent.safety.block_level.output', 'enum', 'config.risk', ['low', 'medium', 'high']],
  ['legal.ai_third_party.version', 'number', 'config.risk', [1, 2147483647]],
  ['agent.result_check.provider', 'enum', 'config.risk', ['rules', 'jev']],
  ['agent.guard.buffer_max_chars', 'number', 'config.risk', [1, 2147483647]],
  ['agent.safety.timeout_ms', 'number', 'config.risk', [1, 2147483647]],
  ['agent.daily_budget_fen', 'number', 'config.business', [0, 2147483647]],
  ['agent.budget.reserve_mfen_per_run', 'number', 'config.business', [0, 2147483647]],
  ['agent.context.max_turns', 'number', 'config.general', [0, 2147483647]],
  ['agent.context.max_chars', 'number', 'config.general', [1, 2147483647]],
  ['agent.orders.default_span_days', 'number', 'config.general', [1, 2147483647]],
  ['agent.orders.max_span_days', 'number', 'config.general', [1, 2147483647]],
  ['agent.model_timeout_ms', 'number', 'config.general', [1, 2147483647]],
  ['agent.search_cache_ttl_s', 'number', 'config.general', [0, 300]],
  ['agent.rag.min_score', 'number', 'config.general', null],
  ['agent.guest_login_to_view.taobao', 'boolean', 'config.general', null],
  ['agent.guest_login_to_view.jd', 'boolean', 'config.general', null],
  ['agent.guest_login_to_view.pdd', 'boolean', 'config.general', null],
  ['agent.require_phone', 'boolean', 'config.risk', null],
  ['agent.filing_text', 'string', 'config.general', null],
  ['agent.examples', 'object', 'config.general', null],
];

it('[AC-B1-22y#1] the Agent keys are the last 26 items, editable, with their type, point and bounds or options', () => {
  const registry = configRegistry();
  expect(registry.slice(-AGENT_A10.length).map((entry) => entry.key)).toStrictEqual(
    AGENT_A10.map(([key]) => key),
  );
  for (const [key, valueType, permission, extra] of AGENT_A10) {
    const entry = spec(key);
    expect([entry.valueType, entry.permission, entry.adminEditable], key).toStrictEqual([
      valueType,
      permission,
      true,
    ]);
    if (valueType === 'enum') {
      expect(entry.options, key).toStrictEqual(extra);
    } else {
      expect(entry.options, key).toBeNull();
    }
    if (valueType === 'number' && extra !== null) {
      const [min, max] = extra as [number, number];
      expect(entry.range, key).toStrictEqual({ integer: true, min, max });
    } else {
      expect('range' in entry, key).toBe(false);
    }
  }
});

it('[AC-B1-22y#2] Agent key values: integer bounds, enum options, the 0..300 cache cap, arrays as objects', () => {
  expect(configValueFits(spec('agent.guest_daily_quota'), 0)).toBe(true);
  expect(configValueFits(spec('agent.guest_daily_quota'), -1)).toBe(false);
  expect(configValueFits(spec('agent.guest_daily_quota'), 2.5)).toBe(false);
  expect(configValueFits(spec('agent.guest_daily_quota'), '3')).toBe(false);
  expect(configValueFits(spec('agent.safety.timeout_ms'), 0)).toBe(false);
  expect(configValueFits(spec('agent.context.max_turns'), 0)).toBe(true);
  expect(configValueFits(spec('agent.search_cache_ttl_s'), 300)).toBe(true);
  expect(configValueFits(spec('agent.search_cache_ttl_s'), 301)).toBe(false);
  expect(configValueFits(spec('agent.safety.block_level.input'), 'medium')).toBe(true);
  expect(configValueFits(spec('agent.safety.block_level.output'), 'none')).toBe(false);
  expect(configValueFits(spec('agent.result_check.provider'), 'jev')).toBe(true);
  expect(configValueFits(spec('agent.result_check.provider'), 'model')).toBe(false);
  expect(configValueFits(spec('agent.rag.min_score'), 0.2)).toBe(true);
  expect(configValueFits(spec('agent.whitelist_user_ids'), ['u1'])).toBe(true);
  expect(configValueFits(spec('agent.whitelist_user_ids'), 'u1')).toBe(false);
  expect(configValueFits(spec('agent.filing_text'), '')).toBe(true);
  expect(configValueFits(spec('agent.require_phone'), 'true')).toBe(false);
});
