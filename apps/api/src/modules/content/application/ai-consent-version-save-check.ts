// B1-22zb (D10-1329 (a), 规划/08 BR-AI-13 细则「当前版本的取值」② ③): the save-time check of
// legal.ai_third_party.version. The version only goes up: a write (single update, batch or
// rollback) whose new value is below the current one is refused (20001 fields=[that key], the
// ordinary config save refusal, no new error code). The current value is the stored row; a missing
// row or a stored value outside 1..2147483647 (not an integer included) counts as 1 (②: invalid =
// unset = the first version). A written value that is not an integer in 1..2147483647 is refused by
// this check itself (D10-1349 ③), whatever the current value, besides the registry's range check.
// ContentAdminModule combines it with content's other save checks; ConfigItemAdmin takes the
// per-app transaction lock of this key's saves before the current value is read, so concurrent
// saves (a first write included) compare against each other's commit.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { ConfigItemSaveCheck } from './config-item-admin.ts';

/** The one key this check reads and refuses. */
export type AiConsentVersionKey = 'legal.ai_third_party.version';

export const AI_CONSENT_VERSION_KEY: AiConsentVersionKey = 'legal.ai_third_party.version';

/** ② the version is an integer in 1..2147483647 (consent_records.version, int32). */
const MAX_VERSION = 2_147_483_647;
/** ② unset or invalid: the effective version is the first one. */
const FIRST_VERSION = 1;

function isVersion(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_VERSION
  );
}

/** ② the current version: the stored value when valid, else 1 (missing row included). */
export function currentAiConsentVersion(stored: ReadonlyMap<string, unknown>): number {
  const value = stored.get(AI_CONSENT_VERSION_KEY);
  return isVersion(value) ? value : FIRST_VERSION;
}

/** The save check of legal.ai_third_party.version (keys = [that key]). */
export function aiConsentVersionSaveCheck(): ConfigItemSaveCheck {
  return {
    keys: Object.freeze([AI_CONSENT_VERSION_KEY]),
    refusals(stored, written) {
      if (!written.has(AI_CONSENT_VERSION_KEY)) return [];
      const value = written.get(AI_CONSENT_VERSION_KEY);
      // ③ (D10-1349): an invalid written value is refused here too, not only by the registry.
      if (!isVersion(value)) return [AI_CONSENT_VERSION_KEY];
      return value < currentAiConsentVersion(stored) ? [AI_CONSENT_VERSION_KEY] : [];
    },
  };
}
