// B2-04zze rule test: orders' rights-sync writer passes the punishment's violation_type on to
// settlement's rights.record unchanged (orchestrator D10-862: 原值经 RightsSyncItem / RightsRecordInput
// 透传到 settlement 的入参，不落库). settlement is the B1-04zza stand-in of rights-import-rows/db-kit.ts
// (one order_rights row per dedupe key), so only the input handed to rights.record is pinned here.
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
  rightsOf,
  seedOrder,
  type Harness,
  type Order,
} from '../../orders/rights-import-rows/db-kit.ts';

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

function punishItem(rightsNo: string): RightsSyncItem {
  return {
    type: 'PUNISH',
    status: 'SUCCEEDED',
    amount_fen: null,
    deduction_commission_fen: null,
    occurred_at: new FixedClock(PROCESSED).now(),
    platform_rights_no: rightsNo,
  };
}

it('[AC-B2-04zze#8] 违规写入：violation_type（文本、编码形态、空值）原样进 rights.record 的入参，order_rights 不多出任何列值', async () => {
  const appId = newAppId();
  const clock = new FixedClock(PROCESSED);
  const settlement = fakeSettlement(h.db);
  const rights = settlement.ports.rights;
  expect(rights).toBeDefined();
  const writer = createRightsSyncWriter({ db: h.db, clock, rights: rights! });
  const raws = ['订单虚假交易', '2', null] as const;
  const orders: Order[] = [];
  for (const raw of raws) {
    const order = await seedOrder(h.db, appId);
    orders.push(order);
    expect(
      await writer.write(
        { app_id: appId, platform: 'taobao', sub_order_id: order.sub_order_id },
        punishItem(`${order.sub_order_id}:202610`),
        { violation_type: raw },
      ),
    ).toEqual({ kind: 'applied' });
  }

  expect(settlement.calls.map((call) => call.input.violation_type)).toEqual([...raws]);
  expect(settlement.calls.map((call) => call.input.order_id)).toEqual(
    orders.map((order) => order.order_id),
  );
  // FU-REASON-SUB-RAW-BACKFILL: the raw value has no column; the rights rows keep no sub-reason.
  expect((await rightsOf(h.db, appId)).map((row) => [row.type, row.reason_sub])).toEqual([
    ['PUNISH', null],
    ['PUNISH', null],
    ['PUNISH', null],
  ]);
});
