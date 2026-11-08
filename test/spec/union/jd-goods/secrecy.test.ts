import { expect, it } from 'vitest';
import { expectRedacted, unionFailure } from '../jd-core/kit.ts';
import { num } from '../jd-orders/kit.ts';
import {
  basePrice,
  couponLink,
  ctx,
  expectNoMarkers,
  failure,
  listing,
  reply,
  row,
  success,
  title,
  warnings,
  wire,
  withPrice,
} from './kit.ts';

// 错误与告警不带报文内容、关键词原文、券链接。
const keyword = '合成隐私关键词';
const link = 'https://u.jd.com/privacy-marker';
const upstreamText = 'upstream-text-marker';

it.each([
  ['429', 'rate_limited'],
  ['410', 'link_unrecognized'],
  ['411', 'link_unrecognized'],
  ['999', 'upstream_rejected'],
] as const)(
  '[AC-B1-04zc#61] 搜索遇内层 %s：错误 %s 不带关键词与上游文案',
  async (code, expected) => {
    const { adapter, warn } = wire(() => reply(failure(code, upstreamText)));
    const error = await unionFailure(() => adapter.searchItems({ keyword }, ctx), expected);
    expectRedacted(error, [keyword, upstreamText]);
    expectNoMarkers(warn.mock.calls, [keyword, upstreamText]);
  },
);

it('[AC-B1-04zc#62] resolveLink 识别不了：错误不带链接原文', async () => {
  const { adapter } = wire(() => listing([]));
  const error = await unionFailure(() => adapter.resolveLink(link, ctx), 'link_unrecognized');
  expectRedacted(error, [link, 'privacy-marker']);
});

it('[AC-B1-04zc#63] data 不是数组：错误不带报文内容', async () => {
  const { adapter } = wire(() => reply(success({ data: { note: upstreamText } })));
  const error = await unionFailure(() => adapter.searchItems({ keyword }, ctx), 'invalid_dto');
  expectRedacted(error, [keyword, upstreamText]);
});

it('[AC-B1-04zc#64] 损坏游标：错误不带游标原文', async () => {
  const { adapter } = wire(() => listing([]));
  const error = await unionFailure(
    () => adapter.searchItems({ keyword, cursor: upstreamText }, ctx),
    'invalid_dto',
  );
  expectRedacted(error, [keyword, upstreamText]);
});

it('[AC-B1-04zc#65] PRICE_ANOMALY 与 PRICE_CALC_DIFF 不带标题、券链接、关键词', async () => {
  const rows = [
    withPrice(num('39.905')),
    row({ priceInfo: basePrice({ lowestCouponPrice: num('29.91') }) }),
  ];
  const { adapter, warn } = wire(() => listing(rows));
  const page = await adapter.searchItems({ keyword }, ctx);
  expect(page.items).toHaveLength(1);
  expect(warnings(warn, 'PRICE_ANOMALY')).toHaveLength(1);
  expect(warnings(warn, 'PRICE_CALC_DIFF')).toHaveLength(1);
  expectNoMarkers(warn.mock.calls, [title, couponLink, keyword]);
});
