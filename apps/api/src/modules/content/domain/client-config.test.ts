import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  agentOpen,
  buildClientConfig,
  CLIENT_CONFIG_KEYS,
  deriveInviteReward,
  inviteRewardSwitchOn,
  h5Bucket,
  NICKNAME_LIMITS,
  PLATFORM_CODES,
  purchaseStatus,
  searchStatus,
  windowDays,
  type ClientConfig,
} from './client-config.ts';

const REQUIRED = {
  h5_base_url: 'https://h5.example.test/',
  'h5_release.stable': 'stable-v1',
  kf: { url: 'https://kf.example.test/chat' },
  'legal.privacy.version': 7,
  'legal.privacy.min_version': 3,
  'legal.agreement.version': 5,
};
const PATTERNS = { version: 'lp-1', rules: [] } as NonNullable<ClientConfig['link_patterns']>;

function build(
  extra: Record<string, unknown> = {},
  viewer: { appId: string; userId: string | null } = { appId: 'app', userId: null },
  deviceId: string | null = null,
) {
  const missing: string[] = [];
  const invalid: string[] = [];
  const config = buildClientConfig({
    values: new Map(Object.entries({ ...REQUIRED, ...extra })),
    viewer,
    deviceId,
    linkPatterns: PATTERNS,
    rankPlatforms: [],
    report: { missing: (k) => missing.push(k), invalid: (k) => invalid.push(k) },
  });
  return { config, missing, invalid };
}

it('[AC-F1-02c] minimal configuration gets every planned default', () => {
  const { config, missing, invalid } = build({ 'invite.required': true });
  expect(missing).toEqual([]);
  expect(invalid).toEqual([]);
  expect(config).toMatchObject({
    dict_version: '0',
    h5_release: { version: 'stable-v1' },
    invite: {
      required: false,
      backfill_hours: 168,
      bind_phone_guide: true,
      before_buy_tip: true,
      reward_enabled: false,
      reward_amount_fen: 1000,
      eligibility_days: 30,
    },
    agent: { enabled: false, whitelist_only: true, guest_daily_quota: 3, require_phone: false },
    external_page: { nav_host_sample_bp: 1000 },
    app_update: { recheck_interval_sec: 1800 },
    claim: { window_days: null },
    link_patterns: PATTERNS,
  });
  expect(Object.keys(config!.features.platform_status)).toEqual([...PLATFORM_CODES]);
});

it('[AC-F1-02c] a required key absent or malformed fails and is reported', () => {
  for (const [key, value] of [
    ['h5_base_url', 'relative/path'],
    ['kf', { url: 'https://kf.example.test', extra: true }],
    ['legal.privacy.version', 0],
    ['h5_release.stable', ''],
  ] as const) {
    const { config, missing } = build({ [key]: value });
    expect(config).toBeUndefined();
    expect(missing).toEqual([key]);
  }
  const missing: string[] = [];
  const result = buildClientConfig({
    values: new Map(),
    viewer: { appId: 'app', userId: null },
    deviceId: null,
    linkPatterns: PATTERNS,
    rankPlatforms: [],
    report: { missing: (k) => missing.push(k), invalid: () => undefined },
  });
  expect(result).toBeUndefined();
  expect(missing).toHaveLength(6);
});

it('[AC-F1-02c] dictionaries and arrays are judged whole; malformed optional values warn', () => {
  const { config, invalid } = build({
    texts: { ok: 'a', bad: 7 },
    help_links: { bad: { route: 'Home', params: { article_id: 'x' } } },
    external_hosts: ['a.example.test', ''],
    jump_tip: [],
  });
  expect(config).toMatchObject({ texts: {}, help_links: {}, external_hosts: [], jump_tip: {} });
  expect(invalid).toEqual(expect.arrayContaining(['texts', 'help_links', 'external_hosts']));
});

it('[AC-F1-02c] derived flags win over the base dictionary', () => {
  const { config } = build({
    'features.flags': { 'external_page.union_host_block': false, custom: true },
    'earnings.dashboard.enabled': false,
  });
  expect(config!.features.flags).toEqual({
    custom: true,
    'external_page.union_host_block': true,
    'earnings.dashboard.visible': false,
    product_feedback: true,
    jd_plus_note: true,
  });
});

it('[AC-F1-02zzze] product_feedback / jd_plus_note: only a strict false source turns them off', () => {
  expect(build({}).config!.features.flags).toMatchObject({
    product_feedback: true,
    jd_plus_note: true,
  });
  const off = build({ 'feedback.enabled': false, 'detail.jd_plus_note.enabled': false });
  expect(off.config!.features.flags).toMatchObject({
    product_feedback: false,
    jd_plus_note: false,
  });
  expect(off.invalid).toEqual([]);
  const odd = build({ 'feedback.enabled': 'false', 'detail.jd_plus_note.enabled': 0 });
  expect(odd.config!.features.flags).toMatchObject({ product_feedback: true, jd_plus_note: true });
  expect(odd.invalid).toEqual(['feedback.enabled', 'detail.jd_plus_note.enabled']);
});

it('[AC-F1-02zzze] product_feedback / jd_plus_note win over same-named base dictionary keys', () => {
  const { config } = build({
    'features.flags': { product_feedback: false, jd_plus_note: true, custom: false },
    'detail.jd_plus_note.enabled': false,
  });
  expect(config!.features.flags).toEqual({
    custom: false,
    'external_page.union_host_block': true,
    'earnings.dashboard.visible': true,
    product_feedback: true,
    jd_plus_note: false,
  });
  expect(CLIENT_CONFIG_KEYS).toEqual(
    expect.arrayContaining(['feedback.enabled', 'detail.jd_plus_note.enabled']),
  );
});

it('[AC-F1-02c] platform and search status read their own switch rules', () => {
  expect(purchaseStatus('on', 'maintenance')).toBe('on');
  expect(purchaseStatus(1, 'maintenance')).toBe('maintenance');
  expect(purchaseStatus(false, 'other')).toBe('not_launched');
  expect(searchStatus('on')).toBe('off');
  expect(searchStatus(true)).toBe('on');
});

it('[AC-F1-02c] agent availability: master switch, whitelist and guests', () => {
  const base = { enabled: true, whitelistOnly: true, whitelist: ['u1'] };
  expect(agentOpen({ ...base, userId: null })).toBe(false);
  expect(agentOpen({ ...base, userId: 'u1' })).toBe(true);
  expect(agentOpen({ ...base, userId: 'u2' })).toBe(false);
  expect(agentOpen({ ...base, whitelistOnly: false, userId: null })).toBe(true);
  expect(agentOpen({ ...base, enabled: 'on', userId: 'u1' })).toBe(false);
  const { config } = build(
    { 'agent.enabled': true, 'agent.whitelist_user_ids': ['u1', 7] },
    { appId: 'app', userId: 'u1' },
  );
  expect(config!.agent.enabled).toBe(false);
});

it('[AC-F1-02c] h5 bucket follows the sha256 formula and includes the app id', () => {
  const hex = createHash('sha256').update('app:subject').digest('hex');
  expect(h5Bucket('app', 'subject')).toBe(Number(BigInt(`0x${hex.slice(0, 16)}`) % 10_000n));
  const canary = { 'h5_release.canary': { version: 'c', percent_bp: 10_000 } };
  expect(build(canary).config!.h5_release).toEqual({ version: 'stable-v1' });
  expect(build(canary, { appId: 'app', userId: null }, 'dev').config!.h5_release).toEqual({
    version: 'c',
  });
  const zero = { 'h5_release.canary': { version: 'c', percent_bp: 0 } };
  expect(build(zero, { appId: 'app', userId: 'u' }).config!.h5_release).toEqual({
    version: 'stable-v1',
  });
  const bad = build({ 'h5_release.canary': { version: 'c' } }, { appId: 'a', userId: 'u' });
  expect(bad.config!.h5_release).toEqual({ version: 'stable-v1' });
  expect(bad.invalid).toContain('h5_release.canary');
  expect(build({ 'h5_release.canary': null }).invalid).toEqual([]);
});

it('[AC-F1-02c] the user id, not the device, buckets a logged-in caller', () => {
  const user = 'user-1';
  const percent = h5Bucket('app', user) + 1;
  const canary = { 'h5_release.canary': { version: 'c', percent_bp: percent } };
  for (const device of [null, 'device-a', 'device-b']) {
    expect(build(canary, { appId: 'app', userId: user }, device).config!.h5_release).toEqual({
      version: 'c',
    });
  }
});

it('[AC-F1-02c] claim window rounds down to days and is null otherwise', () => {
  expect(windowDays(47)).toBe(1);
  expect(windowDays(48)).toBe(2);
  expect(windowDays(23)).toBeNull();
  expect(windowDays(36.5)).toBeNull();
  expect(windowDays('48')).toBeNull();
  expect(windowDays(0)).toBeNull();
  expect(windowDays(2_147_483_648)).toBeNull();
});

it('[AC-F1-02c] the key list covers every platform switch once', () => {
  expect(new Set(CLIENT_CONFIG_KEYS).size).toBe(CLIENT_CONFIG_KEYS.length);
  expect(CLIENT_CONFIG_KEYS).toContain('search.enabled.suning');
  expect(CLIENT_CONFIG_KEYS).not.toContain('link_patterns');
  expect(CLIENT_CONFIG_KEYS).not.toContain('invite.required');
});

it('[AC-F1-02h] lkg_max_age_sec and bridge_disabled_methods default silently when absent', () => {
  const { config, invalid } = build();
  expect(config!.lkg_max_age_sec).toBe(604_800);
  expect(config!.bridge_disabled_methods).toEqual([]);
  expect(config!.features.rank_platforms).toEqual([]);
  expect(invalid).toEqual([]);
});

it('[AC-F1-02h] the namespaced keys are read; same-named keys are ignored', () => {
  const { config } = build({
    'config.lkg_max_age_sec': 3600,
    'bridge.disabled_methods': ['ext.openApp', 'clipboard.read'],
    lkg_max_age_sec: 1,
    bridge_disabled_methods: ['a.b'],
  });
  expect(config!.lkg_max_age_sec).toBe(3600);
  expect(config!.bridge_disabled_methods).toEqual(['ext.openApp', 'clipboard.read']);
});

it('[AC-F1-02zr] legal.agreement.min_version is delivered only when present and int32 >= 1', () => {
  expect(CLIENT_CONFIG_KEYS).toContain('legal.agreement.min_version');
  const absent = build();
  expect(absent.config!.legal.agreement).toEqual({ version: 5 });
  expect(absent.invalid).toEqual([]);
  // Not compared with version: a min_version above version is still delivered.
  for (const value of [1, 9, 2_147_483_647]) {
    const { config, invalid, missing } = build({ 'legal.agreement.min_version': value });
    expect(config!.legal.agreement).toEqual({ version: 5, min_version: value });
    expect(invalid).toEqual([]);
    expect(missing).toEqual([]);
  }
});

it('[AC-F1-02zr] a malformed legal.agreement.min_version is left out and reported once', () => {
  for (const value of [0, -1, 1.5, '2', null, true, 2_147_483_648, { v: 2 }, [2], Number.NaN]) {
    const { config, invalid, missing } = build({ 'legal.agreement.min_version': value });
    expect(config!.legal.agreement).toEqual({ version: 5 });
    expect(invalid).toEqual(['legal.agreement.min_version']);
    expect(missing).toEqual([]);
  }
});

it('[AC-F1-02h] a malformed lkg_max_age_sec falls back whole and is reported', () => {
  for (const value of [0, -1, 1.5, '3600', 2_147_483_648, null]) {
    const { config, invalid } = build({ 'config.lkg_max_age_sec': value });
    expect(config!.lkg_max_age_sec).toBe(604_800);
    expect(invalid).toEqual(['config.lkg_max_age_sec']);
  }
});

it('[AC-F1-02h] a malformed bridge.disabled_methods falls back to [] and is reported', () => {
  for (const value of [
    ['login'],
    ['clipboard.read', 7],
    ['a.b', 'a.b'],
    'clipboard.read',
    ['Clipboard.read'],
    ['clipboard.read.extra'],
    {},
  ]) {
    const { config, invalid } = build({ 'bridge.disabled_methods': value });
    expect(config!.bridge_disabled_methods).toEqual([]);
    expect(invalid).toEqual(['bridge.disabled_methods']);
  }
});

it('[AC-F1-02h] features.rank_platforms comes from the input, never from config rows', () => {
  const missing: string[] = [];
  const config = buildClientConfig({
    values: new Map(
      Object.entries({
        ...REQUIRED,
        'features.rank_platforms': ['taobao'],
        'features.flags': { rank_platforms: true },
      }),
    ),
    viewer: { appId: 'app', userId: null },
    deviceId: null,
    linkPatterns: PATTERNS,
    rankPlatforms: ['jd', 'pdd'],
    report: { missing: (k) => missing.push(k), invalid: () => undefined },
  });
  expect(config!.features.rank_platforms).toEqual(['jd', 'pdd']);
  expect(missing).toEqual([]);
});

it('[AC-F1-02j] a well-formed clipboard passes through as-is; no consent_version is invented', () => {
  for (const clipboard of [
    { consent_version: '2026-10-17', min_len: 10 },
    { consent_version: 'v'.repeat(64) },
    { consent_version: '😀'.repeat(64) },
    { consent_version: ' ' },
    { min_len: 10 },
    {},
  ]) {
    const { config, invalid } = build({ clipboard });
    expect(config!.clipboard).toEqual(clipboard);
    expect(invalid).toEqual([]);
  }
  expect(build().config!.clipboard).toEqual({});
});

it('[AC-F1-02j] a malformed consent_version drops the whole clipboard key and reports it', () => {
  for (const version of [7, '', null, {}, [], true, 'v'.repeat(65), '😀'.repeat(65)]) {
    const { config, invalid } = build({ clipboard: { consent_version: version, min_len: 10 } });
    expect(config!.clipboard).toEqual({});
    expect(invalid).toEqual(['clipboard']);
  }
  for (const clipboard of ['x', [], null, 7]) {
    const { config, invalid } = build({ clipboard });
    expect(config!.clipboard).toEqual({});
    expect(invalid).toEqual(['clipboard']);
  }
});

it('[AC-F1-02j] split clipboard rows are never read', () => {
  const { config, invalid } = build({
    'clipboard.consent_version': 'x',
    'clipboard.auto_read.ios': false,
    'features.clipboard.auto_read.ios': false,
  });
  expect(config!.clipboard).toEqual({});
  expect(config!.features.flags).toEqual({
    'external_page.union_host_block': true,
    'earnings.dashboard.visible': true,
    product_feedback: true,
    jd_plus_note: true,
  });
  expect(invalid).toEqual([]);
});

it('[AC-F1-02j] clipboard.auto_read flags pass through as-is; missing clients are not filled', () => {
  const { config } = build({
    'features.flags': { 'clipboard.auto_read.ios': false, 'clipboard.auto_read.android': true },
  });
  expect(config!.features.flags).toEqual({
    'clipboard.auto_read.ios': false,
    'clipboard.auto_read.android': true,
    'external_page.union_host_block': true,
    'earnings.dashboard.visible': true,
    product_feedback: true,
    jd_plus_note: true,
  });
  const bad = build({ 'features.flags': { 'clipboard.auto_read.ios': 'off', other: true } });
  expect(bad.config!.features.flags).toEqual({
    'external_page.union_host_block': true,
    'earnings.dashboard.visible': true,
    product_feedback: true,
    jd_plus_note: true,
  });
  expect(bad.invalid).toEqual(['features.flags']);
});

const ON = 'growth.invite_reward.enabled';
const AMOUNT = 'growth.invite_reward.amount_fen';

function reward(values: Record<string, unknown>, available: number | null | undefined) {
  const invalid: string[] = [];
  const result = deriveInviteReward({
    values: new Map(Object.entries(values)),
    availableBudgetFen: available,
    report: { missing: () => undefined, invalid: (k) => invalid.push(k) },
  });
  return { result, invalid };
}

it('[AC-F1-02zp] the reward keys are read; same-named invite.reward_* never are', () => {
  expect(CLIENT_CONFIG_KEYS).toEqual(expect.arrayContaining([ON, AMOUNT]));
  expect(CLIENT_CONFIG_KEYS).not.toContain('invite.reward_enabled');
  expect(CLIENT_CONFIG_KEYS).not.toContain('invite.reward_amount_fen');
});

it('[AC-F1-02zp] only JSON true turns the switch on', () => {
  expect(inviteRewardSwitchOn(new Map([[ON, true]]))).toBe(true);
  for (const value of [false, 'true', 1, 'on', null, {}]) {
    expect(inviteRewardSwitchOn(new Map([[ON, value]]))).toBe(false);
  }
  expect(inviteRewardSwitchOn(new Map())).toBe(false);
});

it('[AC-F1-02zp] enabled needs a safe-integer budget of at least both parties', () => {
  for (const [amount, available, enabled] of [
    [1000, 1999, false],
    [1000, 2000, true],
    [500, 1000, true],
    [0, 0, true],
    [0, -1, false],
    [2147483647, 4294967293, false],
    [2147483647, 4294967294, true],
    [1000, 2 ** 53, false],
    [2147483647, Number.MAX_SAFE_INTEGER, true],
    [1000, -Number.MAX_SAFE_INTEGER, false],
    [1000, 2000.5, false],
    [1000, null, false],
    [1000, undefined, false],
  ] as const) {
    const { result, invalid } = reward({ [ON]: true, [AMOUNT]: amount }, available);
    expect(result).toEqual({ reward_enabled: enabled, reward_amount_fen: amount });
    expect(invalid).toEqual([]);
  }
});

it('[AC-F1-02zp] a malformed amount falls back to 1000 and is reported; off still sends it', () => {
  expect(reward({ [ON]: true, [AMOUNT]: '500' }, 1999)).toEqual({
    result: { reward_enabled: false, reward_amount_fen: 1000 },
    invalid: [AMOUNT],
  });
  expect(reward({ [ON]: false, [AMOUNT]: 300 }, 10_000)).toEqual({
    result: { reward_enabled: false, reward_amount_fen: 300 },
    invalid: [],
  });
  expect(reward({ [ON]: 'true' }, 10_000)).toEqual({
    result: { reward_enabled: false, reward_amount_fen: 1000 },
    invalid: [ON],
  });
});

it('[AC-F1-02zp] buildClientConfig derives invite reward from the budget it is given', () => {
  const values = new Map(Object.entries({ ...REQUIRED, [ON]: true, [AMOUNT]: 500 }));
  const base = {
    values,
    viewer: { appId: 'app', userId: null },
    deviceId: null,
    linkPatterns: PATTERNS,
    rankPlatforms: [],
    report: { missing: () => undefined, invalid: () => undefined },
  };
  expect(buildClientConfig({ ...base, inviteRewardBudgetFen: 1000 })?.invite).toMatchObject({
    reward_enabled: true,
    reward_amount_fen: 500,
  });
  expect(buildClientConfig(base)?.invite).toMatchObject({
    reward_enabled: false,
    reward_amount_fen: 500,
  });
});

it('[AC-F1-02zzq] nickname is always sent as {1, 16, 3} without any config row', () => {
  const { config, invalid } = build();
  expect(config!.nickname).toStrictEqual({ min_len: 1, max_len: 16, monthly_limit: 3 });
  expect(NICKNAME_LIMITS).toStrictEqual({ min_len: 1, max_len: 16, monthly_limit: 3 });
  expect(invalid).toEqual([]);
});

it('[AC-F1-02zzq] nickname-like rows are never read nor reported and never override', () => {
  const { config, invalid, missing } = build({
    nickname: { min_len: 2, max_len: 20, monthly_limit: 5 },
    'nickname.max_len': 20,
    'identity.nickname.monthly_limit': 9,
  });
  expect(config!.nickname).toStrictEqual({ min_len: 1, max_len: 16, monthly_limit: 3 });
  expect([...invalid, ...missing]).toEqual([]);
  expect(CLIENT_CONFIG_KEYS.filter((key) => key.includes('nickname'))).toEqual([]);
});

it('[AC-F1-02zzq] each response gets its own nickname object; the constant stays frozen', () => {
  const first = build().config!;
  first.nickname!.max_len = 99;
  expect(build().config!.nickname).toStrictEqual({ min_len: 1, max_len: 16, monthly_limit: 3 });
  expect(Object.isFrozen(NICKNAME_LIMITS)).toBe(true);
});
