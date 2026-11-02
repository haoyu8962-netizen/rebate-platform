// B1-04zw（BR-CALC-26 负数原样保留，BR-CALC-02 联盟 N 为负时 raw_n_fen 记原值、B=0；D10-522、D10-572）：
// 淘宝订单经真实适配器 + 假传输，两种开关（不开 / CallCtx.rowErrors collect）都跑。报文全部合成。
import { expect } from 'vitest';
import type { CallCtx, UnionOrder } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { rejectedOf, resolved, TAOBAO } from '../row-quarantine/wires.ts';
import { num, onePage, rowOf, setup } from '../taobao-orders/kit.ts';

export const PLAIN: CallCtx = TAOBAO.ctx;
export const COLLECT: CallCtx = TAOBAO.collect;

export const MODES: readonly { readonly mode: string; readonly call: CallCtx }[] = [
  { mode: '不开 collect', call: PLAIN },
  { mode: 'collect', call: COLLECT },
];

/** Every case in both modes, for `it.each`. */
export function inBothModes<T extends object>(cases: readonly T[]) {
  return MODES.flatMap((mode) => cases.map((item) => ({ ...mode, ...item })));
}

/** 负数原文与它的数学 floor 分值（同 yuanStrToFen，与京东 B1-04zb 同一套）。 */
export const NEGATIVE = [
  ['-0.01', -1n],
  ['-0.001', -1n],
  ['-1.00', -100n],
  ['-3.20', -320n],
  ['-3.205', -321n],
  ['-12.3', -1230n],
  ['-12.305', -1231n],
  ['-90071992547409.93', -9007199254740993n],
] as const;

/** The same amount as a yuan string and as a JSON number literal. */
export function forms(text: string): readonly unknown[] {
  return [text, num(text)];
}

/** 新用例里仍然非法的写法：负号不是放行的理由，空串也不是 0。 */
export const ILLEGAL: readonly { readonly label: string; readonly value: unknown }[] = [
  { label: '空串', value: '' },
  { label: '「+1.00」', value: '+1.00' },
  { label: '「-abc」', value: '-abc' },
  { label: '「-」', value: '-' },
  { label: '「1e2」', value: '1e2' },
  { label: '「-1e2」', value: '-1e2' },
  { label: 'JSON number -1e2', value: num('-1e2') },
  { label: '「--1.00」', value: '--1.00' },
  { label: '「-+1.00」', value: '-+1.00' },
];

/**
 * A settled row whose negative pub_share_fee must be kept. Behaviour that does not change holds
 * before the implementation too, so those cases start by checking this row on the same page: they
 * are red until negatives are kept, and only then say that the rest stayed as it was (same reasoning
 * as expectCollecting in row-quarantine/wires.ts).
 */
export function control(): Record<string, unknown> {
  return { ...rowOf(900), pub_share_fee: '-1.00' };
}

/** One upstream page through the real adapter: rows that came out, rows refused, warnings. */
export async function throughAdapter(rows: readonly unknown[], call: CallCtx) {
  const s = setup(onePage(rows));
  const page = await resolved(() => s.adapter.listOrders(TAOBAO.win, {}, call));
  return {
    items: page.items,
    rejected: rejectedOf(page),
    warned: s.orderWarn.mock.calls.map(([warning]) => warning),
  };
}

/** The order made from `row`; its absence fails the test as an assertion. */
export function orderOf(
  items: readonly UnionOrder[],
  row: Readonly<Record<string, unknown>>,
): UnionOrder {
  const order = items.find((item) => item.sub_order_id === row.trade_id);
  expect(order, 'the row must come out as an order').toBeDefined();
  return order!;
}
