import type { H5ApiResponse, H5TokenManager } from '@couli/bridge-sdk';
import { errorCodes, type paths } from '@couli/contracts-ts';
import createClient, { type FetchOptions } from 'openapi-fetch';

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export type ApiPath<M extends ApiMethod> = {
  [P in keyof paths]: paths[P] extends Record<Lowercase<M>, object> ? P : never;
}[keyof paths];
type Operation<M extends ApiMethod, P extends ApiPath<M>> =
  paths[P] extends Record<Lowercase<M>, infer O> ? O : never;
type OptionsWithoutHeaders<O> = O extends { parameters: infer Params }
  ? Omit<O, 'parameters'> & { parameters: Omit<Params, 'header'> }
  : O;
export type ApiRequestOptions<M extends ApiMethod, P extends ApiPath<M>> = FetchOptions<
  OptionsWithoutHeaders<Operation<M, P>>
>;
type SuccessData<Responses> = {
  [Status in keyof Responses]: `${Status & (string | number)}` extends `2${string}`
    ? Responses[Status] extends { content: { 'application/json': { data: infer D } } }
      ? D
      : never
    : never;
}[keyof Responses];
export type ApiData<M extends ApiMethod, P extends ApiPath<M>> =
  Operation<M, P> extends { responses: infer Responses } ? SuccessData<Responses> : never;

export interface ApiClientOptions {
  baseUrl: string;
  /** Supplied by the caller; no brand, platform, signing or device defaults in this layer. */
  headers: () => HeadersInit | Promise<HeadersInit>;
  tokenManager?: H5TokenManager;
  fetch?: typeof globalThis.fetch;
}

export interface H5ApiClient {
  request<M extends ApiMethod, P extends ApiPath<M>>(
    method: M,
    path: P,
    options: ApiRequestOptions<M, P>,
  ): Promise<ApiData<M, P>>;
}

/** Common fallback for codes this build does not know (contracts/error-codes.yaml 50001). */
const FALLBACK_CODE = 50001 satisfies keyof typeof errorCodes;

function actionFor(code: number): string {
  const known = Object.hasOwn(errorCodes, code)
    ? errorCodes[code as keyof typeof errorCodes]
    : errorCodes[FALLBACK_CODE];
  return known.action;
}

/** Contract action strings are metadata for the UI, not executable instructions. */
export class ApiError extends Error {
  declare readonly code: number;
  declare readonly msg: string;
  declare readonly data: unknown;
  declare readonly action: string;

  constructor(code: number, msg: string, data?: unknown) {
    super(`api error ${code}`);
    this.name = 'ApiError';
    this.code = code;
    this.msg = msg;
    this.data = data;
    // Unknown codes keep their own code and msg and take the common fallback action.
    this.action = actionFor(code);
  }
}

/** The response body was not a {code, msg, data} envelope (gateway page, empty body, ...). */
export class ApiProtocolError extends Error {
  declare readonly status: number;

  constructor(status: number) {
    super(`api response without envelope (HTTP ${status})`);
    this.name = 'ApiProtocolError';
    this.status = status;
  }
}

type RawRequest = (
  method: string,
  url: string,
  init: Record<string, unknown>,
) => Promise<{ data?: unknown; error?: unknown; response: Response }>;

function toEnvelope(body: unknown, status: number): H5ApiResponse<unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiProtocolError(status);
  }
  const { code, msg, data } = body as { code?: unknown; msg?: unknown; data?: unknown };
  if (typeof code !== 'number' || !Number.isInteger(code)) throw new ApiProtocolError(status);
  return { code, msg: typeof msg === 'string' ? msg : '', data };
}

/** openapi-fetch transport, with token-manager replay before business-envelope unwrapping. */
export function createApiClient(options: ApiClientOptions): H5ApiClient {
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const raw = client.request as unknown as RawRequest;
  const { tokenManager } = options;

  async function request(
    method: ApiMethod,
    path: string,
    init: Record<string, unknown>,
  ): Promise<unknown> {
    // Common headers come from the caller for every request (X-App-Id, X-Platform, ...);
    // per-request headers such as Idempotency-Key are kept identical across the replay.
    const base = new Headers(await options.headers());
    new Headers(init['headers'] as HeadersInit | undefined).forEach((value, name) => {
      base.set(name, value);
    });

    async function send(token?: string): Promise<H5ApiResponse<unknown>> {
      const headers = new Headers(base);
      if (token !== undefined) headers.set('Authorization', `Bearer ${token}`);
      // openapi-fetch builds a fresh Request each time, so a replay re-serializes the same body.
      const { data, error, response } = await raw(method.toLowerCase(), path, {
        ...init,
        headers,
      });
      // The business code decides, whatever the HTTP status (401 / 403 / 5xx carry envelopes).
      return toEnvelope(response.ok ? data : error, response.status);
    }

    const envelope =
      tokenManager === undefined ? await send() : await tokenManager.request(method, send);
    if (envelope.code === 0) return envelope.data;
    throw new ApiError(envelope.code, envelope.msg, envelope.data);
  }

  return {
    request: (method, path, init) =>
      request(method, path, init as Record<string, unknown>) as Promise<never>,
  };
}
