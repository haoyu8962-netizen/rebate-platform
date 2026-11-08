import { inspect } from 'node:util';
import { expect, vi } from 'vitest';
import {
  FixedClock,
  type QuotaLimiter,
  type QuotaPurpose,
  type Scheduler,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { governAdapter } from '../../../../apps/api/src/modules/union/application/governed-adapter.ts';
import {
  UnionError,
  type CallCtx,
  type ItemRef,
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
import {
  DETAIL,
  detailBody,
  detailRow,
  errorBody,
  ref,
  shareBody,
  shareData,
  TPWD,
} from '../taobao-goods/kit.ts';

// Task-local AC labels ([AC-B1-04zzzx#n]) name this task's acceptance points, not business rules.
// 依据：D10-514 ③ / D10-967（FU-UNION-CRED-CLASS）与编排者补充第 1–11 条。合成、非录制：网关地址、凭据、
// 路径、ID 都是合成值（凭据是低熵重复串），报文形状沿用 B1-04m / B1-04j / B1-04l 的合成夹具；不联网、
// 不监听端口、不读宿主时钟。

/** D10-967 ①: our own app credentials / signature / API permission (大淘客外层). */
export const MISCONFIGURED_OUTER: readonly number[] = [
  10009, 10010, 10015, 10016, 10018, 10020, 10021, 401,
];
/** D10-967 ①: the site owner's (站长) authorisation (大淘客外层). */
export const SITE_AUTH_OUTER: readonly number[] = [10072, 10210, 10211];
/** Unchanged groups (B1-04m): throttling, temporary server faults, codes outside every group. */
export const RATE_LIMITED_OUTER: readonly number[] = [
  10064, 10045, 10013, 10014, 10022, 10201, 10202, 10038,
];
export const UNAVAILABLE_OUTER: readonly number[] = [
  -1, 500, 503, 10008, 10012, 10019, 10023, 10025, 10053, 10054,
];
export const OTHER_OUTER: readonly number[] = [10071, 10077, 99999];

/** Every outer code that now has a code of its own, with that code. */
export const NEW_OUTER: readonly (readonly [number, UnionErrorCode])[] = [
  ...MISCONFIGURED_OUTER.map((code) => [code, 'upstream_misconfigured'] as const),
  ...SITE_AUTH_OUTER.map((code) => [code, 'site_auth_invalid'] as const),
];

export const PERMISSION_SUB_CODE = 'isv.permission-api-package-limit';
/** Text that must never surface in an error or a warning. */
export const UPSTREAM_TEXT = 'cred-class-upstream-text-marker';

export const endpoint: UnionEndpoint = {
  platform: 'taobao',
  mode: 'live',
  baseUrl: 'https://taobao-cred-class.invalid/router/rest',
  quotaKey: 'synthetic-cred-class',
};
export const DATAOKE_BASE = 'https://dataoke-cred-class.invalid';
export const TAOBAO_SECRET = 'cred-cred-cred-cred-cred';
export const DATAOKE_SECRET = 'cdtk-cdtk-cdtk-cdtk-cdtk';
export const instant = '2026-11-08T03:00:00.000Z';
/** The goods kit's detail item (its default detail row answers for it). */
export const ITEM: ItemRef = ref;
export const LINK = 'https://s.click.taobao.com/t?e=synthetic-cred-class';
export const KEYWORD = '合成 凭据分类 关键词';

export function onlineCtx(purpose: QuotaPurpose = 'online'): CallCtx {
  return { appId: 'synthetic-cred-app', requestId: 'synthetic-cred-request', purpose };
}

export function json(body: unknown, status = 200): UnionTransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json;charset=utf-8' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

/** A 大淘客 answer with this outer code (no data). */
export function dataokeOuter(code: number | string): UnionTransportResponse {
  return json({ time: 1793500000000, code, msg: `${UPSTREAM_TEXT} ${DATAOKE_SECRET}` });
}

/** A TOP error_response with this code (and sub_code). */
export function topFailure(code: number | string, subCode?: number | string) {
  return json(errorBody(code, subCode));
}

/** The TOP gateway's default answers: a detail row and a share code. */
export function topOk(method: string): UnionTransportResponse {
  if (method === DETAIL) return json(detailBody([detailRow()]));
  if (method === TPWD) return json(shareBody(shareData()));
  return topFailure('synthetic-unexpected-method');
}

function formMethod(request: UnionTransportRequest): string {
  return new URLSearchParams(request.body ?? '').get('method') ?? '';
}

export interface LiveAnswers {
  /** The TOP gateway's answer to one method. */
  top: (method: string) => UnionTransportResponse;
  /** The 大淘客 gateway's answer to every request. */
  dataoke: () => UnionTransportResponse;
}

/**
 * The live Taobao adapter over both fake gateways: TOP (detail, share code) and 大淘客 (search, as
 * searchSource 'dataoke'). The answers can be swapped between calls.
 */
export function live(answers: Partial<LiveAnswers> = {}) {
  const clock = new FixedClock(instant);
  const current: LiveAnswers = {
    top: answers.top ?? topOk,
    dataoke: answers.dataoke ?? (() => dataokeOuter(0)),
  };
  const topTransport = vi.fn<UnionTransport>(async (request) => current.top(formMethod(request)));
  const dataokeTransport = vi.fn<UnionTransport>(async () => current.dataoke());
  const warn = vi.fn<(event: TaobaoWarning) => void>();
  const dataokeWarn = vi.fn<(event: DataokeWarning) => void>();
  const orderSource = new DataokeClient({
    baseUrl: DATAOKE_BASE,
    clock,
    credentials: vi.fn<() => Promise<DataokeCredentials>>(async () => ({
      appKey: 'synthetic-cred-dataoke-key',
      appSecret: DATAOKE_SECRET,
    })),
    random: vi.fn<DataokeRandom>().mockReturnValue(42),
    transport: dataokeTransport,
    warn: dataokeWarn,
  });
  const adapter = new TaobaoUnionAdapter({
    clock,
    credentials: vi.fn<() => Promise<TaobaoCredentials>>(async () => ({
      appKey: 'synthetic-cred-taobao-key',
      appSecret: TAOBAO_SECRET,
    })),
    transport: topTransport,
    endpoint,
    warn,
    orderSource,
    searchSource: 'dataoke',
  });
  return { adapter, answers: current, topTransport, dataokeTransport, warn, dataokeWarn };
}

export type Live = ReturnType<typeof live>;

/** No wall-clock waits: backoff resolves at once, a timeout waits only for cancellation. */
export const scheduler: Scheduler = {
  now: () => 0,
  sleep: (ms, signal) =>
    ms < 3000
      ? Promise.resolve()
      : new Promise<void>((_resolve, reject) => {
          if (signal?.aborted === true) reject(signal.reason);
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
};

/** The governed adapter and its two governors; every token granted unless `take` says no. */
export function govern(
  adapter: UnionAdapter,
  take: QuotaLimiter['tryAcquire'] = () => true,
): ReturnType<typeof governAdapter> {
  return governAdapter(adapter, {
    endpoint,
    scheduler,
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: take },
  });
}

/** What a call ended with: its value or what it threw. */
export async function outcome(run: () => unknown): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return error;
  }
}

/** A rejection with the union `code` (platform taobao); resolving fails as an assertion. */
export async function unionFailure(run: () => unknown, code: UnionErrorCode): Promise<UnionError> {
  const caught = await outcome(run);
  expect(caught).toBeInstanceOf(UnionError);
  expect(caught).toMatchObject({ code, platform: 'taobao' });
  return caught as UnionError;
}

export function visible(value: unknown): string {
  return `${String(value)}\n${JSON.stringify(value)}\n${inspect(value, { depth: null })}`;
}

export function expectRedacted(value: unknown, markers: readonly string[]): void {
  const text = visible(value);
  for (const marker of markers) expect(text).not.toContain(marker);
}
