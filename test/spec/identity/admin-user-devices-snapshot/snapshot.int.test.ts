// B1-02zze · one page and its total from one snapshot (contract adminListUserDevices: items and
// total describe the same list; FU-ADMIN-DEVICES-SNAPSHOT, D10-968). Each case commits a concurrent
// write between the store's first statement on app.devices and its next one (kit.ts, Gate), and
// asserts, whichever statement runs first, that the answer is exactly the page of the state before
// the write or exactly that of the state after it:
//   #1 a device of the user revoked meanwhile;
//   #2 a device of the user added meanwhile (a new device with a session, or a session of the user
//      on a device of someone else);
//   #3 a page past the end on one side: items empty and total still the real count (not the 0 a
//      count(*) over () over no row would give);
//   #4 read only: page() changes no row and sends no writing statement (every case);
//   #5 as before: last_seen_at desc then id desc, page / page_size, only devices of the user that
//      are not revoked, judged by sessions (revoked sessions included), devices.user_id not read,
//      another app not seen, the seven fields of a row (every case: the expected pages come from
//      the kit's oracle over the seeded rows, with kit.noise() in each world).
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DAY,
  REVOKED,
  at,
  device,
  mine,
  noise,
  oneSnapshot,
  open,
  pageOf,
  plan,
  readAcross,
  registerWithSession,
  reverified,
  revokeDevice,
  row,
  session,
  world,
  type Harness,
} from './kit.ts';

let database: TestDatabase | undefined;
let h: Harness | undefined;
beforeAll(async () => {
  database = await createTestDatabase();
  h = open(database.urlFor('couli_app'));
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    await database?.drop();
  }
}, 30_000);

async function fresh() {
  expect(h, 'test database').toBeDefined();
  const w = await world(h!);
  await noise(w);
  return w;
}

it('[AC-B1-02zze#1][AC-B1-02zze#4] 唯一一台设备在读一页与读总数之间被吊销：要么 1 行且 total 1，要么空且 total 0，绝不 1 行配 0', async () => {
  const w = await fresh();
  const only = await mine(w, {
    lastSeenAt: at(30),
    createdAt: at(3 * DAY),
    platform: 'android',
    appVersion: '3.1.0',
  });
  await session(w.h.db, w.target, only, REVOKED);
  await session(w.h.db, w.someone, only);
  const record = await reverified(w, only, 'admin', at(60));

  const run = await readAcross(w, { page: 1, pageSize: 20 }, (db) => revokeDevice(db, only));

  oneSnapshot(run, { items: [row(only, record)], total: 1 }, { items: [], total: 0 });
}, 20_000);

it('[AC-B1-02zze#1][AC-B1-02zze#5] 跨页时吊销最新一台：第 1 页与 total 同属吊销前（4 台）或同属吊销后（3 台），同一 last_seen_at 按 id 降序', async () => {
  const w = await fresh();
  const newest = await mine(w, { lastSeenAt: at(1) });
  const tiedA = await mine(w, { lastSeenAt: at(5), platform: 'harmony', appVersion: '1.0.0' });
  const tiedB = await mine(w, { lastSeenAt: at(5), createdAt: at(DAY) });
  const oldest = await mine(w, { lastSeenAt: at(9), createdAt: at(2 * DAY) });
  const record = await reverified(w, tiedB, 'self', at(90));
  const rest = [row(tiedA), row(tiedB, record), row(oldest)];

  const run = await readAcross(w, { page: 1, pageSize: 2 }, (db) => revokeDevice(db, newest));

  oneSnapshot(run, pageOf([row(newest), ...rest], 1, 2), pageOf(rest, 1, 2));
}, 20_000);

it('[AC-B1-02zze#3][AC-B1-02zze#4] 第 2 页在吊销后越过末尾：要么吊销前的末行配 total 3，要么空列表配真实总数 2', async () => {
  const w = await fresh();
  const newest = await mine(w, { lastSeenAt: at(1) });
  const middle = await mine(w, { lastSeenAt: at(2) });
  const oldest = await mine(w, { lastSeenAt: at(3) });
  const rest = [row(middle), row(oldest)];

  const run = await readAcross(w, { page: 2, pageSize: 2 }, (db) => revokeDevice(db, newest));

  const after = pageOf(rest, 2, 2);
  expect(after).toEqual({ items: [], total: 2 });
  oneSnapshot(run, pageOf([row(newest), ...rest], 2, 2), after);
}, 20_000);

it('[AC-B1-02zze#2][AC-B1-02zze#4] 读一页与读总数之间新增一台带本人会话的设备：要么 1 行配 total 1，要么 2 行配 total 2，绝不 total 2 而只有 1 行', async () => {
  const w = await fresh();
  const old = await mine(w, { lastSeenAt: at(10), createdAt: at(5 * DAY) });
  const added = plan(w.appId, {
    lastSeenAt: at(-1),
    createdAt: at(-1),
    platform: 'android',
    appVersion: '3.2.0',
  });

  const run = await readAcross(w, { page: 1, pageSize: 20 }, (db) =>
    registerWithSession(db, w.target, added),
  );

  oneSnapshot(run, pageOf([row(old)], 1, 20), pageOf([row(old), row(added)], 1, 20));
}, 20_000);

it('[AC-B1-02zze#3][AC-B1-02zze#4] 第 2 页在新增前越过末尾：要么空列表配真实总数 1，要么旧设备配 total 2', async () => {
  const w = await fresh();
  const old = await mine(w, { lastSeenAt: at(10) });
  const added = plan(w.appId, { lastSeenAt: at(-1) });

  const run = await readAcross(w, { page: 2, pageSize: 1 }, (db) =>
    registerWithSession(db, w.target, added),
  );

  const before = pageOf([row(old)], 2, 1);
  expect(before).toEqual({ items: [], total: 1 });
  oneSnapshot(run, before, pageOf([row(old), row(added)], 2, 1));
}, 20_000);

it('[AC-B1-02zze#2][AC-B1-02zze#5] 读之间本人在他人设备上留下一条（已吊销的）会话：该设备随之归属本人，一页与 total 仍同属一侧', async () => {
  const w = await fresh();
  const old = await mine(w, { lastSeenAt: at(10) });
  const shared = await device(w, w.appId, { lastSeenAt: at(2), platform: 'harmony' });
  await session(w.h.db, w.someone, shared);

  const run = await readAcross(w, { page: 1, pageSize: 20 }, (db) =>
    session(db, w.target, shared, REVOKED),
  );

  oneSnapshot(run, pageOf([row(old)], 1, 20), pageOf([row(old), row(shared)], 1, 20));
}, 20_000);
