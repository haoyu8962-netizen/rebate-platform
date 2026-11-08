// Unit tests of the admin implementation of the platform AdminOperationGuard port over in-memory
// account reads and a recording permission guard; the assembled port runs against PG and Redis in
// the rule tests (test/spec/admin/guard-mount/**).
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { expect, it, vi } from 'vitest';
import { AdminOperationGuard, type AdminOperationResponse } from '../../platform/index.ts';
import type { AdminProfile, AdminProfiles } from '../infra/admin-profiles.ts';
import { AdminOperationGuardImpl } from './admin-operation-guard.ts';
import type { AdminPermissionGuard, AdminPermissionRequest } from './permission-guard.ts';

const OK: AdminOperationResponse = { statusCode: 200, body: { code: 0 } };

function setup(profile: Partial<AdminProfile> | null = {}, keys: readonly string[] = ['x.y']) {
  const adminId = randomUUID();
  const row: AdminProfile | undefined =
    profile === null
      ? undefined
      : {
          id: adminId,
          appId: 'couli',
          loginName: 'operator',
          isSuper: false,
          status: 'active',
          verifyPhoneCipher: null,
          ...profile,
        };
  const profiles: AdminProfiles = {
    byId: vi.fn(async (appId: string, id: string) =>
      row !== undefined && row.appId === appId && row.id === id ? row : undefined,
    ),
    permissionKeys: vi.fn(async () => keys),
  };
  const seen: AdminPermissionRequest[] = [];
  const guard: AdminPermissionGuard = {
    run: vi.fn(async (request: AdminPermissionRequest, business: () => Promise<typeof OK>) => {
      seen.push(request);
      return await business();
    }),
  };
  const port = new AdminOperationGuardImpl({ profiles: () => profiles, guard });
  const request = {
    id: 'trace-1',
    headers: { 'x-step-up-token': 'tok' },
    adminPrincipal: { adminId, appId: 'couli', sessionId: 'sess-1', isSuper: false },
  };
  return { adminId, profiles, guard, port, request, seen };
}

it('[AC-F1-06u-UNIT#1] passes the fresh account and grants to the F1-06l guard and the actor to business', async () => {
  const s = setup({ verifyPhoneCipher: Buffer.from('c') }, ['content.platform_icon']);
  const business = vi.fn(async () => OK);
  expect(s.port).toBeInstanceOf(AdminOperationGuard);
  const result = await s.port.run(
    { request: s.request, permission: 'content.platform_icon', operation: 'op' },
    business,
  );
  expect(result).toBe(OK);
  expect(business).toHaveBeenCalledExactlyOnceWith({
    adminId: s.adminId,
    appId: 'couli',
    isSuper: false,
    loginName: 'operator',
  });
  expect(s.seen[0]).toEqual({
    principal: {
      appId: 'couli',
      adminId: s.adminId,
      sessionId: 'sess-1',
      isSuper: false,
      permissions: ['content.platform_icon'],
      hasVerifyPhone: true,
    },
    permission: 'content.platform_icon',
    operation: 'op',
    headers: s.request.headers,
    traceId: 'trace-1',
  });
});

it('[AC-F1-06u-UNIT#2] a disabled or missing account is 10001 with the trace id, before the guard', async () => {
  for (const s of [setup({ status: 'disabled' }), setup(null)]) {
    const business = vi.fn(async () => OK);
    const error = await s.port.run({ request: s.request, permission: 'x.y' }, business).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(401);
    expect((error as HttpException).getResponse()).toMatchObject({
      code: 10001,
      trace_id: 'trace-1',
    });
    expect(s.guard.run).not.toHaveBeenCalled();
    expect(business).not.toHaveBeenCalled();
  }
});

it('[AC-F1-06u-UNIT#3] no verified principal or a failing database is a plain error (50001)', async () => {
  const s = setup();
  const business = vi.fn(async () => OK);
  const { adminPrincipal: _drop, ...bare } = s.request;
  void _drop;
  const missing = await s.port
    .run({ request: bare, permission: 'x.y' }, business)
    .catch((thrown: unknown) => thrown);
  expect(missing).toBeInstanceOf(Error);
  expect(missing).not.toBeInstanceOf(HttpException);
  expect(s.profiles.byId).not.toHaveBeenCalled();

  const down = new AdminOperationGuardImpl({
    profiles: () => {
      throw new Error('no database');
    },
    guard: s.guard,
  });
  await expect(down.run({ request: s.request, permission: 'x.y' }, business)).rejects.toThrow(
    'no database',
  );
  expect(business).not.toHaveBeenCalled();
});

it('[AC-B2-09zg-UNIT#1] withPermissions hands the points read now to business, a super admin as stored, and is not forwarded', async () => {
  for (const [profile, keys] of [
    [{}, ['user.lookup', 'fund.recon']],
    [{ isSuper: true }, []],
  ] as const) {
    const s = setup(profile, keys);
    const business = vi.fn(async () => OK);
    await s.port.run(
      { request: s.request, permission: 'user.lookup', readOnly: true, withPermissions: true },
      business,
    );
    expect(business).toHaveBeenCalledExactlyOnceWith({
      adminId: s.adminId,
      appId: 'couli',
      isSuper: profile.isSuper === true,
      loginName: 'operator',
      permissions: keys,
    });
    expect(s.seen[0]).not.toHaveProperty('withPermissions');
  }
});

it('[AC-F1-10c-UNIT#1] read-only requests forward the selection without accessing headers', async () => {
  const s = setup();
  const headers = vi.fn(() => {
    throw new Error('read-only operations must not access headers');
  });
  Object.defineProperty(s.request, 'headers', { get: headers });
  const business = vi.fn(async () => OK);
  const permission = ['switch.all', 'fund.adjust'] as const;
  expect(await s.port.run({ request: s.request, permission, readOnly: true }, business)).toBe(OK);
  expect(headers).not.toHaveBeenCalled();
  expect(s.seen[0]).toMatchObject({ permission, readOnly: true, headers: {} });
  expect(business).toHaveBeenCalledOnce();
});
