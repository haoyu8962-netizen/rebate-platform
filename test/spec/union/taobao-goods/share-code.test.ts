import { expect, it } from 'vitest';
import type { UnionErrorCode } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  businessFields,
  ctx,
  endpoint,
  errorBody,
  formOf,
  setup,
  SHARE_MODEL,
  SHARE_PASSWORD,
  shareBody,
  shareData,
  sent,
  TPWD,
  unionFailure,
  withStatus,
} from './kit.ts';

const CLICK_LINK = 'https://s.click.taobao.com/t?e=synthetic-share-0001';
const ULAND_LINK = 'https://uland.taobao.com/coupon/edetail?e=synthetic-share-0002';

function shareSetup(answer: unknown = shareBody(shareData())) {
  return setup(() => answer);
}

it.each([CLICK_LINK, ULAND_LINK])(
  '[AC-B1-04l#22] 淘口令：tpwd.create 只传 url（%s），返回 {password_simple, model} 原样',
  async (link) => {
    const { adapter, transport, credentials } = shareSetup();
    const code = await adapter.taobaoShareCode(link, ctx);
    expect(code).toEqual({ password_simple: SHARE_PASSWORD, model: SHARE_MODEL });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(credentials).toHaveBeenCalledTimes(1);
    const request = sent(transport);
    expect(request).toMatchObject({ platform: 'taobao', method: 'POST', url: endpoint.baseUrl });
    expect(formOf(request)['method']).toBe(TPWD);
    expect(businessFields(request)).toEqual({ url: link });
  },
);

it('[AC-B1-04l#23] 淘口令请求带归档上下文 {appId, kind: convert}，并挂上调用方的 AbortSignal', async () => {
  const { adapter, transport } = shareSetup();
  const controller = new AbortController();
  await adapter.taobaoShareCode(CLICK_LINK, { ...ctx, signal: controller.signal });
  const request = sent(transport);
  expect(request.archive).toEqual({ appId: ctx.appId, kind: 'convert' });
  expect(request.signal).toBe(controller.signal);
});

it.each([
  'http://s.click.taobao.com/t?e=synthetic-share-0001',
  'http://uland.taobao.com/coupon/edetail?e=synthetic-share-0002',
  'ftp://s.click.taobao.com/t?e=synthetic',
  'https://ai.taobao.com/synthetic-share',
  'https://temai.taobao.com/synthetic-share',
  'https://item.taobao.com/item.htm?id=synthetic',
  'https://s.click.taobao.com.evil.invalid/t?e=synthetic',
  'https://evil.invalid/s.click.taobao.com/t?e=synthetic',
  'https://evil.invalid/?to=https://uland.taobao.com/coupon',
  'https://click.taobao.com/t?e=synthetic',
  'not a link',
  '',
])(
  '[AC-B1-04l#24] 不是 https 的 s.click / uland 链接（%s）：invalid_dto，不取凭据、不发请求',
  async (link) => {
    const { adapter, transport, credentials } = shareSetup();
    await unionFailure(() => adapter.taobaoShareCode(link, ctx), 'invalid_dto');
    expect(credentials).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  },
);

it.each<[string, unknown]>([
  ['没有 data', { tbk_tpwd_create_response: { request_id: 'synthetic-request-id' } }],
  ['data 为 null', shareBody(null)],
  ['data 是字符串', shareBody(SHARE_PASSWORD)],
  ['缺 password_simple', shareBody({ model: SHARE_MODEL })],
  ['缺 model', shareBody({ password_simple: SHARE_PASSWORD })],
  ['password_simple 非字符串', shareBody(shareData({ password_simple: 13 }))],
  ['model 非字符串', shareBody(shareData({ model: ['synthetic'] }))],
])('[AC-B1-04l#25] 淘口令应答%s：upstream_unavailable', async (_case, answer) => {
  const { adapter, transport } = shareSetup(answer);
  await unionFailure(() => adapter.taobaoShareCode(CLICK_LINK, ctx), 'upstream_unavailable');
  expect(transport).toHaveBeenCalled();
});

interface ErrorCase {
  readonly name: string;
  readonly answer: unknown;
  readonly code: UnionErrorCode;
}

const shareErrors: readonly ErrorCase[] = [
  {
    name: '15 + sub_code 26（非联盟官方场景）',
    answer: errorBody(15, '26'),
    code: 'link_unrecognized',
  },
  {
    name: '15 + sub_code 23（物料为空）',
    answer: errorBody(15, '23'),
    code: 'link_unrecognized',
  },
  {
    name: '"15" + 数字 sub_code 26',
    answer: errorBody('15', 26),
    code: 'link_unrecognized',
  },
  {
    name: '15 + sub_code 50001（只有详情细分为 item_unavailable）',
    answer: errorBody(15, '50001'),
    code: 'upstream_rejected',
  },
  {
    name: '15 + 其他 sub_code',
    answer: errorBody(15, '27'),
    code: 'upstream_rejected',
  },
  {
    name: '7（限流）',
    answer: errorBody(7),
    code: 'rate_limited',
  },
  {
    name: 'HTTP 502',
    answer: withStatus(502, 'synthetic outage'),
    code: 'upstream_unavailable',
  },
];

it.each(shareErrors)('[AC-B1-04l#26] 淘口令错误 $name 得 $code', async ({ answer, code }) => {
  const { adapter, transport } = shareSetup(answer);
  await unionFailure(() => adapter.taobaoShareCode(CLICK_LINK, ctx), code);
  expect(transport).toHaveBeenCalledTimes(1);
});
