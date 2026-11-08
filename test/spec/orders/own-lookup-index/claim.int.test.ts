// B1-09x (FU-ORDERS-OWN-LOOKUP-INDEX, D10-853) path 3: findClaimOrders (H5 找回). Taobao / jd
// compare the stored number verbatim: by 'sub' the lookup goes through order_keys, by 'parent'
// through orders_parent_order_idx. Every taobao / jd call below is measured (app.orders read by
// key; red on main through the sub lookups, which filter orders.sub_order_id without an index),
// then its rows are checked against what main returns. pdd keeps comparing replace(col, '-', '')
// with the hyphen-free input (no index, FU-PDD-ORDERNO-NORMALIZED-INDEX): its calls are not
// measured and sit in a case that also measures taobao / jd calls. Shared helpers: ./kit.ts.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import {
  findClaimOrders,
  type ClaimOrderRow,
} from '../../../../apps/api/src/modules/orders/infra/claim-store.ts';
import {
  addOrder,
  ATTR_AT,
  expectBackground,
  installWorld,
  inTransaction,
  keyedRead,
  orderNo,
  pddOrderSn,
  type NewOrder,
  type Platform,
  type StoredOrder,
} from './kit.ts';

const w = installWorld(createTestDatabase);

const DETAILS = {
  buyType: 'self',
  rebateStatus: 'ESTIMATED',
  locked: false,
  productKey: 'pk-own-lookup',
  shopId: 'shop-own-lookup',
} as const;

/** An order of the world's app (its user, DETAILS) with these numbers. */
async function order(
  platform: Platform,
  sub: string,
  parent: string | null,
  extra: Partial<NewOrder> = {},
): Promise<StoredOrder> {
  const { app, appId, userId } = w();
  return addOrder(app, { appId, platform, sub, parent, userId, ...DETAILS, ...extra });
}

/** The ClaimOrderRow acceptance reads of an order written by `order`. */
function claimRow(stored: StoredOrder): ClaimOrderRow {
  return {
    order_id: stored.order_id,
    sub_order_id: stored.sub_order_id,
    buy_type: DETAILS.buyType,
    user_id: w().userId,
    rebate_status: DETAILS.rebateStatus,
    locked: DETAILS.locked,
    attr_at: stored.attr_at,
    product_key: DETAILS.productKey,
    shop_id: DETAILS.shopId,
    raw_item_id: `item-${stored.sub_order_id}`,
  };
}

function bySub(rows: readonly ClaimOrderRow[]): ClaimOrderRow[] {
  return [...rows].sort((a, b) => (a.sub_order_id < b.sub_order_id ? -1 : 1));
}

/**
 * findClaimOrders in a transaction of its own, rows sorted by sub number. Taobao / jd calls are
 * measured (no sequential scan of app.orders, rows read within READ_BOUND); pdd calls are not
 * (hyphen-stripped fallback, no index).
 */
async function find(
  platform: Platform,
  value: string,
  by: 'sub' | 'parent',
  appId = w().appId,
): Promise<ClaimOrderRow[]> {
  const call = (trx: Transaction<DB>) => findClaimOrders(trx, appId, platform, value, by);
  const rows =
    platform === 'pdd'
      ? await inTransaction(w(), call)
      : await keyedRead(w(), call, (result) => result.length > 0);
  return bySub(rows);
}

it.each(['taobao', 'jd'] as const)(
  '[AC-B1-09x#11] 找回 %s 按子单号：命中本 app 该平台的那一单（字段同改写前）；只是父单号的值、别的 app、别的平台的同号都不命中；每次都不顺序扫描 app.orders、读的行数有界',
  async (platform) => {
    const parent = orderNo();
    const hit = await order(platform, orderNo(), parent, { attrAt: ATTR_AT.september });
    const theirs = orderNo();
    await addOrder(w().app, { appId: w().otherAppId, platform, sub: theirs, parent: null });
    await expectBackground(w());

    expect(await find(platform, hit.sub_order_id, 'sub')).toEqual([claimRow(hit)]);
    expect(await find(platform, parent, 'sub')).toEqual([]);
    expect(await find(platform, theirs, 'sub')).toEqual([]);
    expect(await find(platform, theirs, 'sub', w().otherAppId)).toHaveLength(1);

    const other = platform === 'jd' ? 'taobao' : 'jd';
    expect(await find(other, hit.sub_order_id, 'sub')).toEqual([]);
    expect(await find(platform, orderNo(), 'sub')).toEqual([]);
  },
);

it.each(['taobao', 'jd'] as const)(
  '[AC-B1-09x#12] 找回 %s 按父单号：列出本 app 该平台这个父单下的全部子单（跨分区）；只是子单号的值、别的 app 的同父单子单、别的平台的同父单子单都不在；其子单按子单号仍可单独找回；每次都不顺序扫描 app.orders、读的行数有界',
  async (platform) => {
    const parent = orderNo();
    const first = await order(platform, orderNo(), parent, { attrAt: ATTR_AT.fallback });
    const second = await order(platform, orderNo(), parent, { attrAt: ATTR_AT.october });
    const lone = await order(platform, orderNo(), null);
    const other = platform === 'jd' ? 'taobao' : 'jd';
    await order(other, orderNo(), parent);
    await addOrder(w().app, { appId: w().otherAppId, platform, sub: orderNo(), parent });
    await expectBackground(w());

    expect(await find(platform, first.sub_order_id, 'sub')).toEqual([claimRow(first)]);
    expect(await find(platform, parent, 'parent')).toEqual(
      bySub([claimRow(first), claimRow(second)]),
    );
    expect(await find(platform, first.sub_order_id, 'parent')).toEqual([]);
    expect(await find(platform, lone.sub_order_id, 'parent')).toEqual([]);
    expect(await find(platform, orderNo(), 'parent')).toEqual([]);
  },
);

it('[AC-B1-09x#13] 找回拼多多照旧去横线比较：库里带横线的子单号 / 父单号与去横线的输入相等即命中，不带横线存的也命中；别的 app 不命中；淘宝 / 京东照旧原样比较（带横线存的只按原样命中，不去横线），且这些淘宝 / 京东查找不顺序扫描 app.orders、读的行数有界', async () => {
  const sn = pddOrderSn();
  const stripped = sn.replaceAll('-', '');
  const verbatim: Record<'taobao' | 'jd', StoredOrder> = {
    taobao: await order('taobao', sn, null),
    jd: await order('jd', sn, null, { attrAt: ATTR_AT.september }),
  };
  const hit = await order('pdd', sn, null);
  const parentSn = pddOrderSn();
  const child = await order('pdd', pddOrderSn(), parentSn, { attrAt: ATTR_AT.september });
  const plain = pddOrderSn().replaceAll('-', '');
  const plainHit = await order('pdd', plain, null);
  const theirs = pddOrderSn();
  await addOrder(w().app, { appId: w().otherAppId, platform: 'pdd', sub: theirs, parent: null });
  await expectBackground(w());

  for (const platform of ['taobao', 'jd'] as const) {
    expect(await find(platform, sn, 'sub')).toEqual([claimRow(verbatim[platform])]);
    expect(await find(platform, stripped, 'sub')).toEqual([]);
  }

  expect(await find('pdd', stripped, 'sub')).toEqual([claimRow(hit)]);
  expect(await find('pdd', parentSn.replaceAll('-', ''), 'parent')).toEqual([claimRow(child)]);
  expect(await find('pdd', plain, 'sub')).toEqual([claimRow(plainHit)]);
  expect(await find('pdd', theirs.replaceAll('-', ''), 'sub')).toEqual([]);
});

it.each(['taobao', 'jd'] as const)(
  '[AC-B1-09x#14] 找回 %s 先按子单号、再按父单号命中：两次查找各自在同一事务内不顺序扫描 app.orders 任何分区，读的行数有界',
  async (platform) => {
    const parent = orderNo();
    const first = await order(platform, orderNo(), parent, { attrAt: ATTR_AT.september });
    const second = await order(platform, orderNo(), parent, { attrAt: ATTR_AT.fallback });
    await expectBackground(w());
    expect(await find(platform, second.sub_order_id, 'sub')).toEqual([claimRow(second)]);
    expect(await find(platform, parent, 'parent')).toEqual(
      bySub([claimRow(first), claimRow(second)]),
    );
  },
);
