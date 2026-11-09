// B2-15b: the four user-side pay order operations of contract CT-21c (/v1/pay/orders…; 08
// BR-PAY-01 ②, BR-PAY-02 ～ 05; rulings D10-236 ④, D10-245). Only authentication, parameters and
// the call into application/pay-orders.ts live here.
//
// - The subject is the verified token only (app_id, uid, device_id; BR-AI-03) plus the request's
//   X-Platform (validated by the route schema against ClientPlatformCode); no header, query or
//   body field names a user. The contract schema refuses any amount, title or identity field in
//   the body with 20001 before the handler runs (AC-S2-82 ⑩).
// - Stages ①–⑧ (signature on the three POSTs, token, h5 refusal, version gate, restricted
//   session 10405) are the global guard's; GET is unsigned (D10-245).
// - createPayOrder runs under platform idempotency's standard mode (execute: subject u:<uid>,
//   path /v1/pay/orders): a replay answers the stored bytes without touching the channel; a
//   missing or malformed Idempotency-Key is 20001, another body under the same key 20901. Code 0
//   and 3xxxx results are stored; 20902 and 50306 are not, so the same key may be sent again.
//   B2-15y: a replayed success gives its launch parameters only while the order can be launched;
//   otherwise it answers 30902 / 20902 (replayRefusal), and the stored row stays as it is.
// - Codes as the use case returns them, HTTP status from contracts/error-codes.yaml, msg the
//   BR-TEXT-14 fallback text (contracts/texts.default.json error.<code>).
// - Nothing of a response is logged here; the launch parameters go to the reply only.
// Without a database or the job queue (contract smoke, isolated tests) the routes fail closed
// (50001 by the global filter). Nest metadata is applied by plain calls, as the payout module does.
import type { Schema } from '@couli/contracts-ts';
import { errorCodes } from '@couli/contracts-ts';
import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Optional,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import {
  IDEMPOTENCY,
  contractRouteSchema,
  tokenPrincipal,
  type HandlerResult,
  type Idempotency,
  type TokenPrincipal,
} from '../../../platform/index.ts';
import {
  cancelPayOrder,
  createPayOrder,
  getPayOrder,
  payOrderReturned,
  replayRefusal,
  type PayFailure,
  type PayOrderDeps,
  type PayResult,
  type PaySubject,
} from '../../application/pay-orders.ts';

/** Nest token of the use case dependencies (null in a process without a database or queue). */
export const PAY_ORDER_DEPS = Symbol('PAYMENT_PAY_ORDER_DEPS');

const CREATE_PATH = '/v1/pay/orders';

/** BR-TEXT-14 fallback texts (contracts/texts.default.json error.<code>). */
const MESSAGES: Readonly<Record<PayFailure['code'], string>> = Object.freeze({
  20902: '状态已变化，请刷新后重试',
  30701: '内容不存在或已下线',
  30901: '暂时无法支付，请稍后再试',
  30902: '这笔订单已经支付过了',
  50306: '支付服务繁忙，请稍后再试或换一种支付方式',
});

/** What the handlers read of the Fastify request, already checked by the request checks and the schema. */
export interface PayOrdersHttpRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly params?: { readonly pay_order_id?: string };
  readonly body?: unknown;
  /** Attached by the token check (platform PrincipalCarrier); read with tokenPrincipal. */
  readonly principal?: TokenPrincipal;
}

/** What the create handler writes on the Fastify reply (the idempotency module's stored bytes). */
export interface PayOrdersRawReply {
  code(statusCode: number): PayOrdersRawReply;
  type(contentType: string): PayOrdersRawReply;
  send(payload: string): unknown;
}

function header(request: PayOrdersHttpRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** The use case's answer as status + envelope (success 200 / code 0; failures by the catalog). */
function answer<T>(result: PayResult<T>, traceId: string): HandlerResult {
  if (result.code === 0) {
    return { status: 200, envelope: { code: 0, msg: '', data: result.data, trace_id: traceId } };
  }
  return {
    status: errorCodes[result.code].http,
    envelope: {
      code: result.code,
      msg: MESSAGES[result.code],
      ...('data' in result ? { data: result.data } : {}),
      trace_id: traceId,
    },
  };
}

export class PayOrdersController {
  readonly #deps: PayOrderDeps | null;
  readonly #idempotency: Idempotency | undefined;

  constructor(deps: PayOrderDeps | null, idempotency: Idempotency | undefined) {
    this.#deps = deps;
    this.#idempotency = idempotency;
  }

  #session(request: PayOrdersHttpRequest): {
    deps: PayOrderDeps;
    principal: TokenPrincipal;
    subject: PaySubject;
  } {
    const principal = tokenPrincipal(request);
    const deps = this.#deps;
    const platform = header(request, 'x-platform');
    if (deps === null || principal === undefined || platform === undefined) {
      throw new Error('payment: pay orders need the database, the queue and a verified token');
    }
    return {
      deps,
      principal,
      subject: { app_id: principal.app_id, user_id: principal.uid, platform },
    };
  }

  #orderId(request: PayOrdersHttpRequest): string {
    const id = request.params?.pay_order_id;
    if (typeof id !== 'string' || id === '') {
      throw new Error('payment: the route schema must have validated pay_order_id');
    }
    return id;
  }

  async create(request: PayOrdersHttpRequest, reply: PayOrdersRawReply): Promise<void> {
    const { deps, principal, subject } = this.#session(request);
    const idempotency = this.#idempotency;
    if (idempotency === undefined) {
      throw new Error('payment: creating a pay order needs the idempotency primitive');
    }
    const body = request.body as Schema<'CreatePayOrderRequest'>;
    const traceId = request.id;
    const result = await idempotency.execute(
      {
        appId: principal.app_id,
        actor: { userId: principal.uid, deviceId: principal.device_id, phoneHmac: null },
        method: 'POST',
        path: CREATE_PATH,
        key: header(request, 'idempotency-key'),
        body,
        traceId,
      },
      async () => answer(await createPayOrder(deps, subject, body), traceId),
    );
    const refusal =
      result.source === 'replay' && result.status === 200
        ? await replayRefusal(deps, subject, result.body)
        : null;
    if (refusal !== null) {
      const refused = answer(refusal, traceId);
      reply
        .code(refused.status)
        .type('application/json; charset=utf-8')
        .send(JSON.stringify(refused.envelope));
      return;
    }
    reply.code(result.status).type('application/json; charset=utf-8').send(result.body);
  }

  async get(request: PayOrdersHttpRequest): Promise<Schema<'PayOrderResponse'>> {
    const { deps, subject } = this.#session(request);
    return this.#envelope(await getPayOrder(deps, subject, this.#orderId(request)), request.id);
  }

  async returned(request: PayOrdersHttpRequest): Promise<Schema<'EmptyResponse'>> {
    const { deps, subject } = this.#session(request);
    return this.#envelope(
      await payOrderReturned(deps, subject, this.#orderId(request)),
      request.id,
    );
  }

  async cancel(request: PayOrdersHttpRequest): Promise<Schema<'PayOrderResponse'>> {
    const { deps, subject } = this.#session(request);
    return this.#envelope(await cancelPayOrder(deps, subject, this.#orderId(request)), request.id);
  }

  /** The success envelope, or the failure thrown for the global filter to send as is. */
  #envelope<T>(
    result: PayResult<T>,
    traceId: string,
  ): { code: 0; msg: string; data: T; trace_id: string } {
    if (result.code === 0) return { code: 0, msg: '', data: result.data, trace_id: traceId };
    const failure = answer(result, traceId);
    throw new HttpException(failure.envelope, failure.status);
  }
}

{
  const prototype = PayOrdersController.prototype;
  const create = Object.getOwnPropertyDescriptor(prototype, 'create')!;
  const get = Object.getOwnPropertyDescriptor(prototype, 'get')!;
  const returned = Object.getOwnPropertyDescriptor(prototype, 'returned')!;
  const cancel = Object.getOwnPropertyDescriptor(prototype, 'cancel')!;
  Inject(PAY_ORDER_DEPS)(PayOrdersController, undefined, 0);
  Inject(IDEMPOTENCY)(PayOrdersController, undefined, 1);
  Optional()(PayOrdersController, undefined, 1);
  Req()(prototype, 'create', 0);
  Res()(prototype, 'create', 1);
  Post()(prototype, 'create', create);
  HttpCode(200)(prototype, 'create', create);
  RouteSchema(contractRouteSchema('createPayOrder'))(prototype, 'create', create);
  Req()(prototype, 'get', 0);
  Get(':pay_order_id')(prototype, 'get', get);
  RouteSchema(contractRouteSchema('getPayOrder'))(prototype, 'get', get);
  Req()(prototype, 'returned', 0);
  Post(':pay_order_id/returned')(prototype, 'returned', returned);
  HttpCode(200)(prototype, 'returned', returned);
  RouteSchema(contractRouteSchema('payOrderReturned'))(prototype, 'returned', returned);
  Req()(prototype, 'cancel', 0);
  Post(':pay_order_id/cancel')(prototype, 'cancel', cancel);
  HttpCode(200)(prototype, 'cancel', cancel);
  RouteSchema(contractRouteSchema('cancelPayOrder'))(prototype, 'cancel', cancel);
  Controller('v1/pay/orders')(PayOrdersController);
}
