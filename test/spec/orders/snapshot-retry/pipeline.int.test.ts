import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { setup, succeed, splits, capture, HOUR } from './kit.ts';
import { at } from '../attribution/kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

// B1-08t 的补偿信号是 open pending，不是快照不存在，也不是再次跨入资格。
it('[AC-B1-08t#1] 合法内容更新触发重试；成功处置后再次更新不调用快照端口', async () => {
  const f = await setup(db);
  const port = await succeed(f, db);
  const pending = (await f.pending())[0]!;
  await f.process(f.next());
  expect(port.create).toHaveBeenCalledTimes(1);
  expect(await splits(db, f.ctx.app_id)).toHaveLength(1);
  expect(await f.pending()).toEqual([
    expect.objectContaining({ id: pending.id, status: 'resolved', resolved_at: f.clock.now() }),
  ]);
  expect(port.create.mock.calls[0]?.[1]).toMatchObject({
    appId: f.ctx.app_id,
    orderId: f.current.order_id,
    ownerUserId: f.userId,
    paidAt: f.current.paid_at,
    nBaseFen: 789n,
  });
  await f.process(f.next());
  expect(port.create).toHaveBeenCalledTimes(1);
});

it.each(['paid', 'received', 'settled'] as const)(
  '[AC-B1-08t#2] 已有资格的 %s 更新仍补偿一次，并以本次迁移后的状态判定',
  async (raw_status) => {
    const f = await setup(db);
    const port = await succeed(f, db);
    f.clock.advanceMs(20_000);
    await f.process({
      ...f.incoming,
      raw_status,
      modified_at: f.clock.now(),
      received_at: at('2026-10-16T03:04:05Z'),
      settled_at: raw_status === 'settled' ? at('2026-10-17T04:05:06Z') : null,
    });
    expect(port.create).toHaveBeenCalledTimes(1);
    expect((await f.pending())[0]?.status).toBe('resolved');
    expect(f.onUpdated.mock.calls[0]?.[1]).toMatchObject({ snapshot: 'created' });
    expect(f.onUpdated.mock.calls[0]?.[0]).toBe(port.create.mock.calls[0]?.[0]);
  },
);

it('[AC-B1-08t#3] 多条快照 pending 合并为一次重试，非快照待处理不误处置', async () => {
  const f = await setup(db);
  await f.addPending({});
  await f.addPending({ reason: 'SERVICE_FEE_RATE_MISSING' });
  await f.addPending({ reason: 'NO_RECEIVED_AT', detail: null });
  await succeed(f, db);
  await f.process(f.next());
  expect(f.port.create).toHaveBeenCalledTimes(1);
  const rows = await f.pending();
  expect(rows.filter((p) => p.reason !== 'NO_RECEIVED_AT').map((p) => p.status)).toEqual([
    'resolved',
    'resolved',
    'resolved',
  ]);
  expect(rows.find((p) => p.reason === 'NO_RECEIVED_AT')).toMatchObject({
    status: 'open',
    resolved_at: null,
  });
});

it('[AC-B1-08t#4] 已有快照且还有 open 行仍调幂等端口，不覆盖快照内容', async () => {
  const f = await setup(db);
  const port = await succeed(f, db);
  // 经真实端口预建快照，模拟历史任务留下的 open 行；不以是否存在快照作为触发信号。
  await db.transaction().execute((trx) =>
    port.create(trx, {
      appId: f.ctx.app_id,
      orderId: f.current.order_id,
      platform: 'pdd',
      paidAt: f.current.paid_at!,
      paidAtSource: 'platform',
      orderType: 'share',
      activityType: null,
      rebateMode: null,
      nBaseFen: 758n,
      subsidyCommissionFen: 0n,
      tljDeductFen: 0n,
      tljRedpacketFen: 0n,
      ownerUserId: f.userId,
    }),
  );
  const before = await splits(db, f.ctx.app_id);
  port.create.mockClear();
  await f.process(f.next());
  expect(port.create).toHaveBeenCalledTimes(1);
  expect(await splits(db, f.ctx.app_id)).toEqual(before);
  expect((await f.pending())[0]?.status).toBe('resolved');
});

it('[AC-B1-08t#5] pending 结果每次进入只试一次，保留首次时间，恢复后可完成', async () => {
  const f = await setup(db);
  const first = (await f.pending())[0]!;
  for (let i = 1; i <= 3; i++) {
    f.clock.advanceMs(HOUR);
    await f.process(f.next());
    expect(f.port.create).toHaveBeenCalledTimes(i);
    expect(await f.pending()).toEqual([
      expect.objectContaining({
        id: first.id,
        status: 'open',
        created_at: first.created_at,
        resolved_at: null,
      }),
    ]);
  }
  await succeed(f, db);
  await f.process(f.next());
  expect((await f.pending())[0]?.status).toBe('resolved');
});

it('[AC-B1-08t#6] 无 open 快照行、已处置行、未归因、定金与作废扣回不能触发补偿', async () => {
  for (const guard of [
    'absent',
    'resolved',
    'dismissed',
    'unattributed',
    'deposit',
    'invalid',
    'VOID',
    'CLAWED_BACK',
  ]) {
    const f = await setup(db);
    if (guard === 'absent' || guard === 'resolved' || guard === 'dismissed') {
      await db
        .updateTable('order_sync_pending')
        .set(guard === 'absent' ? { reason: 'NO_RECEIVED_AT' } : { status: guard })
        .where('app_id', '=', f.ctx.app_id)
        .execute();
    } else {
      await db
        .updateTable('orders')
        .set(
          guard === 'unattributed'
            ? { user_id: null }
            : guard === 'deposit'
              ? { platform_status: 'DEPOSIT_PAID' }
              : guard === 'invalid'
                ? { platform_status: 'INVALID' }
                : { rebate_status: guard },
        )
        .where('app_id', '=', f.ctx.app_id)
        .execute();
    }
    const before = await f.pending();
    await f.process();
    expect(f.port.create, guard).not.toHaveBeenCalled();
    expect(await f.pending(), guard).toEqual(before);
  }
  // 正向对照保证完全禁用补偿的实现不能让这一组守卫测试通过。
  const eligible = await setup(db);
  await succeed(eligible, db);
  await eligible.process(eligible.next());
  expect(eligible.port.create).toHaveBeenCalledTimes(1);
});

it('[AC-B1-08t#7] 下游失败时真实快照、处置记录和订单更新一起回滚', async () => {
  const f = await setup(db);
  await succeed(f, db);
  const before = await f.read();
  const failure = new Error('synthetic settlement failure');
  const seen: number[] = [];
  f.onUpdated.mockImplementation(async (trx) => {
    seen.push((await splits(trx, f.ctx.app_id)).length);
    throw failure;
  });
  f.clock.advanceMs(30_000);
  const incoming = f.next();
  expect(await capture(() => f.process(incoming))).toEqual({ ok: false, error: failure });
  expect(seen).toEqual([1]);
  expect(await splits(db, f.ctx.app_id)).toEqual([]);
  expect(await f.read()).toEqual(before);
  f.onUpdated.mockResolvedValue(undefined);
  await f.process(incoming);
  expect(await splits(db, f.ctx.app_id)).toHaveLength(1);
  expect((await f.pending())[0]?.status).toBe('resolved');
});

it('[AC-B1-08t#8] 两个独立流水线并发提交同一合法更新，锁内重读确保只调一次', async () => {
  const f = await setup(db);
  const port = await succeed(f, db);
  const incoming = f.next();
  await Promise.all([f.process(incoming), f.process(incoming)]);
  expect(port.create).toHaveBeenCalledTimes(1);
  expect(await splits(db, f.ctx.app_id)).toHaveLength(1);
  expect((await f.pending())[0]?.status).toBe('resolved');
});

it('[AC-B1-08t#20] 流水线重入的持续失败也在24小时后转人工', async () => {
  const f = await setup(db);
  f.clock.advanceMs(24 * HOUR + 1);
  await f.process(f.next());
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect((await f.pending())[0]).toMatchObject({
    status: 'open',
    resolved_at: null,
  });
  expect(f.alerts()).toHaveLength(1);
  f.clock.advanceMs(2 * HOUR);
  await f.process({ ...f.incoming, modified_at: f.clock.now(), est_commission_fen: 790n });
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect(f.alerts()).toHaveLength(1);
});

it('[AC-B1-08t#21] 本次报文迁入 INVALID 时不得按迁移前 PAID 生成补偿快照', async () => {
  const f = await setup(db);
  await succeed(f, db);
  f.clock.advanceMs(20_000);
  const before = await f.pending();
  await f.process({ ...f.incoming, raw_status: 'invalid', modified_at: f.clock.now() });
  expect(f.port.create).not.toHaveBeenCalled();
  expect(await f.pending()).toEqual(before);
  expect(await splits(db, f.ctx.app_id)).toEqual([]);
  const eligible = await setup(db);
  await succeed(eligible, db);
  await eligible.process(eligible.next());
  expect(eligible.port.create).toHaveBeenCalledTimes(1);
});

it('[AC-B1-08t#26] unchanged 重放即使还有 open 快照行也不重试，合法更新才触发', async () => {
  const f = await setup(db);
  await succeed(f, db);
  const before = await f.read();
  const result = await capture(() => f.process());
  expect(result).toMatchObject({ ok: true, value: { kind: 'unchanged' } });
  expect(f.port.create).not.toHaveBeenCalled();
  expect(await f.read()).toEqual(before);
  expect(await splits(db, f.ctx.app_id)).toEqual([]);
  // 正向对照使尚未接入重试的骨架不能靠现有 unchanged 分支通过本例。
  expect(await capture(() => f.process(f.next()))).toMatchObject({ ok: true });
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect((await f.pending())[0]?.status).toBe('resolved');
});
