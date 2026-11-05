import { generateKeyPairSync } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  BridgeOriginsSigner,
  type BridgeOriginsInput,
} from '../../../../apps/api/src/modules/content/domain/bridge-origins.ts';
import { verified } from './jws-kit.ts';

function fixture() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    ...pair,
    signer: new BridgeOriginsSigner({ kid: 'config-2026', privateKey: pair.privateKey }),
  };
}
const input: BridgeOriginsInput = {
  appId: 'brand-a',
  env: 'staging',
  h5BaseUrl: 'https://h5.example.test/app/',
  item: {
    version: 17,
    value: { origins: ['https://h5.example.test', 'https://bridge.example.test:8443'] },
  },
};

it('[AC-F1-02zzzb#1] ES256 紧凑 JWS 使用独立 P-256 公钥验签、64 字节 R‖S 与精确载荷', () => {
  const f = fixture();
  expect(verified(f.signer.sign(input), f.publicKey, 'config-2026')).toStrictEqual({
    v: 1,
    app_id: 'brand-a',
    env: 'staging',
    version: 17,
    origins: ['https://h5.example.test', 'https://bridge.example.test:8443'],
  });
});

it('[AC-F1-02zzzb#2] 缺配置取 h5_base_url 的规范 origin；默认版本非负且先于首次保存', () => {
  const f = fixture();
  const result = f.signer.sign({
    ...input,
    h5BaseUrl: 'https://H5.Example.Test:443/release/',
    item: null,
  });
  const payload = verified(result, f.publicKey, 'config-2026');
  expect(payload.origins).toStrictEqual(['https://h5.example.test']);
  expect(payload.version).toBeLessThanOrEqual(1);
  const next = verified(
    f.signer.sign({ ...input, item: { ...input.item!, version: 1 } }),
    f.publicKey,
    'config-2026',
  );
  expect(next.version).toBe(1);
  expect(next.version).toBeGreaterThanOrEqual(payload.version);
});

it('[AC-F1-02zzzb#3] 同版本签名逐字节稳定，版本变化使签名变化并携带新版本', () => {
  const f = fixture();
  const first = f.signer.sign(input);
  expect(f.signer.sign(structuredClone(input))).toStrictEqual(first);
  const next = f.signer.sign({ ...input, item: { ...input.item!, version: 18 } });
  expect(next.jws).not.toBe(first.jws);
  expect(verified(next, f.publicKey, 'config-2026').version).toBe(18);
});

it('[AC-F1-02zzzb#4] 相同版本跨 app_id / env 不复用别的载荷；轮换 kid 使用新钥', () => {
  const f = fixture();
  const first = f.signer.sign(input);
  for (const changed of [
    { ...input, appId: 'brand-b' },
    { ...input, env: 'prod' as const },
  ]) {
    const result = f.signer.sign(changed);
    expect(result.jws).not.toBe(first.jws);
    expect(verified(result, f.publicKey, 'config-2026')).toMatchObject({
      app_id: changed.appId,
      env: changed.env,
    });
  }
  const nextKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const next = new BridgeOriginsSigner({ kid: 'config-next', privateKey: nextKey.privateKey }).sign(
    input,
  );
  expect(next.jws).not.toBe(first.jws);
  expect(verified(next, nextKey.publicKey, 'config-next').version).toBe(17);
});

it('[AC-F1-02zzzb#5] 默认版本相同时不同品牌的 h5 origin 不串用缓存', () => {
  const f = fixture();
  const a = f.signer.sign({ ...input, item: null });
  const b = f.signer.sign({
    ...input,
    appId: 'brand-b',
    h5BaseUrl: 'https://b.example.test/app',
    item: null,
  });
  expect(a.jws).not.toBe(b.jws);
  expect(verified(b, f.publicKey, 'config-2026')).toMatchObject({
    app_id: 'brand-b',
    origins: ['https://b.example.test'],
  });
});

it('[AC-F1-02zzzb#19] 配置来源的默认 443 端口省略，非默认端口保留', () => {
  const f = fixture();
  const result = f.signer.sign({
    ...input,
    item: {
      version: 8,
      value: { origins: ['https://h5.example.test:443', 'https://bridge.example.test:8443'] },
    },
  });
  expect(verified(result, f.publicKey, 'config-2026')).toMatchObject({
    version: 8,
    origins: ['https://h5.example.test', 'https://bridge.example.test:8443'],
  });
});
