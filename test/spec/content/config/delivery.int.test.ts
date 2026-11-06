// Scope: task F1-02c §9.1–9.3 and the current ConfigResponse contract only.
// Every case starts with its own app_id; all observations of content are HTTP responses.
import { createDb, destroyDb } from '@couli/db';
import { afterAll, beforeAll, expect, it, onTestFinished } from 'vitest';
import { getLinkPatterns } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  REQUIRED,
  PLATFORMS,
  appId,
  bucket,
  changeConfig,
  configured,
  expectLog,
  failure,
  harness,
  read,
  registerDevice,
  seedConfig,
  session,
  subjectWhere,
  success,
  type Harness,
  type Json,
  type Values,
} from './kit.ts';
import { harness as signingHarness } from '../bridge-origins/http-kit.ts';
import { verified } from '../bridge-origins/jws-kit.ts';

// F1-02zm: F1-02zp adds invite.reward_enabled and invite.reward_amount_fen (BR-INV-24 ⑨, 04 §10.1
// l.903). These cases write neither growth.invite_reward.enabled nor .amount_fen and wire no budget
// port, so the pair is the derived default: off (switch missing) and 1000 (BR-INV-24 细则 每方
// 1000 分). F1-02zt：过渡已收紧, the pair must be delivered; the rest of invite is returned for the
// original exact comparison.
const INVITE_REWARD_DEFAULT = { reward_enabled: false, reward_amount_fen: 1000 };
const INVITE_ELIGIBILITY_DAYS_DEFAULT = 30; // F1-02zzd
function inviteOf<T extends object>(invite: T): T {
  const has = Object.keys(INVITE_REWARD_DEFAULT).map((key) => Object.hasOwn(invite, key));
  expect(has, 'reward_enabled / reward_amount_fen delivered').toStrictEqual([true, true]);
  const { reward_enabled, reward_amount_fen, ...rest } = invite as Record<string, unknown>;
  expect({ reward_enabled, reward_amount_fen }).toStrictEqual(INVITE_REWARD_DEFAULT);
  // F1-02zzd: F1-02zze adds invite.eligibility_days (BR-INV-18 / BR-INV-24 细则: missing row reads
  // as 30). These cases write no growth.invite_reward.eligibility_days, so it must be exactly 30.
  // F1-02zzf：过渡已收紧, the key must be delivered.
  expect(Object.hasOwn(rest, 'eligibility_days'), 'invite.eligibility_days delivered').toBe(true);
  const { eligibility_days, ...others } = rest;
  expect(eligibility_days, 'invite.eligibility_days').toBe(INVITE_ELIGIBILITY_DAYS_DEFAULT);
  return others as T;
}

// F1-02zzzf：收紧为单态（F1-02zzze 已合并）
// Derived flags product_feedback (feedback.enabled) and jd_plus_note (detail.jd_plus_note.enabled):
// only a false source turns them off. These cases write neither source, so both keys must be
// present and exactly true in every exact features.flags comparison below.

let database: Awaited<ReturnType<(typeof import('@couli/db/testing'))['createTestDatabase']>>;
let redis: Awaited<ReturnType<(typeof import('@couli/db/testing'))['acquireTestRedis']>>;
let db: ReturnType<typeof createDb>;
let h: Harness;
beforeAll(async () => {
  const testing = await import('@couli/db/testing');
  database = await testing.createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  redis = await testing.acquireTestRedis();
  h = await harness(db, database.urlFor('couli_app'), redis.url);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    try {
      if (db !== undefined) await destroyDb(db);
      await database?.drop();
    } finally {
      await redis?.stop();
    }
  }
});

it('[AC-F1-02c#1] 最小有效配置下发所有约定键、规划缺省与完整契约', async () => {
  const h = await signingHarness(db, database.urlFor('couli_app'), redis.url);
  onTestFinished(() => h.close());
  const id = await configured(h, { 'invite.required': true });
  const data = await success(h.app, id);
  expect(verified(data.bridge_origins, h.signing.publicKey, 'fixture-config-key')).toMatchObject({
    app_id: id,
    env: 'test',
    origins: ['https://h5.example.test'],
  });
  // platform_icons belongs to F1-02d: absent before it, {} once delivered (no published mark here).
  expect([undefined, {}]).toContainEqual(data.platform_icons);
  // F1-02h keys: absent before it, the 04 §10.1 default once delivered.
  expect([undefined, 604_800]).toContainEqual(data.lkg_max_age_sec);
  expect([undefined, []]).toContainEqual(data.bridge_disabled_methods);
  expect([undefined, []]).toContainEqual(data.features.rank_platforms);
  expect(
    data.config_version === undefined || /^[0-9A-Za-z._:-]{1,64}$/.test(data.config_version),
  ).toBe(true);
  // F1-02zzw: 收紧为单态（F1-02zzq 已合并） (04 l.973 nickname, BR-ID-39: 1–16 字符、每月 3 次).
  // The key must be present and exactly this object; absence or any other value (null, missing /
  // extra field, other numbers) fails. Masked below only for the exact comparison.
  expect(Object.hasOwn(data, 'nickname'), 'nickname present').toBe(true);
  expect(data.nickname, 'nickname').toStrictEqual({ min_len: 1, max_len: 16, monthly_limit: 3 });
  expect({
    ...data,
    invite: inviteOf(data.invite), // F1-02zm
    nickname: undefined, // F1-02zzt, F1-02zzw: asserted above
    platform_icons: undefined,
    lkg_max_age_sec: undefined,
    config_version: undefined,
    bridge_disabled_methods: undefined,
    features: { ...data.features, rank_platforms: undefined },
  }).toEqual({
    dict_version: '0',
    h5_base_url: REQUIRED['h5_base_url'],
    h5_release: { version: 'stable-v1' },
    share_domains: [],
    features: {
      flags: {
        'external_page.union_host_block': true,
        'earnings.dashboard.visible': true,
        product_feedback: true,
        jd_plus_note: true,
      },
      platform_status: Object.fromEntries(PLATFORMS.map((p) => [p, 'not_launched'])),
      search_status: Object.fromEntries(PLATFORMS.map((p) => [p, 'off'])),
    },
    texts: {},
    legal: { privacy: { version: 7, min_version: 3 }, agreement: { version: 5 } },
    invite: { required: false, backfill_hours: 168, bind_phone_guide: true, before_buy_tip: true },
    agent: {
      enabled: false,
      whitelist_only: true,
      filing_text: '',
      examples: [],
      guest_daily_quota: 3,
      require_phone: false,
    },
    kf: REQUIRED['kf'],
    jump_tip: {},
    clipboard: {},
    bridge_origins: data.bridge_origins,
    auth_tips: {},
    compliance: {},
    display: {},
    external_page: { nav_host_sample_bp: 1000 },
    link_patterns: getLinkPatterns(),
    external_hosts: [],
    app_update: { recheck_interval_sec: 1800 },
    help_links: {},
    claim: { window_days: null },
  });
});

it('[AC-F1-02c#2] 有效非缺省配置按键读取，不遗漏 free-form、字典及后增字段', async () => {
  const h = await signingHarness(db, database.urlFor('couli_app'), redis.url);
  onTestFinished(() => h.close());
  const objects = {
    jump_tip: { title: '跳转', count: 2 },
    clipboard: { enabled: false },
    bridge_origins: { origins: ['https://alternate.example.test', 'https://bridge.example.test'] },
    auth_tips: { nested: { text: '提示' } },
    compliance: { enabled: true },
    display: { scale: 2, extra: null },
  };
  const id = await configured(h, {
    ...objects,
    h5_base_url: 'https://alternate.example.test/h5/',
    'h5_release.stable': 'alternate-stable',
    kf: { url: 'https://alternate.example.test/chat' },
    'legal.privacy.version': 11,
    'legal.privacy.min_version': 9,
    'legal.agreement.version': 13,
    dict_version: 'dict-42',
    share_domains: ['a.example.test', 'b.example.test'],
    texts: { 'withdraw.sla_text': '三个工作日', empty: '' },
    'invite.backfill_hours': 0,
    'invite.bind_phone_guide': false,
    'invite.before_buy_tip': false,
    'agent.filing_text': '备案说明',
    'agent.examples': ['查订单', ''],
    'agent.require_phone': true,
    'external_page.nav_host_sample_bp': 0,
    external_hosts: ['outside.example.test'],
    'app_update.recheck_interval_sec': 1,
    help_links: { login_help: { route: 'Help', params: { article_id: 'help-1' } } },
  });
  const data = await success(h.app, id);
  expect(verified(data.bridge_origins, h.signing.publicKey, 'fixture-config-key')).toStrictEqual({
    v: 1,
    app_id: id,
    env: 'test',
    version: 1,
    origins: objects.bridge_origins.origins,
  });
  inviteOf(data.invite); // F1-02zm: the reward pair delivered as the derived default
  expect(data).toMatchObject({
    ...objects,
    bridge_origins: data.bridge_origins,
    h5_base_url: 'https://alternate.example.test/h5/',
    h5_release: { version: 'alternate-stable' },
    kf: { url: 'https://alternate.example.test/chat' },
    legal: { privacy: { version: 11, min_version: 9 }, agreement: { version: 13 } },
    dict_version: 'dict-42',
    share_domains: ['a.example.test', 'b.example.test'],
    texts: { 'withdraw.sla_text': '三个工作日', empty: '' },
    invite: { required: false, backfill_hours: 0, bind_phone_guide: false, before_buy_tip: false },
    agent: { filing_text: '备案说明', examples: ['查订单', ''], require_phone: true },
    external_page: { nav_host_sample_bp: 0 },
    external_hosts: ['outside.example.test'],
    app_update: { recheck_interval_sec: 1 },
    help_links: { login_help: { route: 'Help', params: { article_id: 'help-1' } } },
  });
});

it.each(['bind_phone_guide', 'before_buy_tip'] as const)(
  '[AC-F1-02c#2] invite.%s 单独关闭时不影响另一个缺省开启的开关',
  async (key) => {
    const id = await configured(h, { [`invite.${key}`]: false });
    // F1-02zm: the reward pair is checked and set aside.
    expect(inviteOf((await success(h.app, id)).invite)).toEqual({
      required: false,
      backfill_hours: 168,
      bind_phone_guide: key !== 'bind_phone_guide',
      before_buy_tip: key !== 'before_buy_tip',
    });
  },
);

it.each(Object.keys(REQUIRED))(
  '[AC-F1-02c#3] 必填键 %s 缺失：50001、ErrorEnvelope 与错误日志',
  async (key) => {
    const id = appId();
    await seedConfig(
      h.db,
      id,
      Object.fromEntries(Object.entries(REQUIRED).filter(([k]) => k !== key)),
    );
    const start = h.logs.length;
    await failure(await read(h.app, id));
    expectLog(h.logs.slice(start), 50, key);
  },
);

const malformedRequired: [string, Json][] = [
  ['h5_base_url', 'relative/path'],
  ['h5_base_url', 42],
  ['h5_base_url', null],
  ['h5_release.stable', ''],
  ['h5_release.stable', 1],
  ['kf', { url: 'not a uri' }],
  ['kf', {}],
  ['kf', { url: 'https://kf.example.test', extra: true }],
  ['legal.privacy.version', 0],
  ['legal.privacy.version', '7'],
  ['legal.privacy.min_version', 0],
  ['legal.privacy.min_version', 1.5],
  ['legal.agreement.version', 0],
  ['legal.agreement.version', 2_147_483_648],
];
it.each(malformedRequired)(
  '[AC-F1-02c#4] 必填键 %s 的非法值 %j 不降级成成功响应',
  async (key, value) => {
    const id = await configured(h, { [key]: value });
    const start = h.logs.length;
    await failure(await read(h.app, id));
    expectLog(h.logs.slice(start), 50, key);
  },
);

// Rotate all representations across every platform, preventing special cases for 淘京拼.
it('[AC-F1-02c#5] 九个平台购买状态：on 字符串有效、maintenance 仅关闭时有效', async () => {
  const cases: { enabled?: Json; reason?: Json; expected: string }[] = [
    { enabled: true, reason: 'maintenance', expected: 'on' },
    { enabled: 'on', reason: 'maintenance', expected: 'on' },
    { enabled: false, reason: 'maintenance', expected: 'maintenance' },
    { enabled: false, expected: 'not_launched' },
    { enabled: false, reason: 'unknown', expected: 'not_launched' },
    { enabled: 1, reason: 'maintenance', expected: 'maintenance' },
    { enabled: 'true', expected: 'not_launched' },
    { expected: 'not_launched' },
  ];
  for (let rotation = 0; rotation < cases.length; rotation += 1) {
    const values: Values = {};
    const expected: Record<string, string> = {};
    PLATFORMS.forEach((platform, i) => {
      const sample = cases[(i + rotation) % cases.length]!;
      if (sample.enabled !== undefined) values[`convert.enabled.${platform}`] = sample.enabled;
      if (sample.reason !== undefined) values[`convert.off_reason.${platform}`] = sample.reason;
      expected[platform] = sample.expected;
    });
    const id = await configured(h, values);
    expect((await success(h.app, id)).features.platform_status).toEqual(expected);
  }
});

it('[AC-F1-02c#6] 九个平台搜索只认 JSON true，on、1、字符串 true 及缺失都是 off', async () => {
  const cases: (Json | undefined)[] = [true, false, 'on', 1, 'true', undefined, null];
  for (let rotation = 0; rotation < cases.length; rotation += 1) {
    const values: Values = {};
    const expected: Record<string, string> = {};
    PLATFORMS.forEach((platform, i) => {
      const value = cases[(i + rotation) % cases.length];
      if (value !== undefined) values[`search.enabled.${platform}`] = value;
      expected[platform] = value === true ? 'on' : 'off';
    });
    const id = await configured(h, values);
    expect((await success(h.app, id)).features.search_status).toEqual(expected);
  }
});

it.each([undefined, false, true, 'off', 0, null] as const)(
  '[AC-F1-02c#7] flags 保留基础字典但两个派生键优先；源值 %j 只有 false 算关闭',
  async (value) => {
    const id = await configured(h, {
      'features.flags': {
        custom: true,
        'ui.grayscale': false,
        'external_page.union_host_block': value === false,
        'earnings.dashboard.visible': value === false,
      },
      ...(value === undefined
        ? {}
        : {
            'external_page.union_host_block': value,
            'earnings.dashboard.enabled': value,
          }),
    });
    expect((await success(h.app, id)).features.flags).toEqual({
      custom: true,
      'ui.grayscale': false,
      'external_page.union_host_block': value !== false,
      'earnings.dashboard.visible': value !== false,
      product_feedback: true,
      jd_plus_note: true,
    });
  },
);

it.each([
  ['earnings.dashboard.enabled', true, false],
  ['external_page.union_host_block', false, true],
] as const)(
  '[AC-F1-02c#7] 只关闭 %s 时两个派生 flags 各自跟随自己的配置源',
  async (key, unionHostBlock, dashboardVisible) => {
    const id = await configured(h, { [key]: false });
    expect((await success(h.app, id)).features.flags).toEqual({
      'external_page.union_host_block': unionHostBlock,
      'earnings.dashboard.visible': dashboardVisible,
      product_feedback: true,
      jd_plus_note: true,
    });
  },
);

it('[AC-F1-02c#8] agent 白名单按每次请求登录态判定，含 deletion_only，不泄露名单与备案号', async () => {
  const id = await configured(h, { 'agent.enabled': true, 'agent.whitelist_only': 'on' });
  const member = await session(h, id, await registerDevice(h, id), 'deletion_only');
  const outsider = await session(h, id, await registerDevice(h, id));
  await seedConfig(h.db, id, {
    'agent.whitelist_user_ids': [member.user.id],
    'agent.filing_no': 'private-filing-number',
  });
  // Reuse the same cache/app and alternate callers: never cache a viewer's derived result.
  for (const caller of [undefined, member, outsider, member, undefined]) {
    const data = await success(h.app, id, caller?.headers);
    expect(data.agent).toEqual({
      enabled: caller === member,
      whitelist_only: true,
      filing_text: '',
      examples: [],
      guest_daily_quota: 3,
      require_phone: false,
    });
    expect(JSON.stringify(data)).not.toContain(member.user.id);
    expect(JSON.stringify(data)).not.toContain('private-filing-number');
  }
});

it.each([undefined, 'on', false, 1, 'true'] as const)(
  '[AC-F1-02c#9] agent.enabled=%j 即使关白名单也不开放',
  async (enabled) => {
    const id = await configured(h, {
      'agent.whitelist_only': false,
      ...(enabled === undefined ? {} : { 'agent.enabled': enabled }),
    });
    expect((await success(h.app, id)).agent.enabled).toBe(false);
  },
);

it.each([undefined, false, 'on', true] as const)(
  '[AC-F1-02c#9] 白名单开启时 agent.enabled=%j 仍约束名单内登录用户，名单外始终关闭',
  async (enabled) => {
    const id = await configured(h, {
      'agent.whitelist_only': true,
      ...(enabled === undefined ? {} : { 'agent.enabled': enabled }),
    });
    const member = await session(h, id, await registerDevice(h, id));
    const outsider = await session(h, id, await registerDevice(h, id));
    await seedConfig(h.db, id, { 'agent.whitelist_user_ids': [member.user.id] });
    expect((await success(h.app, id, member.headers)).agent.enabled).toBe(enabled === true);
    expect((await success(h.app, id, outsider.headers)).agent.enabled).toBe(false);
  },
);

it.each([undefined, 'off', 0, null, false] as const)(
  '[AC-F1-02c#10] whitelist_only=%j 只有 JSON false 才允许游客',
  async (value) => {
    const id = await configured(h, {
      'agent.enabled': true,
      'agent.whitelist_user_ids': ['null', ''],
      ...(value === undefined ? {} : { 'agent.whitelist_only': value }),
    });
    const data = await success(h.app, id);
    expect(data.agent.whitelist_only).toBe(value !== false);
    expect(data.agent.enabled).toBe(value === false);
  },
);

it('[AC-F1-02c#11] 白名单混入非字符串时整键失效，不能保留其中匹配用户', async () => {
  const id = await configured(h, { 'agent.enabled': true });
  const account = await session(h, id, await registerDevice(h, id));
  await seedConfig(h.db, id, { 'agent.whitelist_user_ids': [account.user.id, 7] });
  expect((await success(h.app, id, account.headers)).agent.enabled).toBe(false);
});

it.each([undefined, -1, 0, 9, 2_147_483_647, 2_147_483_648, 1.5, '3'] as const)(
  '[AC-F1-02c#12] agent.guest_daily_quota=%j 的整数范围和零额度',
  async (quota) => {
    const id = await configured(h, quota === undefined ? {} : { 'agent.guest_daily_quota': quota });
    const expected =
      typeof quota === 'number' && Number.isInteger(quota) && quota >= 0 && quota <= 2_147_483_647
        ? quota
        : 3;
    expect((await success(h.app, id)).agent.guest_daily_quota).toBe(expected);
  },
);

it.each(['on', 'true', 1, false, true] as const)(
  '[AC-F1-02c#13] agent.require_phone=%j 只认 JSON true',
  async (value) => {
    const id = await configured(h, { 'agent.require_phone': value });
    expect((await success(h.app, id)).agent.require_phone).toBe(value === true);
  },
);

it.each([100, 1000])(
  '[AC-F1-02c#14] 灰度 %i bp：精确边界两侧、游客设备哈希、无主体稳定版',
  async (percent) => {
    const id = await configured(h, {
      'h5_release.canary': { version: 'canary-v2', percent_bp: percent },
    });
    const below = subjectWhere((subject) => bucket(id, subject) === percent - 1);
    const edge = subjectWhere((subject) => bucket(id, subject) === percent);
    for (const [subject, expected] of [
      [below, 'canary-v2'],
      [edge, 'stable-v1'],
      [below, 'canary-v2'],
    ] as const) {
      expect((await success(h.app, id, { 'x-device-id': subject })).h5_release).toEqual({
        version: expected,
      });
    }
    expect((await success(h.app, id)).h5_release).toEqual({ version: 'stable-v1' });
  },
);

it.each([0, 10_000])(
  '[AC-F1-02c#15] percent_bp=%i 覆盖登录、游客、有无分桶主体',
  async (percent) => {
    const id = await configured(h, {
      'h5_release.canary': { version: 'canary-v2', percent_bp: percent },
    });
    const device = await registerDevice(h, id);
    const account = await session(h, id, device);
    for (const extra of [{ 'x-device-id': device.device_id }, account.headers]) {
      expect((await success(h.app, id, extra)).h5_release).toEqual({
        version: percent === 0 ? 'stable-v1' : 'canary-v2',
      });
    }
    expect((await success(h.app, id)).h5_release).toEqual({ version: 'stable-v1' });
  },
);

it('[AC-F1-02c#16] 同设备登录前后改用 user_id；同用户重读、换裸设备头均稳定', async () => {
  const id = await configured(h);
  const device = await registerDevice(h, id);
  let account = await session(h, id, device);
  // Force distinct sides instead of relying on random user/device IDs landing differently.
  for (let i = 0; i < 8 && bucket(id, account.user.id) === bucket(id, device.device_id); i += 1) {
    account = await session(h, id, device);
  }
  const userBucket = bucket(id, account.user.id);
  const deviceBucket = bucket(id, device.device_id);
  expect(userBucket).not.toBe(deviceBucket);
  const percent = Math.max(userBucket, deviceBucket);
  await seedConfig(h.db, id, {
    'h5_release.canary': { version: 'canary-v2', percent_bp: percent },
  });
  const expectedUser = userBucket < percent ? 'canary-v2' : 'stable-v1';
  const expectedGuest = deviceBucket < percent ? 'canary-v2' : 'stable-v1';
  expect(expectedUser).not.toBe(expectedGuest);
  expect((await success(h.app, id, { 'x-device-id': device.device_id })).h5_release).toEqual({
    version: expectedGuest,
  });
  const opposite = subjectWhere(
    (subject) => bucket(id, subject) < percent !== userBucket < percent,
  );
  for (let i = 0; i < 8; i += 1) {
    expect(
      (
        await success(h.app, id, {
          ...account.headers,
          'x-device-id': i % 2 === 0 ? device.device_id : opposite,
        })
      ).h5_release,
    ).toEqual({ version: expectedUser });
  }
  // An absent raw header must still use the authenticated user.
  expect((await success(h.app, id, account.headers)).h5_release).toEqual({ version: expectedUser });
});

it('[AC-F1-02c#17] 灰度哈希包含 app_id，同一游客主体在两个 app 命中不同桶', async () => {
  const values = { 'h5_release.canary': { version: 'canary-v2', percent_bp: 1000 } };
  const first = await configured(h, values);
  const second = await configured(h, values);
  const subject = subjectWhere((s) => bucket(first, s) < 1000 && bucket(second, s) >= 1000);
  expect((await success(h.app, first, { 'x-device-id': subject })).h5_release).toEqual({
    version: 'canary-v2',
  });
  expect((await success(h.app, second, { 'x-device-id': subject })).h5_release).toEqual({
    version: 'stable-v1',
  });
});

it.each([
  undefined,
  null,
  { version: '', percent_bp: 1000 },
  { version: 'v2' },
  { version: 'v2', percent_bp: -1 },
  { version: 'v2', percent_bp: 10_001 },
  { version: 'v2', percent_bp: 1.5 },
  { version: 'v2', percent_bp: '10000' },
] satisfies (Json | undefined)[])(
  '[AC-F1-02c#18] 灰度缺失、null 或形状非法 %j 回稳定版；仅非法非 null 配置要求 warn',
  async (value) => {
    const id = await configured(h, value === undefined ? {} : { 'h5_release.canary': value });
    const start = h.logs.length;
    expect(
      (await success(h.app, id, { 'x-device-id': '019a0000-0000-7000-8000-000000000001' }))
        .h5_release,
    ).toEqual({ version: 'stable-v1' });
    if (value !== undefined && value !== null) {
      expectLog(h.logs.slice(start), 40, 'h5_release.canary');
    }
  },
);

it.each([
  [47, 1],
  [48, 2],
  [23, null],
  [24, 1],
  [undefined, null],
  [36.5, null],
  ['48', null],
  [0, null],
  [-24, null],
  [null, null],
  [2_147_483_647, 89_478_485],
  [2_147_483_648, null],
] satisfies [Json | undefined, number | null][])(
  '[AC-F1-02c#19] claim.window_hours=%j 向下取整为 %j 天，不下发小时',
  async (hours, days) => {
    const id = await configured(h, hours === undefined ? {} : { 'claim.window_hours': hours });
    const data = await success(h.app, id);
    expect(data.claim).toEqual({ window_days: days });
    expect(JSON.stringify(data)).not.toContain('window_hours');
  },
);

// Whole-value validation: invalid members invalidate a dictionary/array rather than being
// silently dropped. The same schema is used to validate the resulting HTTP response.
const optionalCases: { key: string; value: Json; path: string[]; expected: unknown }[] = [
  { key: 'dict_version', value: 12, path: ['dict_version'], expected: '0' },
  { key: 'share_domains', value: ['valid.example.test', 7], path: ['share_domains'], expected: [] },
  { key: 'texts', value: { valid: 'keep?', invalid: 7 }, path: ['texts'], expected: {} },
  {
    key: 'features.flags',
    value: { custom: true, bad: 'true' },
    path: ['features', 'flags'],
    // F1-02zzzf：收紧为单态（F1-02zzze 已合并）
    expected: {
      'external_page.union_host_block': true,
      'earnings.dashboard.visible': true,
      product_feedback: true,
      jd_plus_note: true,
    },
  },
  {
    key: 'help_links',
    value: {
      valid: { route: 'Help', params: { article_id: 'one' } },
      bad: { route: 'Home', params: { article_id: 'two' } },
    },
    path: ['help_links'],
    expected: {},
  },
  {
    key: 'help_links',
    value: { bad: { route: 'Help', params: { article_id: '' } } },
    path: ['help_links'],
    expected: {},
  },
  {
    key: 'help_links',
    value: { bad: { route: 'Help', params: { article_id: 'one', extra: 1 } } },
    path: ['help_links'],
    expected: {},
  },
  {
    key: 'external_hosts',
    value: ['valid.example.test', ''],
    path: ['external_hosts'],
    expected: [],
  },
  { key: 'agent.examples', value: ['valid', false], path: ['agent', 'examples'], expected: [] },
  { key: 'agent.filing_text', value: 1, path: ['agent', 'filing_text'], expected: '' },
  { key: 'invite.backfill_hours', value: -1, path: ['invite', 'backfill_hours'], expected: 168 },
  {
    key: 'invite.backfill_hours',
    value: 2_147_483_648,
    path: ['invite', 'backfill_hours'],
    expected: 168,
  },
  {
    key: 'invite.bind_phone_guide',
    value: 'false',
    path: ['invite', 'bind_phone_guide'],
    expected: true,
  },
  { key: 'invite.before_buy_tip', value: 0, path: ['invite', 'before_buy_tip'], expected: true },
  {
    key: 'external_page.nav_host_sample_bp',
    value: 10_001,
    path: ['external_page', 'nav_host_sample_bp'],
    expected: 1000,
  },
  {
    key: 'external_page.nav_host_sample_bp',
    value: 0.5,
    path: ['external_page', 'nav_host_sample_bp'],
    expected: 1000,
  },
  {
    key: 'app_update.recheck_interval_sec',
    value: 0,
    path: ['app_update', 'recheck_interval_sec'],
    expected: 1800,
  },
  {
    key: 'app_update.recheck_interval_sec',
    value: '1800',
    path: ['app_update', 'recheck_interval_sec'],
    expected: 1800,
  },
  ...['jump_tip', 'clipboard', 'auth_tips', 'compliance', 'display'].flatMap((key) =>
    [null, [], 'text'].map((value) => ({ key, value, path: [key], expected: {} })),
  ),
];
it.each(optionalCases)(
  '[AC-F1-02c#20] 可选键 $key=$value 形状非法整键回缺省并 warn',
  async ({ key, value, path, expected }) => {
    const id = await configured(h, { [key]: value });
    const start = h.logs.length;
    const data = await success(h.app, id);
    const actual = path.reduce<unknown>(
      (value, part) => (value as Record<string, unknown> | null | undefined)?.[part],
      data,
    );
    expect(actual).toEqual(expected);
    expectLog(h.logs.slice(start), 40, key);
  },
);

it('[AC-F1-02c#21] link_patterns 只取平台规格表，忽略同名配置及契约外键', async () => {
  const id = await configured(h, {
    link_patterns: { version: 'database-poison', rules: [] },
    platform_icons: { taobao: {} },
    lkg_max_age_sec: 1,
    config_version: 'private',
    bridge_disabled_methods: ['login'],
    rank_platforms: ['taobao'],
    'features.rank_platforms': ['jd'],
  });
  const data = await success(h.app, id);
  expect(data.link_patterns).toEqual(getLinkPatterns());
  // platform_icons never comes from a same-named config row: absent before F1-02d, {} after it.
  expect([undefined, {}]).toContainEqual(data.platform_icons);
  // F1-02h reads config.lkg_max_age_sec, bridge.disabled_methods and the channel whitelist,
  // and derives config_version from the ETag: the same-named rows above never show through.
  expect([undefined, 604_800]).toContainEqual(data.lkg_max_age_sec);
  expect(data.config_version).not.toBe('private');
  expect([undefined, []]).toContainEqual(data.bridge_disabled_methods);
  expect(data).not.toHaveProperty('rank_platforms');
  expect([undefined, []]).toContainEqual(data.features.rank_platforms);
});

it('[AC-F1-02c#22] 各 app 配置和缓存隔离，他 app 的必填键不能补齐本 app', async () => {
  const first = await configured(h, {
    texts: { owner: 'first' },
    'h5_release.stable': 'first-stable',
  });
  const second = await configured(h, {
    texts: { owner: 'second' },
    'h5_release.stable': 'second-stable',
  });
  for (const id of [first, second, first]) {
    const data = await success(h.app, id);
    const owner = id === first ? 'first' : 'second';
    expect(data.texts).toEqual({ owner });
    expect(data.h5_release).toEqual({ version: `${owner}-stable` });
  }
  const incomplete = appId();
  const { kf: _kf, ...withoutKf } = REQUIRED;
  void _kf;
  await seedConfig(h.db, incomplete, { ...withoutKf, texts: { owner: 'incomplete' } });
  await failure(await read(h.app, incomplete));
});

it('[AC-F1-02c#23] 配置改动在注入时钟推进 60 秒后反映到响应', async () => {
  const id = await configured(h, { texts: { value: 'before' } });
  expect((await success(h.app, id)).texts).toEqual({ value: 'before' });
  await changeConfig(h, id, 'texts', { value: 'after' });
  expect((await success(h.app, id)).texts).toEqual({ value: 'after' });
});

it('[AC-F1-02c#24] 无库句柄仍注册 api 路由且每次 50001；stream/admin 不注册', async () => {
  const api = await h.start('api', null);
  expect(api.getHttpAdapter().getInstance().hasRoute({ method: 'GET', url: '/v1/config' })).toBe(
    true,
  );
  await failure(await read(api, appId()));
  await failure(await read(api, appId()));
  for (const entry of ['stream', 'admin'] as const) {
    const other = await h.start(entry, null);
    expect(
      other.getHttpAdapter().getInstance().hasRoute({ method: 'GET', url: '/v1/config' }),
    ).toBe(false);
    expect((await read(other, appId())).statusCode).toBe(404);
  }
});

it('[AC-F1-02c#25] config_items 读失败即 50001，不回成功缺省或过期数据', async () => {
  const id = await configured(h);
  let unavailable = false;
  const failingDb = h.db.withPlugin({
    transformQuery({ node }) {
      if (
        unavailable &&
        node.kind === 'SelectQueryNode' &&
        JSON.stringify(node).includes('config_items')
      ) {
        throw new Error('synthetic config storage read failure');
      }
      return node;
    },
    transformResult({ result }) {
      return Promise.resolve(result);
    },
  });
  const app = await h.start('api', failingDb);
  expect((await success(app, id)).h5_release).toEqual({ version: 'stable-v1' });
  unavailable = true;
  h.deps.clock.advanceMs(60_000);
  try {
    await failure(await read(app, id));
  } finally {
    unavailable = false;
  }
  expect((await success(app, id)).h5_release).toEqual({ version: 'stable-v1' });
});
