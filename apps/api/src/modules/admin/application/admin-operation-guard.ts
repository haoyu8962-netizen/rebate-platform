// admin's implementation of the platform AdminOperationGuard port (F1-06u; ruling §9.2 #3, #4).
// It adapts the verified request and the account as read now to createAdminPermissionGuard
// (./permission-guard.ts, F1-06l), which keeps the order of the checks and the token handling:
//   1. the admin principal the admin token check attached (platform/http/admin-context.ts); none
//      means the route is not x-auth admin / super, a programming error → 50001;
//   2. admin_users by (app_id, id), every call (no cache): missing or status not active → 10001,
//      so an account disabled between the token check and this read cannot act;
//   3. admin_permissions ticked for the account, every call: a revoked point applies at once;
//   4. the permission guard (10403, tier, 10003, claim / consume of X-Step-Up-Token);
//   5. business(actor), actor.loginName from the row read in 2.
// A failing database or Redis throws a plain error: the global error handling answers 50001.
//
// Pure module apart from Nest's HttpException (no decorators).
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import {
  AdminOperationGuard,
  adminPrincipal,
  type AdminActor,
  type AdminOperationInput,
  type AdminOperationResponse,
} from '../../platform/index.ts';
import type { AdminProfiles } from '../infra/admin-profiles.ts';
import { ADMIN_MESSAGES } from './admin-check.ts';
import { ADMIN_ACTIVE_STATUS } from './admin-login.ts';
import type { AdminPermissionGuard, AdminPermissionRequest } from './permission-guard.ts';

export interface AdminOperationGuardDeps {
  /** Account reads; throws when this process has no database (→ 50001). */
  readonly profiles: () => AdminProfiles;
  /** F1-06l's guard over the `admin-step-up` namespace (fails per request without Redis). */
  readonly guard: AdminPermissionGuard;
}

interface RequestShape {
  readonly id?: unknown;
  readonly headers?: unknown;
}

function traceIdOf(request: object): string {
  const id = (request as RequestShape).id;
  return typeof id === 'string' && id.length > 0 ? id : randomUUID();
}

function headersOf(request: object): AdminPermissionRequest['headers'] {
  const headers = (request as RequestShape).headers;
  return typeof headers === 'object' && headers !== null
    ? (headers as AdminPermissionRequest['headers'])
    : {};
}

function unauthenticated(traceId: string): HttpException {
  return new HttpException({ code: 10001, msg: ADMIN_MESSAGES[10001], trace_id: traceId }, 401);
}

export class AdminOperationGuardImpl extends AdminOperationGuard {
  readonly #deps: AdminOperationGuardDeps;

  constructor(deps: AdminOperationGuardDeps) {
    super();
    this.#deps = deps;
  }

  override async run(
    input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse> {
    const { request, permission, operation, readOnly, withPermissions } = input;
    const principal = adminPrincipal(request);
    if (principal === undefined) {
      // Not a client error: a business route that is not x-auth admin / super used the guard.
      throw new Error('admin operation guard: no verified admin principal on this request');
    }
    const traceId = traceIdOf(request);
    const profiles = this.#deps.profiles();
    const profile = await profiles.byId(principal.appId, principal.adminId);
    if (profile === undefined || profile.status !== ADMIN_ACTIVE_STATUS) {
      throw unauthenticated(traceId);
    }
    const permissions = await profiles.permissionKeys(principal.appId, principal.adminId);
    const actor: AdminActor = {
      adminId: profile.id,
      appId: profile.appId,
      isSuper: profile.isSuper,
      loginName: profile.loginName,
      ...(withPermissions === true ? { permissions } : {}),
    };
    return await this.#deps.guard.run(
      {
        principal: {
          appId: profile.appId,
          adminId: profile.id,
          sessionId: principal.sessionId,
          isSuper: profile.isSuper,
          permissions,
          hasVerifyPhone: profile.verifyPhoneCipher !== null,
        },
        permission,
        ...(operation === undefined ? {} : { operation }),
        ...(readOnly === undefined ? {} : { readOnly }),
        headers: readOnly === true ? {} : headersOf(request),
        traceId,
      },
      () => business(actor),
    );
  }
}
