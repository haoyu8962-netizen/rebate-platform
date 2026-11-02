// GET /admin/v1/users/{user_id}/devices (adminListUserDevices, CT-26j, CT-26m; B1-02zz). Mounted only
// by IdentityAdminModule on the admin entry. The admin request check has verified the admin_token
// before this runs; the operation guard checks the account and user.phone_change. Read only: no
// step-up (X-Step-Up-Token is neither read nor consumed) and no audit record.
import { Controller, Get, HttpException, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  AdminUserDevices,
  type AdminUserDevicesQuery,
} from '../../application/admin-user-devices.ts';

interface DevicesRequest extends CheckedRequest {
  readonly id: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

type ListResponse = Schema<'AdminUserDevicePageResponse'>;

/** The same point as recording a re-verified device (contract, D10-513). */
const PERMISSION = 'user.phone_change';

export class AdminUserDevicesController {
  readonly #guard: AdminOperationGuard;
  readonly #devices: AdminUserDevices;

  constructor(guard: AdminOperationGuard, devices: AdminUserDevices) {
    this.#guard = guard;
    this.#devices = devices;
  }

  async list(
    request: DevicesRequest,
    userId: string,
    query: AdminUserDevicesQuery,
    reply: HeaderReply,
  ): Promise<ListResponse> {
    reply.header('Cache-Control', 'no-store');
    let response: ListResponse | undefined;
    await this.#guard.run({ request, permission: PERMISSION, readOnly: true }, async (actor) => {
      const result = await this.#devices.list(actor.appId, userId, query);
      if (result.code !== 0) {
        const refused = fieldsErrorEnvelope(result.data.fields, request.id);
        throw new HttpException(refused.body, refused.statusCode);
      }
      response = { code: 0, msg: '', data: result.data, trace_id: request.id };
      return { statusCode: 200, body: response };
    });
    if (response === undefined) {
      throw new Error('identity: admin guard returned without an answer');
    }
    return response;
  }
}

// Plain decorator calls, as the other identity admin controllers.
{
  const prototype = AdminUserDevicesController.prototype;
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Inject(AdminOperationGuard)(AdminUserDevicesController, undefined, 0);
  Inject(AdminUserDevices)(AdminUserDevicesController, undefined, 1);
  Req()(prototype, 'list', 0);
  Param('user_id')(prototype, 'list', 1);
  Query()(prototype, 'list', 2);
  Res({ passthrough: true })(prototype, 'list', 3);
  Get(':user_id/devices')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListUserDevices'))(prototype, 'list', list);
  Controller('admin/v1/users')(AdminUserDevicesController);
}
