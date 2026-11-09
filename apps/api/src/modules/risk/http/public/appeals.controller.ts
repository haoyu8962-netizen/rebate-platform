// Contract operations `submitAppeal` (POST /v1/me/appeals: x-auth login, x-idempotent, version
// gate) and `listAppeals` (GET /v1/me/appeals: x-auth login, Cursor / Limit) — task B1-03i,
// BR-ID-36. The subject is the token's principal only (stage ②: uid and app_id), never the body or
// X-App-Id. The submission runs in platform idempotency's transactional mode: the appeal, the risk
// state change, its event and the key's completed record commit together; a refusal (20001) or an
// error rolls all of them back and leaves no record of the key. 30418 (the appeals of the
// current penalty used up, BR-ID-36; HTTP 422, no data) is a 3xxxx business result: nothing was
// written, and the key's record stores it like a success (04 §5). 30701 (target_type=order: the
// order_id is unknown in the app or not the caller's, BR-ID-36 ②, B1-03zl; HTTP 404, no data) is
// likewise a 3xxxx result stored with the key, nothing else written. The idempotency response is
// written as is (HTTP status and body bytes, so a replay equals the first answer). Stage ④a, ⑤
// (10006 whitelist) and ⑬ are the global guard's and the idempotency post-miss hooks', not
// judged here. Without a database (no appeals service or idempotency primitive) both routes fail
// closed with 50001.
//
// Nest's decorators are applied as plain calls below (not decorator syntax): risk.module.ts is
// reachable from the test project, whose compiler settings have no legacy decorators.
import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Optional,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  IDEMPOTENCY,
  contractRouteSchema,
  fieldsErrorEnvelope,
  tokenPrincipal,
  type CheckedRequest,
  type HandlerResult,
  type Idempotency,
} from '../../../platform/index.ts';
import { AppealQueryError, type AppealsService } from '../../application/appeals.ts';

/** Nest token of the appeals service (null when the entry has no database). */
export const APPEALS_SERVICE = Symbol('APPEALS_SERVICE');

const PATH = '/v1/me/appeals';
/** BR-TEXT-14 error.30418 (contracts/texts.default.json); clients show their own copy by code. */
const USED_UP_MSG = '这项申诉的次数已用完，不能再提交申诉';
/** BR-TEXT-14 error.30701 (contracts/texts.default.json). */
const NOT_FOUND_MSG = '内容不存在或已下线';

/** What this controller reads of the Fastify request, already checked by stages ①–③ and the schema. */
export interface AppealsHttpRequest extends CheckedRequest {
  /** Trace id set by `genReqId` (the well-formed X-Trace-Id, else a random UUID). */
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body?: Schema<'SubmitAppealRequest'>;
  readonly query?: { readonly cursor?: string; readonly limit?: number };
}

/** What this controller writes on the Fastify reply. */
export interface AppealsRawReply {
  code(statusCode: number): AppealsRawReply;
  type(contentType: string): AppealsRawReply;
  send(payload: string): unknown;
}

export class AppealsController {
  readonly #appeals: AppealsService | null;
  readonly #idempotency: Idempotency | undefined;

  constructor(appeals: AppealsService | null, idempotency: Idempotency | undefined) {
    this.#appeals = appeals;
    this.#idempotency = idempotency;
  }

  async submit(request: AppealsHttpRequest, reply: AppealsRawReply): Promise<void> {
    const principal = tokenPrincipal(request);
    const appeals = this.#appeals;
    if (appeals === null || this.#idempotency === undefined || principal === undefined) {
      throw new Error('risk: appeals need the database and a verified token');
    }
    const body = request.body!;
    const key = request.headers['idempotency-key'];
    const traceId = request.id;
    const subject = { app_id: principal.app_id, user_id: principal.uid };
    const result = await this.#idempotency.executeInTransaction(
      {
        appId: principal.app_id,
        actor: { userId: principal.uid, deviceId: principal.device_id, phoneHmac: null },
        method: 'POST',
        path: PATH,
        key: typeof key === 'string' ? key : undefined,
        body,
        traceId,
      },
      async (trx): Promise<HandlerResult> => {
        const outcome = await appeals.submit(trx, subject, body);
        if (outcome.code === 0) {
          return {
            status: 200,
            envelope: { code: 0, msg: '', data: outcome.data, trace_id: traceId },
          };
        }
        if (outcome.code === 30418) {
          // Stored by the idempotency module (3xxxx); nothing else was written.
          return {
            status: 422,
            envelope: { code: 30418, msg: USED_UP_MSG, trace_id: traceId },
          };
        }
        if (outcome.code === 30701) {
          // Stored by the idempotency module (3xxxx); nothing else was written.
          return {
            status: 404,
            envelope: { code: 30701, msg: NOT_FOUND_MSG, trace_id: traceId },
          };
        }
        // Not stored by the idempotency module (2xxxx): everything rolls back.
        const refused = fieldsErrorEnvelope(outcome.fields ?? ['target_type'], traceId);
        return { status: refused.statusCode, envelope: refused.body };
      },
    );
    reply.code(result.status).type('application/json; charset=utf-8').send(result.body);
  }

  async list(request: AppealsHttpRequest): Promise<Schema<'AppealListResponse'>> {
    const principal = tokenPrincipal(request);
    if (this.#appeals === null || principal === undefined) {
      throw new Error('risk: appeals need the database and a verified token');
    }
    const query = request.query ?? {};
    try {
      const data = await this.#appeals.list(
        { app_id: principal.app_id, user_id: principal.uid },
        {
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        },
      );
      return { code: 0, msg: '', data, trace_id: request.id };
    } catch (error) {
      if (error instanceof AppealQueryError) {
        const refused = fieldsErrorEnvelope(error.fields, request.id);
        throw new HttpException(refused.body, refused.statusCode);
      }
      throw error;
    }
  }
}

{
  const prototype = AppealsController.prototype;
  const submit = Object.getOwnPropertyDescriptor(prototype, 'submit')!;
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Inject(APPEALS_SERVICE)(AppealsController, undefined, 0);
  Inject(IDEMPOTENCY)(AppealsController, undefined, 1);
  Optional()(AppealsController, undefined, 1);
  Req()(prototype, 'submit', 0);
  Res()(prototype, 'submit', 1);
  Post('me/appeals')(prototype, 'submit', submit);
  HttpCode(200)(prototype, 'submit', submit);
  RouteSchema(contractRouteSchema('submitAppeal'))(prototype, 'submit', submit);
  Req()(prototype, 'list', 0);
  Get('me/appeals')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('listAppeals'))(prototype, 'list', list);
  Controller('v1')(AppealsController);
}
