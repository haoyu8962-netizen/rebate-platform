// B1-10m: POST /admin/v1/orders/{order_id}/hold, /unhold and /reassign (contract adminHoldOrder,
// adminUnholdOrder, adminReassignOrder; BR-FUND-06, BR-ATTR-31). Only authorisation, the parameters
// and the call into the use cases live here. B1-09v: POST …/reason-sub (adminSetOrderReasonSub,
// 改子原因; 08 BR-TEXT-05), permission order.claim, step-up tier null, over the hold use case's deps.
//
// Mounted only by OrdersAdminModule on the admin entry. The admin request check has verified the
// admin_token and the route schema the body before this runs; AdminOperationGuard re-reads the
// account and checks order.hold (step-up tier null) or order.assign (totp, X-Step-Up-Token, through
// order-assign.http.ts). Each use case writes its change and audit record in one transaction, so a
// failing audit rolls the change back (50001). Without the database or the event bus the routes
// still register and every call fails closed (50001).
import { Body, Controller, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { AdminOperationGuard, contractRouteSchema } from '../../../platform/index.ts';
import { holdOrder, unholdOrder } from '../../application/admin-hold.ts';
import { setOrderReasonSub } from '../../application/admin-reason-sub.ts';
import { AdminOrderAssignHttp, type AdminAssignBody } from './order-assign.http.ts';
import {
  ADMIN_WRITE_DEPS,
  conflictRefusal,
  fieldsRefusal,
  type AdminWriteDeps,
  type AdminWriteRequest,
  type HeaderReply,
} from './write-deps.ts';

type Detail = Schema<'AdminOrderDetailResponse'>;

interface HoldBody {
  readonly reason_code?: string;
  readonly note: string;
  readonly expected_row_version: number;
}

export class AdminOrderActionsController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: AdminWriteDeps | null;

  constructor(guard: AdminOperationGuard, deps: AdminWriteDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  hold(
    request: AdminWriteRequest,
    orderId: string,
    body: Schema<'AdminOrderHoldRequest'>,
    reply: HeaderReply,
  ): Promise<Detail> {
    return this.setHold('hold', request, orderId, body, reply);
  }

  unhold(
    request: AdminWriteRequest,
    orderId: string,
    body: Schema<'AdminOrderUnholdRequest'>,
    reply: HeaderReply,
  ): Promise<Detail> {
    return this.setHold('unhold', request, orderId, body, reply);
  }

  async reassign(
    request: AdminWriteRequest,
    orderId: string,
    body: AdminAssignBody,
    reply: HeaderReply,
  ): Promise<Detail> {
    reply.header('Cache-Control', 'no-store');
    const deps = this.#deps;
    if (deps === null) return this.unavailable(request, 'order.assign');
    const http = new AdminOrderAssignHttp({ guard: this.#guard, assign: deps.assign });
    return http.reassign(request, orderId, body);
  }

  async reasonSub(
    request: AdminWriteRequest,
    orderId: string,
    body: Schema<'AdminOrderReasonSubSetRequest'>,
    reply: HeaderReply,
  ): Promise<Detail> {
    reply.header('Cache-Control', 'no-store');
    const deps = this.#deps;
    if (deps === null) return this.unavailable(request, 'order.claim');
    let response: Detail | undefined;
    await this.#guard.run({ request, permission: 'order.claim' }, async (actor) => {
      const outcome = await setOrderReasonSub(
        deps.hold,
        { appId: actor.appId, adminId: actor.adminId, ip: request.ip ?? null },
        {
          orderId,
          reason_sub: body.reason_sub,
          expected_row_version: body.expected_row_version,
        },
      );
      if (outcome.code === 20001) throw fieldsRefusal(outcome.data.fields, request.id);
      if (outcome.code === 20902) throw conflictRefusal(outcome.data.resource, request.id);
      response = { code: 0, msg: '', data: outcome.data, trace_id: request.id };
      return { statusCode: 200, body: response };
    });
    if (response === undefined) throw new Error('orders: admin guard returned without an answer');
    return response;
  }

  private async setHold(
    mode: 'hold' | 'unhold',
    request: AdminWriteRequest,
    orderId: string,
    body: HoldBody,
    reply: HeaderReply,
  ): Promise<Detail> {
    reply.header('Cache-Control', 'no-store');
    const deps = this.#deps;
    if (deps === null) return this.unavailable(request, 'order.hold');
    let response: Detail | undefined;
    await this.#guard.run({ request, permission: 'order.hold' }, async (actor) => {
      const outcome = await (mode === 'hold' ? holdOrder : unholdOrder)(
        deps.hold,
        {
          appId: actor.appId,
          adminId: actor.adminId,
          isSuper: actor.isSuper,
          ip: request.ip ?? null,
        },
        {
          orderId,
          reason_code: body.reason_code,
          note: body.note,
          expected_row_version: body.expected_row_version,
        },
      );
      if (outcome.code === 20001) throw fieldsRefusal(outcome.data.fields, request.id);
      if (outcome.code === 20902) throw conflictRefusal(outcome.data.resource, request.id);
      response = { code: 0, msg: '', data: outcome.data, trace_id: request.id };
      return { statusCode: 200, body: response };
    });
    if (response === undefined) throw new Error('orders: admin guard returned without an answer');
    return response;
  }

  /** The guard answers first: only an authorised call reaches the 50001. */
  private async unavailable(request: AdminWriteRequest, permission: string): Promise<never> {
    await this.#guard.run({ request, permission }, () => {
      throw new Error('orders: admin order actions need the database and events');
    });
    throw new Error('orders: admin guard returned without an answer');
  }
}

// Plain decorator calls, as identity's and risk's admin controllers (no parameter decorators).
{
  const prototype = AdminOrderActionsController.prototype;
  Inject(AdminOperationGuard)(AdminOrderActionsController, undefined, 0);
  Inject(ADMIN_WRITE_DEPS)(AdminOrderActionsController, undefined, 1);
  for (const [name, operationId, path] of [
    ['hold', 'adminHoldOrder', 'hold'],
    ['unhold', 'adminUnholdOrder', 'unhold'],
    ['reassign', 'adminReassignOrder', 'reassign'],
    ['reasonSub', 'adminSetOrderReasonSub', 'reason-sub'],
  ] as const) {
    const handler = Object.getOwnPropertyDescriptor(prototype, name)!;
    Req()(prototype, name, 0);
    Param('order_id')(prototype, name, 1);
    Body()(prototype, name, 2);
    Res({ passthrough: true })(prototype, name, 3);
    Post(`:order_id/${path}`)(prototype, name, handler);
    HttpCode(200)(prototype, name, handler);
    RouteSchema(contractRouteSchema(operationId))(prototype, name, handler);
  }
  Controller('admin/v1/orders')(AdminOrderActionsController);
}
