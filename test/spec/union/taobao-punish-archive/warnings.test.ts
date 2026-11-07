// B1-04zzp（D10-793 ①）：违规归档去掉别家行后，listPunishments 返回的条目与 nextCursor 不变；别家行的计数
// 仍只由推广位过滤发——taobao_punish_foreign_slot 每页恰好一条（count = 别家行数），归档侧不另发 warn /
// error；告警与日志里不带单号、PID。每个上游页恰好一条归档行。报文全部合成。
import { expect, it } from 'vitest';
import {
  PLAIN,
  PUNISH_PATH,
  answer,
  expectArchivedAs,
  onlyArchiveOf,
  visible,
  win,
  wire,
} from '../taobao-order-archive/kit.ts';
import {
  FOREIGN_ADZONE,
  OTHER_FOREIGN_ADZONE,
  OUR_ADZONE,
  RETIRED_ADZONE,
  SLOTS,
  listed,
  punishOf,
} from '../taobao-refunds/kit.ts';
import { foreignText, punishBody, punishForeignCounts, punishIdOf, punishmentIdOf } from './kit.ts';

it('[AC-B1-04zzp#7] taobao_punish_foreign_slot 这一页恰好一条（count 3），归档侧不另发 warn / error；告警与日志里没有单号与 PID；归档已去掉别家行', async () => {
  const rows = [
    punishOf(1),
    punishOf(50, FOREIGN_ADZONE),
    foreignText(51, OTHER_FOREIGN_ADZONE),
    punishOf(2, RETIRED_ADZONE),
    punishOf(52, FOREIGN_ADZONE),
  ];
  const h = wire(() => answer(punishBody(rows)));

  const page = await listed(h.adapter.listPunishments(win, PLAIN));

  expect(page.items.map((item) => item.punishment_id)).toEqual([
    punishmentIdOf(1),
    punishmentIdOf(2),
  ]);
  expect(page.nextCursor).toBeNull();
  expectArchivedAs(
    onlyArchiveOf(h.database, PUNISH_PATH),
    punishBody([punishOf(1), punishOf(2, RETIRED_ADZONE)], { total: rows.length }),
  );
  expect(punishForeignCounts(h)).toEqual([3]);
  expect(h.punishWarn).toHaveBeenCalledTimes(1);
  expect(h.logger.warn).not.toHaveBeenCalled();
  expect(h.logger.error).not.toHaveBeenCalled();
  const logs = visible([
    h.punishWarn.mock.calls,
    h.logger.warn.mock.calls,
    h.logger.error.mock.calls,
  ]);
  for (const index of [1, 2, 50, 51, 52]) expect(logs).not.toContain(punishIdOf(index));
  for (const adzone of [OUR_ADZONE, RETIRED_ADZONE, FOREIGN_ADZONE, OTHER_FOREIGN_ADZONE]) {
    expect(logs).not.toContain(adzone);
  }
  for (const slot of SLOTS) expect(logs).not.toContain(slot);
});

it('[AC-B1-04zzp#8] 连续两页：nextCursor 照常翻到第 2 页再结束，每页恰好一条归档行、都没有别家行（page_no / total_count 各自原样），别家计数每页一条', async () => {
  const ids = ['8100000000000000901', '8100000000000000902'];
  const total = 5;
  const first = [punishOf(1), punishOf(50, FOREIGN_ADZONE)];
  const second = [
    punishOf(51, FOREIGN_ADZONE),
    foreignText(52, OTHER_FOREIGN_ADZONE),
    punishOf(2, RETIRED_ADZONE),
  ];
  const h = wire(
    (call) =>
      answer(
        call.query['pageNo'] === '2'
          ? punishBody(second, { total, pageNo: 2 })
          : punishBody(first, { total, pageNo: 1 }),
      ),
    { ids },
  );

  const one = await listed(h.adapter.listPunishments(win, PLAIN));
  const cursor = one.nextCursor;
  expect(cursor).toBeTypeOf('string');
  const two = await listed(h.adapter.listPunishments(win, PLAIN, { cursor: cursor! }));

  expect(h.calls.map((call) => call.query['pageNo'])).toEqual(['1', '2']);
  expect(one.items.map((item) => item.punishment_id)).toEqual([punishmentIdOf(1)]);
  expect(two.items.map((item) => item.punishment_id)).toEqual([punishmentIdOf(2)]);
  expect(two.nextCursor).toBeNull();
  expect(h.database.inserted.map((row) => row.id)).toEqual(ids);
  expectArchivedAs(h.database.inserted[0]!, punishBody([punishOf(1)], { total, pageNo: 1 }));
  expectArchivedAs(
    h.database.inserted[1]!,
    punishBody([punishOf(2, RETIRED_ADZONE)], { total, pageNo: 2 }),
  );
  expect(punishForeignCounts(h)).toEqual([1, 2]);
});
