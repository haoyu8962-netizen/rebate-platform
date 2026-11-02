import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOrderPipeline } from '../../../../apps/api/src/modules/orders/index.ts';
import { setup, succeed, splits, HOUR } from '../snapshot-retry/kit.ts';
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

async function cohort(skip: 'none' | 'missing_fee' | 'platform_modified' | 'taobao') {
  const f = await setup(
    db,
    skip === 'taobao'
      ? {
          platform: 'taobao',
          service_fee_fen: null,
          attr_params: {
            relation_id: 'synthetic-relation',
            sub_union_id: null,
            custom_parameters: null,
          },
        }
      : {},
  );
  if (skip === 'taobao') {
    // setup 默认无淘宝绑定；首单模拟已归属的历史单，其余单走同一绑定端口入库。
    f.findBindings.mockResolvedValue([
      {
        user_id: f.userId,
        bound_at: f.incoming.paid_at!,
        released_at: null,
        cooldown_until: null,
      },
    ]);
    await db
      .updateTable('orders')
      .set({ user_id: f.userId, paid_at_source: 'platform' })
      .where('app_id', '=', f.ctx.app_id)
      .execute();
    await f.addPending({ reason: 'RULE_VERSION_PLATFORM_MISSING' });
  }
  // 同一 App 下用实际流水线建 100 单，首单由 setup 创建；不注入扫描批量上限。
  for (let i = 1; i < 100; i++) {
    expect(await f.process({ ...f.incoming, sub_order_id: randomUUID() })).toMatchObject({
      kind: 'inserted',
    });
  }
  expect(await readFee(db, f.ctx.app_id)).toHaveLength(100);
  expect(
    (await readFee(db, f.ctx.app_id)).every(
      (row) => row.service_fee_fen === (skip === 'taobao' ? null : 31n),
    ),
  ).toBe(true);
  if (skip === 'missing_fee') await setFee(db, f.ctx.app_id, null);
  if (skip === 'platform_modified') {
    await db
      .updateTable('orders')
      .set({ paid_at_source: 'platform_modified' })
      .where('app_id', '=', f.ctx.app_id)
      .execute();
  }
  const oldTime = f.clock.now();
  await db
    .updateTable('order_sync_pending')
    .set({ status: 'open', detected_at: oldTime, created_at: oldTime })
    .where('app_id', '=', f.ctx.app_id)
    .execute();
  f.clock.advanceMs(1000);
  const accountId = randomUUID();
  await db
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: f.ctx.app_id,
      platform: 'jd',
      account_name: 'synthetic-jd',
      status: 'active',
      auth_status: 'active',
      sync_start_at: f.incoming.paid_at!,
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    })
    .execute();
  const jd = {
    ...f.incoming,
    platform: 'jd' as const,
    sub_order_id: randomUUID(),
    service_fee_fen: null,
    attr_params: { relation_id: null, sub_union_id: 'n_abcd1234', custom_parameters: null },
  };
  const pipeline = createOrderPipeline({ ...f.deps, snapshots: f.port });
  expect(
    await pipeline.process(jd, { ...f.ctx, platform: 'jd', union_account_id: accountId }),
  ).toMatchObject({ kind: 'inserted' });
  await db
    .updateTable('order_sync_pending')
    .set({ status: 'open', detected_at: f.clock.now(), created_at: f.clock.now() })
    .where('app_id', '=', f.ctx.app_id)
    .where('platform', '=', 'jd')
    .execute();
  const before = await f.pending();
  expect(before).toHaveLength(101);
  const jdRow = (await f.read()).orders.find((row) => row.platform === 'jd')!;
  // succeed 的公开夹具按 incoming.platform 补京东规则，仍共用同一 App / 用户。
  const real = await succeed({ ...f, incoming: jd }, db);
  f.port.create.mockImplementation(async (trx, input) =>
    input.platform === 'jd'
      ? real.create(trx, input)
      : { kind: 'pending', reason: 'missing platform rule' },
  );
  f.port.create.mockClear();
  f.clock.advanceMs(HOUR);
  return { f, before, jdRow };
}

it('[AC-B1-08v#14] 100 张有服务费的拼多多 pending 刷新后，下一轮京东获得名额', async () => {
  await requireFeeColumn(db);
  const { f, before, jdRow } = await cohort('none');
  await f.scan();
  expect(f.port.create).toHaveBeenCalledTimes(100);
  expect(f.port.create.mock.calls.every(([, input]) => input.platform === 'pdd')).toBe(true);
  const first = await f.pending();
  for (const row of first.filter((p) => p.platform === 'pdd')) {
    expect(row).toMatchObject({
      status: 'open',
      detected_at: f.clock.now(),
      created_at: before.find((p) => p.id === row.id)!.created_at,
    });
  }
  expect(first.find((p) => p.order_id === jdRow.order_id)).toEqual(
    before.find((p) => p.order_id === jdRow.order_id),
  );
  f.clock.advanceMs(15 * 60_000);
  await f.scan();
  expect(f.port.create).toHaveBeenCalledTimes(101);
  expect(f.port.create.mock.calls[100]?.[1]).toMatchObject({
    orderId: jdRow.order_id,
    platform: 'jd',
    nBaseFen: 789n,
  });
  expect((await f.pending()).find((p) => p.order_id === jdRow.order_id)?.status).toBe('resolved');
  expect(await splits(db, f.ctx.app_id)).toEqual([
    expect.objectContaining({ order_id: jdRow.order_id }),
  ]);
});

it.each(['platform_paid_at_missing', 'platform_modified', 'taobao'] as const)(
  '[AC-B1-08v#15] 100 张必然跳过的 %s 候选排后，首轮就处理京东且跳过单不变；拼多多服务费列为空不再算必然跳过',
  async (skip) => {
    await requireFeeColumn(db);
    // 对照：服务费列为空的拼多多单不跳过，到期扫描照常调端口，N 是 est。
    const unskipped = await setup(db);
    await setFee(db, unskipped.ctx.app_id, null);
    unskipped.clock.advanceMs(HOUR);
    await unskipped.scan();
    expect(unskipped.port.create).toHaveBeenCalledTimes(1);
    expect(unskipped.port.create.mock.calls[0]?.[1]).toMatchObject({
      platform: 'pdd',
      nBaseFen: 789n,
    });

    const { f, before, jdRow } = await cohort(skip === 'platform_paid_at_missing' ? 'none' : skip);
    if (skip === 'platform_paid_at_missing') {
      // paid_at_source 是 platform 而 paid_at 为空：paidAt 不可恢复，扫描必然 skip。
      await db
        .updateTable('orders')
        .set({ paid_at: null })
        .where('app_id', '=', f.ctx.app_id)
        .where('platform', '=', 'pdd')
        .execute();
    }
    const ordersBefore = (await f.read()).orders;
    await f.scan();
    expect(f.port.create).toHaveBeenCalledTimes(1);
    expect(f.port.create.mock.calls[0]?.[1]).toMatchObject({
      orderId: jdRow.order_id,
      platform: 'jd',
    });
    expect((await f.pending()).find((p) => p.order_id === jdRow.order_id)?.status).toBe('resolved');
    expect((await f.pending()).filter((p) => p.platform !== 'jd')).toEqual(
      before.filter((p) => p.platform !== 'jd'),
    );
    expect((await f.read()).orders).toEqual(ordersBefore);
    expect(await splits(db, f.ctx.app_id)).toEqual([
      expect.objectContaining({ order_id: jdRow.order_id }),
    ]);
  },
);
