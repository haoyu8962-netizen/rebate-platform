// POST /admin/v1/users/{user_id}/reverified-devices (adminAddUserReverifiedDevice, CT-26j; BR-WDR-01
// 细则「清除标记只走人工」; B1-02zx). Mounted only by IdentityAdminModule on the admin entry. The admin
// request check has verified the admin_token before this runs; the operation guard checks the
// account, user.phone_change and its totp step-up, and consumes the step-up token only after a 200
// with code 0. Refusals are thrown inside the guard so a refused request never uses up the token.
// No Idempotency-Key (04 §6.6).
//
// The contract answers the permission and the step-up ahead of the body, so the route mounts no
// schema (a route schema runs before the guard): the contract's body schema is compiled here and
// run inside the guard, the way platform's validator compiler does it for a body (Ajv 2020, strict,
// all errors, no coercion) and with the field names of its validationErrorEnvelope. user_id needs
// no schema of its own: the service refuses anything that is not a UUID.
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Schema } from '@couli/contracts-ts';
import type { ErrorObject } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  AdminReverifiedDevices,
  type AdminReverifiedDeviceResult,
} from '../../application/admin-reverified-device.ts';

interface RecordRequest extends CheckedRequest {
  readonly id: string;
  readonly ip?: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

type RecordBody = Schema<'AdminReverifiedDeviceRequest'>;
type RecordResponse = Schema<'AdminReverifiedDeviceResponse'>;

/** specs/permissions.yaml: totp tier; the nearest existing point (contract, D10-513). */
const PERMISSION = 'user.phone_change';

/** contracts/error-codes.yaml status and contracts/texts.default.json text of 30419. */
const NOT_ACCEPTED = { status: 422, msg: '该用户当前不受理这项代办' };

const validBody = new Ajv2020({ strict: true, allErrors: true }).compile<RecordBody>(
  contractRouteSchema('adminAddUserReverifiedDevice').body,
);

/** The body is flat: a field is a top-level name, 'body' when the value is not an object. */
function fieldOf(error: ErrorObject): string {
  const named: unknown =
    error.keyword === 'required'
      ? error.params['missingProperty']
      : error.keyword === 'additionalProperties'
        ? error.params['additionalProperty']
        : undefined;
  if (typeof named === 'string') return named;
  return error.instancePath === '' ? 'body' : error.instancePath.slice(1);
}

export class AdminUserReverifiedDevicesController {
  readonly #guard: AdminOperationGuard;
  readonly #devices: AdminReverifiedDevices;

  constructor(guard: AdminOperationGuard, devices: AdminReverifiedDevices) {
    this.#guard = guard;
    this.#devices = devices;
  }

  async record(
    request: RecordRequest,
    userId: string,
    body: unknown,
    reply?: HeaderReply,
  ): Promise<RecordResponse> {
    reply?.header('Cache-Control', 'no-store');
    let response: RecordResponse | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      if (!validBody(body)) {
        const fields = new Set((validBody.errors ?? []).map(fieldOf));
        throw refusal(fieldsErrorEnvelope([...fields], request.id));
      }
      const result = await this.#devices.record({
        appId: actor.appId,
        adminId: actor.adminId,
        ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
        userId,
        deviceId: body.device_id,
        reason: body.reason,
      });
      if (result.code !== 0) throw rejected(result, request.id);
      response = { code: 0, msg: '', data: { ...result.data }, trace_id: request.id };
      return { statusCode: 200, body: response };
    });
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
  result: Exclude<AdminReverifiedDeviceResult, { code: 0 }>,
  traceId: string,
): HttpException {
  if (result.code === 20001) return refusal(fieldsErrorEnvelope(result.data.fields, traceId));
  return new HttpException(
    { code: 30419, msg: NOT_ACCEPTED.msg, data: { ...result.data }, trace_id: traceId },
    NOT_ACCEPTED.status,
  );
}

// Plain decorator calls, as the other identity admin controllers.
{
  const prototype = AdminUserReverifiedDevicesController.prototype;
  const record = Object.getOwnPropertyDescriptor(prototype, 'record')!;
  Inject(AdminOperationGuard)(AdminUserReverifiedDevicesController, undefined, 0);
  Inject(AdminReverifiedDevices)(AdminUserReverifiedDevicesController, undefined, 1);
  Req()(prototype, 'record', 0);
  Param('user_id')(prototype, 'record', 1);
  Body()(prototype, 'record', 2);
  Res({ passthrough: true })(prototype, 'record', 3);
  Post(':user_id/reverified-devices')(prototype, 'record', record);
  HttpCode(200)(prototype, 'record', record);
  Controller('admin/v1/users')(AdminUserReverifiedDevicesController);
}
