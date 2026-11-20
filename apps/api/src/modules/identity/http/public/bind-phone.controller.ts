import { Controller, Inject, Optional, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  IDEMPOTENCY,
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
  type HandlerResult,
  type Idempotency,
} from '../../../platform/index.ts';
import {
  BindPhoneBlocked,
  type BindPhoneResult,
  type BindPhoneService,
} from '../../application/bind-phone.ts';
import { PHONE_CHANGE_DISABLED_MSG } from '../../application/phone-change-switch.ts';
import { withStepUp } from '../../application/step-up-verify.ts';
import { BIND_PHONE } from '../../application/tokens.ts';

interface BindPhoneRequest extends CheckedRequest {
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Schema<'BindPhoneRequest'>;
}

interface RawReply {
  code(status: number): RawReply;
  type(contentType: string): RawReply;
  send(body: string): unknown;
}

const ERRORS = {
  10002: { status: 401, msg: 'access_token 过期' },
  10003: { status: 403, msg: '为保障资金安全，请先完成短信验证' },
  20001: { status: 400, msg: '请输入 11 位中国大陆手机号' },
  20002: { status: 400, msg: '验证码错误，请重新输入' },
  20003: { status: 400, msg: '验证码已失效，请重新获取' },
  30411: { status: 422, msg: '该手机号已注册，可退出后用手机号登录' },
  30414: { status: 422, msg: PHONE_CHANGE_DISABLED_MSG },
  44001: { status: 403, msg: '操作未通过安全校验' },
  50001: { status: 500, msg: '服务端错误' },
} as const;

function response(result: BindPhoneResult, traceId: string): HandlerResult {
  if (result.code === 0) {
    const envelope: Schema<'EmptyResponse'> = { code: 0, msg: '', data: {}, trace_id: traceId };
    return { status: 200, envelope };
  }
  const error = ERRORS[result.code];
  // 20001 without a reason: the new number equals the current one (a change, B1-20b).
  const msg =
    result.code === 20001 && !('reason' in result.data) ? '填写内容有误，请检查' : error.msg;
  return {
    status: error.status,
    envelope: {
      code: result.code,
      msg,
      trace_id: traceId,
      ...('data' in result && result.data !== undefined ? { data: result.data } : {}),
    },
  };
}

@Controller('v1')
export class BindPhoneController {
  constructor(
    @Inject(BIND_PHONE) private readonly phones: BindPhoneService | null,
    @Optional() @Inject(IDEMPOTENCY) private readonly idempotency?: Idempotency,
  ) {}

  @Post('me/phone')
  @RouteSchema(contractRouteSchema('bindPhone'))
  async bind(@Req() request: BindPhoneRequest, @Res() reply: RawReply): Promise<void> {
    const principal = tokenPrincipal(request);
    const device = request.verifiedDevice;
    if (
      principal === undefined ||
      device === undefined ||
      this.phones === null ||
      this.idempotency === undefined
    ) {
      throw new Error('identity: bind phone needs storage and a verified token and device');
    }
    const phones = this.phones;
    const key = request.headers['idempotency-key'];
    const idempotency = this.idempotency;
    try {
      // Stage ⑫ judges the phone_change step_up_token inside the claim only for an account that
      // already has a phone (step-up-verify.ts); a first binding passes without one. The token is
      // consumed only for code 0 (B1-20b, BR-ID-08).
      // B1-20b (Codex money r1 S0 #1): what ⑫ passed is handed to the service explicitly, which
      // judges a change on its locked users row.
      const result = await withStepUp(request, (stepUp) =>
        idempotency.executeInTransaction(
          {
            appId: principal.app_id,
            actor: { userId: principal.uid, deviceId: device.deviceId, phoneHmac: null },
            method: 'POST',
            path: '/v1/me/phone',
            key: typeof key === 'string' ? key : undefined,
            body: request.body,
            traceId: request.id,
            // Phone number: keyed request digest, never an unkeyed SHA-256 (BR-WDR-07; B1-01zzf).
            keyedRequestDigest: true,
          },
          async (trx) =>
            response(
              await phones.bind(trx, {
                app_id: principal.app_id,
                user_id: principal.uid,
                device_id: device.deviceId,
                sid: principal.sid,
                step_up: stepUp.judged(),
                body: request.body,
              }),
              request.id,
            ),
        ),
      );
      reply.code(result.status).type('application/json; charset=utf-8').send(result.body);
    } catch (error) {
      if (!(error instanceof BindPhoneBlocked)) throw error;
      await error.record();
      const result = response(error.result, request.id);
      reply
        .code(result.status)
        .type('application/json; charset=utf-8')
        .send(JSON.stringify(result.envelope));
    }
  }
}
