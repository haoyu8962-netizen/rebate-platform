// B1-09x (FU-ORDERS-OWN-LOOKUP-INDEX, D10-853) path 2: readOwnTaobaoOrderNos (B1-04zzu). Before
// the change one statement read app.orders with `sub_order_id IN … OR parent_order_id IN …`; after
// it the sub numbers go through order_keys and the parent numbers through
// orders_parent_order_idx. Every call below is measured: app.orders is read by key (red on main,
// where the sub_order_id IN … filter has no index), then the answer set is checked against what
// main returns. Shared helpers and the scan measurement: ./kit.ts.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import { readOwnTaobaoOrderNos } from '../../../../apps/api/src/modules/orders/infra/own-taobao-orders.ts';
import { addOrder, ATTR_AT, expectBackground, installWorld, keyedRead, orderNo } from './kit.ts';

const w = installWorld(createTestDatabase);

/**
 * The answer set, sorted; the call is measured (no sequential scan of app.orders, rows read within
 * READ_BOUND).
 */
async function own(appId: string, orderNos: readonly string[]): Promise<string[]> {
  const found = await keyedRead(
    w(),
    (trx) => readOwnTaobaoOrderNos(trx, appId, orderNos),
    (result) => result.size > 0,
  );
  expect(found).toBeInstanceOf(Set);
  return [...found].sort();
}

/**
 * Taobao orders of the app: s1 and s2 children of p1 (two partitions), s3 without a parent, s6
 * whose parent number is its own; a jd order s4 / p4; the other app's taobao order s5 / p5.
 */
async function stored() {
  const { app, appId, otherAppId } = w();
  const n = {
    s1: orderNo(),
    s2: orderNo(),
    p1: orderNo(),
    s3: orderNo(),
    s4: orderNo(),
    p4: orderNo(),
    s5: orderNo(),
    p5: orderNo(),
    s6: orderNo(),
  };
  await addOrder(app, { appId, platform: 'taobao', sub: n.s1, parent: n.p1 });
  await addOrder(app, {
    appId,
    platform: 'taobao',
    sub: n.s2,
    parent: n.p1,
    attrAt: ATTR_AT.fallback,
  });
  await addOrder(app, {
    appId,
    platform: 'taobao',
    sub: n.s3,
    parent: null,
    attrAt: ATTR_AT.september,
  });
  await addOrder(app, { appId, platform: 'taobao', sub: n.s6, parent: n.s6 });
  await addOrder(app, { appId, platform: 'jd', sub: n.s4, parent: n.p4 });
  await addOrder(app, { appId: otherAppId, platform: 'taobao', sub: n.s5, parent: n.p5 });
  await expectBackground(w());
  return n;
}

it('[AC-B1-09x#8] readOwnTaobaoOrderNos：子单号与父单号混合传入，答案是其中本 app 淘宝订单的子单号或父单号（原样相等）；京东、别的 app、没入库的、只差前导零的不在；重复只答一次；同一事务内不顺序扫描 app.orders、读的行数有界', async () => {
  const n = await stored();
  const { appId } = w();
  const missing = orderNo();
  expect(
    await own(appId, [n.s1, n.p1, n.s3, n.s4, n.p4, n.s5, n.p5, missing, `0${n.s1}`, n.s1, n.p1]),
  ).toEqual([n.s1, n.p1, n.s3].sort());
});

it('[AC-B1-09x#9] readOwnTaobaoOrderNos：只问父单号也算（父单下两个子单也只答一次）；单号同为某单的子单号与父单号只答一次；只问子单号不带出它的父单号；空入参答空集；每次都不顺序扫描 app.orders、读的行数有界', async () => {
  const n = await stored();
  const { appId, otherAppId } = w();
  expect(await own(appId, [n.p1])).toEqual([n.p1]);
  expect(await own(appId, [n.s6])).toEqual([n.s6]);
  expect(await own(appId, [n.s2])).toEqual([n.s2]);
  expect(await own(appId, [])).toEqual([]);
  expect(await own(otherAppId, [n.s5, n.p5, n.s1, n.p1])).toEqual([n.s5, n.p5].sort());
});

it('[AC-B1-09x#10] readOwnTaobaoOrderNos 混合传入子单号与父单号：同一事务内不顺序扫描 app.orders 任何分区，读的行数有界', async () => {
  const n = await stored();
  const asked = [n.s1, n.p1, n.s3, n.s4, n.s5, orderNo()];
  expect(await own(w().appId, asked)).toEqual([n.s1, n.p1, n.s3].sort());
});
