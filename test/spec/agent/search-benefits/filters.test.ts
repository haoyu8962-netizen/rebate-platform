import { expect, it } from 'vitest';
import type { AgentSearchCandidate } from '../../../../apps/api/src/modules/agent/tools/search/index.ts';
import { candidate, card, fixture, items, keys } from '../tools-search/kit.ts';

function titled(row: AgentSearchCandidate, title: string): AgentSearchCandidate {
  return { ...row, item: { ...row.item, title }, ref: { ...row.ref, title } };
}

it('[AC-B3-04k#6] coupon 在各平台服务端重筛，1分券可留、0分券去掉，matched 只用于符合条件的卡', async () => {
  const rows = [
    candidate('tb-coupon', 1000, 'taobao', { price_fen: 1001n, coupon_fen: 1n }),
    candidate('tb-zero', 1000, 'taobao'),
    candidate('jd-coupon', 1000, 'jd', { price_fen: 1100n, coupon_fen: 100n }),
    candidate('jd-zero', 1000, 'jd'),
    candidate('pdd-coupon', 1000, 'pdd', { price_fen: 1100n, coupon_fen: 100n }),
    candidate('pdd-zero', 1000, 'pdd'),
  ];
  const h = fixture(rows);
  const outcome = await h.run({ q: '牛奶', benefits: ['coupon'] });
  expect(keys(outcome).toSorted()).toEqual(['jd-coupon', 'pdd-coupon', 'tb-coupon']);
  expect(items(outcome).map((item) => item.match_tag)).toEqual(['matched', 'matched', 'matched']);
  expect(h.searchProducts).toHaveBeenCalledTimes(3);
  expect(h.registered.toSorted()).toEqual(['jd-coupon', 'pdd-coupon', 'tb-coupon']);
  expect((outcome.modelView as { items: unknown[] }).items).toHaveLength(3);
  // 本假端口忽略权益条件并返回所有候选；省略或空数组应恢复普通搜索。
  for (const args of [{ q: '牛奶' }, { q: '牛奶', benefits: [] }]) {
    expect(keys(await h.run(args)).toSorted()).toEqual(
      rows.map((row) => row.ref.productKey).toSorted(),
    );
  }
});

it('[AC-B3-04k#7] coupon 以最终卡片 coupon_fen 为准，不凭标题或标签猜测有券', async () => {
  const rows = [candidate('zero'), candidate('one')];
  const h = fixture(rows);
  h.quotes.set(
    'zero',
    card(rows[0]!, { title: '有券特惠牛奶', benefit_tags: ['有券'], coupon_fen: 0 }),
  );
  h.quotes.set('one', card(rows[1]!, { price_fen: 1001, coupon_fen: 1, benefit_tags: [] }));
  expect(keys(await h.run({ q: '牛奶', benefits: ['coupon'] }))).toEqual(['one']);
  expect(h.registered).toEqual(['one']);
});

it('[AC-B3-04k#8] 权益过滤后为空是普通空结果，沿用编排无结果流程，不发淘礼金或禁售提示', async () => {
  const h = fixture([candidate('zero')]);
  const outcome = await h.run({ q: '牛奶', benefits: ['coupon'] });
  // search 工具交回空 items；放宽及最终 no_result notice 由既有编排负责。
  expect(outcome).toMatchObject({ kind: 'ok', modelView: { items: [] }, cards: [] });
  expect(h.searchProducts).toHaveBeenCalledTimes(3);
  expect(h.registered).toEqual([]);
  expect(keys(await h.run({ q: '牛奶' }))).toEqual(['zero']);
});

it('[AC-B3-04k#9] 逐步去掉 spec、价格上限后，权益、排除词和价格下限继续生效', async () => {
  const h = fixture([
    titled(candidate('valid', 1000, 'taobao', { price_fen: 1100n, coupon_fen: 100n }), '牛奶 24盒'),
    titled(candidate('high', 1001, 'taobao', { price_fen: 1101n, coupon_fen: 100n }), '牛奶 12盒'),
    candidate('zero', 1000),
    titled(
      candidate('excluded', 1000, 'taobao', { price_fen: 1100n, coupon_fen: 100n }),
      '赠品牛奶',
    ),
    candidate('low', 999, 'taobao', { price_fen: 1099n, coupon_fen: 100n }),
  ]);
  const base = {
    q: '牛奶',
    platforms: ['taobao'],
    benefits: ['coupon'],
    exclude_keywords: ['赠品'],
    price_min_fen: 1000,
  };
  // 模拟编排依次传来的三次参数；本任务只约束 search 路径，不重写编排规则。
  for (const step of [
    { args: { spec: '24盒', price_max_fen: 1000 }, expected: ['valid'] },
    { args: { price_max_fen: 1000 }, expected: ['valid'] },
    { args: {}, expected: ['valid', 'high'] },
  ]) {
    expect(keys(await h.run({ ...base, ...step.args }))).toEqual(step.expected);
  }
  expect(h.searchProducts).toHaveBeenCalledTimes(3);
  expect(h.searchProducts.mock.calls.every(([query]) => query.price_min_fen === 1000)).toBe(true);
  expect(h.registered).toEqual(['valid', 'valid', 'valid', 'high']);
});

it.each([
  { label: '仅品牌', extra: { brand: '合成品牌' }, expected: '合成品牌 牛奶' },
  { label: '仅品类', extra: { category_hint: '乳制品' }, expected: '牛奶 乳制品' },
  {
    label: '品牌和品类',
    extra: { brand: '合成品牌', category_hint: '乳制品' },
    expected: '合成品牌 牛奶 乳制品',
  },
])(
  '[AC-B3-04k#10] $label 按约定拼接端口关键词，不按品牌或品类剔除结果',
  async ({ extra, expected }) => {
    const h = fixture([titled(candidate('unrelated'), '另一个品牌的无关商品')]);
    const args = {
      q: '牛奶',
      ...extra,
      spec: '24盒',
      page: 3,
      limit: 4,
      sort: 'sales_desc',
      price_min_fen: 900,
      price_max_fen: 1100,
    };
    expect(keys(await h.run(args))).toEqual(['unrelated']);
    expect(h.searchProducts.mock.calls.map(([query]) => query.q)).toEqual([
      expected,
      expected,
      expected,
    ]);
    expect(h.searchProducts.mock.calls.map(([, , page]) => page)).toEqual([3, 3, 3]);
    expect(args.q).toBe('牛奶');
    h.searchProducts.mockClear();
    expect(keys(await h.run({ q: '牛奶' }))).toEqual(['unrelated']);
    expect(h.searchProducts.mock.calls.map(([query]) => query.q)).toEqual(['牛奶', '牛奶', '牛奶']);
  },
);

it.each([
  { label: '大小写', title: '牛奶 Gift 套装', word: 'gIfT' },
  { label: '标题全角', title: '牛奶 ＧＩＦＴ 套装', word: 'gift' },
  { label: '排除词全角', title: '牛奶 gift 套装', word: 'ＧｉＦｔ' },
  { label: 'NFKC 兼容字符', title: '牛奶 ① 套装', word: '1' },
  { label: '子串命中', title: '牛奶赠品套装', word: '赠品' },
])('[AC-B3-04k#11] 排除词按 NFKC 且不区分大小写做标题包含匹配：$label', async ({ title, word }) => {
  const h = fixture([titled(candidate('drop'), title), titled(candidate('keep'), '普通纯牛奶')]);
  expect(keys(await h.run({ q: '牛奶', exclude_keywords: ['未命中的词', word] }))).toEqual([
    'keep',
  ]);
  expect(h.registered).toEqual(['keep']);
  expect(keys(await h.run({ q: '牛奶', exclude_keywords: [] }))).toEqual(['drop', 'keep']);
  expect(keys(await h.run({ q: '牛奶' }))).toEqual(['drop', 'keep']);
});

it('[AC-B3-04k#12] 任一个排除词命中就剔除，多个平台均执行；排除后为空仍交回普通空结果', async () => {
  const h = fixture([
    titled(candidate('tb', 1000, 'taobao'), '牛奶赠品'),
    titled(candidate('jd', 1000, 'jd'), '奶粉样品'),
    titled(candidate('pdd', 1000, 'pdd'), '牛奶试用装'),
  ]);
  expect(await h.run({ q: '牛奶', exclude_keywords: ['赠品', '样品', '试用'] })).toMatchObject({
    kind: 'ok',
    modelView: { items: [] },
    cards: [],
  });
  expect(h.searchProducts).toHaveBeenCalledTimes(3);
  expect(h.registered).toEqual([]);
});
