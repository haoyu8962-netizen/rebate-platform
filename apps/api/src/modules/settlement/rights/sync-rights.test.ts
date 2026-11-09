// B2-04zzr unit tests (no database): which order_rights row an order sync's status signal stands for
// (BR-FUND-01 P7 / P8, BR-FUND-02, BR-FUND-08 P{row_version}).
import { expect, it } from 'vitest';
import { syncRightsOf } from './sync-rights.ts';

it('[AC-B2-04zzr-UNIT#1] P7：SETTLED 收到 PLATFORM_INVALID → INVALID_AFTER_SETTLE，单号 P{同步更新写入的 row_version}', () => {
  expect(syncRightsOf({ from_status: 'SETTLED' }, { event: 'PLATFORM_INVALID' }, 7)).toEqual({
    type: 'INVALID_AFTER_SETTLE',
    platformRightsNo: 'P7',
  });
});

it('[AC-B2-04zzr-UNIT#2] 结算前失效（P6）不写 INVALID_AFTER_SETTLE', () => {
  for (const from of ['DEPOSIT_PAID', 'PAID', 'RECEIVED']) {
    expect(syncRightsOf({ from_status: from }, { event: 'PLATFORM_INVALID' }, 3), from).toBeNull();
  }
});

it('[AC-B2-04zzr-UNIT#3] P8 处罚（PAID / RECEIVED / SETTLED）→ PUNISH、无单号；P8 以外的来源状态不写', () => {
  for (const from of ['PAID', 'RECEIVED', 'SETTLED']) {
    expect(syncRightsOf({ from_status: from }, { event: 'PLATFORM_PUNISH' }, 4), from).toEqual({
      type: 'PUNISH',
      platformRightsNo: null,
    });
  }
  for (const from of ['DEPOSIT_PAID', 'INVALID']) {
    expect(syncRightsOf({ from_status: from }, { event: 'PLATFORM_PUNISH' }, 4), from).toBeNull();
  }
});

it('[AC-B2-04zzr-UNIT#4] 其他事件（维权信号、结算、表外码）不写', () => {
  for (const event of ['PLATFORM_RIGHTS', 'PLATFORM_SETTLED', null] as const) {
    expect(syncRightsOf({ from_status: 'SETTLED' }, { event }, 2), String(event)).toBeNull();
  }
});
