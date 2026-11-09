import type { Schema } from '@couli/contracts-ts';
import { expect, it } from 'vitest';
import { blankAdminOrderDetail } from './admin-order-view.ts';

const SPLIT = { reserve_bp: 1500, reserve_fen: 150, beneficiaries: [{ ratio_bp: 5000 }] };
const DETAIL = {
  order_id: 'o1',
  reason: 'OTHER',
  hold_reason: 'CS',
  pay_amount_fen: 12900,
  last_hold_by: 'a1',
  last_hold_note: '内部备注',
  commission_rate_bp: 800,
  commission_split: SPLIT,
} as unknown as Schema<'AdminOrderDetail'>;
const BLANKED = {
  ...DETAIL,
  last_hold_note: null,
  commission_rate_bp: null,
  commission_split: { ...SPLIT, reserve_bp: null },
};

it('[AC-B1-10o#111] 超管或持 order.view 不置空，超管的 permissions 缺失也一样', () => {
  expect(blankAdminOrderDetail(DETAIL, { isSuper: true })).toEqual(DETAIL);
  expect(blankAdminOrderDetail(DETAIL, { isSuper: true, permissions: [] })).toEqual(DETAIL);
  expect(blankAdminOrderDetail(DETAIL, { isSuper: false, permissions: ['order.view'] })).toEqual(
    DETAIL,
  );
});

it('[AC-B1-10o#112] 不持 order.view 时只置空三个内部字段，金额、枚举、受益人份额不动', () => {
  expect(blankAdminOrderDetail(DETAIL, { isSuper: false, permissions: ['user.lookup'] })).toEqual(
    BLANKED,
  );
});

it('[AC-B1-10o#113] 非超管拿不到 permissions 时按无权限置空', () => {
  expect(blankAdminOrderDetail(DETAIL, { isSuper: false })).toEqual(BLANKED);
});

it('[AC-B1-10o#114] 快照未生成时 commission_split 仍是 null', () => {
  const none = { ...DETAIL, commission_split: null };
  expect(blankAdminOrderDetail(none, { isSuper: false })).toEqual({
    ...BLANKED,
    commission_split: null,
  });
});
