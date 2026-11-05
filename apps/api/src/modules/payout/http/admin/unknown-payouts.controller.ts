// B2-09s: GET /admin/v1/unknown-payouts, POST /admin/v1/withdrawals/{withdrawal_id}/query and
// .../resolve (adminListUnknownPayouts, adminQueryPayoutResult, adminResolveUnknownPayout; 08
// BR-WDR-15; 04 §11.2 payout.execute). Only authorisation, the parameters and the call into
// application/admin-unknown-payouts.ts live here.
//
// Mounted only by PayoutAdminModule.forAdmin on the admin entry. The AdminOperationGuard re-reads
// the account and checks payout.execute (a super admin holds every point); the writes also need the
// totp-tier X-Step-Up-Token (10003 data.tier=totp) and run under platform idempotency (subject
// a:<admin_users.id>), their exact bytes written raw here. Without the database, the queue, the event
// bus or the idempotency primitive the routes still register and every call fails closed (50001).
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  type CheckedRequest,
  type IdempotentResponse,
} from '../../../platform/index.ts';
import {
  listAdminUnknownPayouts,
  queryAdminPayoutResult,
  resolveAdminUnknownPayout,
  type AdminUnknownPayoutReadDeps,
  type AdminUnknownPayoutWriteDeps,
  type UnknownPayoutOperator,
} from '../../application/admin-unknown-payouts.ts';

/** Nest tokens of the use case dependencies (null in a process without the database). */
export const ADMIN_UNKNOWN_PAYOUT_READS = Symbol('PAYOUT_ADMIN_UNKNOWN_PAYOUT_READS');
export const ADMIN_UNKNOWN_PAYOUT_WRITES = Symbol('PAYOUT_ADMIN_UNKNOWN_PAYOUT_WRITES');

/** specs/permissions.yaml: payout.execute, step-up tier totp (read by the guard on writes). */
const PERMISSION = 'payout.execute';

export interface AdminUnknownPayoutRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** What the write handlers send on the Fastify reply (the idempotency module's exact bytes). */
export interface AdminUnknownPayoutRawReply {
  header(name: string, value: string): AdminUnknownPayoutRawReply;
  code(statusCode: number): AdminUnknownPayoutRawReply;
  type(contentType: string): AdminUnknownPayoutRawReply;
  send(payload: string): unknown;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

function idempotencyKey(request: AdminUnknownPayoutRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : undefined;
}

export class AdminUnknownPayoutsController {
  readonly #guard: AdminOperationGuard;
  readonly #reads: AdminUnknownPayoutReadDeps | null;
  readonly #writes: AdminUnknownPayoutWriteDeps | null;

  constructor(
    guard: AdminOperationGuard,
    reads: AdminUnknownPayoutReadDeps | null,
    writes: AdminUnknownPayoutWriteDeps | null,
  ) {
    this.#guard = guard;
    this.#reads = reads;
    this.#writes = writes;
  }

  async list(
    request: AdminUnknownPayoutRequest,
    query: { readonly page?: number; readonly page_size?: number },
    reply: HeaderReply,
  ): Promise<Schema<'AdminUnknownPayoutPageResponse'>> {
    reply.header('Cache-Control', 'no-store');
    let response: Schema<'AdminUnknownPayoutPageResponse'> | undefined;
    await this.#guard.run({ request, permission: PERMISSION, readOnly: true }, async (actor) => {
      const deps = this.#reads;
      if (deps === null) throw new Error('payout: the unknown payout list needs the database');
      response = {
        code: 0,
        msg: '',
        data: await listAdminUnknownPayouts(deps, actor.appId, query),
        trace_id: request.id,
      };
      return { statusCode: 200, body: response };
    });
    if (response === undefined) throw new Error('payout: admin guard returned without an answer');
    return response;
  }

  query(
    request: AdminUnknownPayoutRequest,
    withdrawalId: string,
    body: Schema<'AdminPayoutQueryRequest'>,
    reply: AdminUnknownPayoutRawReply,
  ): Promise<void> {
    return this.#write(request, reply, (deps, operator) =>
      queryAdminPayoutResult(deps, operator, withdrawalId, {
        body,
        key: idempotencyKey(request),
        traceId: request.id,
      }),
    );
  }

  resolve(
    request: AdminUnknownPayoutRequest,
    withdrawalId: string,
    body: Schema<'AdminUnknownPayoutResolveRequest'>,
    reply: AdminUnknownPayoutRawReply,
  ): Promise<void> {
    return this.#write(request, reply, (deps, operator) =>
      resolveAdminUnknownPayout(deps, operator, withdrawalId, {
        body,
        key: idempotencyKey(request),
        traceId: request.id,
      }),
    );
  }

  async #write(
    request: AdminUnknownPayoutRequest,
    reply: AdminUnknownPayoutRawReply,
    write: (
      deps: AdminUnknownPayoutWriteDeps,
      operator: UnknownPayoutOperator,
    ) => Promise<IdempotentResponse>,
  ): Promise<void> {
    let sent: IdempotentResponse | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      const deps = this.#writes;
      if (deps === null) {
        throw new Error('payout: the unknown payout writes need the database and the queue');
      }
      sent = await write(deps, {
        appId: actor.appId,
        adminId: actor.adminId,
        ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
      });
      // The guard reads the code and consumes the step-up token on 0; the bytes are sent below.
      return { statusCode: sent.status, body: JSON.parse(sent.body) as { code: number } };
    });
    if (sent === undefined) throw new Error('payout: admin guard returned without an answer');
    reply
      .header('Cache-Control', 'no-store')
      .code(sent.status)
      .type('application/json; charset=utf-8')
      .send(sent.body);
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators in source).
{
  const prototype = AdminUnknownPayoutsController.prototype;
  Inject(AdminOperationGuard)(AdminUnknownPayoutsController, undefined, 0);
  Inject(ADMIN_UNKNOWN_PAYOUT_READS)(AdminUnknownPayoutsController, undefined, 1);
  Inject(ADMIN_UNKNOWN_PAYOUT_WRITES)(AdminUnknownPayoutsController, undefined, 2);

  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('unknown-payouts')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListUnknownPayouts'))(prototype, 'list', list);

  const query = Object.getOwnPropertyDescriptor(prototype, 'query')!;
  Req()(prototype, 'query', 0);
  Param('withdrawal_id')(prototype, 'query', 1);
  Body()(prototype, 'query', 2);
  Res()(prototype, 'query', 3);
  Post('withdrawals/:withdrawal_id/query')(prototype, 'query', query);
  HttpCode(200)(prototype, 'query', query);
  RouteSchema(contractRouteSchema('adminQueryPayoutResult'))(prototype, 'query', query);

  const resolve = Object.getOwnPropertyDescriptor(prototype, 'resolve')!;
  Req()(prototype, 'resolve', 0);
  Param('withdrawal_id')(prototype, 'resolve', 1);
  Body()(prototype, 'resolve', 2);
  Res()(prototype, 'resolve', 3);
  Post('withdrawals/:withdrawal_id/resolve')(prototype, 'resolve', resolve);
  HttpCode(200)(prototype, 'resolve', resolve);
  RouteSchema(contractRouteSchema('adminResolveUnknownPayout'))(prototype, 'resolve', resolve);

  Controller('admin/v1')(AdminUnknownPayoutsController);
}
