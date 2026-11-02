// B1-08zh（D10-574）生产验收：报文经 mapPddOrder、真实 worker 入口的流水线入库，再由真实 api 入口读
// GET /v1/wallet/summary 与 GET /v1/orders（BR-FUND-18、BR-TEXT-02）。两个入口都是 AppModule 组出来的，端口不自注入。
// 钱包与订单页直接读 est，所以 pdd 把服务费多算进去：这正是现在错的地方。
// 金额手写：规则版本预留 0、本人 50%。佣金 1000、服务费 100 → N=900，得 450；佣金 1200、服务费 120 → N=1080，得 540。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { singleBound } from '../../admin/system-audit/kit.ts';
import { WALLET, wallet } from '../../identity/me-balance/kit.ts';
import {
  closeKit,
  consentAll,
  fixture as member,
  openKit,
  type Kit,
} from '../../identity/me/http-kit.ts';
import type { Response } from '../../identity/sms-codes/http-kit.ts';
import { ATTR_CODE, TIMEOUT, withFixture } from '../../orders/rebate-wiring/kit.ts';
import {
  mapPddOrder,
  type PddOrderPage,
} from '../../../../apps/api/src/modules/union/infra/pdd/orders.ts';

/** 与 orders/rebate-wiring 夹具的归因码、推广位相同。 */
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

// 与 worker 入口同样经 URL 加载：计数器在模块里，读到的必须是流水线计数的那一份。
const metrics = (await import(
  new URL('../../../../apps/api/src/modules/platform/metrics/index.ts', import.meta.url).href
)) as typeof import('../../../../apps/api/src/modules/platform/metrics/index.ts');

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 120_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

const LIST = '/v1/orders';
// member() 把 api 的时钟设到 2031-05-06T08:08:09Z：在 order.user_query_months 之内。
const PAID_AT = '2031-04-02T02:00:00.000Z';
const SYNC_AT = '2031-04-03T02:00:00.000Z';

function page(response: Response): Schema<'OrderListData'> {
  expect(response.statusCode).toBe(200);
  const body = response.json<{ code: number; data: Schema<'OrderListData'> }>();
  expect(body).toMatchObject({ code: 0 });
  const schema =
    kit.document.paths[LIST]!['get']!.responses['200']!.content['application/json']!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body.data;
}

/** api 入口的会员，同时是 worker 入口上这单的归属人。 */
async function memberOwner() {
  const m = await member(kit);
  await consentAll(kit, m);
  await m.db
    .updateTable('users')
    .set({ attr_code: ATTR_CODE })
    .where('app_id', '=', m.appId)
    .where('id', '=', m.uid)
    .execute();
  const session = await m.session();
  return {
    owner: { appId: m.appId, userId: m.uid },
    /** 这一单在订单页的金额；单子不在列表里按断言失败。 */
    async amount(row: { readonly order_id: string; readonly buy_type: string | null }) {
      const listed = page(await session.request(`${LIST}?scope=${row.buy_type ?? 'self'}`)).items;
      const item = listed.find((candidate) => candidate.order_id === row.order_id);
      expect(item, 'the order is on the order page').toBeDefined();
      return item?.est_rebate_fen;
    },
    wallet: async () => wallet(kit, await session.request(WALLET)),
  };
}

type Member = Awaited<ReturnType<typeof memberOwner>>;
type Fixture = Parameters<Parameters<typeof withFixture>[1]>[0];

async function withPdd(m: Member, test: (f: Fixture) => Promise<void>): Promise<void> {
  await withFixture(
    singleBound(kit.suite.db),
    async (f) => {
      await f.setConfig('credit.enabled.pdd', true);
      await test(f);
    },
    { platform: 'pdd', owner: m.owner, now: SYNC_AT },
  );
}

async function missingTotal(): Promise<number> {
  return metricTotal(await metrics.createMetricsRegistry({ entry: 'worker' }).render());
}

it(
  '[AC-B1-08zh#27][BR-FUND-18][BR-TEXT-02] 钱包与订单页同数，都按净额算：佣金 1000、服务费 100 得 450，不是 500',
  async () => {
    const m = await memberOwner();
    await withPdd(m, async (f) => {
      await f.sync(pddReports(PAID_AT).next(1000, 100));

      expect((await m.wallet())['estimated_fen']).toBe(450);
      const row = await f.row();
      expect(await m.amount(row)).toBe(450);
      expect(row).toMatchObject({
        rebate_status: 'ESTIMATED',
        est_commission_fen: 900n,
        service_fee_fen: 100n,
        commission_version: 1,
      });
      expect((await f.splits())[0]).toMatchObject({ raw_n_fen: 900n, base_fen: 900n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zh#28][BR-CALC-03][BR-FUND-18] 新单缺服务费：est 为 null，待处理 SERVICE_FEE_RATE_MISSING，无快照，版本 0，钱包不计入不抛错，订单页金额未知',
  async () => {
    const m = await memberOwner();
    await withPdd(m, async (f) => {
      await f.sync(pddReports(PAID_AT).next(1000));

      const row = await f.row();
      expect(row).toMatchObject({ est_commission_fen: null, commission_version: 0 });
      expect((await f.pending()).map((item) => [item.reason, item.status])).toEqual([
        ['SERVICE_FEE_RATE_MISSING', 'open'],
      ]);
      expect(await f.splits()).toEqual([]);
      expect(await f.amounts()).toEqual([]);
      expect(await f.totals()).toEqual([]);
      const summary = await m.wallet();
      expect(summary['estimated_fen']).toBe(0);
      expect(summary['estimated_total_fen']).toBe(0);
      // 未知是 null，不是 0。
      expect(await m.amount(row)).toBeNull();
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zh#29][BR-CALC-03][BR-FUND-18] 已有 est 后续缺服务费：est、版本不变，无新金额行，无新待处理，钱包不抛错、金额不变，计数 +1',
  async () => {
    const m = await memberOwner();
    await withPdd(m, async (f) => {
      const reports = pddReports(PAID_AT);
      await f.sync(reports.next(1000, 100));
      expect((await f.row()).est_commission_fen).toBe(900n);
      const before = await missingTotal();

      await f.sync(reports.next(1200));

      const row = await f.row();
      expect(row).toMatchObject({ est_commission_fen: 900n, commission_version: 1 });
      expect((await f.amounts()).map((item) => [item.commission_version, item.amount_fen])).toEqual(
        [[1, 450n]],
      );
      expect((await f.totals()).map((item) => item.commission_version)).toEqual([1]);
      expect(await f.pending()).toEqual([]);
      expect(await missingTotal()).toBe(before + 1);
      expect((await m.wallet())['estimated_fen']).toBe(450);
      expect(await m.amount(row)).toBe(450);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zh#30][BR-CALC-03][BR-FUND-03] 服务费回来：est 更新为净额，版本前进，金额行与 totals 都在，钱包与订单页取新金额，不再计数',
  async () => {
    const m = await memberOwner();
    await withPdd(m, async (f) => {
      const reports = pddReports(PAID_AT);
      await f.sync(reports.next(1000, 100));
      expect((await f.row()).est_commission_fen).toBe(900n);
      await f.sync(reports.next(1200));
      const before = await missingTotal();

      await f.sync(reports.next(1200, 120));

      const row = await f.row();
      expect(row).toMatchObject({
        est_commission_fen: 1080n,
        service_fee_fen: 120n,
        commission_version: 2,
      });
      expect(
        (await f.amounts()).map((item) => [
          item.commission_version,
          item.base_fen,
          item.amount_fen,
        ]),
      ).toEqual([
        [1, 900n, 450n],
        [2, 1080n, 540n],
      ]);
      expect(
        (await f.totals()).map((item) => [
          item.commission_version,
          item.n_total_fen,
          item.base_fen,
        ]),
      ).toEqual([
        [1, 900n, 900n],
        [2, 1080n, 1080n],
      ]);
      expect(await missingTotal()).toBe(before);
      expect((await m.wallet())['estimated_fen']).toBe(540);
      expect(await m.amount(row)).toBe(540);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zh#31][BR-CALC-03][BR-FUND-18] 新单缺服务费后服务费回来：现有重试收口，快照的 N 是净额，待处理关闭，钱包与订单页同数',
  async () => {
    const m = await memberOwner();
    await withPdd(m, async (f) => {
      const reports = pddReports(PAID_AT);
      await f.sync(reports.next(1000));
      expect(await f.row()).toMatchObject({ est_commission_fen: null, commission_version: 0 });

      await f.sync(reports.next(1000, 100));

      const row = await f.row();
      expect(row).toMatchObject({
        est_commission_fen: 900n,
        service_fee_fen: 100n,
        commission_version: 1,
      });
      expect((await f.splits()).map((item) => [item.raw_n_fen, item.base_fen])).toEqual([
        [900n, 900n],
      ]);
      expect((await f.amounts()).map((item) => [item.commission_version, item.amount_fen])).toEqual(
        [[1, 450n]],
      );
      expect((await f.totals()).map((item) => item.commission_version)).toEqual([1]);
      expect((await f.pending()).filter((item) => item.status === 'open')).toEqual([]);
      expect((await m.wallet())['estimated_fen']).toBe(450);
      expect(await m.amount(row)).toBe(450);
    });
  },
  TIMEOUT,
);
