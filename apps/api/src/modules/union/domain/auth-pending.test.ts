import { expect, it } from 'vitest';
import { UNION_AUTH_PENDING_STATUSES, isUnionAuthPending } from './auth-pending.ts';

it('[AC-B1-22zc-UNIT#1][BR-ID-24] 待处理授权状态恰为 expiring、expired', () => {
  expect([...UNION_AUTH_PENDING_STATUSES]).toEqual(['expiring', 'expired']);
});

it('[AC-B1-22zc-UNIT#2][BR-ID-24] 只有 expiring / expired 判为待处理，active 与其他取值不算', () => {
  expect(isUnionAuthPending('expiring')).toBe(true);
  expect(isUnionAuthPending('expired')).toBe(true);
  for (const status of ['active', '', 'EXPIRED', 'expiring ', 'revoked']) {
    expect(isUnionAuthPending(status)).toBe(false);
  }
});
