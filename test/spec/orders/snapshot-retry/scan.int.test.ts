import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { setup, setupScan, succeed, splits, capture, HOUR } from './kit.ts';

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

it('[AC-B1-08t#9] 定时扫描满一小时即补偿，使用注入时钟并按 App 隔离', async () => {
  const f = await setupScan(db);
  const other = await setupScan(db);
  const beforeOther = await other.pending();
  await succeed(f, db);
  f.clock.advanceMs(HOUR - 1);
  await f.scan();
  expect(f.port.create).not.toHaveBeenCalled();
  f.clock.advanceMs(1);
  await f.scan();
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect((await f.pending())[0]).toMatchObject({ status: 'resolved', resolved_at: f.clock.now() });
  expect(await other.pending()).toEqual(beforeOther);
  expect(await splits(db, other.ctx.app_id)).toEqual([]);
  expect(f.port.create.mock.calls[0]?.[1]).toMatchObject({
    paidAt: f.current.paid_at,
    ownerUserId: f.userId,
    appId: f.ctx.app_id,
  });
});

it('[AC-B1-08t#10] 多条到期待处理按订单去重，重复投递和已处置记录不再调用', async () => {
  const f = await setupScan(db);
  await f.addPending({});
  await f.addPending({ reason: 'SERVICE_FEE_RATE_MISSING', status: 'dismissed' });
  await f.addPending({ reason: 'NO_RECEIVED_AT', detail: null });
  await succeed(f, db);
  f.clock.advanceMs(HOUR + 1);
  const before = await f.pending();
  await f.scan();
  expect(f.port.create).toHaveBeenCalledTimes(1);
  const after = await f.pending();
  expect(
    after
      .filter((p) => ['RULE_VERSION_PLATFORM_MISSING', 'AMOUNT_PARSE_FAILED'].includes(p.reason))
      .map((p) => p.status),
  ).toEqual(['resolved', 'resolved']);
  for (const row of before.filter(
    (p) => !['RULE_VERSION_PLATFORM_MISSING', 'AMOUNT_PARSE_FAILED'].includes(p.reason),
  )) {
    expect(after.find((p) => p.id === row.id)).toEqual(row);
  }
  await f.scan();
  expect(f.port.create).toHaveBeenCalledTimes(1);
});

it.each(['unattributed', 'DEPOSIT_PAID', 'INVALID', 'VOID', 'CLAWED_BACK'] as const)(
  '[AC-B1-08t#11] 定时扫描锁内重读资格，%s 不调用快照端口也不处置',
  async (state) => {
    const f = await setupScan(db);
    await db
      .updateTable('orders')
      .set(
        state === 'unattributed'
          ? { user_id: null }
          : state === 'VOID' || state === 'CLAWED_BACK'
            ? { rebate_status: state }
            : { platform_status: state },
      )
      .where('app_id', '=', f.ctx.app_id)
      .execute();
    f.clock.advanceMs(HOUR + 1);
    const before = await f.pending();
    await f.scan();
    expect(f.port.create).not.toHaveBeenCalled();
    expect(await f.pending()).toEqual(before);
  },
);

it('[AC-B1-08t#12] 刷新 detected_at 不延后未处置时长；超过24小时仍 pending 才告警转人工', async () => {
  const f = await setupScan(db);
  const first = (await f.pending())[0]!;
  f.clock.advanceMs(23 * HOUR);
  await f.scan();
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect(f.alerts()).toEqual([]);
  expect((await f.pending())[0]).toMatchObject({
    status: 'open',
    created_at: first.created_at,
    detected_at: f.clock.now(),
  });
  f.clock.advanceMs(HOUR + 1);
  await f.scan();
  expect(f.port.create).toHaveBeenCalledTimes(2);
  const alerts = f.alerts();
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ app_id: f.ctx.app_id, order_id: f.current.order_id });
  expect((await f.pending())[0]).toMatchObject({
    id: first.id,
    status: 'open',
    resolved_at: null,
    created_at: first.created_at,
  });
  const payload = JSON.stringify(alerts[0]);
  expect(payload).not.toContain(f.incoming.sub_order_id);
  expect(payload).not.toContain(f.userId);
  // 不限定内部标记：再次到期扫描和合法流水线更新均不得自动重试。
  f.clock.advanceMs(2 * HOUR);
  await f.scan();
  await f.process({ ...f.incoming, modified_at: f.clock.now(), est_commission_fen: 790n });
  expect(f.port.create).toHaveBeenCalledTimes(2);
  expect(f.alerts()).toHaveLength(1);
});

it('[AC-B1-08t#13] 超过24小时本次成功则处置成功，不发失败告警', async () => {
  const f = await setupScan(db);
  await succeed(f, db);
  f.clock.advanceMs(24 * HOUR + 1);
  await f.scan();
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect((await f.pending())[0]).toMatchObject({ status: 'resolved', resolved_at: f.clock.now() });
  expect(f.alerts()).toEqual([]);
});

it('[AC-B1-08t#14] 告警只包含平铺定位字段，不输出买家身份或完整子订单号', async () => {
  const f = await setupScan(db);
  f.clock.advanceMs(24 * HOUR + 1);
  await f.scan();
  expect(f.alerts()).toHaveLength(1);
  for (const fields of f.alerts()) {
    expect(
      Object.values(fields).every((value) => value === null || typeof value !== 'object'),
    ).toBe(true);
    expect(JSON.stringify(fields)).not.toContain(f.userId);
    expect(JSON.stringify(fields)).not.toContain(f.incoming.sub_order_id);
    expect(fields).not.toHaveProperty('custom_parameters');
  }
});

it('[AC-B1-08t#15] 端口写快照后抛错不提交半成品，失败后释放锁并可恢复', async () => {
  const f = await setupScan(db);
  const port = await succeed(f, db);
  const failure = new Error('synthetic snapshot failure after insert');
  f.port.create.mockImplementationOnce(async (trx, input) => {
    await port.create(trx, input);
    throw failure;
  });
  f.clock.advanceMs(HOUR + 1);
  const before = await f.pending();
  await capture(() => f.scan());
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect(await splits(db, f.ctx.app_id)).toEqual([]);
  expect(await f.pending()).toEqual(before);
  await f.scan();
  expect(await splits(db, f.ctx.app_id)).toHaveLength(1);
  expect((await f.pending())[0]?.status).toBe('resolved');
});

it('[AC-B1-08t#17] 金额资料仍不完整时保留 pending，不能以0元生成；超时仍须转人工', async () => {
  const f = await setupScan(db, { est_commission_fen: null });
  f.clock.advanceMs(HOUR + 1);
  await f.scan();
  expect(f.port.create).not.toHaveBeenCalled();
  expect((await f.pending())[0]).toMatchObject({ reason: 'AMOUNT_PARSE_FAILED', status: 'open' });
  f.clock.advanceMs(24 * HOUR);
  await f.scan();
  expect(f.port.create).not.toHaveBeenCalled();
  expect(f.alerts()).toHaveLength(1);
});

it('[AC-B1-08t#18] 扫描按 open 原因识别重试对象，不按 detail 或 order_id 排除', async () => {
  const f = await setupScan(db);
  await db
    .updateTable('order_sync_pending')
    .set({ reason: 'AMOUNT_PARSE_FAILED', detail: 'union normalization failed', order_id: null })
    .where('app_id', '=', f.ctx.app_id)
    .execute();
  f.clock.advanceMs(HOUR + 1);
  const before = await f.pending();
  await succeed(f, db);
  await f.scan();
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect(await f.pending()).toEqual([
    expect.objectContaining({
      id: before[0]!.id,
      order_id: null,
      detail: 'union normalization failed',
      status: 'resolved',
      resolved_at: f.clock.now(),
    }),
  ]);
  expect(await splits(db, f.ctx.app_id)).toHaveLength(1);
});

it('[AC-B1-08t#19] 超时后端口抛错也转人工，不能无限重试或提交端口写到一半的快照', async () => {
  const f = await setupScan(db);
  const port = await succeed(f, db);
  f.port.create.mockImplementation(async (trx, input) => {
    await port.create(trx, input);
    throw new Error('synthetic persistent snapshot exception');
  });
  f.clock.advanceMs(24 * HOUR + 1);
  await capture(() => f.scan());
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect(await splits(db, f.ctx.app_id)).toEqual([]);
  expect((await f.pending())[0]).toMatchObject({
    status: 'open',
    resolved_at: null,
  });
  expect(f.alerts()).toHaveLength(1);
  f.clock.advanceMs(2 * HOUR);
  await f.scan();
  await f.process({ ...f.incoming, modified_at: f.clock.now(), est_commission_fen: 790n });
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect(f.alerts()).toHaveLength(1);
});

it('[AC-B1-08t#25] 拼多多扫描缺持久化服务费：est 有值照常调端口，N 是 est；est 为空待处理 SERVICE_FEE_RATE_MISSING，不调用端口、不处置', async () => {
  const f = await setup(db);
  // B1-08v adds app.orders.service_fee_fen and stores the reported fee on import; this case needs
  // the order without a persisted fee, so clear it when the column exists (B1-08x test-change,
  // ruling D10-88 kind: fixture preparation only, assertions unchanged).
  const feeColumn = await sql<{ n: number }>`
    select count(*)::int as n from information_schema.columns
    where table_schema = 'app' and table_name = 'orders' and column_name = 'service_fee_fen'`.execute(
    db,
  );
  if (feeColumn.rows[0]?.n === 1) {
    await sql`update app.orders set service_fee_fen = null where app_id = ${f.ctx.app_id}`.execute(
      db,
    );
  }
  f.clock.advanceMs(HOUR + 1);
  const orderBefore = (await f.read()).orders;
  f.logger.warn.mockClear();
  await f.scan();
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect(f.port.create.mock.calls[0]?.[1]).toMatchObject({
    nBaseFen: 789n,
    paidAt: f.current.paid_at,
    paidAtSource: 'platform',
  });
  expect((await f.read()).orders).toEqual(orderBefore);
  expect(f.logger.warn.mock.calls.map(([fields]) => fields)).not.toContainEqual(
    expect.objectContaining({ event: 'snapshot_retry_skipped' }),
  );
  expect(f.alerts()).toEqual([]);

  const missing = await setup(db, { est_commission_fen: null, service_fee_fen: null });
  const row = (await missing.pending())[0]!;
  expect(row).toMatchObject({ reason: 'SERVICE_FEE_RATE_MISSING', status: 'open' });
  const unpriced = (await missing.read()).orders;
  missing.clock.advanceMs(HOUR + 1);
  await missing.scan();
  expect(missing.port.create).not.toHaveBeenCalled();
  expect((await missing.read()).orders).toEqual(unpriced);
  expect(await missing.pending()).toEqual([
    expect.objectContaining({
      id: row.id,
      reason: 'SERVICE_FEE_RATE_MISSING',
      status: 'open',
      resolved_at: null,
      created_at: row.created_at,
      detected_at: missing.clock.now(),
    }),
  ]);
  expect(missing.alerts()).toEqual([]);
});
