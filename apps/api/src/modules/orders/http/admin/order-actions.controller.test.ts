// Unit tests of the order write controller's answers (B1-10p, D10-1048 ②): each write asks the guard
// for the account's points, stays a write (no readOnly), and blanks the detail it answers with.
import { HttpException } from '@nestjs/common';
import type { Schema } from '@couli/contracts-ts';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  AdminOperationGuard,
  type AdminActor,
  type AdminOperationInput,
  type AdminOperationResponse,
} from '../../../platform/index.ts';
import { assignOrder } from '../../application/admin-assign.ts';
import { holdOrder, unholdOrder } from '../../application/admin-hold.ts';
import { setOrderReasonSub } from '../../application/admin-reason-sub.ts';
import { AdminOrderActionsController } from './order-actions.controller.ts';
import type { AdminWriteDeps, AdminWriteRequest } from './write-deps.ts';

vi.mock('../../application/admin-hold.ts', () => ({ holdOrder: vi.fn(), unholdOrder: vi.fn() }));
vi.mock('../../application/admin-reason-sub.ts', () => ({ setOrderReasonSub: vi.fn() }));
vi.mock('../../application/admin-assign.ts', () => ({ assignOrder: vi.fn() }));

const ORDER = '019c0000-0000-7000-8000-0000000000a1';
const USER = '019c0000-0000-7000-8000-000000000001';
const TRACE = 'trace-b1-10p';

const DETAIL = {
  order_id: ORDER,
  last_hold_note: '内部备注',
  commission_rate_bp: 800,
  commission_split: { reserve_bp: 1000, self_bp: 7000 },
} as unknown as Schema<'AdminOrderDetail'>;
const BLANKED = {
  ...DETAIL,
  last_hold_note: null,
  commission_rate_bp: null,
  commission_split: { reserve_bp: null, self_bp: 7000 },
};

type Access = Pick<AdminActor, 'isSuper' | 'permissions'>;

class RecordingGuard extends AdminOperationGuard {
  readonly inputs: AdminOperationInput[] = [];
  readonly results: AdminOperationResponse[] = [];
  constructor(private readonly access: Access) {
    super();
  }
  override async run(
    input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse> {
    this.inputs.push(input);
    const result = await business({ adminId: 'a', appId: 'app', loginName: 'a', ...this.access });
    this.results.push(result);
    return result;
  }
}

const success = { code: 0, data: DETAIL } as never;
const reply = { header: () => undefined };
const request = { id: TRACE, ip: '192.0.2.1', headers: {} } as unknown as AdminWriteRequest;
const deps = { claims: {}, hold: {}, assign: {} } as unknown as AdminWriteDeps;
const holdBody = { note: '人工核实', expected_row_version: 1 } as never;
const reasonBody = { reason_sub: 'x', expected_row_version: 1 } as never;
const assignBody = {
  user_id: USER,
  expected_user_id: null,
  expected_locked: false,
  reason: '核实后指派',
};

const ACTIONS = [
  [
    'hold',
    'order.hold',
    (c: AdminOrderActionsController) => c.hold(request, ORDER, holdBody, reply),
  ],
  [
    'unhold',
    'order.hold',
    (c: AdminOrderActionsController) => c.unhold(request, ORDER, holdBody, reply),
  ],
  [
    'reasonSub',
    'order.claim',
    (c: AdminOrderActionsController) => c.reasonSub(request, ORDER, reasonBody, reply),
  ],
  [
    'reassign',
    'order.assign',
    (c: AdminOrderActionsController) => c.reassign(request, ORDER, assignBody, reply),
  ],
] as const;

beforeEach(() => {
  vi.mocked(holdOrder).mockReset().mockResolvedValue(success);
  vi.mocked(unholdOrder).mockReset().mockResolvedValue(success);
  vi.mocked(setOrderReasonSub).mockReset().mockResolvedValue(success);
  vi.mocked(assignOrder).mockReset().mockResolvedValue(success);
});

it.each(ACTIONS)(
  '[AC-B1-10p#103] %s 向守卫要权限点、仍是写操作（不带 readOnly），放行点不变',
  async (_name, permission, call) => {
    const guard = new RecordingGuard({ isSuper: false, permissions: [permission] });
    await call(new AdminOrderActionsController(guard, deps));
    expect(guard.inputs).toHaveLength(1);
    expect(guard.inputs[0]).toMatchObject({ request, permission, withPermissions: true });
    expect(guard.inputs[0]).not.toHaveProperty('readOnly');
  },
);

it.each(ACTIONS)(
  '[AC-B1-10p#104] %s 无 order.view：三个内部字段置空，信封不变，守卫看到成功（动态码照常消耗）',
  async (_name, permission, call) => {
    const guard = new RecordingGuard({ isSuper: false, permissions: [permission, 'user.lookup'] });
    const answer = await call(new AdminOrderActionsController(guard, deps));
    expect(answer).toEqual({ code: 0, msg: '', data: BLANKED, trace_id: TRACE });
    expect(guard.results).toEqual([expect.objectContaining({ statusCode: 200 })]);
    expect(guard.results[0]?.body.code).toBe(0);
  },
);

it.each(ACTIONS)(
  '[AC-B1-10p#105] %s 持 order.view 或超管拿到真实值；权限点缺失按无权限',
  async (_name, permission, call) => {
    for (const access of [
      { isSuper: false, permissions: [permission, 'order.view'] },
      { isSuper: true, permissions: [] },
    ]) {
      const guard = new RecordingGuard(access);
      const answer = await call(new AdminOrderActionsController(guard, deps));
      expect(answer.data).toEqual(DETAIL);
    }
    const missing = new RecordingGuard({ isSuper: false });
    const answer = await call(new AdminOrderActionsController(missing, deps));
    expect(answer.data).toEqual(BLANKED);
  },
);

it('[AC-B1-10p#106] commission_split 为 null 时指派回读仍是 null', async () => {
  vi.mocked(assignOrder).mockResolvedValue({
    code: 0,
    data: { ...DETAIL, commission_split: null },
  } as never);
  const guard = new RecordingGuard({ isSuper: false, permissions: ['order.assign'] });
  const answer = await new AdminOrderActionsController(guard, deps).reassign(
    request,
    ORDER,
    assignBody,
    reply,
  );
  expect(answer.data).toEqual({ ...BLANKED, commission_split: null });
});

it('[AC-B1-10p#107] 指派被用例拒绝：拒绝信封原样抛出，守卫看不到成功', async () => {
  vi.mocked(assignOrder).mockResolvedValue({
    code: 20902,
    data: { resource: 'order_attribution' },
  } as never);
  const guard = new RecordingGuard({ isSuper: false, permissions: ['order.assign'] });
  const error: unknown = await new AdminOrderActionsController(guard, deps)
    .reassign(request, ORDER, assignBody, reply)
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  expect(error).toBeInstanceOf(HttpException);
  expect((error as HttpException).getResponse()).toMatchObject({
    code: 20902,
    data: { resource: 'order_attribution' },
    trace_id: TRACE,
  });
  expect(guard.results).toEqual([]);
});
