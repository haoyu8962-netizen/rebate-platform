import { expect, it } from 'vitest';
import { candidate, card } from '../tools-search/kit.ts';
import { allPlatforms, copy, done, kit, searched, searchArgs } from './kit.ts';

// Independent literal fen expectations from BR-AI-08; no production parser as oracle.
it.each([
  [60, '耳机 50以内', undefined, 5000],
  [61, '耳机 50元以下', undefined, 5000],
  [62, '耳机 不超过50块', undefined, 5000],
  [63, '耳机 最多50', undefined, 5000],
  [64, '耳机 低于40', undefined, 3999],
  [65, '耳机 少于40元', undefined, 3999],
  [66, '耳机 不到40块', undefined, 3999],
  [67, '耳机 50以上', 5000, undefined],
  [68, '耳机 至少50元', 5000, undefined],
  [69, '耳机 高于50块', 5001, undefined],
  [70, '耳机 超过50', 5001, undefined],
  [71, '耳机 30到50', 3000, 5000],
  [72, '耳机 30-50元', 3000, 5000],
  [73, '耳机 30至50之间', 3000, 5000],
  [74, '耳机 9.9左右', 891, 1089],
  [75, '耳机 9.99元左右', 899, 1099],
] as const)('[AC-B3-05n#%i] %s 转整数分并传递到检索端口', async (_id, question, min, max) => {
  const h = kit();
  const out = await h.run(question);
  done(out, 'fallback');
  const args = searchArgs(h);
  expect(args).toMatchObject({ q: '耳机', platforms: allPlatforms, sort: 'relevance' });
  expect(args['price_min_fen']).toBe(min);
  expect(args['price_max_fen']).toBe(max);
  expect(args['spec']).toBeUndefined();
  expect(h.search.searchProducts).toHaveBeenCalledTimes(3);
  for (const [query] of h.search.searchProducts.mock.calls) {
    expect(query.q).toBe('耳机');
    expect(query.price_min_fen).toBe(min);
    expect(query.price_max_fen).toBe(max);
  }
  expect(out.events.some((e) => e.kind === 'suggestions')).toBe(false);
});

it.each([
  [76, '纸巾 超过15天'],
  [77, '纸巾 不到3单'],
  [78, '牛奶 500ml 24盒'],
] as const)('[AC-B3-05n#%i] %s 不是价格条件，不拆规格', async (_id, question) => {
  const h = kit();
  const out = await h.run(question);
  done(out, 'fallback');
  const args = searchArgs(h);
  expect(args['price_min_fen']).toBeUndefined();
  expect(args['price_max_fen']).toBeUndefined();
  expect(args['spec']).toBeUndefined();
  expect(args['q']).toBe(question);
});

it.each([
  [79, '返利最高', 'rebate_desc'],
  [80, '返得最多', 'rebate_desc'],
  [81, '佣金最高', 'rebate_desc'],
  [82, '最便宜', 'final_price_asc'],
  [83, '价格最低', 'final_price_asc'],
  [84, '销量最高', 'sales_desc'],
  [85, '卖得最多', 'sales_desc'],
] as const)('[AC-B3-05n#%i] 明确说法 %s → %s', async (_id, phrase, sort) => {
  const h = kit();
  const out = await h.run(`纸巾哪个${phrase}`);
  searched(h, out, '纸巾');
  expect(searchArgs(h)['sort']).toBe(sort);
  for (const [query] of h.search.searchProducts.mock.calls) {
    expect(query.sort).toBe(sort === 'sales_desc' ? 'sales_desc' : 'relevance');
  }
});

it('[AC-B3-05n#86] 最划算不是返利最高，仍 relevance', async () => {
  const h = kit();
  const out = await h.run('纸巾哪个最划算');
  done(out, 'fallback');
  expect(searchArgs(h)['sort']).toBe('relevance');
  expect(h.search.searchProducts).toHaveBeenCalledTimes(3);
});

it('[AC-B3-05n#87] 不要 X 进 exclude_keywords，结果层确实排除且不拆规格', async () => {
  const h = kit();
  const wanted = candidate('jd:wanted', 1000, 'jd');
  const excludedBase = candidate('jd:excluded', 1000, 'jd');
  const excluded = { ...excludedBase, item: { ...excludedBase.item, title: '合成香味纸巾' } };
  h.rows.splice(0, h.rows.length, wanted, excluded);
  const out = await h.run('京东纸巾 不要香味');
  searched(h, out, '纸巾', ['jd']);
  expect(searchArgs(h)).toMatchObject({ exclude_keywords: ['香味'] });
  const list = out.cards.find((c) => c.type === 'product_list');
  expect(list?.data['items']).toEqual([expect.objectContaining({ product_key: 'jd:wanted' })]);
});

it.each([
  [88, '伞'],
  [89, '茶'],
  [90, '帮我找蓝牙耳机'],
  [91, '有没有蓝牙耳机'],
  [92, '想买蓝牙耳机'],
  [93, '推荐蓝牙耳机'],
] as const)('[AC-B3-05n#%i] 口头语移除，剩下单字也搜索：%s', async (_id, question) => {
  const h = kit();
  searched(
    h,
    await h.run(question),
    question === '伞' || question === '茶' ? question : '蓝牙耳机',
  );
});

it('[AC-B3-05n#94] 先清理词再截取前30个 Unicode 字符', async () => {
  const h = kit();
  const term = '𠮷'.repeat(29) + '茶伞';
  searched(h, await h.run(`，帮我找 京东 ${term} 50元以内！？`), '𠮷'.repeat(29) + '茶', ['jd']);
  expect(searchArgs(h)['price_max_fen']).toBe(5000);
});

it('[AC-B3-05n#95] 上游忽略条件也按到手价闭区间筛选，不按原价筛', async () => {
  const h = kit();
  h.rows.splice(
    0,
    h.rows.length,
    candidate('jd:below', 2999, 'jd'),
    candidate('jd:min', 3000, 'jd', { price_fen: 8000n, coupon_fen: 5000n }),
    candidate('jd:max', 5000, 'jd'),
    candidate('jd:above', 5001, 'jd'),
  );
  const out = await h.run('京东耳机30到50元');
  done(out, 'fallback');
  expect(out.cards.find((c) => c.type === 'product_list')?.data['items']).toEqual([
    expect.objectContaining({ product_key: 'jd:min', final_price_fen: 3000 }),
    expect.objectContaining({ product_key: 'jd:max', final_price_fen: 5000 }),
  ]);
  expect(h.search.searchProducts).toHaveBeenCalledTimes(1);
});

it('[AC-B3-05n#96] rebate_desc 的条件到达服务端排序，非仅改枚举', async () => {
  const h = kit();
  const low = candidate('jd:low', 1000, 'jd');
  const high = candidate('jd:high', 2000, 'jd');
  h.rows.splice(0, h.rows.length, low, high);
  h.search.quotes.set('jd:low', card(low, { rebate_min_fen: 100, rebate_max_fen: 100 }));
  h.search.quotes.set('jd:high', card(high, { rebate_min_fen: 500, rebate_max_fen: 600 }));
  const out = await h.run('京东纸巾哪个返利最高');
  done(out, 'fallback');
  expect(out.cards.find((c) => c.type === 'product_list')?.data['items']).toEqual([
    expect.objectContaining({ product_key: 'jd:high' }),
    expect.objectContaining({ product_key: 'jd:low' }),
  ]);
});

it('[AC-B3-05n#97] 无结果不放宽价格、不追问，仍用 degraded.empty', async () => {
  const h = kit();
  h.search.searchProducts.mockResolvedValue([]);
  const out = await h.run('京东耳机30元以内');
  done(out, 'fallback');
  expect(h.search.searchProducts).toHaveBeenCalledTimes(1);
  expect(searchArgs(h)).toMatchObject({ q: '耳机', price_max_fen: 3000 });
  expect(out.cards.map((c) => c.data['text_key'])).toEqual(['agent.degraded.empty']);
  expect(out.cards[0]?.fallback_text).toBe(copy('agent.degraded.empty'));
  expect(out.events.some((e) => e.kind === 'suggestions')).toBe(false);
});

it('[AC-B3-05n#98] 默认平台只含已开启的平台', async () => {
  const h = kit();
  h.settings.set('search.enabled.pdd', false);
  searched(h, await h.run('纸巾'), '纸巾', ['taobao', 'jd']);
  expect(searchArgs(h)['platforms']).toEqual(['taobao', 'jd']);
});
