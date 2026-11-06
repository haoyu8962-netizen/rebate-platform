// B1-04zzc（D10-776 方案 A）：去掉别家行的归档仍是这一页的那条归档行，raw_payload_id 照旧挂回：好行的
// raw_payload_id、collect 下 rejected 行的 raw_payload_id 都是这条归档行的 id；每个上游页恰好一行。
import { expect, it } from 'vitest';
import {
  COLLECT,
  MODES,
  ORDER_PATH,
  OTHER_FOREIGN_ADZONE,
  OUR_ADZONE,
  PLAIN,
  RETIRED_ADZONE,
  answer,
  expectArchivedAs,
  foreign,
  foreignCounts,
  idOf,
  onlyArchiveOf,
  orderBody,
  ours,
  resolvedPage,
  win,
  wire,
} from './kit.ts';

it.each(MODES)(
  '[AC-B1-04zzc#6] $mode：好行的 raw_payload_id 是这一页那条（已去掉别家行的）归档行的 id，每页恰好插入一行',
  async ({ call }) => {
    const id = '8100000000000000777';
    const rows = [ours(1), foreign(50), ours(2, RETIRED_ADZONE)];
    const h = wire(() => answer(orderBody(rows)), { ids: [id] });

    const page = await resolvedPage(() => h.adapter.listOrders(win, {}, call));

    expect(h.database.inserted).toHaveLength(1);
    const row = onlyArchiveOf(h.database, ORDER_PATH);
    expect(row.id).toBe(id);
    expectArchivedAs(row, orderBody([ours(1), ours(2, RETIRED_ADZONE)]));
    expect(page.items.map((order) => [order.order_id, order.raw_payload_id])).toEqual([
      [idOf(1), id],
      [idOf(2), id],
    ]);
  },
);

it('[AC-B1-04zzc#7] collect：rejected 行（读不出推广位、缺 tk_status）的 raw_payload_id 也是这条去掉别家行的归档行的 id', async () => {
  const id = '8100000000000000778';
  const noSlot = ours(2, OUR_ADZONE, { adzone_id: undefined });
  const noStatus = ours(3, OUR_ADZONE, { tk_status: undefined });
  const rows = [ours(1), noSlot, foreign(50), noStatus, foreign(51, OTHER_FOREIGN_ADZONE, true)];
  const h = wire(() => answer(orderBody(rows)), { ids: [id] });

  const page = await resolvedPage(() => h.adapter.listOrders(win, {}, COLLECT));

  expectArchivedAs(onlyArchiveOf(h.database, ORDER_PATH), orderBody([ours(1), noSlot, noStatus]));
  expect(page.items.map((order) => [order.order_id, order.raw_payload_id])).toEqual([
    [idOf(1), id],
  ]);
  const rejected = page.rejected ?? [];
  expect(rejected).toHaveLength(2);
  for (const entry of rejected) expect(entry.raw_payload_id).toBe(id);
});

it('[AC-B1-04zzc#8] 连续两页：每页的订单挂各自那页归档行的 id，两条归档都没有别家行，别家计数每页一条', async () => {
  const first = 'arc-page-1a_SYN|arc-page-1b_SYN';
  const second = 'arc-page-2a_SYN|arc-page-2b_SYN';
  const ids = ['8100000000000000801', '8100000000000000802'];
  const firstBody = orderBody([ours(1), foreign(50)], { hasNext: true, position: first });
  const secondBody = orderBody([foreign(51), foreign(52), ours(2, RETIRED_ADZONE)], {
    position: second,
  });
  const h = wire((call) => answer(call.query['positionIndex'] === first ? secondBody : firstBody), {
    ids,
  });

  const one = await resolvedPage(() => h.adapter.listOrders(win, {}, PLAIN));
  const cursor = one.nextCursor;
  expect(cursor).toBeTypeOf('string');
  const two = await resolvedPage(() => h.adapter.listOrders(win, { cursor: cursor! }, PLAIN));

  expect(h.calls.map((call) => call.query['positionIndex'])).toEqual([undefined, first]);
  expect(h.database.inserted.map((row) => row.id)).toEqual(ids);
  expectArchivedAs(
    h.database.inserted[0]!,
    orderBody([ours(1)], { hasNext: true, position: first }),
  );
  expectArchivedAs(
    h.database.inserted[1]!,
    orderBody([ours(2, RETIRED_ADZONE)], { position: second }),
  );
  expect(one.items.map((order) => [order.order_id, order.raw_payload_id])).toEqual([
    [idOf(1), ids[0]],
  ]);
  expect(two.items.map((order) => [order.order_id, order.raw_payload_id])).toEqual([
    [idOf(2), ids[1]],
  ]);
  expect(two.nextCursor).toBeNull();
  expect(foreignCounts(h)).toEqual([1, 2]);
});
