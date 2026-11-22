// B2-19 规则测试夹具（claude-independent；BR-FUND-02 细则「京东、拼多多已结算时的结算佣金」第 2、3、6 点，
// BR-FUND-09，BR-CALC-03；编排 D10-2408 ①）。补丁 1 后本单只做拼多多：目录名带 jd 是台账 test_paths，
// 京东行为（B2-19a）与京东退货扣回开关（B2-19b）这里一概不断言。
// 拼多多 order_status 5（specs/order-status-map/pdd.csv 映 PLATFORM_SETTLED）时，settle_commission_fen 与同一行
// est_commission_fen 同一取法：promotion_amount − duo_id_service_fee；报文没给服务费时按 union.pdd.service_fee_bp
// 兜底（ceil）；都没有 → null，绝不按 0。2（确认收货）、3（审核成功）仍只写预估（E-24）。
// 报文全部合成（字段名按 pdd.ddk.order.list.increment.get 文档），不是录制。金额都是整数分。
// 本文件不导入 @couli/db/testing：要真库的测试把库传进来。
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import {
  mapPddOrder,
  type PddOrderPage,
} from '../../../../apps/api/src/modules/union/infra/pdd/orders.ts';
import { at } from '../wiring/db-kit.ts';

/** 报文里的拼多多状态码（整数）。 */
export const PDD_PAID_STATUS = 0;
export const PDD_RECEIVED_STATUS = 2;
export const PDD_APPROVED_STATUS = 3;
export const PDD_SETTLED_STATUS = 5;

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
/** 形状不合法的配置（bp 超过 10000）：整份当作没有。 */
export const FEE_BP_INVALID = { '*': { bp: 20_000, source: 'synthetic-b2-19', verified: true } };

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
