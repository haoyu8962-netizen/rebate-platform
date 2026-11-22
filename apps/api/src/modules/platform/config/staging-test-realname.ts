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

export function readStagingTestRealnameConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): StagingTestRealnameConfigResult {
  void appEnv;
  void env;
  throw new Error('NotImplemented: readStagingTestRealnameConfig');
}
