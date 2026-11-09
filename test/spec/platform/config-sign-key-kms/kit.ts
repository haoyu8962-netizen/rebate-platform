// B1-01zzt 规则测试公用件（claude-independent，SPEC_REF deaba4fb；编排 D10-1155 ④，prod-wiring-gaps 第 23 项，
// 规划/02 §12.6「配置签名私钥只 api 用、生产走 KMS」）。全是合成值：密钥在运行时现生成，KMS 一律是测试替身，
// 不读真实密钥、.env、~/.couli，不连真实 KMS。文件只写在 <repo>/.tmp 下（git 忽略）。
//
// 签名私钥的 KMS 来源怎么在 AppConfig 里表示由实现定：测试只经 loadConfig 拿到它，再原样交给
// loadConfigSignKey 的第三个参数（KmsAccess | null，可省略：冻结测试照旧两参调用）。
import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { expect } from 'vitest';
import type { AppEnv } from '../../../../apps/api/src/modules/platform/config/app-env.ts';
import {
  ConfigSignKeyError,
  loadConfigSignKey,
  type ConfigSignKey,
} from '../../../../apps/api/src/modules/platform/config/config-sign-key.ts';
import {
  ConfigError,
  loadConfig,
  type AppConfig,
} from '../../../../apps/api/src/modules/platform/config/config.ts';
import type { KmsConfig } from '../../../../apps/api/src/modules/platform/config/kms.ts';
import type {
  KmsAccess,
  KmsSecretName,
} from '../../../../apps/api/src/modules/platform/kms/index.ts';

/** 签名私钥在 KMS 里的逻辑名；完整 secret 名是 couli/<appEnv>/config/sign-private-key。 */
export const LOGICAL = 'config/sign-private-key';

export function secretNameOf(appEnv: string): string {
  return `couli/${appEnv}/${LOGICAL}`;
}

/** CONFIG_SIGN_KEY_ID 的合成值（JWT kid 语法）。 */
export const CONFIG_KID = 'b1-01zzt-kms-kid';

export const KMS: KmsConfig = {
  regionId: 'cn-hangzhou',
  endpoint: 'kms-vpc.cn-hangzhou.aliyuncs.com',
  keyId: 'key-b1-01zzt-test',
  ramRole: 'couli-b1-01zzt-role',
};

export const KMS_ENV: Readonly<Record<string, string>> = {
  KMS_REGION_ID: KMS.regionId,
  KMS_ENDPOINT: KMS.endpoint,
  KMS_KEY_ID: KMS.keyId,
  KMS_RAM_ROLE: KMS.ramRole,
};

/** AGENT_USER_HASH_KEY：prod 的 loadConfig 必须有（B3-09j），合成值。 */
const PROD_AGENT_KEY: Readonly<Record<string, string>> = {
  AGENT_USER_HASH_KEY: 'test-only-agent-user-hash-key-b1-01zzt',
};

/** staging / prod 通过 loadConfig 所需的最少变量（keyring 只给路径，loadConfig 不读文件）。 */
export function cloudEnv(appEnv: 'staging' | 'prod'): Record<string, string> {
  return {
    APP_ENV: appEnv,
    FIELD_KEY_PROVIDER: 'kms',
    FIELD_KEYRING_FILE: '/srv/couli/keys/keyring.json',
    PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
    PRIOR_IDENTITY_KEYRING_FILE: '/srv/couli/keys/prior-identity-keyring.json',
    ...(appEnv === 'prod' ? PROD_AGENT_KEY : {}),
  };
}

/** 只配 CONFIG_SIGN_KEY_ID、KMS 四项齐。 */
export function kmsOnlyEnv(appEnv: 'staging' | 'prod'): Record<string, string> {
  return { ...cloudEnv(appEnv), ...KMS_ENV, CONFIG_SIGN_KEY_ID: CONFIG_KID };
}

export type Settled<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** 先把结果收成值再断言：骨架或旧实现抛的不是断言错误，必须先变成断言失败。 */
export async function settled<T>(run: () => Promise<T> | T): Promise<Settled<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 一个错误对象能被打印出来的全部内容（隐藏属性也算）。 */
export function visible(value: unknown): string {
  const stack = value instanceof Error ? (value.stack ?? '') : '';
  let json: string;
  try {
    const names = value instanceof Error ? Object.getOwnPropertyNames(value) : null;
    json = JSON.stringify(value, names) ?? '';
  } catch {
    json = '';
  }
  const inspected = inspect(value, { depth: null, showHidden: true });
  return `${String(value)}\n${stack}\n${json}\n${inspected}`;
}

export function codeOf(outcome: Settled<unknown>): unknown {
  if (outcome.ok) return 'resolved';
  const { error } = outcome;
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : String(error);
}

/** ConfigError 的 problems；没抛或抛的不是 ConfigError 时返回一句说明（toEqual / toContain 时自然不等）。 */
export function configProblems(env: Readonly<Record<string, string>>): readonly string[] | string {
  try {
    loadConfig(env);
    return 'loaded without a ConfigError';
  } catch (error) {
    return error instanceof ConfigError ? error.problems : `other error: ${String(error)}`;
  }
}

/** loadConfig 必须通过；不通过时是一个断言失败（带 problems），不是 ConfigError。 */
export function loadedConfig(env: Readonly<Record<string, string>>): AppConfig {
  let config: AppConfig | null = null;
  let refusal: unknown = null;
  try {
    config = loadConfig(env);
  } catch (error) {
    refusal = error instanceof ConfigError ? error.problems : String(error);
  }
  expect(config === null ? refusal : 'loaded').toBe('loaded');
  return config as AppConfig;
}

/** 经 loadConfig 得到的 KMS 来源签名钥配置（形状由实现定，这里只要求非空、kid 为配置值）。 */
export function kmsSourcedKeyConfig(appEnv: 'staging' | 'prod'): unknown {
  const config = loadedConfig(kmsOnlyEnv(appEnv));
  const keyConfig: unknown = config.configSignKey ?? null;
  expect(keyConfig).toEqual(expect.objectContaining({ kid: CONFIG_KID }));
  return keyConfig;
}

type Loader = (appEnv: AppEnv, config: unknown, kms?: KmsAccess | null) => Promise<ConfigSignKey>;

/** loadConfigSignKey(appEnv, config, kms)：第三个参数是本任务加的 KMS 访问。 */
export function loadKey(
  appEnv: AppEnv,
  config: unknown,
  kms: KmsAccess | null,
): Promise<ConfigSignKey> {
  return (loadConfigSignKey as unknown as Loader)(appEnv, config, kms);
}

export interface SyntheticKey {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** 未加密 PKCS#8 PEM。 */
  readonly pem: string;
}

export function syntheticP256(): SyntheticKey {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    pem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** KmsAccess.readSecret 交回的样子：去掉末尾一个换行（同 platform/kms 的约定）。 */
export function kmsText(pem: string): string {
  if (pem.endsWith('\r\n')) return pem.slice(0, -2);
  if (pem.endsWith('\n')) return pem.slice(0, -1);
  return pem;
}

/** PEM 的 base64 正文行：错误对象里不许出现任何一行。 */
export function pemBody(pem: string): string[] {
  return pem
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('-----'));
}

export interface FakeKms {
  readonly access: KmsAccess;
  /** readSecret 收到的逻辑名与上限，按调用顺序。 */
  readonly calls: { readonly name: string; readonly maxBytes: number }[];
}

/**
 * 满足 KmsAccess 的替身：readSecret 记下调用再交给 answer（answer 可以抛，模拟 KmsError 或 SDK 原文）。
 * keyProvider 在这里不该被用到，用到就拒绝。
 */
export function fakeKms(answer: (name: string) => string): FakeKms {
  const calls: { name: string; maxBytes: number }[] = [];
  const access: KmsAccess = {
    keyProvider: {
      keyId: 'fake-b1-01zzt',
      wrapKey: () => Promise.reject(new Error('fake KMS: wrapKey is not used here')),
      unwrapKey: () => Promise.reject(new Error('fake KMS: unwrapKey is not used here')),
    },
    readSecret: async (logicalName: KmsSecretName, maxBytes: number) => {
      calls.push({ name: logicalName, maxBytes });
      return answer(logicalName);
    },
  };
  return { access, calls };
}

/** 只在逻辑名对时交回 text 的替身。 */
export function fakeKmsWith(text: string): FakeKms {
  return fakeKms((name) => {
    if (name !== LOGICAL) throw new Error(`fake KMS: unexpected secret ${name}`);
    return text;
  });
}

/** 加载出的钥能签 ES256，签名用独立的公钥和它自己的 publicKey 都能验。 */
export function expectSignsFor(key: ConfigSignKey, publicKey: KeyObject): void {
  expect(key.privateKey.type).toBe('private');
  expect(key.publicKey.export({ type: 'spki', format: 'der' })).toEqual(
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const data = Buffer.from('synthetic config-sign-key proof b1-01zzt');
  const signature = sign('sha256', data, { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  expect(signature).toHaveLength(64);
  expect(verify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(
    true,
  );
  expect(verify('sha256', data, { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(
    true,
  );
}

const ERROR_KEYS = new Set<PropertyKey>(['stack', 'message', 'name', 'code']);

/**
 * 为什么 outcome 不是一次合格的拒绝：空数组表示它是 ConfigSignKeyError、没有 cause、除 stack / message /
 * name / code 外没有别的自有属性，打印出来也没有 mustNotContain 里的任何值。
 */
export function refusalProblems(
  outcome: Settled<unknown>,
  mustNotContain: readonly string[],
): string[] {
  if (outcome.ok) return ['resolved'];
  const { error } = outcome;
  if (!(error instanceof ConfigSignKeyError)) return [`not a ConfigSignKeyError: ${String(error)}`];
  const problems: string[] = [];
  if ('cause' in error) problems.push('cause');
  const extra = Reflect.ownKeys(error).filter((key) => !ERROR_KEYS.has(key));
  if (extra.length > 0) problems.push(`own properties ${extra.map(String).join(',')}`);
  const text = visible(error);
  for (const value of mustNotContain) {
    if (value !== '' && text.includes(value)) problems.push(`leaks ${value}`);
  }
  return problems;
}

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export function makeDir(label: string): string {
  const base = join(REPO_ROOT, '.tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `spec-b1-01zzt-${label}-`));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function writeKeyFile(dir: string, pem: string): string {
  const file = join(dir, 'synthetic-config-sign.pem');
  writeFileSync(file, pem, { mode: 0o600 });
  return file;
}
