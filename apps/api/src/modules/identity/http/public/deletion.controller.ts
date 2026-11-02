// GET /v1/me/deletion, POST /v1/me/deletion, POST /v1/me/deletion/cancel (getDeletion,
// requestDeletion, cancelDeletion; task B1-15d; 08 BR-ID-27, BR-ID-08, BR-ID-31).
//
// Fixed names (§9.2 #6, B1-15j's step-up-verify fixture swaps these methods): file
// http/public/deletion.controller.ts, class DeletionController, methods getDeletion /
// requestDeletion / cancelDeletion. Each method takes only parameter 0, `@Req()`; an explicit
// `@HttpCode(200)` (a POST must not fall to Nest's default 201); success returns the envelope,
// anything else throws `new HttpException(envelope, status)` (as linking convert.controller; no
// `@Res`). Step-up is judged only inside requestDeletion through withStepUp(request, () =>
// idempotency.executeInTransaction({ method: 'POST', path: '/v1/me/deletion', body:
// request.body ?? {}, … }, business)) — no step-up guard or interceptor on the method.
// The idempotent answer is written back from the stored body (parsed, then serialized the same
// way for the first answer and every replay, so a replay equals the first answer byte for byte).
// 0 and 3xxxx are stored with the key; the claim answers replays, 20001, 20901, 20903 and 40901.
// 10010 is stored by nobody and, as a non-zero code, leaves the step-up token usable.
// `msg` is the package default text of contracts/texts.default.json without placeholders.
import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Optional,
  Post,
  Req,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { fenToJsonNumber } from '@couli/money';
import {
  IDEMPOTENCY,
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
  type HandlerResult,
  type Idempotency,
  type IdempotentResponse,
} from '../../../platform/index.ts';
import type {
  CancelDeletionResult,
  DeletionRequestService,
  RequestDeletionResult,
} from '../../application/deletion-request.ts';
import { withStepUp } from '../../application/step-up-verify.ts';
import { DELETION_REQUESTS } from '../../application/tokens.ts';
import { identityFailure } from './error-envelopes.ts';

const PATH = '/v1/me/deletion';

type DeletionResponse = Schema<'DeletionResponse'>;

interface DeletionHttpRequest extends CheckedRequest {
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body?: unknown;
}

const REFUSALS = Object.freeze({
  10010: { status: 403, msg: '需要先核实是你本人' },
  10007: { status: 403, msg: '账号注销处理中' },
  30412: { status: 422, msg: '有进行中的提现，提现完成后再申请注销' },
  30416: { status: 422, msg: '账户有待扣回金额，抵扣回正后才能注销' },
});

function handlerResult(
  result: RequestDeletionResult | CancelDeletionResult,
  traceId: string,
): HandlerResult {
  if (result.code === 0) {
    const envelope: DeletionResponse = { code: 0, msg: '', data: result.data, trace_id: traceId };
    return { status: 200, envelope };
  }
  const refusal = REFUSALS[result.code];
  let data: Readonly<Record<string, unknown>> | undefined;
  if (result.code === 30416) data = { amount_fen: fenToJsonNumber(result.data.amount_fen) };
  if (result.code === 10007) data = { stage: result.data.stage };
  if (result.code === 10010) data = { ...result.data };
  return {
    status: refusal.status,
    envelope: {
      code: result.code,
      msg: refusal.msg,
      ...(data === undefined ? {} : { data }),
      trace_id: traceId,
    },
  };
}

/** Success: the envelope; anything else: thrown for the global filter to write back unchanged. */
function answer(status: number, envelope: unknown): DeletionResponse {
  if (status === 200) return envelope as DeletionResponse;
  throw new HttpException(envelope as Record<string, unknown>, status);
}

function stored(response: IdempotentResponse): DeletionResponse {
  return answer(response.status, JSON.parse(response.body) as unknown);
}

@Controller('v1')
export class DeletionController {
  constructor(
    @Inject(DELETION_REQUESTS) private readonly deletions: DeletionRequestService | null,
    @Optional() @Inject(IDEMPOTENCY) private readonly idempotency?: Idempotency,
  ) {}

  @Get('me/deletion')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('getDeletion'))
  async getDeletion(@Req() request: DeletionHttpRequest): Promise<DeletionResponse> {
    const principal = tokenPrincipal(request);
    if (principal === undefined) throw identityFailure({ code: 10001 }, request.id);
    const deletions = this.#service();
    const data = await deletions.read({ appId: principal.app_id, userId: principal.uid });
    return { code: 0, msg: '', data, trace_id: request.id };
  }

  @Post('me/deletion')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('requestDeletion'))
  async requestDeletion(@Req() request: DeletionHttpRequest): Promise<DeletionResponse> {
    const principal = tokenPrincipal(request);
    if (principal === undefined) throw identityFailure({ code: 10001 }, request.id);
    const deletions = this.#service();
    const idempotency = this.idempotency;
    // A missing port never lets an application through unchecked (50001).
    if (idempotency === undefined || !deletions.canRequest) {
      throw new Error('identity: deletion request needs idempotency and both deletion ports');
    }
    const header = request.headers['idempotency-key'];
    const subject = { appId: principal.app_id, userId: principal.uid };
    const response = await withStepUp(request, () =>
      idempotency.executeInTransaction(
        {
          appId: principal.app_id,
          actor: { userId: principal.uid, deviceId: principal.device_id, phoneHmac: null },
          method: 'POST',
          path: PATH,
          key: typeof header === 'string' ? header : undefined,
          // The contract has no request body; whatever was sent is what the key is bound to.
          body: request.body ?? {},
          traceId: request.id,
        },
        async (trx) =>
          handlerResult(
            await deletions.request(trx, subject, {
              deviceId: principal.device_id,
              scope: principal.scp,
            }),
            request.id,
          ),
      ),
    );
    return stored(response);
  }

  @Post('me/deletion/cancel')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('cancelDeletion'))
  async cancelDeletion(@Req() request: DeletionHttpRequest): Promise<DeletionResponse> {
    const principal = tokenPrincipal(request);
    if (principal === undefined) throw identityFailure({ code: 10001 }, request.id);
    const deletions = this.#service();
    const result = await deletions.cancel({ appId: principal.app_id, userId: principal.uid });
    const { status, envelope } = handlerResult(result, request.id);
    return answer(status, envelope);
  }

  #service(): DeletionRequestService {
    if (this.deletions === null) throw new Error('identity: account deletion needs the database');
    return this.deletions;
  }
}
