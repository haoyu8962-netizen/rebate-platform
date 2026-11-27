// B2-06f: PAYOUT_MODE of the payout process (规划/08 BR-WDR-13; 规划/04 §10: not a config_items key,
// changed only by a production release). resolvePayoutMode(appEnv, env) is pure: it looks only at
// the object it is given (entry.ts hands it the process environment), never at process.env, and
// never changes it.
//   - PAYOUT_MODE unset or empty → dry_run (every APP_ENV); dry_run carries no credentials.
//   - PAYOUT_MODE = 'dry_run' → dry_run.
//   - PAYOUT_MODE = 'live' → live only when appEnv is prod and every PayoutLiveCredentialEnvName is
//     set and not blank; the values are returned as set.
//   - Anything else (live outside prod, a missing credential, an unknown value) throws platform's
//     ConfigError: startup fails. Its message and problems name variables only, never a value.
import { ConfigError, type AppEnv } from '../platform/index.ts';

export type PayoutMode = 'dry_run' | 'live';

/** The variable naming the mode. */
export type PayoutModeEnvName = 'PAYOUT_MODE';

/** The Alipay credential variables live requires (prod only; all set and not blank). */
export type PayoutLiveCredentialEnvName =
  'ALIPAY_APP_ID' | 'ALIPAY_APP_PRIVATE_KEY' | 'ALIPAY_PUBLIC_KEY' | 'ALIPAY_GATEWAY_URL';

/** ALIPAY_APP_ID, ALIPAY_APP_PRIVATE_KEY, ALIPAY_PUBLIC_KEY and ALIPAY_GATEWAY_URL, in this order. */
export interface PayoutLiveCredentials {
  readonly appId: string;
  readonly privateKey: string;
  readonly alipayPublicKey: string;
  readonly gatewayUrl: string;
  /**
   * Certificate mode (B2-06j): the three serial numbers, all or none. resolvePayoutMode never sets
   * them; the payout entry's prod + live decision (payout-mode-kms.ts) always does.
   */
  readonly appCertSn?: string;
  readonly alipayRootCertSn?: string;
  readonly alipayCertSn?: string;
}

export type PayoutModeDecision =
  | { readonly mode: 'dry_run' }
  | { readonly mode: 'live'; readonly credentials: PayoutLiveCredentials };

/** In the order of PayoutLiveCredentials. */
const CREDENTIALS: ReadonlyArray<
  readonly [PayoutLiveCredentialEnvName, keyof PayoutLiveCredentials]
> = [
  ['ALIPAY_APP_ID', 'appId'],
  ['ALIPAY_APP_PRIVATE_KEY', 'privateKey'],
  ['ALIPAY_PUBLIC_KEY', 'alipayPublicKey'],
  ['ALIPAY_GATEWAY_URL', 'gatewayUrl'],
];

const MODE: PayoutModeEnvName = 'PAYOUT_MODE';

export function resolvePayoutMode(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): PayoutModeDecision {
  const mode = env[MODE];
  if (mode === undefined || mode === '' || mode === 'dry_run') return { mode: 'dry_run' };
  // Problems name variables only: the value of PAYOUT_MODE is not echoed either.
  if (mode !== 'live') throw new ConfigError([`${MODE} must be dry_run or live`]);
  if (appEnv !== 'prod') {
    throw new ConfigError([`${MODE}=live is only allowed when APP_ENV is prod`]);
  }
  const missing: string[] = [];
  const values: Partial<Record<keyof PayoutLiveCredentials, string>> = {};
  for (const [name, field] of CREDENTIALS) {
    const value = env[name];
    if (value === undefined || value.trim() === '') missing.push(name);
    else values[field] = value;
  }
  if (missing.length > 0) {
    throw new ConfigError(missing.map((name) => `${name} is required when ${MODE}=live`));
  }
  return { mode: 'live', credentials: values as PayoutLiveCredentials };
}
