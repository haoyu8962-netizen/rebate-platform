// /admin/v1/audit-logs (B1-34a; contract operations adminListAuditLogs, adminGetAuditLog). Any
// signed-in admin account: the admin request check (application/admin-check.ts) has verified the
// admin_token before the route schema ran; visibility (audit.view_all) is the use case's. The
// handlers take the parameters, refuse `from` later than `to` (20001 [from, to]), call the use
// case and map its answer. Served by the admin entry only.
import { Controller, Get, HttpException, Inject, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  adminPrincipal,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type AdminPrincipal,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  auditRangeInvalid,
  type AuditLogItemView,
  type AuditLogsReader,
} from '../../application/audit-logs-read.ts';
import { ADMIN_AUDIT_LOGS_READ } from '../../application/tokens.ts';
import { ADMIN_PAGE_DEFAULT, ADMIN_PAGE_SIZE_DEFAULT } from '../../domain/admin-view.ts';

type PageResponse = Schema<'AdminAuditLogPageResponse'>;
type DetailResponse = Schema<'AdminAuditLogResponse'>;
type Item = Schema<'AdminAuditLogListItem'>;
type Detail = Schema<'AdminAuditLog'>;

interface AuditLogsRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Validated and coerced by the contract's route schema. */
  readonly query: {
    readonly page?: number;
    readonly page_size?: number;
    readonly actor_id?: string;
    readonly target_type?: string;
    readonly target_id?: string;
    readonly permission?: string;
    readonly from?: string;
    readonly to?: string;
  };
  readonly params: { readonly id?: string };
}

function principalOf(request: AuditLogsRequest): AdminPrincipal {
  const principal = adminPrincipal(request);
  // Unreachable behind the admin token check; never answer 200 for an unchecked request.
  if (principal === undefined) throw new Error('admin: audit read without a verified admin_token');
  return principal;
}

function refuse(fields: string[], request: AuditLogsRequest): never {
  const { statusCode, body } = fieldsErrorEnvelope(fields, request.id);
  throw new HttpException(body, statusCode);
}

function toItem(view: AuditLogItemView): Item {
  return {
    id: view.id,
    actor_id: view.actorId,
    ...(view.actorKind === undefined ? {} : { actor_kind: view.actorKind }),
    // The stored value's format is fixed by the table's CHECK; the enum grows with its writers.
    ...(view.systemActor === undefined
      ? {}
      : { system_actor: view.systemActor as NonNullable<Item['system_actor']> }),
    actor_name: view.actorName,
    action: view.action,
    target_type: view.targetType,
    target_id: view.targetId,
    permission: view.permission,
    ip: view.ip,
    at: view.at.toISOString(),
  };
}

@Controller('admin/v1/audit-logs')
export class AdminAuditLogsController {
  constructor(@Inject(ADMIN_AUDIT_LOGS_READ) private readonly reader: AuditLogsReader) {}

  /** adminListAuditLogs: one page of the app's records, newest first. */
  @Get()
  @RouteSchema(contractRouteSchema('adminListAuditLogs'))
  async list(@Req() request: AuditLogsRequest): Promise<PageResponse> {
    const principal = principalOf(request);
    const query = request.query;
    if (auditRangeInvalid(query.from, query.to)) refuse(['from', 'to'], request);
    const result = await this.reader.list(principal, {
      page: query.page ?? ADMIN_PAGE_DEFAULT,
      pageSize: query.page_size ?? ADMIN_PAGE_SIZE_DEFAULT,
      ...(query.actor_id === undefined ? {} : { actorId: query.actor_id }),
      ...(query.target_type === undefined ? {} : { targetType: query.target_type }),
      ...(query.target_id === undefined ? {} : { targetId: query.target_id }),
      ...(query.permission === undefined ? {} : { permission: query.permission }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
    });
    return {
      code: 0,
      msg: '',
      data: {
        items: result.items.map(toItem),
        page: result.page,
        page_size: result.pageSize,
        total: result.total,
      },
      trace_id: request.id,
    };
  }

  /** adminGetAuditLog: one visible record; anything else → 20001 [id]. */
  @Get(':id')
  @RouteSchema(contractRouteSchema('adminGetAuditLog'))
  async get(@Req() request: AuditLogsRequest): Promise<DetailResponse> {
    const principal = principalOf(request);
    const view = await this.reader.get(principal, request.params.id ?? '');
    if (view === undefined) refuse(['id'], request);
    const data: Detail = { ...toItem(view), before: view.before, after: view.after };
    return { code: 0, msg: '', data, trace_id: request.id };
  }
}
