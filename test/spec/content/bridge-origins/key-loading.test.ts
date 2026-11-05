import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadConfigSignKey } from '../../../../apps/api/src/modules/platform/config/config-sign-key.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';

function directory() {
  const base = fileURLToPath(new URL('../../../../.tmp/bridge-key/', import.meta.url));
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, 'case-'));
}

it.each(['local', 'test'] as const)(
  '[AC-F1-02zzzb#6] %s 无文件时生成可用于 ES256 的临时钥',
  async (env) => {
    const key = await loadConfigSignKey(env, null);
    expect(key.kid).toEqual(expect.any(String));
    expect(key.kid.length).toBeGreaterThan(0);
    expect(key.privateKey.type).toBe('private');
    expect(key.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    const data = Buffer.from('synthetic config-sign-key proof');
    const signature = sign('sha256', data, { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
    expect(signature).toHaveLength(64);
    expect(
      verify('sha256', data, { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, signature),
    ).toBe(true);
  },
);

it.each(['staging', 'prod'] as const)(
  '[AC-F1-02zzzb#7] %s 缺签名钥拒绝加载、不降级临时钥',
  async (env) => {
    await expect(loadConfigSignKey(env, null)).rejects.toThrow(/CONFIG_SIGN_KEY/);
  },
);

it('[AC-F1-02zzzb#8] loadConfig 接入 CONFIG_SIGN_KEY_FILE / ID，和 JWT 独立', () => {
  const config = loadConfig(
    {
      APP_ENV: 'test',
      CONFIG_SIGN_KEY_FILE: '/synthetic/config.pem',
      CONFIG_SIGN_KEY_ID: 'config-kid',
    },
    'api',
  );
  expect(config.configSignKey).toStrictEqual({ file: '/synthetic/config.pem', kid: 'config-kid' });
  expect(config.jwt).toBeNull();
});

it.each(['staging', 'prod'] as const)(
  '[AC-F1-02zzzb#9] %s 只配置 FILE 或 ID 拒绝启动且错误只提变量名',
  (env) => {
    for (const partial of [
      { CONFIG_SIGN_KEY_FILE: '/synthetic/do-not-leak/path.pem' },
      { CONFIG_SIGN_KEY_ID: 'one-half-kid' },
    ]) {
      let error: unknown;
      try {
        loadConfig({ APP_ENV: env, ...partial }, 'api');
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/CONFIG_SIGN_KEY/);
      expect(String(error)).not.toContain('/synthetic/do-not-leak');
    }
  },
);

it('[AC-F1-02zzzb#10] staging 读取真实普通文件内的合成 P-256 私钥且保留 kid', async () => {
  const dir = directory();
  try {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const file = join(dir, 'synthetic.pem');
    writeFileSync(file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const loaded = await loadConfigSignKey('staging', { file, kid: 'staging-key' });
    expect(loaded.kid).toBe('staging-key');
    expect(loaded.publicKey.export({ type: 'spki', format: 'der' })).toEqual(
      pair.publicKey.export({ type: 'spki', format: 'der' }),
    );
    const bytes = Buffer.from('known independent key');
    expect(verify('sha256', bytes, pair.publicKey, sign('sha256', bytes, loaded.privateKey))).toBe(
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(['missing', 'directory', 'garbage', 'public-only', 'P-384', 'RSA'] as const)(
  '[AC-F1-02zzzb#11] 密钥 %s 拒绝，错误对象不回显路径、文件内容或 PEM',
  async (kind) => {
    const dir = directory();
    try {
      const file = kind === 'directory' ? dir : join(dir, 'sensitive-path.pem');
      let material = 'synthetic-secret-invalid-content';
      if (kind === 'public-only')
        material = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
          .publicKey.export({ type: 'spki', format: 'pem' })
          .toString();
      if (kind === 'P-384')
        material = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
          .privateKey.export({ type: 'pkcs8', format: 'pem' })
          .toString();
      if (kind === 'RSA')
        material = generateKeyPairSync('rsa', { modulusLength: 2048 })
          .privateKey.export({ type: 'pkcs8', format: 'pem' })
          .toString();
      if (kind !== 'missing' && kind !== 'directory')
        writeFileSync(file, material, { mode: 0o600 });
      // Promise wrapper also captures the intentional synchronous NotImplemented stub.
      const error: unknown = await Promise.resolve()
        .then(() => loadConfigSignKey('staging', { file, kid: 'bad-key' }))
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/CONFIG_SIGN_KEY/);
      const rendered = String(error) + JSON.stringify(error, Object.getOwnPropertyNames(error));
      expect(rendered).not.toContain(dir);
      expect(rendered).not.toContain(material);
      expect(rendered).not.toContain('-----BEGIN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
