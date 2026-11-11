import { Controller, Get, HttpCode, HttpException, Inject, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  contractRouteSchema,
  fieldsErrorEnvelope,
  isVersionGatedPlatform,
} from '../../../platform/index.ts';
import { SharePageService } from '../../application/share-page.ts';

type SharePageResponse = Schema<'SharePageResponse'>;
type ShareTpwdResponse = Schema<'ShareTpwdResponse'>;

/** What this controller reads of the Fastify request, already checked by the route schema. */
interface SharePageHttpRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Fastify's client address (proxy trust only from the configured trusted proxies). */
  readonly ip: string;
  readonly params: { readonly link_id: string };
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

interface ShareTpwdHttpRequest extends SharePageHttpRequest {
  readonly body: Schema<'ShareTpwdRequest'>;
}

/** What this controller writes on the Fastify reply besides the body. */
interface HeaderReply {
  header(name: string, value: string): unknown;
}

function header(request: SharePageHttpRequest, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}

/** The User-Agent; absent or empty is null (judged as WeChat by the use case). */
function userAgent(request: SharePageHttpRequest): string | null {
  const value = header(request, 'user-agent');
  return value === '' ? null : value;
}

/**
 * X-App-Version of the share page operations is optional in the contract (AppVersionH5Optional;
 * D10-1232 / D10-1246, 规划/08 BR-ID-01 「最低支持版本拦截」: h5 and admin are not judged by
 * version). The three apps (X-Platform ios / android / harmony) must still send it: a missing one
 * is refused exactly as the route schema of every other operation refuses it (400, 20001,
 * data.fields=[x-app-version], trace_id = the request id). A value that is sent was already
 * format-checked by the route schema on every platform.
 */
function requireAppVersionOnApps(request: SharePageHttpRequest): void {
  if (!isVersionGatedPlatform(header(request, 'x-platform'))) return;
  if (header(request, 'x-app-version') !== '') return;
  const { statusCode, body } = fieldsErrorEnvelope(['x-app-version'], request.id);
  throw new HttpException(body, statusCode);
}

/**
 * Contract operations `getSharePage` and `getShareTpwd` (B1-15u; BR-ATTR-10 细则「中间页的口令按
 * 打开环境区分」, BR-ATTR-05 细则): x-auth none, not signed, no X-Device-Id, not idempotent. The app
 * is the request's X-App-Id (route schema checked); no identity is read. Every answer of both,
 * success or refusal, is Cache-Control: no-store (set before the use case runs, so errors keep it);
 * a 42901 carries Retry-After.
 *
 * Nest's decorators are applied as plain calls below (not decorator syntax), as in the landing's
 * controller: linking's index is reachable from the test project without legacy decorators.
 */
export class SharePageController {
  readonly #pages: SharePageService;

  constructor(pages: SharePageService) {
    this.#pages = pages;
  }

  async get(request: SharePageHttpRequest, reply: HeaderReply): Promise<SharePageResponse> {
    reply.header('Cache-Control', 'no-store');
    requireAppVersionOnApps(request);
    const result = await this.#pages.get({
      appId: header(request, 'x-app-id'),
      linkId: request.params.link_id,
      // The caller's X-Trace-Id (schema-checked) when given, else the id genReqId assigned.
      traceId: header(request, 'x-trace-id') || request.id,
      userAgent: userAgent(request),
    });
    if (result.status === 200 && result.envelope.code === 0) {
      return result.envelope as unknown as SharePageResponse;
    }
    throw new HttpException(result.envelope, result.status);
  }

  async tpwd(request: ShareTpwdHttpRequest, reply: HeaderReply): Promise<ShareTpwdResponse> {
    reply.header('Cache-Control', 'no-store');
    requireAppVersionOnApps(request);
    const result = await this.#pages.tpwd({
      appId: header(request, 'x-app-id'),
      linkId: request.params.link_id,
      traceId: header(request, 'x-trace-id') || request.id,
      userAgent: userAgent(request),
      ticket: request.body.ticket,
      ip: request.ip,
    });
    if (result.status === 200 && result.envelope.code === 0) {
      return result.envelope as unknown as ShareTpwdResponse;
    }
    if (result.retryAfterSec !== undefined) {
      reply.header('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterSec))));
    }
    throw new HttpException(result.envelope, result.status);
  }
}

{
  const prototype = SharePageController.prototype;
  const getDescriptor = Object.getOwnPropertyDescriptor(prototype, 'get')!;
  const tpwdDescriptor = Object.getOwnPropertyDescriptor(prototype, 'tpwd')!;
  Inject(SharePageService)(SharePageController, undefined, 0);
  Req()(prototype, 'get', 0);
  Res({ passthrough: true })(prototype, 'get', 1);
  Get('share-pages/:link_id')(prototype, 'get', getDescriptor);
  RouteSchema(contractRouteSchema('getSharePage'))(prototype, 'get', getDescriptor);
  Req()(prototype, 'tpwd', 0);
  Res({ passthrough: true })(prototype, 'tpwd', 1);
  Post('share-pages/:link_id/tpwd')(prototype, 'tpwd', tpwdDescriptor);
  HttpCode(200)(prototype, 'tpwd', tpwdDescriptor);
  RouteSchema(contractRouteSchema('getShareTpwd'))(prototype, 'tpwd', tpwdDescriptor);
  Controller('v1')(SharePageController);
}
