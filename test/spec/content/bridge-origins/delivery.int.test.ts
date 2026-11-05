import { createDb, destroyDb } from '@couli/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { configured, changeConfig, headers, success } from '../config/kit.ts';
import { harness, type Harness } from './http-kit.ts';
import { verified } from './jws-kit.ts';

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

it('[AC-F1-02zzzb#13] /v1/config 缺配置下发可验签默认白名单，载荷绑定 app_id 和 test 环境', async () => {
  const id = await configured(h);
  const data = await success(h.app, id);
  const payload = verified(data.bridge_origins, h.signing.publicKey, 'fixture-config-key');
  expect(payload).toMatchObject({
    v: 1,
    app_id: id,
    env: 'test',
    origins: ['https://h5.example.test'],
  });
  expect(payload.version).toBeLessThanOrEqual(1);
  const logs = h.logs.join('\n');
  expect(logs).not.toContain(h.signingPem);
  expect(logs).not.toContain('-----BEGIN PRIVATE KEY-----');
  expect(logs).not.toContain((data.bridge_origins as { jws: string }).jws);
});

it('[AC-F1-02zzzb#14] 同版本重复请求 JWS 和 ETag 完全相同；同内容增版本仍更换两者', async () => {
  const value = { origins: ['https://h5.example.test', 'https://bridge.example.test:8443'] };
  const id = await configured(h, { bridge_origins: value });
  const request = (extra: Record<string, string> = {}) =>
    h.app.inject({ method: 'GET', url: '/v1/config', headers: { ...headers(id), ...extra } });
  const first = await request();
  expect(first.statusCode).toBe(200);
  const one = first.json<{ data: { bridge_origins: { jws: string }; config_version: string } }>()
    .data;
  expect(verified(one.bridge_origins, h.signing.publicKey, 'fixture-config-key')).toMatchObject({
    version: 1,
    origins: value.origins,
  });
  const second = await request();
  expect(second.statusCode).toBe(200);
  const two = second.json<{ data: typeof one }>().data;
  expect(two).toEqual(one);
  expect(two.bridge_origins.jws).toBe(one.bridge_origins.jws);
  expect(second.headers['etag']).toBe(first.headers['etag']);
  expect(first.headers['etag']).toBe(`"${one.config_version}"`);
  const hit = await request({ 'if-none-match': String(first.headers['etag']) });
  expect(hit.statusCode).toBe(304);
  await changeConfig(h, id, 'bridge_origins', value);
  const changed = await request({ 'if-none-match': String(first.headers['etag']) });
  expect(changed.statusCode).toBe(200);
  const next = changed.json<{ data: { bridge_origins: { jws: string } } }>().data;
  expect(verified(next.bridge_origins, h.signing.publicKey, 'fixture-config-key').version).toBe(2);
  expect(next.bridge_origins.jws).not.toBe(one.bridge_origins.jws);
  expect(changed.headers['etag']).not.toBe(first.headers['etag']);
});

it('[AC-F1-02zzzb#15] 同版本的不同品牌请求只拿自己的签名白名单', async () => {
  const a = await configured(h, { bridge_origins: { origins: ['https://h5.example.test'] } });
  const b = await configured(h, {
    h5_base_url: 'https://b.example.test/app/',
    bridge_origins: { origins: ['https://b.example.test'] },
  });
  const first = await success(h.app, a);
  const second = await success(h.app, b);
  expect(verified(first.bridge_origins, h.signing.publicKey, 'fixture-config-key')).toMatchObject({
    app_id: a,
    version: 1,
    origins: ['https://h5.example.test'],
  });
  expect(verified(second.bridge_origins, h.signing.publicKey, 'fixture-config-key')).toMatchObject({
    app_id: b,
    version: 1,
    origins: ['https://b.example.test'],
  });
  expect(second.bridge_origins).not.toEqual(first.bridge_origins);
});

it.each([
  { origins: [] },
  { origins: ['http://h5.example.test'] },
  { origins: ['https://*.example.test'] },
  { origins: ['https://h5.example.test/path'] },
  { origins: ['https://unrelated.example.test'] },
])('[AC-F1-02zzzb#20] 已存非法白名单 %j 不被签发，仍返回默认签名白名单', async (value) => {
  const id = await configured(h, { bridge_origins: value });
  const data = await success(h.app, id);
  expect(verified(data.bridge_origins, h.signing.publicKey, 'fixture-config-key')).toMatchObject({
    app_id: id,
    env: 'test',
    origins: ['https://h5.example.test'],
  });
});
