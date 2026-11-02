// B2-03q · D10-568，后台改派：assignOrder 经真实 runCommissionSnapshot 与真实 commission；settlement 用 B1-10f
// 夹具的假端口（这里只看快照与版本）。created：版本 0 置 1；版本 ≥ 1 照写 v1 并写当前版本，不补中间版本。
// existing、pending、skip：版本不动。规则版本：京东预留 1500，本人 5000。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  assigned,
  at,
  fixture,
  open,
  type Fixture,
  type Harness,
} from '../../orders/admin-assign/db-kit.ts';
import {
  amountsAt,
  commission,
  orderRow,
  portOrderOf,
  snapshotPortOf,
  snapshotRules,
  storedVersions,
  totalsAt,
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

it('[AC-B2-03q#71] 快照 created、版本 0 → 同事务置 1，读取端口按版本 1 正常', async () => {
  const f = await fixture(h);
  await snapshotRules(f.db, f.appId);
  const o = await f.order();
  const ref = portOrderOf(o);

  assigned(await f.assign(o, {}, { deps: { snapshots: portOf(f) } }));

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

it('[AC-B2-03q#72] 未归因期间版本已到 3，快照 created：照写 v1，同事务写 v3，不补中间版本，版本不动', async () => {
  const f = await fixture(h);
  await snapshotRules(f.db, f.appId);
  const o = await f.order({ commission_version: 3, est_commission_fen: 1600n });
  const ref = portOrderOf(o);

  assigned(await f.assign(o, {}, { deps: { snapshots: portOf(f) } }));

  // 1600 × 85% = 1360；本人 680。
  expect(await orderRow(f.db, ref)).toMatchObject({ commission_version: 3 });
  expect(await storedVersions(f.db, ref)).toEqual({ amounts: [1, 3], totals: [1, 3] });
  expect(await amountsAt(f.db, ref, 3)).toEqual([['self', 1360n, 680n]]);
  expect(await totalsAt(f.db, ref, 3)).toEqual(await totalsAt(f.db, ref, 1));
  const read = await f.db.transaction().execute((trx) =>
    commission.readCommissionSnapshot(trx, {
      appId: ref.appId,
      orderId: ref.orderId,
      commissionVersion: 3,
    }),
  );
  expect(read).toMatchObject({ commissionVersion: 3, baseFen: 1360n });
});

it.each([0, 2])('[AC-B2-03q#73] 快照 existing（版本 %i）：版本不动，不写新行', async (version) => {
  const f = await fixture(h);
  await snapshotRules(f.db, f.appId);
  const o = await f.order({ commission_version: version });
  const ref = portOrderOf(o);
  const port = portOf(f);
  await f.db.transaction().execute((trx) =>
    port.create(trx, {
      appId: f.appId,
      orderId: o.order_id,
      platform: 'jd',
      paidAt: at('2027-12-12T03:00:00.000Z'),
      paidAtSource: 'platform',
      orderType: 'self',
      activityType: null,
      rebateMode: null,
      nBaseFen: 1200n,
      subsidyCommissionFen: 0n,
      tljDeductFen: 0n,
      tljRedpacketFen: 0n,
      ownerUserId: f.subject.user_id,
    }),
  );
  const before = await storedVersions(f.db, ref);

  assigned(await f.assign(o, {}, { deps: { snapshots: port } }));

  expect(f.rebate.onAdminAssigned.mock.calls[0]?.[1]).toMatchObject({ snapshot: 'existing' });
  expect(await orderRow(f.db, ref)).toMatchObject({ commission_version: version });
  expect(await storedVersions(f.db, ref)).toEqual(before);
});

it.each([
  ['端口 pending（规则缺预留）', 'pending', 'jd', false, {}],
  ['计划 pending（拼多多服务费缺失）', 'pending', 'pdd', true, {}],
  [
    '计划 skip（预售定金阶段）',
    'none',
    'jd',
    true,
    {
      platform_status: 'DEPOSIT_PAID',
      is_presale: true,
      paid_at: null,
      deposit_paid_at: at('2027-12-10T02:00:00.000Z'),
      received_at: null,
    },
  ],
] as const)(
  '[AC-B2-03q#74] %s：版本不动，不写金额行',
  async (_name, snapshot, platform, reserves, patch) => {
    for (const version of [0, 2]) {
      const f = await fixture(h);
      await snapshotRules(f.db, f.appId, { reserves });
      const o = await f.order({ platform, commission_version: version, ...patch });
      const ref = portOrderOf(o);

      assigned(await f.assign(o, {}, { deps: { snapshots: portOf(f) } }));

      expect(f.rebate.onAdminAssigned.mock.calls[0]?.[1]).toMatchObject({ snapshot });
      expect(await orderRow(f.db, ref)).toMatchObject({ commission_version: version });
      expect(await storedVersions(f.db, ref)).toEqual({ amounts: [], totals: [] });
    }
  },
);
