// B1-28s: GET /admin/v1/product-feedbacks (adminListProductFeedbacks, CT-26x, 编排 D10-757).
// Mounted only by FeedbackAdminModule on the admin entry. The admin request check has verified the
// admin_token and the route schema the query before this runs; the operation guard re-reads the
// account and checks the permission point feedback.view, read only (no step-up; an X-Step-Up-Token
// header is ignored). No audit record. The answer is no-store. Only authorisation, the parameters
// and the call into application/admin-list.ts live here. Without the database the route still
// registers and every call fails closed (50001).
import { Controller, Get, HttpException, Inject, Query, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  AdminProductFeedbackFieldsError,
  listAdminProductFeedbacks,
  type AdminProductFeedbackListQuery,
} from '../../application/admin-list.ts';

/** Nest token of the database handle of the list (null in a process without the database). */
export const ADMIN_PRODUCT_FEEDBACKS_DB = Symbol('FEEDBACK_ADMIN_PRODUCT_FEEDBACKS_DB');

/** specs/permissions.yaml (CT-26x): feedback.view, step-up null. */
const VIEW = 'feedback.view';

export interface AdminProductFeedbacksRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

export class AdminProductFeedbacksController {
  readonly #guard: AdminOperationGuard;
  readonly #db: Kysely<Database> | null;

  constructor(guard: AdminOperationGuard, db: Kysely<Database> | null) {
    this.#guard = guard;
    this.#db = db;
  }

  async list(
    request: AdminProductFeedbacksRequest,
    query: AdminProductFeedbackListQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminProductFeedbackPageResponse'>> {
    reply.header('Cache-Control', 'no-store');
    let response: Schema<'AdminProductFeedbackPageResponse'> | undefined;
    await this.#guard.run({ request, permission: VIEW, readOnly: true }, async (actor) => {
      const db = this.#db;
      if (db === null) throw new Error('feedback: the product feedback list needs the database');
      try {
        const data = await listAdminProductFeedbacks(db, actor.appId, query);
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error: unknown) {
        if (error instanceof AdminProductFeedbackFieldsError) {
          const refused = fieldsErrorEnvelope(error.fields, request.id);
          throw new HttpException(refused.body, refused.statusCode);
        }
        throw error;
      }
    });
    if (response === undefined) {
      throw new Error('feedback: admin guard returned without an answer');
    }
    return response;
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators).
{
  const prototype = AdminProductFeedbacksController.prototype;
  Inject(AdminOperationGuard)(AdminProductFeedbacksController, undefined, 0);
  Inject(ADMIN_PRODUCT_FEEDBACKS_DB)(AdminProductFeedbacksController, undefined, 1);
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('product-feedbacks')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListProductFeedbacks'))(prototype, 'list', list);
  Controller('admin/v1')(AdminProductFeedbacksController);
}
