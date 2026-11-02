import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readSnapshotRetryInput } from '../../../../apps/api/src/modules/orders/index.ts';
import { setup, succeed, splits, capture, HOUR } from '../snapshot-retry/kit.ts';
import { requireFeeColumn, readFee, setFee } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it.each([
  { settled: null, estimated: 789n, fee: 31n, expected: 789n },
  { settled: 901n, estimated: 789n, fee: 31n, expected: 901n },
  { settled: 0n, estimated: 789n, fee: 0n, expected: 0n },
  { settled: null, estimated: 789n, fee: 0n, expected: 789n },
  {
    settled: 9_007_199_254_741_782n,
    estimated: 789n,
    fee: 9_007_199_254_740_993n,
    expected: 9_007_199_254_741_782n,
  },
])(
  '[AC-B1-08v#11] 拼多多扫描用持久化结算=$settled、预估=$estimated，N 不减服务费=$fee',
  async (amount) => {
    await requireFeeColumn(db);
    const f = await setup(db, { est_commission_fen: amount.estimated });
    // 与原始报文 31 分不同的值验证扫描只读库；结算列沿用既有夹具的布置方法。
    await setFee(db, f.ctx.app_id, amount.fee);
    await db
      .updateTable('orders')
      .set({ settle_commission_fen: amount.settled })
      .where('app_id', '=', f.ctx.app_id)
      .execute();
    const before = (await f.read()).orders;
    const plan = await capture(() =>
      db.transaction().execute((trx) => readSnapshotRetryInput(trx, before[0]!, f.clock)),
    );
    expect(plan).toMatchObject({
      ok: true,
      value: {
        kind: 'call',
        input: {
          nBaseFen: amount.expected,
          appId: f.ctx.app_id,
          ownerUserId: f.userId,
        },
      },
    });
    expect((await f.read()).orders).toEqual(before);
    // N 与这一列无关：同一单换一个列值，读到的 N 不变。
    const otherFee = await capture(() =>
      db
        .transaction()
        .execute((trx) =>
          readSnapshotRetryInput(trx, { ...before[0]!, service_fee_fen: 47n }, f.clock),
        ),
    );
    expect(otherFee).toMatchObject({
      ok: true,
      value: { kind: 'call', input: { nBaseFen: amount.expected } },
    });
    await succeed(f, db);
    f.clock.advanceMs(HOUR);
    expect(await capture(() => f.scan())).toMatchObject({ ok: true });
    expect(f.port.create).toHaveBeenCalledTimes(1);
    expect(f.port.create.mock.calls[0]?.[1]).toMatchObject({
      nBaseFen: amount.expected,
      paidAt: f.current.paid_at,
      paidAtSource: 'platform',
    });
    expect(await f.pending()).toEqual([
      expect.objectContaining({
        status: 'resolved',
        resolved_at: f.clock.now(),
        resolved_by: null,
      }),
    ]);
    expect(await splits(db, f.ctx.app_id)).toEqual([
      expect.objectContaining({ raw_n_fen: amount.expected }),
    ]);
    // 扫描不写订单上的资金、返利、hold、booked_* 或服务费列。
    expect((await f.read()).orders).toEqual(before);
    await f.scan();
    expect(f.port.create).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-08v#12] 服务费列为空：est 有值照常生成快照且不回填列；est 为空待处理 SERVICE_FEE_RATE_MISSING，不调端口、不回填', async () => {
  await requireFeeColumn(db);
  const f = await setup(db);
  await setFee(db, f.ctx.app_id, null);
  const before = await f.read();
  expect(
    await capture(() =>
      db.transaction().execute((trx) => readSnapshotRetryInput(trx, before.orders[0]!, f.clock)),
    ),
  ).toMatchObject({
    ok: true,
    value: {
      kind: 'call',
      input: { nBaseFen: 789n, appId: f.ctx.app_id, ownerUserId: f.userId },
    },
  });
  await succeed(f, db);
  f.clock.advanceMs(HOUR);
  f.logger.warn.mockClear();
  await f.scan();
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect(f.port.create.mock.calls[0]?.[1]).toMatchObject({ nBaseFen: 789n });
  expect(await splits(db, f.ctx.app_id)).toEqual([expect.objectContaining({ raw_n_fen: 789n })]);
  expect(await f.pending()).toEqual([
    expect.objectContaining({ status: 'resolved', resolved_at: f.clock.now(), resolved_by: null }),
  ]);
  expect((await f.read()).orders).toEqual(before.orders);
  expect((await readFee(db, f.ctx.app_id))[0]?.service_fee_fen).toBeNull();
  expect(f.logger.warn.mock.calls.map(([fields]) => fields)).not.toContainEqual(
    expect.objectContaining({ event: 'snapshot_retry_skipped' }),
  );
  expect(f.alerts()).toEqual([]);

  const missing = await setup(db, { est_commission_fen: null, service_fee_fen: null });
  const unpriced = await missing.read();
  const row = (await missing.pending())[0]!;
  expect(row).toMatchObject({ reason: 'SERVICE_FEE_RATE_MISSING', status: 'open' });
  expect(
    await capture(() =>
      db
        .transaction()
        .execute((trx) => readSnapshotRetryInput(trx, unpriced.orders[0]!, missing.clock)),
    ),
  ).toMatchObject({
    ok: true,
    value: { kind: 'pending', reason: 'SERVICE_FEE_RATE_MISSING' },
  });
  missing.clock.advanceMs(HOUR);
  await missing.scan();
  expect(missing.port.create).not.toHaveBeenCalled();
  expect((await missing.read()).orders).toEqual(unpriced.orders);
  expect((await readFee(db, missing.ctx.app_id))[0]?.service_fee_fen).toBeNull();
  expect(await missing.pending()).toEqual([
    expect.objectContaining({
      id: row.id,
      reason: 'SERVICE_FEE_RATE_MISSING',
      status: 'open',
      created_at: row.created_at,
      detected_at: missing.clock.now(),
    }),
  ]);
  expect(missing.alerts()).toEqual([]);
});

it('[AC-B1-08v#13] 已写服务费的拼多多 pending 刷新 detected_at，原发现时间不延后', async () => {
  await requireFeeColumn(db);
  const f = await setup(db);
  const before = (await f.pending())[0]!;
  f.clock.advanceMs(HOUR);
  await f.scan();
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect((await f.pending())[0]).toMatchObject({
    id: before.id,
    status: 'open',
    detected_at: f.clock.now(),
    created_at: before.created_at,
  });
  expect(f.logger.warn.mock.calls.map(([fields]) => fields)).not.toContainEqual(
    expect.objectContaining({ reason: 'service_fee_unknown' }),
  );
});
