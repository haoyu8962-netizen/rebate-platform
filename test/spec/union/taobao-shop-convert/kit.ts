import { inspect } from 'node:util';
import { expect, vi, type Mock } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  classifyUnionError,
  UnionError,
  UnionIdentity,
  type CallCtx,
  type IdentityClaims,
  type ShopConvertReq,
  type ShopConvertResult,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionErrorCode,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  DataokeClient,
  type DataokeCredentials,
  type DataokeRandom,
  type DataokeWarning,
} from '../../../../apps/api/src/modules/union/infra/dataoke/dataoke-client.ts';
import type {
  UnionTransport,
  UnionTransportRequest,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  TaobaoUnionAdapter,
  type TaobaoCredentials,
  type TaobaoWarning,
} from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';

// Task-local AC labels ([AC-B1-04zzt#n]) identify this task's acceptance points, not business rules.
// 合成、非录制：网关、店铺 ID、店名、推广位、relation_id、链接、淘口令都是合成值；字段名只用编排者给出的
// 大淘客店铺转链实测口径（入参 sellerId / pid / shopName / relationId，出参 data 只有 shopLinks、
// tpwd（小写；文档写 Tpwd）、longTpwd），不读私有录制。secret 是低熵重复串。传输全在内存中。

export const SHOP_PATH = '/api/dels/shop/convert';
export const SHOP_VERSION = 'v1.0.0';
/** The 大淘客 public parameters every request carries (B1-04m). */
export const PUBLIC_KEYS: readonly string[] = ['appKey', 'nonce', 'signRan', 'timer', 'version'];
/** A synthetic https gateway; a deployment wires https://openapi.dataoke.com. */
export const DATAOKE_BASE = 'https://dataoke-shop.invalid';
export const DATAOKE_APP_KEY = 'fake-dataoke-shop-app-key';
export const DATAOKE_SECRET = 'shp-shp-shp-shp-shp-shp';
export const TAOBAO_APP_KEY = 'fake-taobao-shop-app-key';
export const TAOBAO_SECRET = 'tbs-tbs-tbs-tbs-tbs-tbs';
export const instant = '2026-11-07T02:03:04.000Z';
export const endpoint: UnionEndpoint = {
  platform: 'taobao',
  mode: 'live',
  baseUrl: 'https://taobao-shop.invalid/router/rest',
  quotaKey: 'fake-taobao-shop-account',
};
export const ctx: CallCtx = {
  appId: 'fake-shop-app',
  requestId: 'fake-shop-request',
  purpose: 'online',
};

/** UnionItem.shop_ref of the item on screen (B1-04zzs): a positive decimal string. */
export const SHOP_REF = '2208765432101';
export const SHOP_NAME = '合成小店 Synthetic Shop';
export const shopReq: ShopConvertReq = { shopRef: SHOP_REF, shopName: SHOP_NAME };

/** Synthetic mm_ three-segment promotion slots (self-buy / share). */
export const SELF_SLOT = 'mm_1001_2002_3003';
export const SHARE_SLOT = 'mm_1001_2002_4004';
export const RELATION_ID = 'synthetic-relation-806';
export const USER_ID = 'internal-user-must-not-leak';

/** Structural stand-in for linking's server-built subclass; no linking import in union. */
export class TestIdentity extends UnionIdentity {
  constructor(claims: Partial<IdentityClaims> = {}) {
    super({
      appId: ctx.appId,
      userId: USER_ID,
      platform: 'taobao',
      promotionSlot: SELF_SLOT,
      relationId: RELATION_ID,
      ...claims,
    });
  }
}

export const identity = new TestIdentity();

export const SHOP_LINK = 'https://s.click.taobao.com/t?e=synthetic-shop-link-806';
export const TPWD = '$SynthShop01$';
export const LONG_TPWD = 'synthetic long shop text $SynthShop01$ /';

/** The measured `data` key set with synthetic values. */
export function shopData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { shopLinks: SHOP_LINK, tpwd: TPWD, longTpwd: LONG_TPWD, ...overrides };
}

/** `shopData()` without the named keys. */
export function dataWithout(...keys: string[]): Record<string, unknown> {
  const data = shopData();
  for (const key of keys) delete data[key];
  return data;
}

export function response(body: unknown, status = 200): UnionTransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json;charset=utf-8' },
    body: JSON.stringify(body),
  };
}

/** The 大淘客 success envelope around `data`. */
export function envelope(data: unknown = shopData()): Record<string, unknown> {
  return { time: 1793932984000, code: 0, msg: 'ok', data };
}

export interface SetupOptions {
  /** The whole 大淘客 transport response; default: success envelope around shopData(). */
  readonly reply?: UnionTransportResponse;
  /** Whether the adapter gets the 大淘客 client as orderSource. Default true. */
  readonly withSource?: boolean;
}

/** A live Taobao adapter over in-memory transports; no convertSource / searchSource switch set. */
export function setup(options: SetupOptions = {}) {
  const clock = new FixedClock(instant);
  const taobaoCredentials = vi.fn<() => Promise<TaobaoCredentials>>(async () => ({
    appKey: TAOBAO_APP_KEY,
    appSecret: TAOBAO_SECRET,
  }));
  const taobaoTransport = vi.fn<UnionTransport>(async () => response({}));
  const dataokeCredentials = vi.fn<() => Promise<DataokeCredentials>>(async () => ({
    appKey: DATAOKE_APP_KEY,
    appSecret: DATAOKE_SECRET,
  }));
  const random = vi.fn<DataokeRandom>().mockReturnValue(42);
  const reply = options.reply ?? response(envelope());
  const dataokeTransport = vi.fn<UnionTransport>(async () => reply);
  const warn = vi.fn<(event: TaobaoWarning) => void>();
  const dataokeWarn = vi.fn<(event: DataokeWarning) => void>();
  const orderSource = new DataokeClient({
    credentials: dataokeCredentials,
    transport: dataokeTransport,
    clock,
    random,
    baseUrl: DATAOKE_BASE,
    warn: dataokeWarn,
  });
  const adapter = new TaobaoUnionAdapter({
    credentials: taobaoCredentials,
    transport: taobaoTransport,
    clock,
    endpoint,
    warn,
    ...(options.withSource === false ? {} : { orderSource }),
  });
  return {
    adapter,
    clock,
    taobaoCredentials,
    taobaoTransport,
    dataokeCredentials,
    dataokeTransport,
    random,
    warn,
    dataokeWarn,
  };
}

export type Harness = ReturnType<typeof setup>;

/** Calls the adapter's convertShop as a method of the adapter; it must be offered. */
export function callShop(
  adapter: UnionAdapter,
  req: ShopConvertReq = shopReq,
  who: UnionIdentity = identity,
  call: CallCtx = ctx,
): Promise<ShopConvertResult> {
  const method = adapter.convertShop;
  expect(method, 'convertShop is offered').toBeTypeOf('function');
  return method!.call(adapter, req, who, call);
}

/** The request a transport received on call `index`. */
export function sent(transport: Mock<UnionTransport>, index = 0): UnionTransportRequest {
  const call = transport.mock.calls[index];
  expect(call, `transport call ${index}`).toBeDefined();
  return call![0];
}

/** The decoded query string; every field name must appear exactly once. */
export function queryFields(request: UnionTransportRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of new URL(request.url).searchParams) {
    expect(Object.hasOwn(out, name), `query field ${name} appears once`).toBe(false);
    out[name] = value;
  }
  return out;
}

/** The one 大淘客 request of a shop conversion: GET to the gateway + path, no body. */
export function shopRequest(
  h: Harness,
  base: string = DATAOKE_BASE,
): {
  readonly request: UnionTransportRequest;
  readonly fields: Record<string, string>;
} {
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
  const request = sent(h.dataokeTransport);
  expect(request.platform).toBe('taobao');
  expect(request.method).toBe('GET');
  expect(request.body).toBeUndefined();
  const url = new URL(request.url);
  expect(`${url.origin}${url.pathname}`).toBe(`${base}${SHOP_PATH}`);
  return { request, fields: queryFields(request) };
}

/** Runs a shop conversion that must succeed; any rejection is an assertion failure. */
export async function converted(run: () => Promise<ShopConvertResult>): Promise<ShopConvertResult> {
  let result: ShopConvertResult | undefined;
  let failure: unknown;
  try {
    result = await run();
  } catch (error) {
    failure = error;
  }
  expect(failure, 'convertShop must succeed').toBeUndefined();
  expect(result).toBeTypeOf('object');
  return result!;
}

async function caught(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The call must reject with a taobao UnionError of `code`. */
export async function unionFailure(run: () => unknown, code: UnionErrorCode): Promise<UnionError> {
  const error = await caught(run);
  expect(error).toBeInstanceOf(UnionError);
  expect(error).toMatchObject({ code, platform: 'taobao' });
  return error as UnionError;
}

/**
 * The call must be refused as a business refusal: a taobao UnionError the governor classifies
 * `rejected` (never retried, not a dependency failure); the code is the implementation's choice.
 */
export async function refusal(run: () => unknown): Promise<UnionError> {
  const error = await caught(run);
  expect(error).toBeInstanceOf(UnionError);
  expect(error).toMatchObject({ platform: 'taobao' });
  expect(classifyUnionError(error)).toBe('rejected');
  return error as UnionError;
}

/** Everything a value would show when printed, serialized or inspected. */
export function visible(value: unknown): string {
  const json = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? `${item}n` : item,
  );
  return `${String(value)}\n${json}\n${inspect(value, { depth: null })}`;
}

/** The error carries no promotion slot, relation id, secret nor any of the given link texts. */
export function expectQuietError(error: unknown, ...links: readonly string[]): void {
  const text = visible(error);
  for (const marker of [SELF_SLOT, RELATION_ID, DATAOKE_SECRET, SHOP_LINK, ...links]) {
    expect(text).not.toContain(marker);
  }
}

/** Nothing was fetched or sent on either the taobao or the 大淘客 side. */
export function expectNothingSent(h: Harness): void {
  expect(h.dataokeCredentials).not.toHaveBeenCalled();
  expect(h.dataokeTransport).not.toHaveBeenCalled();
  expect(h.random).not.toHaveBeenCalled();
  expect(h.taobaoCredentials).not.toHaveBeenCalled();
  expect(h.taobaoTransport).not.toHaveBeenCalled();
}

/** The only keys a shop conversion may expose. */
export const ALLOWED_RESULT_KEYS: ReadonlySet<string> = new Set(['url', 'tpwd', 'longTpwd']);
