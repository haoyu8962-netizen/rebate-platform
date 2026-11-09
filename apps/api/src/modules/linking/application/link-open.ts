// B1-06e: the open use case the HTTP controller calls — B1-06d (whom the open serves) and B1-06k
// (price re-check, idempotency, single flight, link_logs, attempts) composed with the jd / pdd
// server conversion (link-open-conversion.ts). Amounts leave here as safe JSON integers.
import type { components } from '@couli/contracts-ts';
import type { HandlerResult } from '../../platform/index.ts';
import { createLinkOpenConversion, type LinkConversionOptions } from './link-open-conversion.ts';
import {
  createLinkOpenRequote,
  type LinkOpenRequoteInput,
  type LinkOpenRequoteOptions,
  type LinkOpenRequoteOutcome,
  type LinkOpenRequoteResult,
  type LinkOpenRequoteService,
} from './link-open-requote.ts';

export interface LinkOpenInput extends LinkOpenRequoteInput {
  readonly noRebateReason?: components['schemas']['OpenLinkRequest']['no_rebate_reason'];
}

/** HTTP injection token. Controller takes identity from CallerContext, never body fields. */
export class LinkOpenService {
  open(input: LinkOpenInput): Promise<HandlerResult> {
    void input;
    return Promise.reject(new Error('linking: open service is not composed in this process'));
  }
}

type OpenLinkResult = components['schemas']['OpenLinkResult'];

/**
 * HTTP status per contracts/error-codes.yaml for every code an open can answer, including the
 * idempotency layer's own envelopes (20001 / 20901 / 20903 / 40901), which must stay 400 / 409.
 */
const STATUS: Readonly<Record<number, number>> = {
  0: 200,
  10001: 401,
  20001: 400,
  20901: 409,
  20903: 409,
  30101: 422,
  30102: 422,
  30111: 422,
  30131: 422,
  30141: 422,
  30143: 422,
  30144: 404,
  30153: 422,
  30602: 422,
  40901: 409,
  50001: 500,
  50301: 503,
  50303: 503,
};

/** Fallback texts only; clients show the dictionary text error.<code> (BR-TEXT-14). */
const MESSAGES: Readonly<Record<number, string>> = {
  0: 'ok',
  10001: '请先登录',
  20001: '参数错误',
  20901: '请求重复且内容不同',
  20903: '该请求已放弃',
  30101: '请先授权淘宝',
  30102: '淘宝授权已失效，请重新授权',
  30111: '购买前需完成拼多多授权',
  30131: '不支持该链接或平台',
  30143: '商品信息已失效',
  30141: '商品已下架',
  30144: '链接不存在',
  30153: '该平台返利已被停用，请联系客服',
  30602: '淘礼金已领完',
  40901: '请求处理中，请稍后',
  50001: '服务端错误',
  50301: '该平台暂时无法购买，请稍后再试',
  50303: '暂时无法确认价格或生成链接，请稍后再试',
};

/** A decimal fen string as a JSON integer; beyond the safe range it is a server fault. */
function fenNumber(value: string | null): number | null {
  if (value === null) return null;
  const fen = BigInt(value);
  if (fen > BigInt(Number.MAX_SAFE_INTEGER) || fen < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('linking: fen amount outside the safe JSON integer range');
  }
  return Number(fen);
}

function wire(data: LinkOpenRequoteResult): OpenLinkResult {
  return {
    ...data,
    old_final_price_fen: fenNumber(data.old_final_price_fen),
    new_final_price_fen: fenNumber(data.new_final_price_fen),
    new_rebate_min_fen: fenNumber(data.new_rebate_min_fen),
    new_rebate_max_fen: fenNumber(data.new_rebate_max_fen),
  } as OpenLinkResult;
}

class ComposedLinkOpen extends LinkOpenService {
  readonly #requote: LinkOpenRequoteService;

  constructor(requote: LinkOpenRequoteService) {
    super();
    this.#requote = requote;
  }

  override async open(input: LinkOpenInput): Promise<HandlerResult> {
    return openHttpResult(await this.#requote.open(input), input.traceId);
  }
}

/** The HTTP result of an open outcome: status per contracts/error-codes.yaml, never 500 by gap. */
export function openHttpResult(outcome: LinkOpenRequoteOutcome, traceId: string): HandlerResult {
  if (outcome.code === 0 && outcome.data !== null) {
    return {
      status: 200,
      envelope: { code: 0, msg: MESSAGES[0]!, data: wire(outcome.data), trace_id: traceId },
    };
  }
  // Error envelopes carry data only for codes that define it (ErrorEnvelope): 20001, which only
  // the idempotency layer answers, for the Idempotency-Key header; 30101 / 30102 / 30153 with the
  // authorization's data (B1-06f: auth_url, state, auth_methods, or reason); 30111 with auth_jump
  // or reason and 50301 with reason=maintenance (B1-06v), or, switched off, exactly { platform,
  // reason } (B1-06zl, reason from convert.off_reason.<platform>). B1-06i: a convert's own 20001
  // (item_ref of another product, platform mismatch) carries its fields as the error data, which
  // wins.
  // A convert's success data keeps its link_id through wire().
  const error = 'error' in outcome ? outcome.error : undefined;
  return {
    status: STATUS[outcome.code] ?? 500,
    envelope: {
      code: outcome.code,
      msg: MESSAGES[outcome.code] ?? '服务端错误',
      ...(outcome.code === 20001 ? { data: { fields: ['idempotency-key'] } } : {}),
      ...(error === undefined ? {} : { data: { ...error } }),
      trace_id: traceId,
    },
  };
}

/** The HTTP-facing open of an already composed requote service (B1-06w wiring). */
export function linkOpenOf(requote: LinkOpenRequoteService): LinkOpenService {
  return new ComposedLinkOpen(requote);
}

/** Compose ownership/requote with server conversion; serialize fen as safe JSON integers. */
export function createLinkOpen(
  options: Omit<LinkOpenRequoteOptions, 'conversion'> & LinkConversionOptions,
): LinkOpenService {
  const conversion = createLinkOpenConversion(options);
  return new ComposedLinkOpen(createLinkOpenRequote({ ...options, conversion }));
}
