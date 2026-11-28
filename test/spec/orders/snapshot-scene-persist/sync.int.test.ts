import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { requireAttrPidScene } from '../../db/orders/attr-pid-scene/kit.ts';
import { num } from '../../union/taobao-orders/kit.ts';
import { order } from '../rights-port/kit.ts';
import { FULL_PID } from '../taobao-slot-match/adapter-kit.ts';
import { prepareOrder } from './kit.ts';

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

const RERUN = { modified_time: '2026-10-30 10:50:00' };
const CONTENT_UPDATE = { modified_time: '2026-10-30 11:00:00', alipay_total_price: '89.00' };
const NO_SNAPSHOT = { splits: [], totals: [] };
const TAOLIJIN_SNAPSHOT = {
  splits: [{ rebate_mode: 'none', raw_n_fen: 1000n }],
  totals: [{ user_share_total_fen: 0n }],
};
const ORDINARY_SNAPSHOT = {
  splits: [{ rebate_mode: null, raw_n_fen: 1000n }],
  totals: [{ user_share_total_fen: 500n }],
};

type Fixture = Awaited<ReturnType<typeof prepareOrder>>;

async function pendingWithoutRule(f: Fixture) {
  expect(await f.readSnapshot()).toEqual(NO_SNAPSHOT);
  const rows = await f.readRulePending();
  expect(rows).toEqual([
    expect.objectContaining({
      detail: 'commission_snapshot no published rule version',
      status: 'open',
      resolved_at: null,
    }),
  ]);
  return rows[0]!.id;
}

async function expectResolved(f: Fixture, id: bigint) {
  expect(await f.readRulePending()).toEqual([
    expect.objectContaining({ id, status: 'resolved', resolved_at: f.clock.now() }),
  ]);
}

it('[AC-B1-08zzi#1] 重跑命中淘礼金并归因后，改登记为分享也不改变补偿快照', async () => {
  await requireAttrPidScene(db);
  const f = await prepareOrder(db, '4920000000000000101');
  expect(f.initial).toMatchObject({ platform_status: 'PAID', user_id: null, pid: FULL_PID });
  expect(await f.readRulePending()).toEqual([]);

  await f.update(RERUN);
  expect(await f.readOrder()).toMatchObject({ user_id: f.ownerId, user_basis: 'param' });
  expect(await f.readScene()).toBe('taolijin');
  const pending = await pendingWithoutRule(f);

  await f.updateRegistration('share');
  await f.publishRules();
  await f.update(CONTENT_UPDATE);
  expect(await f.readSnapshot()).toEqual(TAOLIJIN_SNAPSHOT);
  await expectResolved(f, pending);
});

it('[AC-B1-08zzi#2] 入库即归因且已付的淘礼金单，补偿沿用入库时的场景', async () => {
  await requireAttrPidScene(db);
  const f = await prepareOrder(db, '4920000000000000102', { attributed: true });
  expect(f.initial).toMatchObject({ platform_status: 'PAID', user_id: f.ownerId, pid: FULL_PID });
  expect(await f.readScene()).toBe('taolijin');
  const pending = await pendingWithoutRule(f);

  await f.updateRegistration('share');
  await f.publishRules();
  await f.update(CONTENT_UPDATE);
  expect(await f.readSnapshot()).toEqual(TAOLIJIN_SNAPSHOT);
  await expectResolved(f, pending);
});

it('[AC-B1-08zzi#3] 已归因的定金单改登记为分享后付尾款，首次快照仍按淘礼金', async () => {
  await requireAttrPidScene(db);
  const f = await prepareOrder(db, '4920000000000000103', { attributed: true, deposit: true });
  expect(f.initial).toMatchObject({
    platform_status: 'DEPOSIT_PAID',
    user_id: f.ownerId,
    is_presale: true,
  });
  expect(await f.readScene()).toBe('taolijin');
  expect(await f.readSnapshot()).toEqual(NO_SNAPSHOT);
  expect(await f.readRulePending()).toEqual([]);

  await f.updateRegistration('share');
  await f.publishRules();
  await f.update({ ...RERUN, tk_deposit_time: '2026-10-29 20:00:00' });
  expect(await f.readOrder()).toMatchObject({ platform_status: 'PAID', user_id: f.ownerId });
  expect(await f.readSnapshot()).toEqual(TAOLIJIN_SNAPSHOT);
  expect(await f.readScene()).toBe('taolijin');
});

it('[AC-B1-08zzi#4] 未归因期间改登记为分享，重跑命中分享后持久化并按普通分佣', async () => {
  await requireAttrPidScene(db);
  const f = await prepareOrder(db, '4920000000000000104');
  expect(f.initial).toMatchObject({ platform_status: 'PAID', user_id: null, pid: FULL_PID });
  expect(await f.readScene()).toBe('taolijin');

  await f.updateRegistration('share');
  await f.publishRules();
  await f.update(RERUN);
  expect(await f.readOrder()).toMatchObject({ user_id: f.ownerId });
  expect(await f.readScene()).toBe('share');
  expect(await f.readSnapshot()).toEqual(ORDINARY_SNAPSHOT);
});

it('[AC-B1-08zzi#5] 命中分享后登记改回淘礼金，重跑仍用命中的分享场景', async () => {
  await requireAttrPidScene(db);
  const f = await prepareOrder(db, '4920000000000000105');
  expect(f.initial).toMatchObject({ platform_status: 'PAID', user_id: null, pid: FULL_PID });
  expect(await f.readScene()).toBe('taolijin');

  await f.updateRegistration('share');
  await f.publishRules();
  const match = f.changeRegistrationAfterMatch();
  await f.update(RERUN);
  expect(match).toHaveBeenCalledTimes(1);
  expect(await f.readOrder()).toMatchObject({ user_id: f.ownerId });
  expect(await f.readScene()).toBe('share');
  expect(await f.readSnapshot()).toEqual(ORDINARY_SNAPSHOT);
});

it('[AC-B1-08zzi#8] 存量已归因订单的场景列为空，补偿按登记行的分享场景分佣', async () => {
  await requireAttrPidScene(db);
  const f = await prepareOrder(db, '4920000000000000108', { attributed: true });
  expect(f.initial).toMatchObject({ platform_status: 'PAID', user_id: f.ownerId, pid: FULL_PID });
  const pending = await pendingWithoutRule(f);

  await f.clearScene();
  await f.updateRegistration('share');
  await f.publishRules();
  await f.update(CONTENT_UPDATE);
  expect(await f.readSnapshot()).toEqual(ORDINARY_SNAPSHOT);
  await expectResolved(f, pending);
});

it('[AC-B1-08zzi#9] 归因后的内容和推广位变化不改已存场景', async () => {
  await requireAttrPidScene(db);
  const f = await prepareOrder(db, '4920000000000000109');
  await f.update(RERUN);
  expect(await f.readOrder()).toMatchObject({ user_id: f.ownerId, pid: FULL_PID });
  expect(await f.readScene()).toBe('taolijin');

  await f.updateRegistration('share');
  await f.update(CONTENT_UPDATE);
  expect(await f.readScene()).toBe('taolijin');

  const alternateSlot = '2003';
  const alternate = await f.addSlot('mm_1001_3001_2003');
  await f.update(
    {
      modified_time: '2026-10-30 11:10:00',
      alipay_total_price: '90.00',
      adzone_id: num(alternateSlot),
    },
    alternate.pid,
  );
  expect(f.publish).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      name: 'order.attr_param_changed',
      payload: { order_id: f.initial.order_id, platform: 'taobao', changed: ['pid'] },
    }),
  );
  expect(await f.readOrder()).toMatchObject({ user_id: f.ownerId, pid: FULL_PID });
  expect(await f.readScene()).toBe('taolijin');

  await f.update({ modified_time: '2026-10-30 11:20:00', alipay_total_price: '91.00' });
  expect(await f.readScene()).toBe('taolijin');
});

it('[AC-B1-08zzi#11] 权利流水测试的 order() 夹具键与实际订单表列一致', async () => {
  await requireAttrPidScene(db);
  const { rows } = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'orders'
  `.execute(db);
  const keys = Object.keys(order()).sort();
  expect(keys).toContain('attr_pid_scene');
  expect(keys).toEqual(rows.map(({ column_name }) => column_name).sort());
});
