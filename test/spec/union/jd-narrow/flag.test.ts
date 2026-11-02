// B1-04zt ① (规划/02 §7.1、09 CAP-JD-07): the real jd adapter over a fake transport. The frozen
// [AC-B1-04zb#24] keeps 2002452 an upstream_rejected the adapter does not narrow by itself; the only
// new thing is the flag the orders side reads. 报文全部合成。
import { expect, it, vi } from 'vitest';
import type { QuotaLimiter } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionError,
  type UnionErrorCode,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  ctx,
  govern,
  inner,
  num,
  pageAnswer,
  reply,
  singleRowPages,
  win,
  wire,
} from '../jd-orders/kit.ts';
import { jdRefusal, type Flagged } from './refusal.ts';

it('[AC-B1-04zt#1] 内层 2002452：code 仍是 upstream_rejected，平台仍是 jd，windowTooLarge 为 true', async () => {
  const error = await jdRefusal('2002452');
  expect(error.code).toBe('upstream_rejected');
  expect(error.platform).toBe('jd');
  expect(error.windowTooLarge).toBe(true);
});

it('[AC-B1-04zt#1] 第 2 页才收到 2002452：标记一样在，适配器不重试、不自行缩窗', async () => {
  const answer = pageAnswer(singleRowPages(3).pages);
  const { adapter, requests } = wire((body) =>
    body.pageIndex === 2 ? reply(inner([], false, num('2002452'))) : answer(body),
  );
  const first = await adapter.listOrders(win, {}, ctx);
  const refused: unknown = await adapter
    .listOrders(win, { cursor: first.nextCursor! }, ctx)
    .catch((error: unknown) => error);
  expect(refused).toMatchObject({ code: 'upstream_rejected', windowTooLarge: true });
  expect(requests.map((body) => body.pageIndex)).toEqual([1, 2]);
  expect(requests[1]).toMatchObject({
    startTime: requests[0]!.startTime,
    endTime: requests[0]!.endTime,
  });
});

it('[AC-B1-04zt#1] 经治理包装后标记不丢，也不重试：生产里订单侧拿到的是包装后的适配器', async () => {
  const { adapter, transport } = wire(() => reply(inner([], false, num('2002452'))));
  const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
  const refused: unknown = await govern(adapter, take)
    .listOrders(win, {}, ctx)
    .catch((error: unknown) => error);
  expect(refused).toMatchObject({ code: 'upstream_rejected', windowTooLarge: true });
  expect(transport).toHaveBeenCalledTimes(1);
});

const OTHER_CODES: readonly { readonly code: string; readonly expected: UnionErrorCode }[] = [
  { code: '2002453', expected: 'upstream_rejected' },
  { code: '2002451', expected: 'upstream_rejected' },
  { code: '20024520', expected: 'upstream_rejected' },
  { code: '403', expected: 'upstream_rejected' },
  { code: '500', expected: 'upstream_rejected' },
  { code: '429', expected: 'rate_limited' },
];

it.each(OTHER_CODES)(
  '[AC-B1-04zt#1] 内层 $code → $expected，windowTooLarge 为 false',
  async ({ code, expected }) => {
    const error = await jdRefusal(code);
    expect(error.code).toBe(expected);
    expect(error.windowTooLarge).toBe(false);
  },
);

it.each(['upstream_rejected', 'invalid_dto', 'rate_limited'] as const)(
  '[AC-B1-04zt#1] 直接构造的 UnionError（%s）不说明时 windowTooLarge 默认 false',
  (code) => {
    const error = new UnionError(code, 'synthetic refusal', 'jd') as Flagged;
    expect(error.windowTooLarge).toBe(false);
  },
);
