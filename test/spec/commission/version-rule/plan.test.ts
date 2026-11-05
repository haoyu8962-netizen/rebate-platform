// B2-03s · 列计划（BR-CALC-02、BR-CALC-15，D10-578）：planOrderSyncColumns 比前后有效 N（settle ?? est），变了才
// commission_version +1，保持纯函数。期望值手写；属性的 oracle 按规则写，不调被测函数。属性体返回布尔，
// 汇总断言在 fc.assert 之外（规划/11 §4.3）；次数与种子只来自 @couli/testing。
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { planOrderSyncColumns } from '../../../../apps/api/src/modules/orders/index.ts';
import type {
  OrderSyncColumns,
  OrderUpdatePlan,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { at, ATTR, order, RECEIVED, SETTLED } from '../../orders/attribution/kit.ts';

type Fen = bigint | null;
type Status = 'PAID' | 'RECEIVED' | 'SETTLED';

const VERSION = 7;

const BASE: OrderSyncColumns = {
  pay_amount_fen: 10000n,
  est_commission_fen: 1000n,
  commission_version: VERSION,
  settle_commission_fen: null,
  received_at: at(RECEIVED),
  platform_received_at: null,
  deposit_paid_at: null,
  paid_at: at(ATTR),
  settled_at: at(SETTLED),
  platform_modified_at: at('2026-10-17T05:06:07Z'),
  parent_order_id: 'old-parent',
  raw_item_id: 'old-item',
  content_hash: 'old-hash',
  raw_payload_id: 101n,
};

const PLAN: OrderUpdatePlan = {
  kind: 'update',
  platform_status: 'PAID',
  received_at: at(RECEIVED),
  history: [],
  pending: null,
  rule: 'P15',
};

function planned(
  est: Fen,
  settle: Fen,
  status: Status,
  reportedEst: Fen,
  reportedSettle: Fen,
  statement: Fen,
) {
  const next = planOrderSyncColumns(
    { ...BASE, est_commission_fen: est, settle_commission_fen: settle },
    order({ est_commission_fen: reportedEst, settle_commission_fen: reportedSettle }),
    { ...PLAN, platform_status: status },
    statement,
  );
  return {
    est: next.est_commission_fen,
    settle: next.settle_commission_fen,
    version: next.commission_version,
  };
}

/** 场景；库内 est、settle；迁移后状态；报文 est、settle；最新 STATEMENT → 写入 est、settle、版本。 */
type Row = readonly [string, Fen, Fen, Status, Fen, Fen, Fen, Fen, Fen, number];

const TABLE: readonly Row[] = [
  ['未结算，est 变', 1000n, null, 'PAID', 1200n, null, null, 1200n, null, 8],
  ['未结算，est 不变', 1000n, null, 'PAID', 1000n, null, null, 1000n, null, 7],
  ['未结算，缺预估（拼多多缺费）', 1000n, null, 'PAID', null, null, null, 1000n, null, 7],
  ['① 结算后只来新预估', 1000n, 800n, 'SETTLED', 1500n, null, null, 1500n, 800n, 7],
  ['① 结算后新预估，结算额同值重报', 1000n, 800n, 'SETTLED', 1500n, 800n, null, 1500n, 800n, 7],
  ['② 到达，settle ≠ est', 1000n, null, 'SETTLED', 1000n, 800n, null, 1000n, 800n, 8],
  ['② 到达，settle = est', 1000n, null, 'SETTLED', 1000n, 1000n, null, 1000n, 1000n, 7],
  ['② 到达，settle = 旧 est，est 变', 1000n, null, 'SETTLED', 1200n, 1000n, null, 1200n, 1000n, 7],
  ['② 到达，est 同变，只 +1', 1000n, null, 'SETTLED', 1200n, 900n, null, 1200n, 900n, 8],
  ['② 到达，settle = 0 是已知值', 1000n, null, 'SETTLED', 1000n, 0n, null, 1000n, 0n, 8],
  ['② 到达，负结算', 1000n, null, 'SETTLED', 1000n, -100n, null, 1000n, -100n, 8],
  ['② 到达，库内 est 为空', null, null, 'SETTLED', null, 800n, null, null, 800n, 8],
  ['② 结算变化', 1000n, 800n, 'SETTLED', 1000n, 700n, null, 1000n, 700n, 8],
  ['② 结算同值重报', 1000n, 800n, 'SETTLED', 1000n, 800n, null, 1000n, 800n, 7],
  ['结算额未算数（未到 SETTLED）', 1000n, null, 'RECEIVED', 1000n, 800n, null, 1000n, null, 7],
  ['STATEMENT 把列改掉', 1000n, 1000n, 'SETTLED', 1000n, 800n, 900n, 1000n, 900n, 8],
  ['STATEMENT 已在列上，API 不覆盖', 1000n, 900n, 'SETTLED', 1000n, 800n, 900n, 1000n, 900n, 7],
];

it('[AC-B2-03s#1][BR-CALC-15][BR-CALC-02] 列计划：有效 N 变了才 +1，只 +1 一次，est 照常存档，缺预估不覆盖', () => {
  const actual = TABLE.map((row) => ({
    name: row[0],
    ...planned(row[1], row[2], row[3], row[4], row[5], row[6]),
  }));
  const expected = TABLE.map((row) => ({
    name: row[0],
    est: row[7],
    settle: row[8],
    version: row[9],
  }));
  expect(actual).toEqual(expected);
});

const fen = fc.oneof(
  fc.constantFrom(-100n, 0n, 1n, 800n, 1000n),
  fc.bigInt({ min: -1000n, max: 2n ** 40n }),
);

const scenario = fc.record({
  est: fc.option(fen, { nil: null }),
  settle: fc.option(fen, { nil: null }),
  status: fc.constantFrom<Status>('PAID', 'RECEIVED', 'SETTLED'),
  reportedEst: fc.option(fen, { nil: null }),
  reportedSettle: fc.option(fen, { nil: null }),
  statement: fc.option(fen, { nil: null }),
});

it('[AC-B2-03s#2][BR-CALC-15][BR-CALC-02] 属性：版本前进当且仅当 settle ?? est 前后不同，est 与 settle 列按 BR-FUND-07、09 取值', () => {
  expect(() =>
    fc.assert(
      fc.property(scenario, (s) => {
        const reported = s.status === 'SETTLED' ? s.reportedSettle : null;
        const estAfter = s.reportedEst ?? s.est;
        const settleAfter = s.statement ?? reported ?? s.settle;
        const moved = (s.settle ?? s.est) !== (settleAfter ?? estAfter);
        const next = planned(
          s.est,
          s.settle,
          s.status,
          s.reportedEst,
          s.reportedSettle,
          s.statement,
        );
        return (
          next.est === estAfter &&
          next.settle === settleAfter &&
          next.version === (moved ? VERSION + 1 : VERSION)
        );
      }),
      propParams(),
    ),
  ).not.toThrow();
});

it('[AC-B2-03s#3][BR-CALC-15] 纯函数：同样的入参两次结果相同，入参不被改动，版本 +1 只在返回值里', () => {
  const current: OrderSyncColumns = { ...BASE };
  // 结算首次到达、settle ≠ est，预估不变：只有比有效 N 才 +1，比预估得 7。
  const incoming = order({ est_commission_fen: 1000n, settle_commission_fen: 800n });
  const plan: OrderUpdatePlan = { ...PLAN, platform_status: 'SETTLED' };
  const before = structuredClone({ current, incoming, plan });

  const first = planOrderSyncColumns(current, incoming, plan);
  const second = planOrderSyncColumns(current, incoming, plan);

  expect(first).toMatchObject({ commission_version: 8, settle_commission_fen: 800n });
  expect(second).toEqual(first);
  expect({ current, incoming, plan }).toEqual(before);
});
