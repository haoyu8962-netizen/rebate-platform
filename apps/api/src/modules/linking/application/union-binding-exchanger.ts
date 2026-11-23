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
import { UnionError, type BindReq, type BindResult, type CallCtx } from '../../union/index.ts';

export interface UnionBindingExchangeInput {
  readonly appId: string;
  readonly method: 'web_code' | 'sdk_token';
  readonly credential:
    { readonly code: string } | { readonly access_token: string; readonly expires_in: number };
  readonly appRef: string;
  readonly traceId: string;
}

export type UnionBindingExchangeResult =
  { readonly kind: 'bound'; readonly relationId: string } | { readonly kind: 'credential_invalid' };

/** The union adapter's channel filing (governed or demo), as linking calls it. */
export type UnionBindPublisher = (req: BindReq, ctx: CallCtx) => Promise<BindResult>;

/** Union answers that mean the credential itself was refused (never a dependency failure). */
const CREDENTIAL_REFUSALS: ReadonlySet<string> = new Set(['invalid_identity', 'upstream_rejected']);

/** Injectable boundary for the demo credential exchange; no upstream call in rule tests. */
export class UnionBindingExchanger {
  readonly #bind: (() => UnionBindPublisher | null) | undefined;

  /**
   * `bind` resolves the Taobao adapter's bindPublisher at call time; absent or resolving to null
   * (no union adapter in this process, or an adapter without channel filing) every exchange
   * rejects, which the bindings use case answers as a server fault.
   */
  constructor(bind?: () => UnionBindPublisher | null) {
    this.#bind = bind;
  }

  async exchange(input: UnionBindingExchangeInput): Promise<UnionBindingExchangeResult> {
    const bind = this.#bind?.() ?? null;
    if (bind === null) {
      throw new Error('linking: no union channel filing for the credential exchange');
    }
    const authorizationCode =
      'code' in input.credential ? input.credential.code : input.credential.access_token;
    try {
      const result = await bind(
        { authorizationCode },
        { appId: input.appId, requestId: input.traceId, purpose: 'online' },
      );
      if (typeof result?.relationId !== 'string' || result.relationId === '') {
        throw new Error('linking: the channel filing returned no relation id');
      }
      return { kind: 'bound', relationId: result.relationId };
    } catch (error) {
      if (error instanceof UnionError && CREDENTIAL_REFUSALS.has(error.code)) {
        return { kind: 'credential_invalid' };
      }
      throw error;
    }
  }
}
