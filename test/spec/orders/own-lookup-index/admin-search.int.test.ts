// B1-09x (FU-ORDERS-OWN-LOOKUP-INDEX, D10-853) path 1: the console order list (count + page of
// createAdminOrderReads) filtered by an order number q. Before the change the filter was
// `sub_order_id = q OR parent_order_id = q`; after it the sub number goes through order_keys and
// the parent number through orders_parent_order_idx, and the two are merged. Every call below is
// measured (count and page in one transaction): app.orders is read by key (red on main, where the
// sub_order_id filter has no index), then the results are checked against what main returns.
// Shared helpers and the scan measurement: ./kit.ts.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import {
  createAdminOrderReads,
  type AdminOrderFilter,
} from '../../../../apps/api/src/modules/orders/infra/admin-order-reads.ts';
import {
  addOrder,
  ATTR_AT,
  expectBackground,
  installWorld,
  keyedRead,
  orderNo,
  type StoredOrder,
} from './kit.ts';

const w = installWorld(createTestDatabase);

/**
 * count and every page row (order_id, numbers, platform), both in one measured transaction: no
 * sequential scan of app.orders, rows read within READ_BOUND.
 */
async function search(filter: AdminOrderFilter, offset = 0, limit = 50) {
  return keyedRead(
    w(),
    async (trx) => {
      const reads = createAdminOrderReads(trx);
      const count = await reads.count(filter);
      const page = await reads.page(filter, offset, limit);
      return {
        count,
        rows: page.map((row) => ({
          order_id: row.order_id,
          sub_order_id: row.sub_order_id,
          parent_order_id: row.parent_order_id,
          platform: row.platform,
        })),
      };
    },
    (result) => result.count > 0 || result.rows.length > 0,
  );
}

function shown(order: StoredOrder) {
  return {
    order_id: order.order_id,
    sub_order_id: order.sub_order_id,
    parent_order_id: order.parent_order_id,
    platform: order.platform,
  };
}

/**
 * Orders of the app hit by q: X (taobao, sub q), W (jd, sub q AND parent q: one order), Y and Z
 * (taobao, parent q) in three partitions; look-alikes of the other app (taobao child of q, pdd
 * sub q); an unrelated pdd order of the app. Expected list order: paid_at desc nulls last, then
 * order_id desc — Z, Y (same paid_at, Z's order_id is greater), X, W (no paid_at).
 */
async function family() {
  const { app, appId, otherAppId } = w();
  const q = orderNo();
  const x = await addOrder(app, {
    appId,
    platform: 'taobao',
    sub: q,
    parent: orderNo(),
    attrAt: ATTR_AT.october,
    paidAt: new Date('2026-10-05T01:00:00Z'),
    platformStatus: 'SETTLED',
  });
  const wq = await addOrder(app, {
    appId,
    platform: 'jd',
    sub: q,
    parent: q,
    attrAt: ATTR_AT.september,
    paidAt: null,
  });
  const y = await addOrder(app, {
    appId,
    platform: 'taobao',
    sub: orderNo(),
    parent: q,
    attrAt: ATTR_AT.fallback,
    paidAt: new Date('2026-10-07T01:00:00Z'),
  });
  const z = await addOrder(app, {
    appId,
    platform: 'taobao',
    sub: orderNo(),
    parent: q,
    attrAt: ATTR_AT.october,
    paidAt: new Date('2026-10-07T01:00:00Z'),
  });
  const otherChild = await addOrder(app, {
    appId: otherAppId,
    platform: 'taobao',
    sub: orderNo(),
    parent: q,
    paidAt: new Date('2026-10-09T01:00:00Z'),
  });
  const otherSub = await addOrder(app, {
    appId: otherAppId,
    platform: 'pdd',
    sub: q,
    parent: null,
    paidAt: new Date('2026-10-08T01:00:00Z'),
  });
  await addOrder(app, { appId, platform: 'pdd', sub: orderNo(), parent: orderNo() });
  await expectBackground(w());
  return { q, x, wq, y, z, otherChild, otherSub };
}

it('[AC-B1-09x#1] 后台订单搜索 q：子单号命中、父单号命中都列出，子单号与父单号同时命中同一单只列一次；count 与列表条数一致，顺序 paid_at 倒序（无 paid_at 在后）再 order_id 倒序；同一事务内不顺序扫描 app.orders、读的行数有界', async () => {
  const { q, x, wq, y, z } = await family();
  const found = await search({ appId: w().appId, q });
  expect(found.rows).toEqual([shown(z), shown(y), shown(x), shown(wq)]);
  expect(found.count).toBe(4);
});

it('[AC-B1-09x#2] 后台订单搜索 q 带 platform：只列该平台命中的单（淘宝子单号与父单号两路合并、京东同号一单、拼多多无），count 同步；每次都不顺序扫描 app.orders、读的行数有界', async () => {
  const { q, x, wq, y, z } = await family();
  const { appId } = w();
  expect(await search({ appId, platform: 'taobao', q })).toEqual({
    count: 3,
    rows: [shown(z), shown(y), shown(x)],
  });
  expect(await search({ appId, platform: 'jd', q })).toEqual({ count: 1, rows: [shown(wq)] });
  expect(await search({ appId, platform: 'pdd', q })).toEqual({ count: 0, rows: [] });
});

it('[AC-B1-09x#3] 后台订单搜索 q 不跨 app：别的 app 同号的子单、父单只在它自己的 app 下出现；每次都不顺序扫描 app.orders、读的行数有界', async () => {
  const { q, otherChild, otherSub } = await family();
  const { appId, otherAppId } = w();
  const mine = await search({ appId, q });
  expect(mine.rows.map((row) => row.order_id)).not.toContain(otherChild.order_id);
  expect(mine.rows.map((row) => row.order_id)).not.toContain(otherSub.order_id);
  expect(await search({ appId: otherAppId, q })).toEqual({
    count: 2,
    rows: [shown(otherChild), shown(otherSub)],
  });
  expect(await search({ appId: otherAppId, platform: 'taobao', q })).toEqual({
    count: 1,
    rows: [shown(otherChild)],
  });
});

it('[AC-B1-09x#4] 后台订单搜索 q 分页：各页按同一顺序衔接、末页之后为空，每页的 count 都是总数；q 与其他筛选（平台状态）同时生效；每次都不顺序扫描 app.orders、读的行数有界', async () => {
  const { q, x, wq, y, z } = await family();
  const { appId } = w();
  expect(await search({ appId, q }, 0, 2)).toEqual({ count: 4, rows: [shown(z), shown(y)] });
  expect(await search({ appId, q }, 2, 2)).toEqual({ count: 4, rows: [shown(x), shown(wq)] });
  expect(await search({ appId, q }, 4, 2)).toEqual({ count: 4, rows: [] });
  expect(await search({ appId, q }, 1, 2)).toEqual({ count: 4, rows: [shown(y), shown(x)] });
  expect(await search({ appId, q, platformStatus: 'SETTLED' })).toEqual({
    count: 1,
    rows: [shown(x)],
  });
  expect(await search({ appId, q, platformStatus: 'RECEIVED' })).toEqual({ count: 0, rows: [] });
});

it('[AC-B1-09x#5] 后台订单搜索 q 都不命中：count 为 0、列表为空；只是别的单的子单号前缀或父单号前缀的 q 不命中；每次都不顺序扫描 app.orders、读的行数有界', async () => {
  const { x, y } = await family();
  const { appId } = w();
  expect(await search({ appId, q: orderNo() })).toEqual({ count: 0, rows: [] });
  expect(await search({ appId, q: x.sub_order_id.slice(0, -1) })).toEqual({ count: 0, rows: [] });
  expect(await search({ appId, q: (y.parent_order_id ?? '').slice(0, -1) })).toEqual({
    count: 0,
    rows: [],
  });
});

it('[AC-B1-09x#6] 后台订单搜索按子单号命中（不带与带 platform）：同一事务内 count 与 page 不顺序扫描 app.orders 任何分区，读的行数有界，只列这一单', async () => {
  const { app, appId } = w();
  const q = orderNo();
  const hit = await addOrder(app, {
    appId,
    platform: 'jd',
    sub: q,
    parent: orderNo(),
    attrAt: ATTR_AT.september,
  });
  await expectBackground(w());
  const filters: AdminOrderFilter[] = [
    { appId, q },
    { appId, platform: 'jd', q },
  ];
  for (const filter of filters) {
    expect(await search(filter, 0, 20)).toEqual({ count: 1, rows: [shown(hit)] });
  }
});

it('[AC-B1-09x#7] 后台订单搜索按父单号命中（不带 platform）：同一事务内 count 与 page 不顺序扫描 app.orders 任何分区，读的行数有界，两个分区的子单按 paid_at 倒序列出', async () => {
  const { app, appId } = w();
  const q = orderNo();
  const first = await addOrder(app, {
    appId,
    platform: 'taobao',
    sub: orderNo(),
    parent: q,
    attrAt: ATTR_AT.fallback,
    paidAt: new Date('2026-10-01T01:00:00Z'),
  });
  const second = await addOrder(app, {
    appId,
    platform: 'taobao',
    sub: orderNo(),
    parent: q,
    attrAt: ATTR_AT.october,
    paidAt: new Date('2026-10-02T01:00:00Z'),
  });
  await expectBackground(w());
  expect(await search({ appId, q }, 0, 20)).toEqual({
    count: 2,
    rows: [shown(second), shown(first)],
  });
});
