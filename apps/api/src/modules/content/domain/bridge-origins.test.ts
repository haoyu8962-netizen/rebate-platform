import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  BridgeOriginsSigner,
  deterministicEs256,
  type BridgeOriginsInput,
} from './bridge-origins.ts';

const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

const INPUT: BridgeOriginsInput = {
  appId: 'couli',
  env: 'staging',
  h5BaseUrl: 'https://h5.example.test/app/',
  item: { version: 17, value: { origins: ['https://h5.example.test', 'https://m.example.test'] } },
};

const RFC_UX = '60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6';
const RFC_UY = '7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299';

function parts(jws: string): [string, string, string] {
  const [h, p, s] = jws.split('.');
  return [h ?? '', p ?? '', s ?? ''];
}

it('[AC-F1-02zzzb] two independent signers with the same key sign byte-identical JWS', () => {
  const a = new BridgeOriginsSigner({ kid: 'k1', privateKey: pair.privateKey }).sign(INPUT).jws;
  const b = new BridgeOriginsSigner({ kid: 'k1', privateKey: pair.privateKey }).sign(INPUT).jws;
  expect(b).toBe(a);
  const scalar = Buffer.from(pair.privateKey.export({ format: 'jwk' }).d ?? '', 'base64url');
  const msg = Buffer.from('header.payload', 'ascii');
  expect(Buffer.from(deterministicEs256(msg, scalar))).toEqual(
    Buffer.from(deterministicEs256(msg, scalar)),
  );
});

it('[AC-F1-02zzzb] the signature verifies with Node crypto as ES256 (ieee-p1363, sha256)', () => {
  const { jws } = new BridgeOriginsSigner({ kid: 'k1', privateKey: pair.privateKey }).sign(INPUT);
  const [h, p, s] = parts(jws);
  const signature = Buffer.from(s, 'base64url');
  expect(signature).toHaveLength(64);
  const ok = verify(
    'sha256',
    Buffer.from(`${h}.${p}`, 'ascii'),
    { key: createPublicKey(pair.privateKey), dsaEncoding: 'ieee-p1363' },
    signature,
  );
  expect(ok).toBe(true);
  expect(JSON.parse(Buffer.from(h, 'base64url').toString('utf8'))).toEqual({
    alg: 'ES256',
    kid: 'k1',
    typ: 'couli-bridge-origins+jws',
  });
});

it('[AC-F1-02zzzb] another kid or another payload changes the signature', () => {
  const base = parts(
    new BridgeOriginsSigner({ kid: 'k1', privateKey: pair.privateKey }).sign(INPUT).jws,
  )[2];
  const otherKid = parts(
    new BridgeOriginsSigner({ kid: 'k2', privateKey: pair.privateKey }).sign(INPUT).jws,
  )[2];
  const otherPayload = parts(
    new BridgeOriginsSigner({ kid: 'k1', privateKey: pair.privateKey }).sign({
      ...INPUT,
      item: { version: 18, value: INPUT.item?.value },
    }).jws,
  )[2];
  expect(otherKid).not.toBe(base);
  expect(otherPayload).not.toBe(base);
});

it('[AC-F1-02zzzb] deterministicEs256 reproduces the RFC 6979 A.2.5 P-256/SHA-256 vectors', () => {
  const d = 'C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721';
  const scalar = Buffer.from(d, 'hex');
  expect(Buffer.from(deterministicEs256(Buffer.from('sample'), scalar)).toString('hex')).toBe(
    'efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716' +
      'f7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8',
  );
  expect(Buffer.from(deterministicEs256(Buffer.from('test'), scalar)).toString('hex')).toBe(
    'f1abb023518351cd71d881567b1ea663ed3efcf6c5132b354f28d3b0b7d38367' +
      '019f4113742a2b14bd25926b49c649155f267e60d3814b4c0cc84250e46f0083',
  );
  // The same scalar loaded as a KeyObject signs identically through two signers.
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: scalar.toString('base64url'),
      x: Buffer.from(RFC_UX, 'hex').toString('base64url'),
      y: Buffer.from(RFC_UY, 'hex').toString('base64url'),
    },
    format: 'jwk',
  });
  const a = new BridgeOriginsSigner({ kid: 'k1', privateKey: key }).sign(INPUT).jws;
  expect(new BridgeOriginsSigner({ kid: 'k1', privateKey: key }).sign(INPUT).jws).toBe(a);
});

it('[AC-F1-02zzzb] a non-P-256 key is refused', () => {
  const ed = generateKeyPairSync('ed25519');
  expect(() => new BridgeOriginsSigner({ kid: 'k1', privateKey: ed.privateKey })).toThrow(
    /P-256 private key/,
  );
});
