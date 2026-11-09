import type { Schema } from '@couli/contracts-ts';
import { expect, it } from 'vitest';
import {
  AdminOperationGuard,
  type AdminActor,
  type AdminOperationInput,
  type AdminOperationResponse,
} from '../../../platform/index.ts';
import { AdminClaims } from '../../application/admin-claims.ts';
import { AdminClaimsController } from './claims.controller.ts';

const USER = '019c0000-0000-7000-8000-000000000001';
const CLAIM = '019c0000-0000-7000-8000-0000000000c1';
const DETAIL = {
  claim_id: CLAIM,
  reason: '找回内部说明',
  items: [],
} as unknown as Schema<'AdminClaimDetail'>;
const PAGE = { items: [], page: 1, page_size: 20, total: 0 } as unknown as Schema<'AdminClaimPage'>;

class RecordingGuard extends AdminOperationGuard {
  readonly inputs: AdminOperationInput[] = [];
  override async run(
    input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse> {
    this.inputs.push(input);
    return business({ adminId: 'a', appId: 'app', isSuper: false, loginName: 'a' });
  }
}

class StubClaims extends AdminClaims {
  override async list(): Promise<Schema<'AdminClaimPage'>> {
    return PAGE;
  }
  override async detail(): Promise<Schema<'AdminClaimDetail'>> {
    return DETAIL;
  }
}

const reply = { header: () => undefined };
const request = { id: 'trace' } as never;

it('[AC-B1-10o#133] 详情向守卫要权限点并按结果置空，放行点不变；列表不要权限点', async () => {
  const guard = new RecordingGuard();
  const controller = new AdminClaimsController(guard, new StubClaims());
  const answer = await controller.detail(request, CLAIM, { user_id: USER }, reply);
  expect(answer.data).toEqual({ ...DETAIL, reason: null });
  await controller.detail(request, CLAIM, {}, reply);
  await controller.list(request, {}, reply);
  expect(guard.inputs.map((i) => [i.permission, i.readOnly, i.withPermissions])).toEqual([
    [['order.claim', 'user.lookup'], true, true],
    ['order.claim', true, true],
    ['order.claim', true, false],
  ]);
});
