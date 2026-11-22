// Stage ⑦ (10004 consent_type=privacy, privacy consent below legal.privacy.min_version) for the
// /v1/agent/ routes of the stream entry (规划/08 BR-ID-01 判定顺序 ⑦ and 「/v1/agent/* 在 ⑦ 之后改按
// BR-AI-23」; task B3-08zi). Rule tests: test/spec/identity/agent-privacy-min-version/**.
//
// Every /v1/agent/ route is x-auth optional, so the api entry's contract-driven ⑦
// (./privacy-consent.ts) never judges them; this one does, for a caller with a verified token only.
// A guest (no token) is not judged and nothing is read: a guest's privacy state is device-level
// (BR-ID-13), and the user-level minimum does not apply. Routes outside /v1/agent/ are let through
// unread.
//
// The judgement is ./privacy-consent.ts's createPrivacyConsentJudge (one copy): the configured
// minimum through config.pooled, the newest user-level privacy row (app_id, user_id, server_at
// DESC, id DESC), the same 10004 envelope and the same 50001 cases. No reader assembled (config
// null) is the key missing: not judged.
//
// Where: agent's stream controller calls the guard after it resolved the caller and before the
// runtime (after the global guards ④a → ⑤ → ⑥ → ⑬, before BR-AI-23 ①); app.module hands it over
// through identity's AGENT_PRIVACY_CONSENT_CHECKS. postMiss never judges: no /v1/agent/ route is
// x-idempotent, so no idempotency claim precedes it.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no decorators.
import { tokenPrincipal } from '../../platform/index.ts';
import {
  createPrivacyConsentJudge,
  type PrivacyConsentChecks,
  type PrivacyConsentOptions,
} from './privacy-consent.ts';

/** Nest token of the assembled agent ⑦ checks (identity.module provides, app.module hands agent). */
export const AGENT_PRIVACY_CONSENT_CHECKS = Symbol('AGENT_PRIVACY_CONSENT_CHECKS');

const AGENT_PREFIX = '/v1/agent/';

export function createAgentPrivacyConsentChecks(
  options: PrivacyConsentOptions,
): PrivacyConsentChecks {
  const { db, config, logger } = options;
  const judge = createPrivacyConsentJudge({ logger });

  return {
    guard: {
      async canActivate(context) {
        const request = context.switchToHttp().getRequest();
        const template = request.routeOptions.url;
        if (typeof template !== 'string' || !template.startsWith(AGENT_PREFIX)) return true;
        // A guest: not judged, nothing read (BR-ID-13).
        if (tokenPrincipal(request) === undefined) return true;
        // No reader assembled: as if legal.privacy.min_version were missing (not judged).
        if (config === null) return true;
        await judge(request, db, () => config.pooled);
        return true;
      },
    },
    async postMiss() {
      // No /v1/agent/ route is x-idempotent: ⑦ for them is the guard above, called by agent.
    },
  };
}
