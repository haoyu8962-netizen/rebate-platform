// B2-03q · D10-568，认领审核：approveClaimItem 经真实 runCommissionSnapshot 与真实 commission；settlement 用 B1-10k
// 夹具的假端口（这里只看快照与版本）。created：版本 0 置 1；版本 ≥ 1 照写 v1 并写当前版本，不补中间版本。
// 规则版本：京东预留 1500，本人 5000。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  fixture,
  open,
  success,
  type Fixture,
  type Harness,
} from '../../orders/claims-review/kit.ts';
import {
  amountsAt,
  commission,
  orderRow,
  portOrderOf,
  snapshotPortOf,
  snapshotRules,
  storedVersions,
} from './kit.ts';

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

function portOf(f: Fixture) {
  return snapshotPortOf(f.clock, f.appId, f.subject.user_id);
}

it('[AC-B2-03q#75] 找回通过：快照 created、版本 0 → 同事务置 1，读取端口按版本 1 正常', async () => {
  const f = await fixture(h);
  await snapshotRules(f.db, f.appId);
  const o = await f.order();
  const ref = portOrderOf(o);
  const i = await f.item(await f.claim(), o);

  success(await f.review('approve', i, {}, { snapshots: portOf(f) }));

  // 1200 × 85% = 1020；本人 510。
  expect(await orderRow(f.db, ref)).toMatchObject({ commission_version: 1 });
  expect(await amountsAt(f.db, ref, 1)).toEqual([['self', 1020n, 510n]]);
  const read = await f.db.transaction().execute((trx) =>
    commission.readCommissionSnapshot(trx, {
      appId: ref.appId,
      orderId: ref.orderId,
      commissionVersion: 1,
    }),
  );
  expect(read).toMatchObject({ commissionVersion: 1, baseFen: 1020n });
});

it('[AC-B2-03q#76] 找回通过：未归因期间版本已到 2，快照 created：照写 v1，同事务写 v2，版本不动', async () => {
  const f = await fixture(h);
  await snapshotRules(f.db, f.appId);
  const o = await f.order({ commission_version: 2, est_commission_fen: 1600n });
  const ref = portOrderOf(o);
  const i = await f.item(await f.claim(), o);

  success(await f.review('approve', i, {}, { snapshots: portOf(f) }));

  // 1600 × 85% = 1360；本人 680。
  expect(await orderRow(f.db, ref)).toMatchObject({ commission_version: 2 });
  expect(await storedVersions(f.db, ref)).toEqual({ amounts: [1, 2], totals: [1, 2] });
  expect(await amountsAt(f.db, ref, 2)).toEqual([['self', 1360n, 680n]]);
  const read = await f.db.transaction().execute((trx) =>
    commission.readCommissionSnapshot(trx, {
      appId: ref.appId,
      orderId: ref.orderId,
      commissionVersion: 2,
    }),
  );
  expect(read).toMatchObject({ commissionVersion: 2, baseFen: 1360n });
});
