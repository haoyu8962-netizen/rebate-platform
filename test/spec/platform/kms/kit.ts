// B1-30a 规则测试公用件（claude-independent，SPEC_REF deb521c2；FU-KMS-ADAPTER，任务书第 9 节；
// 规划/02 §12.6，BR-PAY-08 ②）。所有值都是合成的低熵串，密钥在运行时现生成；期望值照契约手写，不取自实现。
// 平台行为只引 docs-mirror/aliyun-kms/pages/（getsecretvalue.txt、encrypt.txt、decrypt.txt、endpoint.txt）。
// 文件只写在 <repo>/.tmp 下（git 忽略）。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { ConfigError } from '../../../../apps/api/src/modules/platform/config/config.ts';
import type { KmsConfig } from '../../../../apps/api/src/modules/platform/config/kms.ts';
import {
  KmsError,
  type KmsAccess,
  type KmsErrorCode,
  type KmsSecretName,
  kmsAccessOf,
} from '../../../../apps/api/src/modules/platform/kms/index.ts';
import { SDK_MARKER, sdk, type SecretAnswer } from './sdk-stub.ts';

export const KMS: KmsConfig = {
  regionId: 'cn-hangzhou',
  endpoint: 'kms-vpc.cn-hangzhou.aliyuncs.com',
  keyId: 'key-b1-30a-test',
  ramRole: 'couli-b1-30a-role',
};

export const KMS_ENV: Readonly<Record<string, string>> = {
  KMS_REGION_ID: KMS.regionId,
  KMS_ENDPOINT: KMS.endpoint,
  KMS_KEY_ID: KMS.keyId,
  KMS_RAM_ROLE: KMS.ramRole,
};

/** AGENT_USER_HASH_KEY：prod 的 loadConfig 必须有（B3-09j），合成值。 */
export const PROD_AGENT_KEY: Readonly<Record<string, string>> = {
  AGENT_USER_HASH_KEY: 'test-only-agent-user-hash-key-b1-30a',
};

export type Settled<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** 先把结果收成值再断言：vitest 下直接断言抛错的 promise 判不出红因。 */
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
    json = JSON.stringify(value) ?? '';
  } catch {
    json = '';
  }
  return `${String(value)}\n${stack}\n${json}\n${inspect(value, { depth: null, showHidden: true })}`;
}

export function codeOf(outcome: Settled<unknown>): unknown {
  if (outcome.ok) return 'resolved';
  const { error } = outcome;
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : String(error);
}

const ERROR_KEYS = new Set<PropertyKey>(['stack', 'message', 'name', 'code']);

/**
 * 为什么 outcome 不是契约的 KmsError：空数组表示它是 KmsError、code 对、没有 cause、除 stack / message /
 * name / code 外没有别的自有属性，打印出来也没有 SDK 原文和 mustNotContain 里的值。
 */
export function kmsFailureProblems(
  outcome: Settled<unknown>,
  code: KmsErrorCode,
  mustNotContain: readonly string[] = [],
): string[] {
  if (outcome.ok) return ['resolved'];
  const { error } = outcome;
  if (!(error instanceof KmsError)) return [`not a KmsError: ${String(error)}`];
  const problems: string[] = [];
  if (error.code !== code) problems.push(`code ${String(error.code)}`);
  if ('cause' in error) problems.push('cause');
  const extra = Reflect.ownKeys(error).filter((key) => !ERROR_KEYS.has(key));
  if (extra.length > 0) problems.push(`own properties ${extra.map(String).join(',')}`);
  const text = visible(error);
  for (const value of [SDK_MARKER, ...mustNotContain]) {
    if (text.includes(value)) problems.push(`leaks ${value}`);
  }
  return problems;
}

/** 每次新建配置对象：kmsAccessOf 按对象缓存，新对象才有新的实例和新的客户端。 */
export function accessOf(appEnv: 'staging' | 'prod' = 'prod'): KmsAccess {
  const access = kmsAccessOf({ appEnv, kms: { ...KMS } });
  if (access === null) throw new Error('kmsAccessOf returned null for a configured KMS');
  return access;
}

export function text(secretData: string): SecretAnswer {
  return { secretData, secretDataType: 'text' };
}

export function secretNameOf(logical: KmsSecretName, appEnv: string = 'prod'): string {
  return `couli/${appEnv}/${logical}`;
}

export function setSecret(logical: KmsSecretName, answer: SecretAnswer, appEnv = 'prod'): void {
  sdk.secrets.set(secretNameOf(logical, appEnv), answer);
}

/** 桩被读过的 secret 完整名（带 couli/<appEnv>/ 前缀），按调用顺序。 */
export function secretsRead(): string[] {
  return sdk.getSecretValue.mock.calls.map(([request]) => request.secretName);
}

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export function makeDir(label: string): string {
  const base = join(REPO_ROOT, '.tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `spec-b1-30a-${label}-`));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** ConfigError 的 problems；不是 ConfigError 时返回一句说明（断言 toEqual 时自然不等）。 */
export function configProblems(run: () => unknown): readonly string[] | string {
  try {
    run();
    return 'returned without a ConfigError';
  } catch (error) {
    return error instanceof ConfigError ? error.problems : `other error: ${String(error)}`;
  }
}
