import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { expect } from 'vitest';
import { versionOf, type Config } from '../config-etag/kit.ts';
import { configEtag } from '../../../../apps/api/src/modules/content/domain/config-etag.ts';

export interface Payload {
  v: number;
  app_id: string;
  env: string;
  version: number;
  origins: string[];
}

/** D10-624: app binding changes only the signed field and its derived content digest. */
export function expectAppBoundConfig(
  first: { data: Config; etag: string },
  firstId: string,
  second: { data: Config; etag: string },
  secondId: string,
  publicKey: KeyObject,
) {
  const { bridge_origins: firstSigned, config_version: firstVersion, ...firstData } = first.data;
  const {
    bridge_origins: secondSigned,
    config_version: secondVersion,
    ...secondData
  } = second.data;
  expect(secondData).toEqual(firstData);
  const { app_id: firstApp, ...firstPayload } = verified(
    firstSigned,
    publicKey,
    'fixture-config-key',
  );
  const { app_id: secondApp, ...secondPayload } = verified(
    secondSigned,
    publicKey,
    'fixture-config-key',
  );
  expect(firstApp).toBe(firstId);
  expect(secondApp).toBe(secondId);
  expect(secondPayload).toEqual(firstPayload);
  expect(firstVersion).toBe(versionOf(first.data));
  expect(secondVersion).toBe(versionOf(second.data));
  expect(first.etag).toBe(configEtag({ ...firstData, bridge_origins: firstSigned }));
  expect(second.etag).toBe(configEtag({ ...secondData, bridge_origins: secondSigned }));
  expect(first.etag).toBe(`"${firstVersion}"`);
  expect(second.etag).toBe(`"${secondVersion}"`);
}

// Independent crypto oracle: no production signing/decoding code is reused.
export function verified(value: unknown, publicKey: KeyObject, kid: string): Payload {
  expect(value).toEqual({ jws: expect.any(String) });
  const { jws } = value as { jws: string };
  expect(jws).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const [header, payload, signature] = jws.split('.') as [string, string, string];
  expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toStrictEqual({
    alg: 'ES256',
    kid,
    typ: 'couli-bridge-origins+jws',
  });
  const bytes = Buffer.from(signature, 'base64url');
  expect(bytes).toHaveLength(64);
  expect(
    verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      {
        key: publicKey,
        dsaEncoding: 'ieee-p1363',
      },
      bytes,
    ),
  ).toBe(true);
  const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString());
  expect(decoded).toEqual({
    v: 1,
    app_id: expect.any(String),
    env: expect.any(String),
    version: expect.any(Number),
    origins: expect.any(Array),
  });
  const result = decoded as Payload;
  expect(Number.isSafeInteger(result.version)).toBe(true);
  expect(result.version).toBeGreaterThanOrEqual(0);
  expect(result.origins.length).toBeGreaterThan(0);
  for (const origin of result.origins) {
    expect(typeof origin).toBe('string');
    expect(origin).toMatch(/^https:\/\/[^*?#/@]+(?::[0-9]+)?$/);
    expect(new URL(origin).origin).toBe(origin);
  }
  return result;
}

// ETag fixture: a real, freshly generated JWS, signed outside the system under test.
export function signedFixture(): { jws: string } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const header = Buffer.from(
    JSON.stringify({
      alg: 'ES256',
      kid: 'etag-fixture',
      typ: 'couli-bridge-origins+jws',
    }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      app_id: 'etag-fixture',
      env: 'test',
      version: 0,
      origins: ['https://h5.example.test'],
    }),
  ).toString('base64url');
  const input = `${header}.${payload}`;
  return {
    jws: `${input}.${sign('sha256', Buffer.from(input), {
      key: pair.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')}`,
  };
}
