import { createDb, destroyDb } from '@couli/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { configured, expectLog, success } from '../config/kit.ts';
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

// D10-620: moved unchanged invalid inputs and warn requirement from F1-02c#20.
it.each([{ value: null }, { value: [] }, { value: 'text' }])(
  '[AC-F1-02zzzb#21] 已存 bridge_origins=$value 形状非法时下发默认签名白名单并 warn',
  async ({ value }) => {
    const id = await configured(h, { bridge_origins: value });
    const start = h.logs.length;
    const data = await success(h.app, id);
    expect(verified(data.bridge_origins, h.signing.publicKey, 'fixture-config-key')).toMatchObject({
      app_id: id,
      env: 'test',
      origins: ['https://h5.example.test'],
    });
    expectLog(h.logs.slice(start), 40, 'bridge_origins');
  },
);
