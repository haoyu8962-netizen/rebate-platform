// B3-08zi (规划/08 BR-ID-01 ⑦; rule tests test/spec/identity/agent-privacy-min-version/**): the
// privacy minimum-version check of /v1/agent/, built by identity (AGENT_PRIVACY_CONSENT_CHECKS'
// guard) and provided by app.module under agentPrivacyCheckToken() on the stream entry. Agent owns
// no consent tables and imports nothing of identity: this is the shape it calls.
//
// The controller (./controller.ts) calls it in #handle after resolving the caller and before the
// runtime, so it runs after the global guards (④a → ⑤ → ⑥ → ⑬) and before BR-AI-23 ①. It
// resolves when the request is let through and rejects with the refusal (the 10004 envelope in an
// HttpException, or 50001), which the global error filter writes back. Without a provider (a bare
// AgentModule.forStream outside app.module) the controller does not judge ⑦.
import type { AgentStreamRequest } from './caller.ts';

/** The request fields the check reads, besides the verified token principal it finds on it. */
export interface AgentPrivacyRequest {
  readonly id: string;
  readonly method: string;
  readonly headers: AgentStreamRequest['headers'];
  readonly routeOptions: { readonly url?: string };
  readonly body?: unknown;
}

export interface AgentPrivacyCheck {
  canActivate(context: { switchToHttp(): { getRequest(): AgentPrivacyRequest } }): Promise<boolean>;
}

const PRIVACY_CHECK = Symbol('AGENT_PRIVACY_CHECK');

/** The DI token of the AgentPrivacyCheck; the same symbol on every call. */
export function agentPrivacyCheckToken(): symbol {
  return PRIVACY_CHECK;
}
