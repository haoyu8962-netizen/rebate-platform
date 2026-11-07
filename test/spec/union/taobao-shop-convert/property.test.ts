import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  callShop,
  converted,
  envelope,
  expectQuietError,
  identity,
  RELATION_ID,
  response,
  SELF_SLOT,
  setup,
  SHOP_LINK,
  shopData,
  shopReq,
  shopRequest,
  unionFailure,
} from './kit.ts';

// 任意合格店铺（正整数十进制串，含超出安全整数的；非空白店名，含 URL 特殊字符与中文）与任意淘宝联盟
// 链接：上送 sellerId / shopName 原样、pid / relationId 取身份，结果 url 就是 shopLinks 原样。
// 任意非淘宝主机或非 https 的 shopLinks：upstream_unavailable，错误不带链接原文。

const shopRefs = fc.bigInt({ min: 1n, max: 10n ** 30n }).map((n) => String(n));
const nameChars = fc.constantFrom(
  'a',
  'Z',
  '0',
  '9',
  '店',
  '铺',
  '旗',
  '舰',
  '&',
  '=',
  '+',
  '%',
  '#',
  '?',
  '/',
  '-',
  '_',
  ' ',
);
const shopNames = fc
  .array(nameChars, { minLength: 1, maxLength: 24 })
  .map((chars) => chars.join(''))
  .filter((name) => name.trim() !== '' && name.trim() === name);
const linkTails = fc
  .array(fc.constantFrom('a', 'b', 'Z', '0', '7', '-', '_'), { minLength: 1, maxLength: 16 })
  .map((chars) => chars.join(''));
const goodLinks = linkTails.map((tail) => `https://s.click.taobao.com/t?e=synthetic-${tail}`);

it('[AC-B1-04zzt#40] 任意合格 shopRef / shopName 与淘宝联盟链接：sellerId、shopName 原样上送，pid / relationId 取身份，url = shopLinks 原样', async () => {
  await expect(
    fc.assert(
      fc.asyncProperty(shopRefs, shopNames, goodLinks, async (shopRef, shopName, link) => {
        const h = setup({ reply: response(envelope(shopData({ shopLinks: link }))) });
        const result = await converted(() => callShop(h.adapter, { shopRef, shopName }, identity));
        expect(result.url).toBe(link);
        const { fields } = shopRequest(h);
        expect(fields.sellerId).toBe(shopRef);
        expect(fields.shopName).toBe(shopName);
        expect(fields.pid).toBe(SELF_SLOT);
        expect(fields.relationId).toBe(RELATION_ID);
        return true;
      }),
      propParams(),
    ),
  ).resolves.toBeUndefined();
}, 900_000);

const foreignHosts = fc
  .array(fc.constantFrom('a', 'b', 'c', 'x', '1', '-'), { minLength: 1, maxLength: 12 })
  .map((chars) => `h${chars.join('')}.shop-foreign.invalid`);
const badLinks = fc.oneof(
  fc.tuple(foreignHosts, linkTails).map(([host, tail]) => `https://${host}/t?e=synthetic-${tail}`),
  fc
    .tuple(foreignHosts, linkTails)
    .map(([host, tail]) => `https://s.click.taobao.com.${host}/t?e=synthetic-${tail}`),
  linkTails.map((tail) => `http://s.click.taobao.com/t?e=synthetic-${tail}`),
  linkTails.map((tail) => `//s.click.taobao.com/t?e=synthetic-${tail}`),
);

it('[AC-B1-04zzt#41] 任意非淘宝联盟主机或非 https 的 shopLinks → upstream_unavailable、错误不带链接原文；合格链接照常成功', async () => {
  await expect(
    fc.assert(
      fc.asyncProperty(badLinks, async (link) => {
        const h = setup({ reply: response(envelope(shopData({ shopLinks: link }))) });
        const error = await unionFailure(() => callShop(h.adapter), 'upstream_unavailable');
        expectQuietError(error, link);
        expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
        return true;
      }),
      propParams(),
    ),
  ).resolves.toBeUndefined();

  const h = setup();
  const result = await converted(() => callShop(h.adapter, shopReq, identity));
  expect(result.url).toBe(SHOP_LINK);
}, 900_000);
