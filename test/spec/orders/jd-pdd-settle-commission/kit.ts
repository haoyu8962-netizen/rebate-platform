// B2-19 规则测试夹具（claude-independent；BR-FUND-02 细则「京东、拼多多已结算时的结算佣金」第 2、3、6 点，
// BR-FUND-09，BR-CALC-03；编排 D10-2408 ①）。补丁 1 后本单只做拼多多：目录名带 jd 是台账 test_paths，
// 京东行为（B2-19a）与京东退货扣回开关（B2-19b）这里一概不断言。
// 拼多多 order_status 5（specs/order-status-map/pdd.csv 映 PLATFORM_SETTLED）时，settle_commission_fen 与同一行
// est_commission_fen 同一取法：promotion_amount − duo_id_service_fee；报文没给服务费时按 union.pdd.service_fee_bp
// 兜底（ceil）；都没有 → null，绝不按 0。2（确认收货）、3（审核成功）仍只写预估（E-24）。
// 报文全部合成（字段名按 pdd.ddk.order.list.increment.get 文档），不是录制。金额都是整数分。
// 真实同步入口：合成传输（不联网）喂给生产的 PddUnionAdapter，走列表 listOrders（increment / pay_time，
// ctx.rowErrors = collect）与按单号详情 getPddOrderDetail，见 pddAdapter / listedByAdapter / detailByAdapter。
// 本文件不导入 @couli/db/testing：要真库的测试把库传进来。
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  CallCtx,
  OrderPage,
  TimeWindow,
  UnionEndpoint,
  UnionOrder,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  mapPddOrder,
  PDD_ORDER_DETAIL,
  type PddOrderPage,
} from '../../../../apps/api/src/modules/union/infra/pdd/orders.ts';
import { PddUnionAdapter } from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';
import { at } from '../wiring/db-kit.ts';

/** 报文里的拼多多状态码（整数）：0 已支付、1 已成团、2 确认收货、3 审核成功、4 审核失败、5 已结算、10 已处罚。 */
export const PDD_PAID_STATUS = 0;
export const PDD_GROUPED_STATUS = 1;
export const PDD_RECEIVED_STATUS = 2;
export const PDD_APPROVED_STATUS = 3;
export const PDD_REJECTED_STATUS = 4;
export const PDD_SETTLED_STATUS = 5;
export const PDD_PUNISHED_STATUS = 10;

/** 合成的毛额与报文服务费：净额 900 分（手算）。 */
export const PROMOTION_AMOUNT = 1000;
export const SERVICE_FEE = 100;
export const NET_FEN = 900n;

/** 结算后联盟佣金又变：毛额 1200、服务费 120 → 净额 1080 分（手算）。 */
export const CHANGED_PROMOTION_AMOUNT = 1200;
export const CHANGED_SERVICE_FEE = 120;
export const CHANGED_NET_FEN = 1080n;

/** 这页报文的元数据：没有服务费率配置、没有 logger。like 只作 Date 模板。 */
export const PAGE: PddOrderPage = {
  rawPayloadId: null,
  like: at('2026-11-21T02:00:00.000Z'),
};

/** 带 union.pdd.service_fee_bp 的页（只用键 "*"，08 BR-CALC-03 例：fee_bp 1000）。 */
export function pageWithFeeBp(serviceFeeBp: unknown): PddOrderPage {
  return { ...PAGE, serviceFeeBp };
}

/** 合法的 union.pdd.service_fee_bp：1000 bp（10%），已核实（不告警）。 */
export const FEE_BP_1000 = { '*': { bp: 1000, source: 'synthetic-b2-19', verified: true } };
/** 合法的 union.pdd.service_fee_bp：600 bp（6%），已核实。1001 分 → 服务费 ceil(60.06)=61 → 940（手算）。 */
export const FEE_BP_600 = { '*': { bp: 600, source: 'synthetic-b2-19', verified: true } };
/** 形状不合法的配置（bp 超过 10000）：整份当作没有。 */
export const FEE_BP_INVALID = { '*': { bp: 20_000, source: 'synthetic-b2-19', verified: true } };

/** 合成适配器的注入时钟：列表时间窗（24 小时、90 天内）以它为终点。只作适配器的时钟，不进断言。 */
const ADAPTER_NOW = '2026-10-22T03:00:00.000Z';
/** listOrders 的时间窗：increment 跨度恰 24 小时；pay_time 同窗。 */
export const LIST_WINDOW: TimeWindow = { from: '2026-10-21T03:00:00.000Z', to: ADAPTER_NOW };

const ENDPOINT: UnionEndpoint = {
  platform: 'pdd',
  mode: 'live',
  baseUrl: 'https://pdd-b2-19.invalid/router',
  quotaKey: 'synthetic-b2-19-account',
};

/** 订单同步的调用上下文：rowErrors = collect（被映射拒绝的行进 rejected，不整页报错）。 */
export const COLLECT_CTX: CallCtx = {
  appId: 'synthetic-b2-19-app',
  requestId: 'synthetic-b2-19-request',
  purpose: 'order_sync',
  rowErrors: 'collect',
};

/**
 * 生产的拼多多适配器，传输是合成的：详情请求恒答 order_detail_response = input，列表请求恒答
 * 只含 input 一行的 order_list（last_order_id 为空，单页结束）。serviceFeeBp 读取恒给 `serviceFeeBp`。
 */
export function pddAdapter(
  input: Record<string, unknown>,
  serviceFeeBp: unknown = null,
): PddUnionAdapter {
  return new PddUnionAdapter({
    clock: new FixedClock(ADAPTER_NOW),
    credentials: async () => ({ clientId: 'synthetic-b2-19', clientSecret: 'fake-pass!' }),
    transport: async (request): Promise<UnionTransportResponse> => {
      const sent: unknown = JSON.parse(request.body ?? '{}');
      const method = typeof sent === 'object' && sent !== null ? Reflect.get(sent, 'type') : null;
      const body =
        method === PDD_ORDER_DETAIL
          ? { order_detail_response: input }
          : { order_list_get_response: { order_list: [input], last_order_id: '' } };
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    },
    endpoint: ENDPOINT,
    serviceFeeBp: async () => serviceFeeBp,
  });
}

/** 列表入口（rowErrors = collect）取回的一页。 */
export function listedByAdapter(
  input: Record<string, unknown>,
  queryMode: 'increment' | 'pay_time',
  serviceFeeBp: unknown = null,
): Promise<OrderPage> {
  return pddAdapter(input, serviceFeeBp).listOrders(LIST_WINDOW, { queryMode }, COLLECT_CTX);
}

/** 按单号详情入口取回的一单。 */
export function detailByAdapter(
  input: Record<string, unknown>,
  serviceFeeBp: unknown = null,
): Promise<UnionOrder> {
  return pddAdapter(input, serviceFeeBp).getPddOrderDetail(String(input.order_sn), COLLECT_CTX);
}

/** Date → 拼多多报文的秒级时间戳。 */
export function seconds(instant: Date): number {
  return instant.getTime() / 1000;
}

/** 一条合成的拼多多订单报文；默认已支付（0），毛额 1000、服务费 100。 */
export function pddRow(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_sn: 'SYN-PDD-B219-5c0a7e',
    order_id: 'SYN-PO-B219-91d2',
    p_id: 'syn-slot-b219',
    pid: 'syn-slot-b219',
    goods_id: 8123456789013,
    goods_sign: 'syn-goods-b219',
    custom_parameters: JSON.stringify({ app: 'n', uid: 'synuidb219' }),
    goods_price: 52_800,
    order_amount: 52_800,
    promotion_amount: PROMOTION_AMOUNT,
    duo_id_service_fee: SERVICE_FEE,
    order_status: PDD_PAID_STATUS,
    order_status_desc: '合成',
    order_pay_time: 1_792_000_000,
    order_modify_at: 1_792_000_060,
    ...patch,
  };
}

/**
 * 订单同步用的报文补丁：把一条拼多多报文经生产映射 mapPddOrder（increment）得到的状态、时刻与金额，
 * 叠到 ../../settlement/settlement-records/kit.ts 那张单的归因与推广位上（单号、归因串、推广位、付款时刻
 * 仍取那份夹具的，以免和 app 对不上）。结算佣金只来自映射，测试不自己填。
 */
export function mappedReport(
  row: Record<string, unknown>,
  page: PddOrderPage = PAGE,
): Partial<UnionOrder> {
  const dto = mapPddOrder(row, 'increment', page);
  return {
    raw_status: dto.raw_status,
    received_at: dto.received_at,
    settled_at: dto.settled_at,
    modified_at: dto.modified_at,
    commission_fen: dto.commission_fen,
    est_commission_fen: dto.est_commission_fen,
    service_fee_fen: dto.service_fee_fen ?? null,
    settle_commission_fen: dto.settle_commission_fen,
  };
}
