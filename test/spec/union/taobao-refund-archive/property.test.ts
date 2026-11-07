// B1-04zzu（D10-796 ② 甲）：任意顺序的凑狸订单 / 别家订单 / 读不出单号的行混合页（至少一行别家），单号是串或
// JSON 整数、同一订单可有几笔维权：维权归档恰好一行，内容等于去掉别家行后的原序列（读不出单号的行都在，顺序与
// 外层字段不变）；查询按 ctx.appId 问一次、只问读得出的单号且去重；listRefunds 的条目与不注入查询时相同。
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { answer, expectArchivedAs, onlyArchiveOf, win, wire } from '../taobao-order-archive/kit.ts';
import { listed, num, refundOf } from '../taobao-refunds/kit.ts';
import {
  PLAIN,
  REFUND_PATH,
  expectAskedOnce,
  ownOrders,
  refundBody,
  refundSuit,
  tradeIdOf,
  wireRefunds,
} from './kit.ts';

const KINDS = [
  'ours',
  'oursNumber',
  'oursAgain',
  'other',
  'otherNumber',
  'missing',
  'nullId',
  'emptyId',
  'text',
  'number',
  'null',
  'array',
] as const;
type Kind = (typeof KINDS)[number];
const OTHER_KINDS: readonly Kind[] = ['other', 'otherNumber'];

/** Our orders are 1..20 (oursAgain repeats order 1); other companies' are 100 + index. */
const OURS: readonly string[] = Array.from({ length: 20 }, (_value, index) => tradeIdOf(index + 1));

/** The row of `kind` at page position `index` (1-based) and the order number it can be read as. */
function build(kind: Kind, index: number): { readonly row: unknown; readonly no: string | null } {
  switch (kind) {
    case 'ours':
      return { row: refundOf(index), no: tradeIdOf(index) };
    case 'oursNumber':
      return {
        row: { ...refundOf(index), tb_trade_id: num(tradeIdOf(index)) },
        no: tradeIdOf(index),
      };
    case 'oursAgain':
      return { row: refundSuit(1, 200 + index), no: tradeIdOf(1) };
    case 'other':
      return { row: refundOf(100 + index), no: tradeIdOf(100 + index) };
    case 'otherNumber':
      return {
        row: { ...refundOf(100 + index), tb_trade_id: num(tradeIdOf(100 + index)) },
        no: tradeIdOf(100 + index),
      };
    case 'missing':
      return { row: { ...refundOf(100 + index), tb_trade_id: undefined }, no: null };
    case 'nullId':
      return { row: { ...refundOf(100 + index), tb_trade_id: null }, no: null };
    case 'emptyId':
      return { row: { ...refundOf(100 + index), tb_trade_id: '' }, no: null };
    case 'text':
      return { row: `synthetic-refund-row-${index}`, no: null };
    case 'number':
      return { row: num(tradeIdOf(100 + index)), no: null };
    case 'null':
      return { row: null, no: null };
    case 'array':
      return { row: [refundOf(100 + index)], no: null };
  }
}

/** Row kinds in page order with one row of another company inserted somewhere. */
const pages = fc
  .record({
    kinds: fc.array(fc.constantFrom(...KINDS), { maxLength: 9 }),
    at: fc.nat(),
    extra: fc.constantFrom(...OTHER_KINDS),
    hasNext: fc.boolean(),
  })
  .map(({ kinds, at, extra, hasNext }) => {
    const all: Kind[] = [...kinds];
    all.splice(at % (kinds.length + 1), 0, extra);
    return { kinds: all, hasNext };
  });

it('[AC-B1-04zzu#11] 任意顺序的凑狸 / 别家 / 读不出单号的行混合页：维权归档恰好一行，等于去掉别家行后的原序列；只问读得出的单号且去重；listRefunds 的条目与不注入查询时相同', async () => {
  await expect(
    fc.assert(
      fc.asyncProperty(pages, async ({ kinds, hasNext }) => {
        const built = kinds.map((kind, index) => build(kind, index + 1));
        const rows = built.map((entry) => entry.row);
        const kept = rows.filter((_row, index) => !OTHER_KINDS.includes(kinds[index]!));
        const options = {
          hasNext,
          position: 'synthetic-refund-prop-position',
          top: { request_id: 'synthetic-refund-prop-request' },
          data: { synthetic_note: '合成属性页' },
        };
        const body = refundBody(rows, options);
        const own = ownOrders(OURS);
        const h = wireRefunds(() => answer(body), { ownOrders: own.reader });
        const plain = wire(() => answer(body));

        const page = await listed(h.adapter.listRefunds(win, PLAIN));
        const before = await listed(plain.adapter.listRefunds(win, PLAIN));

        expect(page.items).toEqual(before.items);
        expect(page.nextCursor).toBe(before.nextCursor);
        expect(h.database.inserted).toHaveLength(1);
        expectArchivedAs(onlyArchiveOf(h.database, REFUND_PATH), refundBody(kept, options));
        expectAskedOnce(
          own.reader,
          built.flatMap((entry) => (entry.no === null ? [] : [entry.no])),
        );
      }),
      propParams(),
    ),
  ).resolves.toBeUndefined();
}, 900_000);
