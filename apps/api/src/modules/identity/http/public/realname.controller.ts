// POST /v1/me/realname (submitRealname; 规划/08 BR-ID-25; task B1-13d). Contract: x-auth phone,
// signed, idempotent (standard mode: the processing record is committed before the handler, so the
// vendor call holds no database transaction), version gate. The idempotency post-miss checks run
// stage ④a (10405) and ⑧ (10005) before the handler; the use case judges the rest
// (application/realname.ts). Stored results are the idempotency module's rule (0 and 3xxxx), so a
// replay never calls the vendor or counts again; 1xxxx / 2xxxx / 5xxxx leave the key reusable.
// `msg` is the package default text of contracts/texts.default.json without placeholders; `data`
// carries only what the result defines, never a submitted value.
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
import type { RealnameService, SubmitRealnameResult } from '../../application/realname.ts';
import { SUBMIT_REALNAME } from '../../application/tokens.ts';

interface SubmitRealnameHttpRequest extends CheckedRequest {
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Schema<'SubmitRealnameRequest'>;
}

interface RawReply {
  code(status: number): RawReply;
  type(contentType: string): RawReply;
  send(body: string): unknown;
}

const ERRORS = {
  10004: { status: 403, msg: '请先阅读并同意相关授权' },
  10010: { status: 403, msg: '需要先核实是你本人' },
  20001: { status: 400, msg: '填写内容有误，请检查' },
  30405: { status: 422, msg: '该身份证已被其他账号实名' },
  30406: { status: 422, msg: '实名核验未通过，请核对姓名与身份证号' },
  30407: { status: 422, msg: '年龄不满足实名要求' },
  30410: { status: 422, msg: '今日实名次数已用完，请明天再试' },
  50001: { status: 500, msg: '服务端错误' },
  50301: { status: 503, msg: '服务暂不可用，请稍后再试' },
  // Outcome unknown (vendor timeout, or a retry of an attempt whose outcome was not kept): the
  // existing text of contracts/texts.default.json buy.timeout.
  50401: { status: 504, msg: '网络不稳定，请重试' },
} as const;

function response(result: SubmitRealnameResult, traceId: string): HandlerResult {
  if (result.code === 0) {
    const envelope: Schema<'SubmitRealnameResponse'> = {
      code: 0,
      msg: '',
      data: { realname_status: result.data.realname_status, masked_name: result.data.masked_name },
      trace_id: traceId,
    };
    return { status: 200, envelope };
  }
  const error = ERRORS[result.code];
  return {
    status: error.status,
    envelope: {
      code: result.code,
      msg: error.msg,
      trace_id: traceId,
      ...('data' in result ? { data: result.data } : {}),
    },
  };
}

@Controller('v1')
export class RealnameController {
  constructor(
    @Inject(SUBMIT_REALNAME) private readonly realname: RealnameService | null,
    @Optional() @Inject(IDEMPOTENCY) private readonly idempotency?: Idempotency,
  ) {}

  @Post('me/realname')
  @RouteSchema(contractRouteSchema('submitRealname'))
  async submit(@Req() request: SubmitRealnameHttpRequest, @Res() reply: RawReply): Promise<void> {
    const principal = tokenPrincipal(request);
    if (principal === undefined || this.realname === null || this.idempotency === undefined) {
      throw new Error('identity: real-name submission needs storage and a verified token');
    }
    const realname = this.realname;
    const key = request.headers['idempotency-key'];
    const result = await this.idempotency.execute(
      {
        appId: principal.app_id,
        actor: { userId: principal.uid, deviceId: principal.device_id, phoneHmac: null },
        method: 'POST',
        path: '/v1/me/realname',
        key: typeof key === 'string' ? key : undefined,
        body: request.body,
        traceId: request.id,
        // Name and id number: keyed request digest, never an unkeyed SHA-256 (BR-WDR-07; B1-01zzf).
        keyedRequestDigest: true,
      },
      async () => {
        // The idempotency module answered 20001 before the handler when the key is missing.
        if (typeof key !== 'string')
          throw new Error('identity: real-name submission without a key');
        return response(
          await realname.submit({
            appId: principal.app_id,
            userId: principal.uid,
            deviceId: principal.device_id,
            name: request.body.name,
            idNo: request.body.id_no,
            idempotencyKey: key,
          }),
          request.id,
        );
      },
    );
    reply.code(result.status).type('application/json; charset=utf-8').send(result.body);
  }
}
