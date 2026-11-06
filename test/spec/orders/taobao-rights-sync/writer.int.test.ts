// 维权 / 违规同步的写入（任务书第 9 节第 5、8 条，照 rights-import-rows.ts：找单 → 锁 → 重读 →
// rights.record，source = API；settlement 的 rights-command.ts 是 order_rights 唯一写者，本单只钉交给
// rights.record 的参数，不钉扣回金额；08 BR-FUND-01：同一子订单按 order_key 用 advisory 锁串行，判定先于写库）。
// settlement 用 rights-import-rows 的假端口（同一去重键插一行，冲突即 duplicate），只看调用、锁与事务。
// 用例全部是顶层 it（规划/11 §4.3）。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createRightsSyncWriter,
  type RightsSyncItem,
} from '../../../../apps/api/src/modules/orders/application/rights-sync.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  PROCESSED,
  fakeSettlement,
  newAppId,
  open,
  orderNo,
  rightsOf,
  seedOrder,
  type Harness,
  type Order,
} from '../rights-import-rows/db-kit.ts';

let database: TestDatabase | undefined;
let h: Harness;
beforeAll(async () => {
  database = await createTestDatabase();
  h = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    await database?.drop();
  }
}, 30_000);

const OCCURRED = new Date('2026-11-05T02:00:00.000Z');

function rightsItem(patch: Partial<RightsSyncItem> = {}): RightsSyncItem {
  return {
    type: 'RIGHTS',
    status: 'SUCCEEDED',
    amount_fen: null,
    deduction_commission_fen: 71n,
    occurred_at: OCCURRED,
    platform_rights_no: '3300000000000005001',
    ...patch,
  };
}

/**
 * 写入之后重读种入的订单行：假 settlement 不碰 orders，本单也不得自己改订单状态（评审 r1 S1），
 * 所以状态列与 row_version 必须都等于种入值。
 */
async function expectOrderUntouched(seeded: Order) {
  const after = await h.db
    .selectFrom('orders')
    .select(['platform_status', 'rebate_status', 'rights_pending', 'hold', 'row_version'])
    .where('app_id', '=', seeded.app_id)
    .where('order_id', '=', seeded.order_id)
    .executeTakeFirstOrThrow();
  expect(after).toEqual({
    platform_status: seeded.platform_status,
    rebate_status: seeded.rebate_status,
    rights_pending: seeded.rights_pending,
    hold: seeded.hold,
    row_version: seeded.row_version,
  });
}

function setup() {
  const appId = newAppId();
  const clock = new FixedClock(PROCESSED);
  const settlement = fakeSettlement(h.db);
  const rights = settlement.ports.rights;
  expect(rights).toBeDefined();
  const writer = createRightsSyncWriter({ db: h.db, clock, rights: rights! });
  return { appId, clock, settlement, writer };
}

it('[AC-B1-04zza#35] 找到本 App 本平台的子订单：持子订单 advisory 锁与行锁、在事务里调 rights.record（source API、before 是重读的行、now 取注入时钟）', async () => {
  const f = setup();
  const order = await seedOrder(h.db, f.appId);
  f.settlement.control.probe = true;
  const item = rightsItem();
  const result = await f.writer.write(
    { app_id: f.appId, platform: 'taobao', sub_order_id: order.sub_order_id },
    item,
  );
  expect(result).toEqual({ kind: 'applied' });
  expect(f.settlement.calls).toHaveLength(1);
  const call = f.settlement.calls[0]!;
  expect(call.input).toEqual({
    before: order,
    order_id: order.order_id,
    source: 'API',
    type: 'RIGHTS',
    status: 'SUCCEEDED',
    amount_fen: null,
    deduction_commission_fen: 71n,
    occurred_at: OCCURRED,
    platform_rights_no: item.platform_rights_no,
    now: f.clock.now(),
  });
  expect(call.isTransaction).toBe(true);
  expect(call.held).toEqual({ advisoryFree: false, rowFree: false });
  expect((await rightsOf(h.db, f.appId)).map((row) => [row.source, row.type, row.status])).toEqual([
    ['API', 'RIGHTS', 'SUCCEEDED'],
  ]);
  await expectOrderUntouched(order);
});

it('[AC-B1-04zza#36] 违规：PUNISH / SUCCEEDED、违规单号与同步时刻原样交给 rights.record', async () => {
  const f = setup();
  const order = await seedOrder(h.db, f.appId);
  const item = rightsItem({
    type: 'PUNISH',
    status: 'SUCCEEDED',
    deduction_commission_fen: null,
    occurred_at: f.clock.now(),
    platform_rights_no: `${order.sub_order_id}:202610`,
  });
  const result = await f.writer.write(
    { app_id: f.appId, platform: 'taobao', sub_order_id: order.sub_order_id },
    item,
  );
  expect(result).toEqual({ kind: 'applied' });
  expect(f.settlement.calls[0]?.input).toMatchObject({
    order_id: order.order_id,
    source: 'API',
    type: 'PUNISH',
    status: 'SUCCEEDED',
    deduction_commission_fen: null,
    occurred_at: f.clock.now(),
    platform_rights_no: `${order.sub_order_id}:202610`,
  });
  await expectOrderUntouched(order);
});

it('[AC-B1-04zza#37] 同一条重放：第二次 duplicate，order_rights 只有一条', async () => {
  const f = setup();
  const order = await seedOrder(h.db, f.appId);
  const target = { app_id: f.appId, platform: 'taobao', sub_order_id: order.sub_order_id } as const;
  expect(await f.writer.write(target, rightsItem())).toEqual({ kind: 'applied' });
  expect(await f.writer.write(target, rightsItem())).toEqual({ kind: 'duplicate' });
  expect(f.settlement.record).toHaveBeenCalledTimes(2);
  expect(await rightsOf(h.db, f.appId)).toHaveLength(1);
});

it('[AC-B1-04zza#38] 对不上订单（没有这单、别的 App 的单、同号别的平台）：not_found，不调 rights.record、不写库、不抛错', async () => {
  const f = setup();
  const otherApp = newAppId();
  const elsewhere = await seedOrder(h.db, otherApp);
  const jdOrder = await seedOrder(h.db, f.appId, { platform: 'jd', sub_order_id: orderNo() });
  const targets = [
    { app_id: f.appId, platform: 'taobao', sub_order_id: orderNo() },
    { app_id: f.appId, platform: 'taobao', sub_order_id: elsewhere.sub_order_id },
    { app_id: f.appId, platform: 'taobao', sub_order_id: jdOrder.sub_order_id },
  ] as const;
  for (const target of targets) {
    await expect(f.writer.write(target, rightsItem())).resolves.toEqual({ kind: 'not_found' });
  }
  expect(f.settlement.record).not.toHaveBeenCalled();
  expect(await rightsOf(h.db, f.appId)).toEqual([]);
  expect(await rightsOf(h.db, otherApp)).toEqual([]);
});

it('[AC-B1-04zza#39] rights.record 答 not_applicable：原样返回，不抛错', async () => {
  const f = setup();
  const order = await seedOrder(h.db, f.appId);
  f.settlement.control.answer = { kind: 'not_applicable' };
  await expect(
    f.writer.write(
      { app_id: f.appId, platform: 'taobao', sub_order_id: order.sub_order_id },
      rightsItem(),
    ),
  ).resolves.toEqual({ kind: 'not_applicable' });
});

it('[AC-B1-04zza#40] rights.record 抛错：错误外抛，本事务不留 order_rights', async () => {
  const f = setup();
  const order = await seedOrder(h.db, f.appId);
  const failure = new Error('synthetic settlement failure');
  f.settlement.control.fail = failure;
  await expect(
    f.writer.write(
      { app_id: f.appId, platform: 'taobao', sub_order_id: order.sub_order_id },
      rightsItem(),
    ),
  ).rejects.toBe(failure);
  expect(await rightsOf(h.db, f.appId)).toEqual([]);
});
