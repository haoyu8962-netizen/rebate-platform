// B1-30a readSecret（claude-independent，SPEC_REF deb521c2）：任务书第 9 节「适配器」；GetSecretValue 的
// SecretDataType 取值 text / binary 见 docs-mirror/aliyun-kms/pages/getsecretvalue.txt，上线清单要求建 text。
// SDK 一律打桩（sdk-stub.ts），不联网。顶层 it。
import { beforeEach, expect, it, vi } from 'vitest';
import {
  kmsAccessOf,
  type KmsSecretName,
} from '../../../../apps/api/src/modules/platform/kms/index.ts';
import {
  KMS,
  accessOf,
  kmsFailureProblems,
  secretNameOf,
  secretsRead,
  setSecret,
  settled,
  text,
} from './kit.ts';
import { SDK_MARKER, resetSdk, sdk } from './sdk-stub.ts';

vi.mock('../../../../apps/api/src/modules/platform/kms/sdk.ts', async () => {
  const stub = await import('./sdk-stub.ts');
  stub.sdk.moduleLoads += 1;
  return { createKmsSdkClient: stub.createKmsSdkClient };
});

const NAME: KmsSecretName = 'pay/wechat/apiv3-key';
const STORED_VALUE = 'kms stored value';

beforeEach(() => {
  resetSdk();
});

it('[AC-B1-30a#10] kmsAccessOf：kms 为空返回 null；同一配置对象同一实例，别的对象别的实例；本身不建客户端、不发请求', () => {
  expect(kmsAccessOf({ appEnv: 'prod', kms: null })).toBeNull();
  expect(kmsAccessOf({ appEnv: 'prod' })).toBeNull();
  expect(kmsAccessOf({ appEnv: 'staging', kms: undefined })).toBeNull();

  const config = { appEnv: 'prod', kms: { ...KMS } } as const;
  const access = kmsAccessOf(config);
  expect(access).not.toBeNull();
  expect(kmsAccessOf(config)).toBe(access);
  expect(kmsAccessOf({ appEnv: 'prod', kms: { ...KMS } })).not.toBe(access);
  expect(sdk.created).toEqual([]);
  expect(sdk.getSecretValue).not.toHaveBeenCalled();
});

it('[AC-B1-30a#11] readSecret：secret 名是 couli/<appEnv>/<逻辑名>；text 原样返回；懒建一个客户端，配置原样传入', async () => {
  const prod = accessOf('prod');
  setSecret(NAME, text(STORED_VALUE), 'prod');
  expect(await prod.readSecret(NAME, 256)).toBe(STORED_VALUE);
  expect(await prod.readSecret(NAME, 256)).toBe(STORED_VALUE);
  expect(sdk.getSecretValue.mock.calls.map(([request]) => request)).toEqual([
    { secretName: 'couli/prod/pay/wechat/apiv3-key' },
    { secretName: 'couli/prod/pay/wechat/apiv3-key' },
  ]);
  expect(sdk.created).toEqual([KMS]);

  const staging = accessOf('staging');
  setSecret('union/jd/app-secret', text(STORED_VALUE), 'staging');
  expect(await staging.readSecret('union/jd/app-secret', 256)).toBe(STORED_VALUE);
  expect(secretsRead().at(-1)).toBe('couli/staging/union/jd/app-secret');
});

it.each([
  ['\\n', 'abc\n', 'abc'],
  ['\\r\\n', 'abc\r\n', 'abc'],
  ['只去一个 \\n', 'abc\n\n', 'abc\n'],
  ['只去一个 \\r\\n', 'abc\r\n\r\n', 'abc\r\n'],
  ['单独的 \\r 不是换行', 'abc\r', 'abc\r'],
  ['开头的换行不动', '\nabc', '\nabc'],
])(
  '[AC-B1-30a#12] 末尾换行（%s）：去掉一个，同 startup-secret-file.ts',
  async (_name, raw, expected) => {
    setSecret(NAME, text(raw));
    expect(await accessOf().readSecret(NAME, 256)).toBe(expected);
  },
);

it.each([
  ['binary', { secretData: STORED_VALUE, secretDataType: 'binary' }],
  ['缺类型', { secretData: STORED_VALUE }],
  ['类型大小写不符', { secretData: STORED_VALUE, secretDataType: 'TEXT' }],
  ['类型带空白', { secretData: STORED_VALUE, secretDataType: 'text ' }],
  ['空串', { secretData: '', secretDataType: 'text' }],
  ['只有一个换行', { secretData: '\n', secretDataType: 'text' }],
  ['只有一个 \\r\\n', { secretData: '\r\n', secretDataType: 'text' }],
  ['没有 secretData', { secretDataType: 'text' }],
])('[AC-B1-30a#13] 应答不合格（%s）：secret_invalid，错误不带值', async (_name, answer) => {
  setSecret(NAME, answer);
  const outcome = await settled(() => accessOf().readSecret(NAME, 256));
  expect(kmsFailureProblems(outcome, 'secret_invalid', [STORED_VALUE])).toEqual([]);
});

it('[AC-B1-30a#14] 超长按 UTF-8 字节算：正好 maxBytes 收，多一个字节 secret_invalid', async () => {
  const access = accessOf();
  // 五个汉字是 5 个 UTF-16 码元、15 个字节：按字符数算的实现会放过去。
  const wide = '凑狸凑狸凑';
  setSecret(NAME, text(wide));
  expect(await access.readSecret(NAME, 15)).toBe(wide);
  const outcome = await settled(() => access.readSecret(NAME, 14));
  expect(kmsFailureProblems(outcome, 'secret_invalid', [wide])).toEqual([]);

  setSecret(NAME, text('abcd'));
  expect(await access.readSecret(NAME, 4)).toBe('abcd');
  expect(
    kmsFailureProblems(await settled(() => access.readSecret(NAME, 3)), 'secret_invalid'),
  ).toEqual([]);
});

it('[AC-B1-30a#15] SDK 抛错或建客户端失败：kms_read_failed，错误对象只有固定文案和 code，没有 SDK 原文和 cause', async () => {
  const access = accessOf();
  sdk.getSecretValue.mockRejectedValueOnce(new Error(`${SDK_MARKER}: first`));
  const first = await settled(() => access.readSecret(NAME, 256));
  expect(kmsFailureProblems(first, 'kms_read_failed')).toEqual([]);

  sdk.getSecretValue.mockRejectedValueOnce(
    Object.assign(new Error(`${SDK_MARKER}: second`), {
      data: { SecretData: STORED_VALUE },
      statusCode: 500,
    }),
  );
  const second = await settled(() => access.readSecret(NAME, 256));
  expect(kmsFailureProblems(second, 'kms_read_failed', [STORED_VALUE])).toEqual([]);

  // 文案固定：两次的 SDK 原文不同，错误文案相同。
  const messages = [first, second].map((outcome) =>
    outcome.ok ? 'resolved' : (outcome.error as Error).message,
  );
  expect(messages[0]).toBe(messages[1]);

  sdk.createFailure = new Error(`${SDK_MARKER}: credentials`);
  const noClient = await settled(() => accessOf().readSecret(NAME, 256));
  expect(kmsFailureProblems(noClient, 'kms_read_failed')).toEqual([]);
});

it('[AC-B1-30a#16] 单次调用超过 10 秒：kms_read_failed；10 秒之内不判失败', async () => {
  const access = accessOf();
  // 先用真定时器走一次：动态 import 和建客户端不能占假定时器的时间。
  setSecret(NAME, text(STORED_VALUE));
  expect(await access.readSecret(NAME, 256)).toBe(STORED_VALUE);
  sdk.getSecretValue.mockImplementationOnce(() => new Promise(() => undefined));

  vi.useFakeTimers();
  try {
    const state = { finished: false };
    const pending = settled(() => access.readSecret(NAME, 256)).then((outcome) => {
      state.finished = true;
      return outcome;
    });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(sdk.getSecretValue).toHaveBeenCalledTimes(2);
    expect(state.finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(state.finished).toBe(true);
    expect(kmsFailureProblems(await pending, 'kms_read_failed')).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
  // 超时之后同一实例还能读。
  expect(await access.readSecret(NAME, 256)).toBe(STORED_VALUE);
  expect(secretsRead().at(-1)).toBe(secretNameOf(NAME));
});
