import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

// Global setup supplies the migrated template; this file clones it and queries as couli_app.
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
import { at, historySteps, RECEIVED, scenario, SETTLED } from './kit.ts';

it.each([
  {
    initial: 'paid',
    raw: 'received',
    rule: 'P3',
    steps: ['RECEIVED'],
    time: RECEIVED,
    moved: false,
  },
  {
    initial: 'received',
    raw: 'settled',
    rule: 'P4',
    steps: ['SETTLED'],
    time: RECEIVED,
    moved: true,
  },
  {
    initial: 'paid',
    raw: 'settled',
    rule: 'P5',
    steps: ['RECEIVED', 'SETTLED'],
    time: SETTLED,
    moved: true,
  },
  {
    initial: 'deposit',
    raw: 'settled',
    rule: 'P5',
    steps: ['PAID', 'RECEIVED', 'SETTLED'],
    time: SETTLED,
    moved: true,
  },
  {
    initial: 'deposit',
    raw: 'received',
    rule: 'P14',
    steps: ['PAID', 'RECEIVED'],
    time: RECEIVED,
    moved: false,
  },
] as const)(
  '[AC-B1-08i#20] $rule 从 $initial 更新，CAS 一次且 history 按步骤只插入',
  async ({ initial, raw, rule, steps, time, moved }) => {
    const f = await scenario(db, {
      raw_status: initial,
      ...(initial === 'received' ? { received_at: at(RECEIVED) } : {}),
      ...(initial === 'deposit'
        ? { deposit_paid_at: at('2026-10-14T01:02:03Z'), paid_at: null }
        : {}),
    });
    const incoming = f.next({
      raw_status: raw,
      received_at: raw === 'received' ? at(RECEIVED) : null,
      settled_at: raw === 'settled' ? at(SETTLED) : null,
      settle_commission_fen: raw === 'settled' ? 500n : null,
    });
    expect(await f.pipeline.process(incoming, f.ctx)).toEqual({
      kind: 'updated',
      order_id: f.original.order_id,
    });
    const after = await f.read();
    const row = after.orders[0];
    expect(row).toMatchObject({
      platform_status: steps.at(-1),
      received_at: at(time),
      settled_at: raw === 'settled' ? at(SETTLED) : null,
      // BR-CALC-15：结算额 500 与预估 789 不同，有效 N 变了才推版本。
      commission_version: f.original.commission_version + (moved ? 1 : 0),
      row_version: f.original.row_version + 1,
      updated_at: f.clock.now(),
      attr_at: f.original.attr_at,
      rebate_status: f.original.rebate_status,
      hold: f.original.hold,
      locked: f.original.locked,
    });
    expect(after.history.slice(0, f.before.history.length)).toEqual(f.before.history);
    const added = after.history.slice(f.before.history.length);
    expect(historySteps(added)).toEqual(
      steps.map((to, i) => ({
        from_status: i === 0 ? f.original.platform_status : steps[i - 1],
        event: `PLATFORM_${to}`,
        to_status: to,
      })),
    );
    for (const h of added)
      expect(h).toMatchObject({
        app_id: f.ctx.app_id,
        order_id: f.original.order_id,
        field: 'platform',
        source: 'sync',
        at: f.clock.now(),
      });
    expect(f.onUpdated).toHaveBeenCalledTimes(1);
    expect(f.onUpdated.mock.calls[0]?.[1]).toEqual({
      app_id: f.ctx.app_id,
      order_id: f.original.order_id,
      attr_at: f.original.attr_at,
      from_status: f.original.platform_status,
      to_status: steps.at(-1),
      rule,
      received_at: at(time),
      est_before: 789n,
      est_after: 789n,
      settle_commission_fen: raw === 'settled' ? 500n : null,
      attributed_now: false,
      commission_moved: moved,
    });
    expect(f.publishedOf('order.updated')).toHaveLength(1);
    expect(f.publishedOf('order.updated')[0]?.[1]).toEqual({
      appId: f.ctx.app_id,
      name: 'order.updated',
      payload: {
        order_id: f.original.order_id,
        platform: 'pdd',
        from_status: f.original.platform_status,
        to_status: steps.at(-1),
        rule,
        attributed_now: false,
      },
    });
    const updates = f.queries.filter((q) => /^update "app"."orders" /i.test(q.sql));
    expect(updates).toHaveLength(1);
    const where = updates[0]?.sql.split(' where ')[1] ?? '';
    for (const column of ['order_id', 'attr_at', 'app_id', 'row_version', 'platform_status']) {
      expect(where).toContain(`"${column}"`);
    }
    expect(f.queries.some((q) => /^(update|delete).*"order_status_history"/i.test(q.sql))).toBe(
      false,
    );
  },
);

it.each([
  ['paid', 'received', []],
  ['deposit', 'received', ['PAID']],
  ['paid', 'settled', []],
  ['deposit', 'settled', ['PAID']],
] as const)(
  '[AC-B1-08i#21] %s + %s 缺时间只到 PAID 并提交 NO_RECEIVED_AT',
  async (initial, raw, steps) => {
    const f = await scenario(db, {
      raw_status: initial,
      ...(initial === 'deposit'
        ? { deposit_paid_at: at('2026-10-14T02:03:04Z'), paid_at: null }
        : {}),
    });
    expect(await f.pipeline.process(f.next({ raw_status: raw }), f.ctx)).toMatchObject({
      kind: 'updated',
    });
    const after = await f.read();
    expect(after.orders[0]).toMatchObject({ platform_status: 'PAID', received_at: null });
    expect(after.history.slice(f.before.history.length).map((h) => h.to_status)).toEqual(steps);
    expect(after.pending).toEqual([
      expect.objectContaining({
        order_id: f.original.order_id,
        reason: 'NO_RECEIVED_AT',
        raw_status: raw,
        detected_at: f.clock.now(),
      }),
    ]);
    expect(f.onUpdated.mock.calls[0]?.[1]).toMatchObject({ to_status: 'PAID', received_at: null });
  },
);

it('[AC-B1-08i#22] P9 从 INVALID 恢复只改平台状态，并告警', async () => {
  const f = await scenario(db, { raw_status: 'invalid' });
  await f.pipeline.process(f.next({ raw_status: 'paid' }), f.ctx);
  const after = await f.read();
  expect(after.orders[0]).toMatchObject({
    platform_status: 'PAID',
    rebate_status: f.original.rebate_status,
  });
  expect(historySteps(after.history.slice(f.before.history.length))).toEqual([
    { from_status: 'INVALID', event: 'PLATFORM_PAID', to_status: 'PAID' },
  ]);
  expect(f.logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({
      alert: expect.any(String),
      rule: 'P9',
      app_id: f.ctx.app_id,
      platform: 'pdd',
    }),
    expect.any(String),
  );
});

it.each([
  ['paid', 'paid', 'P15'],
  ['paid', 'rights', 'P8'],
  ['received', 'punish', 'P8'],
  ['settled', 'invalid', 'P7'],
] as const)(
  '[AC-B1-08i#23] %s + %s noop 仍写佣金、调用 settlement、发事件',
  async (initial, raw, rule) => {
    const f = await scenario(db, {
      raw_status: initial,
      received_at: at(RECEIVED),
      ...(initial === 'settled' ? { settled_at: at(SETTLED) } : {}),
    });
    await f.pipeline.process(f.next({ raw_status: raw, est_commission_fen: 990n }), f.ctx);
    const after = await f.read();
    expect(after.orders[0]).toMatchObject({
      platform_status: f.original.platform_status,
      est_commission_fen: 990n,
      commission_version: f.original.commission_version + 1,
      row_version: f.original.row_version + 1,
    });
    expect(after.history).toEqual(f.before.history);
    expect(after.pending).toEqual([]);
    expect(f.onUpdated).toHaveBeenCalledTimes(1);
    expect(f.onUpdated.mock.calls[0]?.[1]).toMatchObject({
      rule,
      est_before: 789n,
      est_after: 990n,
    });
    expect(f.publishedOf('order.updated')).toHaveLength(1);
    expect(f.publishedOf('order.updated')[0]?.[1]).toMatchObject({
      name: 'order.updated',
      payload: { rule },
    });
    expect(f.logger.error).not.toHaveBeenCalled();
    expect(f.logger.warn).not.toHaveBeenCalled();
  },
);
