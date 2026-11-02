import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOrderPipeline } from '../../../../apps/api/src/modules/orders/index.ts';
import {
  at,
  capture,
  fresh,
  fakePort,
  runFresh,
  untouchedAmounts,
} from '../commission-snapshot/db-kit.ts';
import { setup } from '../snapshot-retry/kit.ts';
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

it.each([true, false])('[AC-B1-08v#4] 拼多多首次入库保存服务费，已归因=%s', async (attributed) => {
  await requireFeeColumn(db);
  const f = await fresh(db);
  if (!attributed) f.findUser.mockResolvedValue(null);
  const port = fakePort();
  expect(await runFresh(f, port)).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  expect((await readFee(db, f.ctx.app_id))[0]?.service_fee_fen).toBe(31n);
  expect((await f.read()).orders[0]?.user_id).toBe(attributed ? f.userId : null);
  expect(port.create).toHaveBeenCalledTimes(attributed ? 1 : 0);
});

it.each(['null', 'omitted'] as const)('[AC-B1-08v#5] 京东服务费 %s 入库为 NULL', async (mode) => {
  await requireFeeColumn(db);
  const f = await fresh(db, {
    platform: 'jd',
    service_fee_fen: null,
    attr_params: { relation_id: null, sub_union_id: 'n_abcd1234', custom_parameters: null },
  });
  if (mode === 'omitted')
    delete (f.incoming as { service_fee_fen?: bigint | null }).service_fee_fen;
  expect(await runFresh(f, fakePort())).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  expect((await readFee(db, f.ctx.app_id))[0]?.service_fee_fen).toBeNull();
});

it('[AC-B1-08v#6] 仅服务费变化也进入 CAS 更新，重放不再写订单', async () => {
  await requireFeeColumn(db);
  const f = await setup(db);
  const before = (await f.read()).orders[0]!;
  const incoming = { ...f.incoming, service_fee_fen: 47n };
  expect(await f.process(incoming)).toMatchObject({ kind: 'updated' });
  const after = (await f.read()).orders[0]!;
  expect((await readFee(db, f.ctx.app_id))[0]?.service_fee_fen).toBe(47n);
  expect(after.row_version).toBe(before.row_version + 1);
  expect(after.content_hash).not.toBe(before.content_hash);
  expect(untouchedAmounts(after)).toEqual(untouchedAmounts(before));
  expect(after.hold).toBe(before.hold);
  f.queries.length = 0;
  expect(await f.process(incoming)).toMatchObject({ kind: 'unchanged' });
  expect((await f.read()).orders).toEqual([after]);
  expect(f.queries.filter((q) => /^update "app"\."orders" /i.test(q.sql))).toEqual([]);
});

it.each(['null', 'omitted', 'zero'] as const)(
  '[AC-B1-08v#7] 写库报文服务费 %s 原样覆盖旧值',
  async (mode) => {
    await requireFeeColumn(db);
    const f = await setup(db);
    const incoming = { ...f.next(), service_fee_fen: mode === 'zero' ? 0n : null };
    if (mode === 'omitted')
      delete (incoming as { service_fee_fen?: bigint | null }).service_fee_fen;
    expect(await f.process(incoming)).toMatchObject({ kind: 'updated' });
    expect((await readFee(db, f.ctx.app_id))[0]?.service_fee_fen).toBe(mode === 'zero' ? 0n : null);
    // 这一列只留存，不进 N：est 789、报文服务费 47，重试的 N 仍是 789。
    const charged = await setup(db);
    expect(await charged.process({ ...charged.next(), service_fee_fen: 47n })).toMatchObject({
      kind: 'updated',
    });
    expect(charged.port.create).toHaveBeenCalledTimes(1);
    expect(charged.port.create.mock.calls[0]?.[1]).toMatchObject({ nBaseFen: 789n });
    if (mode !== 'zero') {
      // est 为空的新单（真实报文缺服务费就是这样）：不调端口，待处理原因是 SERVICE_FEE_RATE_MISSING。
      const g = await setup(db, { est_commission_fen: null, service_fee_fen: null });
      const again = { ...g.next(), service_fee_fen: null };
      if (mode === 'omitted') delete (again as { service_fee_fen?: bigint | null }).service_fee_fen;
      expect(await g.process(again)).toMatchObject({ kind: 'updated' });
      expect((await readFee(db, g.ctx.app_id))[0]?.service_fee_fen).toBeNull();
      expect(g.port.create).not.toHaveBeenCalled();
      expect(await g.pending()).toContainEqual(
        expect.objectContaining({ reason: 'SERVICE_FEE_RATE_MISSING' }),
      );
    }
  },
);

it('[AC-B1-08v#8] 乱序报文不覆盖服务费，整条拒收也不落服务费', async () => {
  await requireFeeColumn(db);
  const f = await setup(db);
  const before = (await f.read()).orders;
  const pipeline = createOrderPipeline({ ...f.deps, snapshots: f.port, mtimeOrdering: () => true });
  expect(
    await pipeline.process(
      { ...f.incoming, service_fee_fen: 99n, modified_at: at('2026-10-15T08:00:00Z') },
      f.ctx,
    ),
  ).toMatchObject({ kind: 'stale' });
  expect((await f.read()).orders).toEqual(before);
  // 已入账订单收到表外码，整条拒收（沿用已有判定）。
  await db
    .updateTable('orders')
    .set({ rebate_status: 'CREDITED' })
    .where('app_id', '=', f.ctx.app_id)
    .execute();
  const booked = (await f.read()).orders;
  expect(
    await f.process({ ...f.next(), raw_status: 'synthetic-unmapped', service_fee_fen: 99n }),
  ).toMatchObject({ kind: 'pending' });
  expect((await f.read()).orders).toEqual(booked);
  expect((await readFee(db, f.ctx.app_id))[0]?.service_fee_fen).toBe(31n);
});

it('[AC-B1-08v#9] 存量 NULL 不因读取或 unchanged 重放回填，变更报文才写入', async () => {
  await requireFeeColumn(db);
  const f = await setup(db);
  await setFee(db, f.ctx.app_id, null);
  const before = (await f.read()).orders;
  expect(await f.process()).toMatchObject({ kind: 'unchanged' });
  expect((await readFee(db, f.ctx.app_id))[0]?.service_fee_fen).toBeNull();
  expect((await f.read()).orders).toEqual(before);
  expect(await f.process(f.next())).toMatchObject({ kind: 'updated' });
  expect((await readFee(db, f.ctx.app_id))[0]?.service_fee_fen).toBe(31n);
});

it('[AC-B1-08v#10] 后续端口失败时服务费随订单事务回滚', async () => {
  await requireFeeColumn(db);
  const f = await setup(db);
  const before = await f.read();
  f.onUpdated.mockRejectedValueOnce(new Error('synthetic settlement failure'));
  expect(await capture(() => f.process({ ...f.next(), service_fee_fen: 57n }))).toMatchObject({
    ok: false,
  });
  expect(await f.read()).toEqual(before);
  expect((await readFee(db, f.ctx.app_id))[0]?.service_fee_fen).toBe(31n);
});
