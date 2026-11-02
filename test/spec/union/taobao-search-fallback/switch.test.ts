import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  loadConfig,
  startupViolations,
  type AppConfig,
} from '../../../../apps/api/src/modules/platform/config/config.ts';
import { readTaobaoSourceConfig } from '../../../../apps/api/src/modules/platform/config/taobao-sources.ts';
import {
  SEARCH_VARIABLE,
  configFailure,
  ctx,
  environment,
  observeTaobao,
  outcome,
  succeeded,
  visible,
} from '../taobao-dataoke-switches/kit.ts';
import { couliItemId, query } from '../taobao-search/kit.ts';
import { topError, unionFailure } from '../taobao-official-search/official-harness.ts';
import {
  boot,
  expectFallsBack,
  officialCount,
  setup,
  slotRows,
  started,
  stubGateway,
  transportDown,
} from './fallback-harness.ts';

// 第 1 条开关：TAOBAO_SEARCH_SOURCE 接受 official_first；未设、空串仍 official，dataoke 不变，非法值照旧报错。
// official_first 且没有大淘客凭据：启动报错，不静默退化。报错放在 loadConfig 还是模块装配不定，端到端只看
// 「这一入口起不来」，同样的装配带上大淘客凭据就能起来。

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

const APP_ENVS = ['local', 'test', 'staging', 'prod'] as const;
const OFFICIAL_FIRST = 'official_first';

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

/** The variable as loadConfig reads it; a refusal fails as an assertion. */
async function acceptedIn(appEnv: (typeof APP_ENVS)[number]): Promise<AppConfig> {
  const variables = { ...environment(appEnv), [SEARCH_VARIABLE]: OFFICIAL_FIRST };
  const config = await outcome(() => loadConfig(variables));
  expect(config, `${appEnv} accepts ${OFFICIAL_FIRST}`).not.toBeInstanceOf(Error);
  return config as AppConfig;
}

it('[AC-B1-04zy#1] TAOBAO_SEARCH_SOURCE=official_first 任何 APP_ENV 都接受、原样带出；不是凭据，不触发启动限制', async () => {
  for (const appEnv of APP_ENVS) {
    const config = await acceptedIn(appEnv);
    expect(config.taobaoSearchSource).toBe(OFFICIAL_FIRST);
    expect(startupViolations(appEnv, { [SEARCH_VARIABLE]: OFFICIAL_FIRST })).toEqual([]);
  }
  expect(readTaobaoSourceConfig({ [SEARCH_VARIABLE]: OFFICIAL_FIRST })).toEqual({
    taobaoConvertSource: 'baichuan',
    taobaoSearchSource: OFFICIAL_FIRST,
    problems: [],
  });
});

it('[AC-B1-04zy#2] 默认不改：未设、空串仍 official，dataoke 不变；大小写或拼写不同的取值照旧报错，问题文本只写变量名', async () => {
  for (const appEnv of APP_ENVS) {
    await acceptedIn(appEnv);
    for (const extra of [{}, { [SEARCH_VARIABLE]: '' }]) {
      expect(loadConfig({ ...environment(appEnv), ...extra }).taobaoSearchSource).toBe('official');
    }
    expect(
      loadConfig({ ...environment(appEnv), [SEARCH_VARIABLE]: 'dataoke' }).taobaoSearchSource,
    ).toBe('dataoke');
    for (const value of ['OFFICIAL_FIRST', 'Official_First', 'official-first', 'official_first ']) {
      const error = configFailure({ ...environment(appEnv), [SEARCH_VARIABLE]: value });
      expect(error.problems.join('\n')).toContain(SEARCH_VARIABLE);
      expect(error.problems.join('\n')).not.toContain(value);
    }
  }
});

it('[AC-B1-04zy#3] official_first 且没有大淘客凭据：入口启动报错，不静默退化成只走官方；同样的配置带上大淘客凭据才启动', async () => {
  const { transport } = stubGateway();
  const database = slotRows();
  try {
    const refused = await boot(
      { [SEARCH_VARIABLE]: OFFICIAL_FIRST },
      { dataoke: false, db: database.db },
    );
    expect(refused, 'the entry refuses to start').toBeInstanceOf(Error);
    expect(visible(refused)).not.toContain('dtkw-dtkw');

    const app = started(await boot({ [SEARCH_VARIABLE]: OFFICIAL_FIRST }, { db: database.db }));
    await app.close();
    expect(transport).not.toHaveBeenCalled();
  } finally {
    await database.db.destroy();
  }
});

it('[AC-B1-04zy#4] 端到端：official_first 经 UnionModule 接线：官方失败时真的走大淘客客户端，返回大淘客结果', async () => {
  const observed = observeTaobao();
  const { upstream, transport } = stubGateway({ page: () => topError(7) });
  const database = slotRows();
  try {
    const app = started(await boot({ [SEARCH_VARIABLE]: OFFICIAL_FIRST }, { db: database.db }));
    try {
      expect(observed).toHaveBeenCalledTimes(1);
      expect(observed.mock.calls[0]![0].searchSource).toBe(OFFICIAL_FIRST);
      expect(observed.mock.calls[0]![0].orderSource).toBeDefined();
      const page = await succeeded(
        () => app.registry.get('taobao').searchItems(query, ctx),
        'searchItems',
      );
      expect(page.items.map((item) => item.item_id)).toEqual([1, 2].map(couliItemId));
      expect(officialCount({ transport })).toBe(1);
      expect(upstream.dataokeTransport).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  } finally {
    await database.db.destroy();
  }
});

it.each(['official', 'dataoke'] as const)(
  '[AC-B1-04zy#5] 开关 %s 不回落：失败原样抛，不碰另一个来源；只有 official_first 才回落',
  async (searchSource) => {
    await expectFallsBack();
    const h = setup({ searchSource, official: transportDown, dataoke: transportDown });
    await unionFailure(() => h.adapter.searchItems(query, ctx), 'upstream_unavailable');
    if (searchSource === 'official') {
      expect(officialCount(h)).toBe(1);
      expect(h.dataokeTransport).not.toHaveBeenCalled();
    } else {
      expect(officialCount(h)).toBe(0);
      expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
    }
  },
);
