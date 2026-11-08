// GET /v1/config (task F1-02c; contract getConfig: x-auth optional, unsigned, session scopes
// full and deletion_only). The request checks have already verified any bearer token; the caller
// comes from the request-scoped ConfigViewerContext (identity's, assembled by app.module). The
// X-Device-Id header is read only to bucket a guest's h5_release, never as an identity.
// Served by the api entry only (ContentPublicModule).
//
// Nest's decorators are applied as plain calls below (not decorator syntax): content's index.ts
// is reachable from the test project, whose compiler settings have no legacy decorators.
import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema } from '../../../platform/index.ts';
import { ClientConfigService, ConfigViewerContext } from '../../application/client-config.ts';
import { ifNoneMatchHits } from '../../domain/config-etag.ts';

export interface ConfigRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** What this controller writes on the Fastify reply besides the body (F1-02h). */
export interface ConfigReply {
  header(name: string, value: string): unknown;
  code(statusCode: number): unknown;
}

export class ConfigController {
  readonly #service: ClientConfigService;
  readonly #viewer: ConfigViewerContext;

  constructor(service: ClientConfigService, viewer: ConfigViewerContext) {
    this.#service = service;
    this.#viewer = viewer;
  }

  /**
   * 200 with the strong ETag (data.config_version in quotes); 304 without a body when
   * If-None-Match matches it (F1-02h §9.2-4). The configuration is always assembled first, so a
   * broken configuration or a failed read still answers 50001, never 304.
   */
  async read(
    request: ConfigRequest,
    reply: ConfigReply,
  ): Promise<Schema<'ConfigResponse'> | undefined> {
    const viewer = await this.#viewer.current();
    const device = request.headers['x-device-id'];
    const data = await this.#service.read(
      { appId: viewer.appId, userId: viewer.userId },
      typeof device === 'string' && device !== '' ? device : null,
    );
    const etag = `"${data.config_version ?? ''}"`;
    reply.header('ETag', etag);
    const condition = request.headers['if-none-match'];
    if (ifNoneMatchHits(Array.isArray(condition) ? condition.join(',') : condition, etag)) {
      reply.code(304);
      return undefined;
    }
    return { code: 0, msg: '', data, trace_id: request.id };
  }
}

{
  const prototype = ConfigController.prototype;
  const read = Object.getOwnPropertyDescriptor(prototype, 'read')!;
  Inject(ClientConfigService)(ConfigController, undefined, 0);
  Inject(ConfigViewerContext)(ConfigController, undefined, 1);
  Req()(prototype, 'read', 0);
  Res({ passthrough: true })(prototype, 'read', 1);
  Get('config')(prototype, 'read', read);
  RouteSchema(contractRouteSchema('getConfig'))(prototype, 'read', read);
  Controller('v1')(ConfigController);
}
