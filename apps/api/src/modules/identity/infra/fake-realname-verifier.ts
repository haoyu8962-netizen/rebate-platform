// Real-name verifier adapters of the RealnameVerifierPort (规划/08 BR-ID-25; task B1-13d §9.2 #6,
// precedent fake-sms / fake-third-party-identity).
//
// - createFakeRealnameVerifier: local and test only (any other APP_ENV throws). Every request is a
//   match under the provider name FAKE_REALNAME_PROVIDER; it imitates no vendor's messages and
//   keeps and logs nothing of the submitted name or ID number.
// - createRealnameVerifier: what identity.module provides as the verifier: the fake in local /
//   test; in staging / prod null until a two-element vendor is chosen (the request then answers
//   50301 and the attempt is not counted). No vendor answer is ever faked outside local / test.
//
// - createStagingTestRealnameVerifier (B1-13n; owner's consent 2026-11-22, D10-2636 ②): the
//   member-side verifier of a staging node that lists test user_ids
//   (STAGING_TEST_REALNAME_USER_IDS). Only APP_ENV=staging with a non-empty list builds it, and
//   every call judges the environment again: a listed user_id is a match under the provider
//   'staging-test-identity' with one pino audit line (event staging_test_realname_verified; app_id,
//   user_id, provider only), any other user_id is unavailable (50301, not counted). Never the name
//   or the ID number in a log, an audit line or an error; prod never gets a match. The admin
//   real-name correction keeps createRealnameVerifier (no test identity there).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { RootLogger } from '../../platform/index.ts';
import type {
  RealnameVerificationInput,
  RealnameVerificationResult,
  RealnameVerifierPort,
} from '../ports/realname-verifier.ts';

/** B1-13n: what the staging test identity verifier is built from. */
export interface StagingTestRealnameVerifierOptions {
  /** APP_ENV of the process; only 'staging' honours the list. */
  readonly appEnv: string;
  /** STAGING_TEST_REALNAME_USER_IDS as loadConfig kept it; null or empty: none. */
  readonly userIds: readonly string[] | null;
  /** Where the enabling warn (the count only) and the audit lines go. */
  readonly logger: Pick<RootLogger, 'info' | 'warn'>;
}

/** realname.provider of the rows the fake verifies. */
export const FAKE_REALNAME_PROVIDER = 'fake-two-elements';
/** B1-13n: realname.provider of the rows a staging test identity verifies. */
export const STAGING_TEST_REALNAME_PROVIDER = 'staging-test-identity';
/** B1-13n: the `event` field (and the fixed message) of the audit line of a test identity match. */
export const STAGING_TEST_REALNAME_AUDIT_EVENT = 'staging_test_realname_verified';
const STAGING = 'staging';

function isFakeEnvironment(appEnv: string): boolean {
  return appEnv === 'local' || appEnv === 'test';
}

/** Only local / test may construct this adapter; every verification is a match. */
export function createFakeRealnameVerifier(appEnv: string): RealnameVerifierPort {
  if (!isFakeEnvironment(appEnv)) {
    throw new Error(
      'identity: the fake real-name verifier runs only when APP_ENV is local or test',
    );
  }
  return Object.freeze({
    verify: () => Promise.resolve({ outcome: 'match', provider: FAKE_REALNAME_PROVIDER } as const),
  });
}

/** The application assembly uses this factory. No configured vendor in staging / prod: null. */
export function createRealnameVerifier(appEnv: string): RealnameVerifierPort | null {
  // TODO(规划/11 §7.1): 二要素核验供应商的真实适配器 — blocked on 负责人选型与开通（BR-ID-25 细则「供应商」）
  return isFakeEnvironment(appEnv) ? createFakeRealnameVerifier(appEnv) : null;
}

/**
 * B1-13n: the staging test identity verifier, or null when the list is unset / empty (staging then
 * answers 50301 as before). Outside APP_ENV=staging it never answers a match.
 */
export function createStagingTestRealnameVerifier(
  options: StagingTestRealnameVerifierOptions,
): RealnameVerifierPort | null {
  const listed = new Set(options.userIds ?? []);
  if (listed.size === 0) return null;
  if (options.appEnv !== STAGING) {
    // Never names the list, the environment value or anything submitted.
    throw new Error(
      'identity: the staging test identity verifier runs only when APP_ENV is staging',
    );
  }
  const { logger } = options;
  // Fixed message; the only field is the number of listed user_ids (never a user_id).
  logger.warn({ count: listed.size }, 'staging_test_realname_enabled');
  return Object.freeze({
    verify: (input: RealnameVerificationInput): Promise<RealnameVerificationResult> => {
      // Judged again on every call: outside staging nothing is ever a test identity.
      if (options.appEnv !== STAGING || !listed.has(input.user_id)) {
        return Promise.resolve({ outcome: 'unavailable' } as const);
      }
      // Fixed message; app_id, user_id and provider only — never the name or the ID number.
      logger.info(
        {
          event: STAGING_TEST_REALNAME_AUDIT_EVENT,
          app_id: input.app_id,
          user_id: input.user_id,
          provider: STAGING_TEST_REALNAME_PROVIDER,
        },
        STAGING_TEST_REALNAME_AUDIT_EVENT,
      );
      return Promise.resolve({
        outcome: 'match',
        provider: STAGING_TEST_REALNAME_PROVIDER,
      } as const);
    },
  });
}
