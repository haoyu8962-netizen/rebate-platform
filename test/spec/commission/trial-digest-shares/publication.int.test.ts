// BR-CALC-22 细则（2026-11-11，D10-1258）：试算后、发布前，样本订单只因补贴类佣金变化写了新版本
// （BR-CALC-27 细则「仅补贴变化的版本」：各方份额、base_fen 与上一版逐项相同，只重算含补贴的三段）
// 不算样本变化，不要求重跑试算；份额变化仍拒绝发布（TRIAL_SAMPLE_CHANGED）。
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

async function trial(f: Fixture) {
  return db.transaction().execute((tx) => service.runTrial(tx, f.context, f.deps));
}

async function publish(f: Fixture, trialId: string) {
  return db.transaction().execute((tx) => service.publish(tx, { ...f.context, trialId }, f.deps));
}

async function rejectUnchanged(
  f: Fixture,
  code: RulePublicationErrorCode,
  action: () => Promise<unknown>,
) {
  const before = await stored(db, f.input.appId);
  const audits = f.append.mock.calls.length;
  await expect(action()).rejects.toMatchObject({ code });
  expect(await stored(db, f.input.appId)).toEqual(before);
  expect(f.append).toHaveBeenCalledTimes(audits);
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

/** 某单某版本的份额行（去掉版本号与写入时间），用于核对夹具确实是「各方份额逐项相同」。 */
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

it('[AC-B1-18h#4] BR-CALC-22 试算后样本单只因补贴变化写了新版本：重跑摘要不变，原试算报告照常发布', async () => {
  const f = await setup(db);
  const orderId = await seedSample(db, f.input, f.baseId);
  await seedOrderRow(f, orderId);
  const report = await trial(f);
  expect(report.sampleCount).toBe(1);

  // 补贴 0 → 200 → 350，N 不变：两个仅补贴变化的版本。
  expect(await appendVersion(f, orderId, { subsidyFen: 200n })).toBe(2);
  expect(await appendVersion(f, orderId, { subsidyFen: 350n })).toBe(3);
  const v1 = await sharesAt(f, orderId, 1);
  expect(v1).toHaveLength(3);
  expect(await sharesAt(f, orderId, 3)).toEqual(v1);

  // 样本未变：同一窗口重跑试算，摘要与报告都与原试算相同。
  const rerun = await trial(f);
  expect(rerun.sampleCount).toBe(report.sampleCount);
  expect(rerun.sampleHash).toBe(report.sampleHash);
  expect(rerun.report).toEqual(report.report);

  // 不要求重跑试算：用原试算报告发布成功。
  await expect(publish(f, report.trialId)).resolves.toMatchObject({
    rule_version_id: f.draftId,
    status: 'published',
    publisher_id: f.input.actor.adminUserId,
    published_at: new Date(NOW),
  });
  expect(f.append).toHaveBeenLastCalledWith(
    expect.objectContaining({
      appId: f.input.appId,
      action: 'commission.rule.publish',
      target: f.draftId,
    }),
  );
});

it('[AC-B1-18h#5] BR-CALC-22 份额变化仍须重跑试算；重跑后再有仅补贴变化的版本不妨碍发布', async () => {
  const f = await setup(db);
  const a = await seedSample(db, f.input, f.baseId);
  const b = await seedSample(db, f.input, f.baseId, { platform: 'jd', orderType: 'share' });
  await seedOrderRow(f, a);
  await seedOrderRow(f, b);
  const first = await trial(f);
  expect(first.sampleCount).toBe(2);

  // A 只因补贴变化写 v2；B 的归属用户份额 555 → 500（份额变化）写 v2。
  await appendVersion(f, a, { subsidyFen: 200n });
  await appendVersion(f, b, { subsidyFen: 0n, ownFen: 500n });
  await rejectUnchanged(f, 'TRIAL_SAMPLE_CHANGED', () => publish(f, first.trialId));

  const second = await trial(f);
  expect(second.sampleCount).toBe(2);
  expect(second.sampleHash).not.toBe(first.sampleHash);

  // 重跑之后两单都只因补贴变化各写一个新版本（B 照抄已变化的 v2 份额）。
  expect(await appendVersion(f, a, { subsidyFen: 350n })).toBe(3);
  expect(await appendVersion(f, b, { subsidyFen: 120n })).toBe(3);
  expect(await sharesAt(f, b, 3)).toEqual(await sharesAt(f, b, 2));

  // 发布结果先取成值（拒绝时取到错误对象），再断言：发布成功、不是拒绝。
  const outcome: unknown = await publish(f, second.trialId).then(
    (published) => published,
    (error: unknown) => error,
  );
  expect(outcome).toMatchObject({
    rule_version_id: f.draftId,
    status: 'published',
  });
});
