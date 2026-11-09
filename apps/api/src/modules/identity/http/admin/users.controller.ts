import { Controller, Get, HttpException, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type AdminActor,
  type CheckedRequest,
} from '../../../platform/index.ts';
import { blankAdminUserDetail } from '../../application/admin-user-view.ts';
import {
  AdminUsers,
  AdminUsersFieldsError,
  type AdminUserListQuery,
  type AdminUserLookupQuery,
} from '../../application/admin-users.ts';

interface UsersRequest extends CheckedRequest {
  readonly id: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

/** Only mounted on admin; all three operations bypass step-up, never permission checks. */
export class AdminUsersController {
  constructor(
    private readonly guard: AdminOperationGuard,
    private readonly users: AdminUsers,
  ) {}

  list(
    request: UsersRequest,
    query: AdminUserListQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminUserPageResponse'>> {
    return this.run(request, reply, 'user.list', false, (actor) =>
      this.users.list(actor.appId, query),
    );
  }

  lookup(
    request: UsersRequest,
    query: AdminUserLookupQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminUserDetailResponse'>> {
    return this.run(request, reply, 'user.lookup', true, async (actor) =>
      blankAdminUserDetail(await this.users.lookup(actor.appId, query), actor),
    );
  }

  detail(
    request: UsersRequest,
    userId: string,
    reply: HeaderReply,
  ): Promise<Schema<'AdminUserDetailResponse'>> {
    return this.run(request, reply, ['user.list', 'user.lookup'], true, async (actor) =>
      blankAdminUserDetail(await this.users.detail(actor.appId, userId), actor),
    );
  }

  private async run<T>(
    request: UsersRequest,
    reply: HeaderReply,
    permission: string | readonly string[],
    withPermissions: boolean,
    read: (actor: AdminActor) => Promise<T>,
  ): Promise<{ code: 0; msg: string; data: T; trace_id: string }> {
    reply.header('Cache-Control', 'no-store');
    let response: { code: 0; msg: string; data: T; trace_id: string } | undefined;
    await this.guard.run(
      { request, permission, readOnly: true, withPermissions },
      async (actor) => {
        try {
          response = { code: 0, msg: '', data: await read(actor), trace_id: request.id };
          return { statusCode: 200, body: response };
        } catch (error) {
          if (!(error instanceof AdminUsersFieldsError)) throw error;
          const refused = fieldsErrorEnvelope(error.fields, request.id);
          throw new HttpException(
            {
              ...refused.body,
              data: {
                ...refused.body.data,
                ...(error.reason === undefined ? {} : { reason: error.reason }),
              },
            },
            refused.statusCode,
          );
        }
      },
    );
    if (response === undefined) throw new Error('identity: admin guard returned without an answer');
    return response;
  }
}

{
  const prototype = AdminUsersController.prototype;
  Inject(AdminOperationGuard)(AdminUsersController, undefined, 0);
  Inject(AdminUsers)(AdminUsersController, undefined, 1);
  for (const [method, path, operation] of [
    ['list', '', 'adminListUsers'],
    ['lookup', 'lookup', 'adminLookupUser'],
    ['detail', ':user_id', 'adminGetUser'],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method)!;
    Req()(prototype, method, 0);
    if (method === 'detail') Param('user_id')(prototype, method, 1);
    else Query()(prototype, method, 1);
    Res({ passthrough: true })(prototype, method, 2);
    Get(path)(prototype, method, descriptor);
    RouteSchema(contractRouteSchema(operation))(prototype, method, descriptor);
  }
  Controller('admin/v1/users')(AdminUsersController);
}
