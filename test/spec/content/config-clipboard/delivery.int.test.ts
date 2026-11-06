// Scope: F1-02j §9 / CT-02o. Observe real config_items only through GET /v1/config.
// Each case includes malformed consent_version: existing defaults/flags alone would be green.
// Paired valid/absent inputs distinguish validation from unconditional clipboard suppression.
import { createDb, destroyDb } from '@couli/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { configured, harness, login, success, warnings, type Harness, type Json } from './kit.ts';

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

// F1-02zzzd: S-10（F1-02zzze）前的两态过渡，合并后收紧为单态
// F1-02zzze adds derived flags product_feedback (feedback.enabled) and jd_plus_note
// (detail.jd_plus_note.enabled): only a false source turns them off. These cases write neither
// source, so each key, when present, must be exactly true; it is then removed for the original
// exact comparison. Absent keys leave the flags untouched.
const PENDING_DERIVED = ['product_feedback', 'jd_plus_note'] as const;
function settled(flags: unknown): unknown {
  if (typeof flags !== 'object' || flags === null || Array.isArray(flags)) return flags;
  const copy = { ...(flags as Record<string, unknown>) };
  for (const key of PENDING_DERIVED) {
    if (Object.hasOwn(copy, key)) {
      expect(copy[key], `features.flags.${key}`).toBe(true);
      delete copy[key];
    }
  }
  return copy;
}

const DERIVED_DEFAULTS = {
  'external_page.union_host_block': true,
  'earnings.dashboard.visible': true,
};
const MARKER = 'clipboard-rule-test-value';

it('[AC-F1-02j#1] 有效版本及自由字段原样下发，1/64 字符有效，65 字符整键回退', async () => {
  // JSON Schema length counts Unicode code points, not UTF-16 code units; no numeric format
  // or trimming restriction exists in ConfigClipboard.
  for (const version of ['2026-10-17', 'x', ' ', 'v'.repeat(64), '😀'.repeat(64)]) {
    const clipboard = {
      consent_version: version,
      min_len: 10,
      enabled: false,
      extra: { nullable: null, rules: ['demo', { enabled: true }] },
    };
    const id = await configured(h, { clipboard });
    const start = h.logs.length;
    expect((await success(h, id)).clipboard).toEqual(clipboard);
    expect(warnings(h, start, id, 'clipboard')).toEqual([]);
  }
  const id = await configured(h, {
    clipboard: { consent_version: 'v'.repeat(65), min_len: 10 },
  });
  const start = h.logs.length;
  expect((await success(h, id)).clipboard).toEqual({});
  expect(warnings(h, start, id, 'clipboard')).not.toHaveLength(0);
});

it('[AC-F1-02j#2] 缺行或缺版本不补字段且仍成功；显式空版本须整键回退', async () => {
  const absent = await configured(h);
  const startAbsent = h.logs.length;
  expect((await success(h, absent)).clipboard).toEqual({});
  expect(warnings(h, startAbsent, absent, 'clipboard')).toEqual([]);
  for (const clipboard of [{}, { enabled: false, min_len: 10 }]) {
    const id = await configured(h, { clipboard });
    const start = h.logs.length;
    const data = await success(h, id);
    expect(data.clipboard).toEqual(clipboard);
    expect(data.clipboard).not.toHaveProperty('consent_version');
    expect(warnings(h, start, id, 'clipboard')).toEqual([]);
  }
  for (const clipboard of [null, [], 7, false, 'not-an-object']) {
    const id = await configured(h, { clipboard });
    const start = h.logs.length;
    expect((await success(h, id)).clipboard).toEqual({});
    expect(warnings(h, start, id, 'clipboard')).not.toHaveLength(0);
  }
  const id = await configured(h, { clipboard: { consent_version: '', enabled: false } });
  const start = h.logs.length;
  expect((await success(h, id)).clipboard).toEqual({});
  expect(warnings(h, start, id, 'clipboard')).not.toHaveLength(0);
});

it.each([
  ['number', 7],
  ['empty', ''],
  ['null', null],
  ['object', {}],
  ['boolean', false],
  ['array', []],
  ['65 characters', 'v'.repeat(65)],
  ['65 Unicode code points', '😀'.repeat(65)],
] satisfies [string, Json][])(
  '[AC-F1-02j#3] consent_version 为 %s 时整键 {}、200、warn 键名且不记录值',
  async (_name, version) => {
    const id = await configured(h, {
      clipboard: { consent_version: version, min_len: 10, private_marker: MARKER },
      texts: { preserved: 'other-config' },
    });
    const start = h.logs.length;
    const data = await success(h, id);
    expect(data.clipboard).toEqual({});
    expect(data.texts).toEqual({ preserved: 'other-config' });
    const entries = warnings(h, start, id, 'clipboard');
    expect(entries).not.toHaveLength(0);
    for (const entry of entries) {
      expect(entry).not.toHaveProperty('value');
      expect(entry).not.toHaveProperty('config_value');
      expect(entry).not.toHaveProperty('consent_version');
    }
    expect(h.logs.slice(start).join('\n')).not.toContain(MARKER);
  },
);

it('[AC-F1-02j#4] 不读取拆开的 consent_version 行，也不拿它修复非法整键', async () => {
  const splitOnly = await configured(h, { 'clipboard.consent_version': 'x' });
  expect((await success(h, splitOnly)).clipboard).toEqual({});
  const valid = await configured(h, {
    clipboard: { consent_version: 'whole-key', min_len: 10 },
    'clipboard.consent_version': 'split-key',
  });
  expect((await success(h, valid)).clipboard).toEqual({
    consent_version: 'whole-key',
    min_len: 10,
  });
  const invalid = await configured(h, {
    clipboard: { consent_version: null, min_len: 10 },
    'clipboard.consent_version': 'x',
  });
  const start = h.logs.length;
  expect((await success(h, invalid)).clipboard).toEqual({});
  expect(warnings(h, start, invalid, 'clipboard')).not.toHaveLength(0);
});

it.each([
  ['ios', false, true],
  ['android', true, false],
  ['harmony', false, false],
] as const)(
  '[AC-F1-02j#5] %s 请求遇到非法 clipboard，仍透传 auto_read 且只覆盖两个既有派生键',
  async (platform, unionBlock, dashboard) => {
    const base = {
      'clipboard.auto_read.ios': false,
      'clipboard.auto_read.android': true,
      'clipboard.enabled.taobao': false,
      custom: true,
      'external_page.union_host_block': !unionBlock,
      'earnings.dashboard.visible': !dashboard,
    };
    const id = await configured(h, {
      clipboard: { consent_version: 7, min_len: 10 },
      'features.flags': base,
      'external_page.union_host_block': unionBlock,
      'earnings.dashboard.enabled': dashboard,
    });
    const start = h.logs.length;
    const data = await success(h, id, { 'x-platform': platform });
    expect(settled(data.features.flags)).toEqual({
      ...base,
      'external_page.union_host_block': unionBlock,
      'earnings.dashboard.visible': dashboard,
    });
    expect(data.features.flags).not.toHaveProperty('clipboard.auto_read.harmony');
    expect(data.clipboard).toEqual({});
    expect(warnings(h, start, id, 'clipboard')).not.toHaveLength(0);
    expect(warnings(h, start, id, 'features.flags')).toEqual([]);
  },
);

it('[AC-F1-02j#6] auto_read 混入 off 时整个基础 flags 回退，与 clipboard 分别 warn', async () => {
  const id = await configured(h, {
    clipboard: { consent_version: {}, min_len: 10 },
    'features.flags': {
      'clipboard.auto_read.ios': 'off',
      'clipboard.auto_read.android': true,
      'clipboard.auto_read.harmony': false,
      custom: true,
      'external_page.union_host_block': false,
      'earnings.dashboard.visible': false,
    },
  });
  const start = h.logs.length;
  const data = await success(h, id);
  expect(settled(data.features.flags)).toEqual(DERIVED_DEFAULTS);
  expect(data.clipboard).toEqual({});
  expect(warnings(h, start, id, 'features.flags')).not.toHaveLength(0);
  expect(warnings(h, start, id, 'clipboard')).not.toHaveLength(0);
});

it('[AC-F1-02j#7] 不读取单独 auto_read 行，不补缺键，不用它覆盖基础字典', async () => {
  for (const flags of [undefined, { 'clipboard.auto_read.ios': true }]) {
    const id = await configured(h, {
      clipboard: { consent_version: 'valid' },
      'clipboard.auto_read.ios': false,
      'features.clipboard.auto_read.ios': false,
      ...(flags === undefined ? {} : { 'features.flags': flags }),
    });
    expect(settled((await success(h, id)).features.flags)).toEqual({
      ...DERIVED_DEFAULTS,
      ...flags,
    });
  }
  const id = await configured(h, {
    clipboard: { consent_version: '' },
    'clipboard.auto_read.ios': false,
    'features.clipboard.auto_read.ios': false,
    'features.flags': { 'clipboard.auto_read.harmony': false },
  });
  const start = h.logs.length;
  const data = await success(h, id);
  expect(settled(data.features.flags)).toEqual({
    ...DERIVED_DEFAULTS,
    'clipboard.auto_read.harmony': false,
  });
  expect(data.clipboard).toEqual({});
  expect(warnings(h, start, id, 'clipboard')).not.toHaveLength(0);
});

it('[AC-F1-02j#8] 登录与游客交替读取各自 app_id，非法配置回退不污染另一 app', async () => {
  const clipboard = { consent_version: 'app-a-version', min_len: 10 };
  const a = await configured(h, {
    clipboard,
    'features.flags': { 'clipboard.auto_read.ios': false },
  });
  const b = await configured(h, {
    clipboard: { consent_version: 7, min_len: 20 },
    'features.flags': { 'clipboard.auto_read.ios': true, 'clipboard.auto_read.harmony': false },
  });
  const aLogin = await login(h, a);
  const bLogin = await login(h, b);
  const callers = [
    { id: a, headers: {}, clipboard, flags: { 'clipboard.auto_read.ios': false } },
    {
      id: b,
      headers: bLogin,
      clipboard: {},
      flags: { 'clipboard.auto_read.ios': true, 'clipboard.auto_read.harmony': false },
    },
    { id: a, headers: aLogin, clipboard, flags: { 'clipboard.auto_read.ios': false } },
    {
      id: b,
      headers: {},
      clipboard: {},
      flags: { 'clipboard.auto_read.ios': true, 'clipboard.auto_read.harmony': false },
    },
    { id: a, headers: {}, clipboard, flags: { 'clipboard.auto_read.ios': false } },
  ];
  for (const caller of callers) {
    const start = h.logs.length;
    const data = await success(h, caller.id, caller.headers);
    expect(data.clipboard).toEqual(caller.clipboard);
    expect(settled(data.features.flags)).toEqual({ ...DERIVED_DEFAULTS, ...caller.flags });
    if (caller.id === b) {
      expect(warnings(h, start, b, 'clipboard')).not.toHaveLength(0);
    } else {
      expect(warnings(h, start, a, 'clipboard')).toEqual([]);
    }
  }
});
