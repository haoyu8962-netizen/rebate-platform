// B1-05zc (D10-641): 下单前返利一律按接口佣金字段报单一金额。08 BR-PRICE-07（2026-11-05 改写）：不再按
// entry_source 判比价风险、不再用 rebate.taobao.compare_rate_ratio_bp 估下限，淘宝也不出区间；有返利时
// rebate_basis = normal、rebate_min_fen = rebate_max_fen，口径小字只用 rebate_estimate（BR-PRICE-17）；
// entry_source 照常登记。每条用真实 commission 报价器与演示报价器各跑一遍，配置都故意带比价系数 5000。
import { expect, it } from 'vitest';
import {
  SOURCE_LINK,
  viaAgent,
  viaDetail,
  viaFeed,
  viaParse,
  viaRank,
  viaSearch,
} from './entries.ts';
import {
  amountsOf,
  COMPARE_KEY,
  QUOTER_KINDS,
  quoterOf,
  readKeys,
  shown,
  SINGLE,
  SINGLE_AMOUNTS,
} from './kit.ts';
import { APP_ID } from '../detail/kit.ts';

it.each(QUOTER_KINDS)(
  '[AC-B1-05zc#1] BR-PRICE-07：同一淘宝商品经搜索、粘贴、首页池、详情四个入口报价相同且为单值（%s 报价器）',
  async (kind) => {
    const q = quoterOf(kind);
    const search = await viaSearch(q);
    const parse = await viaParse(q);
    const feed = await viaFeed(q);
    const detail = await viaDetail(q);
    expect({
      search: search.cards.map(shown),
      parse: parse.cards.map(shown),
      feed: feed.cards.map(shown),
      detail: detail.cards.map(shown),
    }).toEqual({ search: [SINGLE], parse: [SINGLE], feed: [SINGLE], detail: [SINGLE] });
    // Every entry asked for the normal basis; the compare ratio was never read.
    expect(q.contexts.map((context) => context?.rebateBasis)).toEqual([
      'normal',
      'normal',
      'normal',
      'normal',
    ]);
    expect(readKeys(q.config)).not.toContain(COMPARE_KEY);
    // entry_source is still registered per entry (link reuse and statistics only).
    expect({
      search: search.entrySources,
      parse: parse.entrySources,
      feed: feed.entrySources,
      detail: detail.entrySources,
    }).toEqual({ search: ['search'], parse: ['parse'], feed: ['feed'], detail: ['detail'] });
  },
);

it.each(QUOTER_KINDS)(
  '[AC-B1-05zc#2] BR-PRICE-07：热销榜卡与四个入口同额单值，小字 rebate_estimate，entry_source 记 rank（%s 报价器）',
  async (kind) => {
    const q = quoterOf(kind);
    const rank = await viaRank(q);
    expect(rank.cards.map(shown)).toEqual([SINGLE]);
    expect(q.contexts.map((context) => context?.rebateBasis)).toEqual(['normal']);
    expect(readKeys(q.config)).not.toContain(COMPARE_KEY);
    expect(rank.entrySources).toEqual(['rank']);
  },
);

it.each(QUOTER_KINDS)(
  '[AC-B1-05zc#3] BR-PRICE-07 / BR-AI-04：Agent 报价卡淘宝商品按接口金额单值，不出区间、不下发 rebate_compare（%s 报价器）',
  async (kind) => {
    const q = quoterOf(kind);
    const agent = await viaAgent(q);
    expect(amountsOf(agent.product)).toEqual(SINGLE_AMOUNTS);
    expect(agent.product['disclaimer_keys']).toEqual(expect.arrayContaining(['rebate_estimate']));
    expect(agent.product['disclaimer_keys']).not.toContain('rebate_compare');
    expect(q.contexts.map((context) => context?.rebateBasis)).toEqual(['normal']);
    expect(readKeys(q.config)).not.toContain(COMPARE_KEY);
    expect(agent.entrySources).toEqual(['agent']);
  },
);

it.each(QUOTER_KINDS)(
  '[AC-B1-05zc#4] BR-PRICE-07：带 from_link_id 的详情无论来源卡是什么都按单值报价，来源照常继承登记（%s 报价器）',
  async (kind) => {
    for (const source of ['search', 'parse', 'agent', 'agent_refresh', 'feed', 'watch', null]) {
      const q = quoterOf(kind);
      const detail = await viaDetail(q, { source });
      expect(detail.cards.map(shown), `来源 ${String(source)}`).toEqual([SINGLE]);
      expect(detail.sourceReads).toEqual([[APP_ID, SOURCE_LINK]]);
      expect(detail.entrySources).toEqual([source]);
      expect(q.contexts).toEqual([
        expect.objectContaining({ entrySource: source, rebateBasis: 'normal' }),
      ]);
      expect(readKeys(q.config)).not.toContain(COMPARE_KEY);
    }
  },
);
