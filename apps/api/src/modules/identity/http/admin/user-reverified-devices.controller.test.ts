// Unit tests of POST /admin/v1/users/{user_id}/reverified-devices' controller and of the checks of
// AdminReverifiedDevices that need no database (B1-02zx): the guard input, the body inside the
// guard, the refusal envelopes, and that a refused request keeps the step-up token.
import { HttpException } from '@nestjs/common';
import { expect, it } from 'vitest';
import {
  AdminOperationGuard,
  type AdminActor,
  type AdminOperationInput,
  type AdminOperationResponse,
} from '../../../platform/index.ts';
import {
  AdminReverifiedDevices,
  type AdminReverifiedDeviceCommand,
  type AdminReverifiedDeviceResult,
  type AdminReverifiedDevicesOptions,
} from '../../application/admin-reverified-device.ts';
import { AdminUserReverifiedDevicesController } from './user-reverified-devices.controller.ts';

const APP = 'b1-02zx-ctrl';
const ADMIN = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02';
const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';
const DEVICE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a60';
const TRACE = 'trace-b1-02zx';
const REASON = '企业微信核对注册时间';
const BODY = { device_id: DEVICE, reason: REASON };

class FakeGuard extends AdminOperationGuard {
  readonly calls: AdminOperationInput[] = [];
  readonly outcomes: string[] = [];

  override async run(
    input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse> {
    this.calls.push(input);
    try {
      const result = await business({ adminId: ADMIN, appId: APP, isSuper: false, loginName: 'a' });
      this.outcomes.push('consumed');
      return result;
    } catch (error) {
      this.outcomes.push('released');
      throw error;
    }
  }
}

function setup(result: AdminReverifiedDeviceResult) {
  const guard = new FakeGuard();
  const commands: AdminReverifiedDeviceCommand[] = [];
  const devices = {
    record: (command: AdminReverifiedDeviceCommand) => {
      commands.push(command);
      return Promise.resolve(result);
    },
  } as unknown as AdminReverifiedDevices;
  return { guard, commands, controller: new AdminUserReverifiedDevicesController(guard, devices) };
}

const DONE: AdminReverifiedDeviceResult = {
  code: 0,
  data: {
    user_id: USER,
    device_id: DEVICE,
    source: 'admin',
    created: true,
    created_at: '2026-11-03T02:00:00.000Z',
  },
};

const request = { id: TRACE, ip: '192.0.2.1' } as never;

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

it('[AC-B1-02zx#U1] 成功：权限点 user.phone_change，用例收到操作人与提交的字段，令牌被消费，no-store', async () => {
  const { guard, commands, controller } = setup(DONE);
  const headers: string[][] = [];
  const reply = { header: (name: string, value: string) => headers.push([name, value]) };
  const answer = await controller.record(request, USER, BODY, reply);
  expect(guard.calls[0]).toMatchObject({ permission: 'user.phone_change' });
  expect(guard.calls[0]).not.toHaveProperty('readOnly');
  expect(commands).toEqual([
    {
      appId: APP,
      adminId: ADMIN,
      ip: '192.0.2.1',
      userId: USER,
      deviceId: DEVICE,
      reason: REASON,
    },
  ]);
  expect(answer).toEqual({ code: 0, msg: '', data: DONE.data, trace_id: TRACE });
  expect(guard.outcomes).toEqual(['consumed']);
  expect(headers).toEqual([['Cache-Control', 'no-store']]);
});

it.each([
  { body: undefined, fields: ['body'] },
  { body: [], fields: ['body'] },
  { body: { reason: REASON }, fields: ['device_id'] },
  { body: { device_id: DEVICE }, fields: ['reason'] },
  { body: { device_id: 1, reason: null }, fields: ['device_id', 'reason'] },
  { body: { ...BODY, source: 'self' }, fields: ['source'] },
  { body: { ...BODY, reason: '核'.repeat(201) }, fields: ['reason'] },
])('[AC-B1-02zx#U2] 请求体按契约在守卫内校验：$fields，用例不被调用，令牌留着', async (entry) => {
  const { guard, commands, controller } = setup(DONE);
  const refused = await refusalOf(controller.record(request, USER, entry.body));
  expect(refused.status).toBe(400);
  expect(refused.body).toMatchObject({ code: 20001, data: { fields: entry.fields } });
  expect(guard.calls).toHaveLength(1);
  expect(commands).toEqual([]);
  expect(guard.outcomes).toEqual(['released']);
});

it.each([
  { data: { reason: 'account_deleted' } as const },
  { data: { reason: 'reverify_not_pending' } as const },
  { data: { reason: 'account_deleting', stage: 'processing' } as const },
])('[AC-B1-02zx#U3] 30419 $data.reason：422，data 原样，令牌留着', async ({ data }) => {
  const { guard, controller } = setup({ code: 30419, data });
  const refused = await refusalOf(controller.record(request, USER, BODY));
  expect(refused.status).toBe(422);
  expect(refused.body).toEqual({
    code: 30419,
    msg: '该用户当前不受理这项代办',
    data,
    trace_id: TRACE,
  });
  expect(guard.outcomes).toEqual(['released']);
});

it('[AC-B1-02zx#U4] 用例的 20001 走统一信封，令牌留着', async () => {
  const { guard, controller } = setup({ code: 20001, data: { fields: ['device_id'] } });
  const refused = await refusalOf(controller.record(request, USER, BODY));
  expect(refused.status).toBe(400);
  expect(refused.body).toMatchObject({ code: 20001, data: { fields: ['device_id'] } });
  expect(guard.outcomes).toEqual(['released']);
});

/** A service whose database must not be reached: each case is decided before any statement. */
function offline() {
  const options = {
    db: {
      transaction: () => {
        throw new Error('no statement may run for these requests');
      },
    },
    clock: { now: () => new Date(0) },
    logger: { info: () => undefined },
    auditOn: () => {
      throw new Error('no audit record for these requests');
    },
  } as unknown as AdminReverifiedDevicesOptions;
  return new AdminReverifiedDevices(options);
}

const COMMAND: AdminReverifiedDeviceCommand = {
  appId: APP,
  adminId: ADMIN,
  ip: null,
  userId: USER,
  deviceId: DEVICE,
  reason: REASON,
};

it.each([
  { patch: { reason: ' \t\n' }, fields: ['reason'] },
  { patch: { reason: '　　' }, fields: ['reason'] },
  { patch: { deviceId: 'not-a-uuid' }, fields: ['device_id'] },
  { patch: { userId: 'not-a-uuid' }, fields: ['user_id'] },
  // The body comes first: device_id is named, not the unusable user_id.
  { patch: { userId: 'not-a-uuid', deviceId: 'nope' }, fields: ['device_id'] },
])(
  '[AC-B1-02zx#U5] $fields：不开事务、不写审计，直接 20001（$patch）',
  async ({ patch, fields }) => {
    const result = await offline().record({ ...COMMAND, ...patch });
    expect(result).toEqual({ code: 20001, data: { fields } });
  },
);
