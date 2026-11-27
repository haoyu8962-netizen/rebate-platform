import { expect, vi } from 'vitest';
import type { AppConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { KMS, text } from '../../platform/kms/kit.ts';
import { resetSdk, sdk } from '../../platform/kms/sdk-stub.ts';
import { expectRefused, fixture, type FixtureOptions } from '../entry/entry-kit.ts';
import {
  ALIPAY_CERT,
  ALIPAY_CERT_PUBLIC_KEY,
  APP_CERT,
  APP_PRIVATE_KEY,
  CERT_SERIALS,
  ROOT_CERT,
} from './cert-kit.ts';

vi.mock('../../../../apps/api/src/modules/platform/kms/sdk.ts', async () => {
  const stub = await import('../../platform/kms/sdk-stub.ts');
  return { createKmsSdkClient: stub.createKmsSdkClient };
});

const LIVE_ENV = {
  PAYOUT_MODE: 'live',
  ALIPAY_APP_ID: 'test-payout-cert-app',
  ALIPAY_GATEWAY_URL: 'https://payout-cert.test.invalid/gateway.do',
};

export const LEGACY_ENV = {
  ALIPAY_APP_PRIVATE_KEY: 'test-payout-legacy-private-sentinel',
  ALIPAY_PUBLIC_KEY: 'test-payout-legacy-public-sentinel',
};

export const EXPECTED_CREDENTIALS = {
  appId: LIVE_ENV.ALIPAY_APP_ID,
  gatewayUrl: LIVE_ENV.ALIPAY_GATEWAY_URL,
  privateKey: APP_PRIVATE_KEY,
  alipayPublicKey: ALIPAY_CERT_PUBLIC_KEY,
  ...CERT_SERIALS,
};

const SECRETS = {
  'couli/prod/payout/alipay/app-private-key': APP_PRIVATE_KEY,
  'couli/prod/payout/alipay/app-cert': APP_CERT,
  'couli/prod/payout/alipay/public-cert': ALIPAY_CERT,
  'couli/prod/payout/alipay/root-cert': ROOT_CERT,
};

export const SECRET_NAMES = Object.keys(SECRETS);

interface KmsFixtureOptions extends FixtureOptions {
  readonly withKms?: boolean;
}

interface PlatformPorts {
  loadConfig(env: object): AppConfig;
  createDbHandles(...args: unknown[]): unknown;
}

const platformUrl = new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url);

export async function kmsFixture(options: KmsFixtureOptions = {}) {
  const f = await fixture({
    appEnv: 'prod',
    ...options,
    env: { ...LIVE_ENV, ...options.env },
  });
  const platform = (await import(platformUrl.href)) as PlatformPorts;
  const base = platform.loadConfig({ APP_ENV: 'test' });
  vi.spyOn(platform, 'loadConfig').mockReturnValue({
    ...base,
    kms: options.withKms === false ? null : { ...KMS },
  });
  const closeHandles = vi.fn(async () => undefined);
  const createHandles = vi.spyOn(platform, 'createDbHandles').mockReturnValue({
    db: null,
    dbRead: null,
    close: closeHandles,
  });

  resetSdk();
  for (const [name, value] of Object.entries(SECRETS)) sdk.secrets.set(name, text(value));
  return { ...f, closeHandles, createHandles };
}

export function expectNoCredentialInLogs(lines: readonly string[]): void {
  const logs = lines.join('\n');
  for (const value of Object.values(LEGACY_ENV)) expect(logs).not.toContain(value);
  for (const [name, pem] of Object.entries(SECRETS)) {
    const contents = pem.trim().split('\n').slice(1, -1);
    const leaked = contents.some((line) => logs.includes(line));
    expect(leaked, name).toBe(false);
  }
}

export function expectKmsRefused(f: Awaited<ReturnType<typeof kmsFixture>>): void {
  expectRefused(f);
  expect(f.closeHandles).toHaveBeenCalledTimes(f.createHandles.mock.calls.length);
  expectNoCredentialInLogs(f.lines);
}
