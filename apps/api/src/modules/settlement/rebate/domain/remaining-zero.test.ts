// B2-04zzg 源码旁单元测试：京东入账前「剩余数量为 0」的判定（纯函数）。
import { expect, it } from 'vitest';
import { jdRemainingZero } from './rules.ts';

it('[AC-B2-04zzg#U1] 京东两列都已知且 quantity − refunded_quantity ≤ 0 才判剩余为 0', () => {
  expect(jdRemainingZero({ platform: 'jd', quantity: 2, refunded_quantity: 2 })).toBe(true);
  expect(jdRemainingZero({ platform: 'jd', quantity: 2, refunded_quantity: 3 })).toBe(true);
  expect(jdRemainingZero({ platform: 'jd', quantity: 2, refunded_quantity: 1 })).toBe(false);
  expect(jdRemainingZero({ platform: 'jd', quantity: 1, refunded_quantity: 0 })).toBe(false);
});

it('[AC-B2-04zzg#U2] 任一列为空、件数为 0、非京东都不判定', () => {
  expect(jdRemainingZero({ platform: 'jd', quantity: null, refunded_quantity: 2 })).toBe(false);
  expect(jdRemainingZero({ platform: 'jd', quantity: 2, refunded_quantity: null })).toBe(false);
  expect(jdRemainingZero({ platform: 'jd', quantity: 0, refunded_quantity: 0 })).toBe(false);
  expect(jdRemainingZero({ platform: 'pdd', quantity: 2, refunded_quantity: 2 })).toBe(false);
  expect(jdRemainingZero({ platform: 'taobao', quantity: 2, refunded_quantity: 2 })).toBe(false);
});
