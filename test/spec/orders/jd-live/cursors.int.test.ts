// B1-04zt ②: the increment stream's rewind on createSyncCursorStore. expected names the row it must
// find; expected null means "insert when the stream has no row, otherwise do nothing and resolve
// false". rewind is optional on the port and missing before the implementation, so every call goes
// through rewindOf: that has to be an assertion failure here, not a TypeError.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createSyncCursorStore } from '../../../../apps/api/src/modules/orders/infra/sync-cursors.ts';
import type {
  OrderSyncWindow,
  SyncStream,
} from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';

const NOW = '2026-10-17T02:00:00.000Z';
const SEEDED = '2026-10-01T00:00:00.000Z';
const OLD = '2026-07-01T00:00:00.000Z';
const OTHER = '2026-07-02T00:00:00.000Z';
/** now − 90 days + 1 hour. */
const FLOOR = '2026-07-19T03:00:00.000Z';
const FLOOR_END = '2026-07-19T04:00:00.000Z';

// The shared integration global setup provisions the migrated template and injects its
// factory connection. Each file clones it; queries below use the ordinary application role.
let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

type Store = ReturnType<typeof createSyncCursorStore>;

/** What this test calls; a cast, as rewind is not on the store's type before the implementation. */
interface Rewinding {
  rewind?: (stream: SyncStream, expected: string | null, to: string) => Promise<boolean>;
}

async function rewindOf(
  store: Store,
  stream: SyncStream,
  expected: string | null,
  to: string,
): Promise<boolean | undefined> {
  const rewinding = store as unknown as Rewinding;
  expect(rewinding.rewind).toBeTypeOf('function');
  return rewinding.rewind?.(stream, expected, to);
}

async function scenario() {
  const clock = new FixedClock(NOW);
  const accountId = randomUUID();
  const appId = `jd-live-spec-${randomUUID()}`;
  await db
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: appId,
      platform: 'jd',
      account_name: `synthetic jd live account ${accountId}`,
      status: 'active',
      auth_status: 'active',
      sync_start_at: OLD,
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  const stream: SyncStream = {
    app_id: appId,
    platform: 'jd',
    union_account_id: accountId,
    query_kind: 'increment',
    scene: '-',
  };
  const rescan: SyncStream = { ...stream, query_kind: 'rescan' };
  return { clock, stream, rescan, store: createSyncCursorStore(db, clock) };
}

async function seed(stream: SyncStream, cursor = OLD) {
  await db
    .insertInto('sync_cursors')
    .values({ ...stream, cursor_at: cursor, updated_at: SEEDED })
    .execute();
}

async function rows(appId: string) {
  return db
    .selectFrom('sync_cursors')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

function windowFrom(stream: SyncStream, start: string, end: string): OrderSyncWindow {
  return { ...stream, query_kind: 'increment', scene: '-', window_start: start, window_end: end };
}

it('[AC-B1-04zt#16] expected 匹配：改到 to，updated_at 取注入时钟', async () => {
  const f = await scenario();
  await seed(f.stream);
  expect(await rewindOf(f.store, f.stream, OLD, FLOOR)).toBe(true);
  expect(await f.store.read(f.stream)).toBe(FLOOR);
  expect(await rows(f.stream.app_id)).toEqual([
    expect.objectContaining({
      ...f.stream,
      cursor_at: new Date(FLOOR),
      updated_at: new Date(NOW),
    }),
  ]);
});

it('[AC-B1-04zt#16] expected 不匹配：返回 false，不写任何列', async () => {
  const f = await scenario();
  await seed(f.stream, OTHER);
  const before = await rows(f.stream.app_id);
  f.clock.advanceMs(60_000);
  expect(await rewindOf(f.store, f.stream, OLD, FLOOR)).toBe(false);
  expect(await rows(f.stream.app_id)).toEqual(before);
});

it('[AC-B1-04zt#16] expected 非空而流没有行：返回 false，不插入', async () => {
  const f = await scenario();
  expect(await rewindOf(f.store, f.stream, OLD, FLOOR)).toBe(false);
  expect(await rows(f.stream.app_id)).toEqual([]);
});

it('[AC-B1-04zt#17] 只改 increment 流：同账号游标相同的 rescan 流不动', async () => {
  const f = await scenario();
  await seed(f.stream);
  // Equal cursors deliberately make a missing query_kind predicate hit the rescan row.
  await seed(f.rescan);
  const before = await rows(f.stream.app_id);
  expect(await rewindOf(f.store, f.stream, OLD, FLOOR)).toBe(true);
  expect(await f.store.read(f.stream)).toBe(FLOOR);
  expect(await f.store.read(f.rescan)).toBe(OLD);
  const rescanRows = (list: typeof before) => list.filter((row) => row.query_kind === 'rescan');
  expect(rescanRows(await rows(f.stream.app_id))).toEqual(rescanRows(before));
});

it('[AC-B1-04zt#17] expected=null：同账号已有 rescan 行不算 increment 流有行，照样插入，rescan 不动', async () => {
  const f = await scenario();
  await seed(f.rescan);
  const before = await rows(f.stream.app_id);
  expect(await rewindOf(f.store, f.stream, null, FLOOR)).toBe(true);
  expect(await f.store.read(f.stream)).toBe(FLOOR);
  expect(await f.store.read(f.rescan)).toBe(OLD);
  const after = await rows(f.stream.app_id);
  expect(after).toHaveLength(2);
  expect(after.filter((row) => row.query_kind === 'rescan')).toEqual(before);
});

it('[AC-B1-04zt#18] expected=null、行不存在：插入 to，updated_at 取注入时钟', async () => {
  const f = await scenario();
  expect(await rewindOf(f.store, f.stream, null, FLOOR)).toBe(true);
  expect(await f.store.read(f.stream)).toBe(FLOOR);
  expect(await rows(f.stream.app_id)).toEqual([
    expect.objectContaining({
      ...f.stream,
      cursor_at: new Date(FLOOR),
      updated_at: new Date(NOW),
    }),
  ]);
});

it('[AC-B1-04zt#18] expected=null、行已存在：什么都不做，返回 false', async () => {
  const f = await scenario();
  await seed(f.stream);
  const before = await rows(f.stream.app_id);
  f.clock.advanceMs(60_000);
  expect(await rewindOf(f.store, f.stream, null, FLOOR)).toBe(false);
  expect(await rows(f.stream.app_id)).toEqual(before);
});

it('[AC-B1-04zt#18] expected=null 并发两次：只成功一个，无唯一冲突泄漏，只有一行', async () => {
  const f = await scenario();
  const results = await Promise.all([
    rewindOf(f.store, f.stream, null, FLOOR),
    rewindOf(f.store, f.stream, null, FLOOR),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await rows(f.stream.app_id)).toHaveLength(1);
});

it.each([
  { label: '收到已有水位', expected: OLD },
  { label: '无水位时插入', expected: null },
])('[AC-B1-04zt#19] $label后，从 to 起的窗 advance CAS 命中', async ({ expected }) => {
  const f = await scenario();
  if (expected !== null) await seed(f.stream, expected);
  expect(await rewindOf(f.store, f.stream, expected, FLOOR)).toBe(true);
  expect(await f.store.advance(windowFrom(f.stream, FLOOR, FLOOR_END))).toBe(true);
  expect(await f.store.read(f.stream)).toBe(FLOOR_END);
  expect(await rows(f.stream.app_id)).toHaveLength(1);
});

it('[AC-B1-04zt#19] 收到前已在途的旧窗 advance CAS 落空，不把水位带回原位', async () => {
  const f = await scenario();
  await seed(f.stream);
  expect(await rewindOf(f.store, f.stream, OLD, FLOOR)).toBe(true);
  expect(await f.store.advance(windowFrom(f.stream, OLD, OTHER))).toBe(false);
  expect(await f.store.read(f.stream)).toBe(FLOOR);
});
