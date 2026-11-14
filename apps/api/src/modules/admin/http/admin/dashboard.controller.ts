// B1-10w: GET /admin/v1/dashboard (adminGetDashboard, contracts/openapi.yaml; 编排 D10-1401 /
// D10-1402 / D10-1403 ③). Mounted only by AdminDashboardModule (../../admin.module.ts) on the admin
// entry. The admin request check has verified the admin_token before this runs; the operation guard
// re-reads the account and checks dashboard.view (read only, no step-up) and hands over the
// account's points, which only trim what is shown (../../application/dashboard.ts). Nothing is
// written, no audit row. The answer is no-store. Without the database the route still registers
// and every call fails closed (50001).
import { Controller, Get, HttpCode, Inject, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  type CheckedRequest,
} from '../../../platform/index.ts';
import { readAdminDashboard, type AdminDashboardDeps } from '../../application/dashboard.ts';

/** Nest token of the dashboard's read dependencies (null in a process without the database). */
export const ADMIN_DASHBOARD_DEPS = Symbol('ADMIN_DASHBOARD_DEPS');

/** specs/permissions.yaml: dashboard.view, step-up null. */
const VIEW = 'dashboard.view';

type DashboardResponse = Schema<'AdminDashboardResponse'>;

export interface AdminDashboardRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

export class AdminDashboardController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: AdminDashboardDeps | null;

  constructor(guard: AdminOperationGuard, deps: AdminDashboardDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  async get(request: AdminDashboardRequest, reply: HeaderReply): Promise<DashboardResponse> {
    reply.header('Cache-Control', 'no-store');
    let response: DashboardResponse | undefined;
    await this.#guard.run(
      { request, permission: VIEW, readOnly: true, withPermissions: true },
      async (actor) => {
        const deps = this.#deps;
        if (deps === null) throw new Error('admin: the dashboard needs the database');
        const data = await readAdminDashboard(deps, {
          appId: actor.appId,
          isSuper: actor.isSuper,
          permissions: actor.permissions ?? [],
        });
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      },
    );
    if (response === undefined) {
      throw new Error('admin: admin guard returned without an answer');
    }
    return response;
  }
}

// Plain decorator calls (no parameter decorators), as the other admin controllers.
{
  const prototype = AdminDashboardController.prototype;
  Inject(AdminOperationGuard)(AdminDashboardController, undefined, 0);
  Inject(ADMIN_DASHBOARD_DEPS)(AdminDashboardController, undefined, 1);
  const get = Object.getOwnPropertyDescriptor(prototype, 'get')!;
  Req()(prototype, 'get', 0);
  Res({ passthrough: true })(prototype, 'get', 1);
  Get('dashboard')(prototype, 'get', get);
  HttpCode(200)(prototype, 'get', get);
  RouteSchema(contractRouteSchema('adminGetDashboard'))(prototype, 'get', get);
  Controller('admin/v1')(AdminDashboardController);
}
