// BR-CALC-22 细则（2026-11-11，D10-1258）：试算后样本单的份额改回某个旧值（v1 555 → v2 444，试算；
// v3 改回 555）仍是样本变化，发布拒绝 TRIAL_SAMPLE_CHANGED；摘要只比各单最新版本的份额，
// 不能把所有历史版本份额去重后再比。重跑试算后再有仅补贴变化的版本，不妨碍发布。
// 夹具只读复用 ../publish/fixtures.ts；订单行与四段合计由本文件补写，不借助待测服务生成。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { RulePublicationErrorCode } from '../../../../apps/api/src/modules/commission/application/rule-publication.ts';
import { NOW, seedSample, service, setup, stored } from '../publish/fixtures.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 60_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 60_000);

type Fixture = Awaited<ReturnType<typeof setup>>;

const SAMPLE_CHANGED: RulePublicationErrorCode = 'TRIAL_SAMPLE_CHANGED';

async function trial(f: Fixture) {
  return db.transaction().execute((tx) => service.runTrial(tx, f.context, f.deps));
}

/** 发布结果先取成值（拒绝时取到错误对象），再由调用方断言。 */
async function publishOutcome(f: Fixture, trialId: string): Promise<unknown> {
  return db
    .transaction()
    .execute((tx) => service.publish(tx, { ...f.context, trialId }, f.deps))
    .then(
      (published) => published,
      (error: unknown) => error,
    );
}

async function snapshotOf(f: Fixture, orderId: string) {
  return db
    .withSchema('app')
    .selectFrom('commission_splits')
    .selectAll()
    .where('app_id', '=', f.input.appId)
    .where('order_id', '=', orderId)
    .executeTakeFirstOrThrow();
}

/** 订单行（commission_version=1）与 v1 四段合计：按快照与 v1 份额行算，补贴取快照值。 */
async function seedOrderRow(f: Fixture, orderId: string): Promise<void> {
  const app = db.withSchema('app');
  const key = await app
    .selectFrom('order_keys')
    .selectAll()
    .where('app_id', '=', f.input.appId)
    .where('order_id', '=', orderId)
    .executeTakeFirstOrThrow();
  const split = await snapshotOf(f, orderId);
  const shares = await app
    .selectFrom('commission_split_amounts')
    .selectAll()
    .where('app_id', '=', f.input.appId)
    .where('order_id', '=', orderId)
    .where('commission_version', '=', 1)
    .execute();
  const shareTotal = shares.reduce((sum, r) => sum + r.amount_fen, 0n);
  const nTotal = split.raw_n_fen + split.subsidy_commission_fen;
  await app
    .insertInto('orders')
    .values({
      app_id: f.input.appId,
      order_id: orderId,
      platform: key.platform,
      sub_order_id: key.sub_order_id,
      attr_at: key.attr_at,
      raw_item_id: 'synthetic',
      buy_type: split.order_type,
      platform_status: 'PAID',
      rebate_status: 'ESTIMATED',
      paid_at: split.paid_at,
      paid_at_source: split.paid_at_source,
      est_commission_fen: split.raw_n_fen,
      subsidy_commission_fen: split.subsidy_commission_fen,
      commission_version: 1,
      n_total_fen: nTotal,
      pre_base_deduct_fen: nTotal - split.base_fen,
      base_fen: split.base_fen,
      platform_est_profit_fen: nTotal - shareTotal,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
  await app
    .insertInto('commission_split_totals')
    .values({
      app_id: f.input.appId,
      order_id: orderId,
      commission_version: 1,
      n_total_fen: nTotal,
      pre_base_deduct_fen: nTotal - split.base_fen,
      base_fen: split.base_fen,
      user_share_total_fen: shareTotal,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: nTotal - shareTotal,
      created_at: NOW,
    })
    .execute();
}

/**
 * 给订单追加下一个金额版本：份额行照抄上一版；给了 ownFen 时归属用户那一行改成 ownFen（份额变化），
 * 否则就是 BR-CALC-27 细则「仅补贴变化的版本」。四段合计按新补贴重算，orders.commission_version +1。
 */
async function appendVersion(
  f: Fixture,
  orderId: string,
  change: { readonly subsidyFen: bigint; readonly ownFen?: bigint },
): Promise<number> {
  const app = db.withSchema('app');
  const order = await app
    .selectFrom('orders')
    .select('commission_version')
    .where('app_id', '=', f.input.appId)
    .where('order_id', '=', orderId)
    .executeTakeFirstOrThrow();
  const previous = order.commission_version;
  const next = previous + 1;
  const split = await snapshotOf(f, orderId);
  const last = await app
    .selectFrom('commission_split_totals')
    .selectAll()
    .where('app_id', '=', f.input.appId)
    .where('order_id', '=', orderId)
    .where('commission_version', '=', previous)
    .executeTakeFirstOrThrow();
  const rows = (
    await app
      .selectFrom('commission_split_amounts')
      .selectAll()
      .where('app_id', '=', f.input.appId)
      .where('order_id', '=', orderId)
      .where('commission_version', '=', previous)
      .execute()
  ).map((r) => ({
    ...r,
    commission_version: next,
    amount_fen:
      change.ownFen !== undefined && (r.role === 'self' || r.role === 'share')
        ? change.ownFen
        : r.amount_fen,
    created_at: NOW,
  }));
  const shareTotal = rows.reduce((sum, r) => sum + r.amount_fen, 0n);
  const nTotal = split.raw_n_fen + change.subsidyFen;
  await app.insertInto('commission_split_amounts').values(rows).execute();
  await app
    .insertInto('commission_split_totals')
    .values({
      app_id: f.input.appId,
      order_id: orderId,
      commission_version: next,
      n_total_fen: nTotal,
      pre_base_deduct_fen: nTotal - last.base_fen,
      base_fen: last.base_fen,
      user_share_total_fen: shareTotal,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: nTotal - shareTotal,
      created_at: NOW,
    })
    .execute();
  const updated = await app
    .updateTable('orders')
    .set({
      commission_version: next,
      subsidy_commission_fen: change.subsidyFen,
      n_total_fen: nTotal,
      pre_base_deduct_fen: nTotal - last.base_fen,
      platform_est_profit_fen: nTotal - shareTotal,
      updated_at: NOW,
    })
    .where('app_id', '=', f.input.appId)
    .where('order_id', '=', orderId)
    .where('commission_version', '=', previous)
    .executeTakeFirstOrThrow();
  expect(updated.numUpdatedRows).toBe(1n);
  return next;
}

/** 某单某版本的份额行（去掉版本号与写入时间）。 */
async function sharesAt(f: Fixture, orderId: string, version: number) {
  return (await stored(db, f.input.appId)).amounts
    .filter((r) => r.order_id === orderId && r.commission_version === version)
    .map((r) => ({
      user_id: r.user_id,
      role: r.role,
      base_fen: r.base_fen,
      amount_fen: r.amount_fen,
    }));
}

it('[AC-B1-18h#7] BR-CALC-22 试算后份额改回旧值（v2 444 → v3 555）仍须重跑试算；重跑后仅补贴变化的版本不妨碍发布', async () => {
  const f = await setup(db);
  const orderId = await seedSample(db, f.input, f.baseId);
  await seedOrderRow(f, orderId);
  const v1 = await sharesAt(f, orderId, 1);
  expect(v1).toHaveLength(3);
  expect(v1.find((r) => r.role === 'self')?.amount_fen).toBe(555n);

  // v2：本人份额 555 → 444（份额变化）；在 v2 之后试算。
  expect(await appendVersion(f, orderId, { subsidyFen: 0n, ownFen: 444n })).toBe(2);
  const first = await trial(f);
  expect(first.sampleCount).toBe(1);

  // v3：本人份额恢复为 555，份额行与 v1 逐项相同，但与试算时的最新版本 v2 不同。
  expect(await appendVersion(f, orderId, { subsidyFen: 0n, ownFen: 555n })).toBe(3);
  expect(await sharesAt(f, orderId, 3)).toEqual(v1);
  expect(await sharesAt(f, orderId, 3)).not.toEqual(await sharesAt(f, orderId, 2));

  // 样本已变：用原试算发布被拒，不写库、不写审计。
  const before = await stored(db, f.input.appId);
  const audits = f.append.mock.calls.length;
  const rejected = await publishOutcome(f, first.trialId);
  expect(rejected).toMatchObject({ code: SAMPLE_CHANGED });
  expect(await stored(db, f.input.appId)).toEqual(before);
  expect(f.append).toHaveBeenCalledTimes(audits);

  // 重跑试算：摘要随最新版本 v3 变化。
  const second = await trial(f);
  expect(second.sampleCount).toBe(1);
  expect(second.sampleHash).not.toBe(first.sampleHash);

  // 重跑之后只因补贴变化写 v4（份额同 v3）：用重跑的试算发布成功。
  expect(await appendVersion(f, orderId, { subsidyFen: 200n })).toBe(4);
  expect(await sharesAt(f, orderId, 4)).toEqual(await sharesAt(f, orderId, 3));
  const outcome = await publishOutcome(f, second.trialId);
  expect(outcome).toMatchObject({
    rule_version_id: f.draftId,
    status: 'published',
  });
});
