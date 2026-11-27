// B2-06j implementer unit tests of resolvePayoutDecision (payout-mode-kms.ts): the three
// implementation must-haves of 任务书 §12.3. A fake KmsAccess and fake AlipayCertTools only; the
// application key is generated at run time, no key or certificate material is written here.
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  APP_ENVS,
  ConfigError,
  HTTP_ENTRIES,
  WORKER_ENTRIES,
  type EntryName,
  type KmsAccess,
  type KmsSecretName,
} from '../platform/index.ts';
import {
  PAYOUT_KMS_SECRETS,
  PayoutCredentialsUnavailableError,
  resolvePayoutDecision,
  type AlipayCertTools,
  type PayoutDecisionInput,
} from './payout-mode-kms.ts';

const rsaPair = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
const APP_KEYS = rsaPair();
const APP_PRIVATE_KEY = APP_KEYS.privateKey.trimEnd();
/** The application key's public half (SPKI PEM), as publicKeyFromCert answers for the app cert. */
const APP_PUBLIC_KEY = APP_KEYS.publicKey;
/** A public key of another pair: an application certificate rotated without its key. */
const OTHER_PUBLIC_KEY = rsaPair().publicKey;

// Opaque texts: only the injected tools look at them (nothing here is a real certificate).
const TEXTS: Readonly<Record<string, string>> = {
  'payout/alipay/app-private-key': APP_PRIVATE_KEY,
  'payout/alipay/app-cert': 'test-opaque-app-cert-text',
  'payout/alipay/public-cert': 'test-opaque-public-cert-text',
  'payout/alipay/root-cert': 'test-opaque-root-bundle-text',
};

const LIVE_ENV = {
  PAYOUT_MODE: 'live',
  ALIPAY_APP_ID: 'test-unit-app-id',
  ALIPAY_GATEWAY_URL: 'https://unit.test.invalid/gateway.do',
};

function fakeKms(texts: Readonly<Record<string, string>> = TEXTS) {
  const readSecret = vi.fn(async (name: KmsSecretName, maxBytes: number) => {
    void maxBytes;
    const text = texts[name];
    if (text === undefined) throw new Error('test-unit-sdk-message');
    return text;
  });
  const access = { keyProvider: {}, readSecret } as unknown as KmsAccess;
  return { access, readSecret };
}

type ToolMocks = { [K in keyof AlipayCertTools]: Mock<(text: string) => string> };

function fakeTools(): ToolMocks {
  return {
    certSn: vi.fn((text: string) => `sn-of:${text}`),
    rootCertSn: vi.fn((text: string) => `root-sn-of:${text}`),
    // The opaque application certificate "holds" the application key's public half.
    publicKeyFromCert: vi.fn((text: string) =>
      text === TEXTS['payout/alipay/app-cert'] ? APP_PUBLIC_KEY : `public-key-of:${text}`,
    ),
  };
}

function input(overrides: Partial<PayoutDecisionInput> = {}) {
  const kms = fakeKms();
  const kmsOf = vi.fn(() => kms.access);
  const certs = fakeTools();
  const logger = { warn: vi.fn() };
  const value: PayoutDecisionInput = {
    entry: 'payout',
    appEnv: 'prod',
    env: LIVE_ENV,
    kms: kmsOf,
    certs,
    logger,
    ...overrides,
  };
  return { value, kms, kmsOf, certs, logger };
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function settled<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

describe('resolvePayoutDecision', () => {
  it('[AC-B2-06j] prod + live with all four secrets: certificate-mode credentials, only the four payout secrets read', async () => {
    const f = input();
    const decision = await resolvePayoutDecision(f.value);
    expect(decision).toStrictEqual({
      mode: 'live',
      credentials: {
        appId: LIVE_ENV.ALIPAY_APP_ID,
        gatewayUrl: LIVE_ENV.ALIPAY_GATEWAY_URL,
        privateKey: APP_PRIVATE_KEY,
        alipayPublicKey: 'public-key-of:test-opaque-public-cert-text',
        appCertSn: 'sn-of:test-opaque-app-cert-text',
        alipayCertSn: 'sn-of:test-opaque-public-cert-text',
        alipayRootCertSn: 'root-sn-of:test-opaque-root-bundle-text',
      },
    });
    expect(f.kms.readSecret.mock.calls.map(([name]) => name)).toEqual([...PAYOUT_KMS_SECRETS]);
    expect(f.logger.warn).not.toHaveBeenCalled();
  });

  // Must-have 1 (§12.3 ①): KMS complete, ALIPAY_APP_ID / ALIPAY_GATEWAY_URL still required.
  it.each(
    ['ALIPAY_APP_ID', 'ALIPAY_GATEWAY_URL'].flatMap((name) =>
      [undefined, '', '   '].map((value) => ({ name, value })),
    ),
  )(
    '[AC-B2-06j] must-have 1: prod + live, KMS complete, $name=$value → refused, KMS not read',
    async ({ name, value }) => {
      const f = input({ env: { ...LIVE_ENV, [name]: value } });
      const result = await settled(resolvePayoutDecision(f.value));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ConfigError);
        expect((result.error as ConfigError).problems).toEqual([
          `${name} is required when PAYOUT_MODE=live`,
        ]);
      }
      expect(f.kmsOf).not.toHaveBeenCalled();
      expect(f.kms.readSecret).not.toHaveBeenCalled();
    },
  );

  // Must-have 2 (§12.3 ②): only the payout entry may read the payout secrets.
  const OTHER_ENTRIES: readonly EntryName[] = [...HTTP_ENTRIES, ...WORKER_ENTRIES].filter(
    (entry) => entry !== 'payout',
  );
  it.each(
    OTHER_ENTRIES.flatMap((entry) =>
      APP_ENVS.flatMap((appEnv) =>
        [undefined, 'dry_run', 'live'].map((mode) => ({ entry, appEnv, mode })),
      ),
    ),
  )(
    '[AC-B2-06j] must-have 2: entry $entry, APP_ENV=$appEnv, PAYOUT_MODE=$mode → refused, no payout secret read',
    async ({ entry, appEnv, mode }) => {
      const f = input({ entry, appEnv, env: { ...LIVE_ENV, PAYOUT_MODE: mode } });
      const result = await settled(resolvePayoutDecision(f.value));
      expect(result.ok).toBe(false);
      expect(f.kmsOf).not.toHaveBeenCalled();
      expect(f.kms.readSecret).not.toHaveBeenCalled();
      expect(f.certs.certSn).not.toHaveBeenCalled();
    },
  );

  it('[AC-B2-06j] must-have 2: the payout entry reads KMS only for prod + live', async () => {
    for (const appEnv of APP_ENVS) {
      for (const mode of [undefined, 'dry_run', 'live']) {
        if (appEnv === 'prod' && mode === 'live') continue;
        const f = input({ appEnv, env: { ...LIVE_ENV, PAYOUT_MODE: mode } });
        await settled(resolvePayoutDecision(f.value));
        expect(f.kmsOf).not.toHaveBeenCalled();
        expect(f.kms.readSecret).not.toHaveBeenCalled();
      }
    }
    const prod = input();
    await resolvePayoutDecision(prod.value);
    expect(prod.kmsOf).toHaveBeenCalledTimes(1);
  });

  // Must-have 3 (§12.3 ③): serial numbers and the public key come only from the injected tools.
  it('[AC-B2-06j] must-have 3: each serial number and the public key are the injected tools’ answers on the right secret', async () => {
    const f = input();
    const decision = await resolvePayoutDecision(f.value);
    expect(f.certs.certSn.mock.calls).toEqual([
      ['test-opaque-app-cert-text'],
      ['test-opaque-public-cert-text'],
    ]);
    expect(f.certs.rootCertSn.mock.calls).toEqual([['test-opaque-root-bundle-text']]);
    // The Alipay public key from the Alipay certificate; then the application certificate's key,
    // only for the pairing check (it becomes no credential).
    expect(f.certs.publicKeyFromCert.mock.calls).toEqual([
      ['test-opaque-public-cert-text'],
      ['test-opaque-app-cert-text'],
    ]);
    // The texts are no certificates at all: nothing but the tools looked inside them.
    expect(decision.mode === 'live' && decision.credentials.alipayRootCertSn).toBe(
      'root-sn-of:test-opaque-root-bundle-text',
    );
  });

  it.each([
    ['certSn', 'payout/alipay/app-cert'],
    ['rootCertSn', 'payout/alipay/root-cert'],
    ['publicKeyFromCert', 'payout/alipay/public-cert'],
  ] as const)(
    '[AC-B2-06j] must-have 3: when %s refuses its secret, startup is refused naming %s only',
    async (tool, secret) => {
      const f = input();
      f.certs[tool].mockImplementation((text: string) => {
        if (text === TEXTS[secret]) throw new Error(`test-unit-parser-message ${text}`);
        if (tool === 'publicKeyFromCert' && text === TEXTS['payout/alipay/app-cert']) {
          return APP_PUBLIC_KEY;
        }
        return `ok:${text}`;
      });
      const result = await settled(resolvePayoutDecision(f.value));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const error = result.error as PayoutCredentialsUnavailableError;
        expect(error).toBeInstanceOf(PayoutCredentialsUnavailableError);
        expect(error.reason).toBe('secret_invalid');
        expect(error.secrets).toEqual([secret]);
        expect(error.message).not.toContain('test-unit-parser-message');
        expect(error.message).not.toContain(TEXTS[secret]);
        expect('cause' in error).toBe(false);
      }
    },
  );

  it('[AC-B2-06j] refusals carry neither secret text nor SDK message; KMS missing, unreadable, bad private key', async () => {
    const noKms = input({ kms: () => null });
    const a = await settled(resolvePayoutDecision(noKms.value));
    expect(!a.ok && (a.error as PayoutCredentialsUnavailableError).reason).toBe(
      'kms_not_configured',
    );

    const missing = input();
    const { access } = fakeKms({ ...TEXTS, 'payout/alipay/root-cert': undefined } as never);
    const b = await settled(resolvePayoutDecision({ ...missing.value, kms: () => access }));
    expect(b.ok).toBe(false);
    if (!b.ok) {
      const error = b.error as PayoutCredentialsUnavailableError;
      expect(error.reason).toBe('kms_read_failed');
      expect(error.secrets).toEqual(['payout/alipay/root-cert']);
      expect(error.message).not.toContain('test-unit-sdk-message');
    }

    const badKey = fakeKms({ ...TEXTS, 'payout/alipay/app-private-key': 'test-unit-not-a-key' });
    const badKeyInput = { ...input().value, kms: () => badKey.access };
    const c = await settled(resolvePayoutDecision(badKeyInput));
    expect(c.ok).toBe(false);
    if (!c.ok) {
      const error = c.error as PayoutCredentialsUnavailableError;
      expect(error.reason).toBe('secret_invalid');
      expect(error.secrets).toEqual(['payout/alipay/app-private-key']);
      expect(error.message).not.toContain('test-unit-not-a-key');
    }
  });

  it('[AC-B2-06j] prod + live ignores ALIPAY_APP_PRIVATE_KEY / ALIPAY_PUBLIC_KEY with one warn naming them only', async () => {
    const f = input({
      env: {
        ...LIVE_ENV,
        ALIPAY_APP_PRIVATE_KEY: 'test-unit-legacy-private',
        ALIPAY_PUBLIC_KEY: 'test-unit-legacy-public',
      },
    });
    const decision = await resolvePayoutDecision(f.value);
    expect(decision.mode === 'live' && decision.credentials.privateKey).toBe(APP_PRIVATE_KEY);
    expect(f.logger.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(f.logger.warn.mock.calls);
    expect(logged).toContain('ALIPAY_APP_PRIVATE_KEY');
    expect(logged).toContain('ALIPAY_PUBLIC_KEY');
    expect(logged).not.toContain('test-unit-legacy');
  });

  // Pairing check: the application private key and the application certificate must be one pair.
  const PAIR_SECRETS = ['payout/alipay/app-private-key', 'payout/alipay/app-cert'];
  const keyBody = (pem: string) => pem.split('\n').filter((line) => !line.startsWith('-----'));

  it.each([
    ['a public key of another pair', () => OTHER_PUBLIC_KEY],
    ['no key at all', () => 'test-unit-not-a-public-key'],
    ['an empty answer', () => ''],
  ] as const)(
    '[AC-B2-06j] application key and certificate not one pair (%s) → secret_invalid naming the two, no key text',
    async (_label, answer) => {
      const f = input();
      f.certs.publicKeyFromCert.mockImplementation((text: string) =>
        text === TEXTS['payout/alipay/app-cert'] ? answer() : `public-key-of:${text}`,
      );
      const result = await settled(resolvePayoutDecision(f.value));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const error = result.error as PayoutCredentialsUnavailableError;
        expect(error).toBeInstanceOf(PayoutCredentialsUnavailableError);
        expect(error.reason).toBe('secret_invalid');
        expect(error.secrets).toEqual(PAIR_SECRETS);
        expect(error.message).toBe(
          `payout credentials unavailable (secret_invalid): ${PAIR_SECRETS.join(', ')}`,
        );
        for (const line of [...keyBody(APP_PRIVATE_KEY), ...keyBody(OTHER_PUBLIC_KEY)]) {
          if (line !== '') expect(error.message).not.toContain(line);
        }
        expect(error.message).not.toContain('test-opaque-app-cert-text');
        expect('cause' in error).toBe(false);
      }
    },
  );

  it('[AC-B2-06j] one pair in another encoding of the public key (PKCS#1 PEM) → credentials returned', async () => {
    const f = input();
    const pkcs1 = createPublicKey(APP_PUBLIC_KEY)
      .export({ type: 'pkcs1', format: 'pem' })
      .toString();
    expect(pkcs1).not.toBe(APP_PUBLIC_KEY);
    f.certs.publicKeyFromCert.mockImplementation((text: string) =>
      text === TEXTS['payout/alipay/app-cert'] ? pkcs1 : `public-key-of:${text}`,
    );
    const decision = await resolvePayoutDecision(f.value);
    expect(decision.mode).toBe('live');
    expect(decision.mode === 'live' && decision.credentials.privateKey).toBe(APP_PRIVATE_KEY);
    expect(decision.mode === 'live' && decision.credentials.alipayPublicKey).toBe(
      'public-key-of:test-opaque-public-cert-text',
    );
  });

  it('[AC-B2-06j] a parse failure lists only the failing secret, even when the pair would not match', async () => {
    const f = input();
    f.certs.publicKeyFromCert.mockImplementation((text: string) =>
      text === TEXTS['payout/alipay/app-cert'] ? OTHER_PUBLIC_KEY : `public-key-of:${text}`,
    );
    f.certs.rootCertSn.mockImplementation(() => {
      throw new Error('test-unit-parser-message');
    });
    const result = await settled(resolvePayoutDecision(f.value));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.error as PayoutCredentialsUnavailableError;
      expect(error.reason).toBe('secret_invalid');
      expect(error.secrets).toEqual(['payout/alipay/root-cert']);
    }
    expect(f.certs.publicKeyFromCert.mock.calls).toEqual([['test-opaque-public-cert-text']]);
  });
});
