import { expect, it } from 'vitest';
import type { UnionErrorCode } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  APP_KEY,
  ctx,
  DETAIL,
  detailBody,
  detailSetup,
  errorBody,
  formOf,
  sent,
  setup,
  unionFailure,
  withStatus,
} from '../taobao-goods/kit.ts';

const taobaoLink = 'https://item.taobao.com/item.htm?id=123456789';
const upstreamItemId = 'Synthetic-ReceivedItem01';

async function expectResolvedItem(raw: string, requestedId: string): Promise<void> {
  const { adapter, credentials, transport } = detailSetup([{ item_id: upstreamItemId }]);
  const result = await adapter.resolveLink(raw, ctx).catch((error: unknown) => error);

  expect(result).toEqual({ item: { platform: 'taobao', item_id: upstreamItemId } });
  expect(credentials).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(formOf(sent(transport))).toMatchObject({
    method: DETAIL,
    app_key: APP_KEY,
    item_id: requestedId,
  });
}

const unsupportedLinks = [
  'https://s.click.taobao.com/abc',
  'https://uland.taobao.com/coupon/edetail?e=x',
  'https://m.tb.cn/abc',
  'https://h5.m.taobao.com/awp/core/detail.htm?id=1',
  'http://item.taobao.com/item.htm?id=1',
  'https://item.taobao.com/item.htm?id=abc',
  'https://item.taobao.com/item.htm?id=',
  'https://item.taobao.com/item.htm?id=123456789012345678901',
  'https://item.taobao.com/item.htm',
  'https://item.taobao.com/other.htm?id=1',
  'https://user@item.taobao.com/item.htm?id=1',
  'https://item.taobao.com.example.invalid/item.htm?id=1',
  'https://item.jd.com/1.html',
  '合成淘口令',
];

it('[AC-B1-04zzzzk#1] [AC-B1-04zzzzk#4] 淘宝商品页取联盟返回的原串，其余链接维持 adapter_unimplemented', async () => {
  await expectResolvedItem(taobaoLink, '123456789');

  const { adapter, credentials, transport, warn } = setup(() => detailBody([]));
  for (const raw of unsupportedLinks) {
    await unionFailure(() => adapter.resolveLink(raw, ctx), 'adapter_unimplemented');
    expect(credentials, raw).not.toHaveBeenCalled();
    expect(transport, raw).not.toHaveBeenCalled();
    expect(warn, raw).not.toHaveBeenCalled();
  }
});

it('[AC-B1-04zzzzk#1] 天猫商品页带其他参数和片段时，仍返回淘宝商品标识', async () => {
  await expectResolvedItem('https://detail.tmall.com/item.htm?spm=x&id=123456789#f', '123456789');
});

it.each([
  ['https://ITEM.taobao.com./item.htm?id=1', '1'],
  ['https://item.taobao.com/item.htm?id=12345678901234567890', '12345678901234567890'],
])('[AC-B1-04zzzzk#2] %s 原样传递商品页数字 ID', async (raw, requestedId) => {
  await expectResolvedItem(raw, requestedId);
});

it.each([
  ['详情商品数组为空', detailBody([])],
  ['详情业务码 15/50001 表示无该商品', errorBody(15, '50001')],
])('[AC-B1-04zzzzk#3] %s 时返回 link_unrecognized', async (_name, answer) => {
  const { adapter, transport } = setup(() => answer);
  await unionFailure(() => adapter.resolveLink(taobaoLink, ctx), 'link_unrecognized');
  expect(transport).toHaveBeenCalledTimes(1);
});

it.each<[string, unknown, UnionErrorCode]>([
  ['请求被拒绝', errorBody(15, '1911'), 'upstream_rejected'],
  ['接口限流', errorBody(7), 'rate_limited'],
  ['HTTP 503', withStatus(503, 'synthetic outage'), 'upstream_unavailable'],
  ['权限错误', errorBody(11, '50001'), 'upstream_misconfigured'],
])('[AC-B1-04zzzzk#5] %s 时沿用详情错误分类', async (_name, answer, code) => {
  const { adapter, transport } = setup(() => answer);
  await unionFailure(() => adapter.resolveLink(taobaoLink, ctx), code);
  expect(transport).toHaveBeenCalledTimes(1);
});
