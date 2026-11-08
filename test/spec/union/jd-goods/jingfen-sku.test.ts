import { expect, it, vi } from 'vitest';
import type { JdProductKeyMode } from '../../../../apps/api/src/modules/union/infra/jd/orders.ts';
import { endpoint, sent, unionFailure } from '../jd-core/kit.ts';
import { beyondNumber, num } from '../jd-orders/kit.ts';
import {
  ctx,
  failure,
  listing,
  mode,
  otherItemId,
  otherSkuId,
  reply,
  row,
  skuId,
  success,
  wholeItemId,
  wire,
  withPrice,
  type Answer,
} from './kit.ts';

// sku 模式要 skuId，jingfen 链接里只有 itemId：走 goods.query（keyword 为该链接），取第一条的 skuId；
// 取不到 → link_unrecognized，不猜。item 模式仍直接得 itemId、不调上游。
type Read = (appId: string) => Promise<JdProductKeyMode>;

const link = `https://jingfen.jd.com/detail/${wholeItemId}.html`;
const forms = [
  link,
  `http://jingfen.jd.com/detail/${wholeItemId}.html`,
  `jingfen.jd.com/detail/${wholeItemId}.html`,
  `${link}?from=share`,
];
const other = row({ itemId: otherItemId, skuId: num(otherSkuId) });
const misses: readonly (readonly [string, Answer])[] = [
  ['内层 410', () => reply(failure('410'))],
  ['内层 411', () => reply(failure('411'))],
  ['内层 201', () => reply(failure('201'))],
  ['空数组', () => listing([])],
  ['data 缺失', () => reply(success())],
  ['第一条没有 skuId', () => listing([row({ skuId: undefined })])],
  ['第一条没有 skuId、第二条有', () => listing([row({ skuId: undefined }), other])],
];

it.each(forms)(
  '[AC-B1-04zc#83] sku 模式下 %s 原样作为 keyword 走 goods.query，item_id 取第一条的 skuId',
  async (form) => {
    const { adapter, requests, transport } = wire(() => listing([row(), other]), mode('sku'));
    const { item } = await adapter.resolveLink(form, ctx);
    expect(item).toMatchObject({ platform: 'jd', item_id: skuId, skuId });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ keyword: form, sceneId: 1, pageIndex: 1 });
    expect(requests[0]).not.toHaveProperty('itemIds');
    expect(sent(transport).url).toBe(endpoint.baseUrl);
  },
);

it('[AC-B1-04zc#84] sku 模式下超出 JS 安全整数的 skuId 按原文取', async () => {
  const { adapter } = wire(() => listing([row({ skuId: num(beyondNumber) })]), mode('sku'));
  const { item } = await adapter.resolveLink(link, ctx);
  expect(item).toMatchObject({ item_id: beyondNumber, skuId: beyondNumber });
});

it.each(misses)(
  '[AC-B1-04zc#85] sku 模式遇%s → link_unrecognized，不把 itemId 当 skuId',
  async (_name, answer) => {
    const { adapter, requests } = wire(answer, mode('sku'));
    const error = await unionFailure(() => adapter.resolveLink(link, ctx), 'link_unrecognized');
    expect(error.message).not.toContain(wholeItemId);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ keyword: link, sceneId: 1 });
  },
);

it('[AC-B1-04zc#86] sku 模式第一条价格异常也取它的 skuId，不换第二条', async () => {
  const rows = [withPrice(num('39.905')), other];
  const { adapter } = wire(() => listing(rows), mode('sku'));
  const { item } = await adapter.resolveLink(link, ctx);
  expect(item).toMatchObject({ platform: 'jd', item_id: skuId });
});

it.each([['429', 'rate_limited']] as const)(
  '[AC-B1-04zc#87] sku 模式内层 %s → %s：上游失败不算取不到',
  async (code, expected) => {
    const { adapter, requests } = wire(() => reply(failure(code)), mode('sku'));
    await unionFailure(() => adapter.resolveLink(link, ctx), expected);
    expect(requests).toHaveLength(1);
  },
);

it.each(forms)('[AC-B1-04zc#88] item 模式下 %s 直接得 itemId，不调上游', async (form) => {
  const { adapter, credentials, transport } = wire(() => listing([]), mode('item'));
  const { item } = await adapter.resolveLink(form, ctx);
  expect(item).toMatchObject({ platform: 'jd', item_id: wholeItemId, itemId: wholeItemId });
  expect(credentials).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

it.each(['item', 'sku'] as const)(
  '[AC-B1-04zc#89] %s 模式的 jingfen 链接每次按 ctx.appId 读一次商品键模式',
  async (value) => {
    const read = vi.fn<Read>(async () => value);
    const { adapter } = wire(() => listing([row()]), { productKeyMode: { read } });
    await adapter.resolveLink(link, ctx);
    await adapter.resolveLink(link, ctx);
    expect(read.mock.calls).toEqual([[ctx.appId], [ctx.appId]]);
  },
);

it('[AC-B1-04zc#90] jingfen 链接读到其他模式值 → invalid_dto，不取凭据、不发请求', async () => {
  const read = vi.fn<Read>(async () => 'spu' as unknown as JdProductKeyMode);
  const modes = { productKeyMode: { read } };
  const { adapter, credentials, transport } = wire(() => listing([row()]), modes);
  await unionFailure(() => adapter.resolveLink(link, ctx), 'invalid_dto');
  expect(credentials).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});
