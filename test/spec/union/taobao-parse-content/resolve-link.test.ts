import { expect, it } from 'vitest';
import type { UnionErrorCode } from '../../../../apps/api/src/modules/union/domain/types.ts';
import type { UnionTransportResponse } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import type { TaobaoUnionAdapter } from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  appKey as dataokeAppKey,
  baseUrl as dataokeBaseUrl,
  expectedSignRan,
  expectRedacted,
  nonce,
  ok as dataokeOk,
  queryFields,
  response as dataokeResponse,
  secret as dataokeSecret,
  sent as dataokeSent,
  setup as setupDataoke,
  timer,
} from '../dataoke-core/kit.ts';
import {
  APP_KEY,
  ctx,
  DETAIL,
  detailBody,
  detailSetup,
  errorBody,
  formOf,
  sent,
  setup as setupTaobao,
  unionFailure,
  withStatus,
} from '../taobao-goods/kit.ts';
import { dtkRow, query, searchData, searched, truthfulTop } from '../taobao-search/kit.ts';
import { enableThirdPartyParse } from './settings.ts';

// 合成夹具，字段按任务书构造。真实样本仍待 FU-PARSE-CONTENT-SAMPLES。
const parsePath = '/api/tb-service/parse-content';
const goodsId = '9007199254740993123';
const itemId = 'SyN-prefix-ReceivedItem01';
const nextItemId = 'sYn-next-ReceivedItem01';
const shortLink = 'https://s.click.taobao.com/t?e=syn%2Bclick&src=share';
const discardedData = {
  pid: 'synthetic-other-promotion-slot',
  commissionRate: 'synthetic-other-rate',
  commissionType: 'synthetic-other-commission-type',
  url: 'https://promotion.invalid/synthetic-other-link',
  originInfo: { activityId: 'synthetic-other-activity-id' },
};
const discardedValues = [
  discardedData.pid,
  discardedData.commissionRate,
  discardedData.commissionType,
  discardedData.url,
  discardedData.originInfo.activityId,
];

function setupParsedLink(
  parseReply = dataokeOk({ ...discardedData, goodsId }),
  detailReply: unknown = detailBody([{ item_id: itemId }, { item_id: 'Synthetic-OtherRow' }]),
) {
  const dataoke = setupDataoke();
  dataoke.transport.mockResolvedValue(parseReply);
  const taobao = setupTaobao(() => detailReply, {
    orderSource: dataoke.client,
    ...enableThirdPartyParse(ctx.appId),
  });
  return { dataoke, taobao };
}

async function expectResolvedItem(adapter: TaobaoUnionAdapter, raw: string, expectedId: string) {
  const result = await adapter.resolveLink(raw, ctx).catch((error: unknown) => error);
  expect(result).toStrictEqual({ item: { platform: 'taobao', item_id: expectedId } });
}

it.each([
  ['s.click 推广短链', shortLink],
  ['uland 推广链接', 'https://uland.taobao.com/coupon/edetail?e=syn%2Fcoupon'],
  ['淘口令', '  【合成分享文案】￥Synthetic01￥ + 合成商品\n'],
  ['m.tb.cn 短链', 'https://m.tb.cn/h.Synthetic01?tk=example'],
])('[AC-B1-04zzzzo#1] %s 原样解析并取联盟首条 item_id', async (_name, raw) => {
  const { dataoke, taobao } = setupParsedLink();

  await expectResolvedItem(taobao.adapter, raw, itemId);

  expect(dataoke.credentials).toHaveBeenCalledTimes(1);
  expect(dataoke.transport).toHaveBeenCalledTimes(1);
  const parseRequest = dataokeSent(dataoke.transport);
  const parseUrl = new URL(parseRequest.url);
  expect(`${parseUrl.origin}${parseUrl.pathname}`).toBe(`${dataokeBaseUrl}${parsePath}`);
  expect(parseRequest).toMatchObject({
    method: 'GET',
    platform: 'taobao',
    archive: { appId: ctx.appId, kind: 'query' },
  });
  expect(parseRequest.body).toBeUndefined();
  expect(queryFields(parseRequest)).toEqual({
    content: raw,
    version: 'v1.0.0',
    appKey: dataokeAppKey,
    timer,
    nonce,
    signRan: expectedSignRan(dataokeAppKey, timer, nonce, dataokeSecret),
  });

  expect(taobao.transport).toHaveBeenCalledTimes(1);
  expect(dataoke.transport.mock.invocationCallOrder[0]).toBeLessThan(
    taobao.transport.mock.invocationCallOrder[0]!,
  );
  const detailRequest = sent(taobao.transport);
  const detailFields = formOf(detailRequest);
  expect(detailRequest.archive).toEqual({ appId: ctx.appId, kind: 'query' });
  expect(detailFields).toMatchObject({ method: DETAIL, app_key: APP_KEY, item_id: goodsId });
  expectRedacted([detailFields, dataoke.warn.mock.calls, taobao.warn.mock.calls], discardedValues);
});

it.each<[string, UnionTransportResponse]>([
  ['解析业务码 25003', dataokeResponse({ code: 25003, data: null })],
  ['解析业务码字符串 25003', dataokeResponse({ code: '25003', data: { goodsId } })],
  ['只有推广和活动字段', dataokeOk(discardedData)],
  ['goodsId 只在外层', dataokeResponse({ code: 0, goodsId, data: discardedData })],
  ['goodsId 是空字符串', dataokeOk({ ...discardedData, goodsId: '' })],
  ['goodsId 是数字', dataokeOk({ ...discardedData, goodsId: 123456 })],
])('[AC-B1-04zzzzo#2] %s 返回 link_unrecognized', async (_name, parseReply) => {
  const { dataoke, taobao } = setupParsedLink(parseReply);

  const failure = await unionFailure(
    () => taobao.adapter.resolveLink(shortLink, ctx),
    'link_unrecognized',
  );

  expect(dataoke.transport).toHaveBeenCalledTimes(1);
  expect(taobao.credentials).not.toHaveBeenCalled();
  expect(taobao.transport).not.toHaveBeenCalled();
  expectRedacted([failure, dataoke.warn.mock.calls, taobao.warn.mock.calls], discardedValues);
});

it.each<[number, UnionErrorCode, boolean]>([
  [10014, 'rate_limited', false],
  [10021, 'upstream_misconfigured', true],
  [10072, 'site_auth_invalid', true],
  [10008, 'upstream_unavailable', false],
  [10071, 'upstream_rejected', false],
])('[AC-B1-04zzzzo#3] 大淘客 %i 沿用 %s 分类', async (code, classified, warns) => {
  const message = 'synthetic-dataoke-response-message';
  const { dataoke, taobao } = setupParsedLink(
    dataokeResponse({ code, msg: message, data: { ...discardedData, goodsId } }),
  );

  const failure = await unionFailure(() => taobao.adapter.resolveLink(shortLink, ctx), classified);

  expect(dataoke.transport).toHaveBeenCalledTimes(1);
  expect(dataoke.warn.mock.calls).toEqual(warns ? [[{ path: parsePath, code: String(code) }]] : []);
  expect(taobao.transport).not.toHaveBeenCalled();
  expectRedacted([failure, taobao.warn.mock.calls], [message, ...discardedValues]);
});

it.each<[string, unknown, UnionErrorCode]>([
  ['商品数组为空', detailBody([]), 'link_unrecognized'],
  ['接口业务码 15/50001', errorBody(15, '50001'), 'link_unrecognized'],
  ['首条缺 ID', detailBody([{}, { item_id: itemId }]), 'link_unrecognized'],
  ['首条 item_id 是空字符串', detailBody([{ item_id: '' }]), 'link_unrecognized'],
  ['首条 item_id 是数字', detailBody([{ item_id: 123 }]), 'link_unrecognized'],
  ['接口限流', errorBody(7), 'rate_limited'],
  ['HTTP 503', withStatus(503, 'synthetic outage'), 'upstream_unavailable'],
])('[AC-B1-04zzzzo#4] 淘宝详情%s时返回 %s', async (_name, detailReply, classified) => {
  const { dataoke, taobao } = setupParsedLink(undefined, detailReply);

  await unionFailure(() => taobao.adapter.resolveLink(shortLink, ctx), classified);

  expect(dataoke.transport).toHaveBeenCalledTimes(1);
  expect(taobao.transport).toHaveBeenCalledTimes(1);
  expect(formOf(sent(taobao.transport))).toMatchObject({ method: DETAIL, item_id: goodsId });
});

it('[AC-B1-04zzzzo#5] 大淘客来源决定同一短链能否解析', async () => {
  const direct = detailSetup([{ item_id: itemId }]);
  await unionFailure(() => direct.adapter.resolveLink(shortLink, ctx), 'adapter_unimplemented');
  expect(direct.credentials).not.toHaveBeenCalled();
  expect(direct.transport).not.toHaveBeenCalled();
  expect(direct.warn).not.toHaveBeenCalled();

  const { dataoke, taobao } = setupParsedLink();
  await expectResolvedItem(taobao.adapter, shortLink, itemId);
  expect(dataoke.transport).toHaveBeenCalledTimes(1);
});

it.each(['item.taobao.com', 'detail.tmall.com'])(
  '[AC-B1-04zzzzo#6] 配有大淘客来源时 %s 商品页仍直查，同商品短链随后取本次联盟原串',
  async (host) => {
    const { dataoke, taobao } = setupParsedLink(undefined, detailBody([{ item_id: nextItemId }]));
    taobao.transport.mockResolvedValueOnce({
      status: 200,
      headers: { 'content-type': 'application/json;charset=utf-8' },
      body: detailBody([{ item_id: itemId }]),
    });

    await expectResolvedItem(taobao.adapter, `https://${host}/item.htm?id=${goodsId}`, itemId);
    expect(dataoke.credentials).not.toHaveBeenCalled();
    expect(dataoke.transport).not.toHaveBeenCalled();
    expect(taobao.transport).toHaveBeenCalledTimes(1);
    expect(formOf(sent(taobao.transport))).toMatchObject({ method: DETAIL, item_id: goodsId });

    await expectResolvedItem(taobao.adapter, shortLink, nextItemId);
    expect(dataoke.transport).toHaveBeenCalledTimes(1);
    expect(taobao.transport).toHaveBeenCalledTimes(2);
    expect(formOf(sent(taobao.transport, 1))).toMatchObject({ method: DETAIL, item_id: goodsId });
  },
);

it('[AC-B1-04zzzzo#7] 大淘客搜索预热缓存后，同一短链两次解析各取本次联盟原串且保留搜索缓存', async () => {
  const cachedItemId = 'Synthetic-FromSearch';
  let returnedItemId = cachedItemId;
  const dataoke = setupDataoke();
  const dataokeTransport = dataoke.transport.mockResolvedValue(
    dataokeOk(searchData([dtkRow(1, { goodsId })], 1)),
  );
  const { adapter, transport: taobaoTransport } = setupTaobao(
    (form) => {
      if (form['method'] !== DETAIL) return errorBody('synthetic-unexpected-method');
      return truthfulTop((form['item_id'] ?? '').split(','), (id) =>
        id === goodsId ? returnedItemId : undefined,
      );
    },
    {
      orderSource: dataoke.client,
      searchSource: 'dataoke',
      ...enableThirdPartyParse(ctx.appId),
    },
  );
  const { items } = await searched(() => adapter.searchItems(query, ctx));
  expect(items).toMatchObject([{ item_id: cachedItemId }]);
  expect(dataokeTransport).toHaveBeenCalledTimes(1);
  expect(taobaoTransport).toHaveBeenCalledTimes(1);

  for (const [index, expectedItemId] of [itemId, nextItemId].entries()) {
    returnedItemId = expectedItemId;
    dataokeTransport.mockResolvedValueOnce(dataokeOk({ goodsId }));

    await expectResolvedItem(adapter, shortLink, expectedItemId);

    expect(dataokeTransport).toHaveBeenCalledTimes(index + 2);
    const parseRequest = dataokeSent(dataokeTransport, index + 1);
    expect(new URL(parseRequest.url).pathname).toBe(parsePath);
    expect(queryFields(parseRequest)).toMatchObject({ version: 'v1.0.0', content: shortLink });
    expect(taobaoTransport).toHaveBeenCalledTimes(index + 2);
    expect(formOf(sent(taobaoTransport, index + 1))).toMatchObject({
      method: DETAIL,
      item_id: goodsId,
    });
  }

  const searchAfterResolve = await searched(() => adapter.searchItems(query, ctx));
  expect(searchAfterResolve.items).toMatchObject([{ item_id: cachedItemId }]);
  expect(taobaoTransport).toHaveBeenCalledTimes(3);
});
