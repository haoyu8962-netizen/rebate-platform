import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionError,
  type CallCtx,
  type Page,
  type SearchQuery,
  type UnionItem,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  DataokeClient,
  type DataokeCredentials,
  type DataokeRandom,
} from '../../../../apps/api/src/modules/union/infra/dataoke/dataoke-client.ts';
import type { UnionRegistry } from '../../../../apps/api/src/modules/union/infra/registry.ts';
import type {
  UnionTransport,
  UnionTransportRequest,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  taobaoSearchCounterToken,
  type TaobaoSearchCounter,
  type TaobaoSearchMetricOutcome,
  type TaobaoSearchMetricSource,
} from '../../../../apps/api/src/modules/union/infra/taobao/search-counter.ts';
import {
  TaobaoUnionAdapter,
  type TaobaoCredentials,
  type TaobaoSearchSlotReader,
  type TaobaoSearchSource,
} from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import { ManualScheduler } from '../../platform/http/kit.ts';
import {
  configured,
  endpoints,
  fakeUpstream,
  outcome,
  pidRow,
  stubHttp,
  clock as moduleClock,
  visible,
  type LogEntry,
} from '../taobao-dataoke-switches/kit.ts';
import {
  convertToDetail,
  ctx,
  DETAIL,
  endpoint,
  formOf,
  gateway,
  instant,
  KEYWORD,
  OFFICIAL_SEARCH,
  query,
  requestsOf,
  rowsFrom,
  SEARCH_ENVELOPE,
  searchBody,
  searchNumber,
  searchRequests,
  searchRow,
  SLOT_PID,
  topError,
  type GatewayOptions,
} from '../taobao-official-search/official-harness.ts';
import { slotDatabase } from '../taobao-official-search/slot-database.ts';
import {
  DATAOKE_BASE,
  dataokeEnvelope,
  dtkRow,
  response,
  searchData,
  searched,
  truthfulTop,
} from '../taobao-search/kit.ts';

// Task-local AC labels ([AC-B1-04zy#n]) identify this task's acceptance points, not business rules.
// 依据：BR-PRICE-11（quoted_at）、D10-582 与编排者补充第 1–14 条。合成、非录制：报文沿用 B1-04zh / B1-04zx
// 的合成夹具，不读私有库、不联网、不监听端口、不等真实时间。
//
// 时间分两种：官方这一步的限时走手动 Scheduler（挂住的请求只有 scheduler.advance 才会到点，且用 observe
// 看结果，不 await：现实现不回落时用例红在断言，而不是超时）；冷却与 quoted_at 走注入的 FixedClock。
// 骨架上的红：不回落类用例在现实现上本来就不回落，所以都先调 expectFallsBack，「同样的装配确实会回落」才算数。

/** What an upstream handler may touch while "on the wire". */
export interface Wire {
  readonly clock: FixedClock;
  readonly scheduler: ManualScheduler;
}

export type Upstream = (
  request: UnionTransportRequest,
  wire: Wire,
) => UnionTransportResponse | Promise<UnionTransportResponse>;

/** The three upstream calls of a search; replaceable between searches. */
export interface Upstreams {
  official: Upstream;
  detail: Upstream;
  dataoke: Upstream;
}

export interface SetupOptions extends Partial<Upstreams> {
  /** Default 'official_first'. */
  readonly searchSource?: TaobaoSearchSource;
  /** Which ids the TOP detail converts; default convertToDetail. Ignored when `detail` is given. */
  readonly available?: (id: string) => string | undefined;
  /** What the slot reader answers. Default SLOT_PID. */
  readonly slot?: string | null;
  /** Replaces the slot reader. */
  readonly slotReader?: TaobaoSearchSlotReader;
  /** What the adapter counts on; only the tests that read the counter give one. */
  readonly searchCounter?: TaobaoSearchCounter;
}

/** The ids of a TOP item detail call. */
export function detailIds(request: UnionTransportRequest): string[] {
  return (formOf(request)['item_id'] ?? '').split(',');
}

/** A truthful TOP detail over `available`. */
export function convertedBy(available: (id: string) => string | undefined): Upstream {
  return (request) => response(truthfulTop(detailIds(request), available));
}

/** Official ids do not convert; 大淘客 ids do. */
export function officialUnconverted(id: string): string | undefined {
  return searchNumber(id) === undefined ? convertToDetail(id) : undefined;
}

/** The TOP detail fails for official ids and converts 大淘客 ids. */
export function officialDetailFails(failure: Upstream): Upstream {
  const converted = convertedBy(convertToDetail);
  return (request, wire) =>
    searchNumber(detailIds(request)[0] ?? '') === undefined
      ? converted(request, wire)
      : failure(request, wire);
}

/** The default official answer: rows 1..3 of three. */
export function officialDefault(): UnionTransportResponse {
  return response(searchBody(rowsFrom(1, 3), 3));
}

/** The default 大淘客 answer: rows 1, 2 of two. */
export function dataokeDefault(): UnionTransportResponse {
  return response(dataokeEnvelope(searchData([dtkRow(1), dtkRow(2)], 2)));
}

/** A full 大淘客 page: there is a next page. */
export function dataokeFullPage(): UnionTransportResponse {
  const rows = Array.from({ length: 20 }, (_unused, i) => dtkRow(i + 1));
  return response(dataokeEnvelope(searchData(rows, 165)));
}

/** 大淘客 has nothing. */
export function dataokeEmpty(): UnionTransportResponse {
  return response(dataokeEnvelope(searchData([], 0)));
}

/** A transport that fails outright (official: upstream_unavailable; 大淘客 likewise). */
export function transportDown(): never {
  throw new Error('synthetic transport down');
}

/** The official search refuses: code 7. */
export function officialRateLimited(): UnionTransportResponse {
  return response(topError(7));
}

/**
 * Never answers. On abort it fails as the real HTTPS transport does (http-transport.ts:
 * UnionError upstream_unavailable), so a limit and a cancellation look alike at the transport.
 */
export function hang(request: UnionTransportRequest): Promise<UnionTransportResponse> {
  return new Promise((_resolve, reject) => {
    const aborted = (): void => {
      reject(new UnionError('upstream_unavailable', 'taobao transport: request aborted', 'taobao'));
    };
    if (request.signal?.aborted === true) {
      aborted();
      return;
    }
    request.signal?.addEventListener('abort', aborted, { once: true });
  });
}

/** 第 2 条：官方抛这些错误要回落（超时见 timing.test.ts）。 */
export const OFFICIAL_FAILURES: [string, Upstream][] = [
  ['传输抛错（upstream_unavailable）', transportDown],
  ['HTTP 502（upstream_unavailable）', () => response('synthetic bad gateway', 502)],
  ['外层键缺失（upstream_unavailable）', () => response({ unexpected_envelope: {} })],
  ['code 7（rate_limited）', officialRateLimited],
  ['isp.call-limited（rate_limited）', () => response(topError(15, 'isp.call-limited-synthetic'))],
  [
    'code 11 无权限（upstream_rejected）',
    () => response(topError(11, 'isv.permission-api-package-limit')),
  ],
  ['code 15 表外子码（upstream_rejected）', () => response(topError(15, 'isv.synthetic-refused'))],
];

/** 第 3 条：官方成功但 0 条。 */
export const OFFICIAL_EMPTIES: [string, Upstream][] = [
  ['空 map_data', () => response(searchBody([], 0))],
  [
    'total_results 0、没有 result_list',
    () => response({ [SEARCH_ENVELOPE]: { total_results: 0 } }),
  ],
  ['15/50001', () => response(topError(15, 50001))],
];

/** The adapter under official_first by default, over fake upstreams and a manual scheduler. */
export function setup(options: SetupOptions = {}) {
  const clock = new FixedClock(instant);
  const scheduler = new ManualScheduler();
  const wire: Wire = { clock, scheduler };
  const upstreams: Upstreams = {
    official: options.official ?? officialDefault,
    detail: options.detail ?? convertedBy(options.available ?? convertToDetail),
    dataoke: options.dataoke ?? dataokeDefault,
  };
  const credentials = vi.fn<() => Promise<TaobaoCredentials>>(async () => ({
    appKey: 'fake-fallback-key',
    appSecret: 'fbck-fbck-fbck-fbck-fbck',
  }));
  const transport = vi.fn<UnionTransport>(async (request) => {
    const method = formOf(request)['method'];
    if (method === OFFICIAL_SEARCH) return upstreams.official(request, wire);
    if (method === DETAIL) return upstreams.detail(request, wire);
    return response(topError('synthetic-unexpected-method'));
  });
  const dataokeTransport = vi.fn<UnionTransport>(async (request) =>
    upstreams.dataoke(request, wire),
  );
  const orderSource = new DataokeClient({
    credentials: vi.fn<() => Promise<DataokeCredentials>>(async () => ({
      appKey: 'fake-fallback-dataoke-key',
      appSecret: 'dtkf-dtkf-dtkf-dtkf-dtkf',
    })),
    transport: dataokeTransport,
    clock,
    random: vi.fn<DataokeRandom>().mockReturnValue(42),
    baseUrl: DATAOKE_BASE,
  });
  const slot = options.slot === undefined ? SLOT_PID : options.slot;
  const searchSlot = vi.fn<TaobaoSearchSlotReader>(options.slotReader ?? (async () => slot));
  const adapter = new TaobaoUnionAdapter({
    credentials,
    transport,
    clock,
    endpoint,
    orderSource,
    scheduler,
    searchSlot,
    searchSource: options.searchSource ?? 'official_first',
    ...(options.searchCounter === undefined ? {} : { searchCounter: options.searchCounter }),
  });
  return {
    adapter,
    clock,
    scheduler,
    upstreams,
    credentials,
    transport,
    dataokeTransport,
    searchSlot,
  };
}

export type Harness = ReturnType<typeof setup>;

/** One search that must succeed; a rejection fails as an assertion. */
export function search(
  h: Harness,
  q: SearchQuery = query,
  context: CallCtx = ctx,
): Promise<Page<UnionItem>> {
  return searched(() => h.adapter.searchItems(q, context));
}

/**
 * The control of every "does not fall back" test: the same assembly does fall back. A case that
 * does not fall back holds on any adapter; next to this it says the fallback stops at that case.
 */
export async function expectFallsBack(options: SetupOptions = {}): Promise<void> {
  const h = setup({ official: officialRateLimited, ...options });
  const page = await search(h);
  expect(h.dataokeTransport, 'control: official_first falls back').toHaveBeenCalledTimes(1);
  expect(page.items.length, 'control: the 大淘客 result comes back').toBeGreaterThan(0);
}

/** Official search requests so far. */
export function officialCount(h: Pick<Harness, 'transport'>): number {
  return searchRequests(h).length;
}

/** The id list of every TOP item detail call, in call order. */
export function detailLists(h: Pick<Harness, 'transport'>): string[][] {
  return requestsOf(h, DETAIL).map(detailIds);
}

/** The signal official search request `index` carried; it must carry one. */
export function officialSignal(h: Pick<Harness, 'transport'>, index = 0): AbortSignal {
  const signal = searchRequests(h)[index]?.signal;
  expect(signal, 'the official search request carries a signal').toBeDefined();
  return signal as AbortSignal;
}

/** One full official page: there is a next page. */
export function officialFullPage(): UnionTransportResponse {
  return response(searchBody(rowsFrom(1, 20), 165));
}

/** Rows that all lack a title: the official page itself is invalid_dto. */
export function officialInvalidRows(): UnionTransportResponse {
  const rows = [1, 2, 3].map((n) => searchRow(n, { basic: { title: undefined } }));
  return response(searchBody(rows, 3));
}

export { KEYWORD };

// ---------------------------------------------------------------------------------------------
// UnionModule assembled by Nest (as taobao-dataoke-switches/kit.ts assemble, but a refused startup
// comes back as a value, and the module's own counter can be read)
// ---------------------------------------------------------------------------------------------

export const FALLBACK_EVENT = 'taobao_search_fallback';

export interface StartedModule {
  readonly registry: UnionRegistry;
  readonly logs: LogEntry[];
  /** The counter UnionModule provides. */
  counter(): TaobaoSearchCounter;
  close(): Promise<void>;
}

interface FactoryProvider {
  provide: unknown;
  inject?: readonly unknown[];
  useFactory?: (...args: unknown[]) => unknown;
}
interface ModuleMetadata {
  module: unknown;
  providers: FactoryProvider[];
  exports?: unknown[];
}
interface ModuleExports {
  UNION_ENDPOINTS: unknown;
  UNION_REGISTRY: unknown;
  UnionModule: { forRoot(): ModuleMetadata };
}
interface TestContext {
  get<T>(token: unknown): T;
  init(): Promise<unknown>;
  close(): Promise<void>;
}
interface NestTesting {
  Test: {
    createTestingModule(metadata: { imports: unknown[] }): {
      compile(): Promise<TestContext>;
    };
  };
}

export interface BootOptions {
  /** Whether the 大淘客 credentials are configured. Default true. */
  readonly dataoke?: boolean;
  readonly db?: Kysely<DB>;
}

/**
 * Loads staging with these extra variables and resolves UnionModule.forRoot() in full (no
 * application, no port). A refusal, by loadConfig or by the module, comes back as the error.
 * Dynamic imports keep the module's decorators out of the test type check.
 */
export async function boot(
  extra: Record<string, string>,
  options: BootOptions = {},
): Promise<StartedModule | Error> {
  const config = await outcome(() => configured(extra, options.dataoke ?? true));
  if (config instanceof Error) return config;
  const modulePath = '../../../../apps/api/src/modules/union/union.module.ts';
  const union = (await import(
    /* @vite-ignore */ new URL(modulePath, import.meta.url).href
  )) as ModuleExports;
  const platformPath = '../../../../apps/api/src/modules/platform/index.ts';
  const platform = (await import(
    /* @vite-ignore */ new URL(platformPath, import.meta.url).href
  )) as Record<string, unknown>;
  const requireApi = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const testing = (await import(
    /* @vite-ignore */ pathToFileURL(requireApi.resolve('@nestjs/testing')).href
  )) as NestTesting;
  const logs: LogEntry[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      logs.push({ level, args, text: visible(args) });
    };
  const logger = {
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    child: () => logger,
  };
  const values = new Map<unknown, unknown>([
    [platform['APP_CONFIG'], config],
    [platform['CLOCK'], moduleClock],
    [platform['ROOT_LOGGER'], logger],
  ]);
  if (options.db !== undefined) values.set(platform['DB'], options.db);
  class FixtureGlobals {}
  const metadata = union.UnionModule.forRoot();
  const compiled = await outcome(() =>
    testing.Test.createTestingModule({
      imports: [
        {
          module: FixtureGlobals,
          global: true,
          providers: [...values].map(([provide, useValue]) => ({ provide, useValue })),
          exports: [...values.keys()],
        },
        {
          ...metadata,
          providers: metadata.providers.map((provider) =>
            provider.provide === union.UNION_ENDPOINTS
              ? { provide: provider.provide, useValue: endpoints() }
              : provider,
          ),
        },
      ],
    }).compile(),
  );
  if (compiled instanceof Error) return compiled;
  const context = compiled as TestContext;
  const initialized = await outcome(() => context.init());
  if (initialized instanceof Error) return initialized;
  return {
    registry: context.get<UnionRegistry>(union.UNION_REGISTRY),
    logs,
    counter: () => context.get<TaobaoSearchCounter>(taobaoSearchCounterToken()),
    close: () => context.close(),
  };
}

/** A boot that must have started. */
export function started(result: StartedModule | Error): StartedModule {
  expect(result, 'the union module must start').not.toBeInstanceOf(Error);
  return result as StartedModule;
}

/** Every HTTPS transport of the module answers as the official gateway; 大淘客 stays the fake. */
export function stubGateway(options: GatewayOptions = {}) {
  const upstream = fakeUpstream();
  const transport = gateway(moduleClock, options);
  const combined: UnionTransport = (request) =>
    new URL(request.url).pathname.startsWith('/api/')
      ? upstream.dataokeTransport(request)
      : transport(request);
  stubHttp({ ...upstream, combined });
  return { upstream, transport };
}

/** An in-memory union_pids with the query PID of the module's app. */
export function slotRows() {
  return slotDatabase([pidRow({ pid: SLOT_PID, pid_scene: 'query' })]);
}

/** The value of one series; a series not counted yet reads 0, a repeated one fails. */
export function counted(
  counter: TaobaoSearchCounter,
  source: TaobaoSearchMetricSource,
  metricOutcome: TaobaoSearchMetricOutcome,
): number {
  const found = counter
    .snapshot()
    .filter((sample) => sample.source === source && sample.outcome === metricOutcome);
  expect(found.length, `${source}/${metricOutcome} appears once at most`).toBeLessThanOrEqual(1);
  return found[0]?.value ?? 0;
}

/** Everything counted so far as `source/outcome` → value; a series still at 0 is left out. */
export function recorded(counter: TaobaoSearchCounter): Record<string, number> {
  const counts = counter.snapshot().filter((sample) => sample.value > 0);
  return Object.fromEntries(
    counts.map((sample) => [`${sample.source}/${sample.outcome}`, sample.value]),
  );
}

/** Log entries of the fallback itself: every taobao_search_* event but the skipped row. */
export function searchEvents(logs: readonly LogEntry[]): LogEntry[] {
  return logs.filter((entry) => {
    const event = Reflect.get(Object(entry.args[0]), 'event') as unknown;
    return (
      typeof event === 'string' &&
      event.startsWith('taobao_search_') &&
      event !== 'taobao_search_row_skipped'
    );
  });
}
