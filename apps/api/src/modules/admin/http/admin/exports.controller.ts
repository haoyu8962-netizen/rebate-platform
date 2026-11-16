// /admin/v1/exports (B1-34f; contract CT-24k adminCreateExport, adminListExports,
// adminDownloadExport, adminRetryExport; 08 BR-ID-42). The admin request check has verified the
// admin_token and the route schema the parameters and body before these run. Every operation goes
// through the platform AdminOperationGuard with the point `export` (10001 / 10403); an unmasked
// create or retry then runs inside a second guard call on `pii.reveal_phone`, whose totp tier
// claims X-Step-Up-Token and consumes it only after the 2xx answer (a refusal or a failure keeps
// it usable). Refusals are thrown inside the guard. The download answers Cache-Control: no-store.
// tax_withdrawals (B2-08e; BR-WDR-21): the masked version is `export` plus fund.view (use case); the
// full version enters on tax.export_full instead, then its request rules, then a second guard call
// on that point for the totp step-up. List, download and retry enter on either point without a
// token (readOnly); the use case decides per task what tax.export_full reaches. No branch here
// skips the guard for a super admin.
// ledger (CT-24zzm): `export` plus fund.view or user.lookup (use case), always masked, so it never
// reaches the second guard call.
// Served by the admin entry only.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  EXPORT_ACCESS_POINTS,
  EXPORT_POINT,
  EXPORT_TAX_FULL_POINT,
  ExportCreatorInactiveError,
  ExportFieldsError,
  ExportPermissionError,
  ExportStatusError,
  exportFullPoint,
  type AdminExports,
  type ExportCreateCommand,
  type ExportResource,
  type ExportStatus,
} from '../../application/admin-exports.ts';
import { ADMIN_MESSAGES } from '../../application/admin-check.ts';
import { STEP_UP_MESSAGES } from '../../application/permission-guard.ts';
import { ADMIN_EXPORTS } from '../../application/tokens.ts';
import { ADMIN_PAGE_DEFAULT, ADMIN_PAGE_SIZE_DEFAULT } from '../../domain/admin-view.ts';

type ExportResponse = Schema<'AdminExportResponse'>;
type PageResponse = Schema<'AdminExportPageResponse'>;
type DownloadResponse = Schema<'AdminExportDownloadResponse'>;

/** Fallback text of 30417 (clients show their dictionary text error.30417). */
const STATUS_MESSAGE = '导出任务当前的状态不允许这项操作，请刷新后查看';

interface ExportsRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
  /** Validated and coerced by the contract's route schema. */
  readonly query: {
    readonly page?: number;
    readonly page_size?: number;
    readonly status?: ExportStatus;
    readonly resource?: ExportResource;
    readonly from?: string;
    readonly to?: string;
  };
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

function ipOf(request: ExportsRequest): string | null {
  return typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null;
}

function commandOf(body: Schema<'AdminExportCreateRequest'>): ExportCreateCommand {
  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(body.filters ?? {})) {
    if (typeof value === 'string') filters[key] = value;
  }
  if (body.resource === 'audit_logs') return { resource: 'audit_logs', filters };
  // Always masked (CT-24zzm): the schema's ledger branch takes neither unmasked nor reason.
  if (body.resource === 'ledger') return { resource: 'ledger', filters };
  return {
    resource: body.resource,
    filters,
    ...(body.unmasked === undefined ? {} : { unmasked: body.unmasked }),
    ...(body.reason === undefined ? {} : { reason: body.reason }),
  };
}

/** The use case's refusals as error envelopes; anything else is left to the global handling. */
function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof ExportCreatorInactiveError) {
    // Disabled meanwhile (B1-34h): the same answer as its next admin_token check.
    return new HttpException({ code: 10001, msg: ADMIN_MESSAGES[10001], trace_id: traceId }, 401);
  }
  if (error instanceof ExportFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    return new HttpException(refused.body, refused.statusCode);
  }
  if (error instanceof ExportPermissionError) {
    return new HttpException(
      {
        code: 10403,
        msg: STEP_UP_MESSAGES.admin_permission_denied,
        data: { reason: 'admin_permission_denied' },
        trace_id: traceId,
      },
      403,
    );
  }
  if (error instanceof ExportStatusError) {
    return new HttpException(
      { code: 30417, msg: STATUS_MESSAGE, data: { status: error.status }, trace_id: traceId },
      422,
    );
  }
  return error;
}

function answered<T>(response: T | undefined): T {
  if (response === undefined) throw new Error('admin: export guard returned without an answer');
  return response;
}

@Controller('admin/v1/exports')
export class AdminExportsController {
  constructor(
    @Inject(AdminOperationGuard) private readonly guard: AdminOperationGuard,
    @Inject(ADMIN_EXPORTS) private readonly exports: AdminExports,
  ) {}

  /** adminCreateExport: 202 with the new pending task. */
  @Post()
  @HttpCode(202)
  @RouteSchema(contractRouteSchema('adminCreateExport'))
  async create(
    @Req() request: ExportsRequest,
    @Body() body: Schema<'AdminExportCreateRequest'>,
  ): Promise<ExportResponse> {
    const command = commandOf(body);
    // The full tax version does not need export; its token is checked by the second guard call.
    const entry =
      command.resource === 'tax_withdrawals' && command.unmasked === true
        ? { request, permission: EXPORT_TAX_FULL_POINT, readOnly: true }
        : { request, permission: EXPORT_POINT };
    let response: ExportResponse | undefined;
    await this.guard.run(entry, async (actor) => {
      try {
        const { masked } = await this.exports.checkCreate(actor, command);
        const run = async () => {
          const data = await this.exports.create(actor, command, ipOf(request));
          response = { code: 0, msg: '', data, trace_id: request.id };
          return { statusCode: 202, body: response };
        };
        if (masked) return await run();
        // Full values: the resource's point and its totp step-up, consumed only by this success.
        return await this.guard.run(
          { request, permission: exportFullPoint(command.resource) },
          run,
        );
      } catch (error) {
        throw refusal(error, request.id);
      }
    });
    return answered(response);
  }

  /** adminListExports: own tasks, or the app's with audit.view_all; newest first. */
  @Get()
  @RouteSchema(contractRouteSchema('adminListExports'))
  async list(@Req() request: ExportsRequest): Promise<PageResponse> {
    let response: PageResponse | undefined;
    const query = request.query;
    const access = { request, permission: EXPORT_ACCESS_POINTS, readOnly: true };
    await this.guard.run(access, async (actor) => {
      try {
        const page = await this.exports.list(actor, {
          page: query.page ?? ADMIN_PAGE_DEFAULT,
          pageSize: query.page_size ?? ADMIN_PAGE_SIZE_DEFAULT,
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.resource === undefined ? {} : { resource: query.resource }),
          ...(query.from === undefined ? {} : { from: query.from }),
          ...(query.to === undefined ? {} : { to: query.to }),
        });
        response = {
          code: 0,
          msg: '',
          data: {
            items: [...page.items],
            page: page.page,
            page_size: page.pageSize,
            total: page.total,
          },
          trace_id: request.id,
        };
        return { statusCode: 200, body: response };
      } catch (error) {
        throw refusal(error, request.id);
      }
    });
    return answered(response);
  }

  /** adminDownloadExport: a freshly signed short-lived link to one's own done file (audited). */
  @Get(':id/download')
  @RouteSchema(contractRouteSchema('adminDownloadExport'))
  async download(
    @Req() request: ExportsRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<DownloadResponse> {
    reply.header('Cache-Control', 'no-store');
    let response: DownloadResponse | undefined;
    const access = { request, permission: EXPORT_ACCESS_POINTS, readOnly: true };
    await this.guard.run(access, async (actor) => {
      try {
        const link = await this.exports.download(actor, id, ipOf(request));
        response = {
          code: 0,
          msg: '',
          data: { url: link.url, url_expires_at: link.expiresAt.toISOString() },
          trace_id: request.id,
        };
        return { statusCode: 200, body: response };
      } catch (error) {
        throw refusal(error, request.id);
      }
    });
    return answered(response);
  }

  /** adminRetryExport: one's own failed task back to pending. */
  @Post(':id/retry')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('adminRetryExport'))
  async retry(
    @Req() request: ExportsRequest,
    @Param('id') id: string,
    @Body() body: Schema<'AdminExportRetryRequest'>,
  ): Promise<ExportResponse> {
    let response: ExportResponse | undefined;
    // readOnly only because export has no tier of its own: the token is the second guard call's.
    const access = { request, permission: EXPORT_ACCESS_POINTS, readOnly: true };
    await this.guard.run(access, async (actor) => {
      try {
        const target = await this.exports.checkRetry(actor, id, {
          ...(body.reason === undefined ? {} : { reason: body.reason }),
        });
        const run = async () => {
          const data = await this.exports.retry(actor, target, ipOf(request));
          response = { code: 0, msg: '', data, trace_id: request.id };
          return { statusCode: 200, body: response };
        };
        if (target.task.masked) return await run();
        // Every generation of a full-value file is verified anew (new token, new reason).
        const point = exportFullPoint(target.task.resource as ExportResource);
        return await this.guard.run({ request, permission: point }, run);
      } catch (error) {
        throw refusal(error, request.id);
      }
    });
    return answered(response);
  }
}
