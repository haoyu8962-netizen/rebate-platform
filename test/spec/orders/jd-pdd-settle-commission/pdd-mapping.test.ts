// B2-19 · 拼多多适配器映射（BR-FUND-02 细则「京东、拼多多已结算时的结算佣金」第 2 点；BR-CALC-03「报文直接给出
// 服务费金额时」；D10-2408 ①、D10-2532、D10-2538）。直接调生产映射 mapPddOrder，金额按 bigint 分比较；
// 另经合成传输走生产适配器的列表（increment、pay_time，rowErrors = collect）与按单号详情两个入口。
// - order_status 5：settle_commission_fen 与同一行 est_commission_fen 同一取法（promotion_amount − duo_id_service_fee；
//   报文没给服务费时按 union.pdd.service_fee_bp 兜底 ceil；报文给了金额就按金额，不看配置）；
// - 2、3 仍只写预估（E-24）；0、1（已支付、已成团）与带正佣金的 4、10（失效类）也不写结算佣金；
// - 服务费算不出（报文没有、配置没有或不合法）→ null，绝不按 0（写成 0 会被月结当成零结算拦下）。
// 主干上本就成立的断言（非 5 为 null；算不出为 null）与先红的断言放在同一个 it 里（D10-2538）。报文合成。
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import {
  mapPddOrder,
  type PddOrderSource,
} from '../../../../apps/api/src/modules/union/infra/pdd/orders.ts';
import {
  detailByAdapter,
  FEE_BP_1000,
  FEE_BP_600,
  FEE_BP_INVALID,
  listedByAdapter,
  NET_FEN,
  PAGE,
  PDD_APPROVED_STATUS,
  PDD_GROUPED_STATUS,
  PDD_PAID_STATUS,
  PDD_PUNISHED_STATUS,
  PDD_RECEIVED_STATUS,
  PDD_REJECTED_STATUS,
  PDD_SETTLED_STATUS,
  pageWithFeeBp,
  pddRow,
} from './kit.ts';

/** 映射的三个入口：列表 increment、列表 range、按单号详情。 */
const SOURCES: readonly PddOrderSource[] = ['increment', 'range', 'detail'];

it('[AC-B2-19#1] 拼多多状态 5：settle_commission_fen = promotion_amount − duo_id_service_fee（1000 − 100 = 900），与 est 同值；状态 2、3 的 settle 仍为 null、est 照写；0、1 与带正佣金的 4、10 的 settle 也为 null', () => {
  for (const source of ['increment', 'range'] as const) {
    const settled = mapPddOrder(pddRow({ order_status: PDD_SETTLED_STATUS }), source, PAGE);
    expect(settled, `${source} 5`).toMatchObject({
      raw_status: '5',
      commission_fen: 1000n,
      service_fee_fen: 100n,
      est_commission_fen: NET_FEN,
      settle_commission_fen: NET_FEN,
    });
  }
  for (const status of [PDD_RECEIVED_STATUS, PDD_APPROVED_STATUS]) {
    for (const source of ['increment', 'range'] as const) {
      const dto = mapPddOrder(pddRow({ order_status: status }), source, PAGE);
      expect(dto, `${source} ${String(status)}`).toMatchObject({
        raw_status: String(status),
        est_commission_fen: NET_FEN,
        settle_commission_fen: null,
      });
    }
  }
  // 防「order_status >= 4 就写结算额」与「有佣金就写结算额」：毛额 1000 > 0 的 0、1、4、10 一律不写。
  const others = [PDD_PAID_STATUS, PDD_GROUPED_STATUS, PDD_REJECTED_STATUS, PDD_PUNISHED_STATUS];
  for (const status of others) {
    for (const source of ['increment', 'range'] as const) {
      const dto = mapPddOrder(pddRow({ order_status: status }), source, PAGE);
      expect(dto, `${source} ${String(status)}`).toMatchObject({
        raw_status: String(status),
        commission_fen: 1000n,
        settle_commission_fen: null,
      });
    }
  }
});

it('[AC-B2-19#2] 拼多多状态 5、任意毛额与服务费：settle 恰为 promotion_amount − duo_id_service_fee（bigint，可为负），与 est 相等；同额状态 3 的 settle 为 null', () => {
  const fen = fc.integer({ min: 0, max: 2 ** 40 });
  const source = fc.constantFrom('increment' as const, 'range' as const);
  expect(() =>
    fc.assert(
      fc.property(fen, fen, source, (promotion, fee, from) => {
        const amounts = { promotion_amount: promotion, duo_id_service_fee: fee };
        const settled = mapPddOrder(
          pddRow({ ...amounts, order_status: PDD_SETTLED_STATUS }),
          from,
          PAGE,
        );
        const approved = mapPddOrder(
          pddRow({ ...amounts, order_status: PDD_APPROVED_STATUS }),
          from,
          PAGE,
        );
        const net = BigInt(promotion) - BigInt(fee);
        return (
          settled.settle_commission_fen === net &&
          settled.est_commission_fen === net &&
          approved.settle_commission_fen === null &&
          approved.est_commission_fen === net
        );
      }),
      propParams(),
    ),
  ).not.toThrow();
}, 900_000);

it('[AC-B2-19#3] 拼多多状态 5 报文没给服务费：increment、range、详情三个入口都按 union.pdd.service_fee_bp 兜底，与 est 同一取法（1001、600 bp → 服务费 ceil(60.06)=61 → 940；1605、1000 bp → 161 → 1444）；显式给 100 → 901（报文金额优先，不看配置）；没有配置或配置不合法时 settle 为 null、不是 0', () => {
  for (const source of SOURCES) {
    for (const missing of [{ duo_id_service_fee: undefined }, { duo_id_service_fee: null }]) {
      const small = pddRow({
        ...missing,
        promotion_amount: 1001,
        order_status: PDD_SETTLED_STATUS,
      });
      const carried = mapPddOrder(small, source, pageWithFeeBp(FEE_BP_600));
      expect(carried, `${source} 1001`).toMatchObject({
        commission_fen: 1001n,
        service_fee_fen: 61n,
        est_commission_fen: 940n,
        settle_commission_fen: 940n,
      });

      const row = pddRow({ ...missing, promotion_amount: 1605, order_status: PDD_SETTLED_STATUS });
      const configured = mapPddOrder(row, source, pageWithFeeBp(FEE_BP_1000));
      expect(configured, `${source} 1605`).toMatchObject({
        service_fee_fen: 161n,
        est_commission_fen: 1444n,
        settle_commission_fen: 1444n,
      });
      for (const page of [PAGE, pageWithFeeBp(null), pageWithFeeBp(FEE_BP_INVALID)]) {
        const dto = mapPddOrder(row, source, page);
        expect(dto.est_commission_fen, source).toBeNull();
        expect(dto.settle_commission_fen, source).toBeNull();
      }
    }

    const explicit = pddRow({
      promotion_amount: 1001,
      duo_id_service_fee: 100,
      order_status: PDD_SETTLED_STATUS,
    });
    const given = mapPddOrder(explicit, source, pageWithFeeBp(FEE_BP_600));
    expect(given, `${source} 显式 100`).toMatchObject({
      commission_fen: 1001n,
      service_fee_fen: 100n,
      est_commission_fen: 901n,
      settle_commission_fen: 901n,
    });
  }
});

/** 列表入口（rowErrors = collect）取回的唯一一单；没有被拒的行。 */
async function listedOne(
  input: Record<string, unknown>,
  queryMode: 'increment' | 'pay_time',
  serviceFeeBp: unknown,
): Promise<UnionOrder> {
  const page = await listedByAdapter(input, queryMode, serviceFeeBp);
  expect(page.rejected ?? [], `${queryMode} rejected`).toEqual([]);
  expect(page.items, `${queryMode} items`).toHaveLength(1);
  return page.items[0]!;
}

it('[AC-B2-19#3] 真实同步入口：合成传输经生产适配器的列表 listOrders（increment、pay_time，rowErrors=collect）与按单号详情 getPddOrderDetail，状态 5 的结算值与 est 同一取法：没给服务费按配置 600 bp → 940，显式 100 → 901；同一报文状态 3 的 settle 为 null', async () => {
  const cases = [
    { label: '没给服务费', patch: { duo_id_service_fee: undefined }, net: 940n },
    { label: '显式 100', patch: { duo_id_service_fee: 100 }, net: 901n },
  ] as const;
  for (const { label, patch, net } of cases) {
    const amounts = { ...patch, promotion_amount: 1001 };
    const settled = pddRow({ ...amounts, order_status: PDD_SETTLED_STATUS });
    const approved = pddRow({ ...amounts, order_status: PDD_APPROVED_STATUS });
    for (const queryMode of ['increment', 'pay_time'] as const) {
      const after = await listedOne(settled, queryMode, FEE_BP_600);
      expect(after, `${label} ${queryMode} 5`).toMatchObject({
        raw_status: '5',
        commission_fen: 1001n,
        est_commission_fen: net,
        settle_commission_fen: net,
      });
      const before = await listedOne(approved, queryMode, FEE_BP_600);
      expect(before, `${label} ${queryMode} 3`).toMatchObject({
        raw_status: '3',
        est_commission_fen: net,
        settle_commission_fen: null,
      });
    }
    const detailSettled = await detailByAdapter(settled, FEE_BP_600);
    expect(detailSettled, `${label} detail 5`).toMatchObject({
      raw_status: '5',
      commission_fen: 1001n,
      est_commission_fen: net,
      settle_commission_fen: net,
    });
    const detailApproved = await detailByAdapter(approved, FEE_BP_600);
    expect(detailApproved, `${label} detail 3`).toMatchObject({
      raw_status: '3',
      est_commission_fen: net,
      settle_commission_fen: null,
    });
  }
});
