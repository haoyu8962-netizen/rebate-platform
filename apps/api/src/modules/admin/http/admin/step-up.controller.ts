// /admin/v1 step-up and me/permissions (F1-06l; contract operations adminSendStepUpSms,
// adminStepUp, adminGetMyPermissions). Served by the admin entry only. The admin request check
// (application/admin-check.ts) has already refused a source outside the whitelist (10403) and
// verified the admin_token, its session and its account (10001) before the body schema ran; the
// handlers only take the principal and the parameters, call the use case and map its answer.
import { Controller, Get, HttpCode, HttpException, Inject, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  adminPrincipal,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type CheckedRequest,
} from '../../../platform/index.ts';
import type {
  AdminCaller,
  AdminStepUpService,
  SendStepUpSmsResult,
  StepUpResult,
} from '../../application/admin-step-up.ts';
import { ADMIN_MESSAGES } from '../../application/admin-check.ts';
import { stepUpRequired } from '../../application/permission-guard.ts';
import { ADMIN_STEP_UP } from '../../application/tokens.ts';

type SendResponse = Schema<'SendSmsCodeResponse'>;
type StepUpResponse = Schema<'AdminStepUpResponse'>;
type MeResponse = Schema<'AdminMeResponse'>;

interface AdminRequest<Body> extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Client address as Fastify derived it (TRUSTED_PROXIES aware). */
  readonly ip: string;
  readonly body: Body;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

/** Fallback texts (clients show their dictionary text error.<code>). */
const MESSAGES = Object.freeze({
  20002: '验证码错误，请重新输入',
  20003: '验证码已失效，请重新获取',
  42901: '操作太频繁，请稍后再试',
  50001: '服务繁忙，请稍后再试',
});

function caller(request: AdminRequest<unknown>): AdminCaller {
  const principal = adminPrincipal(request);
  // Unreachable behind the admin token check; never answer for an unchecked request.
  if (principal === undefined) throw new Error('admin: step-up without a verified admin_token');
  return {
    appId: principal.appId,
    adminId: principal.adminId,
    sessionId: principal.sessionId,
    ip: request.ip,
  };
}

function failure(
  result: Exclude<SendStepUpSmsResult | StepUpResult, { code: 0 }>,
  traceId: string,
): HttpException {
  switch (result.code) {
    case 10001:
      return new HttpException({ code: 10001, msg: ADMIN_MESSAGES[10001], trace_id: traceId }, 401);
    case 10003:
      return stepUpRequired('sms', traceId, true);
    case 20002:
    case 20003:
      return new HttpException(
        { code: result.code, msg: MESSAGES[result.code], trace_id: traceId },
        400,
      );
    case 42901:
      return new HttpException({ code: 42901, msg: MESSAGES[42901], trace_id: traceId }, 429);
    case 50001:
      return new HttpException({ code: 50001, msg: MESSAGES[50001], trace_id: traceId }, 500);
  }
}

@Controller('admin/v1')
export class AdminStepUpController {
  constructor(@Inject(ADMIN_STEP_UP) private readonly stepUp: AdminStepUpService) {}

  /** adminSendStepUpSms: a code to the account's registered verify phone. */
  @Post('auth/step-up/sms-codes')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('adminSendStepUpSms'))
  async sendSms(
    @Req() request: AdminRequest<unknown>,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<SendResponse> {
    const result = await this.stepUp.sendSms(caller(request));
    if (result.code !== 0) {
      if (result.code === 42901) reply.header('Retry-After', String(result.retryAfterSec));
      throw failure(result, request.id);
    }
    return {
      code: 0,
      msg: '',
      data: { resend_after_sec: result.resendAfterSec, expires_in_sec: result.expiresInSec },
      trace_id: request.id,
    };
  }

  /** adminStepUp: an authenticator or SMS code → a step_up_token of that tier. */
  @Post('auth/step-up')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('adminStepUp'))
  async verify(
    @Req() request: AdminRequest<Schema<'AdminStepUpRequest'>>,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<StepUpResponse> {
    reply.header('Cache-Control', 'no-store');
    // The contract made `tier` optional (CT-24zzv); until the service reads `method`, a body
    // without `tier` is refused as before (20001 [tier]).
    const { tier } = request.body;
    if (tier === undefined) {
      const { statusCode, body } = fieldsErrorEnvelope(['tier'], request.id);
      throw new HttpException(body, statusCode);
    }
    const result = await this.stepUp.stepUp(caller(request), tier, request.body.code);
    if (result.code !== 0) throw failure(result, request.id);
    return { code: 0, msg: '', data: { ...result.grant }, trace_id: request.id };
  }

  /** adminGetMyPermissions: the account, its permission points and their step-up tiers. */
  @Get('me/permissions')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('adminGetMyPermissions'))
  async me(@Req() request: AdminRequest<unknown>): Promise<MeResponse> {
    const result = await this.stepUp.me(caller(request));
    if (result.code !== 0) throw failure(result, request.id);
    const { me } = result;
    return {
      code: 0,
      msg: '',
      data: {
        admin_id: me.admin_id,
        username: me.username,
        is_super: me.is_super,
        verify_phone_masked: me.verify_phone_masked,
        permissions: me.permissions.map((entry) => ({
          key: entry.key,
          step_up_tier: entry.step_up_tier,
          step_up_operations: entry.step_up_operations.map((item) => ({
            operation: item.operation,
            tier: item.tier,
          })),
        })),
      },
      trace_id: request.id,
    };
  }
}
