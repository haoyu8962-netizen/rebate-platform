import { expect, it } from 'vitest';
import { createParsing, parseUrl } from '../../../../apps/api/src/modules/parsing/index.ts';
import { CTX, fixture, item, observed, TABLE, URL_B, URL_C } from '../../parsing/core/kit.ts';
import { ctx, detailRow, detailSetup, ref as detailRef } from '../taobao-goods/kit.ts';

it('[AC-B1-04zzzzk#6] 淘宝详情只将数字 user_type 1 和 0 映射为天猫和淘宝', async () => {
  const cases = [
    [1, 'tmall'],
    [0, 'taobao'],
    [undefined, null],
    [2, null],
    ['1', null],
  ] as const;

  for (const [userType, shopType] of cases) {
    const { adapter } = detailSetup([detailRow({ basic: { user_type: userType } })]);
    const detail = await adapter.getItem(detailRef, ctx);
    expect(
      'shop_type' in detail ? detail.shop_type : null,
      `user_type=${JSON.stringify(userType)}`,
    ).toBe(shopType);
  }
});

const TMALL_URL = 'https://detail.tmall.com/item.htm?id=123456789';
const linkPatterns: typeof TABLE = {
  ...TABLE,
  rules: [
    ...TABLE.rules,
    {
      platform: 'taobao',
      category: 'product',
      hosts: ['detail.tmall.com'],
      path_patterns: ['/item.htm'],
    },
  ],
};
const parsingCases = [
  [TMALL_URL, 'taobao', 'tmall'],
  [TMALL_URL, 'taobao', 'taobao'],
  [TMALL_URL, 'taobao', null],
  [URL_B, 'jd', null],
  [URL_C, 'pdd', null],
] as const;

function parsingFixture(shopType: 'tmall' | 'taobao' | null) {
  const f = fixture();
  f.refs.set(TMALL_URL, { platform: 'taobao', item_id: 'synthetic-tmall-item' });
  f.getItem.mockImplementationOnce(async (ref) => {
    const detail = item(ref);
    return shopType === null ? detail : { ...detail, shop_type: shopType };
  });
  return { ...f, options: { ...f.options, linkPatterns } };
}

it('[AC-B1-04zzzzk#7] parseUrl 返回的 ProductRef 使用详情给出的店铺类型，缺省时为 null', async () => {
  for (const [url, platform, shopType] of parsingCases) {
    const f = parsingFixture(shopType);
    const result = await observed(() => parseUrl(f.options, url, CTX));

    expect(result, url).toMatchObject({
      outcome: 'returned',
      value: { ref: { platform, shopType } },
    });
  }
});

it('[AC-B1-04zzzzk#8] parseInput 登记卡片时传入详情给出的店铺类型，缺省时为 null', async () => {
  for (const [url, platform, shopType] of parsingCases) {
    const f = parsingFixture(shopType);
    const result = await createParsing(f.options).parseInput(url, CTX);

    expect(result, url).toMatchObject([{ kind: 'card' }]);
    expect(f.register, url).toHaveBeenCalledWith(
      expect.objectContaining({ ref: expect.objectContaining({ platform, shopType }) }),
    );
  }
});
