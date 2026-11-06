// B1-28p: POST /v1/products/{product_key}/feedback (contract CT-26q submitProductFeedback; x-auth
// optional, x-signed, x-idempotent, x-min-version-gate). Only authentication, parameters and the call
// into the use case live here (application/submit.ts).
//
// - Who submits comes from the request checks only: the device verified by the signature (stage
//   ①: a device not issued, or revoked after the privacy consent was withdrawn, is 10402 there, so
//   only guests who accepted the privacy policy get here) and, when a token was sent, the token's
//   user (stage ②). No header or body field names a user or a device.
// - The route schema comes from the contract: any field BR-ID-30 细则「商品反馈记录」 does not list
//   is 20001 before this handler runs.
// - feedback.enabled and feedback.daily_limit_per_device are read before the idempotency
//   transaction holds a pool connection; the use case runs in platform idempotency's transactional
//   mode, so the record and the `completed` key commit together and a replay of an accepted key
//   answers the first result before any rule (also after the day's limit is reached).
// - 42901 carries Retry-After (seconds to the next +08:00 midnight); it is not stored, so the same
//   key may be sent again.
// Without a database (no idempotency primitive or ports) the route fails closed (50001 by the
// global filter).
// Nest metadata is applied below without decorator syntax: the feedback index is reachable from the
// test project, whose compiler settings have no legacy decorators.
import { Controller, HttpCode, Inject, Optional, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  CLOCK,
  IDEMPOTENCY,
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
  type Clock,
  type Idempotency,
} from '../../../platform/index.ts';
import {
  submitFeedback,
  type FeedbackAccountReader,
  type FeedbackLinkReader,
  type FeedbackSettings,
} from '../../application/submit.ts';
import {
  FEEDBACK_DAILY_LIMIT_KEY,
  FEEDBACK_ENABLED_KEY,
  dailyLimit,
  feedbackEnabled,
  requestAppOfDevice,
} from '../../domain/rules.ts';

/** content's configuration read (cached, one reader per process). */
export interface FeedbackConfigReader {
  configValue(appId: string, key: string): Promise<{ readonly value: unknown } | null>;
}

/** What the route needs besides the clock and the idempotency primitive. */
export interface FeedbackRoutePorts {
  readonly config: FeedbackConfigReader;
  readonly links: FeedbackLinkReader;
  readonly accounts: FeedbackAccountReader;
}

/** error-codes.yaml 10403 (App 或请求来源不被允许). */
const FOREIGN_DEVICE_MSG = 'App 或请求来源不被允许';

/** Nest injection token of the route ports (null in a process without a database). */
export const FEEDBACK_ROUTE = Symbol('FEEDBACK_ROUTE');

interface FeedbackRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly params: { readonly product_key: string };
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Schema<'ProductFeedbackRequest'>;
}

interface RawReply {
  code(statusCode: number): RawReply;
  header(name: string, value: string): RawReply;
  type(contentType: string): RawReply;
  send(payload: string): unknown;
}

export class FeedbackController {
  readonly #ports: FeedbackRoutePorts | null;
  readonly #idempotency: Idempotency | undefined;
  readonly #clock: Clock;

  constructor(
    ports: FeedbackRoutePorts | null,
    idempotency: Idempotency | undefined,
    clock: Clock,
  ) {
    this.#ports = ports;
    this.#idempotency = idempotency;
    this.#clock = clock;
  }

  async #settings(ports: FeedbackRoutePorts, appId: string): Promise<FeedbackSettings> {
    const [enabled, limit] = await Promise.all([
      ports.config.configValue(appId, FEEDBACK_ENABLED_KEY),
      ports.config.configValue(appId, FEEDBACK_DAILY_LIMIT_KEY),
    ]);
    return { enabled: feedbackEnabled(enabled?.value), dailyLimit: dailyLimit(limit?.value) };
  }

  async submit(request: FeedbackRequest, reply: RawReply): Promise<void> {
    const ports = this.#ports;
    const idempotency = this.#idempotency;
    const device = request.verifiedDevice;
    if (ports === null || idempotency === undefined || device === undefined) {
      throw new Error('feedback: the route needs the database, idempotency and a verified device');
    }
    const principal = tokenPrincipal(request);
    // Money r1 S2: the signature check finds the device by id alone, so the device must belong to
    // the request's app (the token's, or a guest's X-App-Id); otherwise 10403, nothing written.
    const appId = requestAppOfDevice(device.appId, principal?.app_id, request.headers['x-app-id']);
    if (appId === null) {
      reply
        .code(403)
        .type('application/json; charset=utf-8')
        .send(JSON.stringify({ code: 10403, msg: FOREIGN_DEVICE_MSG, trace_id: request.id }));
      return;
    }
    const productKey = request.params.product_key;
    const settings = await this.#settings(ports, appId);
    const key = request.headers['idempotency-key'];
    let retryAfterSec: number | undefined;
    const result = await idempotency.executeInTransaction(
      {
        appId,
        actor: { userId: principal?.uid ?? null, deviceId: device.deviceId, phoneHmac: null },
        method: 'POST',
        path: `/v1/products/${encodeURIComponent(productKey)}/feedback`,
        key: typeof key === 'string' ? key : undefined,
        body: request.body,
        traceId: request.id,
      },
      async (trx) => {
        const outcome = await submitFeedback(
          trx,
          {
            appId,
            deviceId: device.deviceId,
            userId: principal?.uid ?? null,
            productKey,
            body: request.body,
            traceId: request.id,
          },
          settings,
          { clock: this.#clock, links: ports.links, accounts: ports.accounts },
        );
        retryAfterSec = outcome.retryAfterSec;
        return outcome.result;
      },
    );
    if (result.source === 'handler' && result.status === 429 && retryAfterSec !== undefined) {
      reply.header('Retry-After', String(retryAfterSec));
    }
    reply.code(result.status).type('application/json; charset=utf-8').send(result.body);
  }
}

{
  const prototype = FeedbackController.prototype;
  const submit = Object.getOwnPropertyDescriptor(prototype, 'submit')!;
  Inject(FEEDBACK_ROUTE)(FeedbackController, undefined, 0);
  Inject(IDEMPOTENCY)(FeedbackController, undefined, 1);
  Optional()(FeedbackController, undefined, 1);
  Inject(CLOCK)(FeedbackController, undefined, 2);
  Req()(prototype, 'submit', 0);
  Res()(prototype, 'submit', 1);
  Post('products/:product_key/feedback')(prototype, 'submit', submit);
  HttpCode(200)(prototype, 'submit', submit);
  RouteSchema(contractRouteSchema('submitProductFeedback'))(prototype, 'submit', submit);
  Controller('v1')(FeedbackController);
}
