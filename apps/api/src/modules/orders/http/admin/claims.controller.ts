// B1-10j: GET /admin/v1/claims (adminListClaims) and GET /admin/v1/claims/{claim_id}
// (adminGetClaim), the read side of the console's claim review (BR-ATTR-30, BR-ID-33). Mounted
// only by OrdersAdminModule on the admin entry. The admin request check has verified the
// admin_token and the route schema the query before this runs. Permission through platform's
// AdminOperationGuard, read only (no step-up, an X-Step-Up-Token header is ignored):
// `order.claim` reads every claim of the app; with `user_id` an account holding `user.lookup`
// may read that user's claims too (['order.claim', 'user.lookup'], any of them); without `user_id`
// only `order.claim` (else 10403). The answer is no-store; reading writes no audit record.
import { Controller, Get, HttpException, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type AdminActor,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  AdminClaims,
  AdminClaimsFieldsError,
  type AdminClaimListQuery,
} from '../../application/admin-claims.ts';
import { blankAdminClaimDetail } from '../../domain/admin-claim-view.ts';

interface ClaimsRequest extends CheckedRequest {
  readonly id: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

interface DetailQuery {
  readonly user_id?: string;
}

/** user.lookup only together with user_id (contract adminListClaims / adminGetClaim). */
function permissionOf(userId: string | undefined): string | readonly string[] {
  return userId === undefined ? 'order.claim' : ['order.claim', 'user.lookup'];
}

export class AdminClaimsController {
  readonly #guard: AdminOperationGuard;
  readonly #claims: AdminClaims;

  constructor(guard: AdminOperationGuard, claims: AdminClaims) {
    this.#guard = guard;
    this.#claims = claims;
  }

  list(
    request: ClaimsRequest,
    query: AdminClaimListQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminClaimPageResponse'>> {
    return this.run(request, reply, query.user_id, false, (actor) =>
      this.#claims.list(actor.appId, query),
    );
  }

  detail(
    request: ClaimsRequest,
    claimId: string,
    query: DetailQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminClaimDetailResponse'>> {
    return this.run(request, reply, query.user_id, true, async (actor) =>
      blankAdminClaimDetail(await this.#claims.detail(actor.appId, claimId, query.user_id), actor),
    );
  }

  private async run<T>(
    request: ClaimsRequest,
    reply: HeaderReply,
    userId: string | undefined,
    withPermissions: boolean,
    read: (actor: AdminActor) => Promise<T>,
  ): Promise<{ code: 0; msg: string; data: T; trace_id: string }> {
    reply.header('Cache-Control', 'no-store');
    let response: { code: 0; msg: string; data: T; trace_id: string } | undefined;
    await this.#guard.run(
      { request, permission: permissionOf(userId), readOnly: true, withPermissions },
      async (actor) => {
        try {
          response = { code: 0, msg: '', data: await read(actor), trace_id: request.id };
          return { statusCode: 200, body: response };
        } catch (error) {
          if (!(error instanceof AdminClaimsFieldsError)) throw error;
          const refused = fieldsErrorEnvelope(error.fields, request.id);
          throw new HttpException(refused.body, refused.statusCode);
        }
      },
    );
    if (response === undefined) throw new Error('orders: admin guard returned without an answer');
    return response;
  }
}

// Plain decorator calls, as identity's and risk's admin controllers (no parameter decorators).
{
  const prototype = AdminClaimsController.prototype;
  Inject(AdminOperationGuard)(AdminClaimsController, undefined, 0);
  Inject(AdminClaims)(AdminClaimsController, undefined, 1);
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListClaims'))(prototype, 'list', list);
  const detail = Object.getOwnPropertyDescriptor(prototype, 'detail')!;
  Req()(prototype, 'detail', 0);
  Param('claim_id')(prototype, 'detail', 1);
  Query()(prototype, 'detail', 2);
  Res({ passthrough: true })(prototype, 'detail', 3);
  Get(':claim_id')(prototype, 'detail', detail);
  RouteSchema(contractRouteSchema('adminGetClaim'))(prototype, 'detail', detail);
  Controller('admin/v1/claims')(AdminClaimsController);
}
