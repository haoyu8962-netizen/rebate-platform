// B1-30a 四家联盟（claude-independent，SPEC_REF deb521c2）：任务书第 9 节「接入」；规划/02 §12.6「联盟 appSecret、
// 授权令牌 | KMS」。只有 prod 走 KMS，staging 仍读文件。函数级覆盖 open*Credentials，模块级用
// union/jd-live-wiring/kit.ts 的 startUnion 跑真的工厂。SDK 打桩，fetch 打桩，不联网。顶层 it。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../../../apps/api/src/modules/platform/config/app-env.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import {
  DataokeStartupError,
  openDataokeCredentials,
} from '../../../../apps/api/src/modules/platform/config/dataoke-startup.ts';
import {
  JdStartupError,
  openJdCredentials,
} from '../../../../apps/api/src/modules/platform/config/jd-startup.ts';
import {
  PddStartupError,
  openPddCredentials,
} from '../../../../apps/api/src/modules/platform/config/pdd-startup.ts';
import {
  TaobaoStartupError,
  openTaobaoCredentials,
} from '../../../../apps/api/src/modules/platform/config/taobao-startup.ts';
import type {
  KmsAccess,
  KmsSecretName,
} from '../../../../apps/api/src/modules/platform/kms/index.ts';
import { endpoints, environment, startUnion } from '../../union/jd-live-wiring/kit.ts';
import {
  KMS_ENV,
  PROD_AGENT_KEY,
  accessOf,
  codeOf,
  makeDir,
  removeDir,
  secretNameOf,
  secretsRead,
  setSecret,
  settled,
  text,
  visible,
} from './kit.ts';
import { SDK_MARKER, resetSdk, sdk } from './sdk-stub.ts';

vi.mock('../../../../apps/api/src/modules/platform/kms/sdk.ts', async () => {
  const stub = await import('./sdk-stub.ts');
  stub.sdk.moduleLoads += 1;
  return { createKmsSdkClient: stub.createKmsSdkClient };
});

type Credentials = () => Promise<Readonly<Record<string, string>>>;
type Opener = (appEnv: AppEnv, cfg: unknown, kms?: KmsAccess | null) => Promise<Credentials>;

interface Platform {
  readonly name: string;
  readonly open: Opener;
  readonly errorClass: new (code: never) => Error;
  readonly idField: 'clientId' | 'appKey';
  readonly secretField: 'clientSecret' | 'appSecret';
  readonly logical: KmsSecretName;
}

const PLATFORMS: readonly Platform[] = [
  {
    name: '拼多多',
    open: openPddCredentials as unknown as Opener,
    errorClass: PddStartupError as unknown as Platform['errorClass'],
    idField: 'clientId',
    secretField: 'clientSecret',
    logical: 'union/pdd/client-secret',
  },
  {
    name: '淘宝',
    open: openTaobaoCredentials as unknown as Opener,
    errorClass: TaobaoStartupError as unknown as Platform['errorClass'],
    idField: 'appKey',
    secretField: 'appSecret',
    logical: 'union/taobao/app-secret',
  },
  {
    name: '京东',
    open: openJdCredentials as unknown as Opener,
    errorClass: JdStartupError as unknown as Platform['errorClass'],
    idField: 'appKey',
    secretField: 'appSecret',
    logical: 'union/jd/app-secret',
  },
  {
    name: '大淘客',
    open: openDataokeCredentials as unknown as Opener,
    errorClass: DataokeStartupError as unknown as Platform['errorClass'],
    idField: 'appKey',
    secretField: 'appSecret',
    logical: 'union/dataoke/app-secret',
  },
];

const PUBLIC_ID = 'public-id-b1-30a';
const KMS_VALUE = 'kms stored value';
const FILE_VALUE = 'file stored value';

let dir: string;

beforeEach(() => {
  resetSdk();
  dir = makeDir('union');
  // 实现再坏也不许在这些测试里联网。
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network access is forbidden')));
});
afterEach(() => {
  vi.unstubAllGlobals();
  removeDir(dir);
});

function prodConfig({ idField }: Platform): Readonly<Record<string, string>> {
  return { [idField]: PUBLIC_ID, secretFile: '' };
}

it.each(PLATFORMS)(
  '[AC-B1-30a#40] $name prod + KMS：返回公开 id 与 secret（去一个换行）；只读一次，之后 provider 不再调 SDK',
  async (platform) => {
    setSecret(platform.logical, text(`${KMS_VALUE}\n`));
    const provider = await platform.open('prod', prodConfig(platform), accessOf());
    const expected = { [platform.idField]: PUBLIC_ID, [platform.secretField]: KMS_VALUE };
    expect(await provider()).toEqual(expected);
    expect(await provider()).toEqual(expected);
    expect(secretsRead()).toEqual([secretNameOf(platform.logical)]);
  },
);

it.each(PLATFORMS)(
  '[AC-B1-30a#41] $name prod：缺公开 id credentials_missing 且不调 SDK；没有 access 是 kms_unavailable',
  async (platform) => {
    const access = accessOf();
    for (const cfg of [null, undefined, { [platform.idField]: '', secretFile: '' }]) {
      const outcome = await settled(() => platform.open('prod', cfg, access));
      expect(codeOf(outcome)).toBe('credentials_missing');
      expect(outcome.ok ? null : outcome.error).toBeInstanceOf(platform.errorClass);
    }
    for (const kms of [undefined, null]) {
      const outcome = await settled(() => platform.open('prod', prodConfig(platform), kms));
      expect(codeOf(outcome)).toBe('kms_unavailable');
    }
    expect(sdk.created).toEqual([]);
    expect(sdk.getSecretValue).not.toHaveBeenCalled();
  },
);

it.each(PLATFORMS)(
  '[AC-B1-30a#42] $name prod：KMS 读失败 kms_unavailable；空、binary、过大 secret_invalid；都是该平台的错误类，不带 SDK 原文和值',
  async (platform) => {
    const access = accessOf();
    const open = () => settled(() => platform.open('prod', prodConfig(platform), access));

    sdk.getSecretValue.mockRejectedValueOnce(new Error(`${SDK_MARKER}: ${KMS_VALUE}`));
    const failed = await open();
    expect(codeOf(failed)).toBe('kms_unavailable');
    expect(failed.ok ? null : failed.error).toBeInstanceOf(platform.errorClass);
    expect(visible(failed.ok ? null : failed.error)).not.toContain(SDK_MARKER);
    expect(visible(failed.ok ? null : failed.error)).not.toContain(KMS_VALUE);

    for (const answer of [
      text(''),
      text('\n'),
      { secretData: KMS_VALUE, secretDataType: 'binary' },
      { secretData: KMS_VALUE },
      text('x'.repeat(1024 * 1024)),
    ]) {
      setSecret(platform.logical, answer);
      const invalid = await open();
      expect(codeOf(invalid)).toBe('secret_invalid');
      expect(invalid.ok ? null : invalid.error).toBeInstanceOf(platform.errorClass);
      expect(visible(invalid.ok ? null : invalid.error)).not.toContain(KMS_VALUE);
    }
  },
);

it.each(PLATFORMS)(
  '[AC-B1-30a#43] $name：staging 有 KMS 也读文件、不调 SDK；local / test 还是 live_in_local',
  async (platform) => {
    const access = accessOf('staging');
    setSecret(platform.logical, text(KMS_VALUE), 'staging');
    const file = join(dir, 'secret.txt');
    writeFileSync(file, `${FILE_VALUE}\n`);
    const provider = await platform.open(
      'staging',
      { [platform.idField]: PUBLIC_ID, secretFile: file },
      access,
    );
    expect(await provider()).toEqual({
      [platform.idField]: PUBLIC_ID,
      [platform.secretField]: FILE_VALUE,
    });
    for (const appEnv of ['local', 'test'] as const) {
      const outcome = await settled(() => platform.open(appEnv, prodConfig(platform), access));
      expect(codeOf(outcome)).toBe('live_in_local');
    }
    expect(sdk.created).toEqual([]);
    expect(sdk.getSecretValue).not.toHaveBeenCalled();
  },
);

/** prod、配齐 KMS 和四家公开 id 的环境；extra 里写空串表示去掉某个变量。 */
function prodEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...environment('prod'),
    ...PROD_AGENT_KEY,
    ...KMS_ENV,
    PDD_CLIENT_ID: 'public-pdd-id',
    TAOBAO_APP_KEY: 'public-taobao-key',
    JD_APP_KEY: 'public-jd-key',
    DATAOKE_APP_KEY: 'public-dataoke-key',
    ...extra,
  };
}

function setAllUnionSecrets(): void {
  for (const platform of PLATFORMS) setSecret(platform.logical, text(KMS_VALUE));
}

/**
 * 跑真的工厂，并把启动结果收成断言：骨架上工厂抛 PddStartupError（kms_unavailable），那不是一个算数的红因，
 * 必须先变成断言失败。
 */
async function startedRegistry(
  config: ReturnType<typeof loadConfig>,
): Promise<Awaited<ReturnType<typeof startUnion>>> {
  const outcome = await settled(() => startUnion(config, endpoints('live', 'live')));
  expect(outcome.ok ? 'started' : `refused: ${String(codeOf(outcome))}`).toBe('started');
  return (outcome as { readonly value: Awaited<ReturnType<typeof startUnion>> }).value;
}

function implemented(registry: Awaited<ReturnType<typeof startUnion>>): Record<string, boolean> {
  return Object.fromEntries(
    registry.registrations().map((item) => [item.platform, item.implemented]),
  );
}

it('[AC-B1-30a#44] union.module：prod + KMS + 三家 live：真的走到桩，每个 secret 读一次，三家都是真适配器', async () => {
  setAllUnionSecrets();
  const registry = await startedRegistry(loadConfig(prodEnv()));
  expect(implemented(registry)).toEqual({ jd: true, pdd: true, taobao: true });
  expect(secretsRead().toSorted()).toEqual(
    PLATFORMS.map((platform) => secretNameOf(platform.logical)).toSorted(),
  );
});

it('[AC-B1-30a#45] union.module：大淘客只在配了公开 id 时读；没配时不读它的 secret，淘宝照常', async () => {
  setAllUnionSecrets();
  const registry = await startedRegistry(loadConfig(prodEnv({ DATAOKE_APP_KEY: '' })));
  expect(implemented(registry)).toEqual({ jd: true, pdd: true, taobao: true });
  expect(secretsRead()).not.toContain(secretNameOf('union/dataoke/app-secret'));
  expect(secretsRead()).toContain(secretNameOf('union/taobao/app-secret'));
});

it.each([
  ['PDD_CLIENT_ID', 'credentials_missing', PddStartupError],
  ['TAOBAO_APP_KEY', 'credentials_missing', TaobaoStartupError],
  ['JD_APP_KEY', 'credentials_missing', JdStartupError],
] as const)(
  '[AC-B1-30a#46] union.module：prod 配了 KMS 选 live 却缺 %s：拒绝启动',
  async (variable, code, errorClass) => {
    setAllUnionSecrets();
    const config = loadConfig(prodEnv({ [variable]: '' }));
    const outcome = await settled(() => startUnion(config, endpoints('live', 'live')));
    expect(codeOf(outcome)).toBe(code);
    expect(outcome.ok ? null : outcome.error).toBeInstanceOf(errorClass);
  },
);

it('[AC-B1-30a#47] union.module：KMS 读失败或 secret 不合格拒绝启动（kms_unavailable、secret_invalid），错误不带 SDK 原文', async () => {
  setAllUnionSecrets();
  sdk.getSecretValue.mockRejectedValueOnce(new Error(SDK_MARKER));
  const failed = await settled(() => startUnion(loadConfig(prodEnv()), endpoints('live', 'live')));
  expect(codeOf(failed)).toBe('kms_unavailable');
  expect(visible(failed.ok ? null : failed.error)).not.toContain(SDK_MARKER);

  setSecret('union/pdd/client-secret', text(''));
  const invalid = await settled(() => startUnion(loadConfig(prodEnv()), endpoints('live', 'live')));
  expect(codeOf(invalid)).toBe('secret_invalid');
});

it('[AC-B1-30a#48] union.module：staging 配了 KMS 还是读文件、不调 SDK；淘宝、京东没配时仍是未实现', async () => {
  setAllUnionSecrets();
  // prod 的正例先站住，下面的「不调 SDK」才有意义。
  const prod = await startedRegistry(loadConfig(prodEnv()));
  expect(implemented(prod)).toEqual({ jd: true, pdd: true, taobao: true });

  resetSdk();
  const file = join(dir, 'pdd-secret.txt');
  writeFileSync(file, FILE_VALUE);
  const config = loadConfig({
    ...environment('staging'),
    ...KMS_ENV,
    PDD_CLIENT_ID: 'public-pdd-id',
    PDD_CLIENT_SECRET_FILE: file,
  });
  const registry = await startedRegistry(config);
  expect(implemented(registry)).toEqual({ jd: false, pdd: true, taobao: false });
  expect(sdk.created).toEqual([]);
  expect(sdk.getSecretValue).not.toHaveBeenCalled();
});
