import { expect, it } from 'vitest';
import { OTHER, selfSignedCert } from '../../../payment/channels/kit.ts';
import { secretsRead, setSecret, text } from '../../../platform/kms/kit.ts';
import { expectServedThenStopped } from '../../entry/entry-kit.ts';
import { SECRET_NAMES, expectKmsRefused, kmsFixture } from '../entry-kit.ts';
import { mixedRootBundle } from './root-bundle-kit.ts';

it.each([
  ['ALIPAY_APP_ID', '未设', undefined],
  ['ALIPAY_APP_ID', '只有空白', ' \t '],
  ['ALIPAY_GATEWAY_URL', '未设', undefined],
  ['ALIPAY_GATEWAY_URL', '只有空白', ' \t '],
] as const)(
  '[AC-B2-06ja#1] 四个 KMS 条目齐备时，%s %s 仍拒绝启动打款',
  async (variable, _state, value): Promise<void> => {
    const f = await kmsFixture({ env: { [variable]: value } });
    await f.run();

    expectKmsRefused(f);
    expect(f.lines.join('\n')).toContain(variable);
  },
);

const APP_PRIVATE_KEY_NAME = 'payout/alipay/app-private-key';
const APP_CERT_NAME = 'payout/alipay/app-cert';

it.each([
  [
    APP_CERT_NAME,
    (): string => selfSignedCert([{ name: 'CN', value: 'test-payout-rotated-app' }], 12n, OTHER),
  ],
  [APP_PRIVATE_KEY_NAME, (): string => OTHER.privateKey.trimEnd()],
] as const)(
  '[AC-B2-06ja#3] 单独轮换合法的 %s 后应用私钥与证书不成对，拒绝启动打款',
  async (name, replacementOf): Promise<void> => {
    const f = await kmsFixture();
    const replacement = replacementOf();
    setSecret(name, text(replacement));
    await f.run();

    expectKmsRefused(f);
    expect(secretsRead().toSorted()).toEqual(SECRET_NAMES.toSorted());

    const logs = f.lines.join('\n');
    const replacementBody = replacement.trim().split('\n').slice(1, -1);
    expect(replacementBody.some((line): boolean => logs.includes(line))).toBe(false);

    const refusal = f.lines.find(
      (line): boolean => (JSON.parse(line) as { msg: string }).msg === 'startup_failed',
    );
    expect(refusal).toContain('secret_invalid');
    expect(refusal).toContain(APP_PRIVATE_KEY_NAME);
    expect(refusal).toContain(APP_CERT_NAME);
    expect(refusal).not.toContain('payout/alipay/public-cert');
    expect(refusal).not.toContain('payout/alipay/root-cert');
  },
);

it('[AC-B2-06ja#4] live 打款只拼接 RSA 签名的根证书序列号', async (): Promise<void> => {
  const f = await kmsFixture();
  const { pem, expectedSerial } = mixedRootBundle();
  setSecret('payout/alipay/root-cert', text(pem));
  await f.run();
  await expectServedThenStopped(f);

  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.start.mock.calls[0]?.[0]).toMatchObject({
    mode: 'live',
    credentials: { alipayRootCertSn: expectedSerial },
  });
});
