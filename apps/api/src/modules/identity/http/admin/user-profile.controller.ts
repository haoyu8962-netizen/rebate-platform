// PATCH /admin/v1/users/{user_id}/profile (adminEditUserProfile; BR-ID-44 细则, BR-ID-39 细则「后台改
// 昵称」, B1-27b). Mounted only by IdentityAdminModule on the admin entry. The admin request check has
// verified the admin_token and the route schema the body before this runs; the operation guard
// checks the account, user.phone_change and its totp step-up, and consumes the step-up token only
// after a 200 with code 0. The answer is the user as GET /admin/v1/users/{user_id} returns it after
// the save (AdminUsers.detail), phone number masked, risk.reason blanked like that read for an
// account holding no risk point (B1-10p, D10-1048 ①; only the answer narrows).
//
// The route schema is the contract's, except that the body's `minProperties: 2` is checked here
// (before the guard, like a schema failure): the generic validator would name the whole body,
// while the contract names `phone` and `nickname` when neither is given and `reason` alone when
// only the reason is missing. Refusals are thrown inside the guard so a refused save never uses
// up the step-up token.
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Patch,
  Req,
  Res,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  AdminProfileEdit,
  type AdminProfileEditResult,
} from '../../application/admin-profile-edit.ts';
import { blankAdminUserDetail } from '../../application/admin-user-view.ts';
import { AdminUsers, AdminUsersFieldsError } from '../../application/admin-users.ts';

interface ProfileRequest extends CheckedRequest {
  readonly id: string;
  readonly ip?: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

type EditBody = Schema<'AdminUserProfileEditRequest'>;
type EditResponse = Schema<'AdminUserDetailResponse'>;

/** specs/permissions.yaml: totp tier; covers the nickname as well (contract). */
const PERMISSION = 'user.phone_change';

/** Fallback texts of the refusals the service answers (contracts/error-codes.yaml statuses). */
const REFUSALS = {
  30411: { status: 422, msg: '该手机号已被其他账号占用' },
  44001: { status: 403, msg: '该手机号不能使用' },
} as const;

/** The contract body schema without `minProperties`, which the controller checks itself. */
function bodySchemaWithoutMinProperties() {
  const contract = contractRouteSchema('adminEditUserProfile');
  const { minProperties, ...body } = contract.body as Record<string, unknown>;
  void minProperties;
  return { ...contract, body };
}

export class AdminUserProfileController {
  readonly #guard: AdminOperationGuard;
  readonly #profiles: AdminProfileEdit;
  readonly #users: AdminUsers;

  constructor(guard: AdminOperationGuard, profiles: AdminProfileEdit, users: AdminUsers) {
    this.#guard = guard;
    this.#profiles = profiles;
    this.#users = users;
  }

  async edit(
    request: ProfileRequest,
    userId: string,
    body: EditBody,
    reply?: HeaderReply,
  ): Promise<EditResponse> {
    reply?.header('Cache-Control', 'no-store');
    if (body.phone === undefined && body.nickname === undefined) {
      throw refusal(fieldsErrorEnvelope(['phone', 'nickname'], request.id));
    }
    let response: EditResponse | undefined;
    await this.#guard.run(
      { request, permission: PERMISSION, withPermissions: true },
      async (actor) => {
        const result = await this.#profiles.edit({
          appId: actor.appId,
          adminId: actor.adminId,
          ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
          userId,
          body: {
            reason: body.reason,
            ...(body.phone === undefined ? {} : { phone: body.phone }),
            ...(body.nickname === undefined ? {} : { nickname: body.nickname }),
          },
        });
        if (result.code !== 0) throw rejected(result, request.id);
        let data: Schema<'AdminUserDetail'>;
        try {
          data = blankAdminUserDetail(await this.#users.detail(actor.appId, userId), actor);
        } catch (error) {
          if (error instanceof AdminUsersFieldsError) {
            throw refusal(fieldsErrorEnvelope(error.fields, request.id));
          }
          throw error;
        }
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      },
    );
    if (response === undefined) {
      throw new Error('identity: admin guard returned without an answer');
    }
    return response;
  }
}

function refusal(envelope: { statusCode: number; body: object }): HttpException {
  return new HttpException(envelope.body, envelope.statusCode);
}

function rejected(
  result: Exclude<AdminProfileEditResult, { code: 0 }>,
  traceId: string,
): HttpException {
  if (result.code === 20001) {
    const refused = fieldsErrorEnvelope(result.data.fields, traceId);
    return new HttpException(
      { ...refused.body, data: { ...refused.body.data, ...withReason(result.data) } },
      refused.statusCode,
    );
  }
  // 30411 never carries mergeable; 44001 here carries no risk_msg_code (no appeal, task §9).
  const { status, msg } = REFUSALS[result.code];
  return new HttpException({ code: result.code, msg, trace_id: traceId }, status);
}

function withReason(data: object): { reason?: string } {
  return 'reason' in data && typeof data.reason === 'string' ? { reason: data.reason } : {};
}

// Plain decorator calls, as the other identity admin controllers.
{
  const prototype = AdminUserProfileController.prototype;
  const edit = Object.getOwnPropertyDescriptor(prototype, 'edit')!;
  Inject(AdminOperationGuard)(AdminUserProfileController, undefined, 0);
  Inject(AdminProfileEdit)(AdminUserProfileController, undefined, 1);
  Inject(AdminUsers)(AdminUserProfileController, undefined, 2);
  Req()(prototype, 'edit', 0);
  Param('user_id')(prototype, 'edit', 1);
  Body()(prototype, 'edit', 2);
  Res({ passthrough: true })(prototype, 'edit', 3);
  Patch(':user_id/profile')(prototype, 'edit', edit);
  HttpCode(200)(prototype, 'edit', edit);
  RouteSchema(bodySchemaWithoutMinProperties())(prototype, 'edit', edit);
  Controller('admin/v1/users')(AdminUserProfileController);
}
