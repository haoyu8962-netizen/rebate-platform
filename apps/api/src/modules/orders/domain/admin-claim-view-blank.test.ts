import type { Schema } from '@couli/contracts-ts';
import { expect, it } from 'vitest';
import { blankAdminClaimDetail } from './admin-claim-view.ts';

const DETAIL = {
  claim_id: 'c1',
  reason: '找回内部说明',
  items: [
    { reject_reason: 'NO_EVIDENCE', matches: [], evidence_links: [{ at: 't', scene: null }] },
  ],
} as unknown as Schema<'AdminClaimDetail'>;
const BLANKED = { ...DETAIL, reason: null };

it('[AC-B1-10o#121] 超管或持 order.claim 不置空，超管的 permissions 缺失也一样', () => {
  expect(blankAdminClaimDetail(DETAIL, { isSuper: true })).toEqual(DETAIL);
  expect(blankAdminClaimDetail(DETAIL, { isSuper: true, permissions: [] })).toEqual(DETAIL);
  expect(blankAdminClaimDetail(DETAIL, { isSuper: false, permissions: ['order.claim'] })).toEqual(
    DETAIL,
  );
});

it('[AC-B1-10o#122] 不持 order.claim 时只置空 reason，items 不动', () => {
  expect(blankAdminClaimDetail(DETAIL, { isSuper: false, permissions: ['user.lookup'] })).toEqual(
    BLANKED,
  );
});

it('[AC-B1-10o#123] 非超管拿不到 permissions 时按无权限置空', () => {
  expect(blankAdminClaimDetail(DETAIL, { isSuper: false })).toEqual(BLANKED);
});
