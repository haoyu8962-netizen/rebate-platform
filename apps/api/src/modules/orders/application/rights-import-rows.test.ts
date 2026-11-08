// B1-09v (08 BR-TEXT-05 子原因 写入来源 ②; D10-819 ①, D10-957): the punish task's stored reason_sub
// as rights.record takes it. Unit test only (no database); the rule tests are
// test/spec/orders/reason-sub-manual/**.
import { expect, it } from 'vitest';
import { manualChoiceOf } from './rights-import-rows.ts';

const PUNISH = { kind: 'punish', import_id: 'imp-1', created_by: 'admin-1' } as const;
const ORIGIN = { import_id: 'imp-1', admin_id: 'admin-1' };

it('[AC-B1-09v#1] a punish task with a PUNISH sub-reason hands it on with its import and creator', () => {
  expect(manualChoiceOf(PUNISH, 'FAKE_TRADE')).toEqual({ value: 'FAKE_TRADE', origin: ORIGIN });
  expect(manualChoiceOf(PUNISH, 'PUNISH_ORDER')).toEqual({ value: 'PUNISH_ORDER', origin: ORIGIN });
});

it('[AC-B1-09v#2] none is a choice by hand without a sub-reason (value null), still with its origin', () => {
  expect(manualChoiceOf(PUNISH, 'none')).toEqual({ value: null, origin: ORIGIN });
});

it('[AC-B1-09v#3] no stored part, or a value outside PUNISH, is no choice by hand', () => {
  expect(manualChoiceOf(PUNISH, null)).toBeUndefined();
  expect(manualChoiceOf(PUNISH, undefined)).toBeUndefined();
  for (const other of ['IN_SALE', 'AFTER_SETTLE', 'AFTER_SALE', 'fake_trade', 'NONE', '']) {
    expect(manualChoiceOf(PUNISH, other)).toBeUndefined();
  }
});

it('[AC-B1-09v#5] a rights or channel task never carries a choice by hand (D10-819 ②)', () => {
  expect(manualChoiceOf({ ...PUNISH, kind: 'rights' }, 'FAKE_TRADE')).toBeUndefined();
  expect(manualChoiceOf({ ...PUNISH, kind: 'channel' }, 'none')).toBeUndefined();
});
