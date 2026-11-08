// B1-09zd (FU-SUFFIX-VOID-WIRING-R2) · 尾号作废开关的生产接线补测（08 BR-ATTR-26 ①；默认 false）。
// 开关只经 config_items 进来（../suffix-void-wiring/kit.ts 的生产 worker 装配，只读复用）：
// ① 非布尔取值（字符串 "true" / "false"、数字 1 / 0、对象 {}）一律不算开：尾号命中只记待复核；
// ② 同一个 worker 运行中改 config_items，每单按当时的值判定（不缓存第一次读到的值）。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  SUFFIX,
  SWITCH,
  TIMEOUT,
  withWorld,
  type TaobaoApp,
  type World,
} from '../suffix-void-wiring/kit.ts';

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

/** 一个子订单号对应的订单行（按 sub_order_id 取，同一 App 可有多单）。 */
async function orderOf(app: TaobaoApp, subOrderId: string) {
  return db
    .selectFrom('orders')
    .selectAll()
    .where('app_id', '=', app.appId)
    .where('sub_order_id', '=', subOrderId)
    .executeTakeFirstOrThrow();
}

async function hitsOf(app: TaobaoApp, orderId: string) {
  return db
    .selectFrom('risk_hits')
    .selectAll()
    .where('app_id', '=', app.appId)
    .where('ref_id', '=', orderId)
    .execute();
}

async function splitsOf(app: TaobaoApp, orderId: string) {
  return db
    .selectFrom('commission_splits')
    .selectAll()
    .where('app_id', '=', app.appId)
    .where('order_id', '=', orderId)
    .execute();
}

/** 该单的 order.invalidated 事件条数（event_log 的 payload 是 { v, data }，data.order_id 指向订单）。 */
async function invalidatedOf(app: TaobaoApp, orderId: string): Promise<number> {
  const rows = await db
    .selectFrom('event_log')
    .select(['name', 'payload'])
    .where('app_id', '=', app.appId)
    .where('name', '=', 'order.invalidated')
    .execute();
  return rows.filter((event) => {
    const payload = event.payload as { data?: { order_id?: unknown } } | null;
    return payload?.data?.order_id === orderId;
  }).length;
}

function suffixHit(app: TaobaoApp, orderId: string, riskAction: string) {
  return expect.objectContaining({
    user_id: app.userId,
    rule_id: 'BLACKLIST_HIT',
    risk_action: riskAction,
    dimension: 'order_no_suffix',
    ref_type: 'order',
    ref_id: orderId,
  });
}

/** 同步一单尾号命中的淘宝订单，返回它的子订单号。 */
async function syncOne(w: World, app: TaobaoApp): Promise<string> {
  const subOrderId = randomUUID();
  await w.sync(app, { order_id: randomUUID(), sub_order_id: subOrderId });
  return subOrderId;
}

/** 不作废：ESTIMATED、有快照、无 order.invalidated，尾号只记 manual_review。 */
async function expectKept(app: TaobaoApp, subOrderId: string) {
  const row = await orderOf(app, subOrderId);
  expect(row).toMatchObject({
    user_id: app.userId,
    rebate_status: 'ESTIMATED',
    reason: null,
    commission_version: 1,
  });
  expect(row.parent_order_id?.slice(-6)).toBe(SUFFIX);
  expect(await splitsOf(app, row.order_id)).toHaveLength(1);
  expect(await invalidatedOf(app, row.order_id)).toBe(0);
  expect(await hitsOf(app, row.order_id)).toEqual([suffixHit(app, row.order_id, 'manual_review')]);
}

/** 作废：VOID / BLACKLIST、无快照、发 order.invalidated，尾号记 void_commission。 */
async function expectVoided(app: TaobaoApp, subOrderId: string) {
  const row = await orderOf(app, subOrderId);
  expect(row).toMatchObject({
    user_id: app.userId,
    rebate_status: 'VOID',
    reason: 'BLACKLIST',
    commission_version: 0,
  });
  expect(await splitsOf(app, row.order_id)).toEqual([]);
  expect(await invalidatedOf(app, row.order_id)).toBe(1);
  expect(await hitsOf(app, row.order_id)).toEqual([
    suffixHit(app, row.order_id, 'void_commission'),
  ]);
}

/** 运行中改开关：content 存的是 config_items 的同一行，改值并升版本。 */
async function changeSwitch(app: TaobaoApp, value: unknown, version: number) {
  const result = await db
    .updateTable('config_items')
    .set({ value: JSON.stringify(value), version, updated_by: 'fixture' })
    .where('app_id', '=', app.appId)
    .where('key', '=', SWITCH)
    .executeTakeFirst();
  expect(result.numUpdatedRows).toBe(1n);
}

const NON_BOOLEAN: ReadonlyArray<readonly [number, string, unknown]> = [
  [1, '字符串 "true"', 'true'],
  [2, '字符串 "false"', 'false'],
  [3, '数字 1', 1],
  [4, '数字 0', 0],
  [5, '对象 {}', {}],
];

for (const [n, label, value] of NON_BOOLEAN) {
  it(
    `[AC-B1-09zd#${n}] 开关 config_items 为非布尔（${label}）：不算开，尾号命中只记 manual_review、订单照常 ESTIMATED、不作废`,
    async () => {
      await withWorld(db, async (w) => {
        const app = await w.seed();
        await w.setSwitch(app, value);
        await w.blockSuffix(app);
        const subOrderId = await syncOne(w, app);
        await expectKept(app, subOrderId);
      });
    },
    TIMEOUT,
  );
}

// 时钟依赖：kit 的 sync 每单把注入时钟推进 60 秒，恰好等于 content 配置读取的缓存有效期
// （CONTENT_CACHE_TTL_MS，到点即过期）。所以本用例钉的是「不永久缓存、超过配置缓存期后的下一单
// 按新值判定」，不是「改完立刻生效」。推进量必须 ≥ 该缓存有效期：若 kit 的推进量变小或缓存期变长，
// 本用例会意外变红（读到旧值），反之若缓存被去掉也照绿、约束随之失效。
it(
  '[AC-B1-09zd#6] 同一 worker 运行中改开关：false 时一单不作废 → 改 true 后超过配置缓存期的下一单作废 → 改回 false 后超过配置缓存期的第三单不作废（不永久缓存首次读到的值）',
  async () => {
    await withWorld(db, async (w) => {
      const app = await w.seed();
      await w.setSwitch(app, false);
      await w.blockSuffix(app);

      const first = await syncOne(w, app);
      await expectKept(app, first);

      await changeSwitch(app, true, 2);
      const second = await syncOne(w, app);
      await expectVoided(app, second);

      await changeSwitch(app, false, 3);
      const third = await syncOne(w, app);
      await expectKept(app, third);

      // 前面的单不因后来的开关值被改写。
      await expectKept(app, first);
      await expectVoided(app, second);
    });
  },
  TIMEOUT,
);
