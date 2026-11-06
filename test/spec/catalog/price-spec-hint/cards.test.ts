// B1-05zh (S-19, D10-713, BR-PROD-04): every card built by catalog's card path carries the same
// price_spec_hint decision — search, home feed / product pool, hot rank, favorites, detail,
// inputs/parse and share all assemble through createCardAssembler (via createCatalogCardEntry), so
// the decision is pinned there. jd in sku mode → null; taobao, pdd, jd item mode → spec_uncertain;
// pool fallback, stale cache and open re-check cards keep that decision (no null from the source).
// See kit.ts for how the JD mode shows in the card's own identity.
import { expect, it } from 'vitest';
import {
  EXPECTED,
  SHAPES,
  assembler,
  cardEntry,
  expectHint,
  itemOf,
  noRebateQuote,
  refOf,
  requestOf,
} from './kit.ts';

for (const shape of SHAPES) {
  const expected = EXPECTED[shape];

  it(`[AC-B1-05zh#9][BR-PROD-04] ${shape} 搜索卡 price_spec_hint = ${String(expected)}，预备卡与登记后的卡相同`, async () => {
    const f = assembler();
    const prepared = await f.service.prepare(requestOf(shape));
    expectHint(prepared.card, expected);
    const card = await prepared.commit();
    expectHint(card, expected);
    expect(card.link_id).toBe('spec-hint-link');
    expectHint(await f.service.assemble(requestOf(shape)), expected);
  });

  it.each([
    { scene: '商品池回退（pool，stale）', entrySource: 'pool', source: 'pool', stale: true },
    { scene: '首页物料（feed，池行）', entrySource: 'feed', source: 'pool', stale: false },
    { scene: '缓存降级（search，stale）', entrySource: 'search', source: 'search', stale: true },
    { scene: '热销榜（rank）', entrySource: 'rank', source: 'search', stale: false },
    { scene: '粘贴识别（parse）', entrySource: 'parse', source: 'parse', stale: false },
    { scene: '详情（detail）', entrySource: 'detail', source: 'detail', stale: false },
    { scene: '淘礼金池（tlj_pool）', entrySource: 'tlj_pool', source: 'pool', stale: false },
    { scene: 'Agent 检索（agent）', entrySource: 'agent', source: 'search', stale: false },
  ] as const)(
    `[AC-B1-05zh#10][BR-PROD-04] ${shape} $scene：数据来源与 stale 不改变判定（${String(expected)}）`,
    async ({ entrySource, source, stale }) => {
      const f = assembler();
      const card = await f.service.assemble(
        requestOf(shape, { entrySource, stale, ref: refOf(shape, { source }) }),
      );
      expect(card.stale).toBe(stale);
      expectHint(card, expected);
    },
  );

  it(`[AC-B1-05zh#11][BR-PROD-04] ${shape} 带来源链接的详情 / 复核卡（sourceLinkId）同一判定`, async () => {
    const f = assembler();
    f.entrySource.mockResolvedValue('pool');
    const card = await f.service.assemble(
      requestOf(shape, { entrySource: null, sourceLinkId: 'spec-hint-source-link', stale: true }),
    );
    expect(f.entrySource).toHaveBeenCalledTimes(1);
    expectHint(card, expected);
  });

  it(`[AC-B1-05zh#12][BR-PROD-04] ${shape} 标题、券、价格不参与判定（无券、标题写明规格与「起」也一样）`, async () => {
    const f = assembler();
    const card = await f.service.assemble(
      requestOf(shape, {
        item: itemOf(shape, {
          title: '伊利纯牛奶 250ml*24 盒 最低规格价 ¥45 起',
          price_fen: 4500n,
          coupon_fen: 0n,
          final_price_fen: 4500n,
        }),
        ref: refOf(shape, { title: '伊利纯牛奶 250ml*24 盒 最低规格价 ¥45 起' }),
      }),
    );
    expectHint(card, expected);
  });

  it(`[AC-B1-05zh#13][BR-PROD-04] ${shape} 无返利卡（no_rebate）照样带同一判定`, async () => {
    const f = assembler();
    f.quote.mockResolvedValue(noRebateQuote());
    const card = await f.service.assemble(requestOf(shape));
    expect(card.rebate_basis).toBe('no_rebate');
    expectHint(card, expected);
  });

  it(`[AC-B1-05zh#14][BR-PROD-04] ${shape} 经 catalog 统一出卡入口：检索（延后登记）与主动查询同一判定`, async () => {
    const f = cardEntry();
    const retrieval = await f.entry.assemble({
      ...requestOf(shape, { entrySource: 'search' }),
      scene: 'retrieval',
      deferLink: true,
    });
    expect(retrieval.kind).toBe('prepared');
    if (retrieval.kind !== 'prepared') return;
    expectHint(retrieval.card, expected);
    expectHint(await retrieval.commit(), expected);

    const active = await f.entry.assemble({
      ...requestOf(shape, { entrySource: 'parse', ref: refOf(shape, { source: 'parse' }) }),
      scene: 'active_query',
    });
    expect(active.kind).toBe('card');
    if (active.kind !== 'card') return;
    expectHint(active.card, expected);
  });
}

it('[AC-B1-05zh#15][BR-PROD-04] 同一京东联盟条目（同带 itemId 与 skuId）：按卡片自身 product_key 的派生模式判定，不按条目字段猜', async () => {
  const f = assembler();
  const item = itemOf('jd_sku');
  expect(itemOf('jd_item')).toEqual(item);
  const skuCard = await f.service.assemble(requestOf('jd_sku', { item }));
  const itemCard = await f.service.assemble(requestOf('jd_item', { item }));
  expect(skuCard.product_key).toBe(refOf('jd_sku').productKey);
  expect(itemCard.product_key).toBe(refOf('jd_item').productKey);
  expectHint(skuCard, null);
  expectHint(itemCard, 'spec_uncertain');
});

it('[AC-B1-05zh#16][BR-PROD-04] 同一出卡器交替出不同形态的卡，每张各自判定，不沿用上一张', async () => {
  const f = assembler();
  const hints: unknown[] = [];
  for (const shape of ['jd_sku', 'taobao', 'jd_sku', 'jd_item', 'pdd', 'jd_sku'] as const) {
    const card = await f.service.assemble(requestOf(shape));
    expect(card).toHaveProperty('price_spec_hint');
    hints.push((card as unknown as Record<string, unknown>)['price_spec_hint']);
  }
  expect(hints).toEqual([null, 'spec_uncertain', null, 'spec_uncertain', 'spec_uncertain', null]);
});
