// Test support for F1-01qa (D10-1745): H5 sends x-auth optional operations with the h5_token when
// native gives one and anonymously otherwise. Real SDK and real createAppApi; only the native
// bridge boundary and fetch are faked (no network, no listening socket).
import { expect, vi } from 'vitest';
import * as sdk from '@couli/bridge-sdk';
import type { BridgeRequest, BridgeResponse, H5Token } from '@couli/bridge-sdk';
import {
  createAppApi,
  type AppApiBridge,
  type AppApiClient,
} from '../../../../apps/h5/src/shared/api/app-api.ts';
import type { H5ApiClient } from '../../../../apps/h5/src/shared/api/index.ts';
import { installBridge, outcome } from '../bridge-sdk/kit.ts';
import { ENV, NATIVE_ENV, requiredText } from '../h5-app-api/kit.ts';

export { outcome };

/**
 * getH5Token failures of D10-1745 ① ("90401 或任何失败"): 90401, a timeout (90003), a malformed
 * result, and native answering 90001 (method not supported). The other "not supported" shape,
 * native not declaring auth.getH5Token at all, is built with optionalBridge's methods argument.
 */
export const TOKEN_FAILURES = ['not-logged-in', 'timeout', 'malformed', 'unsupported'] as const;

/** What native answers to one auth.getH5Token call. */
export type TokenAnswer = H5Token['scope'] | (typeof TOKEN_FAILURES)[number];

/** The only bridge methods H5 may call while it sends optional requests (no prompt, no login). */
export const QUIET_METHODS: readonly string[] = ['app.getEnv', 'auth.getH5Token'];

/** Contract bridge methods a wrong implementation could use to prompt or start a login. */
export const PROMPT_METHODS: readonly string[] = ['ui.toast', 'ui.showLoading', 'auth.login'];

export interface IssuedToken {
  account: string;
  scope: H5Token['scope'];
  token: string;
}

const releases: (() => void)[] = [];

/** A pending boundary that is always released after the test, even after an early red. */
export function deferred<T>(fallback: T) {
  const pending = Promise.withResolvers<T>();
  releases.push(() => pending.resolve(fallback));
  return pending;
}

export function releaseAll(): void {
  for (const release of releases.splice(0)) release();
}

function answer(request: BridgeRequest, account: string, call: number, value: TokenAnswer) {
  const issued: IssuedToken | null =
    value === 'standard' || value === 'read_only'
      ? { account, scope: value, token: `fx-opt-${account}-${value}-${call}` }
      : null;
  let response: BridgeResponse;
  if (issued !== null) {
    response = {
      id: request.id,
      code: 0,
      msg: '',
      data: { token: issued.token, scope: issued.scope, expire_at: '2099-01-01T00:00:00Z' },
    };
  } else if (value === 'not-logged-in') {
    response = { id: request.id, code: 90401, msg: 'not logged in' };
  } else if (value === 'timeout') {
    response = { id: request.id, code: 90003, msg: 'timed out' };
  } else if (value === 'unsupported') {
    response = { id: request.id, code: 90001, msg: 'not supported' };
  } else {
    // Code 0 with a result outside contracts/bridge.schema.json (empty token, no expire_at).
    response = { id: request.id, code: 0, msg: '', data: { token: '', scope: 'standard' } };
  }
  return { issued, response };
}

/**
 * Fake native side: app.getEnv answers NATIVE_ENV, auth.getH5Token answers plan(n) for its n-th
 * call (1-based). The account is captured when a token call starts, so a token acquired before a
 * switch still names the old account. Every successful token is recorded in issued().
 */
export function optionalBridge(
  plan: (call: number) => TokenAnswer | Promise<TokenAnswer> = () => 'standard',
  methods: readonly string[] = ['app.getEnv', 'auth.getH5Token'],
) {
  let account = 'A';
  let tokenCalls = 0;
  const issued: IssuedToken[] = [];
  const native = installBridge(methods, async (request): Promise<BridgeResponse> => {
    if (request.method === 'app.getEnv') {
      return { id: request.id, code: 0, msg: '', data: NATIVE_ENV };
    }
    if (request.method !== 'auth.getH5Token') {
      return { id: request.id, code: 90500, msg: `unexpected bridge method ${request.method}` };
    }
    tokenCalls += 1;
    const call = tokenCalls;
    const owner = account;
    const result = answer(request, owner, call, await plan(call));
    if (result.issued !== null) issued.push(result.issued);
    return result.response;
  });
  const bridge: AppApiBridge = {
    isInApp: sdk.isInApp,
    has: sdk.has,
    call: sdk.call,
    // A fresh manager per session, as the default SDK factory gives.
    createH5TokenManager: () => sdk.createH5TokenManager(),
  };
  return {
    ...native,
    bridge,
    tokenCalls: () => tokenCalls,
    issued: () => [...issued],
    /** `Bearer <token>` of every token native issued (optionally only for one account). */
    bearers: (of?: string) =>
      issued.filter((item) => of === undefined || item.account === of).map(bearer),
    switchTo(next: string) {
      account = next;
    },
    /** Every bridge method H5 called, in order. */
    bridgeMethods: () => native.postMessage.mock.calls.map(([request]) => request.method),
  };
}

export function bearer(item: IssuedToken): string {
  return `Bearer ${item.token}`;
}

export function reply(data: unknown, code = 0, status = 200): Response {
  return new Response(JSON.stringify({ code, msg: '', data, trace_id: 'fx-opt-trace' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function expired(): Response {
  return reply(null, 10002, 401);
}

/** In-memory HTTP boundary; handler gets each request and its 0-based index. */
export function httpServer(
  handler: (request: Request, index: number) => Response | Promise<Response> = () => reply({}),
) {
  const requests: Request[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request.clone());
    return handler(request, requests.length - 1);
  });
  return {
    fetch,
    requests,
    authorizations: () => requests.map((request) => request.headers.get('Authorization')),
  };
}

export function appApi(
  native: ReturnType<typeof optionalBridge>,
  http: ReturnType<typeof httpServer>,
): AppApiClient {
  const api = createAppApi({ env: ENV, bridge: native.bridge, fetch: http.fetch });
  expect(api, 'createAppApi is available with bridge, app.getEnv and build env').not.toBeNull();
  return api!;
}

/** One contract operation as H5 would call it (path template plus openapi-fetch options). */
export interface Operation {
  method: string;
  path: string;
  options: object;
}

/** Contract operations are heterogeneous; bypass the generated types only at this boundary. */
export type LooseRequest = (method: string, path: string, options: object) => Promise<unknown>;

export function send(api: H5ApiClient, operation: Operation): Promise<unknown> {
  const request = api.request as unknown as LooseRequest;
  return outcome(() => request.call(api, operation.method, operation.path, operation.options));
}

export type Settled =
  { status: 'fulfilled'; value: unknown } | { status: 'rejected'; reason: unknown };

/** Attaches the handlers at once, so a rejection is never left unhandled. */
export function settle(promise: Promise<unknown>): Promise<Settled> {
  return promise.then(
    (value): Settled => ({ status: 'fulfilled', value }),
    (reason: unknown): Settled => ({ status: 'rejected', reason }),
  );
}

/** Let late transport work run (a replay or resend would show up on the wire by then). */
export async function drain(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

export const PRODUCT: Operation = {
  method: 'GET',
  path: '/v1/products/{product_key}',
  options: { params: { path: { product_key: 'fx-product' } } },
};

export const EVENTS: Operation = {
  method: 'POST',
  path: '/v1/events',
  options: { body: { events: [] } },
};

export const LINK: Operation = {
  method: 'GET',
  path: '/v1/links/{link_id}',
  options: { params: { path: { link_id: 'fx-link' } } },
};

/** The optional operations H5 sends itself (D10-1745: reads plus POST /v1/events). */
export const OPTIONAL_OPERATIONS: readonly Operation[] = [
  {
    method: 'GET',
    path: '/v1/pages/{page_key}',
    options: { params: { path: { page_key: 'home' } } },
  },
  {
    method: 'GET',
    path: '/v1/pages/{page_key}/sections/{section_id}/items',
    options: { params: { path: { page_key: 'home', section_id: 'fx-section' } } },
  },
  {
    method: 'GET',
    path: '/v1/products/search',
    options: { params: { query: { q: 'fx-keyword' } } },
  },
  PRODUCT,
  { method: 'GET', path: '/v1/rank/hot', options: {} },
  LINK,
  EVENTS,
];

/** Contract security [] operations (x-auth none) that H5 reads. */
export const NONE_OPERATIONS: readonly Operation[] = [
  { method: 'GET', path: '/v1/articles', options: { params: { query: { category: 'help' } } } },
  {
    method: 'GET',
    path: '/v1/products/{product_key}/price-trend',
    options: { params: { path: { product_key: 'fx-product' } } },
  },
  { method: 'GET', path: '/v1/search/hot-words', options: {} },
];

export const SIGNED_OPERATIONS: readonly Operation[] = [
  { method: 'POST', path: '/v1/inputs/parse', options: { body: { input: 'fx-input' } } },
  {
    method: 'POST',
    path: '/v1/links/{link_id}/open',
    options: { params: { path: { link_id: 'fx-link' } }, body: {} },
  },
];

export interface ContractAuth {
  auth: string;
  signed: boolean;
}

/**
 * Independent oracle from contracts/openapi.yaml indentation: `security: []` is none, otherwise
 * the operation's `x-auth` (required when absent); `x-signed: true` marks a signed operation.
 */
export function contractAuth(): Map<string, ContractAuth> {
  const operations = new Map<string, ContractAuth>();
  let path = '';
  let current: ContractAuth | undefined;
  for (const line of requiredText('contracts/openapi.yaml').split('\n')) {
    if (/^\S/.test(line)) {
      path = '';
      current = undefined;
      continue;
    }
    const pathMatch = /^ {2}(\/[^:]+):$/.exec(line);
    if (pathMatch) {
      path = pathMatch[1]!;
      current = undefined;
      continue;
    }
    const methodMatch = /^ {4}(get|post|put|patch|delete|head|options):$/.exec(line);
    if (methodMatch && path !== '') {
      current = { auth: 'required', signed: false };
      operations.set(`${methodMatch[1]!.toUpperCase()} ${path}`, current);
      continue;
    }
    if (current === undefined) continue;
    const auth = /^ {6}x-auth: (\S+)$/.exec(line);
    if (auth && current.auth !== 'none') current.auth = auth[1]!;
    if (/^ {6}security: \[\]$/.test(line)) current.auth = 'none';
    if (/^ {6}x-signed: true$/.test(line)) current.signed = true;
  }
  return operations;
}

export function key(operation: Operation): string {
  return `${operation.method} ${operation.path}`;
}

/** Guards the fixture lists against the contract (passes on any implementation). */
export function expectContract(operations: readonly Operation[], expected: ContractAuth): void {
  const contract = contractAuth();
  for (const operation of operations) {
    expect(contract.get(key(operation)), key(operation)).toEqual(expected);
  }
}
