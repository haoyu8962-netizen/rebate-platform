// Unit tests of /admin/v1/exports' controller (CT-24zi): the tax_withdrawals create stays closed
// until its implementation merges (20001 data.fields=[resource], no guard call, no use case).
// CT-24x: the orders create stays closed the same way until its back end (D2) merges.
import { HttpException } from '@nestjs/common';
import { expect, it } from 'vitest';
import {
  AdminOperationGuard,
  type AdminActor,
  type AdminOperationInput,
  type AdminOperationResponse,
} from '../../../platform/index.ts';
import type { AdminExports, ExportCreateCommand } from '../../application/admin-exports.ts';
import { AdminExportsController } from './exports.controller.ts';

const APP = 'ct_24zi_ctrl';
const ADMIN = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01';
const TRACE = 'trace-ct-24zi';

class FakeGuard extends AdminOperationGuard {
  readonly calls: AdminOperationInput[] = [];

  override async run(
    input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse> {
    this.calls.push(input);
    return business({ adminId: ADMIN, appId: APP, isSuper: false, loginName: 'ops01' });
  }
}

function setup() {
  const guard = new FakeGuard();
  const checked: ExportCreateCommand[] = [];
  const created: ExportCreateCommand[] = [];
  const view = { id: 'exp_Kd3Qw8Rt5Ym1Zx7N' };
  const exports = {
    checkCreate: (_actor: AdminActor, command: ExportCreateCommand) => {
      checked.push(command);
      return Promise.resolve({ masked: true });
    },
    create: (_actor: AdminActor, command: ExportCreateCommand) => {
      created.push(command);
      return Promise.resolve(view);
    },
  } as unknown as AdminExports;
  const controller = new AdminExportsController(guard, exports);
  const request = { id: TRACE, ip: '127.0.0.1', query: {} } as never;
  return { guard, checked, created, view, controller, request };
}

it('[CT-24zi] the other resources still go through the export guard to the use case', async () => {
  const { guard, checked, created, view, controller, request } = setup();
  const answer = await controller.create(request, { resource: 'audit_logs', filters: {} });
  expect(answer).toEqual({ code: 0, msg: '', data: view, trace_id: TRACE });
  expect(guard.calls.map((call) => call.permission)).toEqual(['export']);
  expect(checked).toEqual([{ resource: 'audit_logs', filters: {} }]);
  expect(created).toEqual([{ resource: 'audit_logs', filters: {} }]);
});

it('[CT-24x] an orders create is 20001 on resource before D2: no guard call, no use case', async () => {
  const { guard, checked, created, controller, request } = setup();
  const error: unknown = await controller
    .create(request, { resource: 'orders', filters: { platform: 'pdd' } })
    .then(
      () => undefined,
      (reason: unknown) => reason,
    );
  expect(error).toBeInstanceOf(HttpException);
  const refused = error as HttpException;
  expect(refused.getStatus()).toBe(400);
  expect(refused.getResponse()).toEqual({
    code: 20001,
    msg: '参数校验失败',
    data: { fields: ['resource'] },
    trace_id: TRACE,
  });
  expect(guard.calls).toEqual([]);
  expect(checked).toEqual([]);
  expect(created).toEqual([]);
});
