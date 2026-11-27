import { verify } from 'node:crypto';
import { expect, it } from 'vitest';
import { PayoutChannelNotConfiguredError } from '../../../../apps/api/src/modules/payout/domain/channel-result.ts';
import { AlipayChannel } from '../../../../apps/api/src/modules/payout/infra/channels/alipay-channel.ts';
import { settled } from '../../platform/kms/kit.ts';
import {
  alipayKeys,
  appKeys,
  fixture,
  REQUEST,
  signedEnvelope,
  signNode,
  VERIFIED_TEST_LISTS,
} from '../channel/fixtures.ts';
import { ALIPAY_CERT_PRIVATE_KEY, ALIPAY_CERT_PUBLIC_KEY, CERT_SERIALS } from './cert-kit.ts';

const METHODS = ['transfer', 'query'] as const;
type Method = (typeof METHODS)[number];

const API_METHOD = {
  transfer: 'alipay.fund.trans.uni.transfer',
  query: 'alipay.fund.trans.common.query',
} as const;

const ORDER_ID = 'test-payout-cert-order';
const SUCCESS_NODE = { code: '10000', status: 'SUCCESS', order_id: ORDER_ID };
const OTHER_SN = 'test-other-alipay-cert-sn';

function response(
  method: Method,
  node: Record<string, string>,
  serial: string | null,
  signer = ALIPAY_CERT_PRIVATE_KEY,
): string {
  const raw = JSON.stringify(node);
  const envelope = signedEnvelope(method, raw, signNode(raw, signer));
  return serial === null
    ? envelope
    : `${envelope.slice(0, -1)},"alipay_cert_sn":${JSON.stringify(serial)}}`;
}

function channelFixture(
  method: Method,
  body: string,
  serials: Partial<typeof CERT_SERIALS> = CERT_SERIALS,
  publicKey = ALIPAY_CERT_PUBLIC_KEY,
) {
  const { options, send } = fixture(async () => ({ status: 200, body }));
  const credentials = { ...options.credentials, ...serials, alipayPublicKey: publicKey };
  return {
    send,
    async run() {
      const channel = new AlipayChannel({ ...options, credentials, lists: VERIFIED_TEST_LISTS });
      return method === 'transfer' ? channel.transfer(REQUEST) : channel.query(REQUEST.outBizNo);
    },
  };
}

function pauses(result: object): boolean {
  return 'pauseQueue' in result && result.pauseQueue === true;
}

async function expectUnverified(f: ReturnType<typeof channelFixture>): Promise<void> {
  const result = await f.run();
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(result.kind).toBe('unknown');
  expect(pauses(result)).toBe(false);
  expect(result.channelOrderId).toBeUndefined();
  expect(result.paidAt).toBeUndefined();
}

it.each(METHODS)(
  '[AC-B2-06j#1] %s 的两个请求证书序列号参与加签，业务字段与公钥模式一致',
  async (method) => {
    const cert = channelFixture(method, response(method, SUCCESS_NODE, CERT_SERIALS.alipayCertSn));
    const plain = channelFixture(
      method,
      response(method, SUCCESS_NODE, null, alipayKeys().privateKey),
      {},
      alipayKeys().publicKey,
    );
    expect(await cert.run()).toMatchObject({ kind: 'success', channelOrderId: ORDER_ID });
    expect(await plain.run()).toMatchObject({ kind: 'success', channelOrderId: ORDER_ID });
    expect(cert.send).toHaveBeenCalledTimes(1);
    expect(plain.send).toHaveBeenCalledTimes(1);

    const form = new URLSearchParams(cert.send.mock.calls[0]?.[1].body);
    const plainForm = new URLSearchParams(plain.send.mock.calls[0]?.[1].body);
    expect(form.get('method')).toBe(API_METHOD[method]);
    expect(form.get('app_cert_sn')).toBe(CERT_SERIALS.appCertSn);
    expect(form.get('alipay_root_cert_sn')).toBe(CERT_SERIALS.alipayRootCertSn);
    expect(plainForm.has('app_cert_sn')).toBe(false);
    expect(plainForm.has('alipay_root_cert_sn')).toBe(false);

    const bizContent = form.get('biz_content') ?? '{}';
    expect(JSON.parse(bizContent)).toMatchObject({
      out_biz_no: REQUEST.outBizNo,
      product_code: 'TRANS_ACCOUNT_NO_PWD',
      biz_scene: 'DIRECT_TRANSFER',
      ...(method === 'transfer' ? { trans_amount: '12.34' } : {}),
    });
    if (method === 'transfer') expect(bizContent).toContain('TEST_COMMISSION_SCENE');
    expect(form.get('biz_content')).toBe(plainForm.get('biz_content'));

    // Rebuild the signed text independently of the channel's signer.
    const canonical = [...form]
      .filter(([key, value]) => key !== 'sign' && value !== '')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    const signature = Buffer.from(form.get('sign') ?? '', 'base64');
    expect(verify('RSA-SHA256', Buffer.from(canonical), appKeys().publicKey, signature)).toBe(true);

    await expectUnverified(channelFixture(method, response(method, SUCCESS_NODE, null)));
  },
);

const BUSINESS_RESULTS = [
  { method: 'transfer', code: '10000', status: 'SUCCESS', kind: 'success', pause: false },
  { method: 'transfer', code: '40004', subCode: 'TEST_CONFIRMED_FAIL', kind: 'fail', pause: false },
  {
    method: 'transfer',
    code: '40004',
    subCode: 'TEST_PAYER_SIDE',
    kind: 'payer_side',
    pause: true,
  },
  { method: 'transfer', code: '40004', subCode: 'TEST_UNRECOGNIZED', kind: 'unknown', pause: true },
  { method: 'query', code: '10000', status: 'SUCCESS', kind: 'success', pause: false },
  { method: 'query', code: '10000', status: 'TEST_FINAL_FAIL', kind: 'fail', pause: false },
  { method: 'query', code: '10000', status: 'TEST_PENDING', kind: 'unknown', pause: false },
] as const;

it.each(BUSINESS_RESULTS)(
  '[AC-B2-06j#2] $method：证书序列号与签名正确时按原规则判定 $kind',
  async (row) => {
    const node: Record<string, string> = {
      code: row.code,
      order_id: ORDER_ID,
      ...('status' in row ? { status: row.status } : { sub_code: row.subCode }),
    };
    const cert = channelFixture(row.method, response(row.method, node, CERT_SERIALS.alipayCertSn));
    const result = await cert.run();
    expect(result).toMatchObject({ kind: row.kind, channelOrderId: ORDER_ID });
    expect(pauses(result)).toBe(row.pause);
    expect(cert.send).toHaveBeenCalledTimes(1);

    await expectUnverified(channelFixture(row.method, response(row.method, node, OTHER_SN)));
  },
);

it.each(METHODS)(
  '[AC-B2-06j#3] %s：成功应答的证书序列号缺失、不符或用了公钥模式的签名时，结果未知、不暂停、不重发',
  async (method) => {
    const bodies = [
      response(method, SUCCESS_NODE, null),
      response(method, SUCCESS_NODE, OTHER_SN),
      response(method, SUCCESS_NODE, CERT_SERIALS.alipayCertSn, alipayKeys().privateKey),
    ];
    for (const body of bodies) await expectUnverified(channelFixture(method, body));
  },
);

const { appCertSn, alipayRootCertSn, alipayCertSn } = CERT_SERIALS;
const PARTIAL_SERIALS: readonly Partial<typeof CERT_SERIALS>[] = [
  { appCertSn },
  { alipayRootCertSn },
  { alipayCertSn },
  { appCertSn, alipayRootCertSn },
  { appCertSn, alipayCertSn },
  { alipayRootCertSn, alipayCertSn },
];

it.each(METHODS.flatMap((method) => PARTIAL_SERIALS.map((serials) => ({ method, serials }))))(
  '[AC-B2-06j#4] $method：只配部分证书序列号 $serials，在发送请求前拒绝',
  async ({ method, serials }) => {
    const f = channelFixture(
      method,
      response(method, SUCCESS_NODE, CERT_SERIALS.alipayCertSn),
      serials,
    );
    expect(await settled(f.run)).toMatchObject({
      ok: false,
      error: expect.any(PayoutChannelNotConfiguredError),
    });
    expect(f.send).not.toHaveBeenCalled();
  },
);
