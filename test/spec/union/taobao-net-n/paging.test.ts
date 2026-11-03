// B1-04zz（02 §7.1、大淘客文档）：续页请求带 jumpType，值是上一页 position_index 的翻页方向 1；每窗首页不带。
import { expect, it } from 'vitest';
import type { TimeWindow } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  collect,
  ctx,
  hourMs,
  listed,
  positionOf,
  rowOf,
  setup,
  win,
  windowAnswer,
} from '../taobao-orders/kit.ts';

const W0 = '2026-10-30 10:00:00';
const W1 = '2026-10-30 13:00:00';
const fourHours: TimeWindow = {
  from: win.from,
  to: new Date(Date.parse(win.from) + 4 * hourMs).toISOString(),
};

it('[AC-B1-04zz#14] 续页带 jumpType=1，首页不带；进下一窗的首页也不带', async () => {
  const s = setup(
    windowAnswer({
      [W0]: [[rowOf(1)], [rowOf(2)], [rowOf(3)]],
      [W1]: [[rowOf(4)]],
    }),
  );
  await collect(s.adapter, fourHours);
  expect(s.requests.map((q) => [q.startTime, q.positionIndex, q.jumpType])).toEqual([
    [W0, undefined, undefined],
    [W0, positionOf(0, 0), '1'],
    [W0, positionOf(0, 1), '1'],
    [W1, undefined, undefined],
  ]);
  expect(s.requests[0]).not.toHaveProperty('jumpType');
  expect(s.requests[3]).not.toHaveProperty('jumpType');
});

it('[AC-B1-04zz#15] 换一个新的适配器实例从游标续拉，续页同样带 jumpType=1', async () => {
  const answer = windowAnswer({ [W0]: [[rowOf(1)], [rowOf(2)]] });
  const first = setup(answer);
  const page = await listed(first.adapter.listOrders(win, {}, ctx));
  expect(page.nextCursor).toBeTypeOf('string');

  const second = setup(answer);
  await listed(second.adapter.listOrders(win, { cursor: page.nextCursor! }, ctx));
  expect(second.requests).toEqual([
    expect.objectContaining({ positionIndex: positionOf(0, 0), jumpType: '1' }),
  ]);
});
