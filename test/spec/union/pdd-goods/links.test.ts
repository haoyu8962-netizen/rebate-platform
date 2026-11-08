import { expect, it } from 'vitest';
import {
  ctx,
  envelope,
  identity,
  longLink,
  ref,
  row,
  search,
  setup,
  shortLink,
  shortParse,
} from './kit.ts';

it.each([longLink, shortLink])(
  '[AC-B1-04u-LINK#1] 商品链接 / 进宝短链 %s 经 goods.search keyword 得到真实响应身份',
  async (link) => {
    const { adapter, requests, transport } = setup((body) => {
      if (body.type === shortParse) return { url: { url: longLink } };
      expect(body.type).toBe(search);
      expect([link, longLink]).toContain(body.keyword);
      // 响应 ID 与输入链接里的数字故意不同，不能从 URL 猜出 DTO。
      return envelope(search, [
        row({ goods_id: 7234567890123, goods_sign: 'resolved-synthetic-sign' }),
      ]);
    });
    const controller = new AbortController();
    const resolved = await adapter.resolveLink(link, { ...ctx, signal: controller.signal });
    expect(resolved.item).toMatchObject({
      platform: 'pdd',
      goods_id: '7234567890123',
      goods_sign: 'resolved-synthetic-sign',
    });
    expect(requests.some((body) => body.type === search)).toBe(true);
    for (const request of requests) {
      expect(request).toMatchObject({
        pid: identity.pid,
        custom_parameters: identity.customParameters,
      });
    }
    for (const [request] of transport.mock.calls) expect(request.signal).toBe(controller.signal);
  },
);

it('[AC-B1-04u-LINK#2] 短链直接搜索无结果时可用 url.short.parse 的 url.url 再识别', async () => {
  const { adapter, requests } = setup((body) => {
    if (body.type === shortParse) {
      expect(Object.values(body)).toContain(shortLink);
      return { url: { url: longLink } };
    }
    expect(body.type).toBe(search);
    expect([shortLink, longLink]).toContain(body.keyword);
    return envelope(search, body.keyword === longLink ? [row()] : []);
  });
  expect((await adapter.resolveLink(shortLink, ctx)).item).toMatchObject(ref);
  expect(requests.filter((body) => body.type === shortParse)).toHaveLength(1);
  expect(requests.some((body) => body.type === search && body.keyword === longLink)).toBe(true);
  expect(requests.length).toBeLessThanOrEqual(3);
});

it('[AC-B1-04u-LINK#3] 搜索与短链展开均识别不到商品时 link_unrecognized', async () => {
  let count = 0;
  const { adapter } = setup((body) => {
    count += 1;
    expect(count).toBeLessThanOrEqual(3);
    return body.type === shortParse ? { url: { url: longLink } } : envelope(body.type, []);
  });
  await expect(adapter.resolveLink(shortLink, ctx)).rejects.toMatchObject({
    code: 'link_unrecognized',
    platform: 'pdd',
  });
  expect(count).toBeGreaterThan(0);
});

it('[AC-B1-04u-LINK#4] 短链展开回自身不能无限循环', async () => {
  let count = 0;
  const { adapter } = setup((body) => {
    count += 1;
    expect(count).toBeLessThanOrEqual(3);
    return body.type === shortParse ? { url: { url: shortLink } } : envelope(body.type, []);
  });
  await expect(adapter.resolveLink(shortLink, ctx)).rejects.toMatchObject({
    code: 'link_unrecognized',
    platform: 'pdd',
  });
});

it.each([undefined, '', 123])(
  '[AC-B1-04u-LINK#5] 链接识别缺少有效 goods_sign (%s) 时不能仅用 URL 商品号成功',
  async (goodsSign) => {
    const { adapter } = setup((body) => envelope(body.type, [row({ goods_sign: goodsSign })]));
    await expect(adapter.resolveLink(longLink, ctx)).rejects.toMatchObject({
      platform: 'pdd',
      code: expect.stringMatching(/^(invalid_dto|link_unrecognized)$/),
    });
  },
);

it.each([
  [52101, 'rate_limited'],
  [52102, 'upstream_unavailable'],
] as const)(
  '[AC-B1-04u-LINK#6] 网关错误 %i 保留 %s，不吞成识别失败或调用转链',
  async (errorCode, code) => {
    const { adapter, requests } = setup(() => ({ error_response: { error_code: errorCode } }));
    await expect(adapter.resolveLink(longLink, ctx)).rejects.toMatchObject({
      code,
      platform: 'pdd',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.type).toBe(search);
  },
);

it('[AC-B1-04u-LINK#7] 非安全整数响应 goods_id 不能从链接数字补回', async () => {
  const { adapter } = setup((body) => envelope(body.type, [row({ goods_id: 9007199254740992 })]));
  await expect(adapter.resolveLink(longLink, ctx)).rejects.toMatchObject({
    code: 'invalid_dto',
    platform: 'pdd',
  });
});

it('[AC-B1-04u-LINK#8] 短链展开为空且搜索无结果时 link_unrecognized', async () => {
  let count = 0;
  const { adapter } = setup((body) => {
    count += 1;
    expect(count).toBeLessThanOrEqual(3);
    return body.type === shortParse ? { url: { url: '' } } : envelope(body.type, []);
  });
  await expect(adapter.resolveLink(shortLink, ctx)).rejects.toMatchObject({
    code: 'link_unrecognized',
    platform: 'pdd',
  });
});
