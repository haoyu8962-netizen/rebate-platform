// B1-09x (FU-ORDERS-OWN-LOOKUP-INDEX, D10-853) path 5: the snapshot retry reads of
// orders/infra/snapshot-retry-store.ts. readOrderByKey (reread under the lock) and
// selectDueSubOrders (the scan's JOIN of order_sync_pending with orders) go through order_keys
// (PK platform, sub_order_id) and read orders by (order_id, attr_at). Every call below is measured
// (app.orders read by key; red on main, where orders has no index on sub_order_id), then its
// result is checked against what main returns. Shared helpers and the scan measurement: ./kit.ts.
import { sql, type Kysely } from 'kysely';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import {
  readOrderByKey,
  selectDueSubOrders,
  type SubOrderRef,
} from '../../../../apps/api/src/modules/orders/infra/snapshot-retry-store.ts';
import {
  addOrder,
  ATTR_AT,
  expectBackground,
  installWorld,
  keyedRead,
  orderNo,
  orderRow,
  pddOrderSn,
  type NewOrder,
  type Platform,
  type StoredOrder,
} from './kit.ts';

const w = installWorld(createTestDatabase);

/** The scan's clock reading; due means the latest open snapshot row detected ≤ NOW − 1 hour. */
const NOW = new Date('2026-11-08T12:00:00Z');

const RULE = 'RULE_VERSION_PLATFORM_MISSING';
const AMOUNT = 'AMOUNT_PARSE_FAILED';
const FEE = 'SERVICE_FEE_RATE_MISSING';
const HANDOFF = 'auto: commission snapshot retry exhausted; manual';

function ref(order: StoredOrder): SubOrderRef {
  return { app_id: order.app_id, platform: order.platform, sub_order_id: order.sub_order_id };
}

/** readOrderByKey, measured (no sequential scan of app.orders, rows read within READ_BOUND). */
async function byKey(key: SubOrderRef) {
  return keyedRead(
    w(),
    (trx) => readOrderByKey(trx, key),
    (result) => result !== undefined,
  );
}

/** selectDueSubOrders, measured (no sequential scan of app.orders, rows read within READ_BOUND). */
async function dueOf(appId: string, now: Date, limit: number): Promise<SubOrderRef[]> {
  return keyedRead(
    w(),
    (trx) => selectDueSubOrders(trx, appId, now, limit),
    (result) => result.length > 0,
  );
}

async function pending(
  db: Kysely<DB>,
  order: StoredOrder,
  reason: string,
  detectedAt: string,
  extra: { readonly status?: string; readonly note?: string } = {},
): Promise<void> {
  await sql`
    INSERT INTO app.order_sync_pending (app_id, platform, sub_order_id, order_id, reason,
      detected_at, status, resolution_note)
    VALUES (${order.app_id}, ${order.platform}, ${order.sub_order_id}, ${order.order_id}::uuid,
      ${reason}, ${detectedAt}::timestamptz, ${extra.status ?? 'open'}, ${extra.note ?? null})
  `.execute(db);
}

/** An order of the app (with its user, PAID, not attributed) unless `extra` says otherwise. */
async function eligible(platform: Platform, extra: Partial<NewOrder> = {}): Promise<StoredOrder> {
  const { app, appId, userId } = w();
  const sub = platform === 'pdd' ? pddOrderSn() : orderNo();
  return addOrder(app, { appId, platform, sub, parent: orderNo(), userId, ...extra });
}

interface Scenario {
  /** The due sub-orders of the app in scan order. */
  readonly due: readonly SubOrderRef[];
  /** The other app's due sub-order. */
  readonly theirs: SubOrderRef;
}

let scenario: Promise<Scenario> | undefined;

/**
 * Pending snapshot rows of the app (written once, by #22; no other case of this file writes
 * order_sync_pending). Due: e2 (earliest 08:00), e1 (09:00, latest 10:30), e3
 * (exactly NOW − 1 h), and t1, a taobao order with a commission (a scan skip is certain, so last
 * whatever its 07:00). Not due or not eligible: n1 (11:30), n2 (latest 11:30), n3 (no user), n4
 * (INVALID), n5 (VOID), n6 (handed off), n7 (resolved), n8 (not a snapshot reason).
 */
function due(): Promise<Scenario> {
  scenario ??= (async () => {
    const { app, otherAppId, otherUserId } = w();
    const e1 = await eligible('jd', { attrAt: ATTR_AT.september });
    const e2 = await eligible('pdd', { attrAt: ATTR_AT.fallback });
    const e3 = await eligible('jd', { attrAt: ATTR_AT.october, platformStatus: 'RECEIVED' });
    const t1 = await eligible('taobao', { estCommissionFen: 100n, rebateStatus: 'ESTIMATED' });
    const n1 = await eligible('jd');
    const n2 = await eligible('pdd', { attrAt: ATTR_AT.september });
    const n3 = await eligible('jd', { userId: null });
    const n4 = await eligible('jd', { platformStatus: 'INVALID' });
    const n5 = await eligible('jd', { rebateStatus: 'VOID' });
    const n6 = await eligible('jd', { attrAt: ATTR_AT.fallback });
    const n7 = await eligible('jd');
    const n8 = await eligible('jd');
    await pending(app, e1, RULE, '2026-11-08T09:00:00Z');
    await pending(app, e1, AMOUNT, '2026-11-08T10:30:00Z');
    await pending(app, e2, FEE, '2026-11-08T08:00:00Z');
    await pending(app, e3, RULE, '2026-11-08T11:00:00Z');
    await pending(app, t1, RULE, '2026-11-08T07:00:00Z');
    await pending(app, n1, RULE, '2026-11-08T11:30:00Z');
    await pending(app, n2, FEE, '2026-11-08T09:00:00Z');
    await pending(app, n2, AMOUNT, '2026-11-08T11:30:00Z');
    await pending(app, n3, RULE, '2026-11-08T08:30:00Z');
    await pending(app, n4, RULE, '2026-11-08T08:30:00Z');
    await pending(app, n5, RULE, '2026-11-08T08:30:00Z');
    await pending(app, n6, RULE, '2026-11-08T08:30:00Z', { note: HANDOFF });
    await pending(app, n7, RULE, '2026-11-08T08:30:00Z', { status: 'resolved' });
    await pending(app, n8, 'UNMAPPED_STATUS', '2026-11-08T08:30:00Z');
    const other = await addOrder(app, {
      appId: otherAppId,
      platform: 'jd',
      sub: orderNo(),
      parent: null,
      userId: otherUserId,
    });
    await pending(app, other, RULE, '2026-11-08T06:00:00Z');
    return { due: [ref(e2), ref(e1), ref(e3), ref(t1)], theirs: ref(other) };
  })();
  return scenario;
}

it('[AC-B1-09x#21] 快照重试 readOrderByKey：按 (app, platform, 子单号) 读出该单整行（同改写前，三个分区）；别的 app 的同号、别的平台、没入库的读不到；每次都不顺序扫描 app.orders、读的行数有界', async () => {
  const { app, appId, otherAppId, otherUserId } = w();
  const hit = await eligible('jd', { attrAt: ATTR_AT.september });
  const pdd = await eligible('pdd', { attrAt: ATTR_AT.october });
  const theirs = await addOrder(app, {
    appId: otherAppId,
    platform: 'pdd',
    sub: pddOrderSn(),
    parent: null,
    userId: otherUserId,
    attrAt: ATTR_AT.fallback,
  });
  const expected = {
    hit: await orderRow(app, hit.order_id),
    pdd: await orderRow(app, pdd.order_id),
    theirs: await orderRow(app, theirs.order_id),
  };
  await expectBackground(w());

  expect(await byKey(ref(hit))).toEqual(expected.hit);
  expect(await byKey(ref(pdd))).toEqual(expected.pdd);
  expect(await byKey({ ...ref(hit), platform: 'taobao' })).toBeUndefined();
  expect(await byKey({ ...ref(hit), sub_order_id: orderNo() })).toBeUndefined();
  expect(await byKey({ ...ref(theirs), app_id: appId })).toBeUndefined();
  expect(await byKey(ref(theirs))).toEqual(expected.theirs);
});

it('[AC-B1-09x#22] 快照重试 selectDueSubOrders：只选本 app 到期、未转人工、订单满足资格的子订单，必然 skip 的排末尾，其余按最早 detected_at；limit 截断；别的 app 的只在它自己的 app 下；每次都不顺序扫描 app.orders、读的行数有界', async () => {
  const { due: expected, theirs } = await due();
  const { appId, otherAppId } = w();
  await expectBackground(w());
  expect(await dueOf(appId, NOW, 100)).toEqual(expected);
  expect(await dueOf(appId, NOW, 2)).toEqual(expected.slice(0, 2));
  expect(await dueOf(otherAppId, NOW, 100)).toEqual([theirs]);
  expect(await dueOf(appId, new Date('2026-11-08T09:59:59Z'), 100)).toEqual([
    expected[0],
    expected[3],
  ]);
});
