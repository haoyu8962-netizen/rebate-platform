import { order_reason_sub } from '@couli/contracts-ts';
import { expect, it } from 'vitest';
import { REASON_SUB_INVALID_ALERT, userReasonSub } from './order-queries.ts';

function recorder() {
  const calls: unknown[][] = [];
  return { calls, logger: { warn: (...args: unknown[]) => void calls.push(args) } };
}

it('[AC-B1-09y-UNIT#1] 15 个合法 (父编码, 子原因) 原样返回且不告警', () => {
  const { calls, logger } = recorder();
  const refund = ['IN_SALE', 'AFTER_SETTLE'];
  for (const sub of order_reason_sub) {
    const parent = refund.includes(sub) ? 'REFUND' : sub === 'AFTER_SALE' ? 'RIGHTS' : 'PUNISH';
    expect(userReasonSub(parent, sub, logger)).toBe(sub);
  }
  expect(order_reason_sub).toHaveLength(15);
  expect(calls).toEqual([]);
});

it('[AC-B1-09y-UNIT#2] null 子原因、父编码无子原因或为 null：不输出也不告警', () => {
  const { calls, logger } = recorder();
  expect(userReasonSub('PUNISH', null, logger)).toBeUndefined();
  expect(userReasonSub(null, 'AFTER_SALE', logger)).toBeUndefined();
  expect(userReasonSub('OTHER', 'FAKE_TRADE', logger)).toBeUndefined();
  expect(userReasonSub('PART_REFUND', 'IN_SALE', logger)).toBeUndefined();
  expect(calls).toEqual([]);
});

it('[AC-B1-09y-UNIT#3] 别的父编码的值或枚举外的值：不输出，warn 一次且只带 alert / reason / reason_sub', () => {
  for (const [reason, sub] of [
    ['REFUND', 'FAKE_TRADE'],
    ['PUNISH', 'AFTER_SALE'],
    ['RIGHTS', 'IN_SALE'],
    ['PUNISH', 'BOGUS_SUB'],
    ['RIGHTS', 'after_sale'],
    ['PUNISH', ''],
  ] as const) {
    const { calls, logger } = recorder();
    expect(userReasonSub(reason, sub, logger)).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual({ alert: REASON_SUB_INVALID_ALERT, reason, reason_sub: sub });
  }
});

it('[AC-B1-09y-UNIT#4] 没有 logger 时不合法值同样不输出、不抛错', () => {
  expect(userReasonSub('REFUND', 'FAKE_TRADE', undefined)).toBeUndefined();
});
