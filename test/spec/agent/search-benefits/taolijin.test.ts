import { expect, it } from 'vitest';
import { candidate, fixture, keys } from '../tools-search/kit.ts';

it.each([
  { label: '未限定平台', platforms: undefined, extra: false },
  { label: '仅淘宝', platforms: ['taobao'], extra: false },
  { label: '仅京东', platforms: ['jd'], extra: true },
  { label: '仅拼多多', platforms: ['pdd'], extra: true },
  { label: '两个非淘宝平台', platforms: ['jd', 'pdd'], extra: true },
  { label: '淘宝混合京东', platforms: ['taobao', 'jd'], extra: true },
])(
  '[AC-B3-04k#4] 首版淘礼金关闭：$label，只返回对应 notice，联盟端口零调用',
  async ({ platforms, extra }) => {
    // 联盟本来有有券商品，也不能用它替代淘礼金卡。
    const h = fixture([
      candidate('coupon', 1000, 'taobao', { price_fen: 1100n, coupon_fen: 100n }),
    ]);
    h.settings.set('tlj.enabled', false);
    const args = {
      q: '牛奶',
      benefits: ['taolijin'],
      ...(platforms === undefined ? {} : { platforms }),
    };
    const outcome = await h.run(args);
    expect(h.searchProducts).not.toHaveBeenCalled();
    expect(h.assemble).not.toHaveBeenCalled();
    expect(h.registered).toEqual([]);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    const expected = extra
      ? ['agent.notice.tlj_none', 'agent.notice.tlj_taobao_only']
      : ['agent.notice.tlj_none'];
    expect(outcome.cards).toHaveLength(expected.length);
    expect(outcome.cards.every((card) => card.type === 'notice')).toBe(true);
    expect(
      outcome.cards.map((card) => (card.data as { text_key: string }).text_key).toSorted(),
    ).toEqual(expected.toSorted());
    expect(keys(outcome)).toEqual([]);
    expect((outcome.modelView as { items?: unknown[] }).items ?? []).toEqual([]);
    expect(args.platforms).toEqual(platforms);
  },
);

it.each([
  { label: '显式关闭', configured: true },
  { label: '缺配置使用关闭默认值', configured: false },
])('[AC-B3-04k#5] $label，coupon 与 taolijin 同时请求仍不出替代有券卡', async ({ configured }) => {
  const h = fixture([candidate('coupon', 1000, 'taobao', { price_fen: 1100n, coupon_fen: 100n })]);
  if (configured) h.settings.set('tlj.enabled', false);
  const outcome = await h.run({
    q: '牛奶',
    benefits: ['coupon', 'taolijin'],
    platforms: ['taobao'],
  });
  expect(h.searchProducts).not.toHaveBeenCalled();
  expect(outcome).toMatchObject({
    kind: 'ok',
    cards: [{ type: 'notice', data: { text_key: 'agent.notice.tlj_none' } }],
  });
  if (outcome.kind !== 'ok') return;
  expect(outcome.cards).toHaveLength(1);
  expect(h.registered).toEqual([]);
  // 开关关闭只阻止淘礼金检索，不应阻止下一次普通有券检索。
  expect(keys(await h.run({ q: '牛奶', benefits: ['coupon'], platforms: ['taobao'] }))).toEqual([
    'coupon',
  ]);
  expect(h.searchProducts).toHaveBeenCalledTimes(1);
});
