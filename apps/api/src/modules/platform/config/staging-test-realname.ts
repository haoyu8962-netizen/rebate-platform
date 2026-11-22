// Staging test identities of the two-element real-name check (B1-13n; owner's consent 2026-11-22,
// D10-2636 ②; precedent B1-02zza staging-test-phones.ts). Only APP_ENV=staging honours them; every
// other environment is hard off. The user_ids come from the node, never from the repository.
//
// readStagingTestRealnameConfig (pure, loadConfig's part; never echoes a value):
//   - STAGING_TEST_REALNAME_USER_IDS: comma-separated user_ids (app.users.id), 1 to 10 items, every
//     item a valid user_id (no empty item);
//   - unset or empty string: null, no problem, in every environment (staging then keeps no
//     verifier: 50301 as today);
//   - local / test / prod: set → a problem (refused at startup);
//   - staging: a list that breaks the rules above → a problem.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports.
import type { AppEnv } from './app-env.ts';

/** What loadConfig keeps of STAGING_TEST_REALNAME_USER_IDS (null: not configured). */
export interface StagingTestRealnameConfigResult {
  /** The listed user_ids (1 to 10), or null when unset / empty or refused. */
  readonly stagingTestRealnameUserIds: readonly string[] | null;
  /** Each problem starts with `STAGING_TEST_REALNAME_USER_IDS:` and never carries a value. */
  readonly problems: readonly string[];
}

export const STAGING_TEST_REALNAME_USER_IDS_ENV = 'STAGING_TEST_REALNAME_USER_IDS';
/** Most user_ids the list may hold (D10-2636 ②). */
export const STAGING_TEST_REALNAME_MAX = 10;
/**
 * A user_id as PostgreSQL prints app.users.id (canonical lowercase UUID). An uppercase spelling is
 * refused rather than folded, so the node holds exactly what the session carries.
 */
const USER_ID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The first rule `items` breaks, or null. The limit is checked before any de-duplication. */
function listProblem(items: readonly string[]): string | null {
  if (items.some((item) => item === '')) return 'must not contain an empty item';
  if (items.length > STAGING_TEST_REALNAME_MAX) {
    return `must list at most ${String(STAGING_TEST_REALNAME_MAX)} user_ids`;
  }
  if (items.some((item) => !USER_ID_FORMAT.test(item))) {
    return 'every item must be a user_id (lowercase canonical UUID)';
  }
  if (new Set(items).size !== items.length) return 'must not list a user_id twice';
  return null;
}

export function readStagingTestRealnameConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): StagingTestRealnameConfigResult {
  const value = env[STAGING_TEST_REALNAME_USER_IDS_ENV] ?? '';
  if (value === '') return { stagingTestRealnameUserIds: null, problems: [] };
  if (appEnv !== 'staging') {
    return {
      stagingTestRealnameUserIds: null,
      problems: [
        `${STAGING_TEST_REALNAME_USER_IDS_ENV}: must only be set when APP_ENV=staging (test identities are hard off elsewhere)`,
      ],
    };
  }
  const items = value.split(',');
  const problem = listProblem(items);
  if (problem !== null) {
    return {
      stagingTestRealnameUserIds: null,
      problems: [`${STAGING_TEST_REALNAME_USER_IDS_ENV}: ${problem}`],
    };
  }
  return { stagingTestRealnameUserIds: Object.freeze([...items]), problems: [] };
}
