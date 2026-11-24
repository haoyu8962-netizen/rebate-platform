// Unit tests of the manual sync helpers (F1-07eb): typed Beijing times, order number lines and the
// outcome of a refused request.
import { expect, it } from 'vitest';
import { AdminApiError } from '../../providers/data/index.ts';
import { ordersTexts } from '../../texts/orders.ts';
import {
  beijingInput,
  beijingMinute,
  minuteUp,
  newerSync,
  orderNosOf,
  syncBarOf,
  syncFailureOf,
  syncLatestOf,
  thisOrderRejectedText,
} from './model.ts';

it('[AC-F1-07eb-UNIT#1] 北京时间输入转成带 +08:00 的时间，非法日期与格式不收', () => {
  expect(beijingInput('2026-10-21 00:00')).toBe('2026-10-21T00:00:00+08:00');
  expect(beijingInput(' 2026-10-20 12:00:30 ')).toBe('2026-10-20T12:00:30+08:00');
  expect(beijingInput('2026-10-20T12:00')).toBe('2026-10-20T12:00:00+08:00');
  expect(beijingInput('2026-02-30 00:00')).toBeUndefined();
  expect(beijingInput('2026-10-21 24:00')).toBeUndefined();
  expect(beijingInput('2026/10/21 00:00')).toBeUndefined();
  expect(beijingInput('')).toBeUndefined();
  expect(beijingMinute('2026-10-18T16:30:00Z')).toBe('2026-10-19 00:30');
});

it('[AC-F1-07eb-UNIT#2] 单号每行一个，去掉首尾空白、空行与重复', () => {
  expect(orderNosOf('  A1\nB2  \n\n')).toEqual(['A1', 'B2']);
  expect(orderNosOf('A1,B2，A1')).toEqual(['A1', 'B2']);
  expect(orderNosOf('  \n \n')).toEqual([]);
});

it('[AC-F1-07eb-UNIT#3] 拒绝码对应结果：20001 字段、30156 平台、10403、429、网络失败', () => {
  const api = (code: number, data: unknown, httpStatus = 400) =>
    new AdminApiError({ code, msg: '', data, httpStatus, kind: 'api' });
  expect(syncFailureOf(api(20001, { fields: ['from', 'to'] }), 'pdd')).toEqual({
    kind: 'fields',
    fields: ['from', 'to'],
  });
  expect(syncFailureOf(api(30156, { platform: 'jd' }, 422), 'pdd')).toEqual({
    kind: 'paused',
    platform: 'jd',
  });
  expect(syncFailureOf(api(10403, null, 403), 'pdd')).toEqual({ kind: 'forbidden' });
  expect(syncFailureOf(api(42901, null, 429), 'pdd')).toEqual({ kind: 'rateLimited' });
  expect(
    syncFailureOf(
      new AdminApiError({ code: -1, msg: '', data: null, httpStatus: 0, kind: 'network' }),
      'pdd',
    ),
  ).toEqual({ kind: 'network' });
  expect(syncFailureOf(new Error('x'), 'pdd')).toEqual({ kind: 'failed' });
});

it('[AC-F1-07eb-UNIT#4] 最早可选时间按分钟向上取整，显示值本身能通过校验', () => {
  const earliest = minuteUp('2026-08-02T06:23:17.123Z');
  expect(earliest).toBe('2026-08-02T06:24:00.000Z');
  expect(beijingMinute(earliest)).toBe('2026-08-02 14:24');
  const typed = beijingInput(beijingMinute(earliest));
  expect(typed).toBe('2026-08-02T14:24:00+08:00');
  expect(Date.parse(typed!) >= Date.parse(earliest)).toBe(true);
  expect(minuteUp('2026-07-24T00:00:00+08:00')).toBe('2026-07-23T16:00:00.000Z');
  expect(minuteUp('not a time')).toBe('not a time');
});

it('[AC-F1-07eb-UNIT#5] 同步此单收到 20001 [platform] 或 [order_nos]：提示平台不支持按订单号同步，不报单号格式', () => {
  const t = ordersTexts.sync;
  expect(thisOrderRejectedText(['platform'])).toBe(t.thisOrderUnsupported);
  expect(thisOrderRejectedText(['order_nos'])).toBe(t.thisOrderUnsupported);
  expect(thisOrderRejectedText(['from'])).toBe(t.failed);
  expect(thisOrderRejectedText([])).not.toBe(t.orderNosRejected);
});

it('[AC-F1-07edb-UNIT#3] 手动同步提交成功：状态条取创建响应的状态与创建时间、提交的平台，替换「暂无同步记录」', () => {
  const latest = syncLatestOf(
    { sync_id: 'x', status: 'queued', reused: false, created_at: '2026-10-31T10:01:00+08:00' },
    'pdd',
  );
  expect(latest).toEqual({
    platform: 'pdd',
    status: 'queued',
    created_at: '2026-10-31T10:01:00+08:00',
  });
  expect(syncBarOf({ status: 'ready', item: undefined }, latest)).toEqual({
    status: 'ready',
    item: latest,
  });
  // Still reading or the read failed: the accepted request is shown all the same.
  expect(syncBarOf({ status: 'loading' }, latest)).toEqual({ status: 'ready', item: latest });
  expect(syncBarOf({ status: 'failed' }, latest)).toEqual({ status: 'ready', item: latest });
  expect(syncBarOf({ status: 'failed' }, undefined)).toEqual({ status: 'failed' });
  // An answer without the fields the bar needs changes nothing.
  expect(syncLatestOf({ sync_id: 'x', reused: false }, 'pdd')).toBeUndefined();
  expect(syncLatestOf(null, 'pdd')).toBeUndefined();
});

it('[AC-F1-07edb-UNIT#4] 复用旧请求（reused）时状态条保留创建时间更晚的那条', () => {
  const read = {
    platform: 'jd',
    status: 'done',
    created_at: '2026-10-31T09:30:00+08:00',
  } as const;
  const older = {
    platform: 'pdd',
    status: 'running',
    created_at: '2026-10-31T09:00:00+08:00',
  } as const;
  const newer = {
    platform: 'pdd',
    status: 'queued',
    created_at: '2026-10-31T10:00:00+08:00',
  } as const;
  expect(newerSync(read, older)).toBe(read);
  expect(newerSync(read, newer)).toBe(newer);
  expect(newerSync(undefined, older)).toBe(older);
  expect(newerSync(read, undefined)).toBe(read);
  expect(syncBarOf({ status: 'ready', item: read }, older)).toEqual({
    status: 'ready',
    item: read,
  });
});
