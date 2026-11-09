import type { Schema } from '@couli/contracts-ts';
import { expect, it } from 'vitest';
import { blankAdminUserDetail } from './admin-user-view.ts';

const DETAIL = {
  user_id: 'u1',
  risk: { state: 'frozen', reason_category: 'abnormal_trade', reason: '内部说明', row_version: 1 },
  union_bindings: [{ platform: 'taobao', reason: '绑定说明' }],
} as unknown as Schema<'AdminUserDetail'>;
const BLANKED = { ...DETAIL, risk: { ...DETAIL.risk, reason: null } };

it('[AC-B1-10o#101] 超管不置空 risk.reason，permissions 缺失或为空也一样', () => {
  expect(blankAdminUserDetail(DETAIL, { isSuper: true })).toEqual(DETAIL);
  expect(blankAdminUserDetail(DETAIL, { isSuper: true, permissions: [] })).toEqual(DETAIL);
});

it.each(['risk.freeze', 'risk.ban', 'risk.blocklist', 'risk.appeal'])(
  '[AC-B1-10o#102] 持 %s 的账号看到 risk.reason',
  (point) => {
    expect(blankAdminUserDetail(DETAIL, { isSuper: false, permissions: [point] })).toEqual(DETAIL);
  },
);

it('[AC-B1-10o#103] 不持风控权限点时只置空 risk.reason，其余字段与 union_bindings[].reason 不动', () => {
  for (const permissions of [[], ['user.lookup'], ['user.list', 'order.view']]) {
    expect(blankAdminUserDetail(DETAIL, { isSuper: false, permissions })).toEqual(BLANKED);
  }
});

it('[AC-B1-10o#104] 非超管拿不到 permissions 时按无权限置空', () => {
  expect(blankAdminUserDetail(DETAIL, { isSuper: false })).toEqual(BLANKED);
});
