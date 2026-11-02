// Unit tests of GET /admin/v1/users/{user_id}/devices' controller and of AdminUserDevices without a
// database (B1-02zz): the guard input, the app the read is scoped to, the projection of a row and
// the refusals. What the query selects is the integration rule tests' subject.
import { HttpException } from '@nestjs/common';
import { expect, it } from 'vitest';
import {
  AdminOperationGuard,
  type AdminActor,
  type AdminOperationInput,
  type AdminOperationResponse,
} from '../../../platform/index.ts';
import {
  AdminUserDevices,
  type AdminUserDeviceRow,
  type AdminUserDeviceStore,
} from '../../application/admin-user-devices.ts';
import { AdminUserDevicesController } from './user-devices.controller.ts';

const APP = 'b1-02zz-ctrl';
const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';
const DEVICE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a60';
const TRACE = 'trace-b1-02zz';
const SEEN = new Date('2026-11-03T01:58:00.000Z');
const REGISTERED = new Date('2026-10-20T01:00:00.000Z');
const RECORDED = new Date('2026-11-01T01:00:00.000Z');

class FakeGuard extends AdminOperationGuard {
  readonly calls: AdminOperationInput[] = [];

  override run(
    input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse> {
    this.calls.push(input);
    return business({
      adminId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02',
      appId: APP,
      isSuper: false,
      loginName: 'a',
    });
  }
}

const ROW: AdminUserDeviceRow = {
  device_id: DEVICE,
  platform: 'ios',
  app_version: '1.2.0',
  created_at: REGISTERED,
  last_seen_at: SEEN,
  reverified_source: null,
  reverified_at: null,
};

function setup(rows: readonly AdminUserDeviceRow[], exists = true) {
  const guard = new FakeGuard();
  const calls: unknown[] = [];
  const store: AdminUserDeviceStore = {
    userExists: (input) => {
      calls.push(['userExists', input]);
      return Promise.resolve(exists);
    },
    page: (input) => {
      calls.push(['page', input]);
      return Promise.resolve({ items: rows, total: rows.length });
    },
  };
  const controller = new AdminUserDevicesController(guard, new AdminUserDevices(store));
  return { guard, calls, controller };
}

const request = { id: TRACE } as never;
const reply = () => {
  const headers: string[][] = [];
  return { headers, header: (name: string, value: string) => headers.push([name, value]) };
};

async function refusalOf(answer: Promise<unknown>) {
  const error: unknown = await answer.then(
    () => {
      throw new Error('expected a refusal');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HttpException);
  const refused = error as HttpException;
  return { status: refused.getStatus(), body: refused.getResponse() };
}

it('[AC-B1-02zz#U1] 只读：权限点 user.phone_change、readOnly，范围是操作人的 app，默认分页，no-store', async () => {
  const { guard, calls, controller } = setup([]);
  const http = reply();
  const answer = await controller.list(request, USER, {}, http);
  expect(guard.calls).toEqual([{ request, permission: 'user.phone_change', readOnly: true }]);
  expect(calls).toEqual([
    ['userExists', { appId: APP, userId: USER }],
    ['page', { appId: APP, userId: USER, page: 1, pageSize: 20 }],
  ]);
  expect(answer).toEqual({
    code: 0,
    msg: '',
    data: { items: [], page: 1, page_size: 20, total: 0 },
    trace_id: TRACE,
  });
  expect(http.headers).toEqual([['Cache-Control', 'no-store']]);
});

it('[AC-B1-02zz#U2] 一行恰好六个字段；有记录时 reverified 是 source 与时刻，多余的列不外泄', async () => {
  const leaking = { ...ROW, device_hash: 'a'.repeat(64) } as AdminUserDeviceRow;
  const recorded: AdminUserDeviceRow = {
    ...ROW,
    reverified_source: 'admin',
    reverified_at: RECORDED,
  };
  const { controller } = setup([leaking, recorded]);
  const answer = await controller.list(request, USER, { page: 2, page_size: 5 }, reply());
  const common = {
    device_id: DEVICE,
    platform: 'ios',
    app_version: '1.2.0',
    created_at: REGISTERED.toISOString(),
    last_seen_at: SEEN.toISOString(),
  };
  expect(answer.data).toEqual({
    items: [
      { ...common, reverified: null },
      { ...common, reverified: { source: 'admin', created_at: RECORDED.toISOString() } },
    ],
    page: 2,
    page_size: 5,
    total: 2,
  });
});

it('[AC-B1-02zz#U3] 未知 user_id：400 / 20001 [user_id]，不查设备', async () => {
  const { calls, controller } = setup([ROW], false);
  const refused = await refusalOf(controller.list(request, USER, {}, reply()));
  expect(refused.status).toBe(400);
  expect(refused.body).toMatchObject({ code: 20001, data: { fields: ['user_id'] } });
  expect(calls).toEqual([['userExists', { appId: APP, userId: USER }]]);
});

it.each(['not-a-uuid', 'a'.repeat(64)])(
  '[AC-B1-02zz#U4] user_id 不是 UUID（%s）：不碰库，20001 [user_id]',
  async (id) => {
    const { calls, controller } = setup([ROW]);
    const refused = await refusalOf(controller.list(request, id, {}, reply()));
    expect(refused.body).toMatchObject({ code: 20001, data: { fields: ['user_id'] } });
    expect(calls).toEqual([]);
  },
);
