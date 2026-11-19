// STAGING-SMOKE (QA-04b): what the cases share during one run.
import type { MemberClient } from '../lib/member-client.ts';
import type { AdminCredential, MemberConfig, Target } from '../lib/node-files.ts';

export interface SmokeContext {
  readonly target: Target;
  readonly member: MemberClient;
  readonly config: MemberConfig;
  /** null: admin.json missing (case 7 fails with that reason). */
  readonly adminCredential: AdminCredential | null;
  /** Set by case 1; later cases that need a session are skipped while it is false. */
  loggedIn: boolean;
  /** Legal versions from GET /v1/config, for the SMS login (BR-ID-04). */
  legal: { privacy: number; agreement: number } | null;
  /** min_supported_version of GET /v1/app-versions/check (case 8's 10405 probe). */
  minSupportedVersion: string | null;
}

/** Withdrawal amount of each run: the default minimum and step of BR-WDR-04 (¥1). */
export const WITHDRAW_AMOUNT_FEN = 100n;
/** Below this withdrawable balance the money cases are skipped as yellow (D10-2119 ②, ¥10). */
export const LOW_BALANCE_FEN = 1000n;
