import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createOrderPipeline,
  type OrderPipelineContext,
} from '../../../../apps/api/src/modules/orders/application/pipeline-port.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createUnionOrderReaders,
  type UnionOrder,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  requireTaobaoOrder,
  TaobaoRawNumber,
} from '../../../../apps/api/src/modules/union/infra/taobao/orders.ts';
import { at, capture, NOW, order, snapshot } from '../attribution/kit.ts';
import { account, built, pid, START } from '../wiring/db-kit.ts';

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

const SITE = '3001';
const OTHER_SITE = '3002';
const ADZONE = '2002';
const PARENT = '4900000000000000000';
const RELATION = '987654321098';
let taobaoSequence = 0;

function taobaoOrder(site: string | null = SITE, adzone = ADZONE) {
  // 合成 publisher_order_dto 单行。RawNumber 保留 JSON 数字 token，走实际映射器。
  return requireTaobaoOrder(
    {
      trade_id: `490000000000000${String(++taobaoSequence).padStart(4, '0')}`,
      trade_parent_id: PARENT,
      item_id: 'synthetic-item',
      adzone_id: new TaobaoRawNumber(adzone),
      ...(site === null ? {} : { site_id: new TaobaoRawNumber(site) }),
      relation_id: RELATION,
      tk_status: new TaobaoRawNumber('12'),
      tk_paid_time: '2026-10-16 00:00:00',
      alipay_total_price: '1234.57',
      pub_share_pre_fee: '17.93',
      pub_share_pre_fee_for_commission: '17.93',
      alimama_share_fee: '1.00',
    },
    { rawPayloadId: null, like: at(NOW) },
    undefined,
  );
}

function context(
  platform: OrderPipelineContext['platform'],
  acc: Awaited<ReturnType<typeof account>>,
): OrderPipelineContext {
  return {
    app_id: acc.app_id,
    union_account_id: acc.id,
    platform,
    query_kind: 'increment',
    scene: '-',
    window_start: START,
    window_end: NOW,
    requestId: randomUUID(),
  };
}

async function harness() {
  const paid = { event: 'PLATFORM_PAID', source: 'synthetic', verified: false, note: '' } as const;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const readers = await built(() => createUnionOrderReaders(db));
  const pipeline = await built(() =>
    createOrderPipeline({
      db,
      clock: new FixedClock(NOW),
      statusMaps: (platform) => ({
        platform,
        entries: new Map([
          ['12', paid],
          ['paid', paid],
        ]),
      }),
      ...readers,
      users: { findByAttrCode: async () => null },
      bindings: { findByRelation: async () => [] },
      rebate: { onImported: async () => undefined },
      logger,
    }),
  );
  return {
    process: (incoming: UnionOrder, ctx: OrderPipelineContext) =>
      capture(() => pipeline.process(incoming, ctx)),
    p1: () =>
      [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].filter(
        ([fields]) => fields?.alert === 'P1',
      ),
  };
}

async function expectStored(ctx: OrderPipelineContext, incoming: UnionOrder) {
  const { orders, keys } = await snapshot(db, ctx.app_id);
  const identity = {
    app_id: ctx.app_id,
    platform: incoming.platform,
    sub_order_id: incoming.sub_order_id,
  };
  expect(orders).toEqual([expect.objectContaining(identity)]);
  expect(keys).toEqual([expect.objectContaining({ ...identity, order_id: orders[0]?.order_id })]);
}

async function expectDrop(ctx: OrderPipelineContext, incoming: UnionOrder, reason: string) {
  const { orders, keys, dropKeys, drops } = await snapshot(db, ctx.app_id);
  expect(orders).toEqual([]);
  expect(keys).toEqual([]);
  expect(dropKeys).toEqual([
    expect.objectContaining({
      app_id: ctx.app_id,
      platform: incoming.platform,
      sub_order_id: incoming.sub_order_id,
      reason,
    }),
  ]);
  expect(drops).toEqual([
    expect.objectContaining({
      app_id: ctx.app_id,
      platform: incoming.platform,
      reason,
      day: '2026-10-16',
      count: 1n,
    }),
  ]);
}

it('[AC-B1-08zzc#1a] 数字 adzone_id 和 site_id 命中 mm_ 推广位', async () => {
  const acc = await account(db, { platform: 'taobao' });
  const ctx = context('taobao', acc);
  // 故意让同 adzone 的不同媒体排在前面，只有后面的登记能命中完整键。
  await pid(db, acc, {
    id: '00000000-0000-4000-8000-000000000001',
    site_id: OTHER_SITE,
    pid: `mm_1001_${OTHER_SITE}_${ADZONE}`,
    status: 'pending',
  });
  await pid(db, acc, {
    id: '00000000-0000-4000-8000-000000000002',
    site_id: SITE,
    pid: `mm_1001_${SITE}_${ADZONE}`,
  });
  const incoming = taobaoOrder();
  const h = await harness();
  expect(await h.process(incoming, ctx)).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  await expectStored(ctx, incoming);
  expect(h.p1()).toEqual([]);
});

it('[AC-B1-08zzc#1b] 数字 PID 按独立的 site_id 核对媒体', async () => {
  const acc = await account(db, { platform: 'taobao' });
  const ctx = context('taobao', acc);
  await pid(db, acc, { site_id: SITE, pid: ADZONE });
  const h = await harness();
  const match = taobaoOrder();
  const otherSite = taobaoOrder(OTHER_SITE);

  expect(await h.process(match, ctx)).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  expect(await h.process(otherSite, ctx)).toMatchObject({
    ok: true,
    value: { kind: 'dropped', reason: 'SITE_MISMATCH' },
  });
  await expectStored(ctx, match);
});

it('[AC-B1-08zzc#2] SITE_MISMATCH 丢弃、发一条 P1 并去重计数', async () => {
  const acc = await account(db, { platform: 'taobao' });
  const ctx = context('taobao', acc);
  await pid(db, acc, { site_id: SITE, pid: `mm_1001_${SITE}_${ADZONE}` });
  await pid(db, acc, {
    site_id: OTHER_SITE,
    pid: `mm_1001_${OTHER_SITE}_${ADZONE}`,
    status: 'retired',
  });
  const incoming = taobaoOrder('3003');
  const h = await harness();
  const dropped = { ok: true, value: { kind: 'dropped', reason: 'SITE_MISMATCH' } };

  expect(await h.process(incoming, ctx)).toMatchObject(dropped);
  await expectDrop(ctx, incoming, 'SITE_MISMATCH');
  const alerts = h.p1();
  expect(alerts).toHaveLength(1);
  const line = inspect(alerts, { depth: null });
  for (const sensitive of [incoming.sub_order_id, PARENT, RELATION, '123457', '1234.57']) {
    expect(line).not.toContain(sensitive);
  }

  expect(await h.process(incoming, ctx)).toMatchObject(dropped);
  await expectDrop(ctx, incoming, 'SITE_MISMATCH');
});

it('[AC-B1-08zzc#3] 同一 site_id 下未命中 adzone 记 PID_NOT_OURS', async () => {
  const acc = await account(db, { platform: 'taobao' });
  const ctx = context('taobao', acc);
  const registeredAdzone = '12002';
  // 直接写夹具让第二段与 site_id 列不同，单独验证匹配时只以 site_id 列核对媒体。
  await pid(db, acc, { site_id: SITE, pid: `mm_1001_${OTHER_SITE}_${registeredAdzone}` });
  const h = await harness();
  const miss = taobaoOrder();
  expect(await h.process(miss, ctx)).toMatchObject({
    ok: true,
    value: { kind: 'dropped', reason: 'PID_NOT_OURS' },
  });
  await expectDrop(ctx, miss, 'PID_NOT_OURS');

  const match = taobaoOrder(SITE, registeredAdzone);
  expect(await h.process(match, ctx)).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  await expectStored(ctx, match);
  expect(h.p1()).toEqual([]);
});

it('[AC-B1-08zzc#4] 缺 site_id 的淘宝订单记 PID_NOT_OURS', async () => {
  const acc = await account(db, { platform: 'taobao' });
  const ctx = context('taobao', acc);
  await pid(db, acc, { site_id: SITE, pid: ADZONE });
  const incoming = taobaoOrder(null);
  const h = await harness();
  expect(await h.process(incoming, ctx)).toMatchObject({
    ok: true,
    value: { kind: 'dropped', reason: 'PID_NOT_OURS' },
  });
  await expectDrop(ctx, incoming, 'PID_NOT_OURS');
  expect(h.p1()).toEqual([]);
});

it.each(['pending', 'retired'] as const)(
  '[AC-B1-08zzc#5] %s 状态的淘宝推广位仍可用于订单归属',
  async (status) => {
    const acc = await account(db, { platform: 'taobao' });
    const ctx = context('taobao', acc);
    await pid(db, acc, { site_id: SITE, pid: `mm_1001_${SITE}_${ADZONE}`, status });
    const incoming = taobaoOrder();
    const h = await harness();
    expect(await h.process(incoming, ctx)).toMatchObject({ ok: true, value: { kind: 'inserted' } });
    await expectStored(ctx, incoming);
  },
);

it('[AC-B1-08zzc#6] 推广位按 App 和联盟账号隔离', async () => {
  const owner = await account(db, { platform: 'taobao' });
  const otherAccount = await account(db, { platform: 'taobao', app_id: owner.app_id });
  const otherApp = await account(db, { platform: 'taobao' });
  const ownerCtx = context('taobao', owner);
  await pid(db, owner, { site_id: SITE, pid: `mm_1001_${SITE}_${ADZONE}` });
  const incoming = taobaoOrder();
  const h = await harness();

  for (const wrongCtx of [
    { ...ownerCtx, app_id: otherApp.app_id },
    context('taobao', otherAccount),
  ]) {
    expect(await h.process(incoming, wrongCtx)).toMatchObject({
      ok: true,
      value: { kind: 'dropped', reason: 'PID_NOT_OURS' },
    });
    await expectDrop(wrongCtx, incoming, 'PID_NOT_OURS');
  }

  expect(await h.process(incoming, ownerCtx)).toMatchObject({
    ok: true,
    value: { kind: 'inserted' },
  });
  await expectStored(ownerCtx, incoming);
  expect(h.p1()).toEqual([]);
});

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-08zzc#7] %s 仍按自身推广位精确匹配，淘宝的媒体要求仅用于淘宝',
  async (platform) => {
    const acc = await account(db, { platform });
    const taobao = await account(db, { platform: 'taobao', app_id: acc.app_id });
    const ctx = context(platform, acc);
    const taobaoCtx = context('taobao', taobao);
    await pid(db, acc, { pid: ADZONE });
    await pid(db, taobao, { site_id: SITE, pid: ADZONE });
    const incoming = order({
      platform,
      sub_order_id: randomUUID(),
      promotion_slot: ADZONE,
      raw_payload_id: null,
    });
    const missing = taobaoOrder(null);
    const h = await harness();
    expect(
      await h.process({ ...incoming, sub_order_id: randomUUID(), promotion_slot: '12002' }, ctx),
    ).toMatchObject({ ok: true, value: { kind: 'dropped', reason: 'PID_NOT_OURS' } });
    expect(await h.process(incoming, ctx)).toMatchObject({ ok: true, value: { kind: 'inserted' } });
    await expectStored(ctx, incoming);
    expect(await h.process(missing, taobaoCtx)).toMatchObject({
      ok: true,
      value: { kind: 'dropped', reason: 'PID_NOT_OURS' },
    });
    await expectStored(ctx, incoming);
    expect(h.p1()).toEqual([]);
  },
);
