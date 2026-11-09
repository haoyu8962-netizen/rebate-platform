import type { Schema } from '@couli/contracts-ts';
import { expect, it } from 'vitest';
import {
  AdminOperationGuard,
  type AdminActor,
  type AdminOperationInput,
  type AdminOperationResponse,
} from '../../../platform/index.ts';
import { AdminOrders } from '../../application/admin-orders.ts';
import { AdminOrdersController } from './orders.controller.ts';

const USER = '019c0000-0000-7000-8000-000000000001';
const ORDER = '019c0000-0000-7000-8000-0000000000a1';
const DETAIL = {
  order_id: ORDER,
  last_hold_note: '内部备注',
  commission_rate_bp: 800,
  commission_split: null,
} as unknown as Schema<'AdminOrderDetail'>;
const PAGE = { items: [], page: 1, page_size: 20, total: 0 } as Schema<'AdminOrderPage'>;

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

class StubOrders extends AdminOrders {
  override async list(): Promise<Schema<'AdminOrderPage'>> {
    return PAGE;
  }
  override async detail(): Promise<Schema<'AdminOrderDetail'>> {
    return DETAIL;
  }
}

const reply = { header: () => undefined };
const request = { id: 'trace' } as never;

it('[AC-B1-10o#132] 详情向守卫要权限点并按结果置空，放行点不变；列表不要权限点', async () => {
  const guard = new RecordingGuard();
  const controller = new AdminOrdersController(guard, new StubOrders());
  const answer = await controller.detail(request, ORDER, { user_id: USER }, reply);
  expect(answer.data).toEqual({ ...DETAIL, last_hold_note: null, commission_rate_bp: null });
  await controller.detail(request, ORDER, {}, reply);
  await controller.list(request, {}, reply);
  expect(guard.inputs.map((i) => [i.permission, i.readOnly, i.withPermissions])).toEqual([
    [['order.view', 'user.lookup'], true, true],
    ['order.view', true, true],
    ['order.view', true, false],
  ]);
});
