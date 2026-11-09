import * as bridgeSdk from '@couli/bridge-sdk';
import type { BridgeMethods, H5ApiResponse, H5TokenManager } from '@couli/bridge-sdk';
import { createContext, createElement, useContext, type ReactElement, type ReactNode } from 'react';
import { readAppApiEnv, type AppApiEnv } from '../env.ts';
import { createApiClient, type H5ApiClient } from './index.ts';
import { isAnonymousOperation } from './anonymous.ts';
import { isSignedOperation, SignedOperationError } from './signed.ts';

/** Injectable SDK facade; the default is @couli/bridge-sdk, never the native global. */
export type AppApiBridge = Pick<
  typeof bridgeSdk,
  'isInApp' | 'has' | 'call' | 'createH5TokenManager'
>;

export interface AppApiOptions {
  bridge?: AppApiBridge;
  fetch?: typeof globalThis.fetch;
  env?: AppApiEnv;
}

const DEFAULT_BRIDGE: AppApiBridge = {
  isInApp: bridgeSdk.isInApp,
  has: bridgeSdk.has,
  call: bridgeSdk.call,
  createH5TokenManager: bridgeSdk.createH5TokenManager,
};

type NativeEnv = BridgeMethods['app.getEnv']['result'];

/** The shell's App API client: the H5 API client plus the account-switch hook the shell calls. */
export interface AppApiClient extends H5ApiClient {
  /**
   * Account switch or logout (bridge auth.changed, subscribed by the shell): retires the H5 token
   * session. Authenticated requests started before it fail with AccountChangedError without asking
   * native for another token or sending anything more; later requests use a new token manager and
   * ask native for a new token.
   */
  invalidateToken(): void;
}

/** An authenticated request started in an earlier account session (before auth.changed). */
export class AccountChangedError extends Error {
  constructor() {
    super('account changed while the request was pending');
    this.name = 'AccountChangedError';
  }
}

/** One account session: its own token manager and authenticated client, retired on switch. */
interface TokenSession {
  readonly manager: H5TokenManager;
  readonly client: H5ApiClient;
  retired: boolean;
}

/**
 * Gate in front of a session's token manager. A retired session never starts a token request,
 * never sends and never returns a response (so no 10002 renewal or replay follows). The manager
 * itself is not invalidated: that would make a waiter re-acquire through native.
 */
function guardedManager(session: () => TokenSession): H5TokenManager {
  const live = (): TokenSession => {
    const current = session();
    if (current.retired) throw new AccountChangedError();
    return current;
  };
  return {
    getToken: async (options) => {
      const token = await live().manager.getToken(options);
      live();
      return token;
    },
    invalidate: () => {
      session().manager.invalidate();
    },
    request: async <T>(
      method: string,
      send: (token: string) => Promise<H5ApiResponse<T>>,
    ): Promise<H5ApiResponse<T>> =>
      live().manager.request(method, async (token) => {
        live();
        const response = await send(token);
        live();
        return response;
      }),
  };
}

/** Contract trace id: 1–64 characters of [A-Za-z0-9_-], new for every request. */
function newTraceId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return uuid;
  const random = () => Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${random()}${random()}`.slice(0, 64);
}

function requiredText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Missing bridge, app.getEnv capability, base URL or brand yields null. */
export function createAppApi(options: AppApiOptions = {}): AppApiClient | null {
  const env = options.env ?? readAppApiEnv();
  const { apiBaseUrl, appId } = env;
  // No same-origin fallback and no guessed brand: without both the client stays off.
  if (!requiredText(apiBaseUrl) || !requiredText(appId)) return null;
  const bridge = options.bridge ?? DEFAULT_BRIDGE;
  if (!bridge.isInApp()) return null;
  // X-App-Version and X-Build come only from native; without app.getEnv nothing is invented.
  const getEnv = bridge.has('app.getEnv');
  if (getEnv === null) return null;

  // One app.getEnv per client; a failed call is not cached, so the next request asks again.
  let nativeEnv: Promise<NativeEnv> | null = null;
  const readNativeEnv = (): Promise<NativeEnv> => {
    if (nativeEnv === null) {
      const pending = bridge.call(getEnv, {}).then((result) => {
        if (!requiredText(result.app_version) || !requiredText(result.build)) {
          throw new Error('app.getEnv returned no app_version or build');
        }
        return result;
      });
      nativeEnv = pending;
      pending.catch(() => {
        if (nativeEnv === pending) nativeEnv = null;
      });
    }
    return nativeEnv;
  };

  const transport = {
    baseUrl: apiBaseUrl.trim(),
    // h5 sends no X-Channel (contract: absent for H5), no X-Device-Id and no signature headers.
    headers: async () => {
      const native = await readNativeEnv();
      return {
        'X-App-Id': appId.trim(),
        'X-Platform': 'h5',
        'X-App-Version': native.app_version,
        'X-Build': native.build,
        'X-Trace-Id': newTraceId(),
      };
    },
    // Resolved per request so the page's current fetch is used when none is injected.
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
  } satisfies Parameters<typeof createApiClient>[0];
  // h5_token lives only in the current session manager's memory (renewed once on 10002 and
  // replayed once). auth.changed retires the session and starts a new one with a new manager.
  const startSession = (previous?: H5TokenManager): TokenSession => {
    const manager = bridge.createH5TokenManager();
    // An injected factory might hand back the same manager; then at least drop its token.
    if (manager === previous) manager.invalidate();
    const created: TokenSession = {
      manager,
      client: createApiClient({ ...transport, tokenManager: guardedManager(() => created) }),
      retired: false,
    };
    return created;
  };
  let session = startSession();
  // Operations without required auth (security [] or optional): no token, no Authorization.
  const anonymous = createApiClient(transport);

  return {
    request(method, path, init) {
      // Signed operations need native signing (net.signedRequest); this client never sends them,
      // neither directly with the H5 token nor through native (left to a later task).
      if (isSignedOperation(method, path)) {
        return Promise.reject(new SignedOperationError(method, path));
      }
      // The session is bound when the request starts, before the async header read.
      const client = isAnonymousOperation(method, path) ? anonymous : session.client;
      return client.request(method, path, init);
    },
    invalidateToken() {
      session.retired = true;
      session = startSession(session.manager);
    },
  };
}

const ApiContext = createContext<H5ApiClient | null>(null);

export interface ApiProviderProps {
  api: H5ApiClient | null;
  children?: ReactNode;
}

export function ApiProvider(props: ApiProviderProps): ReactElement {
  return createElement(ApiContext.Provider, { value: props.api }, props.children);
}

/** Returns null outside a provider or when the App API is unavailable. */
export function useApi(): H5ApiClient | null {
  return useContext(ApiContext);
}
