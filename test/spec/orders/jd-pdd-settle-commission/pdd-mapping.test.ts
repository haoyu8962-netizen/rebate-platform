// B2-19 · 拼多多适配器映射（BR-FUND-02 细则「京东、拼多多已结算时的结算佣金」第 2 点；BR-CALC-03「报文直接给出
// 服务费金额时」；D10-2408 ①、D10-2532、D10-2538）。直接调生产映射 mapPddOrder，金额按 bigint 分比较。
// - order_status 5：settle_commission_fen 与同一行 est_commission_fen 同一取法（promotion_amount − duo_id_service_fee；
//   报文没给服务费时按 union.pdd.service_fee_bp 兜底 ceil）；
// - 2、3 仍只写预估（E-24）；
// - 服务费算不出（报文没有、配置没有或不合法）→ null，绝不按 0（写成 0 会被月结当成零结算拦下）。
// 主干上本就成立的断言（2、3 为 null；算不出为 null）与先红的断言放在同一个 it 里（D10-2538）。报文合成。
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { mapPddOrder } from '../../../../apps/api/src/modules/union/infra/pdd/orders.ts';
import {
  FEE_BP_1000,
  FEE_BP_INVALID,
  NET_FEN,
  PAGE,
  PDD_APPROVED_STATUS,
  PDD_RECEIVED_STATUS,
  PDD_SETTLED_STATUS,
  pageWithFeeBp,
  pddRow,
} from './kit.ts';

it('[AC-B2-19#1] 拼多多状态 5：settle_commission_fen = promotion_amount − duo_id_service_fee（1000 − 100 = 900），与 est 同值；状态 2、3 的 settle 仍为 null、est 照写', () => {
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

it('[AC-B2-19#3] 拼多多状态 5 报文没给服务费：按 union.pdd.service_fee_bp 兜底，与 est 同一取法（1605、1000 bp → 服务费 ceil(160.5)=161 → 1444）；没有配置或配置不合法时 settle 为 null、不是 0', () => {
  for (const missing of [{ duo_id_service_fee: undefined }, { duo_id_service_fee: null }]) {
    const row = pddRow({ ...missing, promotion_amount: 1605, order_status: PDD_SETTLED_STATUS });
    const configured = mapPddOrder(row, 'increment', pageWithFeeBp(FEE_BP_1000));
    expect(configured).toMatchObject({
      service_fee_fen: 161n,
      est_commission_fen: 1444n,
      settle_commission_fen: 1444n,
    });
    for (const page of [PAGE, pageWithFeeBp(null), pageWithFeeBp(FEE_BP_INVALID)]) {
      const dto = mapPddOrder(row, 'increment', page);
      expect(dto.est_commission_fen).toBeNull();
      expect(dto.settle_commission_fen).toBeNull();
    }
  }
});
