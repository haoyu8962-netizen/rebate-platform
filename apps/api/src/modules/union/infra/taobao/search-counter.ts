// couli_taobao_search_total{source,outcome} 的进程内计数（B1-04zy，FU-TB-SEARCH-FALLBACK，D10-582）。
// 规则测试 test/spec/union/taobao-search-fallback/**。
//
// - 计数器由 UnionModule 提供（Nest 令牌 taobaoSearchCounterToken()），淘宝适配器每次搜索按实际来源记数。
// - entry.ts 在 api 入口取到它，把 snapshot 作为 collectTaobaoSearch 交给 createMetricsRegistry；
//   platform 不依赖 union，注册表只认结构相同的快照类型（platform/metrics/registry.ts）。
// - 标签只有 source、outcome；回落原因不进标签，只进 warn 日志 taobao_search_fallback 的 reason。
// - 一次回落里官方那一次只记 fallback（不重复记 error），大淘客那一次记 ok、empty 或 error；冷却期的请求只记大淘客
//   那一次，source=dataoke；纯 official、dataoke 模式同样计数。没发出请求就被拒绝的（空关键词、坏游标、没有
//   推广位）也算那个来源的 error：调用确实失败了，只是告警的分母因此略大。

/** Where a search was answered from. */
export type TaobaoSearchMetricSource = 'official' | 'dataoke';

/** How that source's attempt ended; `fallback` is the official attempt that handed over. */
export type TaobaoSearchMetricOutcome = 'ok' | 'empty' | 'error' | 'fallback';

/** One series of the counter. */
export interface TaobaoSearchSample {
  readonly source: TaobaoSearchMetricSource;
  readonly outcome: TaobaoSearchMetricOutcome;
  readonly value: number;
}

/** Process-local counter; one per UnionModule instance. */
export interface TaobaoSearchCounter {
  record(source: TaobaoSearchMetricSource, outcome: TaobaoSearchMetricOutcome): void;
  /** Every series counted so far, read at scrape time. */
  snapshot(): readonly TaobaoSearchSample[];
}

const TAOBAO_SEARCH_COUNTER = Symbol('TAOBAO_SEARCH_COUNTER');

/** A new counter with nothing counted. */
export function createTaobaoSearchCounter(): TaobaoSearchCounter {
  const series = new Map<string, TaobaoSearchSample>();
  return {
    record(source, outcome) {
      const key = `${source}/${outcome}`;
      series.set(key, { source, outcome, value: (series.get(key)?.value ?? 0) + 1 });
    },
    snapshot: () => [...series.values()],
  };
}

/** The Nest token of the counter UnionModule provides; entry.ts resolves it, strict: false. */
export function taobaoSearchCounterToken(): symbol {
  return TAOBAO_SEARCH_COUNTER;
}
