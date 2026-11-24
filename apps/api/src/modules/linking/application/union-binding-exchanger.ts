// B1-06h: the credential exchange of POST /v1/unions/{platform}/bindings (BR-ID-17 细则「授权方式」
// ④): with the application configuration the state recorded for the method (appRef), exchange or
// use the submitted credential (web_code: the authorization code; sdk_token: the access token the
// Taobao SDK returned) and file the channel, giving the relation_id. The credential lives only in
// this call: it is never stored, logged or echoed.
//
// The Nest class token is injectable (linking.module.ts provides the default below; rule tests
// replace it). The default forwards to the governed Taobao adapter's bindPublisher (authorizationCode =
// the code or the access token): the demo adapter outside staging / prod synthesizes a relation id;
// the live TaobaoUnionAdapter (B1-04zzzzm) exchanges the web_code for the user's token and files the
// channel (publisher.info.save, duplicate → publisher.info.get). A refused code comes back as
// invalid_identity → credential_invalid.
// TODO(规划/11 §4.5): the live adapter's sdk_token path (an SDK access token used as the session
// directly) — blocked on 淘宝客户端 SDK 接入（本单不动 sdk_token 路径）.
// B1-04zzzzm 补丁 2 (D10-2755): the bindings use case also passes the server-selected union account
// (the adapter files only when its inviter code belongs to it, BR-ATTR-05) and the request then
// keeps the credential's kind (credentialType: an SDK token is never sent as an authorization code).
// With `resolveApp` (the staging / prod wiring) the state's recorded reference is resolved to the
// OAuth application it was issued with, which the adapter uses instead of its current setting; a
// reference that does not resolve, or a method the live path cannot complete (sdk_token), is
// refused here before anything is exchanged (UnionBindingExchangeRefusal).
// r4b (D10-2779): the exchange port's input stays the five fields the B1-06h rule tests pin. The
// account is the bindings use case's own choice (reads.authAccountId, the account the binding is
// written under), scoped around the call with withBindingUnionAccount and read here; without it
// (a caller outside the bindings use case) the request names no account, and the live adapter,
// whose credentials always carry TAOBAO_INVITER_ACCOUNT_ID, refuses the filing unsent.
// 补丁 3 (D10-2826): ② with `ready` (the staging / prod wiring: the readiness auth-url issues
// under, infra/auth-apps.ts taobaoLiveFilingReady) a filing adapter that is not the real one (a
// demo endpoint) never receives a credential: refused before anything is exchanged; ① an id the
// adapter only read back after a duplicate filing comes back marked (fromDuplicateLookup) so the
// bindings use case checks it against its own history before writing anything.
import { AsyncLocalStorage } from 'node:async_hooks';
import { UnionError, type BindReq, type BindResult, type CallCtx } from '../../union/index.ts';

export interface UnionBindingExchangeInput {
  readonly appId: string;
  readonly method: 'web_code' | 'sdk_token';
  readonly credential:
    { readonly code: string } | { readonly access_token: string; readonly expires_in: number };
  readonly appRef: string;
  readonly traceId: string;
}

/** r4b: the union account the binding is written under, scoped by the bindings use case. */
const bindingUnionAccount = new AsyncLocalStorage<string>();

/** Runs `run` (the exchange) with the account the binding will be written under. */
export function withBindingUnionAccount<T>(accountId: string, run: () => Promise<T>): Promise<T> {
  return bindingUnionAccount.run(accountId, run);
}

/** The OAuth application a state's reference names (app key + redirect URI, no secret). */
export interface UnionBindingOAuthApp {
  readonly appKey: string;
  readonly redirectUri: string;
}

/** Resolves a state's recorded reference for its method; null when it does not resolve. */
export type UnionBindingAppResolver = (
  appRef: string,
  method: UnionBindingExchangeInput['method'],
) => UnionBindingOAuthApp | null;

/** A refusal before anything is exchanged; `reason` is a fixed classification only. */
export class UnionBindingExchangeRefusal extends Error {
  readonly reason: 'oauth_app_unresolved' | 'method_unsupported' | 'filing_unavailable';

  constructor(reason: UnionBindingExchangeRefusal['reason']) {
    super(`linking: credential exchange refused (${reason})`);
    this.name = 'UnionBindingExchangeRefusal';
    this.reason = reason;
  }
}

export type UnionBindingExchangeResult =
  | {
      readonly kind: 'bound';
      readonly relationId: string;
      /** 补丁 3 ①: read back after a duplicate filing; accepted only against binding history. */
      readonly fromDuplicateLookup?: true;
    }
  | { readonly kind: 'credential_invalid' };

/** The union adapter's channel filing (governed or demo), as linking calls it. */
export type UnionBindPublisher = (req: BindReq, ctx: CallCtx) => Promise<BindResult>;

/** Union answers that mean the credential itself was refused (never a dependency failure). */
const CREDENTIAL_REFUSALS: ReadonlySet<string> = new Set(['invalid_identity', 'upstream_rejected']);

/** Injectable boundary for the demo credential exchange; no upstream call in rule tests. */
export class UnionBindingExchanger {
  readonly #bind: (() => UnionBindPublisher | null) | undefined;
  readonly #resolveApp: UnionBindingAppResolver | undefined;
  readonly #ready: (() => boolean) | undefined;

  /**
   * `bind` resolves the Taobao adapter's bindPublisher at call time; absent or resolving to null
   * (no union adapter in this process, or an adapter without channel filing) every exchange
   * rejects, which the bindings use case answers as a server fault. `options.resolveApp` (staging /
   * prod) resolves the state's reference; without it the adapter's current setting is used.
   * `options.ready` (staging / prod, 补丁 3 ②) is the shared readiness of the real filing adapter;
   * false → refused (filing_unavailable) before the adapter is resolved or anything is sent.
   */
  constructor(
    bind?: () => UnionBindPublisher | null,
    options?: {
      readonly resolveApp?: UnionBindingAppResolver;
      readonly ready?: () => boolean;
    },
  ) {
    this.#bind = bind;
    this.#resolveApp = options?.resolveApp;
    this.#ready = options?.ready;
  }

  async exchange(input: UnionBindingExchangeInput): Promise<UnionBindingExchangeResult> {
    const unionAccountId = bindingUnionAccount.getStore();
    if (this.#ready !== undefined && !this.#ready()) {
      throw new UnionBindingExchangeRefusal('filing_unavailable');
    }
    const bind = this.#bind?.() ?? null;
    if (bind === null) {
      throw new Error('linking: no union channel filing for the credential exchange');
    }
    let oauthApp: UnionBindingOAuthApp | undefined;
    if (this.#resolveApp !== undefined) {
      // The live path completes web_code only (an SDK token is never exchanged as a code).
      if (input.method !== 'web_code') throw new UnionBindingExchangeRefusal('method_unsupported');
      const resolved = this.#resolveApp(input.appRef, input.method);
      if (resolved === null) throw new UnionBindingExchangeRefusal('oauth_app_unresolved');
      oauthApp = { appKey: resolved.appKey, redirectUri: resolved.redirectUri };
    }
    const authorizationCode =
      'code' in input.credential ? input.credential.code : input.credential.access_token;
    // Legacy callers (no account, no resolved app) send the credential alone, as before.
    const req: BindReq =
      unionAccountId === undefined && oauthApp === undefined
        ? { authorizationCode }
        : {
            authorizationCode,
            credentialType: input.method === 'web_code' ? 'authorization_code' : 'sdk_token',
            ...(unionAccountId === undefined ? {} : { unionAccountId }),
            ...(oauthApp === undefined ? {} : { oauthApp }),
          };
    try {
      const result = await bind(req, {
        appId: input.appId,
        requestId: input.traceId,
        purpose: 'online',
      });
      if (typeof result?.relationId !== 'string' || result.relationId === '') {
        throw new Error('linking: the channel filing returned no relation id');
      }
      return result.fromDuplicateLookup === true
        ? { kind: 'bound', relationId: result.relationId, fromDuplicateLookup: true }
        : { kind: 'bound', relationId: result.relationId };
    } catch (error) {
      if (error instanceof UnionError && CREDENTIAL_REFUSALS.has(error.code)) {
        return { kind: 'credential_invalid' };
      }
      throw error;
    }
  }
}
