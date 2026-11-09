// B1-01zzt 经 content 公共模块的装配（claude-independent，SPEC_REF deaba4fb）：编排 D10-1155 ④ 第 6 条、
// prod-wiring-gaps 第 23 项、规划/02 §12.6。配置从 loadConfig 来（CONFIG_SIGN_KEY_ID + KMS_* → AppConfig），
// 真的 kmsAccessOf 经 vi.mock 走到 ./sdk-stub.ts：断言读的是 couli/<appEnv>/config/sign-private-key，/v1/config
// 的 bridge_origins 用 KMS 读出的钥签、kid 为配置值。不连库（DummyDriver）、不 listen、不联网。顶层 it。
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { startContent, verifiedBridgeOrigins, type ContentApp } from './content-kit.ts';
import {
  CONFIG_KID,
  KMS_ENV,
  cloudEnv,
  codeOf,
  kmsOnlyEnv,
  loadedConfig,
  makeDir,
  pemBody,
  refusalProblems,
  removeDir,
  secretNameOf,
  syntheticP256,
  writeKeyFile,
  type Settled,
} from './kit.ts';
import { SDK_MARKER, resetSdk, sdk } from './sdk-stub.ts';

vi.mock('../../../../apps/api/src/modules/platform/kms/sdk.ts', async () => {
  const stub = await import('./sdk-stub.ts');
  return { createKmsSdkClient: stub.createKmsSdkClient };
});

// 第一次加载 Nest 很慢，CI 更慢：显式放宽。
const NEST_TIMEOUT_MS = 90_000;

beforeEach(() => {
  resetSdk();
  // 实现再坏也不许在这些测试里联网。
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network access is forbidden')));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function started(outcome: Settled<ContentApp>): ContentApp {
  expect(outcome.ok ? 'started' : `refused: ${String(outcome.error)}`).toBe('started');
  const app = (outcome as { readonly value: ContentApp }).value;
  onTestFinished(() => app.close());
  return app;
}

async function bridgeOriginsOf(app: ContentApp): Promise<unknown> {
  const response = await app.readConfig();
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ data: { bridge_origins?: unknown } }>().data.bridge_origins;
}

it.each(['staging', 'prod'] as const)(
  '[AC-B1-01zzt#10] %s：content 公共模块：只配 ID + KMS 时从 KMS 读一次 couli/<appEnv>/config/sign-private-key，bridge_origins 用读出的钥签、kid 为配置值；改配 FILE / ID 一对后读文件、不再读 KMS',
  async (appEnv) => {
    const config = loadedConfig(kmsOnlyEnv(appEnv));
    const kmsKey = syntheticP256();
    sdk.secrets.set(secretNameOf(appEnv), { secretData: kmsKey.pem, secretDataType: 'text' });

    const lines: string[] = [];
    const app = started(await startContent(config, lines));
    expect(sdk.reads).toEqual([secretNameOf(appEnv)]);
    const payload = verifiedBridgeOrigins(await bridgeOriginsOf(app), kmsKey.publicKey, CONFIG_KID);
    expect(payload.env).toBe(appEnv);
    // 签名钥在启动时读一次，之后的请求不再读 KMS。
    await bridgeOriginsOf(app);
    expect(sdk.reads).toEqual([secretNameOf(appEnv)]);
    const log = lines.join('\n');
    expect(log).not.toContain('-----BEGIN');
    for (const line of pemBody(kmsKey.pem)) expect(log).not.toContain(line);

    // FILE / ID 一对 + KMS 也配了：用文件里的钥，不读 KMS。
    resetSdk();
    sdk.secrets.set(secretNameOf(appEnv), { secretData: kmsKey.pem, secretDataType: 'text' });
    const dir = makeDir('content');
    onTestFinished(() => removeDir(dir));
    const fileKey = syntheticP256();
    const fileConfig = loadedConfig({
      ...cloudEnv(appEnv),
      ...KMS_ENV,
      CONFIG_SIGN_KEY_FILE: writeKeyFile(dir, fileKey.pem),
      CONFIG_SIGN_KEY_ID: 'file-kid',
    });
    const fileApp = started(await startContent(fileConfig));
    verifiedBridgeOrigins(await bridgeOriginsOf(fileApp), fileKey.publicKey, 'file-kid');
    expect(sdk.reads).toEqual([]);
  },
  NEST_TIMEOUT_MS,
);

it.each(['staging', 'prod'] as const)(
  '[AC-B1-01zzt#11] %s：content 公共模块：KMS 读失败或读出的不是 P-256 PKCS#8 PEM 时启动被拒（ConfigSignKeyError），错误与日志不带 SDK 原文和钥内容',
  async (appEnv) => {
    const config = loadedConfig(kmsOnlyEnv(appEnv));
    const kmsKey = syntheticP256();
    sdk.secrets.set(secretNameOf(appEnv), { secretData: kmsKey.pem, secretDataType: 'text' });
    sdk.readFailure = new Error(`${SDK_MARKER}: ${kmsKey.pem}`);
    const lines: string[] = [];
    const failed = await startContent(config, lines);
    const mustNotContain = [SDK_MARKER, '-----BEGIN', ...pemBody(kmsKey.pem)];
    expect(refusalProblems(failed, mustNotContain)).toEqual([]);
    expect(sdk.reads).toEqual([secretNameOf(appEnv)]);
    for (const value of mustNotContain) expect(lines.join('\n')).not.toContain(value);

    resetSdk();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    sdk.secrets.set(secretNameOf(appEnv), { secretData: rsa, secretDataType: 'text' });
    const invalid = await startContent(loadedConfig(kmsOnlyEnv(appEnv)));
    expect(refusalProblems(invalid, ['-----BEGIN', ...pemBody(rsa)])).toEqual([]);
    expect(codeOf(invalid)).toBe('key_invalid');
  },
  NEST_TIMEOUT_MS,
);
