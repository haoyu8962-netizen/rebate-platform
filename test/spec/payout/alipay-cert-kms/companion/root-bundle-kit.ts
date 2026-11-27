import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { expect } from 'vitest';
import { certSn } from '../../../../../apps/api/src/modules/payment/infra/channels/alipay/cert-sn.ts';
import { expectedSn, OTHER, selfSignedCert } from '../../../payment/channels/kit.ts';

function der(tag: number, ...parts: readonly Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  if (body.length < 0x80) return Buffer.concat([Buffer.from([tag, body.length]), body]);
  const length: number[] = [];
  for (let size = body.length; size > 0; size = Math.floor(size / 256)) length.unshift(size % 256);
  return Buffer.concat([Buffer.from([tag, 0x80 | length.length, ...length]), body]);
}

function selfSignedEcRoot(): string {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  // ecdsa-with-SHA256 的 AlgorithmIdentifier 没有参数。
  const algorithm = der(0x30, der(0x06, Buffer.from('2a8648ce3d040302', 'hex')));
  const name = der(
    0x30,
    der(
      0x31,
      der(0x30, der(0x06, Buffer.from('550403', 'hex')), der(0x0c, Buffer.from('test-ec-root'))),
    ),
  );
  const validity = der(
    0x30,
    der(0x17, Buffer.from('260101000000Z')),
    der(0x17, Buffer.from('360101000000Z')),
  );
  const tbs = der(
    0x30,
    der(0x02, Buffer.from([21])),
    algorithm,
    name,
    validity,
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, privateKey);
  const certificate = der(0x30, tbs, algorithm, der(0x03, Buffer.from([0]), signature));
  const body = certificate
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trimEnd();
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

export function mixedRootBundle(): { pem: string; expectedSerial: string } {
  const issuer = [{ name: 'CN', value: 'test-rsa-root' }] as const;
  const firstRsa = selfSignedCert(issuer, 19n, OTHER);
  const lastRsa = selfSignedCert(issuer, 20n, OTHER);
  const ec = selfSignedEcRoot();
  const parsedEc = new X509Certificate(ec);
  expect(parsedEc.verify(parsedEc.publicKey)).toBe(true);

  const certificates = [firstRsa, ec, lastRsa];
  const expectedSerial = [expectedSn(issuer, 19n), expectedSn(issuer, 20n)].join('_');
  expect(expectedSerial).not.toBe(certificates.map(certSn).join('_'));
  return { pem: certificates.join(''), expectedSerial };
}
