// GET /v1/me/reverify, POST /v1/me/reverify/id-number, POST /v1/me/reverify/oauth (规划/08 BR-WDR-01
// 细则; B1-02zp). Standard idempotency: the processing record is committed before the handler, so
// the provider exchange holds no database transaction. What is stored is the idempotency module's
// rule: a pass; 10010, 20005 and the other refusals leave the key reusable (BR-WDR-07, D10-149).
// Both bodies carry personal data or credentials: keyed request digest. `msg` is a fallback text of
// contracts/texts.default.json without placeholders; `data` never carries a submitted value.
import { Controller, Get, Inject, Optional, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  IDEMPOTENCY,
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
  type HandlerResult,
  type Idempotency,
  type TokenPrincipal,
} from '../../../platform/index.ts';
import type { ReverifyResult, ReverifyService } from '../../application/reverify.ts';
import { REVERIFY } from '../../application/tokens.ts';

interface ReverifyHttpRequest<Body = unknown> extends CheckedRequest {
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Body;
}

interface RawReply {
  code(status: number): RawReply;
  type(contentType: string): RawReply;
  send(body: string): unknown;
}

const ERRORS = {
  10010: { status: 403, msg: '需要先核实是你本人' },
  10403: { status: 403, msg: '请在 App 内操作' },
  20001: { status: 400, msg: '填写内容有误，请检查' },
  20004: { status: 400, msg: '授权未完成，请重新授权' },
  20005: { status: 400, msg: '没有核实通过' },
  50001: { status: 500, msg: '服务端错误' },
  50305: { status: 503, msg: '该登录方式暂时不可用，请稍后再试或改用其他登录方式' },
} as const;

function response(result: ReverifyResult, traceId: string): HandlerResult {
  if (result.code === 0) {
    const envelope: Schema<'ReverifyPassedResponse'> = {
      code: 0,
      msg: '',
      data: { passed: true },
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
export class ReverifyController {
  constructor(
    @Inject(REVERIFY) private readonly reverify: ReverifyService | null,
    @Optional() @Inject(IDEMPOTENCY) private readonly idempotency?: Idempotency,
  ) {}

  @Get('me/reverify')
  @RouteSchema(contractRouteSchema('getReverify'))
  async status(@Req() request: ReverifyHttpRequest): Promise<Schema<'ReverifyStatusResponse'>> {
    const principal = tokenPrincipal(request);
    if (principal === undefined || this.reverify === null) {
      throw new Error('identity: reverify needs storage and a verified token');
    }
    const data = await this.reverify.status(principal);
    return { code: 0, msg: '', data, trace_id: request.id };
  }

  @Post('me/reverify/id-number')
  @RouteSchema(contractRouteSchema('reverifyByIdNumber'))
  async byIdNumber(
    @Req() request: ReverifyHttpRequest<Schema<'ReverifyByIdNumberRequest'>>,
    @Res() reply: RawReply,
  ): Promise<void> {
    await this.submit(request, reply, '/v1/me/reverify/id-number', (service, principal) =>
      service.byIdNumber(principal, request.body.id_no),
    );
  }

  @Post('me/reverify/oauth')
  @RouteSchema(contractRouteSchema('reverifyByOauth'))
  async byOauth(
    @Req() request: ReverifyHttpRequest<Schema<'ReverifyByOauthRequest'>>,
    @Res() reply: RawReply,
  ): Promise<void> {
    const device = request.verifiedDevice;
    if (device === undefined) throw new Error('identity: reverify without a verified device');
    await this.submit(request, reply, '/v1/me/reverify/oauth', (service, principal) =>
      service.byOauth(principal, device, request.body),
    );
  }

  private async submit(
    request: ReverifyHttpRequest,
    reply: RawReply,
    path: string,
    run: (service: ReverifyService, principal: TokenPrincipal) => Promise<ReverifyResult>,
  ): Promise<void> {
    const principal = tokenPrincipal(request);
    const service = this.reverify;
    if (principal === undefined || service === null || this.idempotency === undefined) {
      throw new Error('identity: reverify needs storage and a verified token');
    }
    const key = request.headers['idempotency-key'];
    const result = await this.idempotency.execute(
      {
        appId: principal.app_id,
        actor: { userId: principal.uid, deviceId: principal.device_id, phoneHmac: null },
        method: 'POST',
        path,
        key: typeof key === 'string' ? key : undefined,
        body: request.body,
        traceId: request.id,
        keyedRequestDigest: true,
      },
      async () => response(await run(service, principal), request.id),
    );
    reply.code(result.status).type('application/json; charset=utf-8').send(result.body);
  }
}
