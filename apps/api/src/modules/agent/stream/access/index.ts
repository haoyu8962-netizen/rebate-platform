// Agent access ports (B3-03i; plan B3-05-plan §1.3 G-1, G-2): the implementations of the ports ①
// access, ② identity and ③ consent of ../../http (AgentAccessPort, AgentIdentityPort,
// AgentConsentPort), the AgentConsent version source, and the per-run RunGuard factory given to
// the RunManager as RunManagerDeps.guardFor (../run/types.ts). B3-03f wires them. The rule tests
// in test/spec/agent/stream-access/** import this file by path: names, signatures and the
// semantics written here are the contract. Values are only in 规划/08 (BR-AI-11, BR-AI-12,
// BR-AI-13, BR-ID-03); configuration is read per caller.appId through ContentReader.configValue
// on every check (the reader caches). A reader that rejects makes the check reject: never allow
// by default, never fall back to an old answer (the HTTP layer answers 50001; the RunManager
// retries on its next poll).
//
// Switch values are JSON booleans (config_items, db/seeds convention).
//
// createAgentAccessPort({reader}).check(caller) — ① BR-AI-12, BR-ID-03 细则「开放判定」:
//   open = agent.enabled is true and (agent.whitelist_only is false or (caller.userId is not null
//   and caller.phoneBound and caller.userId ∈ agent.whitelist_user_ids)); otherwise {code: 30501}.
//   Fail-closed readings: agent.enabled opens only when it is boolean true; agent.whitelist_only is
//   off only when it is boolean false (missing or any other value: on — BR-AI-12, it must be on
//   before the filing); agent.whitelist_user_ids is a JSON array of user id strings (missing or
//   any other value: nobody is listed).
//
// createAgentIdentityPort({reader}).check(caller) — ② BR-AI-11, BR-ID-03 法务收紧开关:
//   agent.require_phone (default false; only boolean true is on): on → a guest (userId null)
//   10001, a logged-in caller without a bound phone 10005, a bound phone null. off → null for all
//   three, except that agent.guest_daily_quota = 0 (the number zero) makes a guest 10001 (not
//   30502; BR-ID-03). Any other guest_daily_quota value does not refuse here.
//
// createConsentVersionSource({reader, logger?})(appId) — plan G-2: the current AgentConsent version
//   of the app, from config key `legal.ai_third_party.version`. The value is decided by content's
//   effectiveAiConsentVersion (CT-26zm, D10-1330; the same function GET /v1/config uses): an
//   integer in [1, 2147483647] is returned as it is; a missing key or any other value gives 1 and
//   one logger.warn naming the key (per call; as createQuotaLimitsSource); a reader rejection
//   rejects (no default).
//
// createAgentConsentPort({consent, version}).check(caller) — ③ BR-AI-13: consent is identity's
//   AiConsentReader (B1-02r), created with this same `version` source as its currentVersion (the
//   wiring of B3-03f). Subject: {appId, userId, deviceId} of the caller (userId null for a guest;
//   no other field). Verdict allowed → null; missing, withdrawn or outdated → {code: 10004}. A
//   rejection of the reader or of the version source rejects.
//
// createRunGuardFactory({reader, consent, version})(run) → RunGuard — for RunManagerDeps.guardFor
//   (plan G-1). run.ownerKey `u:<user_id>` is the user subject {appId: run.appId, userId,
//   deviceId: ''} (identity reads user-level records only, the device id is not read);
//   `d:<device_id>` is the device subject {appId, userId: null, deviceId}; any other form (other
//   prefix, empty id) is refused: the factory throws or every check() rejects, and the consent
//   reader is never asked. check(): first the opening (agent.enabled and the whitelist of ①, read
//   for run.appId; a device subject is never on the list; the phone binding is not re-checked
//   during a run) → {code: 30501}; then the consent of ③ for the run's subject → {code: 10004};
//   both pass → null. Each guard checks only its own run's subject.
//
// Rules for the implementation: also compiled by the `test` project: erasable syntax only,
// `import type` for type-only imports, relative imports with `.ts`, no NestJS, no process.env.
import type { RootLogger } from '../../../platform/index.ts';
import { effectiveAiConsentVersion, type ContentReader } from '../../../content/index.ts';
import type { AgentAccessPort, AgentConsentPort, AgentIdentityPort } from '../../http/index.ts';
import type { RunGuard, RunGuardTarget } from '../run/index.ts';

/**
 * Structurally matches identity's AiConsentReader (B1-02r, identity/ports/ai-consent.ts). Declared
 * here because identity's index also exports its Nest module, which the `test` project cannot
 * compile; B3-03f passes createAiConsentReader(...) as it is.
 */
export interface AgentConsentReader {
  check(subject: {
    readonly appId: string;
    readonly userId: string | null;
    readonly deviceId: string;
  }): Promise<
    | { readonly allowed: true; readonly version: number }
    | { readonly allowed: false; readonly reason: 'missing' | 'withdrawn' | 'outdated' }
  >;
}

export interface AgentConfigDeps {
  readonly reader: Pick<ContentReader, 'configValue'>;
}

export interface ConsentVersionSourceDeps {
  readonly reader: Pick<ContentReader, 'configValue'>;
  readonly logger?: Pick<RootLogger, 'warn'>;
}

/** The current AgentConsent version of an app (plan G-2). */
export type ConsentVersionSource = (appId: string) => Promise<number>;

export interface AgentConsentPortDeps {
  /** identity's AiConsentReader (B1-02r), created with `version` as its currentVersion. */
  readonly consent: AgentConsentReader;
  readonly version: ConsentVersionSource;
}

export interface RunGuardFactoryDeps {
  readonly reader: Pick<ContentReader, 'configValue'>;
  readonly consent: AgentConsentReader;
  readonly version: ConsentVersionSource;
}

export function createAgentAccessPort(deps: AgentConfigDeps): AgentAccessPort {
  return {
    async check(caller) {
      return (await isOpen(deps.reader, caller.appId, caller.userId, caller.phoneBound))
        ? null
        : { code: 30501 };
    },
  };
}

export function createAgentIdentityPort(deps: AgentConfigDeps): AgentIdentityPort {
  return {
    async check(caller) {
      const requirePhone = await deps.reader.configValue(caller.appId, 'agent.require_phone');
      if (requirePhone?.value === true) {
        if (caller.userId === null) return { code: 10001 };
        return caller.phoneBound ? null : { code: 10005 };
      }
      if (caller.userId === null) {
        const quota = await deps.reader.configValue(caller.appId, 'agent.guest_daily_quota');
        if (quota?.value === 0) return { code: 10001 };
      }
      return null;
    },
  };
}

export function createConsentVersionSource(deps: ConsentVersionSourceDeps): ConsentVersionSource {
  return async (appId) => {
    const key = 'legal.ai_third_party.version';
    const answer = effectiveAiConsentVersion(await deps.reader.configValue(appId, key));
    if (answer.source !== 'configured') {
      deps.logger?.warn({ app_id: appId, config_key: key }, 'agent.consent_version_config_invalid');
    }
    return answer.version;
  };
}

export function createAgentConsentPort(deps: AgentConsentPortDeps): AgentConsentPort {
  return {
    async check({ appId, userId, deviceId }) {
      // The identity reader uses deps.version as currentVersion on each check (B3-03f wiring).
      const verdict = await deps.consent.check({ appId, userId, deviceId });
      return verdict.allowed ? null : { code: 10004 };
    },
  };
}

export function createRunGuardFactory(
  deps: RunGuardFactoryDeps,
): (run: RunGuardTarget) => RunGuard {
  return ({ appId, ownerKey }) => {
    const id = ownerKey.slice(2);
    if (id.length === 0 || (!ownerKey.startsWith('u:') && !ownerKey.startsWith('d:'))) {
      throw new Error('Invalid agent run owner key');
    }
    const userId = ownerKey.startsWith('u:') ? id : null;
    const deviceId = userId === null ? id : '';
    return {
      async check() {
        // Binding was checked at admission; a live run only rechecks opening and consent.
        if (!(await isOpen(deps.reader, appId, userId, true))) return { code: 30501 };
        const verdict = await deps.consent.check({ appId, userId, deviceId });
        return verdict.allowed ? null : { code: 10004 };
      },
    };
  };
}

async function isOpen(
  reader: AgentConfigDeps['reader'],
  appId: string,
  userId: string | null,
  phoneBound: boolean,
): Promise<boolean> {
  if ((await reader.configValue(appId, 'agent.enabled'))?.value !== true) return false;
  if ((await reader.configValue(appId, 'agent.whitelist_only'))?.value === false) return true;
  if (userId === null || !phoneBound) return false;
  const ids = (await reader.configValue(appId, 'agent.whitelist_user_ids'))?.value;
  return Array.isArray(ids) && ids.every((id) => typeof id === 'string') && ids.includes(userId);
}
