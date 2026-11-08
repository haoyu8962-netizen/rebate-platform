// B1-09x (FU-ORDERS-OWN-LOOKUP-INDEX, D10-853) path 4: findOrderForRights (rights sync and the
// console rights import). Taobao / jd: the sub number goes through order_keys, and when it misses,
// the diagnostic parent probe goes through orders_parent_order_idx. Every taobao / jd call below
// is measured (app.orders read by key; red on main, where the sub lookup filters
// orders.sub_order_id without an index), then its result is checked against what main returns.
// pdd keeps its hyphen-stripped UNION (no index, FU-PDD-ORDERNO-NORMALIZED-INDEX): its calls are
// not measured and sit in a case that also measures taobao / jd calls. Shared helpers: ./kit.ts.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import {
  findOrderForRights,
  type RightsOrderLookupResult,
} from '../../../../apps/api/src/modules/orders/infra/rights-order-lookup.ts';
import {
  addOrder,
  ATTR_AT,
  expectBackground,
  installWorld,
  inTransaction,
  keyedRead,
  orderNo,
  orderRow,
  pddOrderSn,
  type Platform,
} from './kit.ts';

const w = installWorld(createTestDatabase);

/**
 * findOrderForRights in a transaction of its own. Taobao / jd calls are measured (no sequential
 * scan of app.orders, rows read within READ_BOUND; found and sub_order_no_missing read orders rows
 * through an index); pdd calls are not (hyphen-stripped fallback, no index).
 */
async function lookup(
  platform: Platform,
  no: string,
  appId = w().appId,
): Promise<RightsOrderLookupResult> {
  const call = (trx: Transaction<DB>) =>
    findOrderForRights(trx, { app_id: appId, platform, platform_order_no: no });
  if (platform === 'pdd') return inTransaction(w(), call);
  return keyedRead(w(), call, (result) => result.kind !== 'not_found');
}

async function found(orderId: string): Promise<RightsOrderLookupResult> {
  return { kind: 'found', order: await orderRow(w().app, orderId) };
}

const MISSING = { kind: 'sub_order_no_missing' } as const;
const NOT_FOUND = { kind: 'not_found' } as const;

it.each(['taobao', 'jd'] as const)(
  '[AC-B1-09x#15] 维权定位 %s：子单号命中答 found（整行同改写前）；只命中父单号答 sub_order_no_missing；都不命中答 not_found；别的 app、别的平台的同号不算；单号原样比较（保留横线与前导零）；每次都不顺序扫描 app.orders、读的行数有界',
  async (platform) => {
    const { app, appId, otherAppId } = w();
    const parent = orderNo();
    const hit = await addOrder(app, {
      appId,
      platform,
      sub: orderNo(),
      parent,
      attrAt: ATTR_AT.september,
    });
    const theirSub = orderNo();
    const theirParent = orderNo();
    await addOrder(app, { appId: otherAppId, platform, sub: theirSub, parent: theirParent });
    const verbatim = `000123-${orderNo()}`;
    const kept = await addOrder(app, { appId, platform, sub: verbatim, parent: null });
    await expectBackground(w());

    expect(await lookup(platform, hit.sub_order_id)).toEqual(await found(hit.order_id));
    expect(await lookup(platform, parent)).toEqual(MISSING);
    expect(await lookup(platform, orderNo())).toEqual(NOT_FOUND);
    expect(await lookup(platform, theirSub)).toEqual(NOT_FOUND);
    expect(await lookup(platform, theirParent)).toEqual(NOT_FOUND);

    const other = platform === 'jd' ? 'taobao' : 'jd';
    expect(await lookup(other, hit.sub_order_id)).toEqual(NOT_FOUND);
    expect(await lookup(other, parent)).toEqual(NOT_FOUND);

    expect(await lookup(platform, verbatim)).toEqual(await found(kept.order_id));
    expect(await lookup(platform, verbatim.replaceAll('-', ''))).toEqual(NOT_FOUND);
    expect(await lookup(platform, verbatim.slice(3))).toEqual(NOT_FOUND);
  },
);

it.each(['taobao', 'jd'] as const)(
  '[AC-B1-09x#16] 维权定位 %s：同一单的子单号与父单号相同答 found；某单的子单号恰是另一单的父单号时答子单号那一单；每次都不顺序扫描 app.orders、读的行数有界',
  async (platform) => {
    const { app, appId } = w();
    const same = orderNo();
    const single = await addOrder(app, { appId, platform, sub: same, parent: same });
    const shared = orderNo();
    const own = await addOrder(app, { appId, platform, sub: shared, parent: orderNo() });
    await addOrder(app, {
      appId,
      platform,
      sub: orderNo(),
      parent: shared,
      attrAt: ATTR_AT.fallback,
    });
    await expectBackground(w());

    expect(await lookup(platform, same)).toEqual(await found(single.order_id));
    expect(await lookup(platform, shared)).toEqual(await found(own.order_id));
  },
);

it('[AC-B1-09x#17] 维权定位拼多多照旧去横线：带横线存的子单号按任意横线写法命中 found；只命中去横线后的父单号答 sub_order_no_missing；别的 app 的不算；同号的淘宝 / 京东单照旧原样比较（去横线写法不命中），且这些淘宝 / 京东查找不顺序扫描 app.orders、读的行数有界', async () => {
  const { app, appId, otherAppId } = w();
  const sn = pddOrderSn();
  const digits = sn.replaceAll('-', '');
  const verbatim = {
    taobao: await addOrder(app, { appId, platform: 'taobao', sub: sn, parent: null }),
    jd: await addOrder(app, {
      appId,
      platform: 'jd',
      sub: sn,
      parent: null,
      attrAt: ATTR_AT.september,
    }),
  };
  const hit = await addOrder(app, { appId, platform: 'pdd', sub: sn, parent: null });
  const parentSn = pddOrderSn();
  await addOrder(app, {
    appId,
    platform: 'pdd',
    sub: pddOrderSn(),
    parent: parentSn,
    attrAt: ATTR_AT.october,
  });
  const theirs = pddOrderSn();
  await addOrder(app, { appId: otherAppId, platform: 'pdd', sub: theirs, parent: null });
  await expectBackground(w());

  for (const platform of ['taobao', 'jd'] as const) {
    expect(await lookup(platform, sn)).toEqual(await found(verbatim[platform].order_id));
    expect(await lookup(platform, digits)).toEqual(NOT_FOUND);
  }

  for (const asked of [
    sn,
    digits,
    `${digits.slice(0, 3)}-${digits.slice(3, 9)}-${digits.slice(9)}`,
  ]) {
    expect(await lookup('pdd', asked)).toEqual(await found(hit.order_id));
  }
  expect(await lookup('pdd', parentSn.replaceAll('-', ''))).toEqual(MISSING);
  expect(await lookup('pdd', parentSn)).toEqual(MISSING);
  expect(await lookup('pdd', theirs)).toEqual(NOT_FOUND);
  expect(await lookup('pdd', pddOrderSn())).toEqual(NOT_FOUND);
});

it.each(['taobao', 'jd'] as const)(
  '[AC-B1-09x#18] 维权定位 %s 子单号命中（默认分区）：同一事务内不顺序扫描 app.orders 任何分区，读的行数有界，答 found 整行',
  async (platform) => {
    const { app, appId } = w();
    const hit = await addOrder(app, {
      appId,
      platform,
      sub: orderNo(),
      parent: orderNo(),
      attrAt: ATTR_AT.fallback,
    });
    await expectBackground(w());
    expect(await lookup(platform, hit.sub_order_id)).toEqual(await found(hit.order_id));
  },
);

it.each(['taobao', 'jd'] as const)(
  '[AC-B1-09x#19] 维权定位 %s 子单号未命中、父单号探查命中两个分区的子单（sub_order_no_missing）：同一事务内不顺序扫描 app.orders 任何分区，读的行数有界',
  async (platform) => {
    const { app, appId } = w();
    const parent = orderNo();
    await addOrder(app, { appId, platform, sub: orderNo(), parent, attrAt: ATTR_AT.september });
    await addOrder(app, { appId, platform, sub: orderNo(), parent, attrAt: ATTR_AT.october });
    await expectBackground(w());
    expect(await lookup(platform, parent)).toEqual(MISSING);
  },
);

it.each(['taobao', 'jd'] as const)(
  '[AC-B1-09x#20] 维权定位 %s 子单号与父单号探查都不命中（not_found）：同一事务内不顺序扫描 app.orders 任何分区，读的行数有界',
  async (platform) => {
    await expectBackground(w());
    expect(await lookup(platform, orderNo())).toEqual(NOT_FOUND);
  },
);
