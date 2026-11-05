// F1-02h §9.2–9.3. HTTP is the oracle boundary; each case owns a fresh app_id.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { afterAll, beforeAll, expect, it, onTestFinished } from 'vitest';
import { harness as signedHarness } from '../bridge-origins/http-kit.ts';
import { expectAppBoundConfig } from '../bridge-origins/jws-kit.ts';
import { getMaterialChannels } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  PLATFORMS,
  REQUIRED,
  appId,
  bucket,
  changeConfig,
  configured,
  failure,
  harness,
  iconAdmin,
  notModified,
  read,
  registerDevice,
  saveVersion,
  seedConfig,
  session,
  setCurrent,
  snapshot,
  type Harness,
  type Json,
} from './kit.ts';

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

it('[AC-F1-02h#1] 200 契约、强 ETag 与最终 data 的独立 SHA256 oracle 一致', async () => {
  const id = await configured(h, {
    texts: { z: '中文与转义"\n', a: 'first', '10': 'ten', '2': 'two' },
    display: { z: [{ z: 2, a: 1 }, null, true], a: { z: false, a: '值' } },
    'config.lkg_max_age_sec': 3600,
    'bridge.disabled_methods': ['ext.openApp', 'clipboard.read'],
  });
  const { data } = await snapshot(h.app, id);
  expect(data.lkg_max_age_sec).toBe(3600);
  expect(data.bridge_disabled_methods).toEqual(['ext.openApp', 'clipboard.read']);
});

it('[AC-F1-02h#2] 同一 viewer 重读、60 秒缓存到期和相同配置的另一个 app 均不改变 ETag', async () => {
  const h = await signedHarness(db, database.urlFor('couli_app'), redis.url);
  onTestFinished(() => h.close());
  const id = await configured(h);
  const device = await registerDevice(h, id);
  const viewer = await session(h, id, device);
  const first = await snapshot(h.app, id, viewer.headers);
  const second = await snapshot(h.app, id, viewer.headers);
  expect(second.etag).toBe(first.etag);
  h.deps.clock.advanceMs(60_001);
  expect((await snapshot(h.app, id, viewer.headers)).etag).toBe(first.etag);
  const otherId = await configured(h);
  const otherViewer = await session(h, otherId, await registerDevice(h, otherId));
  const other = await snapshot(h.app, otherId, otherViewer.headers);
  expectAppBoundConfig(first, id, other, otherId, h.signing.publicKey);
});

it('[AC-F1-02h#3] texts 改动沿用 60 秒缓存，到期后旧 ETag 得到 200 和新内容', async () => {
  const id = await configured(h, { texts: { value: 'before' } });
  const first = await snapshot(h.app, id);
  await changeConfig(h, id, 'texts', { value: 'after' }, 0);
  h.deps.clock.advanceMs(59_999);
  notModified(await read(h.app, id, { 'if-none-match': first.etag }), first.etag);
  h.deps.clock.advanceMs(1);
  const next = await snapshot(h.app, id, { 'if-none-match': first.etag });
  expect(next.data.texts).toEqual({ value: 'after' });
  expect(next.etag).not.toBe(first.etag);
});

it('[AC-F1-02h#4] h5 灰度两侧用户得到不同 ETag，A 的 ETag 不能让 B 得到 304', async () => {
  const id = await configured(h, {
    'h5_release.canary': { version: 'canary-v2', percent_bp: 5000 },
  });
  const device = await registerDevice(h, id);
  const candidates = Array.from({ length: 128 }, () => randomUUID());
  const low = candidates.find((uid) => bucket(id, uid) < 5000);
  const high = candidates.find((uid) => bucket(id, uid) >= 5000);
  expect(low).toBeDefined();
  expect(high).toBeDefined();
  const a = await session(h, id, device, 'full', low!);
  const b = await session(h, id, device, 'full', high!);
  const first = await snapshot(h.app, id, a.headers);
  const second = await snapshot(h.app, id, { ...b.headers, 'if-none-match': first.etag });
  expect(first.data.h5_release).toEqual({ version: 'canary-v2' });
  expect(second.data.h5_release).toEqual({ version: 'stable-v1' });
  expect(second.etag).not.toBe(first.etag);
  expect((await snapshot(h.app, id, a.headers)).etag).toBe(first.etag);
});

it('[AC-F1-02h#5] agent 名单内外两人 ETag 不同，缓存不能复用另一人的结果', async () => {
  const inside = randomUUID();
  const id = await configured(h, {
    'agent.enabled': true,
    'agent.whitelist_only': true,
    'agent.whitelist_user_ids': [inside],
  });
  const device = await registerDevice(h, id);
  const a = await session(h, id, device, 'full', inside);
  const b = await session(h, id, device);
  const first = await snapshot(h.app, id, a.headers);
  const second = await snapshot(h.app, id, { ...b.headers, 'if-none-match': first.etag });
  expect(first.data.agent?.enabled).toBe(true);
  expect(second.data.agent?.enabled).toBe(false);
  expect(second.etag).not.toBe(first.etag);
});

it('[AC-F1-02h#6] platform_icons 发布后立即参与哈希，旧 ETag 不能遮蔽最新标识', async () => {
  const id = await configured(h);
  const first = await snapshot(h.app, id);
  expect(first.data.platform_icons).toEqual({});
  const a = await iconAdmin(h, id);
  const saved = await saveVersion(h, a, 'taobao', 1);
  await setCurrent(h, a, 'taobao', 1);
  const next = await snapshot(h.app, id, { 'if-none-match': first.etag });
  expect(next.data.platform_icons?.taobao).toMatchObject({ sha256: saved.sha256, version: 1 });
  expect(next.etag).not.toBe(first.etag);
});

it.each(['exact', 'weak', 'list', 'weak-list', 'wildcard'] as const)(
  '[AC-F1-02h#7] If-None-Match %s 命中回 304 空 body，无 JSON，带 ETag 和 X-Trace-Id',
  async (kind) => {
    const id = await configured(h);
    const { etag } = await snapshot(h.app, id);
    const match = {
      exact: etag,
      weak: `W/${etag}`,
      list: `"x", ${etag}`,
      'weak-list': `  "x" , W/${etag} , "other"  `,
      wildcard: '*',
    }[kind];
    notModified(await read(h.app, id, { 'if-none-match': match }), etag);
  },
);

it.each(['stale', 'bare', 'weak-bare', 'lowercase', 'junk', 'unclosed'] as const)(
  '[AC-F1-02h#8] 不命中或语法非法的 %s 返回 200 完整内容',
  async (kind) => {
    const id = await configured(h);
    const first = await snapshot(h.app, id);
    const tag = first.etag.slice(1, -1);
    const miss = {
      stale: '"abc"',
      bare: tag,
      'weak-bare': `W/${tag}`,
      lowercase: `w/${first.etag}`,
      junk: `${first.etag}junk`,
      unclosed: `"${tag}`,
    }[kind];
    const next = await snapshot(h.app, id, { 'if-none-match': miss });
    expect(next.data).toEqual(first.data);
    expect(next.etag).toBe(first.etag);
  },
);

it.each(Object.keys(REQUIRED))(
  '[AC-F1-02h#9] 必填键 %s 缺失时 If-None-Match * 仍回 50001',
  async (missing) => {
    // Same test checks the new conditional response, so the pre-feature route cannot go green.
    const valid = await configured(h);
    const current = await snapshot(h.app, valid);
    notModified(await read(h.app, valid, { 'if-none-match': '*' }), current.etag);
    const id = appId();
    await seedConfig(
      h.db,
      id,
      Object.fromEntries(Object.entries(REQUIRED).filter(([key]) => key !== missing)),
    );
    await failure(await read(h.app, id, { 'if-none-match': '*' }));
  },
);

it('[AC-F1-02h#10] 缓存到期后读口失败，精确 ETag 和 * 都不能跳过读取', async () => {
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
  const first = await snapshot(app, id);
  unavailable = true;
  h.deps.clock.advanceMs(60_000);
  try {
    await failure(await read(app, id, { 'if-none-match': first.etag }));
    await failure(await read(app, id, { 'if-none-match': '*' }));
  } finally {
    unavailable = false;
  }
});

it.each([1, 3600, 2_147_483_647])(
  '[AC-F1-02h#11] config.lkg_max_age_sec=%j 原值下发',
  async (value) => {
    const id = await configured(h, { 'config.lkg_max_age_sec': value });
    expect((await snapshot(h.app, id)).data.lkg_max_age_sec).toBe(value);
  },
);

it('[AC-F1-02h#12] 两键缺失取 604800 与 []，不记录配置非法 warn', async () => {
  const id = await configured(h);
  const start = h.logs.length;
  const { data } = await snapshot(h.app, id);
  expect(data.lkg_max_age_sec).toBe(604800);
  expect(data.bridge_disabled_methods).toEqual([]);
  const warnings = h.logs
    .slice(start)
    .map((line) => JSON.parse(line) as { level: number; event?: string });
  expect(
    warnings.filter(
      (entry) => entry.level === 40 && entry.event === 'content_config_value_invalid',
    ),
  ).toEqual([]);
});

it.each(
  ([0, -1, 1.5, '3600', 2_147_483_648, null, true, [], {}] satisfies Json[]).map((value) => ({
    value,
  })),
)('[AC-F1-02h#13] 非法 lkg=$value 整键取缺省并记录键名 warn', async ({ value }) => {
  const id = await configured(h, { 'config.lkg_max_age_sec': value });
  const start = h.logs.length;
  expect((await snapshot(h.app, id)).data.lkg_max_age_sec).toBe(604800);
  expect(h.logs.slice(start).map((line) => JSON.parse(line) as unknown)).toContainEqual(
    expect.objectContaining({
      level: 40,
      event: 'content_config_value_invalid',
      config_key: 'config.lkg_max_age_sec',
    }),
  );
});

it('[AC-F1-02h#14] bridge 方法按配置原序下发，不依赖 bridge.schema 的方法清单', async () => {
  const methods = ['ext.openApp', 'clipboard.read', 'customApi.newMethod9'];
  const id = await configured(h, { 'bridge.disabled_methods': methods });
  expect((await snapshot(h.app, id)).data.bridge_disabled_methods).toEqual(methods);
});

it.each(
  (
    [
      ['login'],
      ['clipboard.read', 7],
      ['a.b', 'a.b'],
      'clipboard.read',
      ['Clipboard.read'],
      ['clipboard.Read'],
      ['clipboard.read.extra'],
      null,
      {},
    ] satisfies Json[]
  ).map((value) => ({ value })),
)('[AC-F1-02h#15] 非法 bridge=$value 整键回 [] 并记录键名 warn', async ({ value }) => {
  const id = await configured(h, { 'bridge.disabled_methods': value });
  const start = h.logs.length;
  expect((await snapshot(h.app, id)).data.bridge_disabled_methods).toEqual([]);
  expect(h.logs.slice(start).map((line) => JSON.parse(line) as unknown)).toContainEqual(
    expect.objectContaining({
      level: 40,
      event: 'content_config_value_invalid',
      config_key: 'bridge.disabled_methods',
    }),
  );
});

it('[AC-F1-02h#16] 同名 config_items 不作为 lkg、bridge、config_version 的来源', async () => {
  const id = await configured(h, {
    lkg_max_age_sec: 1,
    bridge_disabled_methods: ['clipboard.read'],
    config_version: 'poison',
  });
  const { data } = await snapshot(h.app, id);
  expect(data.lkg_max_age_sec).toBe(604800);
  expect(data.bridge_disabled_methods).toEqual([]);
  expect(data.config_version).not.toBe('poison');
});

it('[AC-F1-02h#17] rank_platforms 总下发且只从物料频道派生，配置行和 features.flags 均不能覆盖（只认 sales / popularity，D10-422）', async () => {
  const spec = getMaterialChannels();
  const expected = PLATFORMS.filter((platform) =>
    spec.channels.some(
      (channel) =>
        channel.platform === platform &&
        channel.selectable &&
        (channel.sort_basis === 'sales' || channel.sort_basis === 'popularity'),
    ),
  );
  const plain = await configured(h);
  expect((await snapshot(h.app, plain)).data.features.rank_platforms).toEqual(expected);
  const poisoned = await configured(h, {
    'features.rank_platforms': ['taobao'],
    rank_platforms: ['jd'],
    'features.flags': { rank_platforms: true, 'features.rank_platforms': true },
  });
  const { data } = await snapshot(h.app, poisoned);
  expect(data.features.rank_platforms).toEqual(expected);
  expect(data).not.toHaveProperty('rank_platforms');
});

it('[AC-F1-02h#18] deletion_only 令牌仍能获取 200 ETag，随后条件请求回 304', async () => {
  const id = await configured(h);
  const viewer = await session(h, id, await registerDevice(h, id), 'deletion_only');
  const { etag } = await snapshot(h.app, id, viewer.headers);
  notModified(await read(h.app, id, { ...viewer.headers, 'if-none-match': etag }), etag);
});

it('[AC-F1-02h#19] 相同值仅提高数据库版本号不改变 ETag，数组换序会改变 ETag', async () => {
  const id = await configured(h, { 'bridge.disabled_methods': ['ext.openApp', 'clipboard.read'] });
  const first = await snapshot(h.app, id);
  await changeConfig(h, id, 'bridge.disabled_methods', ['ext.openApp', 'clipboard.read']);
  expect((await snapshot(h.app, id)).etag).toBe(first.etag);
  await changeConfig(h, id, 'bridge.disabled_methods', ['clipboard.read', 'ext.openApp']);
  const next = await snapshot(h.app, id, { 'if-none-match': first.etag });
  expect(next.data.bridge_disabled_methods).toEqual(['clipboard.read', 'ext.openApp']);
  expect(next.etag).not.toBe(first.etag);
});
