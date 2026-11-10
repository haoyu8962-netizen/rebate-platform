// B2-16d: GET /admin/v1/invite-rewards (adminListInviteRewards) and
// GET /admin/v1/invite-rewards/{invitee_id} (adminGetInviteReward), the console's read of the
// invite reward records (BR-INV-24 细则「资格记录与状态」④, BR-ID-33). Mounted only by
// GrowthAdminModule on the admin entry. The admin request check has verified the admin_token and
// the route schema the query before this runs. Permission `fund.view` through platform's
// AdminOperationGuard, read only (no step-up: an X-Step-Up-Token header is ignored). appId is
// always the guard's actor. The answer is no-store; reading writes no audit record.
// Without the read (no database) the routes still register and fail closed with 50001.
//
// Also compiled by the `test` project (through ../../index.ts): Nest metadata is applied by plain
// calls below, no parameter properties.
import { Controller, Get, HttpException, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import { errorCodes, type Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type AdminActor,
  type CheckedRequest,
} from '../../../platform/index.ts';
import type {
  AdminInviteRewardQuery,
  AdminInviteRewardsReader,
} from '../../application/admin-invite-rewards.ts';

/** Nest token of growth's console invite reward read (null without a database). */
export const ADMIN_INVITE_REWARDS_READER = Symbol('GROWTH_ADMIN_INVITE_REWARDS_READER');

/** specs/permissions.yaml: the fund console's read point (step-up null). */
const PERMISSION = 'fund.view';
const DEFAULT_PAGE_SIZE = 20;
/** contracts/texts.default.json error.30701 (the console shows its own dictionary text). */
const MSG_30701 = '内容不存在或已下线';

interface InviteRewardsRequest extends CheckedRequest {
  readonly id: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

/** The query as the route schema leaves it (page and page_size may be absent). */
export interface AdminInviteRewardListQuery extends Omit<
  AdminInviteRewardQuery,
  'page' | 'page_size'
> {
  readonly page?: number;
  readonly page_size?: number;
}

type Envelope<T> = { code: 0; msg: string; data: T; trace_id: string };

export class AdminInviteRewardsController {
  readonly #guard: AdminOperationGuard;
  readonly #reader: AdminInviteRewardsReader | null;

  constructor(guard: AdminOperationGuard, reader: AdminInviteRewardsReader | null) {
    this.#guard = guard;
    this.#reader = reader;
  }

  list(
    request: InviteRewardsRequest,
    query: AdminInviteRewardListQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminInviteRewardPageResponse'>> {
    return this.run(request, reply, async (reader, actor) => {
      const result = await reader.list(actor.appId, {
        ...query,
        page: query.page ?? 1,
        page_size: query.page_size ?? DEFAULT_PAGE_SIZE,
      });
      if ('kind' in result) {
        const refused = fieldsErrorEnvelope(result.fields, request.id);
        throw new HttpException(refused.body, refused.statusCode);
      }
      return result;
    });
  }

  detail(
    request: InviteRewardsRequest,
    inviteeId: string,
    reply: HeaderReply,
  ): Promise<Schema<'AdminInviteRewardResponse'>> {
    return this.run(request, reply, async (reader, actor) => {
      const record = await reader.get(actor.appId, inviteeId);
      if (record === null) {
        throw new HttpException(
          { code: 30701, msg: MSG_30701, trace_id: request.id },
          errorCodes[30701].http,
        );
      }
      return record;
    });
  }

  private async run<T>(
    request: InviteRewardsRequest,
    reply: HeaderReply,
    read: (reader: AdminInviteRewardsReader, actor: AdminActor) => Promise<T>,
  ): Promise<Envelope<T>> {
    reply.header('Cache-Control', 'no-store');
    let response: Envelope<T> | undefined;
    await this.#guard.run({ request, permission: PERMISSION, readOnly: true }, async (actor) => {
      const reader = this.#reader;
      if (reader === null) throw new Error('growth: admin invite reward reads need the database');
      response = { code: 0, msg: '', data: await read(reader, actor), trace_id: request.id };
      return { statusCode: 200, body: response };
    });
    if (response === undefined) throw new Error('growth: admin guard returned without an answer');
    return response;
  }
}

// Plain decorator calls, as identity's and orders' admin controllers (no parameter decorators).
{
  const prototype = AdminInviteRewardsController.prototype;
  Inject(AdminOperationGuard)(AdminInviteRewardsController, undefined, 0);
  Inject(ADMIN_INVITE_REWARDS_READER)(AdminInviteRewardsController, undefined, 1);
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListInviteRewards'))(prototype, 'list', list);
  const detail = Object.getOwnPropertyDescriptor(prototype, 'detail')!;
  Req()(prototype, 'detail', 0);
  Param('invitee_id')(prototype, 'detail', 1);
  Res({ passthrough: true })(prototype, 'detail', 2);
  Get(':invitee_id')(prototype, 'detail', detail);
  RouteSchema(contractRouteSchema('adminGetInviteReward'))(prototype, 'detail', detail);
  Controller('admin/v1/invite-rewards')(AdminInviteRewardsController);
}
