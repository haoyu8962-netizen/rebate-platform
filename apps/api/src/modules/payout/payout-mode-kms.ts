// B2-06j: the payout entry's PAYOUT_MODE decision (规划/08 BR-WDR-13: only the payout process holds
// the transfer key; live only through a production release). resolvePayoutMode (payout-mode.ts)
// stays as it is and decides every case but one: APP_ENV=prod with PAYOUT_MODE=live. There the
// Alipay channel runs in certificate mode with its key and certificates from KMS:
//   - ALIPAY_APP_ID and ALIPAY_GATEWAY_URL still come from the environment and must be set and not
//     blank (ConfigError naming the variables, before KMS is touched);
//   - ALIPAY_APP_PRIVATE_KEY / ALIPAY_PUBLIC_KEY, if still set, are ignored: one warn naming the
//     variables, never their values;
//   - the four KMS_SECRETS.payout secrets are read: the application private key (must be a private
//     key), the application certificate, the Alipay public-key certificate and the Alipay root
//     bundle; the three serial numbers and the Alipay public key are computed only by the injected
//     AlipayCertTools (the entry hands in payment's certSn / rootCertSn / publicKeyFromCert, so the
//     payout module neither imports payment nor parses certificates itself);
//   - KMS not configured, a read failure, a missing secret or one that does not parse → startup is
//     refused with PayoutCredentialsUnavailableError: a fixed text and logical secret names, never a
//     secret, a certificate, an SDK or parser message, nor a `cause`.
// Only the payout entry may call this: any other entry is refused before anything is read.
import { createPrivateKey } from 'node:crypto';
import type { Logger } from 'pino';

import {
  ConfigError,
  KMS_SECRETS,
  type AppEnv,
  type EntryName,
  type KmsAccess,
  type KmsSecretName,
} from '../platform/index.ts';
import {
  resolvePayoutMode,
  type PayoutLiveCredentials,
  type PayoutModeDecision,
} from './payout-mode.ts';

/** How the serial numbers and the Alipay public key are computed (payment's cert-sn.ts). */
export interface AlipayCertTools {
  certSn(certPem: string): string;
  rootCertSn(bundlePem: string): string;
  publicKeyFromCert(certPem: string): string;
}

export interface PayoutDecisionInput {
  readonly entry: EntryName;
  readonly appEnv: AppEnv;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Called only for prod + live, after the two variables are checked; null without KMS. */
  readonly kms: () => KmsAccess | null;
  readonly certs: AlipayCertTools;
  readonly logger: Pick<Logger, 'warn'>;
}

export type PayoutCredentialsFailure = 'kms_not_configured' | 'kms_read_failed' | 'secret_invalid';

const { payout: SECRETS } = KMS_SECRETS;

/** The four secrets of prod + live, in reading order. */
export const PAYOUT_KMS_SECRETS: readonly KmsSecretName[] = Object.freeze([
  SECRETS.alipayAppPrivateKey,
  SECRETS.alipayAppCert,
  SECRETS.alipayPublicCert,
  SECRETS.alipayRootCert,
]);

/** As payment's key files: a key or certificate bundle is far below this. */
const SECRET_MAX_BYTES = 64 * 1024;

const REQUIRED_ENV = ['ALIPAY_APP_ID', 'ALIPAY_GATEWAY_URL'] as const;
const IGNORED_ENV = ['ALIPAY_APP_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY'] as const;

/** A fixed text naming the reason and the logical secret names only. */
export class PayoutCredentialsUnavailableError extends Error {
  readonly reason: PayoutCredentialsFailure;
  readonly secrets: readonly KmsSecretName[];

  constructor(reason: PayoutCredentialsFailure, secrets: readonly KmsSecretName[]) {
    super(`payout credentials unavailable (${reason}): ${secrets.join(', ')}`);
    this.name = 'PayoutCredentialsUnavailableError';
    this.reason = reason;
    this.secrets = Object.freeze([...secrets]);
  }
}

const blank = (value: string | undefined): boolean => value === undefined || value.trim() === '';

/** Throws (no message of its own reaches the caller) unless the text is a private key. */
function privateKeyPem(text: string): string {
  createPrivateKey(text);
  return text;
}

/** A computed value is used only when it is a non-empty string. */
function nonEmpty(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new Error('empty');
  return value;
}

/** prod + live: the certificate-mode credentials from KMS (see the file header). */
async function liveFromKms(input: PayoutDecisionInput): Promise<PayoutModeDecision> {
  const { env } = input;
  const missing = REQUIRED_ENV.filter((name) => blank(env[name]));
  if (missing.length > 0) {
    throw new ConfigError(missing.map((name) => `${name} is required when PAYOUT_MODE=live`));
  }
  const ignored = IGNORED_ENV.filter((name) => env[name] !== undefined);
  if (ignored.length > 0) {
    input.logger.warn({ ignored_env: ignored }, 'payout_env_credentials_ignored');
  }
  const kms = input.kms();
  if (kms === null) {
    throw new PayoutCredentialsUnavailableError('kms_not_configured', PAYOUT_KMS_SECRETS);
  }

  const texts = new Map<KmsSecretName, string>();
  const unreadable: KmsSecretName[] = [];
  for (const name of PAYOUT_KMS_SECRETS) {
    try {
      texts.set(name, await kms.readSecret(name, SECRET_MAX_BYTES));
    } catch {
      // KmsError (fixed text) or anything else: nothing of it is kept.
      unreadable.push(name);
    }
  }
  if (unreadable.length > 0) {
    throw new PayoutCredentialsUnavailableError('kms_read_failed', unreadable);
  }

  const invalid: KmsSecretName[] = [];
  const parse = <T>(name: KmsSecretName, of: (text: string) => T): T | null => {
    try {
      return of(texts.get(name) ?? '');
    } catch {
      invalid.push(name);
      return null;
    }
  };
  const { certs } = input;
  const privateKey = parse(SECRETS.alipayAppPrivateKey, privateKeyPem);
  const appCertSn = parse(SECRETS.alipayAppCert, (text) => nonEmpty(certs.certSn(text)));
  const alipayCert = parse(SECRETS.alipayPublicCert, (text) => ({
    sn: nonEmpty(certs.certSn(text)),
    publicKey: nonEmpty(certs.publicKeyFromCert(text)),
  }));
  const alipayRootCertSn = parse(SECRETS.alipayRootCert, (text) =>
    nonEmpty(certs.rootCertSn(text)),
  );
  if (
    invalid.length > 0 ||
    privateKey === null ||
    appCertSn === null ||
    alipayCert === null ||
    alipayRootCertSn === null
  ) {
    throw new PayoutCredentialsUnavailableError('secret_invalid', invalid);
  }
  const credentials: PayoutLiveCredentials = {
    appId: env['ALIPAY_APP_ID'] as string,
    privateKey,
    alipayPublicKey: alipayCert.publicKey,
    gatewayUrl: env['ALIPAY_GATEWAY_URL'] as string,
    appCertSn,
    alipayRootCertSn,
    alipayCertSn: alipayCert.sn,
  };
  return { mode: 'live', credentials };
}

/**
 * The payout entry's decision. prod + PAYOUT_MODE=live → certificate mode from KMS; everything
 * else → resolvePayoutMode unchanged (no KMS). Any other entry is refused before KMS or the
 * environment is looked at: only the payout process reads the transfer credentials.
 */
export async function resolvePayoutDecision(
  input: PayoutDecisionInput,
): Promise<PayoutModeDecision> {
  if (input.entry !== 'payout') {
    throw new Error('only the payout entry resolves the payout credentials');
  }
  if (input.appEnv === 'prod' && input.env['PAYOUT_MODE'] === 'live') return liveFromKms(input);
  return resolvePayoutMode(input.appEnv, input.env);
}
