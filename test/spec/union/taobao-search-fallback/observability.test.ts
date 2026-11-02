import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import {
  createTaobaoSearchCounter,
  type TaobaoSearchMetricOutcome,
} from '../../../../apps/api/src/modules/union/infra/taobao/search-counter.ts';
import type { TaobaoSearchSource } from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { families, ROOT, samples } from '../../platform/metrics/kit.ts';
import {
  SEARCH_VARIABLE,
  ctx,
  logText,
  outcome,
  type LogEntry,
} from '../taobao-dataoke-switches/kit.ts';
import {
  KEYWORD,
  query,
  searchBody,
  topError,
} from '../taobao-official-search/official-harness.ts';
import { dataokeEnvelope, response, searchData } from '../taobao-search/kit.ts';
import {
  boot,
  counted,
  FALLBACK_EVENT,
  officialCount,
  recorded,
  searchEvents,
  slotRows,
  started,
  stubGateway,
  type StartedModule,
} from './fallback-harness.ts';

// 第 12–14 条。计数器 couli_taobao_search_total{source,outcome}：source official / dataoke，outcome ok、empty、
// error、fallback，回落原因不进标签；经 metrics 注册表在 api 入口输出，worker 不出（入口接线见 entry.test.ts）。
// warn taobao_search_fallback 带 reason、不含关键词。告警 CouliTaobaoSearchFallbackHigh（warning）读该计数器的
// 回落比例。
// 记法：一次回落里官方那一次只记 fallback，不重复记 error，大淘客那一次记 ok、empty 或 error；冷却期的请求只记大淘客
// 那一次，source=dataoke；纯 official、dataoke 模式同样计数。所以告警的分母只能数官方尝试：冷却期的请求不算官方的。

vi.mock('../../../../apps/api/src/modules/platform/config/taobao-startup.ts', async (original) => ({
  ...(await original<
    typeof import('../../../../apps/api/src/modules/platform/config/taobao-startup.ts')
  >()),
  openTaobaoCredentials: async () => async () => ({
    appKey: 'fake-fallback-wiring-key',
    appSecret: 'wire-wire-wire-wire-wire',
  }),
}));
vi.mock(
  '../../../../apps/api/src/modules/platform/config/dataoke-startup.ts',
  async (original) => ({
    ...(await original<
      typeof import('../../../../apps/api/src/modules/platform/config/dataoke-startup.ts')
    >()),
    openDataokeCredentials: async () => async () => ({
      appKey: 'fake-fallback-wiring-dataoke-key',
      appSecret: 'dtkw-dtkw-dtkw-dtkw-dtkw',
    }),
  }),
);

const METRIC = 'couli_taobao_search_total';
const ALERT = 'CouliTaobaoSearchFallbackHigh';
const RULES = new URL('infra/monitoring/rules/couli.yaml', ROOT);

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => expect.fail('network access is forbidden')),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Scenario {
  /** The official gateway's page body. */
  readonly page?: () => unknown;
  /** The 大淘客 search answer. */
  readonly dataoke?: DataokeAnswer;
  /** TAOBAO_SEARCH_SOURCE; default official_first. */
  readonly mode?: TaobaoSearchSource;
}

type DataokeAnswer = 'empty' | 'down';
type Gateway = ReturnType<typeof stubGateway>;

/** From now on the 大淘客 search answers this way. */
function dataokeAnswers(upstream: Gateway['upstream'], answer: DataokeAnswer): void {
  if (answer === 'empty') {
    upstream.dataokeTransport.mockResolvedValue(response(dataokeEnvelope(searchData([], 0))));
  } else {
    upstream.dataokeTransport.mockRejectedValue(new Error('synthetic dataoke down'));
  }
}

/** Runs `run` on a started module (official_first by default) over these upstreams. */
async function withModule<T>(
  scenario: Scenario,
  run: (app: StartedModule, gateway: Gateway) => Promise<T>,
): Promise<T> {
  const gateway = stubGateway(scenario.page === undefined ? {} : { page: scenario.page });
  if (scenario.dataoke !== undefined) dataokeAnswers(gateway.upstream, scenario.dataoke);
  const database = slotRows();
  try {
    const app = started(
      await boot({ [SEARCH_VARIABLE]: scenario.mode ?? 'official_first' }, { db: database.db }),
    );
    try {
      return await run(app, gateway);
    } finally {
      await app.close();
    }
  } finally {
    await database.db.destroy();
  }
}

/** One first-page search on the module; a failure is a value here. */
function firstPage(app: StartedModule): Promise<unknown> {
  return outcome(() => app.registry.get('taobao').searchItems(query, ctx));
}

function fallbackWarnings(logs: readonly LogEntry[]): LogEntry[] {
  return logs.filter((entry) => entry.level === 'warn' && entry.text.includes(FALLBACK_EVENT));
}

/** The reason of the one fallback warning a search left. */
function reasonOf(app: StartedModule): unknown {
  const warnings = fallbackWarnings(app.logs);
  expect(warnings, `one ${FALLBACK_EVENT} warning`).toHaveLength(1);
  const fields = warnings[0]!.args[0] as Record<string, unknown>;
  expect(fields['event']).toBe(FALLBACK_EVENT);
  return fields['reason'];
}

it('[AC-B1-04zy#47] 注册表：api 入口输出 couli_taobao_search_total（counter），标签只有 source、outcome；worker 给了也不出、不调用', async () => {
  const snapshot = [
    { source: 'official', outcome: 'ok', value: 7 },
    { source: 'official', outcome: 'fallback', value: 3 },
    { source: 'dataoke', outcome: 'ok', value: 2 },
    { source: 'dataoke', outcome: 'empty', value: 1 },
  ];
  const collectTaobaoSearch = vi.fn(() => snapshot);
  const text = await createMetricsRegistry({ entry: 'api', collectTaobaoSearch }).render();
  expect(families(text).get(METRIC)).toBe('counter');
  const series = samples(text).filter((sample) => sample.name === METRIC);
  expect(series.map(({ labels, value }) => ({ ...labels, value }))).toEqual(snapshot);
  for (const sample of series) {
    expect(Object.keys(sample.labels).sort()).toEqual(['outcome', 'source']);
  }
  expect(collectTaobaoSearch).toHaveBeenCalledTimes(1);

  const worker = vi.fn(() => snapshot);
  const workerText = await createMetricsRegistry({
    entry: 'worker',
    collectTaobaoSearch: worker,
  }).render();
  expect(workerText).not.toContain(METRIC);
  expect(worker).not.toHaveBeenCalled();
});

it('[AC-B1-04zy#48] 注册表每次 scrape 都读当前快照，不缓存上一次的值', async () => {
  let snapshot = [{ source: 'official', outcome: 'ok', value: 1 }];
  const registry = createMetricsRegistry({ entry: 'api', collectTaobaoSearch: () => snapshot });
  const read = async (): Promise<number[]> =>
    samples(await registry.render())
      .filter((sample) => sample.name === METRIC)
      .map((sample) => sample.value);
  expect(await read()).toEqual([1]);
  snapshot = [{ source: 'official', outcome: 'ok', value: 5 }];
  expect(await read()).toEqual([5]);
});

it('[AC-B1-04zy#49] 计数器：按 source、outcome 分别累加，两个实例互不相干', () => {
  const counter = createTaobaoSearchCounter();
  counter.record('official', 'ok');
  counter.record('official', 'ok');
  counter.record('official', 'fallback');
  counter.record('dataoke', 'empty');
  expect(counted(counter, 'official', 'ok')).toBe(2);
  expect(counted(counter, 'official', 'fallback')).toBe(1);
  expect(counted(counter, 'dataoke', 'empty')).toBe(1);
  expect(counted(counter, 'dataoke', 'error')).toBe(0);
  expect(counted(createTaobaoSearchCounter(), 'official', 'ok')).toBe(0);
});

it('[AC-B1-04zy#50] 官方成功：official/ok 加一，dataoke 不动', async () => {
  await withModule({}, async (app) => {
    await firstPage(app);
    const counter = app.counter();
    expect(counted(counter, 'official', 'ok')).toBe(1);
    expect(counted(counter, 'official', 'fallback')).toBe(0);
    expect(counted(counter, 'dataoke', 'ok')).toBe(0);
  });
});

it.each([
  ['官方失败', () => topError(7)],
  ['官方 0 条', () => searchBody([], 0)],
] as [string, () => unknown][])(
  '[AC-B1-04zy#51] %s、大淘客有结果：官方那次只记 official/fallback（不重复记 error、empty），大淘客那次记 dataoke/ok',
  async (_label, page) => {
    await withModule({ page }, async (app) => {
      await firstPage(app);
      expect(recorded(app.counter())).toEqual({ 'official/fallback': 1, 'dataoke/ok': 1 });
    });
  },
);

it('[AC-B1-04zy#52] 两边都 0 条：官方那次只记 official/fallback，大淘客那次记 dataoke/empty', async () => {
  await withModule({ page: () => searchBody([], 0), dataoke: 'empty' }, async (app) => {
    await firstPage(app);
    expect(recorded(app.counter())).toEqual({ 'official/fallback': 1, 'dataoke/empty': 1 });
  });
});

it('[AC-B1-04zy#53] 官方失败、大淘客也失败：官方那次只记 official/fallback（不重复记 error），大淘客那次记 dataoke/error', async () => {
  await withModule({ page: () => topError(7), dataoke: 'down' }, async (app) => {
    await firstPage(app);
    expect(recorded(app.counter())).toEqual({ 'official/fallback': 1, 'dataoke/error': 1 });
  });
});

it('[AC-B1-04zy#54] 官方续页失败：official/error 加一，不算回落；续页 0 条：official/empty 加一', async () => {
  await withModule({ page: () => topError(7) }, async (app) => {
    const q = { keyword: KEYWORD, cursor: 'taobao-search:2' };
    await outcome(() => app.registry.get('taobao').searchItems(q, ctx));
    const counter = app.counter();
    expect(counted(counter, 'official', 'error')).toBe(1);
    expect(counted(counter, 'official', 'fallback')).toBe(0);
    expect(counted(counter, 'dataoke', 'ok')).toBe(0);
  });
  await withModule({ page: () => searchBody([], 0) }, async (app) => {
    const q = { keyword: KEYWORD, cursor: 'taobao-search:2' };
    await outcome(() => app.registry.get('taobao').searchItems(q, ctx));
    expect(counted(app.counter(), 'official', 'empty')).toBe(1);
  });
});

it('[AC-B1-04zy#55] 回落写 warn 事件 taobao_search_fallback：平铺字段带 reason，不含关键词；失败与 0 条的 reason 不同', async () => {
  const failed = await withModule({ page: () => topError(7) }, async (app) => {
    await firstPage(app);
    expect(logText(app.logs)).not.toContain(KEYWORD);
    return reasonOf(app);
  });
  const empty = await withModule({ page: () => searchBody([], 0) }, async (app) => {
    await firstPage(app);
    expect(logText(app.logs)).not.toContain(KEYWORD);
    return reasonOf(app);
  });
  expect(failed).toEqual(expect.any(String));
  expect(failed).not.toBe('');
  expect(empty).toEqual(expect.any(String));
  expect(empty).not.toBe('');
  expect(empty).not.toBe(failed);
});

it('[AC-B1-04zy#56] 没回落不写这条 warn：官方成功时日志里没有 taobao_search_fallback', async () => {
  await withModule({ page: () => topError(7) }, async (app) => {
    await firstPage(app);
    expect(fallbackWarnings(app.logs)).toHaveLength(1);
  });
  await withModule({}, async (app) => {
    await firstPage(app);
    expect(fallbackWarnings(app.logs)).toEqual([]);
  });
});

it('[AC-B1-04zy#57] 大淘客也失败：日志里两个来源都有，都不含关键词', async () => {
  await withModule({ page: () => topError(7), dataoke: 'down' }, async (app) => {
    const failure = await firstPage(app);
    expect(failure).toBeInstanceOf(Error);
    const text = logText(searchEvents(app.logs));
    expect(text).toContain('official');
    expect(text).toContain('dataoke');
    expect(logText(app.logs)).not.toContain(KEYWORD);
  });
});

it('[AC-B1-04zy#60] 冷却期的请求只记大淘客那一次（dataoke/ok）：官方没被问，official 下什么都不记', async () => {
  await withModule({ page: () => topError(7) }, async (app, { transport }) => {
    await firstPage(app);
    expect(recorded(app.counter())).toEqual({ 'official/fallback': 1, 'dataoke/ok': 1 });

    await firstPage(app);
    expect(officialCount({ transport })).toBe(1);
    expect(recorded(app.counter())).toEqual({ 'official/fallback': 1, 'dataoke/ok': 2 });
  });
});

it.each([
  ['0 条', 'empty', 'empty'],
  ['失败', 'down', 'error'],
] as [string, DataokeAnswer, TaobaoSearchMetricOutcome][])(
  '[AC-B1-04zy#61] 冷却期大淘客%s：只多记一次 dataoke 那一条，official 不动',
  async (_label, answer, want) => {
    await withModule({ page: () => topError(7) }, async (app, { transport, upstream }) => {
      await firstPage(app);
      dataokeAnswers(upstream, answer);
      await firstPage(app);
      expect(officialCount({ transport })).toBe(1);
      expect(recorded(app.counter())).toEqual({
        'official/fallback': 1,
        'dataoke/ok': 1,
        [`dataoke/${want}`]: 1,
      });
    });
  },
);

const OFFICIAL_MODE: [string, Scenario, TaobaoSearchMetricOutcome][] = [
  ['有结果记 ok', {}, 'ok'],
  ['0 条记 empty', { page: () => searchBody([], 0) }, 'empty'],
  ['失败记 error', { page: () => topError(7) }, 'error'],
];

it.each(OFFICIAL_MODE)(
  '[AC-B1-04zy#62] 纯 official 模式也计数：%s，source=official，不记 fallback，大淘客没被问',
  async (_label, scenario, want) => {
    await withModule({ ...scenario, mode: 'official' }, async (app, { upstream }) => {
      await firstPage(app);
      expect(recorded(app.counter())).toEqual({ [`official/${want}`]: 1 });
      expect(upstream.dataokeTransport).not.toHaveBeenCalled();
    });
  },
);

const DATAOKE_MODE: [string, Scenario, TaobaoSearchMetricOutcome][] = [
  ['有结果记 ok', {}, 'ok'],
  ['0 条记 empty', { dataoke: 'empty' }, 'empty'],
  ['失败记 error', { dataoke: 'down' }, 'error'],
];

it.each(DATAOKE_MODE)(
  '[AC-B1-04zy#63] 纯 dataoke 模式也计数：%s，source=dataoke，官方没被问',
  async (_label, scenario, want) => {
    await withModule({ ...scenario, mode: 'dataoke' }, async (app, { transport }) => {
      await firstPage(app);
      expect(recorded(app.counter())).toEqual({ [`dataoke/${want}`]: 1 });
      expect(officialCount({ transport })).toBe(0);
    });
  },
);

interface Rule {
  readonly alert?: unknown;
  readonly expr?: unknown;
  readonly for?: unknown;
  readonly labels?: Readonly<Record<string, unknown>>;
  readonly annotations?: { readonly summary?: unknown };
}

function baseRules(): Rule[] {
  const doc = parseYamlLite(readFileSync(RULES, 'utf8')) as { groups: { rules: Rule[] }[] };
  return doc.groups.flatMap((group) => group.rules);
}

/** The matchers of a `{…}` selector; anything but `name="value"` fails. */
function matchersOf(selector: string): Record<string, string> {
  return Object.fromEntries(
    selector.split(',').map((matcher) => {
      const parsed = /^\s*(\w+)\s*=\s*"([^"]*)"\s*$/.exec(matcher);
      expect(parsed, `matcher ${matcher}`).not.toBeNull();
      return [parsed![1]!, parsed![2]!];
    }),
  );
}

it('[AC-B1-04zy#58] couli.yaml 有 CouliTaobaoSearchFallbackHigh：warning（不是 critical、不是资金告警），表达式是 sum(rate(官方回落)) / sum(rate(官方尝试)) > 阈值，分子分母都只读 source="official"，两边同一窗口且不小于 5m', () => {
  const found = baseRules().filter((rule) => rule.alert === ALERT);
  expect(found).toHaveLength(1);
  const rule = found[0]!;
  expect(rule.labels?.['severity']).toBe('warning');
  expect(rule.labels?.['fund']).toBeUndefined();
  expect(rule.annotations?.summary).toEqual(expect.stringMatching(/\S/));
  expect(rule.for).toEqual(expect.stringMatching(/^[1-9][0-9]*[smh]$/));

  const expr = String(rule.expr).trim();
  // 必须 sum：两边标签集不同（分子带 outcome），不聚合时 `/` 按标签一对一匹配，出不来这个比例。
  const side = `sum\\(\\s*rate\\(\\s*${METRIC}\\{([^}]*)\\}\\[([1-9][0-9]*)([smh])\\]\\s*\\)\\s*\\)`;
  const ratio = new RegExp(`^${side}\\s*/\\s*${side}\\s*>\\s*(0?\\.[0-9]+)$`).exec(expr);
  expect(ratio, `expression shape: ${expr}`).not.toBeNull();
  const [, numerator, amount, unit, denominator, otherAmount, otherUnit, threshold] = ratio!;
  // 官方挂住时绝大多数请求走冷却、只记 dataoke：分母若数全部序列，比例被冷却稀释到接近 0，告警在最该响的时候不响。
  expect(matchersOf(numerator!)).toEqual({ source: 'official', outcome: 'fallback' });
  expect(matchersOf(denominator!)).toEqual({ source: 'official' });
  // 冷却期每 60 秒只有一次官方尝试：窗口短了比例算不稳。
  expect(otherAmount).toBe(amount);
  expect(otherUnit).toBe(unit);
  const unitSeconds: Record<string, number> = { s: 1, m: 60, h: 3600 };
  expect(Number(amount) * unitSeconds[unit!]!).toBeGreaterThanOrEqual(300);
  expect(Number(threshold)).toBeGreaterThan(0);
});
