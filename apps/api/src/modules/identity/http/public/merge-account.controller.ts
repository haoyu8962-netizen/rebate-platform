// POST /v1/auth/merge (mergeAccount; 规划/08 BR-ID-06; task B1-20c): the merge of the logged-in
// third-party account into the phone account of its merge_ticket (application/merge-account.ts).
// The configuration read (withdraw.dormant_reverify_days) happens before the idempotency
// transaction; the merge runs inside it. The stored record of a success keeps the answer with
// data.tokens null (D10-1099 Q-6, B1-01zzs archive override): the tokens are given to this caller
// only, and a replay of the key never happens (the source session is revoked, ② answers 10002).
// Before the transaction the service judges the phone account for re-verification on its own short
// transaction (judgeTarget; Codex money review r1 S1), so a 10010 never loses the flag. A deadlock
// with growth's relation writers rolls the attempt back whole and is retried once
// (retryOnDeadlock; review r1 S2).
import { Controller, Inject, Optional, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { ClientPlatform, Schema } from '@couli/contracts-ts';
import {
  IDEMPOTENCY,
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
  type HandlerResult,
  type Idempotency,
} from '../../../platform/index.ts';
import {
  retryOnDeadlock,
  type MergeAccountCommand,
  type MergeAccountResult,
  type MergeAccountService,
} from '../../application/merge-account.ts';
import { readDormantReverifyDays } from '../../application/reverify-activity.ts';
import type { SmsConfigReader } from '../../application/sms-codes.ts';
import { IDENTITY_CONFIG, MERGE_ACCOUNT } from '../../application/tokens.ts';

interface MergeAccountRequest extends CheckedRequest {
  readonly id: string;
  readonly ip: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Schema<'MergeAccountRequest'>;
}

interface RawReply {
  code(status: number): RawReply;
  type(contentType: string): RawReply;
  send(body: string): unknown;
}

/** Fallback texts (contracts/texts.default.json error.<code>; clients show their dictionary). */
const ERRORS = {
  10002: { status: 401, msg: 'access_token 过期' },
  10010: { status: 403, msg: '需要先核实是你本人' },
  30411: { status: 422, msg: '该手机号已注册，可退出后用手机号登录' },
  50001: { status: 500, msg: '服务端错误' },
} as const;

function response(result: MergeAccountResult, traceId: string): HandlerResult {
  if (result.code === 0) {
    const envelope: Schema<'LoginResponse'> = {
      code: 0,
      msg: '',
      data: result.data,
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
      ...(result.code === 10010 ? { data: { ...result.data } } : {}),
    },
  };
}

/** The stored form of a success: the same envelope with data.tokens null (D10-1099 Q-6). */
function withoutTokens<E extends { readonly code: number; readonly data?: unknown }>(
  envelope: E,
): E {
  if (envelope.code !== 0 || typeof envelope.data !== 'object' || envelope.data === null) {
    return envelope;
  }
  return { ...envelope, data: { ...envelope.data, tokens: null } };
}

function header(request: MergeAccountRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

@Controller('v1')
export class MergeAccountController {
  constructor(
    @Inject(MERGE_ACCOUNT) private readonly merges: MergeAccountService | null,
    @Inject(IDENTITY_CONFIG) private readonly config: SmsConfigReader | null,
    @Optional() @Inject(IDEMPOTENCY) private readonly idempotency?: Idempotency,
  ) {}

  @Post('auth/merge')
  @RouteSchema(contractRouteSchema('mergeAccount'))
  async merge(@Req() request: MergeAccountRequest, @Res() reply: RawReply): Promise<void> {
    const principal = tokenPrincipal(request);
    const device = request.verifiedDevice;
    if (
      principal === undefined ||
      device === undefined ||
      this.merges === null ||
      this.idempotency === undefined
    ) {
      throw new Error('identity: the merge needs storage and a verified token and device');
    }
    const merges = this.merges;
    const key = request.headers['idempotency-key'];
    const dormantReverifyDays = await readDormantReverifyDays(
      this.config ?? undefined,
      principal.app_id,
    );
    const command: MergeAccountCommand = {
      app_id: principal.app_id,
      user_id: principal.uid,
      device_id: device.deviceId,
      platform: header(request, 'x-platform') as ClientPlatform,
      client_ip: request.ip,
      merge_ticket: request.body.merge_ticket,
      sid: principal.sid,
      dormantReverifyDays,
    };
    const idempotency = this.idempotency;
    const result = await retryOnDeadlock(async () => {
      // Committed on its own before the merge transaction opens (no connection is held here).
      await merges.judgeTarget(command);
      return idempotency.executeInTransaction(
        {
          appId: principal.app_id,
          actor: { userId: principal.uid, deviceId: device.deviceId, phoneHmac: null },
          method: 'POST',
          path: '/v1/auth/merge',
          key: typeof key === 'string' ? key : undefined,
          body: request.body,
          traceId: request.id,
        },
        async (trx) => response(await merges.merge(trx, command), request.id),
        { archive: withoutTokens },
      );
    });
    reply.code(result.status).type('application/json; charset=utf-8').send(result.body);
  }
}
