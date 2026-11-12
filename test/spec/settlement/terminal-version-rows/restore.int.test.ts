// B1-18k · 终态期间佣金变化写下的版本行，人工恢复后即为订单的当前版本（BR-CALC-15 一览终态一路「人工恢复（BR-FUND-22）
// 后即为订单的当前版本」、BR-CALC-27；D10-1272）。订单经生产 worker 的订单同步流水线（../../commission/version-rule/
// kit.ts 的 withRule）进入终态、佣金再回正；回正那次同步由 orders 登记的 platform_restore 差错单经真实 admin 入口
// （../platform-restore/kit.ts 的 withRestoreAdmin：POST /admin/v1/recon-diffs/{id}/restore，order.restore + totp
// 二次验证，同一数据库与 App）恢复，不用 SQL 改状态。
// 要钉：R12（VOID → WAITING / ESTIMATED）后订单页金额与钱包可读且按当前 N（800 → 400）；R12 到 WAITING 后账单可跑，
// b_settle 800 与当前版本 base 800 一致，不出账单金额不一致的差错单（BR-FUND-04 零容差）。R13（CLAWED_BACK → CREDITED）
// 后订单页金额可读、当前版本有行。
// 夹具：拼多多、服务费 0、预留 0、本人 50 %、无邀请人。手算：N 800 → B 800 → 400。
// 取整边界（Codex spec-test r1 S1-4，第一例）：N 801 → B 801 → 本人 801 × 5000 / 10000 = 400.5 → 向下取整 400；
// 四段：① 801（补贴 0），② 801 − 801 = 0，③ 801，Σ用户份额 400，④ 801 − 400 − 0（淘礼金红包）= 401。
import { acquireTestRedis, createTestDatabase, type TestRedis } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  BILL_AT,
  TIMEOUT,
  databaseFixture,
  received,
  settled,
  touched,
  withRule,
} from '../../commission/version-rule/kit.ts';
import {
  platformRestored,
  withRestoreAdmin,
  type RestoreFixture,
} from '../platform-restore/kit.ts';
import type { App } from '../settlement-records/kit.ts';

const p = databaseFixture(createTestDatabase);

let redis: TestRedis | undefined;
beforeAll(async () => {
  redis = await acquireTestRedis();
}, TIMEOUT);
afterAll(async () => {
  await redis?.stop();
}, TIMEOUT);

type Rule = Parameters<Parameters<typeof withRule>[1]>[0];

/** The admin entry's view of this file's database and Redis (the platform-restore kit's suite shape). */
const suite: RestoreFixture['s'] = {
  db: () => p.db,
  holder: () => p.control,
  redisUrl: () => {
    expect(redis, 'test redis').toBeDefined();
    return redis!.url;
  },
};

/** The restore fixture of the worker's app: same database and app, the admin clock at its now. */
async function restoreFixture(w: Rule, app: App): Promise<RestoreFixture> {
  const clock = new FixedClock(w.clock.now().toISOString());
  const rules = await p.db
    .selectFrom('commission_rule_versions')
    .select('rule_version_id')
    .where('app_id', '=', app.appId)
    .execute();
  expect(rules, 'the published rule version of the app').toHaveLength(1);
  return {
    s: suite,
    db: p.db,
    clock,
    appId: app.appId,
    ledger: createLedger({ clock }),
    ruleVersionId: rules[0]!.rule_version_id,
    accounts: new Map(),
  };
}

/** The one open platform_restore difference the sync registered for the app. */
async function openRestoreDiff(app: App) {
  const rows = await p.db
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', app.appId)
    .where('type', '=', 'platform_restore')
    .where('status', '=', 'open')
    .execute();
  expect(rows, 'the platform_restore difference of the positive sync').toHaveLength(1);
  return rows[0]!;
}

/** Restores the app's open platform_restore difference through the real admin entry. */
async function restoreThroughAdmin(w: Rule, app: App, expected: string): Promise<void> {
  const diff = await openRestoreDiff(app);
  const f = await restoreFixture(w, app);
  await withRestoreAdmin(f, async (h) => {
    const data = await platformRestored(await h.restore(diff.id));
    expect(data.rebate_status_after).toBe(expected);
  });
}

it(
  '[AC-B1-18k#4][BR-CALC-15][BR-CALC-27][BR-FUND-22][BR-FUND-04] VOID（WAITING 单结算 -100 → BASE_ZERO）后结算回正 801（v3，取整边界），经真实入口 R12 回到 WAITING：订单页 b_est 801、本人 400（向下取整），钱包 400，当前版本行 B 801、400，① 801 ② 0 ④ 401；账单 b_settle 801 与当前 base 一致，不出差错单',
  async () => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app);
      await o.sync();
      await o.sync(received());
      await o.sync(settled(-100n));
      expect(await o.row(), '前置：BASE_ZERO 作废，v2').toMatchObject({
        rebate_status: 'VOID',
        reason: 'COMMISSION_ZERO',
        commission_version: 2,
      });
      await o.sync(settled(801n, touched(1)));
      expect(await o.row(), '前置：终态期间回正，v3，仍 VOID').toMatchObject({
        rebate_status: 'VOID',
        settle_commission_fen: 801n,
        commission_version: 3,
      });

      await restoreThroughAdmin(w, app, 'WAITING');

      const restored = await o.row();
      expect(restored).toMatchObject({ rebate_status: 'WAITING', settle_commission_fen: 801n });
      expect(await o.amounts(restored.commission_version)).toEqual([[801n, 400n]]);
      expect(await o.fourAmounts(restored.commission_version)).toEqual({
        n_total_fen: 801n,
        pre_base_deduct_fen: 0n,
        base_fen: 801n,
        user_share_total_fen: 400n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: 401n,
      });
      await expect(o.figure()).resolves.toMatchObject({ b_est: 801n, est_rebate_fen: 400n });
      await expect(o.wallet()).resolves.toMatchObject({ estimated_total_fen: 400n });

      const diffs = await w.diffs(app);
      w.clock.set(BILL_AT);
      await w.bill(app);

      expect(await w.items(app)).toMatchObject([
        { item_type: 'order', order_id: restored.order_id, b_settle_fen: 801n },
      ]);
      expect(await w.diffs(app), '账单不出金额不一致的差错单').toEqual(diffs);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-18k#4][BR-CALC-15][BR-CALC-27][BR-FUND-22] VOID（PAID 单预估 0 → BASE_ZERO）后预估回正 800（v3），经真实入口 R12 回到 ESTIMATED：订单页 b_est 800、本人 400，钱包 400，当前版本行 B 800、400',
  async () => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      const o = w.order(app);
      await o.sync();
      await o.sync({ est_commission_fen: 0n });
      expect(await o.row(), '前置：BASE_ZERO 作废，v2').toMatchObject({
        rebate_status: 'VOID',
        platform_status: 'PAID',
        commission_version: 2,
      });
      await o.sync({ est_commission_fen: 800n });
      expect(await o.row(), '前置：终态期间回正，v3，仍 VOID').toMatchObject({
        rebate_status: 'VOID',
        est_commission_fen: 800n,
        commission_version: 3,
      });

      await restoreThroughAdmin(w, app, 'ESTIMATED');

      const restored = await o.row();
      expect(restored).toMatchObject({ rebate_status: 'ESTIMATED', est_commission_fen: 800n });
      expect(await o.amounts(restored.commission_version)).toEqual([[800n, 400n]]);
      await expect(o.figure()).resolves.toMatchObject({ b_est: 800n, est_rebate_fen: 400n });
      await expect(o.wallet()).resolves.toMatchObject({ estimated_total_fen: 400n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-18k#5][BR-CALC-15][BR-CALC-27][BR-FUND-22] CLAWED_BACK（入账后结算 0 → R8）后结算回正 800（v3），经真实入口 R13 回到 CREDITED：订单页金额可读，当前版本有行（B 800、本人 400）',
  async () => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      const o = await w.credited(app);
      await o.sync(settled(0n, touched(1)));
      expect(await o.row(), '前置：R8 整单扣回，v2').toMatchObject({
        rebate_status: 'CLAWED_BACK',
        commission_version: 2,
      });
      await o.sync(settled(800n, touched(2)));
      expect(await o.row(), '前置：终态期间回正，v3，仍 CLAWED_BACK').toMatchObject({
        rebate_status: 'CLAWED_BACK',
        settle_commission_fen: 800n,
        commission_version: 3,
      });

      await restoreThroughAdmin(w, app, 'CREDITED');

      const restored = await o.row();
      expect(restored).toMatchObject({ rebate_status: 'CREDITED', settle_commission_fen: 800n });
      expect(await o.amounts(restored.commission_version)).toEqual([[800n, 400n]]);
      expect(await o.fourAmounts(restored.commission_version)).toMatchObject({
        n_total_fen: 800n,
        base_fen: 800n,
        user_share_total_fen: 400n,
      });
      await expect(o.figure()).resolves.toBeDefined();
    });
  },
  TIMEOUT,
);
