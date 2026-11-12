import { expect, it } from 'vitest';
import { CREDITABLE_EVENTS } from '../../specs/creditable-events.gen.ts';
import {
  commissionChangeOf,
  commissionOutcome,
  isBaseZero,
  isCreditablePlatform,
  periodBasisSupported,
  reverseEventOf,
  step,
  unmappedHoldEnabled,
  voidReasonOf,
} from './rules.ts';

const zero = {
  platformStatus: 'PAID',
  fromPlatformStatus: 'PAID',
} as const;

it('[AC-B2-04j-UNIT#1] 有效基数只有正数变 0 才归零；null 是未知、定金期不触发', () => {
  expect(isBaseZero({ ...zero, before: 1n, after: 0n })).toBe(true);
  expect(isBaseZero({ ...zero, before: 0n, after: 0n })).toBe(false);
  expect(isBaseZero({ ...zero, before: null, after: 0n })).toBe(false);
  expect(isBaseZero({ ...zero, before: 900n, after: null })).toBe(false);
  expect(isBaseZero({ ...zero, before: 900n, after: 0n, platformStatus: 'DEPOSIT_PAID' })).toBe(
    false,
  );
  expect(isBaseZero({ ...zero, before: 900n, after: 0n, fromPlatformStatus: 'DEPOSIT_PAID' })).toBe(
    false,
  );
});

it('[AC-B2-04j-UNIT#2] R6 事件的原因码与平台事件映射', () => {
  expect(voidReasonOf('PLATFORM_INVALID')).toBe('REFUND');
  expect(voidReasonOf('RIGHTS_FULL')).toBe('RIGHTS');
  expect(voidReasonOf('PUNISH')).toBe('PUNISH');
  expect(voidReasonOf('BLACKLIST_HIT')).toBe('BLACKLIST');
  expect(voidReasonOf('BASE_ZERO')).toBe('COMMISSION_ZERO');
  expect(voidReasonOf('PARTIAL_REFUND')).toBeNull();
  expect(reverseEventOf('PLATFORM_INVALID', 'SETTLED')).toBe('PLATFORM_INVALID');
  expect(reverseEventOf('PLATFORM_PUNISH', 'PAID')).toBe('PUNISH');
  expect(reverseEventOf('PLATFORM_RIGHTS', 'PAID')).toBeNull();
  expect(reverseEventOf(null, 'PAID')).toBeNull();
});

it('[AC-B2-04j-UNIT#3] 迁移只经生成的 transition()：终态与表外事件返回 null', () => {
  expect(step(null, 'IMPORT_ATTRIBUTED')).toEqual({
    from: null,
    event: 'IMPORT_ATTRIBUTED',
    to: 'ESTIMATED',
  });
  expect(step('WAITING', 'PARTIAL_REFUND')).toEqual({
    from: 'WAITING',
    event: 'PARTIAL_REFUND',
    to: 'WAITING',
  });
  expect(step('VOID', 'PARTIAL_REFUND')).toBeNull();
  expect(step('UNATTRIBUTED', 'PLATFORM_RECEIVED_OR_SETTLED')).toBeNull();
});

it('[AC-B2-04j-UNIT#4] 可入账平台、结算周期取法与未映射状态 hold 开关', () => {
  expect(['taobao', 'jd', 'pdd', 'meituan'].every(isCreditablePlatform)).toBe(true);
  expect(['vip', 'douyin', 'eleme'].some(isCreditablePlatform)).toBe(false);
  expect(periodBasisSupported(undefined)).toBe(true);
  expect(periodBasisSupported('received_at')).toBe(true);
  expect(periodBasisSupported('settled_at')).toBe(false);
  expect(unmappedHoldEnabled(undefined)).toBe(true);
  expect(unmappedHoldEnabled(true)).toBe(true);
  expect(unmappedHoldEnabled(false)).toBe(false);
});

it('[AC-B2-10a-UNIT#1] 可入账平台只取生成常量的登记项：逐项全等比较，原型链名字、大小写与空白变体都不可入账', () => {
  for (const entry of CREDITABLE_EVENTS.platforms) {
    expect(isCreditablePlatform(entry.platform), entry.platform).toBe(true);
  }
  for (const name of [
    '',
    'Taobao',
    ' jd',
    'pdd ',
    '__proto__',
    'constructor',
    'toString',
    'platforms',
  ]) {
    expect(isCreditablePlatform(name), JSON.stringify(name)).toBe(false);
  }
});

const settled = { platformStatus: 'SETTLED', fromPlatformStatus: 'SETTLED' } as const;

it('[AC-B2-04j-UNIT#5] 首次结算额为 0：WAITING 预估 1000 不变而结算佣金 0 到达 → R6 作废', () => {
  const change = commissionChangeOf({
    estBefore: 1000n,
    estAfter: 1000n,
    settleCommissionFen: 0n,
    platformStatus: 'SETTLED',
    fromPlatformStatus: 'RECEIVED',
  });
  expect(change).toBe('settle_arrived');
  expect(
    commissionOutcome({
      change,
      before: 900n,
      after: 0n,
      ...settled,
      fromPlatformStatus: 'RECEIVED',
    }),
  ).toBe('void');
});

it('[AC-B2-04j-UNIT#6] 已结算订单结算额调减（预估未变）→ R7 重算；调减到 0 → R6；未变 → 不动', () => {
  const change = commissionChangeOf({
    estBefore: 1000n,
    estAfter: 1000n,
    settleCommissionFen: 600n,
    ...settled,
  });
  expect(change).toBe('settle_recheck');
  expect(commissionOutcome({ change, before: 720n, after: 540n, ...settled })).toBe('recalc');
  expect(commissionOutcome({ change, before: 720n, after: 0n, ...settled })).toBe('void');
  expect(commissionOutcome({ change, before: 720n, after: 720n, ...settled })).toBe('none');
  // 首次结算额与预估相同、换算基数不变也按结算额到达重算（R7），不漏判。
  expect(
    commissionOutcome({
      change: 'settle_arrived',
      before: 900n,
      after: 900n,
      ...settled,
      fromPlatformStatus: 'RECEIVED',
    }),
  ).toBe('recalc');
});

it('[AC-B2-04j-UNIT#7] 结算额不变仅预估变化 → 经端口确认有效基数未变后按 BR-FUND-03 / 07 豁免，只存档', () => {
  const change = commissionChangeOf({
    estBefore: 1000n,
    estAfter: 0n,
    settleCommissionFen: 800n,
    ...settled,
  });
  // 预估变化不再跳过基数比较：仍归为 settle_recheck，由前后有效基数决定。
  expect(change).toBe('settle_recheck');
  expect(commissionOutcome({ change, before: 720n, after: 720n, ...settled })).toBe('none');
  // 无结算佣金时预估变化照常比较；定金期一律不动。
  expect(
    commissionChangeOf({
      estBefore: 1000n,
      estAfter: 0n,
      settleCommissionFen: null,
      platformStatus: 'PAID',
      fromPlatformStatus: 'PAID',
    }),
  ).toBe('estimate');
  expect(
    commissionChangeOf({
      estBefore: 1000n,
      estAfter: 0n,
      settleCommissionFen: null,
      platformStatus: 'DEPOSIT_PAID',
      fromPlatformStatus: 'DEPOSIT_PAID',
    }),
  ).toBe('none');
  expect(
    commissionChangeOf({
      estBefore: 1000n,
      estAfter: 1000n,
      settleCommissionFen: null,
      platformStatus: 'PAID',
      fromPlatformStatus: 'PAID',
    }),
  ).toBe('none');
});

it('[AC-B2-04j-UNIT#8] 同一报文同时调减预估与结算佣金（预估 1000→600、结算 800→500）→ R7 重算', () => {
  const change = commissionChangeOf({
    estBefore: 1000n,
    estAfter: 600n,
    settleCommissionFen: 500n,
    ...settled,
  });
  expect(change).toBe('settle_recheck');
  expect(commissionOutcome({ change, before: 720n, after: 450n, ...settled })).toBe('recalc');
});

it('[AC-B2-04j-UNIT#9] 同一报文同时把预估与结算佣金归零（1000→0、800→0）→ R6 作废', () => {
  const change = commissionChangeOf({
    estBefore: 1000n,
    estAfter: 0n,
    settleCommissionFen: 0n,
    ...settled,
  });
  expect(change).toBe('settle_recheck');
  expect(commissionOutcome({ change, before: 720n, after: 0n, ...settled })).toBe('void');
});
