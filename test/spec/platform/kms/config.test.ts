// B1-30a 配置（claude-independent，SPEC_REF deb521c2）：任务书第 9 节「配置」；接入点格式
// docs-mirror/aliyun-kms/pages/endpoint.txt（kms.<region>.aliyuncs.com、kms-vpc.<region>.aliyuncs.com）。
// 问题文案照任务书手写；问题里不许有变量的值。顶层 it。
import { expect, it } from 'vitest';
import {
  loadConfig,
  type AppConfig,
  type AppEnv,
} from '../../../../apps/api/src/modules/platform/config/config.ts';
import { readDataokeConfig } from '../../../../apps/api/src/modules/platform/config/dataoke.ts';
import { readJdConfig } from '../../../../apps/api/src/modules/platform/config/jd.ts';
import {
  readKmsConfig,
  type KmsConfig,
} from '../../../../apps/api/src/modules/platform/config/kms.ts';
import { readPddConfig } from '../../../../apps/api/src/modules/platform/config/pdd.ts';
import { readTaobaoConfig } from '../../../../apps/api/src/modules/platform/config/taobao.ts';
import { PROD_AGENT_KEY, configProblems } from './kit.ts';

const NAMES = ['KMS_REGION_ID', 'KMS_ENDPOINT', 'KMS_KEY_ID', 'KMS_RAM_ROLE'] as const;
type Name = (typeof NAMES)[number];

/** 值里都带标记，用来查问题文案有没有回显。 */
const MARKER = 'markerb130a';
const VALUES: Readonly<Record<Name, string>> = {
  KMS_REGION_ID: `cn-${MARKER}`,
  KMS_ENDPOINT: `kms.${MARKER}.aliyuncs.com`,
  KMS_KEY_ID: `key-${MARKER}`,
  KMS_RAM_ROLE: `role-${MARKER}`,
};
const CONFIGURED: KmsConfig = {
  regionId: VALUES.KMS_REGION_ID,
  endpoint: VALUES.KMS_ENDPOINT,
  keyId: VALUES.KMS_KEY_ID,
  ramRole: VALUES.KMS_RAM_ROLE,
};

const TOGETHER = 'KMS_REGION_ID, KMS_ENDPOINT, KMS_KEY_ID, KMS_RAM_ROLE: must be set together';
const ENDPOINT = 'KMS_ENDPOINT: must be a host name ending in .aliyuncs.com';
const notInLocal = (appEnv: string): string =>
  `KMS_*: must not be set when APP_ENV=${appEnv} (local and test never load real keys)`;

/** 四个变量的全部非空真子集。 */
function partialSets(): Record<string, string>[] {
  const sets: Record<string, string>[] = [];
  for (let mask = 1; mask < 2 ** NAMES.length - 1; mask += 1) {
    const env: Record<string, string> = {};
    NAMES.forEach((name, index) => {
      if ((mask & (1 << index)) !== 0) env[name] = VALUES[name];
    });
    sets.push(env);
  }
  return sets;
}

function emptyStrings(): Record<string, string> {
  return Object.fromEntries(NAMES.map((name) => [name, '']));
}

/** staging / prod 通过 loadConfig 所需的最少变量。 */
function cloudEnv(appEnv: 'staging' | 'prod'): Record<string, string> {
  return {
    APP_ENV: appEnv,
    FIELD_KEY_PROVIDER: 'kms',
    FIELD_KEYRING_FILE: '/srv/couli/keys/keyring.json',
    PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
    PRIOR_IDENTITY_KEYRING_FILE: '/srv/couli/keys/prior-identity-keyring.json',
    ...(appEnv === 'prod' ? PROD_AGENT_KEY : {}),
  };
}

function kmsKeyOf(config: AppConfig): { readonly has: boolean; readonly value: unknown } {
  const record = config as unknown as Record<string, unknown>;
  return { has: Object.hasOwn(record, 'kms'), value: record['kms'] };
}

it.each(['local', 'test'] as const)(
  '[AC-B1-30a#1] %s：全没设或全是空串没有问题；设了任一个或全设都是一条固定问题，kms 为 null，问题里没有值',
  (appEnv) => {
    expect(readKmsConfig(appEnv, {})).toEqual({ kms: null, problems: [] });
    expect(readKmsConfig(appEnv, emptyStrings())).toEqual({ kms: null, problems: [] });
    for (const name of NAMES) {
      const result = readKmsConfig(appEnv, { [name]: VALUES[name] });
      expect(result, name).toEqual({ kms: null, problems: [notInLocal(appEnv)] });
    }
    for (const env of [...partialSets(), { ...VALUES }]) {
      const result = readKmsConfig(appEnv, env);
      expect(result).toEqual({ kms: null, problems: [notInLocal(appEnv)] });
      expect(result.problems.join('\n')).not.toContain(MARKER);
    }
  },
);

it.each(['staging', 'prod'] as const)(
  '[AC-B1-30a#2] %s：全没设无问题；部分设是一条固定问题（空串同未设），kms 为 null；全设得到配置',
  (appEnv) => {
    expect(readKmsConfig(appEnv, {})).toEqual({ kms: null, problems: [] });
    expect(readKmsConfig(appEnv, emptyStrings())).toEqual({ kms: null, problems: [] });
    for (const env of partialSets()) {
      const result = readKmsConfig(appEnv, env);
      expect(result, Object.keys(env).join()).toEqual({ kms: null, problems: [TOGETHER] });
      expect(result.problems.join('\n')).not.toContain(MARKER);
    }
    expect(readKmsConfig(appEnv, { ...VALUES, KMS_RAM_ROLE: '' })).toEqual({
      kms: null,
      problems: [TOGETHER],
    });
    expect(readKmsConfig(appEnv, { ...VALUES })).toEqual({ kms: CONFIGURED, problems: [] });
  },
);

it.each([
  ['带 https', `https://kms.${MARKER}.aliyuncs.com`],
  ['带 http', `http://kms.${MARKER}.aliyuncs.com`],
  ['带路径', `kms.${MARKER}.aliyuncs.com/path`],
  ['带尾斜线', `kms.${MARKER}.aliyuncs.com/`],
  ['带端口', `kms.${MARKER}.aliyuncs.com:443`],
  ['带查询串', `kms.${MARKER}.aliyuncs.com?a=1`],
  ['带用户信息', `user@kms.${MARKER}.aliyuncs.com`],
  ['别的域名', `kms.${MARKER}.example.com`],
  ['后缀后面还有域名', `kms.${MARKER}.aliyuncs.com.example.com`],
  ['不是子域', `${MARKER}aliyuncs.com`],
  ['只有后缀', '.aliyuncs.com'],
  ['中间有空格', `kms.${MARKER} .aliyuncs.com`],
  ['开头有空格', ` kms.${MARKER}.aliyuncs.com`],
  ['末尾有换行', `kms.${MARKER}.aliyuncs.com\n`],
])(
  '[AC-B1-30a#3] KMS_ENDPOINT 非法（%s）：staging 与 prod 都是固定问题，不回显值',
  (_name, value) => {
    for (const appEnv of ['staging', 'prod'] as const) {
      const { problems } = readKmsConfig(appEnv, { ...VALUES, KMS_ENDPOINT: value });
      expect(problems).toEqual([ENDPOINT]);
      expect(problems.join('\n')).not.toContain(MARKER);
    }
    // 同一组变量换成合法接入点就没有问题，公网与 VPC 两种写法都收。
    for (const endpoint of ['kms.cn-hangzhou.aliyuncs.com', 'kms-vpc.cn-hangzhou.aliyuncs.com']) {
      expect(readKmsConfig('prod', { ...VALUES, KMS_ENDPOINT: endpoint })).toEqual({
        kms: { ...CONFIGURED, endpoint },
        problems: [],
      });
    }
  },
);

it('[AC-B1-30a#4] loadConfig：配了才有 kms 键；没配不出现这个键（冻结的 toEqual 不破）；local / test 设了拒绝启动', () => {
  for (const appEnv of ['staging', 'prod'] as const) {
    expect(kmsKeyOf(loadConfig(cloudEnv(appEnv))), appEnv).toEqual({
      has: false,
      value: undefined,
    });
    expect(kmsKeyOf(loadConfig({ ...cloudEnv(appEnv), ...VALUES })), appEnv).toEqual({
      has: true,
      value: CONFIGURED,
    });
  }
  for (const appEnv of ['local', 'test'] as const) {
    expect(kmsKeyOf(loadConfig({ APP_ENV: appEnv }))).toEqual({ has: false, value: undefined });
    expect(configProblems(() => loadConfig({ APP_ENV: appEnv, KMS_KEY_ID: MARKER }))).toEqual([
      notInLocal(appEnv),
    ]);
  }
});

it('[AC-B1-30a#5] loadConfig：KMS 的问题排在 keyring 问题之前，其他变量非法时也一样；问题不带值', () => {
  const orderOf = (env: Record<string, string>): readonly string[] | string =>
    configProblems(() => loadConfig(env));
  const keyring = 'FIELD_KEY_PROVIDER: must be set when APP_ENV=staging';

  const plain = orderOf({ APP_ENV: 'staging', KMS_KEY_ID: MARKER });
  expect(plain).toEqual([TOGETHER, keyring]);

  const withBadLevel = orderOf({ APP_ENV: 'staging', LOG_LEVEL: 'loud', KMS_KEY_ID: MARKER });
  expect(Array.isArray(withBadLevel)).toBe(true);
  const problems = withBadLevel as readonly string[];
  expect(problems).toContain(TOGETHER);
  expect(problems.indexOf(TOGETHER)).toBeLessThan(problems.indexOf(keyring));
  expect(problems.join('\n')).not.toContain(MARKER);

  const badEndpoint = orderOf({ ...cloudEnv('prod'), ...VALUES, KMS_ENDPOINT: 'kms.example.com' });
  expect(badEndpoint).toEqual([ENDPOINT]);
});

interface UnionReader {
  readonly platform: 'pdd' | 'taobao' | 'jd' | 'dataoke';
  readonly read: (
    appEnv: AppEnv,
    env: Readonly<Record<string, string | undefined>>,
  ) => { readonly problems: readonly string[] } & Readonly<Record<string, unknown>>;
  readonly idEnv: string;
  readonly fileEnv: string;
  readonly idField: 'clientId' | 'appKey';
}

const UNION_READERS: readonly UnionReader[] = [
  {
    platform: 'pdd',
    read: readPddConfig as unknown as UnionReader['read'],
    idEnv: 'PDD_CLIENT_ID',
    fileEnv: 'PDD_CLIENT_SECRET_FILE',
    idField: 'clientId',
  },
  {
    platform: 'taobao',
    read: readTaobaoConfig as unknown as UnionReader['read'],
    idEnv: 'TAOBAO_APP_KEY',
    fileEnv: 'TAOBAO_APP_SECRET_FILE',
    idField: 'appKey',
  },
  {
    platform: 'jd',
    read: readJdConfig as unknown as UnionReader['read'],
    idEnv: 'JD_APP_KEY',
    fileEnv: 'JD_APP_SECRET_FILE',
    idField: 'appKey',
  },
  {
    platform: 'dataoke',
    read: readDataokeConfig as unknown as UnionReader['read'],
    idEnv: 'DATAOKE_APP_KEY',
    fileEnv: 'DATAOKE_APP_SECRET_FILE',
    idField: 'appKey',
  },
];

it.each(UNION_READERS)(
  '[AC-B1-30a#6] $platform 配置：prod 配齐 KMS 才保留公开 id（secretFile 为空串）；没配或只配一部分同今天；prod 设 *_FILE 仍是问题；staging 不变',
  ({ platform, read, idEnv, fileEnv, idField }) => {
    const id = `id-${MARKER}`;
    const file = `/srv/${MARKER}/secret`;

    const kept = read('prod', { ...VALUES, [idEnv]: id });
    expect(kept[platform]).toEqual({ [idField]: id, secretFile: '' });
    expect(kept.problems).toEqual([]);

    expect(read('prod', { ...VALUES })[platform]).toBeNull();
    expect(read('prod', { [idEnv]: id })[platform]).toBeNull();
    expect(read('prod', { KMS_KEY_ID: VALUES.KMS_KEY_ID, [idEnv]: id })[platform]).toBeNull();

    const refused = read('prod', { ...VALUES, [idEnv]: id, [fileEnv]: file });
    expect(refused.problems).toHaveLength(1);
    expect(refused.problems[0]).toContain(fileEnv);
    expect(refused.problems.join('\n')).not.toContain(MARKER);

    expect(read('staging', { ...VALUES, [idEnv]: id, [fileEnv]: file })[platform]).toEqual({
      [idField]: id,
      secretFile: file,
    });
    expect(read('staging', { ...VALUES, [idEnv]: id }).problems).toHaveLength(1);
  },
);

it('[AC-B1-30a#7] PAY_ALIPAY_KEY_MODE：prod 只收 public_key 与 cert，别的值是问题且不回显；stream、payout 不读收款变量', () => {
  const env = { ...cloudEnv('prod'), ...VALUES };
  for (const mode of ['public_key', 'cert']) {
    expect(loadConfig({ ...env, PAY_ALIPAY_KEY_MODE: mode }, 'api').appEnv).toBe('prod');
  }
  const problems = configProblems(() =>
    loadConfig({ ...env, PAY_ALIPAY_KEY_MODE: `pem-${MARKER}` }, 'api'),
  );
  expect(Array.isArray(problems)).toBe(true);
  const list = problems as readonly string[];
  expect(list.filter((problem) => problem.startsWith('PAY_ALIPAY_KEY_MODE:'))).toHaveLength(1);
  expect(list.join('\n')).not.toContain(MARKER);
  for (const entry of ['stream', 'payout'] as const) {
    expect(
      loadConfig({ ...env, PAY_ALIPAY_KEY_MODE: `pem-${MARKER}` }, entry).payChannels ?? null,
    ).toBeNull();
  }
});
