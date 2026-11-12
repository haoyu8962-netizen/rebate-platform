// CT-26zm (BR-AI-13; 变更记录 20261112 §3.4 C4 第一项; 编排 D10-1330): the effective AgentConsent
// version of an app, from config key `legal.ai_third_party.version`. The one place that decides
// it: the agent consent gate (agent/stream/access createConsentVersionSource, through this
// module's index) and GET /v1/config (domain/client-config.ts, legal.ai_third_party.version) both
// call effectiveAiConsentVersion and never re-check the value themselves.
//
// effectiveAiConsentVersion(entry):
//   entry null or undefined (no config_items row) → { version: 1, source: 'missing' };
//   entry.value a JSON number that is an integer in [1, 2147483647]
//     → { version: entry.value, source: 'configured' };
//   any other entry.value (0, negatives, fractions, above 2147483647 even when a safe integer,
//   strings, null, booleans, objects, arrays) → { version: 1, source: 'invalid' }.
// Pure: never logs, never mutates the entry. Logging is the caller's: the gate warns
// `agent.consent_version_config_invalid` for missing and invalid; /v1/config reports only invalid
// (report.invalid → warn content_config_value_invalid with config_key) and delivers `version`
// always.
//
// Also compiled by the `test` project: erasable syntax only.

/** The config_items key of the AgentConsent version. */
export type AiConsentVersionKey = 'legal.ai_third_party.version';

/** A config_items row as read (ContentReader.configValue's answer fits). */
export interface AiConsentVersionEntry {
  readonly value: unknown;
}

/** The effective version and where it came from (the callers log by `source`). */
export interface AiConsentVersion {
  /** int32 >= 1: the configured value, or 1 when missing or invalid. */
  readonly version: number;
  readonly source: 'configured' | 'missing' | 'invalid';
}

/** int32 upper bound of the contract's ConfigLegal.ai_third_party.version. */
const INT32_MAX = 2_147_483_647;
/** The effective version when the key is missing or invalid. */
const DEFAULT_VERSION = 1;

export function effectiveAiConsentVersion(
  entry: AiConsentVersionEntry | null | undefined,
): AiConsentVersion {
  if (entry === null || entry === undefined) return { version: DEFAULT_VERSION, source: 'missing' };
  const value = entry.value;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= INT32_MAX) {
    return { version: value, source: 'configured' };
  }
  return { version: DEFAULT_VERSION, source: 'invalid' };
}
