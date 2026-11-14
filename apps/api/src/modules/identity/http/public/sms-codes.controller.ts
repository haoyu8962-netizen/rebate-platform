import { Controller, HttpCode, HttpException, Inject, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
} from '../../../platform/index.ts';
import type { SmsCodeRequestService } from '../../application/sms-code-requests.ts';
import type { SmsResult } from '../../application/sms-codes.ts';
import { SMS_CODE_REQUESTS } from '../../application/tokens.ts';
import { identityFailure } from './error-envelopes.ts';

type SendSmsCodeResponse = Schema<'SendSmsCodeResponse'>;

/** What this controller reads of the Fastify request, already checked by stage ① and the schema. */
interface SendSmsCodeRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Fastify's client address (no proxy trust is configured yet; B1-03g decides). */
  readonly ip: string;
  readonly body: Schema<'SendSmsCodeRequest'>;
}

/** What this controller writes on the Fastify reply besides the body. */
interface HeaderReply {
  header(name: string, value: string): unknown;
}

/**
 * Fallback texts (`msg`; clients show their dictionary text). Where the package defaults of
 * BR-TEXT-14 (contracts/texts.default.json error.<code>[.<reason>]) have a key, `msg` is that text;
 * 44003 has none (the meaning of contracts/error-codes.yaml), and 50001 is the global error
 * filter's text, so that every 50001 reads the same.
 */
const MESSAGES = Object.freeze({
  phone_invalid: '请输入 11 位中国大陆手机号',
  42901: '操作太频繁，请稍后再试',
  44001: '操作未通过安全校验',
  44003: '需要人机验证',
  50001: '服务端错误',
});

export interface SmsErrorResponse {
  readonly statusCode: number;
  readonly body: {
    readonly code: number;
    readonly msg: string;
    readonly data?: Readonly<Record<string, unknown>>;
    readonly trace_id: string;
  };
  /** Retry-After in seconds (42901 only). */
  readonly retryAfterSec?: number;
}

/**
 * The HTTP answer of a failed send (contracts/error-codes.yaml statuses): 20001 400 with
 * data.fields=[phone] and data.reason=phone_invalid; 42901 429 with Retry-After; 44001 403 with
 * data.risk_msg_code only when the result carries one (no free text, BR-TEXT-14); 44003 403;
 * 50001 500.
 */
export function smsErrorResponse(
  result: Exclude<SmsResult, { code: 0 }>,
  traceId: string,
): SmsErrorResponse {
  switch (result.code) {
    case 20001:
      return {
        statusCode: 400,
        body: {
          code: 20001,
          msg: MESSAGES.phone_invalid,
          data: { fields: [...result.data.fields], reason: result.data.reason },
          trace_id: traceId,
        },
      };
    case 42901:
      return {
        statusCode: 429,
        body: { code: 42901, msg: MESSAGES[42901], trace_id: traceId },
        retryAfterSec: Math.max(1, Math.ceil(result.retryAfterSec)),
      };
    case 44001:
      return {
        statusCode: 403,
        body: {
          code: 44001,
          msg: MESSAGES[44001],
          ...(result.data === undefined
            ? {}
            : { data: { risk_msg_code: result.data.risk_msg_code } }),
          trace_id: traceId,
        },
      };
    case 44003:
      return { statusCode: 403, body: { code: 44003, msg: MESSAGES[44003], trace_id: traceId } };
    case 50001:
      return { statusCode: 500, body: { code: 50001, msg: MESSAGES[50001], trace_id: traceId } };
  }
}

@Controller('v1')
export class SmsCodesController {
  constructor(@Inject(SMS_CODE_REQUESTS) private readonly smsCodes: SmsCodeRequestService | null) {}

  /**
   * Contract operation `sendSmsCode` (BR-ID-05, BR-ID-08): x-auth optional, x-signed. Stage ①
   * (request signature) and the token stages ② ③ have already run; the app of the code is the
   * verified device's app_id, as for the nonce. login / bind send to the body's phone, anonymous or
   * logged in; step_up needs the caller's own token, takes no phone and sends to the token
   * account's bound phone (application/sms-code-requests.ts). The device id and the client IP go
   * to the insertion points (B1-03g limits). The version gate and the session scope
   * (x-min-version-gate conditional, x-session-scopes) are stage ④a's, before this handler.
   */
  @Post('auth/sms-codes')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('sendSmsCode'))
  async send(
    @Req() request: SendSmsCodeRequest,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<SendSmsCodeResponse> {
    const device = request.verifiedDevice;
    if (this.smsCodes === null || device === undefined) {
      throw new Error('identity: SMS codes need Redis, the database and a verified device');
    }
    const principal = tokenPrincipal(request);
    const result = await this.smsCodes.send({
      body: request.body,
      verifiedDevice: device,
      client_ip: request.ip,
      ...(principal === undefined ? {} : { principal }),
    });
    if ('refused' in result) throw identityFailure(result.refused, request.id);
    if (result.code === 0) {
      return { code: 0, msg: '', data: result.data, trace_id: request.id };
    }
    const response = smsErrorResponse(result, request.id);
    if (response.retryAfterSec !== undefined) {
      reply.header('Retry-After', String(response.retryAfterSec));
    }
    throw new HttpException(response.body, response.statusCode);
  }
}
