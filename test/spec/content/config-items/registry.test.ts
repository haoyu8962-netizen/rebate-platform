// F1-10e ruling 14: the configuration item registry (content/domain, pure data, disjoint from the
// emergency switch registry). Oracle in ./kit.ts (EXPECTED) and the seed file itself.
// F1-02zi / F1-02zm / F1-02zw: #1 compares with expectedNow() (EXPECTED + the BR-FUND-04 settle.*
// group of F1-02zj + the BR-INV-24 growth.invite_reward.* group of F1-02zn / F1-02zx), #3 reads an
// enum item's seed as a JSON string, #56 pins SETTLE, #57 the five invite reward keys and #58
// growth.invite_reward.eligibility_days right after ip_window_hours. F1-02zt：过渡已收紧, every group present.
// B2-06bz (D10-244 ②、D10-296): the eight payout.* keys follow the growth group (kit PAYOUT).
// B2-11z (D10-368): the six risk.withdraw.* keys follow payout.* (kit RISK_WITHDRAW).
// B2-11y (D10-373): the seventeen withdraw.auto_payout.* keys follow risk.withdraw.* (kit
// AUTO_PAYOUT).
// B2-11dz (D10-392 / D10-394): the four payout.auto_enable_check.* keys follow withdraw.auto_payout.* (kit
// AUTO_ENABLE_CHECK); recon_required_days is unset by default and has no seed row
// (AUTO_ENABLE_UNSEEDED).
// B1-28g (D10-419): rank.cache_ttl_seconds follows payout.auto_enable_check.* (kit RANK).
// B1-05l (D10-419 (a)): search.hot_words and search.keyword_routes follow it (kit SEARCH).
// B1-15zd (D10-454, BR-ID-30): the seven retention.* keys follow search.* (kit RETENTION).
// B2-08cz (D10-456 ④, BR-WDR-20): the three tax.SERVICE_FEE.* keys follow retention.* (kit TAX).
// B1-05s (D10-480): feed.fallback_pool_id and the two pool.* keys follow tax.SERVICE_FEE.* (kit
// POOL); feed.fallback_pool_id is unset by default and has no seed row (POOL_UNSEEDED).
// B1-02zs (BR-WDR-01 细则): withdraw.dormant_reverify_days follows pool.* (kit REVERIFY).
// B1-06ze (D10-510): the three Taobao promotion link keys follow it (kit PROMO_LINK), unset by
// default with no seed rows (PROMO_LINK_UNSEEDED).
// B1-04zq (D10-543): the four order_sync.rescan.* keys follow them (kit ORDER_RESCAN), unset by
// default with no seed rows (ORDER_RESCAN_UNSEEDED).
// B2-04zo (BR-FUND-20 细则): ledger.advance_alert_fen follows them (kit ADVANCE_ALERT), unset by
// default with no seed row (ADVANCE_ALERT_UNSEEDED).
// B2-03t (D10-605 (a)): tech_fee_bp and rebate.taobao.compare_rate_ratio_bp follow it (kit QUOTE),
// unset by default with no seed rows (QUOTE_UNSEEDED).
// B2-03u (D10-608): share_domains follows them (kit SHARE), unset by default with no seed row
// (SHARE_UNSEEDED).
// B2-03v (D10-610): bridge_origins follows it (kit BRIDGE), unset by default with no seed row
// (BRIDGE_UNSEEDED).
// B2-03w (D10-637): me.default_avatar_url follows it (kit AVATAR), unset by default with no seed
// row (AVATAR_UNSEEDED).
import { expect, it } from 'vitest';
import {
  configItemSpecOf,
  configRegistry,
  configValueFits,
  type ConfigItemSpec,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import {
  switchRegistry,
  switchSpecOf,
} from '../../../../apps/api/src/modules/content/domain/switch-registry.ts';
import {
  ADVANCE_ALERT,
  ADVANCE_ALERT_UNSEEDED,
  AUTO_ENABLE_CHECK,
  AUTO_ENABLE_UNSEEDED,
  AUTO_PAYOUT,
  AVATAR,
  AVATAR_UNSEEDED,
  BRIDGE,
  BRIDGE_UNSEEDED,
  EXPECTED,
  FUND_FLAGS,
  INVITE_CFG,
  INVITE_ELIG,
  ORDER_RESCAN,
  ORDER_RESCAN_UNSEEDED,
  PAYOUT,
  POOL,
  POOL_UNSEEDED,
  PROMO_LINK,
  PROMO_LINK_UNSEEDED,
  QUOTE,
  QUOTE_UNSEEDED,
  RANK,
  RETENTION,
  REVERIFY,
  RISK_WITHDRAW,
  SEARCH,
  SETTLE,
  SHARE,
  SHARE_UNSEEDED,
  TAX,
  UNREGISTERED,
  expectedNow,
  inviteNow,
  jsonTypeOf,
  presentOf,
  seedRows,
} from './kit.ts';

const sorted = <T>(items: readonly T[]): T[] => [...items].sort();
const EXTRA = ['agent.page_guide.routes', 'external_hosts'];

function registered(key: string): ConfigItemSpec {
  const found = configRegistry().filter((spec) => spec.key === key);
  expect(found, key).toHaveLength(1);
  return found[0]!;
}

it('[AC-F1-10e#1] 裁定 14：注册表恰好是种子里全部非开关键加 agent.page_guide.routes、external_hosts，不多不少不重复', () => {
  const keys = configRegistry().map((spec) => spec.key);
  expect(new Set(keys).size).toBe(keys.length);
  const seeds = [...seedRows().keys()];
  expect(seeds.length).toBeGreaterThan(0);
  const fromSeeds = seeds.filter((key) => switchSpecOf(key) === null);
  // B2-11dz: + the registered keys 08 leaves unset (no seed row), and only those.
  // B1-05s: + the fall-back pool, unset by default (D10-480).
  // B1-06ze: + the three Taobao promotion link keys, unset by default (D10-510).
  // B1-04zq: + the four order_sync.rescan.* keys, unset by default (D10-543).
  // B2-04zo: + the advance alert threshold, unset by default (BR-FUND-20 细则).
  expect(sorted(keys)).toStrictEqual(
    sorted([
      ...new Set([
        ...fromSeeds,
        ...EXTRA,
        ...AUTO_ENABLE_UNSEEDED,
        ...POOL_UNSEEDED,
        ...PROMO_LINK_UNSEEDED,
        ...ORDER_RESCAN_UNSEEDED,
        ...ADVANCE_ALERT_UNSEEDED,
        ...QUOTE_UNSEEDED,
        ...SHARE_UNSEEDED,
        ...BRIDGE_UNSEEDED,
        ...AVATAR_UNSEEDED,
      ]),
    ]),
  );
  for (const key of [
    ...AUTO_ENABLE_UNSEEDED,
    ...POOL_UNSEEDED,
    ...PROMO_LINK_UNSEEDED,
    ...ORDER_RESCAN_UNSEEDED,
    ...ADVANCE_ALERT_UNSEEDED,
    ...QUOTE_UNSEEDED,
    ...SHARE_UNSEEDED,
    ...BRIDGE_UNSEEDED,
    ...AVATAR_UNSEEDED,
  ]) {
    expect(seeds, key).not.toContain(key);
  }
  // F1-02zt：过渡已收紧: EXPECTED + settle.* + growth.invite_reward.* + payout.* (B2-06bz)
  // + risk.withdraw.* (B2-11z) + withdraw.auto_payout.* (B2-11y)
  // + payout.auto_enable_check.* (B2-11dz) + rank.cache_ttl_seconds (B1-28g)
  // + search.hot_words / search.keyword_routes (B1-05l) + retention.* (B1-15zd)
  // + tax.SERVICE_FEE.* (B2-08cz) + feed.fallback_pool_id / pool.* (B1-05s)
  // + withdraw.dormant_reverify_days (B1-02zs) + the Taobao promotion link keys (B1-06ze)
  // + the order_sync.rescan.* keys (B1-04zq) + ledger.advance_alert_fen (B2-04zo), all present.
  expect(sorted(keys)).toStrictEqual(
    sorted(
      [
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
      ].map((entry) => entry.key),
    ),
  );
});

it.each(EXPECTED.map((entry) => [entry.key, entry] as const))(
  '[AC-F1-10e#2] 裁定 14 逐键：%s 的值类型、权限点、可改标记，options 为 null',
  (key, entry) => {
    const spec = registered(key);
    expect({
      key: spec.key,
      valueType: spec.valueType,
      options: spec.options,
      permission: spec.permission,
      adminEditable: spec.adminEditable,
    }).toStrictEqual({ ...entry, options: null });
    expect(configItemSpecOf(key)).toStrictEqual(spec);
  },
);

it('[AC-F1-10e#3] 裁定 14：值类型取种子值的 JSON 类型（数组记 object）', () => {
  const seeds = seedRows();
  let checked = 0;
  for (const spec of configRegistry()) {
    if (!seeds.has(spec.key)) continue;
    // F1-02zi: an enum item's seed is a JSON string (EXPECTED has no enum).
    const seedType = spec.valueType === 'enum' ? 'string' : spec.valueType;
    expect(seedType, spec.key).toBe(jsonTypeOf(seeds.get(spec.key)));
    checked += 1;
  }
  // agent.page_guide.routes has no seed row; B2-11dz: neither have AUTO_ENABLE_UNSEEDED;
  // B1-05s: nor POOL_UNSEEDED; B1-06ze: nor PROMO_LINK_UNSEEDED; B1-04zq: nor
  // ORDER_RESCAN_UNSEEDED; B2-04zo: nor ADVANCE_ALERT_UNSEEDED.
  expect(checked).toBe(
    configRegistry().length -
      1 -
      AUTO_ENABLE_UNSEEDED.length -
      POOL_UNSEEDED.length -
      PROMO_LINK_UNSEEDED.length -
      ORDER_RESCAN_UNSEEDED.length -
      ADVANCE_ALERT_UNSEEDED.length -
      QUOTE_UNSEEDED.length -
      SHARE_UNSEEDED.length -
      BRIDGE_UNSEEDED.length -
      AVATAR_UNSEEDED.length,
  );
  expect(registered('agent.page_guide.routes').valueType).toBe('object');
});

// B2-11y (D10-373): 08 BR-WDR-30 has the console show the two auto-payout policies read only.
const AUTO_READ_ONLY = [
  'withdraw.auto_payout.frozen_balance_policy',
  'withdraw.auto_payout.same_day_policy',
];

it('[AC-F1-10e#4] 裁定 14：6 个资金规则标志与 agent.page_guide.routes、external_hosts 不可改（B2-11y 另加自动到账两项策略只读），其余全部可改', () => {
  const locked = configRegistry()
    .filter((spec) => !spec.adminEditable)
    .map((spec) => spec.key);
  expect(sorted(locked)).toStrictEqual(sorted([...FUND_FLAGS, ...EXTRA, ...AUTO_READ_ONLY]));
  for (const key of FUND_FLAGS) {
    expect(registered(key)).toMatchObject({ permission: 'config.business', adminEditable: false });
  }
});

it('[AC-F1-10e#5] 裁定 14、F1-10b：开关键不在配置中心，配置键也不是开关', () => {
  for (const spec of configRegistry()) expect(switchSpecOf(spec.key), spec.key).toBeNull();
  for (const sw of switchRegistry()) {
    const concrete = sw.pattern.replace(/<[a-z_]+>/g, 'taobao');
    expect(configItemSpecOf(concrete), concrete).toBeNull();
    expect(configItemSpecOf(sw.pattern), sw.pattern).toBeNull();
  }
});

it.each([
  ...UNREGISTERED,
  'ORDER.user_query_months',
  'order.user_query_months\n',
  ' order.user_query_months',
  'order.user_query_months.',
  'external_hosts.extra',
  'hasOwnProperty',
  '',
])('[AC-F1-10e#6] 裁定 14：注册表外的键 %j 查不到（不按前缀、不走原型链）', (key) => {
  expect(configItemSpecOf(key)).toBeNull();
  expect(configRegistry().some((spec) => spec.key === key)).toBe(false);
});

it('[AC-F1-10e#7] 注册表是共享的纯数据：改动返回值不影响后续查询', () => {
  const first = configRegistry();
  expect(Object.isFrozen(first)).toBe(true);
  for (const spec of first) expect(Object.isFrozen(spec), spec.key).toBe(true);
  try {
    (first[0] as { adminEditable: boolean }).adminEditable = !first[0]!.adminEditable;
  } catch {
    // strict-mode assignment to a frozen object throws; either way nothing may change
  }
  expect(configRegistry()[0]).toStrictEqual(first[0]);
  expect(registered(EXPECTED[0]!.key).adminEditable).toBe(EXPECTED[0]!.adminEditable);
});

it.each([
  ['boolean', true, true],
  ['boolean', false, true],
  ['boolean', 'true', false],
  ['boolean', 1, false],
  ['boolean', 0, false],
  ['boolean', null, false],
  ['boolean', [], false],
  ['number', 0, true],
  ['number', 1800, true],
  ['number', '3', false],
  ['number', true, false],
  ['number', null, false],
  ['number', {}, false],
  ['object', [], true],
  ['object', ['web_code'], true],
  ['object', {}, true],
  ['object', 'web_code', false],
  ['object', 1, false],
  ['object', true, false],
  ['object', null, false],
] as const)(
  '[AC-F1-10e#8] 裁定 9、14：%s 型的值 %j 合型=%s（null 一律不合）',
  (type, value, fits) => {
    const spec = configRegistry().find((entry) => entry.valueType === type && entry.adminEditable);
    expect(spec, type).toBeDefined();
    expect(configValueFits(spec!, value)).toBe(fits);
  },
);

it('[AC-F1-10e#9] enum 型（契约 AdminConfigValueType）只接受 options 里的字符串', () => {
  const spec: ConfigItemSpec = {
    key: 'x.mode',
    valueType: 'enum',
    options: ['a', 'b'],
    permission: 'config.general',
    adminEditable: true,
  };
  expect(configValueFits(spec, 'a')).toBe(true);
  expect(configValueFits(spec, 'b')).toBe(true);
  expect(configValueFits(spec, 'c')).toBe(false);
  expect(configValueFits(spec, 'A')).toBe(false);
  expect(configValueFits(spec, null)).toBe(false);
  expect(configValueFits(spec, ['a'])).toBe(false);
});

// F1-02zi: the BR-FUND-04 细则 settle.* group of F1-02zj is registered whole, after the ruling 14
// items and in its own order. F1-02zt：过渡已收紧, the absent branch is gone.
it('[AC-F1-10e#56] BR-FUND-04 细则 settle.* 一组 16 键整组登记（追加在裁定 14 之后，逐键值类型、options、权限点、可改标记）', () => {
  expect(SETTLE).toHaveLength(16);
  const keys = configRegistry().map((spec) => spec.key);
  const present = SETTLE.filter((entry) => keys.includes(entry.key));
  expect(present).toHaveLength(SETTLE.length);
  // F1-02zm / F1-02zw: the only keys after this group are the whole growth.invite_reward.* group
  // inviteNow() followed by the eight payout.* keys (B2-06bz), the six risk.withdraw.* keys
  // (B2-11z), the seventeen withdraw.auto_payout.* keys (B2-11y), the four
  // payout.auto_enable_check.* keys (B2-11dz), rank.cache_ttl_seconds (B1-28g), the two search.*
  // keys (B1-05l), the seven retention.* keys (B1-15zd), the three tax.SERVICE_FEE.* keys
  // (B2-08cz), feed.fallback_pool_id with the two pool.* keys (B1-05s),
  // withdraw.dormant_reverify_days (B1-02zs), the three Taobao promotion link keys (B1-06ze), the
  // four order_sync.rescan.* keys (B1-04zq) and ledger.advance_alert_fen (B2-04zo; checked key by
  // key in #57 and #58).
  presentOf(INVITE_CFG, 'growth.invite_reward.*');
  const inviteTail = [
    ...inviteNow(),
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
  ].map((e) => e.key);
  expect(keys.slice(EXPECTED.length, EXPECTED.length + SETTLE.length)).toStrictEqual(
    SETTLE.map((entry) => entry.key),
  );
  expect(keys.slice(EXPECTED.length + SETTLE.length)).toStrictEqual(inviteTail);
  for (const entry of SETTLE) {
    const spec = registered(entry.key);
    expect({
      key: spec.key,
      valueType: spec.valueType,
      options: spec.options,
      permission: spec.permission,
      adminEditable: spec.adminEditable,
    }).toStrictEqual({ ...entry, options: entry.options ?? null });
    expect(configItemSpecOf(entry.key), entry.key).toBe(spec);
  }
});

// F1-02zm: the BR-INV-24 细则 growth.invite_reward.* group of F1-02zn is registered whole right
// after SETTLE, in its own order, followed by eligibility_days, then payout.*, risk.withdraw.*,
// withdraw.auto_payout.*, payout.auto_enable_check.*, rank.cache_ttl_seconds, the two search.*
// keys, the seven retention.* keys, the three tax.SERVICE_FEE.* keys, feed.fallback_pool_id and
// the two pool.* keys, withdraw.dormant_reverify_days, the three Taobao promotion link keys, the
// four order_sync.rescan.* keys, ledger.advance_alert_fen (#58).
// F1-02zt：过渡已收紧, the absent branch is gone.
it('[AC-F1-10e#57] BR-INV-24 细则 growth.invite_reward.* 一组 5 键整组登记（紧接 settle.* 之后、其后是 eligibility_days、payout.* 八项、risk.withdraw.* 六项、withdraw.auto_payout.* 十七项、payout.auto_enable_check.* 四项、rank.cache_ttl_seconds、search.* 两项、retention.* 七项、tax.* 三项、feed.fallback_pool_id 与 pool.* 两项，逐键值类型、options、权限点、可改标记）', () => {
  expect(INVITE_CFG).toHaveLength(5);
  const keys = configRegistry().map((spec) => spec.key);
  const present = INVITE_CFG.filter((entry) => keys.includes(entry.key));
  expect(present).toHaveLength(INVITE_CFG.length);
  // F1-02zw: the tail is inviteNow(), the five keys followed by eligibility_days (checked in #58),
  // then the eight payout.* keys (B2-06bz), the six risk.withdraw.* keys (B2-11z), the
  // seventeen withdraw.auto_payout.* keys (B2-11y), the four payout.auto_enable_check.* keys
  // (B2-11dz), rank.cache_ttl_seconds (B1-28g), the two search.* keys (B1-05l), the seven
  // retention.* keys (B1-15zd), the three tax.SERVICE_FEE.* keys (B2-08cz),
  // feed.fallback_pool_id and the two pool.* keys (B1-05s), withdraw.dormant_reverify_days
  // (B1-02zs), the three Taobao promotion link keys (B1-06ze), the four order_sync.rescan.* keys
  // (B1-04zq), ledger.advance_alert_fen (B2-04zo).
  const tail = [
    ...inviteNow(),
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
  ];
  const head = keys.length - tail.length;
  expect(keys.slice(head)).toStrictEqual(tail.map((entry) => entry.key));
  expect(keys.slice(head, head + INVITE_CFG.length)).toStrictEqual(
    INVITE_CFG.map((entry) => entry.key),
  );
  presentOf(SETTLE, 'settle.*');
  expect(keys[head - 1]).toBe(SETTLE.at(-1)!.key);
  for (const entry of INVITE_CFG) {
    const spec = registered(entry.key);
    expect({
      key: spec.key,
      valueType: spec.valueType,
      options: spec.options,
      permission: spec.permission,
      adminEditable: spec.adminEditable,
    }).toStrictEqual({ ...entry, options: null });
    expect(configItemSpecOf(entry.key), entry.key).toBe(spec);
  }
});

// F1-02zw: the BR-INV-24 细则 eligibility period of F1-02zx (08 l.560; 04 §10.1, config.business)
// is registered right after growth.invite_reward.ip_window_hours; B2-06bz (D10-244 ②、D10-296):
// the eight payout.* keys follow it directly, in PAYOUT order, then B2-11z (D10-368) the six
// risk.withdraw.* keys in RISK_WITHDRAW order, then B2-11y (D10-373) the seventeen
// withdraw.auto_payout.* keys in AUTO_PAYOUT order (enum options exactly as the kit), then
// B2-11dz (D10-392 / D10-394) the four payout.auto_enable_check.* keys in AUTO_ENABLE_CHECK order,
// then B1-28g (D10-419) rank.cache_ttl_seconds (RANK), then B1-05l (D10-419 (a)) the two search.*
// keys in SEARCH order, then B1-15zd (D10-454) the seven retention.* keys in RETENTION order, then
// B2-08cz (D10-456 ④) the three tax.SERVICE_FEE.* keys in TAX order (the method's enum options
// exactly as the kit), then B1-05s (D10-480) feed.fallback_pool_id and the two pool.* keys in POOL
// order, then B1-02zs withdraw.dormant_reverify_days (REVERIFY), then B1-06ze (D10-510) the three
// Taobao promotion link keys in PROMO_LINK order, then B1-04zq (D10-543) the four
// order_sync.rescan.* keys in ORDER_RESCAN order, then B2-04zo ledger.advance_alert_fen
// (ADVANCE_ALERT), and nothing else.
// F1-02zt：过渡已收紧, the absent branch is gone.
it('[AC-F1-10e#58] BR-INV-24 细则 growth.invite_reward.eligibility_days 紧接 ip_window_hours 登记、其后紧接 payout.* 八项、risk.withdraw.* 六项、withdraw.auto_payout.* 十七项、payout.auto_enable_check.* 四项、rank.cache_ttl_seconds、search.* 两项、retention.* 七项、tax.* 三项、feed.fallback_pool_id 与 pool.* 两项（按登记顺序，逐键值类型、options、权限点、可改标记；options 为 null、config.business、可改）', () => {
  expect(INVITE_ELIG).toHaveLength(1);
  const key = 'growth.invite_reward.eligibility_days';
  expect(INVITE_ELIG[0]!.key).toBe(key);
  const keys = configRegistry().map((spec) => spec.key);
  const tail = inviteNow().map((entry) => entry.key);
  expect(tail).toStrictEqual([...INVITE_CFG.map((entry) => entry.key), key]);
  expect(keys.filter((entry) => entry === key)).toHaveLength(1);
  const at = keys.indexOf(key);
  expect(keys[at - 1]).toBe('growth.invite_reward.ip_window_hours');
  expect(keys.slice(at + 1)).toStrictEqual(
    [
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
    ].map((entry) => entry.key),
  );
  for (const entry of [
    ...PAYOUT,
    ...RISK_WITHDRAW,
    ...AUTO_ENABLE_CHECK,
    ...RANK,
    ...SEARCH,
    ...RETENTION,
    ...POOL,
    ...REVERIFY,
    ...PROMO_LINK,
    ...ORDER_RESCAN,
    ...ADVANCE_ALERT,
    ...QUOTE,
    ...SHARE,
    ...BRIDGE,
    ...AVATAR,
  ]) {
    const payoutSpec = registered(entry.key);
    expect({
      key: payoutSpec.key,
      valueType: payoutSpec.valueType,
      options: payoutSpec.options,
      permission: payoutSpec.permission,
      adminEditable: payoutSpec.adminEditable,
    }).toStrictEqual({ ...entry, options: null });
    expect(configItemSpecOf(entry.key), entry.key).toBe(payoutSpec);
    expect(switchSpecOf(entry.key), entry.key).toBeNull();
  }
  for (const entry of AUTO_PAYOUT) {
    const autoSpec = registered(entry.key);
    expect({
      key: autoSpec.key,
      valueType: autoSpec.valueType,
      options: autoSpec.options,
      permission: autoSpec.permission,
      adminEditable: autoSpec.adminEditable,
    }).toStrictEqual({ ...entry, options: entry.options ?? null });
    expect(configItemSpecOf(entry.key), entry.key).toBe(autoSpec);
    expect(switchSpecOf(entry.key), entry.key).toBeNull();
  }
  // B2-08cz (D10-456 ④): the three tax.SERVICE_FEE.* keys, the method with its enum options.
  for (const entry of TAX) {
    const taxSpec = registered(entry.key);
    expect({
      key: taxSpec.key,
      valueType: taxSpec.valueType,
      options: taxSpec.options,
      permission: taxSpec.permission,
      adminEditable: taxSpec.adminEditable,
    }).toStrictEqual({ ...entry, options: entry.options ?? null });
    expect(configItemSpecOf(entry.key), entry.key).toBe(taxSpec);
    expect(switchSpecOf(entry.key), entry.key).toBeNull();
  }
  const spec = registered(key);
  expect({
    key: spec.key,
    valueType: spec.valueType,
    options: spec.options,
    permission: spec.permission,
    adminEditable: spec.adminEditable,
  }).toStrictEqual({
    key,
    valueType: 'number',
    options: null,
    permission: 'config.business',
    adminEditable: true,
  });
  expect(configItemSpecOf(key)).toBe(spec);
  expect(switchSpecOf(key)).toBeNull();
});

// B2-11dzb (D10-400): assertions carried over from B2-11d #33–#35. The days the reconciliation has
// run through are not a key; the three support flags accept JSON booleans only; the required
// reconciliation days must be an integer ≥ 1.
const ENABLE_SUPPORT_KEYS = [
  'payout.auto_enable_check.limits_supported',
  'payout.auto_enable_check.status_codes_supported',
  'payout.auto_enable_check.bill_out_biz_no_supported',
];
const ENABLE_RECON_REQUIRED_DAYS = 'payout.auto_enable_check.recon_required_days';
const ENABLE_RETIRED_PASSED_DAYS = 'payout.auto_enable_check.recon_passed_days';

it('[AC-F1-10e#59] payout.auto_enable_check.recon_passed_days 不登记：configItemSpecOf 查不到、注册表与开关表都没有（B2-11dzb，D10-400）', () => {
  expect(configItemSpecOf(ENABLE_RETIRED_PASSED_DAYS)).toBeNull();
  expect(configRegistry().some((spec) => spec.key === ENABLE_RETIRED_PASSED_DAYS)).toBe(false);
  expect(switchSpecOf(ENABLE_RETIRED_PASSED_DAYS)).toBeNull();
});

it.each(ENABLE_SUPPORT_KEYS)('[AC-F1-10e#60] %s 只收 JSON 布尔（B2-11dzb，D10-400）', (key) => {
  const spec = registered(key);
  expect(configItemSpecOf(key), key).toBe(spec);
  for (const value of [true, false]) {
    expect(configValueFits(spec, value), String(value)).toBe(true);
  }
  for (const value of ['true', 'on', 1, 0, null, [], {}]) {
    expect(configValueFits(spec, value), JSON.stringify(value)).toBe(false);
  }
});

it('[AC-F1-10e#61] payout.auto_enable_check.recon_required_days 设了须为 ≥ 1 的整数（B2-11dzb，D10-400）', () => {
  const spec = registered(ENABLE_RECON_REQUIRED_DAYS);
  expect(configItemSpecOf(ENABLE_RECON_REQUIRED_DAYS)).toBe(spec);
  for (const value of [1, 2, 7, 30, 365]) {
    expect(configValueFits(spec, value), String(value)).toBe(true);
  }
  const refused = [0, -1, 1.5, 7.5, Number.NaN, Number.POSITIVE_INFINITY, '7', true, null, []];
  for (const value of refused) expect(configValueFits(spec, value), String(value)).toBe(false);
});

// B1-15zd (D10-454, BR-ID-30): the type, permission and editable flag of each retention.* key are
// checked in #58; here the lower bound (D10-458: each key's value in 08, so it can only be
// lengthened; upper bound the int4 default) and the master switch's JSON booleans.
const RETENTION_ENABLED = 'retention.purge.enabled';
const RETENTION_DAYS_KEYS = [
  ['retention.login_logs_days', 180],
  ['retention.device_registrations_days', 180],
  ['retention.sms_send_attempts_days', 190],
  ['retention.inbox_messages_days', 180],
  ['retention.notify_logs_days', 190],
  ['retention.union_raw_payloads_days', 180],
] as const;

it.each(RETENTION_DAYS_KEYS)(
  '[AC-F1-10e#62] %s 是可改的 config.risk 整数，下限 %i、上限 int4，只能往长调（B1-15zd，D10-454、D10-458）',
  (key, min) => {
    const spec = registered(key);
    expect(spec).toMatchObject({
      valueType: 'number',
      options: null,
      permission: 'config.risk',
      adminEditable: true,
    });
    expect(spec.range).toStrictEqual({ integer: true, min, max: 2147483647 });
    for (const value of [min, min + 1, 2147483647]) {
      expect(configValueFits(spec, value), String(value)).toBe(true);
    }
    const refused = [
      min - 1,
      30,
      0,
      -1,
      min + 0.5,
      2147483648,
      Number.NaN,
      String(min),
      true,
      null,
      [],
    ];
    for (const value of refused) expect(configValueFits(spec, value), String(value)).toBe(false);
  },
);

it('[AC-F1-10e#63] retention.purge.enabled 是可改的 config.risk 布尔项，不是开关，只收 JSON 布尔（B1-15zd，D10-454）', () => {
  const spec = registered(RETENTION_ENABLED);
  expect(spec).toMatchObject({
    valueType: 'boolean',
    options: null,
    permission: 'config.risk',
    adminEditable: true,
  });
  expect(switchSpecOf(RETENTION_ENABLED)).toBeNull();
  for (const value of [true, false]) {
    expect(configValueFits(spec, value), String(value)).toBe(true);
  }
  for (const value of ['true', 'on', 1, 0, null, [], {}]) {
    expect(configValueFits(spec, value), JSON.stringify(value)).toBe(false);
  }
});

// B2-08cz (D10-456 ④, BR-WDR-20): the type, options, permission and editable flag of each
// tax.SERVICE_FEE.* key are checked in #58; here the values each one accepts: the method only
// its three names, the rate only whole bp in 0..10000, the rate table only a JSON object / array.
it('[AC-F1-10e#64] tax.SERVICE_FEE.method 只收 none / flat_rate / cumulative 三个字符串，rate_table 只收 JSON 对象或数组（B2-08cz，D10-456 ④）', () => {
  const method = registered('tax.SERVICE_FEE.method');
  expect(method.options).toStrictEqual(['none', 'flat_rate', 'cumulative']);
  for (const value of ['none', 'flat_rate', 'cumulative']) {
    expect(configValueFits(method, value), value).toBe(true);
  }
  for (const value of ['', 'NONE', 'progressive', 0, true, null, [], {}]) {
    expect(configValueFits(method, value), JSON.stringify(value)).toBe(false);
  }
  const table = registered('tax.SERVICE_FEE.rate_table');
  for (const value of [[], {}, [{}]]) {
    expect(configValueFits(table, value), JSON.stringify(value)).toBe(true);
  }
  for (const value of ['[]', 0, true, null]) {
    expect(configValueFits(table, value), JSON.stringify(value)).toBe(false);
  }
});

it('[AC-F1-10e#65] tax.SERVICE_FEE.rate_bp 是可改的 config.business 整数，闭区间 0..10000 bp，拒绝浮点与隐式转换（B2-08cz，D10-456 ④）', () => {
  const spec = registered('tax.SERVICE_FEE.rate_bp');
  expect(spec).toMatchObject({
    valueType: 'number',
    options: null,
    permission: 'config.business',
    adminEditable: true,
  });
  expect(spec.range).toStrictEqual({ integer: true, min: 0, max: 10000 });
  for (const value of [0, 1, 2000, 10000]) {
    expect(configValueFits(spec, value), String(value)).toBe(true);
  }
  const refused = [
    -1,
    10001,
    0.5,
    2000.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '0',
    true,
    null,
    [],
  ];
  for (const value of refused) expect(configValueFits(spec, value), String(value)).toBe(false);
});

// B1-05s (D10-480): the type, permission and editable flag of each key are checked in #58; here
// the values each one accepts: the fall-back pool id only a string, each pool.* key only a whole
// number of seconds of at least 1 (int4 max, 08 gives no upper bound).
it('[AC-F1-10e#66] feed.fallback_pool_id 只收字符串（B1-05s，D10-480）', () => {
  const spec = registered('feed.fallback_pool_id');
  expect(spec.range).toBeUndefined();
  expect(configValueFits(spec, 'pool-1')).toBe(true);
  for (const value of [0, 1, true, null, [], {}]) {
    expect(configValueFits(spec, value), JSON.stringify(value)).toBe(false);
  }
});

it.each(['pool.max_age_sec', 'pool.refresh_interval_sec'])(
  '[AC-F1-10e#67] %s 是可改的 config.business 整数，下限 1，拒绝 0、浮点与隐式转换（B1-05s，D10-480，BR-PRICE-11）',
  (key) => {
    const spec = registered(key);
    expect(spec).toMatchObject({
      valueType: 'number',
      options: null,
      permission: 'config.business',
      adminEditable: true,
    });
    expect(spec.range).toStrictEqual({ integer: true, min: 1, max: 2147483647 });
    for (const value of [1, 3600, 7200, 2147483647]) {
      expect(configValueFits(spec, value), String(value)).toBe(true);
    }
    const refused = [
      0,
      -1,
      0.5,
      3600.5,
      2147483648,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '3600',
      true,
      null,
      [],
    ];
    for (const value of refused) expect(configValueFits(spec, value), String(value)).toBe(false);
  },
);

// B1-02zs (BR-WDR-01 细则): the type, permission and editable flag are checked in #58; here the
// values it accepts: a whole number of days of at least 0 (0 = old-account re-verification off,
// int4 max, 08 gives no upper bound).
it('[AC-F1-10e#68] withdraw.dormant_reverify_days 是可改的 config.business 整数，下限 0，拒绝负数、浮点与隐式转换（B1-02zs，BR-WDR-01）', () => {
  const spec = registered('withdraw.dormant_reverify_days');
  expect(spec).toMatchObject({
    valueType: 'number',
    options: null,
    permission: 'config.business',
    adminEditable: true,
  });
  expect(spec.range).toStrictEqual({ integer: true, min: 0, max: 2147483647 });
  for (const value of [0, 1, 180, 2147483647]) {
    expect(configValueFits(spec, value), String(value)).toBe(true);
  }
  const refused = [
    -1,
    0.5,
    180.5,
    2147483648,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '180',
    true,
    null,
    [],
  ];
  for (const value of refused) expect(configValueFits(spec, value), String(value)).toBe(false);
});

// B1-05w (编排 12:06 ③; B1-06zd #47 moved here): the type, permission and editable flag are checked
// in #58; here the values it accepts: a whole number per minute of at least 1 (int4 max, 08 gives
// no upper bound).
it('[AC-F1-10e#69] convert.taobao_prefetch.rate_per_min 是可改的 config.business 整数，下限 1，拒绝 0、浮点与隐式转换（B1-06ze，D10-510）', () => {
  const spec = registered('convert.taobao_prefetch.rate_per_min');
  expect(spec).toMatchObject({
    valueType: 'number',
    options: null,
    permission: 'config.business',
    adminEditable: true,
  });
  expect(spec.range).toStrictEqual({ integer: true, min: 1, max: 2147483647 });
  for (const value of [1, 60, 600, 2147483647]) {
    expect(configValueFits(spec, value), String(value)).toBe(true);
  }
  const refused = [
    0,
    -1,
    0.5,
    60.5,
    2147483648,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '60',
    true,
    null,
    [],
  ];
  for (const value of refused) expect(configValueFits(spec, value), String(value)).toBe(false);
});

// B2-04zo (BR-FUND-20): the type, permission and editable flag are checked in #58; here the values
// it accepts: a whole number of fen of at least 0 (int4 max, as businessInteger gives).
it('[AC-F1-10e#70] ledger.advance_alert_fen 是可改的 config.business 整数，下限 0，拒绝负数、浮点与隐式转换（B2-04zo，BR-FUND-20）', () => {
  const spec = registered('ledger.advance_alert_fen');
  expect(spec).toMatchObject({
    valueType: 'number',
    options: null,
    permission: 'config.business',
    adminEditable: true,
  });
  expect(spec.range).toStrictEqual({ integer: true, min: 0, max: 2147483647 });
  for (const value of [0, 1, 100000, 2147483647]) {
    expect(configValueFits(spec, value), String(value)).toBe(true);
  }
  const refused = [
    -1,
    0.5,
    100000.5,
    2147483648,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '100000',
    true,
    null,
    [],
  ];
  for (const value of refused) expect(configValueFits(spec, value), String(value)).toBe(false);
});
