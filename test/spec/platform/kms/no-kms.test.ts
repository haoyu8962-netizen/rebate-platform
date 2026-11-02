// B1-30a 没配 KMS 的回归（claude-independent，SPEC_REF deb521c2）：任务书第 9 节铁律「KMS_* 全未配置时，行为与
// 今天逐字相同」与「local / test 或没配 KMS 的进程永远不加载 SDK」。sdk.ts 由 kms/index.ts 懒加载：vi.mock 的
// 工厂只有在它真的被加载时才跑，所以 moduleLoads 能看出有没有加载。工厂一个文件只跑一次，这里的「没加载」断言
// 必须排在本文件第一次走到桩之前（it 按写的顺序执行，第一个 it 里负面在前、正面在后）。顶层 it。
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../../../apps/api/src/modules/platform/config/app-env.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import { openConfiguredFieldCrypto } from '../../../../apps/api/src/modules/platform/config/keyring-startup.ts';
import type { KeyringConfig } from '../../../../apps/api/src/modules/platform/config/keyring.ts';
import { openPddCredentials } from '../../../../apps/api/src/modules/platform/config/pdd-startup.ts';
import {
  kmsAccessOf,
  type KmsAccess,
} from '../../../../apps/api/src/modules/platform/kms/index.ts';
import { startupErrorProblems, memoryLogger, settle, startEntry } from '../crypto/wiring-kit.ts';
import {
  ALIPAY_ORDER,
  ORDER,
  baseEnv,
  channelSetOf,
  commonEnv,
  loadFor,
  warnLines,
} from '../../payment/channels/kit.ts';
import { KMS, accessOf, codeOf, secretsRead, setSecret, settled, text } from './kit.ts';
import { resetSdk, sdk } from './sdk-stub.ts';

vi.mock('../../../../apps/api/src/modules/platform/kms/sdk.ts', async () => {
  const stub = await import('./sdk-stub.ts');
  stub.sdk.moduleLoads += 1;
  return { createKmsSdkClient: stub.createKmsSdkClient };
});

const NEST_TIMEOUT_MS = 90_000;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

type OpenMain = (
  appEnv: AppEnv,
  keyring: KeyringConfig,
  kms?: KmsAccess | null,
) => Promise<unknown>;
const openMain = openConfiguredFieldCrypto as unknown as OpenMain;

beforeEach(() => {
  resetSdk();
});

it(
  '[AC-B1-30a#70] 没配 KMS：keyring、联盟、收款仍是 kms_unavailable，入口启动也是，桩 0 次调用、sdk.ts 没加载；local / test 同样；配了才加载并走桩',
  async () => {
    const env = { ...baseEnv('prod'), ...commonEnv() };
    const config = loadFor(env, 'api');
    expect(Object.hasOwn(config, 'kms')).toBe(false);
    expect(kmsAccessOf(config)).toBeNull();
    expect(kmsAccessOf(loadConfig({ APP_ENV: 'test' }))).toBeNull();
    expect(kmsAccessOf(loadConfig({ APP_ENV: 'local' }))).toBeNull();

    // keyring：不传 access，不读文件（路径不存在）。
    const keyring = await settled(() =>
      openMain('prod', { provider: 'kms', keyringFile: '/nonexistent/keyring.json' }),
    );
    expect(
      keyring.ok ? ['opened'] : startupErrorProblems(keyring.error, 'kms_unavailable'),
    ).toEqual([]);

    // 联盟：现状的两参调用。
    const union = await settled(() => openPddCredentials('prod', null));
    expect(codeOf(union)).toBe('kms_unavailable');

    // 收款：配置完整也是 kms_unavailable，每渠道一条 warn，不列变量名。
    const pay = await channelSetOf(config);
    const answer = { kind: 'unknown', reason: 'kms_unavailable' };
    expect(await pay.set.of('wechat_pay').createOrder(ORDER)).toEqual(answer);
    expect(await pay.set.of('alipay').createOrder(ALIPAY_ORDER)).toEqual(answer);
    expect(warnLines(pay.logs)).toHaveLength(2);
    expect(warnLines(pay.logs).join('\n')).not.toMatch(/PAY_[A-Z0-9_]+/);

    // 入口：FIELD_KEY_PROVIDER=kms 的 worker 与 payout 拒绝启动。
    for (const entry of ['worker', 'payout'] as const) {
      const { logger } = memoryLogger(entry, 'prod');
      const started = await settle(startEntry(entry, { config: loadFor(env, entry), logger }));
      expect(
        'error' in started ? startupErrorProblems(started.error, 'kms_unavailable') : ['started'],
      ).toEqual([]);
    }

    expect(sdk.moduleLoads).toBe(0);
    expect(sdk.created).toEqual([]);
    expect(secretsRead()).toEqual([]);
    expect(sdk.encrypt).not.toHaveBeenCalled();
    expect(sdk.decrypt).not.toHaveBeenCalled();

    // 正面：配了 KMS，kmsAccessOf 本身还不加载，第一次用才加载。
    const access = accessOf();
    expect(sdk.moduleLoads).toBe(0);
    setSecret('union/jd/app-secret', text('synthetic'));
    expect(await access.readSecret('union/jd/app-secret', 64)).toBe('synthetic');
    expect(sdk.moduleLoads).toBe(1);
    expect(sdk.created).toEqual([KMS]);
  },
  NEST_TIMEOUT_MS,
);

function sourcesUnder(directory: string): string[] {
  return readdirSync(join(REPO_ROOT, directory), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => relative(REPO_ROOT, join(REPO_ROOT, directory, file)));
}

it('[AC-B1-30a#71] 全仓只有 platform/kms/sdk.ts 导入 @alicloud/kms20160120，而且是动态 import()', () => {
  const importing = [...sourcesUnder('apps/api/src'), ...sourcesUnder('apps/api/scripts')].filter(
    (file) => /['"]@alicloud\/kms20160120['"]/.test(readFileSync(join(REPO_ROOT, file), 'utf8')),
  );
  expect(importing).toEqual(['apps/api/src/modules/platform/kms/sdk.ts']);
  const source = readFileSync(join(REPO_ROOT, importing[0] ?? ''), 'utf8');
  expect(source).toMatch(/import\(\s*['"]@alicloud\/kms20160120['"]\s*\)/);
  expect(source).not.toMatch(/from\s+['"]@alicloud\/kms20160120['"]/);
});
