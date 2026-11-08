// B1-09z (FU-SUFFIX-VOID-WIRING) · 尾号作废开关的生产接线（08 BR-ATTR-26 ①；默认 false）。开关只经
// config_items 进来：AppModule 的 worker 装配读 content 配置 attr.blacklist.order_suffix_void_enabled，
// 交给流水线第 ③ 步。淘宝订单走生产流水线；作废的可观察结果与 ../rebate-wiring/blacklist.int.test.ts
// 一致：VOID / BLACKLIST、不生成快照、risk_hits 记 void_commission、发 order.invalidated。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { SUFFIX, TIMEOUT, withWorld, type TaobaoApp, type World } from './kit.ts';

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

/** 父单号末 6 位不是 SUFFIX：尾号维度不命中。 */
const PARENT_MISS = '3301987654012345';

function hit(app: TaobaoApp, orderId: string, dimension: string, riskAction: string) {
  return expect.objectContaining({
    user_id: app.userId,
    rule_id: 'BLACKLIST_HIT',
    risk_action: riskAction,
    dimension,
    ref_type: 'order',
    ref_id: orderId,
  });
}

/** 作废：VOID / BLACKLIST，不生成快照，发 order.invalidated；user_id 不变。 */
async function expectVoided(w: World, app: TaobaoApp) {
  const row = await w.row(app);
  expect(row).toMatchObject({
    user_id: app.userId,
    rebate_status: 'VOID',
    reason: 'BLACKLIST',
    commission_version: 0,
  });
  expect(await w.splits(app)).toEqual([]);
  expect(await w.eventNames(app)).toContain('order.invalidated');
  return row;
}

/** 不作废：照常 ESTIMATED，有快照，不发 order.invalidated。 */
async function expectKept(w: World, app: TaobaoApp) {
  const row = await w.row(app);
  expect(row).toMatchObject({
    user_id: app.userId,
    rebate_status: 'ESTIMATED',
    reason: null,
    commission_version: 1,
  });
  expect(await w.splits(app)).toHaveLength(1);
  expect(await w.eventNames(app)).not.toContain('order.invalidated');
  return row;
}

it(
  '[AC-B1-09z#1] 开关 config_items=true：淘宝父单号尾号命中 → 作废（VOID / BLACKLIST），risk_hits 记 order_no_suffix 的 void_commission',
  async () => {
    await withWorld(db, async (w) => {
      const app = await w.seed();
      await w.setSwitch(app, true);
      await w.blockSuffix(app);
      await w.sync(app);
      const row = await expectVoided(w, app);
      expect(await w.hits(app)).toEqual([
        hit(app, row.order_id, 'order_no_suffix', 'void_commission'),
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-09z#2] 开关 config_items=false：尾号命中只记待复核（manual_review），订单照常 ESTIMATED、不作废',
  async () => {
    await withWorld(db, async (w) => {
      const app = await w.seed();
      await w.setSwitch(app, false);
      await w.blockSuffix(app);
      await w.sync(app);
      const row = await expectKept(w, app);
      expect(await w.hits(app)).toEqual([
        hit(app, row.order_id, 'order_no_suffix', 'manual_review'),
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-09z#3] 开关未配置（无 config_items 行，08 默认 false）：同 false，尾号命中只记 manual_review、不作废',
  async () => {
    await withWorld(db, async (w) => {
      const app = await w.seed();
      await w.blockSuffix(app);
      await w.sync(app);
      const row = await expectKept(w, app);
      expect(await w.hits(app)).toEqual([
        hit(app, row.order_id, 'order_no_suffix', 'manual_review'),
      ]);
      expect(SUFFIX).toBe(row.parent_order_id?.slice(-6));
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-09z#4] 渠道维度命中不受开关影响：开关 false 时渠道命中照样作废（尾号不命中）',
  async () => {
    await withWorld(db, async (w) => {
      const app = await w.seed();
      await w.setSwitch(app, false);
      await w.blockSuffix(app);
      await w.blockChannel(app);
      await w.sync(app, { parent_order_id: PARENT_MISS });
      const row = await expectVoided(w, app);
      expect(await w.hits(app)).toEqual([hit(app, row.order_id, 'channel', 'void_commission')]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-09z#5] 渠道维度命中不受开关影响：开关 true 时渠道命中同样作废（尾号不命中）',
  async () => {
    await withWorld(db, async (w) => {
      const app = await w.seed();
      await w.setSwitch(app, true);
      await w.blockSuffix(app);
      await w.blockChannel(app);
      await w.sync(app, { parent_order_id: PARENT_MISS });
      const row = await expectVoided(w, app);
      expect(await w.hits(app)).toEqual([hit(app, row.order_id, 'channel', 'void_commission')]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-09z#6] 渠道维度命中不受开关影响：未配置开关、尾号与渠道同时命中 → 作废；渠道记 void_commission，尾号只记 manual_review',
  async () => {
    await withWorld(db, async (w) => {
      const app = await w.seed();
      await w.blockSuffix(app);
      await w.blockChannel(app);
      await w.sync(app);
      const row = await expectVoided(w, app);
      expect(await w.hits(app)).toEqual([
        hit(app, row.order_id, 'order_no_suffix', 'manual_review'),
        hit(app, row.order_id, 'channel', 'void_commission'),
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-09z#7] 开关按订单所属 App 读：同一 worker 里 A 开（true）、B 未配置、C 关（false），各自尾号命中只有 A 作废',
  async () => {
    await withWorld(db, async (w) => {
      const a = await w.seed();
      const b = await w.seed();
      const c = await w.seed();
      await w.setSwitch(a, true);
      await w.setSwitch(c, false);
      for (const app of [a, b, c]) await w.blockSuffix(app);
      // B、C 先同步：A 的 true 已在库里，B / C 也不能借用。
      await w.sync(b);
      await w.sync(c);
      await w.sync(a);
      const rowA = await expectVoided(w, a);
      expect(await w.hits(a)).toEqual([
        hit(a, rowA.order_id, 'order_no_suffix', 'void_commission'),
      ]);
      const rowB = await expectKept(w, b);
      expect(await w.hits(b)).toEqual([hit(b, rowB.order_id, 'order_no_suffix', 'manual_review')]);
      const rowC = await expectKept(w, c);
      expect(await w.hits(c)).toEqual([hit(c, rowC.order_id, 'order_no_suffix', 'manual_review')]);
    });
  },
  TIMEOUT,
);
