// B1-08zh（D10-574）refresh / bases：拼多多的 N 也是 settle ?? est，不再减服务费；服务费列为空不再让 N 变成未知
// （BR-CALC-02）。默认单：预留 1500，self 5000 / direct 1000 / indirect 500。金额手写。
// N=900 → B=765；N=1800 → B=1530，765 / 153 / 76，合计 994。
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  amountsAt,
  commission,
  databaseFixture,
  estimatesOf,
  fixture,
  portOrderOf,
  rebateOf,
  snapshotPortOf,
  snapshotRules,
  storedVersions,
  totalsAt,
} from '../../commission/estimate-port/kit.ts';
import {
  createOrderPipeline,
  createOrderUpdateStep,
} from '../../../../apps/api/src/modules/orders/index.ts';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import { fixture as orderFixture } from '../../orders/attribution/kit.ts';
import {
  mapPddOrder,
  type PddOrderPage,
} from '../../../../apps/api/src/modules/union/infra/pdd/orders.ts';

const p = databaseFixture(createTestDatabase);

/** 夹具的付款时间（orders/attribution/kit.ts ATTR）：同步起点与规则生效之后。 */
const PAID_AT = '2026-10-15T16:00:00.000Z';

/** 与 orders/attribution 夹具的归因码、推广位相同。 */
const ATTR_UID = 'abcd1234';
const SLOT = 'slot-ours';
const CUSTOM_PARAMETERS = JSON.stringify({ app: 'n', uid: ATTR_UID });

const PAGE: PddOrderPage = { rawPayloadId: null, like: new Date('2026-10-17T17:30:00.000Z') };

/**
 * 一条已支付的订单报文：佣金 1000（含服务费）、服务费 100。字段名按 pdd.ddk.order.list.increment.get 文档：
 * promotion_amount 佣金含软件服务费，duo_id_service_fee 软件服务费，都是整数分。合成值，不是录制报文。
 */
function pddRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    order_sn: 'SYN-241102-0001',
    order_id: 'SYN-PO-0001',
    p_id: SLOT,
    pid: SLOT,
    goods_id: 8123456789012,
    goods_sign: 'syn-goods',
    mall_id: 7001,
    custom_parameters: CUSTOM_PARAMETERS,
    goods_price: 12000,
    order_amount: 12000,
    promotion_amount: 1000,
    duo_id_service_fee: 100,
    order_status: 0,
    order_status_desc: '已支付',
    order_pay_time: 1792000000,
    order_modify_at: 1792000060,
    ...overrides,
  };
}

/** 同一子订单的一串报文：每次修改时间后移一分钟。fee 省略即报文没有 duo_id_service_fee。 */
function pddReports(paidAt: string) {
  const orderSn = `SYN-${randomUUID()}`;
  const paySeconds = Date.parse(paidAt) / 1000;
  let step = 0;
  return {
    next(promotion: number, fee?: number) {
      step += 1;
      return mapPddOrder(
        pddRow({
          order_sn: orderSn,
          order_pay_time: paySeconds,
          order_modify_at: paySeconds + step * 60,
          promotion_amount: promotion,
          duo_id_service_fee: fee,
        }),
        'increment',
        PAGE,
      );
    },
  };
}

/**
 * 新 App 的一单：真实 createOrderPipeline、createOrderUpdateStep、commission、rebate 与数据库，只有归属查询是夹具
 * （orders/attribution/kit.ts）。规则版本：预留 1500，本人 5000。
 */
async function harness(db: Kysely<DB>) {
  const f = await orderFixture(db, { platform: 'pdd' });
  f.findPid.mockResolvedValue([{ pid_scene: 'self_buy', status: 'active', site_id: null }]);
  await snapshotRules(db, f.ctx.app_id);
  const estimates = estimatesOf(f.clock);
  const rebate = rebateOf(f.clock, estimates);
  const snapshots = snapshotPortOf(f.clock, f.ctx.app_id, f.userId);
  const pipeline = createOrderPipeline({
    ...f.deps,
    rebate,
    snapshots,
    updateStep: createOrderUpdateStep({
      clock: f.clock,
      users: f.deps.users,
      bindings: f.deps.bindings,
      statusMaps: f.deps.statusMaps,
      pids: f.deps.pids,
      logger: f.logger,
      rebate,
      snapshots,
      events: { publish: async () => ({ eventId: randomUUID(), duplicate: false }) },
    }),
  });

  async function row() {
    return db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', f.ctx.app_id)
      .executeTakeFirstOrThrow();
  }

  return {
    estimates,
    row,
    /** 平台真实状态码在这个夹具的状态表之外：只把状态码换成夹具的 paid，其余是映射结果原样。 */
    report: (order: UnionOrder) => pipeline.process({ ...order, raw_status: 'paid' }, f.ctx),
    split: () =>
      db
        .selectFrom('commission_splits')
        .selectAll()
        .where('app_id', '=', f.ctx.app_id)
        .executeTakeFirstOrThrow(),
    /** 写库后的订单引用，给金额行读取与 bases 用。 */
    stored: async () => portOrderOf(await row()),
  };
}

it(
  '[AC-B1-08zh#17][BR-CALC-02] bases：拼多多 after 直接按 est 换算，服务费 100 不再减；结算优先时同样不减',
  async () => {
    const f = await fixture(p.db);
    const o = await f.order({
      platform: 'pdd',
      estFen: 900n,
      snapshotNFen: 900n,
      patch: { service_fee_fen: 100n },
    });
    expect(await f.bases(o, { estAfter: 900n, settleCommissionFen: null })).toEqual({
      before: 765n,
      after: 765n,
    });
    expect(await f.bases(o, { estAfter: 900n, settleCommissionFen: 1800n })).toEqual({
      before: 765n,
      after: 1530n,
    });
    // 净额等于服务费也不再归零：100 × 85% = 85。净额为负按 0 算。
    expect(await f.bases(o, { estAfter: 100n, settleCommissionFen: null })).toEqual({
      before: 765n,
      after: 85n,
    });
    expect(await f.bases(o, { estAfter: -200n, settleCommissionFen: null })).toEqual({
      before: 765n,
      after: 0n,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zh#18][BR-CALC-02] bases：服务费列为空时 N 仍已知，after 不是 null；est 与 settle 全空才是 null',
  async () => {
    const f = await fixture(p.db);
    const o = await f.order({
      platform: 'pdd',
      estFen: 900n,
      snapshotNFen: 900n,
      patch: { service_fee_fen: null },
    });
    expect(await f.bases(o, { estAfter: 900n, settleCommissionFen: null })).toEqual({
      before: 765n,
      after: 765n,
    });
    expect(await f.bases(o, { estAfter: null, settleCommissionFen: 1800n })).toEqual({
      before: 765n,
      after: 1530n,
    });
    expect(await f.bases(o, { estAfter: null, settleCommissionFen: null })).toEqual({
      before: 765n,
      after: null,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zh#19][BR-CALC-02][BR-CALC-27] refresh：拼多多 N 就是 est，四段金额都不再减服务费',
  async () => {
    const f = await fixture(p.db);
    const o = await f.order({
      platform: 'pdd',
      estFen: 900n,
      snapshotNFen: 900n,
      patch: { service_fee_fen: 100n },
    });
    await f.move(o, { estAfter: 1800n });

    await f.refresh(o);

    expect(await amountsAt(p.db, o, 2)).toEqual([
      ['self', 1530n, 765n],
      ['direct', 1530n, 153n],
      ['indirect', 1530n, 76n],
    ]);
    expect(await totalsAt(p.db, o, 2)).toEqual({
      n_total_fen: 1800n,
      pre_base_deduct_fen: 270n,
      base_fen: 1530n,
      user_share_total_fen: 994n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 806n,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zh#20][BR-CALC-02] refresh：结算优先，结算额不减服务费，预估不参与',
  async () => {
    const f = await fixture(p.db);
    const o = await f.order({
      platform: 'pdd',
      rebateStatus: 'WAITING',
      platformStatus: 'SETTLED',
      estFen: 900n,
      snapshotNFen: 900n,
      settleFen: 1800n,
      patch: { service_fee_fen: 100n },
    });
    await f.move(o, { estAfter: 9999n });

    await f.refresh(o);

    expect(await totalsAt(p.db, o, 2)).toMatchObject({ n_total_fen: 1800n, base_fen: 1530n });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zh#21][BR-CALC-02] refresh：服务费列为空也按 est 写当前版本，版本行不缺（B2-03q 遗留：缺行时钱包读取抛错）',
  async () => {
    const f = await fixture(p.db);
    const o = await f.order({
      platform: 'pdd',
      estFen: 900n,
      snapshotNFen: 900n,
      patch: { service_fee_fen: null },
    });
    await f.move(o, { estAfter: 1800n });

    await f.refresh(o);

    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2], totals: [1, 2] });
    const read = await p.db.transaction().execute((trx) =>
      commission.readCommissionSnapshot(trx, {
        appId: o.appId,
        orderId: o.orderId,
        commissionVersion: 2,
      }),
    );
    expect(read).toMatchObject({ commissionVersion: 2, baseFen: 1530n });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zh#22][BR-CALC-02] 真实流水线：快照的 B 与 bases、refresh 一致，都是净额算出来的',
  async () => {
    const h = await harness(p.db);
    const reports = pddReports(PAID_AT);

    expect(await h.report(reports.next(1000, 100))).toMatchObject({ kind: 'inserted' });

    expect((await h.row()).est_commission_fen).toBe(900n);
    expect(await h.split()).toMatchObject({ raw_n_fen: 900n, reserve_bp: 1500, base_fen: 765n });
    const order = await h.stored();
    expect(await amountsAt(p.db, order, 1)).toEqual([['self', 765n, 382n]]);
    const bases = await p.db.transaction().execute((trx) =>
      h.estimates.bases(trx, {
        appId: order.appId,
        orderId: order.orderId,
        attrAt: order.attrAt,
        estBefore: 900n,
        estAfter: 900n,
        settleCommissionFen: null,
      }),
    );
    expect(bases).toEqual({ before: 765n, after: 765n });

    // 佣金变化：版本 2 的金额行由 rebate 调真实 refresh 写，N = 2000 − 200 = 1800。
    expect(await h.report(reports.next(2000, 200))).toMatchObject({ kind: 'updated' });
    expect(await h.row()).toMatchObject({ est_commission_fen: 1800n, commission_version: 2 });
    expect(await amountsAt(p.db, order, 2)).toEqual([['self', 1530n, 765n]]);
    expect(await totalsAt(p.db, order, 2)).toMatchObject({ n_total_fen: 1800n, base_fen: 1530n });
  },
  TIMEOUT,
);
