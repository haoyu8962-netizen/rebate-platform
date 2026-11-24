// Unit tests of the order detail write helpers (F1-07ee r3): unknown statuses (display_status
// included) hide every write entry and 【同步此单】, notes / reasons are checked and sent trimmed,
// a write without an answer times out as result unknown, a dialog cannot be closed while a result
// is unknown, and the unknown write is kept per order until a definite answer.
import { afterEach, expect, it, vi } from 'vitest';
import type { AccessControl } from '../../../providers/access-control/index.ts';
import { AdminApiError } from '../../../providers/data/index.ts';
import type { OrderDetail } from '../model.ts';
import {
  WRITE_TIMEOUT_MS,
  assignReasonValid,
  clearPendingWrite,
  dialogClosable,
  keepPendingWrite,
  knownStatuses,
  noteValid,
  pendingWriteOf,
  sentText,
  withDeadline,
  writeEntriesOf,
  writeFailureOf,
} from './model.ts';

const everything: AccessControl = {
  isSuper: true,
  can: () => true,
  stepUpTier: () => null,
};

function detail(overrides: Partial<OrderDetail>): OrderDetail {
  const base = {
    order_id: '0b9d3c1e-1a2b-4c3d-8e9f-001122334455',
    platform_status: 'RECEIVED',
    rebate_status: 'WAITING',
    display_status: 'WAITING',
    flags: { locked: false, status_locked: false, rights_pending: false, hold: false },
    hold_reason: null,
    unmapped_pending_open: false,
    reason: 'REFUND',
    reason_sub: null,
    user: null,
    row_version: 7,
  };
  return { ...base, ...overrides } as unknown as OrderDetail;
}

afterEach(() => {
  vi.useRealTimers();
});

it('[AC-F1-07ee-UNIT#1] display_status 不在本端枚举里也算未知状态，写入口全部隐藏；null 不算未知', () => {
  expect(knownStatuses(detail({}))).toBe(true);
  expect(knownStatuses(detail({ display_status: null }))).toBe(true);
  const future = { display_status: 'SETTLING_V2' } as unknown as Partial<OrderDetail>;
  expect(knownStatuses(detail(future))).toBe(false);
  expect(writeEntriesOf(detail(future), everything)).toEqual({
    hold: false,
    unhold: false,
    unholdBlocked: false,
    reasonSub: false,
    assign: false,
  });
  // The same order with a known display_status gets its entries.
  expect(writeEntriesOf(detail({}), everything).hold).toBe(true);
});

it('[AC-F1-07ee-UNIT#2] 平台状态或返利状态未知同样算未知（详情页据此连【同步此单】一起隐藏）', () => {
  const platform = { platform_status: 'SHIPPED_V2' } as unknown as Partial<OrderDetail>;
  const rebate = { rebate_status: 'PENDING_V2' } as unknown as Partial<OrderDetail>;
  expect(knownStatuses(detail(platform))).toBe(false);
  expect(knownStatuses(detail(rebate))).toBe(false);
  expect(knownStatuses(detail({ platform_status: 'PAID', rebate_status: 'ESTIMATED' }))).toBe(true);
});

it('[AC-F1-07ee-UNIT#3] 说明与指派原因按去掉首尾空白后的值校验，提交的也是同一个值', () => {
  expect(noteValid(' ')).toBe(false);
  expect(noteValid('\n\t ')).toBe(false);
  expect(noteValid(' 核对 ')).toBe(true);
  expect(noteValid(`${'字'.repeat(200)}  `)).toBe(true);
  expect(noteValid('字'.repeat(201))).toBe(false);
  expect(sentText(' 核对 ')).toBe('核对');
  expect(assignReasonValid('订单凭证 ')).toBe(false);
  expect(assignReasonValid('  订单凭证  ')).toBe(false);
  expect(assignReasonValid(' 订单凭证齐 ')).toBe(true);
  expect(sentText(' 订单凭证齐 ')).toBe('订单凭证齐');
});

it('[AC-F1-07ee-UNIT#4] 写请求超过时限没有回应：取消信号被触发，按结果未知处理', async () => {
  vi.useFakeTimers();
  let seen: AbortSignal | undefined;
  const hanging = withDeadline((signal) => {
    seen = signal;
    return new Promise<never>(() => undefined);
  }, WRITE_TIMEOUT_MS);
  const outcome = hanging.then(
    () => 'resolved',
    (cause: unknown) => cause,
  );
  await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS - 1);
  expect(seen?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const cause = await outcome;
  expect(cause).toBeInstanceOf(DOMException);
  expect((cause as DOMException).name).toBe('TimeoutError');
  expect(seen?.aborted).toBe(true);
  expect(writeFailureOf(cause)).toEqual({ kind: 'unknown' });
  // The data provider turns an aborted fetch into a network error: also unknown.
  const network = new AdminApiError({
    kind: 'network',
    code: -1,
    msg: '网络异常',
    data: null,
    httpStatus: 0,
  });
  expect(writeFailureOf(network)).toEqual({ kind: 'unknown' });
  expect(WRITE_TIMEOUT_MS).toBe(15_000);
});

it('[AC-F1-07ee-UNIT#5] 时限内的回应照常返回，计时器随即清除', async () => {
  vi.useFakeTimers();
  const answered = withDeadline(() => Promise.resolve('ok'), WRITE_TIMEOUT_MS);
  await expect(answered).resolves.toBe('ok');
  expect(vi.getTimerCount()).toBe(0);
  const refused = withDeadline(() => Promise.reject(new Error('refused')), WRITE_TIMEOUT_MS);
  await expect(refused).rejects.toThrow('refused');
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-F1-07ee-UNIT#6] 弹窗只在编辑中可关闭；发送中、验证中、结果未知都不可关闭', () => {
  expect(dialogClosable('editing')).toBe(true);
  expect(dialogClosable('sending')).toBe(false);
  expect(dialogClosable('verifying')).toBe(false);
  expect(dialogClosable('unknown')).toBe(false);
});

it('[AC-F1-07ee-UNIT#7] 结果未知的写按订单保留原体与令牌，明确结果后才清除，别的订单不受影响', () => {
  const id = 'order-unit-7';
  const other = 'order-unit-7-other';
  expect(pendingWriteOf(id)).toBeUndefined();
  const body = { reason_code: 'RISK' as const, note: '核对', expected_row_version: 7 };
  keepPendingWrite(id, { action: 'hold', sent: { body, token: 'tok' } });
  expect(pendingWriteOf(id)).toEqual({ action: 'hold', sent: { body, token: 'tok' } });
  expect(pendingWriteOf(other)).toBeUndefined();
  // A remount reads the same write back (same body, nothing re-derived).
  expect(pendingWriteOf(id)?.sent.body).toBe(body);
  clearPendingWrite(id);
  expect(pendingWriteOf(id)).toBeUndefined();
});
