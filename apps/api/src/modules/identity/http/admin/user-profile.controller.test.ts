// Unit tests of PATCH /admin/v1/users/{user_id}/profile's controller (B1-27b): the guard input,
// the refusal envelopes, the "neither field" check before the guard, and the mounted route schema
// (the contract's, without the body's minProperties).
import { HttpException } from '@nestjs/common';
import { expect, it } from 'vitest';
import {
  AdminOperationGuard,
  contractRouteSchema,
  type AdminActor,
  type AdminOperationInput,
  type AdminOperationResponse,
} from '../../../platform/index.ts';
import type {
  AdminProfileEdit,
  AdminProfileEditCommand,
  AdminProfileEditResult,
} from '../../application/admin-profile-edit.ts';
import { AdminUsersFieldsError, type AdminUsers } from '../../application/admin-users.ts';
import { AdminUserProfileController } from './user-profile.controller.ts';

const APP = 'b1-27b-ctrl';
const ADMIN = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02';
const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';
const TRACE = 'trace-b1-27b';
const REASON = '企业微信核对注册时间';

class FakeGuard extends AdminOperationGuard {
  readonly calls: AdminOperationInput[] = [];
  readonly outcomes: string[] = [];
  access: Pick<AdminActor, 'isSuper' | 'permissions'> = {
    isSuper: false,
    permissions: ['user.phone_change'],
  };

  override async run(
    input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse> {
    this.calls.push(input);
    try {
      const result = await business({
        adminId: ADMIN,
        appId: APP,
        loginName: 'a',
        ...this.access,
      });
      this.outcomes.push('consumed');
      return result;
    } catch (error) {
      this.outcomes.push('released');
      throw error;
    }
  }
}

const DETAIL = {
  user_id: USER,
  nickname: '小狸',
  phone_masked: '199****0002',
  risk: { state: 'frozen', reason_category: 'other', reason: '风控内部说明', row_version: 3 },
};
const BLANKED = { ...DETAIL, risk: { ...DETAIL.risk, reason: null } };

function setup(
  result: AdminProfileEditResult,
  detail: () => Promise<unknown> = async () => DETAIL,
) {
  const guard = new FakeGuard();
  const commands: AdminProfileEditCommand[] = [];
  const profiles = {
    edit: (command: AdminProfileEditCommand) => {
      commands.push(command);
      return Promise.resolve(result);
    },
  } as unknown as AdminProfileEdit;
  const users = { detail: () => detail() } as unknown as AdminUsers;
  const headers: Record<string, string> = {};
  const reply = { header: (name: string, value: string) => (headers[name] = value) };
  const controller = new AdminUserProfileController(guard, profiles, users);
  const request = { id: TRACE, ip: '127.0.0.1' } as never;
  return { guard, commands, controller, request, reply, headers };
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(HttpException);
  const exception = error as HttpException;
  return { status: exception.getStatus(), body: exception.getResponse() };
}

it('[AC-B1-27b#5] 保存成功：守卫按 user.phone_change（totp）跑、身份取自守卫，回保存后的详情', async () => {
  const s = setup({ code: 0 });
  const body = { phone: '19900000002', nickname: '小狸', reason: REASON };
  const response = await s.controller.edit(s.request, USER, body, s.reply);
  expect(response).toEqual({ code: 0, msg: '', data: BLANKED, trace_id: TRACE });
  expect(s.guard.calls).toHaveLength(1);
  expect(s.guard.calls[0]).toMatchObject({ permission: 'user.phone_change' });
  expect(s.guard.calls[0]?.readOnly).toBeUndefined();
  expect(s.guard.outcomes).toEqual(['consumed']);
  expect(s.commands).toEqual([{ appId: APP, adminId: ADMIN, ip: '127.0.0.1', userId: USER, body }]);
  expect(s.headers['Cache-Control']).toBe('no-store');
});

it('[AC-B1-10p#101] 编辑向守卫要权限点（仍是写操作，不带 readOnly），无 risk.* 时置空 risk.reason', async () => {
  const s = setup({ code: 0 });
  const answer = await s.controller.edit(s.request, USER, { nickname: '小狸', reason: REASON });
  expect(s.guard.calls[0]).toMatchObject({
    permission: 'user.phone_change',
    withPermissions: true,
  });
  expect(s.guard.calls[0]).not.toHaveProperty('readOnly');
  expect(answer.data).toEqual(BLANKED);
  expect(s.guard.outcomes).toEqual(['consumed']);
});

it.each<[string, Pick<AdminActor, 'isSuper' | 'permissions'>, unknown]>([
  ['risk.freeze', { isSuper: false, permissions: ['user.phone_change', 'risk.freeze'] }, DETAIL],
  ['risk.appeal', { isSuper: false, permissions: ['user.phone_change', 'risk.appeal'] }, DETAIL],
  ['超管', { isSuper: true, permissions: [] }, DETAIL],
  ['config.risk 不是 risk.* 点', { isSuper: false, permissions: ['config.risk'] }, BLANKED],
  ['权限点缺失', { isSuper: false }, BLANKED],
])('[AC-B1-10p#102] 回读详情的 risk.reason：%s', async (_name, access, expected) => {
  const s = setup({ code: 0 });
  s.guard.access = access;
  const answer = await s.controller.edit(s.request, USER, { nickname: '小狸', reason: REASON });
  expect(answer.data).toEqual(expected);
});

it('[AC-B1-27b#9] phone 与 nickname 都没给：守卫之前 20001 [phone, nickname]，不调用服务', async () => {
  const s = setup({ code: 0 });
  const refused = await refusal(s.controller.edit(s.request, USER, { reason: REASON }, s.reply));
  expect(refused).toEqual({
    status: 400,
    body: {
      code: 20001,
      msg: expect.any(String),
      data: { fields: ['phone', 'nickname'] },
      trace_id: TRACE,
    },
  });
  expect(s.guard.calls).toEqual([]);
  expect(s.commands).toEqual([]);
});

it.each<[AdminProfileEditResult, number, object | undefined]>([
  [{ code: 20001, data: { fields: ['user_id'] } }, 400, { fields: ['user_id'] }],
  [
    { code: 20001, data: { fields: ['phone'], reason: 'phone_invalid' } },
    400,
    { fields: ['phone'], reason: 'phone_invalid' },
  ],
  [
    { code: 20001, data: { fields: ['nickname'], reason: 'nickname_sensitive' } },
    400,
    { fields: ['nickname'], reason: 'nickname_sensitive' },
  ],
  [{ code: 30411 }, 422, undefined],
  [{ code: 44001 }, 403, undefined],
])(
  '[AC-B1-27b#19] 服务拒绝 %j → HTTP %i，信封按契约，30411 / 44001 不带 data；令牌不消耗',
  async (result, status, data) => {
    const s = setup(result);
    const refused = await refusal(
      s.controller.edit(s.request, USER, { nickname: '小狸', reason: REASON }, s.reply),
    );
    expect(refused.status).toBe(status);
    expect(refused.body).toEqual({
      code: result.code,
      msg: expect.any(String),
      ...(data === undefined ? {} : { data }),
      trace_id: TRACE,
    });
    expect(s.guard.outcomes).toEqual(['released']);
  },
);

it('[AC-B1-27b#14] 保存后读详情不到（并发注销等）→ 20001 [user_id]', async () => {
  const s = setup({ code: 0 }, () => Promise.reject(new AdminUsersFieldsError(['user_id'])));
  const refused = await refusal(
    s.controller.edit(s.request, USER, { nickname: '小狸', reason: REASON }, s.reply),
  );
  expect(refused.status).toBe(400);
  expect(refused.body).toMatchObject({ code: 20001, data: { fields: ['user_id'] } });
});

it('[AC-B1-27b#1] 挂载的路由 schema 是契约的，只去掉 body 的 minProperties（其余校验不变）', () => {
  const contract = contractRouteSchema('adminEditUserProfile') as {
    params: unknown;
    headers?: unknown;
    body: Record<string, unknown>;
  };
  // @nestjs/platform-fastify's FASTIFY_ROUTE_SCHEMA_METADATA (not on the package's public entry).
  const mounted = Reflect.getMetadata(
    '__fastify_route_schema__',
    AdminUserProfileController.prototype.edit,
  ) as { params: unknown; headers?: unknown; body: Record<string, unknown> } | undefined;
  expect(contract.body['minProperties']).toBe(2);
  expect(mounted).toBeDefined();
  expect(mounted!.params).toEqual(contract.params);
  expect(mounted!.headers).toEqual(contract.headers);
  const { minProperties, ...rest } = contract.body;
  void minProperties;
  expect(mounted!.body).toEqual(rest);
  expect(mounted!.body['additionalProperties']).toBe(false);
  expect(mounted!.body['required']).toEqual(['reason']);
});
