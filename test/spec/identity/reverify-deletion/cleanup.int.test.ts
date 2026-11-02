// B1-02zr: the old-number re-verification data goes when a deletion enters processing (08 BR-ID-28
// 细则「待加验记录」, BR-WDR-01 细则「删除」). Through the worker's round as app.module assembles it,
// over PostgreSQL as couli_app (kit.ts): users' six columns cleared and the user's reverified_devices
// rows deleted in the cleanup transaction, nothing of them on the tombstone.
//
// A request stuck in a later step shows where it happens: the data is gone while the request is
// still before the completion (#1) and also in a cleanup a blocked port keeps rerunning (#6), the
// same way the rest of the cleanup commits there (AC-B1-15g, ports.int.test.ts).
//
// Scope: app.users' primary key is (id) and reverified_devices references (app_id, id), so a row of
// the same user id in another app cannot exist. #4 covers another app through the same device.
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  CLEANUP_FAILED,
  HOUR_MS,
  at,
  deletedIdentitiesOf,
  device,
  hex,
  member,
  oauth,
  processing,
  request,
  session,
  userRow,
  warnings,
} from '../deletion-processing/kit.ts';
import {
  CLEARED,
  activity,
  cancelledRound,
  close,
  favorite,
  flag,
  footprint,
  holdFavorites,
  holdReverifiedDevices,
  open,
  reset,
  reverifiedDevice,
  reverifiedDevices,
  reverifyColumnsOfTombstone,
  reverifyState,
  seededState,
  type Kit,
} from './kit.ts';

/** cancelledRound's bounded waits. */
const LOCK_TEST_MS = 60_000;

let database: TestDatabase;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  kit = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    await database?.drop();
  }
});
beforeEach(async () => {
  await reset(kit);
});

/** A processing user with all six columns, a session and two reverified devices. */
async function flaggedAccount() {
  const { m, row } = await processing(kit.db);
  const last = await device(kit.db, m.appId);
  await session(kit.db, m, last.id);
  await flag(kit.db, m, last.hash);
  await reverifiedDevice(kit.db, m, last.hash, 'self');
  await reverifiedDevice(kit.db, m, hex(), 'admin');
  return { m, row, last };
}

it('[AC-B1-02zr#1] 进 processing 的清理事务提交后：六列全部清空（失败计数归 0），该用户 reverified_devices 全删；此时单还没完成，手机号还在', async () => {
  const { m, row, last } = await flaggedAccount();
  // The real unconfigured Apple revoker fails: the request stops after ①, before the completion.
  await oauth(kit.db, m, 'apple', { appleToken: 'synthetic-apple-refresh', crypto: kit.crypto });
  expect(await reverifyState(kit.db, m)).toEqual(seededState(last.hash));
  expect(await reverifiedDevices(kit.db, m)).toHaveLength(2);
  await kit.worker.runOnce();
  expect(await request(kit.db, row.id)).toMatchObject({
    status: 'processing',
    cleaned_at: kit.clock.now(),
    apple_revoke_attempts: 1,
    apple_revoke_result: null,
  });
  expect(await userRow(kit.db, m)).toMatchObject({ status: 'deleting', phone_hmac: m.phoneHmac });
  expect(await reverifyState(kit.db, m)).toEqual(CLEARED);
  expect(await reverifiedDevices(kit.db, m)).toEqual([]);
});

it(
  '[AC-B1-02zr#2] 与清理同一事务：删 reverified_devices 时等锁期间外部看不到任何变化；这句被取消 → 整笔回滚、列与行都不变，下一轮才清掉',
  async () => {
    const { m, row } = await flaggedAccount();
    const before = await footprint(kit.db, m, row.id);
    await cancelledRound(kit, holdReverifiedDevices(m), async () => {
      expect(await footprint(kit.db, m, row.id)).toEqual(before);
    });
    expect(await footprint(kit.db, m, row.id)).toEqual(before);
    expect(warnings(kit, CLEANUP_FAILED, m.appId)).toHaveLength(1);
    kit.clock.set(at(HOUR_MS));
    await kit.worker.runOnce();
    expect(await reverifyState(kit.db, m)).toEqual(CLEARED);
    expect(await reverifiedDevices(kit.db, m)).toEqual([]);
    expect(await request(kit.db, row.id)).toMatchObject({
      status: 'done',
      cleaned_at: kit.clock.now(),
    });
  },
  LOCK_TEST_MS,
);

it(
  '[AC-B1-02zr#3] 与清理同一事务：最后一个端口（catalog 删收藏）失败 → 这些列与行随整笔回滚不变，下一轮才清掉',
  async () => {
    const { m, row } = await flaggedAccount();
    await favorite(kit.db, m);
    const before = await footprint(kit.db, m, row.id);
    await cancelledRound(kit, holdFavorites(m), async () => {
      expect(await footprint(kit.db, m, row.id)).toEqual(before);
    });
    expect(await footprint(kit.db, m, row.id)).toEqual(before);
    expect(warnings(kit, CLEANUP_FAILED, m.appId)).toHaveLength(1);
    kit.clock.set(at(HOUR_MS));
    await kit.worker.runOnce();
    expect(await reverifyState(kit.db, m)).toEqual(CLEARED);
    expect(await reverifiedDevices(kit.db, m)).toEqual([]);
  },
  LOCK_TEST_MS,
);

it('[AC-B1-02zr#4] 只动这个用户：同设备的同 app 其他账号、别的 app 账号，users 行与 reverified_devices 行都不变', async () => {
  const { m } = await flaggedAccount();
  const shared = hex();
  await reverifiedDevice(kit.db, m, shared);
  const sameApp = await member(kit.db, { appId: m.appId, status: 'normal' });
  const otherApp = await member(kit.db, { status: 'normal' });
  for (const other of [sameApp, otherApp]) {
    await flag(kit.db, other, shared);
    await reverifiedDevice(kit.db, other, shared);
  }
  const sameAppBefore = await userRow(kit.db, sameApp);
  const otherAppBefore = await userRow(kit.db, otherApp);
  await kit.worker.runOnce();
  expect(await reverifyState(kit.db, m)).toEqual(CLEARED);
  expect(await reverifiedDevices(kit.db, m)).toEqual([]);
  expect(await userRow(kit.db, sameApp)).toEqual(sameAppBefore);
  expect(await userRow(kit.db, otherApp)).toEqual(otherAppBefore);
  for (const other of [sameApp, otherApp]) {
    expect(await reverifiedDevices(kit.db, other)).toEqual([
      { device_hash: shared, source: 'self' },
    ]);
  }
});

it('[AC-B1-02zr#5] 墓碑不留：完成后 users 墓碑这些列仍是空的，deleted_identities 无这些列，也不含只在加验数据里出现的设备哈希', async () => {
  const { m, row } = await processing(kit.db);
  const used = await device(kit.db, m.appId);
  await session(kit.db, m, used.id);
  // Neither hash belongs to a device of the user's sessions.
  const lastLogin = hex();
  await flag(kit.db, m, lastLogin);
  await reverifiedDevice(kit.db, m, lastLogin, 'self');
  await reverifiedDevice(kit.db, m, hex(), 'admin');
  await kit.worker.runOnce();
  expect(await request(kit.db, row.id)).toMatchObject({ status: 'done' });
  expect(await userRow(kit.db, m)).toMatchObject({ status: 'deleted', phone_hmac: null });
  expect(await reverifyState(kit.db, m)).toEqual(CLEARED);
  expect(await reverifiedDevices(kit.db, m)).toEqual([]);
  expect(await reverifyColumnsOfTombstone(kit.db)).toEqual([]);
  const identities = await deletedIdentitiesOf(kit.db, m.appId);
  const kept = identities.map((identity) => identity.phone_hmac ?? identity.device_hash);
  expect(kept.sort()).toEqual([m.phoneHmac, used.hash].sort());
});

it('[AC-B1-02zr#6] 幂等：端口未上线的清理每轮重跑，已清理的 users 行不再动（row_version、updated_at 不变）；完成后再跑也不动', async () => {
  const { m, row } = await flaggedAccount();
  await kit.blockedWorker.runOnce();
  expect(await request(kit.db, row.id)).toMatchObject({ status: 'processing', cleaned_at: null });
  expect(await reverifyState(kit.db, m)).toEqual(CLEARED);
  expect(await reverifiedDevices(kit.db, m)).toEqual([]);
  const cleaned = await userRow(kit.db, m);
  kit.clock.set(at(HOUR_MS));
  await kit.blockedWorker.runOnce();
  expect(await userRow(kit.db, m)).toEqual(cleaned);
  kit.clock.set(at(2 * HOUR_MS));
  await kit.worker.runOnce();
  expect(await request(kit.db, row.id)).toMatchObject({ status: 'done' });
  expect(await reverifyState(kit.db, m)).toEqual(CLEARED);
  const done = await userRow(kit.db, m);
  kit.clock.set(at(3 * HOUR_MS));
  await kit.worker.runOnce();
  expect(await userRow(kit.db, m)).toEqual(done);
});

it('[AC-B1-02zr#7] 没有标记的账号照常走完不报错：从未有加验数据的不受影响，只有活动列和失败计数的同样清空', async () => {
  const never = await processing(kit.db);
  const unflagged = await processing(kit.db);
  await activity(kit.db, unflagged.m, hex());
  await kit.worker.runOnce();
  expect(warnings(kit, CLEANUP_FAILED)).toEqual([]);
  for (const { m, row } of [never, unflagged]) {
    expect(await request(kit.db, row.id)).toMatchObject({ status: 'done' });
    expect(await reverifyState(kit.db, m)).toEqual(CLEARED);
    expect(await reverifiedDevices(kit.db, m)).toEqual([]);
  }
});
