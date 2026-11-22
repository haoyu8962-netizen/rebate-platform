import { expect, it } from 'vitest';
import { classifyParsingUrl } from '../../../../apps/api/src/modules/parsing/index.ts';
import { getLinkPatterns } from '../../../../apps/api/src/modules/platform/specs/link-patterns.ts';

it.each([
  ['https://pub.alimama.com/', 'taobao', 'union_host'],
  ['https://item.taobao.com/item.htm?id=43907626661', 'taobao', 'product'],
  ['https://detail.tmall.com/item.htm?id=561427522238', 'taobao', 'product'],
  ['https://s.click.taobao.com/Ys3TNlu', 'taobao', 'promo'],
  ['https://uland.taobao.com/coupon/edetail?e=x', 'taobao', 'promo'],
  ['https://uland.taobao.com/quan/detail?sellerId=1', 'taobao', 'promo'],
  ['https://uland.taobao.com/item/edetail?e=x', 'taobao', 'promo'],
  ['https://union.jd.com/account_son', 'jd', 'union_host'],
  ['https://item.jd.com/26898778009.html', 'jd', 'product'],
  ['https://union-click.jd.com/jdc?e=x', 'jd', 'promo'],
  ['https://jinbao.pinduoduo.com/', 'pdd', 'union_host'],
  ['https://mobile.yangkeduo.com/duo_coupon_landing.html', 'pdd', 'union_host'],
] as const)('[AC-B1-07d#1] 样例链接 %s 命中 %s 的 %s', (url, platform, category) => {
  expect(classifyParsingUrl(url, getLinkPatterns())).toEqual({ platform, category });
});

it.each([
  ['taobao.com', 'taobao'],
  ['tmall.com', 'taobao'],
  ['alimama.com', 'taobao'],
  ['jd.com', 'jd'],
  ['pinduoduo.com', 'pdd'],
  ['yangkeduo.com', 'pdd'],
] as const)('[AC-B1-07d#2] 注册域 %s 命中 %s 的联盟域名', (host, platform) => {
  expect(classifyParsingUrl(`https://${host}/`, getLinkPatterns())).toEqual({
    platform,
    category: 'union_host',
  });
});

it.each([
  ['https://item.taobao.com/other', 'taobao'],
  ['https://item.jd.com/a/b.html', 'jd'],
  ['https://union-click.jd.com/jdc/other', 'jd'],
] as const)('[AC-B1-07d#3] 路径不符时 %s 回落到 %s 的联盟域名', (url, platform) => {
  expect(classifyParsingUrl(url, getLinkPatterns())).toEqual({ platform, category: 'union_host' });
});

it.each([
  ['https://www.example.com/item.htm', 'https://item.taobao.com/item.htm', 'taobao', 'product'],
  [
    'https://taobao.com.evil.invalid/item.htm',
    'https://taobao.com/item.htm',
    'taobao',
    'union_host',
  ],
  ['https://eviltaobao.com/', 'https://taobao.com/', 'taobao', 'union_host'],
  ['https://jd.com.evil.invalid/', 'https://jd.com/', 'jd', 'union_host'],
  [
    'http://item.taobao.com/item.htm?id=1',
    'https://item.taobao.com/item.htm?id=1',
    'taobao',
    'product',
  ],
  ['https://user@item.jd.com/1.html', 'https://item.jd.com/1.html', 'jd', 'product'],
  ['https://item.jd.com@evil.invalid/1.html', 'https://item.jd.com/1.html', 'jd', 'product'],
] as const)('[AC-B1-07d#4] 拒绝 %s 且命中对照', (rejected, accepted, platform, category) => {
  const patterns = getLinkPatterns();
  expect({
    rejected: classifyParsingUrl(rejected, patterns),
    accepted: classifyParsingUrl(accepted, patterns),
  }).toEqual({ rejected: null, accepted: { platform, category } });
});

it('[AC-B1-07d#5] 首批规则发布时递增表版本', () => {
  expect(getLinkPatterns().version).not.toBe('0');
});

it.each(['taobao', 'jd', 'pdd'])('[AC-B1-07d#6] %s 有联盟域名规则', (platform) => {
  expect(getLinkPatterns().rules).toContainEqual(
    expect.objectContaining({ platform, category: 'union_host' }),
  );
});
