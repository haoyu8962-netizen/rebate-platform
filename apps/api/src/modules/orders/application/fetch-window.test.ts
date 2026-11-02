import { expect, it, vi } from 'vitest';
import {
  UnionError,
  type CallCtx,
  type RejectedOrderRow,
  type UnionAdapter,
  type UnionOrder,
} from '../../union/index.ts';
import { fetchWindow } from './fetch-window.ts';
import { ORDER_ROW_WHOLE_PAGE_MIN } from './row-quarantine.ts';

const FROM = '2026-10-17T00:00:00.000Z';
const MID = '2026-10-17T00:30:00.000Z';
const TO = '2026-10-17T01:00:00.000Z';
const call: CallCtx = { appId: 'unit', requestId: 'unit-request', purpose: 'order_sync' };

const refusal = (): UnionError =>
  new UnionError('upstream_rejected', 'synthetic refusal', 'jd', { windowTooLarge: true });

function order(id: string): UnionOrder {
  return {
    platform: 'jd',
    order_id: id,
    sub_order_id: id,
    paid_fen: 1000n,
    commission_fen: 100n,
    raw_payload_id: null,
  };
}

function setup() {
  const listOrders = vi.fn<UnionAdapter['listOrders']>();
  const pages: string[][] = [];
  const quarantined: string[][] = [];
  const query = {
    adapter: { listOrders },
    call,
    onPage: async (orders: readonly UnionOrder[]) => {
      pages.push(orders.map((item) => item.order_id));
    },
    onRejected: async (rows: readonly RejectedOrderRow[]) => {
      quarantined.push(rows.map((row) => row.row_key));
    },
  };
  return { listOrders, pages, quarantined, query };
}

it('[AC-B1-04zt#u1] 没被拒：逐页取完，只查原窗', async () => {
  const { listOrders, pages, query } = setup();
  listOrders
    .mockResolvedValueOnce({ items: [order('a')], nextCursor: 'next' })
    .mockResolvedValueOnce({ items: [order('b')], nextCursor: null });
  await fetchWindow({ from: FROM, to: TO }, query);
  expect(pages).toEqual([['a'], ['b']]);
  expect(listOrders.mock.calls.map(([, opt]) => opt)).toEqual([
    { queryMode: 'increment' },
    { cursor: 'next', queryMode: 'increment' },
  ]);
});

it('[AC-B1-04zt#u2] 第 2 页被拒：已交出的页留着，两半各从第 1 页重查，边界共用中点', async () => {
  const { listOrders, pages, query } = setup();
  listOrders
    .mockResolvedValueOnce({ items: [order('a')], nextCursor: 'next' })
    .mockRejectedValueOnce(refusal())
    .mockResolvedValueOnce({ items: [order('b')], nextCursor: null })
    .mockResolvedValueOnce({ items: [order('c')], nextCursor: null });
  await fetchWindow({ from: FROM, to: TO }, query);
  expect(pages).toEqual([['a'], ['b'], ['c']]);
  expect(listOrders.mock.calls.slice(2).map(([range, opt]) => [range, opt])).toEqual([
    [{ from: FROM, to: MID }, { queryMode: 'increment' }],
    [{ from: MID, to: TO }, { queryMode: 'increment' }],
  ]);
});

it('[AC-B1-04zt#u3] 跨度到下限还被拒：抛原错误，不再切', async () => {
  const { listOrders, query } = setup();
  const error = refusal();
  listOrders.mockRejectedValue(error);
  const range = { from: FROM, to: '2026-10-17T00:01:00.000Z' };
  await expect(fetchWindow(range, query)).rejects.toBe(error);
  expect(listOrders).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04zt#u4] 不带标记的错误：不切，原样抛出', async () => {
  const { listOrders, query } = setup();
  const error = new UnionError('upstream_rejected', 'synthetic refusal', 'jd');
  listOrders.mockRejectedValue(error);
  await expect(fetchWindow({ from: FROM, to: TO }, query)).rejects.toBe(error);
  expect(listOrders).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04zt#u5] 同一窗内游标重复：报错，不死循环', async () => {
  const { listOrders, query } = setup();
  listOrders.mockResolvedValue({ items: [], nextCursor: 'same' });
  await expect(fetchWindow({ from: FROM, to: TO }, query)).rejects.toThrow(
    'order_sync_cursor_repeated',
  );
  expect(listOrders).toHaveBeenCalledTimes(2);
});

function refused(key: string): RejectedOrderRow {
  return {
    sub_order_id: key,
    raw_status: null,
    raw_payload_id: null,
    detail: 'synthetic',
    row_key: key,
  };
}

const refusedRows = (count: number): RejectedOrderRow[] =>
  Array.from({ length: count }, (_, index) => refused(`bad-${index}`));

it('[AC-B1-04zv#u1] 每页带 rowErrors collect，好行先交，坏行随后交给 onRejected', async () => {
  const { listOrders, pages, quarantined, query } = setup();
  listOrders.mockResolvedValueOnce({
    items: [order('a')],
    nextCursor: null,
    rejected: [refused('bad')],
  });
  await fetchWindow({ from: FROM, to: TO }, query);
  expect(listOrders.mock.calls[0]?.[2]).toEqual({ ...call, rowErrors: 'collect' });
  expect(pages).toEqual([['a']]);
  expect(quarantined).toEqual([['bad']]);
});

it('[AC-B1-04zv#u2] 没有坏行的页不调 onRejected', async () => {
  const { listOrders, quarantined, query } = setup();
  listOrders.mockResolvedValueOnce({ items: [order('a')], nextCursor: null, rejected: [] });
  await fetchWindow({ from: FROM, to: TO }, query);
  expect(quarantined).toEqual([]);
});

it('[AC-B1-04zv#u3] 一页没有好行且坏行达到门槛：坏行照写，窗口失败，后面的页不取', async () => {
  const { listOrders, quarantined, query } = setup();
  const rejected = refusedRows(ORDER_ROW_WHOLE_PAGE_MIN);
  listOrders.mockResolvedValueOnce({ items: [], nextCursor: 'next', rejected });
  await expect(fetchWindow({ from: FROM, to: TO }, query)).rejects.toThrow(
    'order_sync_page_all_invalid',
  );
  expect(quarantined).toHaveLength(1);
  expect(listOrders).toHaveBeenCalledTimes(1);
});

it.each([
  { label: '没到门槛', items: [] as UnionOrder[], count: ORDER_ROW_WHOLE_PAGE_MIN - 1 },
  { label: '有一条好行', items: [order('a')], count: ORDER_ROW_WHOLE_PAGE_MIN },
])('[AC-B1-04zv#u4] $label：窗口照常结束', async ({ items, count }) => {
  const { listOrders, quarantined, query } = setup();
  listOrders.mockResolvedValueOnce({ items, nextCursor: null, rejected: refusedRows(count) });
  await fetchWindow({ from: FROM, to: TO }, query);
  expect(quarantined).toHaveLength(1);
});
