// B1-08zh（D10-574）缺服务费时的计数与日志：已有 est 的单后续缺服务费，计数 +1、记一条 warn，都不含金额与订单号；
// 新单缺服务费走现有待处理的 warn。淘宝、京东不计数（京东在这里走真实流水线，淘宝的计划在 plans.test.ts）。
// 真实 createOrderPipeline / createOrderUpdateStep；日志用可观察的 logger（本文件的 harness）。
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { createMetricsRegistry } from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import {
  TIMEOUT,
  amountsAt,
  databaseFixture,
  estimatesOf,
  portOrderOf,
  rebateOf,
  snapshotPortOf,
  snapshotRules,
  storedVersions,
} from '../../commission/estimate-port/kit.ts';
import { at, fixture as orderFixture } from '../../orders/attribution/kit.ts';
import {
  createOrderPipeline,
  createOrderUpdateStep,
} from '../../../../apps/api/src/modules/orders/index.ts';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import {
  mapPddOrder,
  type PddOrderPage,
} from '../../../../apps/api/src/modules/union/infra/pdd/orders.ts';

const p = databaseFixture(createTestDatabase);

const PAID_AT = '2026-10-15T16:00:00.000Z';
const registry = createMetricsRegistry({ entry: 'worker' });

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

function mapPdd(overrides: Record<string, unknown> = {}) {
  return mapPddOrder(pddRow(overrides), 'increment', PAGE);
}

/** 同一子订单的一串报文：每次修改时间后移一分钟。fee 省略即报文没有 duo_id_service_fee。 */
function pddReports(paidAt: string) {
  const orderSn = `SYN-${randomUUID()}`;
  const paySeconds = Date.parse(paidAt) / 1000;
  let step = 0;
  return {
    orderSn,
    next(promotion: number, fee?: number) {
      step += 1;
      return mapPdd({
        order_sn: orderSn,
        order_pay_time: paySeconds,
        order_modify_at: paySeconds + step * 60,
        promotion_amount: promotion,
        duo_id_service_fee: fee,
      });
    },
  };
}

interface MetricSample {
  readonly labels: string;
  readonly value: number;
}

/** /metrics 文本里这个指标的样本；没有样本为空数组。 */
function metricSamples(text: string): MetricSample[] {
  const samples: MetricSample[] = [];
  for (const line of text.split('\n')) {
    const match = /^couli_pdd_service_fee_missing_total(\{.*\})? (\S+)$/.exec(line);
    if (match !== null) samples.push({ labels: match[1] ?? '', value: Number(match[2]) });
  }
  return samples;
}

/** 所有序列的合计；还没有序列时是 0。 */
function metricTotal(text: string): number {
  return metricSamples(text).reduce((sum, sample) => sum + sample.value, 0);
}

/**
 * 新 App 的一单：platform 决定流水线与归因参数；金额由测试给的报文决定。真实 createOrderPipeline、
 * createOrderUpdateStep、commission、rebate 与数据库，只有归属查询是夹具（orders/attribution/kit.ts）。
 * 日志要逐条看，所以这里用可观察的 logger，不走 worker 入口。规则版本：预留 1500，本人 5000。
 */
async function harness(
  db: Kysely<DB>,
  patch: NonNullable<Parameters<typeof orderFixture>[1]> = {},
) {
  const f = await orderFixture(db, { platform: 'pdd', ...patch });
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
    ...f,
    row,
    /** 平台真实状态码在这个夹具的状态表之外：只把状态码换成夹具的 paid，其余是映射结果原样。 */
    report: (order: UnionOrder) => pipeline.process({ ...order, raw_status: 'paid' }, f.ctx),
    /** 夹具自己造的归一订单（京东用例），状态码已经是夹具的。 */
    process: (order: UnionOrder) => pipeline.process(order, f.ctx),
    pendingRows: () =>
      db.selectFrom('order_sync_pending').selectAll().where('app_id', '=', f.ctx.app_id).execute(),
    /** 写库后的订单引用，给金额行读取用。 */
    stored: async () => portOrderOf(await row()),
  };
}

const FORBIDDEN_FIELD = /fen|amount|commission|promotion|service_fee|custom|buyer|phone/i;

/** 一次记录里的问题：字段不平铺、字段名像金额、值是金额或订单号或买家参数。 */
function logProblems(
  call: readonly unknown[],
  amounts: readonly bigint[],
  forbidden: readonly string[],
): string[] {
  const problems: string[] = [];
  const [fields, message] = call;
  const texts: string[] = typeof message === 'string' ? [message] : [];
  const entries: readonly (readonly [string, unknown])[] =
    typeof fields === 'object' && fields !== null ? Object.entries(fields) : [['', fields]];
  const amountTexts = amounts.map((amount) => amount.toString());
  for (const [name, value] of entries) {
    if (FORBIDDEN_FIELD.test(name)) problems.push(`field ${name}`);
    if (typeof value === 'object' && value !== null) problems.push(`nested field ${name}`);
    if (
      (typeof value === 'bigint' || typeof value === 'number') &&
      amountTexts.includes(value.toString())
    ) {
      problems.push(`amount in ${name}`);
    }
    if (typeof value === 'string') texts.push(value);
  }
  for (const text of texts) {
    for (const value of forbidden) {
      if (text.includes(value)) problems.push(`forbidden value in "${text}"`);
    }
    // 只比完整的数字词：连字符算在词里，UUID 的一段不会被当成金额。
    const words = text.split(/[^-\w]+/);
    for (const amount of amountTexts) {
      if (words.includes(amount)) problems.push(`amount in "${text}"`);
    }
  }
  return problems;
}

async function missingTotal(): Promise<number> {
  return metricTotal(await registry.render());
}

it(
  '[AC-B1-08zh#23][BR-CALC-03] 已有 est 的单后续缺服务费：est、版本不变，无新金额行，无待处理，计数 +1，一条 warn',
  async () => {
    const h = await harness(p.db);
    const reports = pddReports(PAID_AT);
    await h.report(reports.next(1000, 100));
    expect(await h.row()).toMatchObject({ est_commission_fen: 900n, commission_version: 1 });
    const before = await missingTotal();
    h.logger.warn.mockClear();

    expect(await h.report(reports.next(1200))).toMatchObject({ kind: 'updated' });

    expect(await h.row()).toMatchObject({ est_commission_fen: 900n, commission_version: 1 });
    expect(await storedVersions(p.db, await h.stored())).toEqual({ amounts: [1], totals: [1] });
    expect(await h.pendingRows()).toEqual([]);
    expect(await missingTotal()).toBe(before + 1);
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zh#24][BR-ID-33] 缺服务费这一路的日志：只有平铺字段，没有金额、订单号、买家参数',
  async () => {
    const h = await harness(p.db);
    const reports = pddReports(PAID_AT);
    await h.report(reports.next(1000, 100));
    expect((await h.row()).est_commission_fen).toBe(900n);
    h.logger.info.mockClear();
    h.logger.warn.mockClear();
    h.logger.error.mockClear();

    await h.report(reports.next(1200));

    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    const calls = [
      ...h.logger.info.mock.calls,
      ...h.logger.warn.mock.calls,
      ...h.logger.error.mock.calls,
    ];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(
        logProblems(
          call,
          [1200n, 1000n, 900n, 100n],
          [reports.orderSn, ATTR_UID, CUSTOM_PARAMETERS],
        ),
      ).toEqual([]);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zh#25][BR-CALC-03] 新单缺服务费：est 为 null，待处理 SERVICE_FEE_RATE_MISSING 且告警，日志不含金额与订单号',
  async () => {
    const h = await harness(p.db);
    const reports = pddReports(PAID_AT);

    expect(await h.report(reports.next(1000))).toMatchObject({ kind: 'inserted' });

    expect(await h.row()).toMatchObject({ est_commission_fen: null, commission_version: 0 });
    expect((await h.pendingRows()).map((row) => [row.reason, row.status])).toEqual([
      ['SERVICE_FEE_RATE_MISSING', 'open'],
    ]);
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'SERVICE_FEE_RATE_MISSING' }),
      expect.any(String),
    );
    const calls = [
      ...h.logger.info.mock.calls,
      ...h.logger.warn.mock.calls,
      ...h.logger.error.mock.calls,
    ];
    for (const call of calls) {
      expect(logProblems(call, [1000n], [reports.orderSn, ATTR_UID, CUSTOM_PARAMETERS])).toEqual(
        [],
      );
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zh#26][BR-CALC-03] 其他平台不变：京东没有服务费照常建快照、版本前进，不进待处理，不计数',
  async () => {
    expect(mapPdd().est_commission_fen).toBe(900n);

    const h = await harness(p.db, {
      platform: 'jd',
      service_fee_fen: null,
      est_commission_fen: 1000n,
      commission_fen: 1000n,
      attr_params: { relation_id: null, sub_union_id: 'n_abcd1234', custom_parameters: null },
    });
    const before = await missingTotal();

    expect(await h.process(h.incoming)).toMatchObject({ kind: 'inserted' });
    expect(
      await h.process({
        ...h.incoming,
        est_commission_fen: 2000n,
        commission_fen: 2000n,
        modified_at: at('2026-10-16T09:00:00.000Z'),
      }),
    ).toMatchObject({ kind: 'updated' });

    expect(await h.row()).toMatchObject({ est_commission_fen: 2000n, commission_version: 2 });
    const order = await h.stored();
    expect(await amountsAt(p.db, order, 1)).toEqual([['self', 850n, 425n]]);
    expect(await amountsAt(p.db, order, 2)).toEqual([['self', 1700n, 850n]]);
    expect(await h.pendingRows()).toEqual([]);
    expect(await missingTotal()).toBe(before);
  },
  TIMEOUT,
);
