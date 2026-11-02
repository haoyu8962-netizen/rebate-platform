// B1-09q rule-test kit. Agent 的三条路（list_my_orders、explain_order 按单号、explain_order 按卡片）
// 接真实库与真实 OrderQueries（行与读取器取自 ../../orders/figures/kit.ts），工具走真实 handler 与
// ToolRegistry（../tools-orders/kit.ts），替身只有 card_id → order_id 的解析。时刻只来自注入的
// Clock（f.clock）；每次读都重新装配，等于一次新请求。期望值都在规则测试里写死。
// 集成测试把 createTestDatabase 传进来：本文件不 import @couli/db/testing。
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  PAID_MONTH,
  fixture,
  type FixtureOptions,
  type SeededOrder,
} from '../../orders/figures/kit.ts';
import { EXPLAIN, LIST, context, okCards, orderCards, setup } from '../tools-orders/kit.ts';

/** 默认预计月份 2027-12：账单日 24 + 宽限 10 = 2028-01-03（+08:00）的最后一刻，未逾期。 */
export const DEADLINE_LAST_MS = '2028-01-03T15:59:59.999Z';
/** 下一刻是 2028-01-04（+08:00）：逾期。 */
export const DEADLINE_NEXT_DAY = '2028-01-03T16:00:00.000Z';

type CardData = Readonly<Record<string, unknown>>;
type Rig = Awaited<ReturnType<typeof rig>>;

function single(entries: readonly CardData[], o: SeededOrder): CardData | undefined {
  const mine = entries.filter((entry) => entry['order_id'] === o.orderId);
  expect(mine).toHaveLength(1);
  return mine[0];
}

/** 一个新 App 的订单夹具，加三条路的读取：`days` 是 list_my_orders 的付款日范围。 */
export async function rig(db: Kysely<DB>, options: FixtureOptions = {}, days = PAID_MONTH) {
  const f = await fixture(db, options);
  const ctx = context({ appId: f.subject.app_id, userId: f.subject.user_id });

  /** 一次工具调用出的全部 order_status 卡片数据；卡片过 agent-stream 契约校验（okCards）。 */
  async function cards(name: string, args: CardData): Promise<readonly CardData[]> {
    const tools = setup({
      orders: await f.queries(),
      clock: f.clock,
      refs: { resolve: async (cardId) => ({ kind: 'order', orderId: cardId }) },
    });
    return orderCards(okCards(await tools.execute(name, args, ctx))).map((card) => card.data);
  }

  const list = () => cards(LIST, days);
  const number = (orderNo: string) => cards(EXPLAIN, { order_no: orderNo });

  return {
    f,
    list,
    number,
    onList: async (o: SeededOrder) => single(await list(), o),
    onNumber: async (o: SeededOrder) => single(await number(o.subOrderId), o),
    onCard: async (o: SeededOrder) => single(await cards(EXPLAIN, { card_id: o.orderId }), o),
  };
}

/** 三条路，给规则测试的 it.each 用。 */
export const PATHS = [
  { path: 'list_my_orders', read: (r: Rig, o: SeededOrder) => r.onList(o) },
  { path: 'explain_order 按单号', read: (r: Rig, o: SeededOrder) => r.onNumber(o) },
  { path: 'explain_order 按卡片', read: (r: Rig, o: SeededOrder) => r.onCard(o) },
];

/** card_order_status 的 8 个字段：默认本人自购、N=1000、自购 50 %，`shown` 写该用例的取值。 */
export function card(o: SeededOrder, shown: CardData) {
  return {
    order_id: o.orderId,
    platform: o.platform,
    title: 'Synthetic item',
    is_other_product: false,
    reason: null,
    est_rebate_fen: 425,
    ...shown,
  };
}

export function byOrder(entries: readonly CardData[]) {
  return new Map(entries.map((entry) => [entry['order_id'], entry]));
}
