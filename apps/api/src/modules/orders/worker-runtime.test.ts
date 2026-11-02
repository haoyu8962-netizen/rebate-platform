// B1-08n: the worker's order-sync assembly over a compile-only database (no connection, no
// listen): what building runs, what the handler and scheduler share, and the status-map cache.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import {
  FixedClock,
  createRootLogger,
  type JobHandler,
  type QueueRuntime,
} from '../platform/index.ts';
import type {
  RegisteredPlatform,
  UnionAdapter,
  UnionEndpoint,
  UnionRegistry,
} from '../union/index.ts';
import * as pipelinePort from './application/pipeline-port.ts';
import type { OrderSourcePorts } from './application/source-backfill.ts';
import * as updateStep from './application/update-step.ts';
import {
  createOrderSyncRuntime,
  orderSyncToken,
  type OrderRightsImportDeps,
  type OrderSyncReadPorts,
} from './worker-runtime.ts';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

function compileOnly(queries: string[]): Kysely<DB> {
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => void queries.push(event.query.sql),
  });
  handles.push(db);
  return db;
}

function rawAdapter(platform: RegisteredPlatform): UnionAdapter {
  return {
    platform,
    searchItems: vi.fn(),
    getItem: vi.fn(),
    resolveLink: vi.fn(),
    convert: vi.fn(),
    listOrders: vi.fn(async () => ({ items: [], nextCursor: null })),
  };
}

function setup(
  sources?: OrderSyncReadPorts['sources'],
  extra: Pick<OrderSyncReadPorts, 'blocklist' | 'suffixVoidEnabled' | 'rebate'> = {},
  rightsImports?: OrderRightsImportDeps,
) {
  const queries: string[] = [];
  const lines: { msg: string }[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void lines.push(JSON.parse(line) as { msg: string }) },
  );
  const register = vi.fn<(queue: string, handler: JobHandler) => void>();
  const send = vi.fn(async () => 'unit');
  const queue = {
    register,
    send,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as QueueRuntime;
  const endpoints: UnionEndpoint[] = (['pdd', 'jd'] as const).map((platform) => ({
    platform,
    mode: 'demo',
    baseUrl: null,
    quotaKey: `unit-${platform}`,
  }));
  const raws = new Map<RegisteredPlatform, UnionAdapter>();
  const registry: UnionRegistry = {
    registrations: () => [],
    get: (platform) => {
      const adapter = raws.get(platform) ?? rawAdapter(platform);
      raws.set(platform, adapter);
      return adapter;
    },
  };
  const users = { findByAttrCode: vi.fn() };
  const bindings = { findByRelation: vi.fn() };
  const ports = {
    users: vi.fn(() => users),
    bindings: vi.fn(() => bindings),
    quota: vi.fn((endpoint: UnionEndpoint) => ({
      bucketKey: endpoint.quotaKey,
      tryAcquire: () => true,
    })),
    ...(sources === undefined ? {} : { sources }),
    ...extra,
  };
  const db = compileOnly(queries);
  const clock = new FixedClock('2026-10-17T17:30:00.000Z');
  const runtime = createOrderSyncRuntime({
    db,
    clock,
    logger,
    queue,
    events: { publish: vi.fn() },
    endpoints,
    registry,
    ports,
    ...(rightsImports === undefined ? {} : { rightsImports }),
  });
  return {
    runtime,
    queries,
    lines,
    register,
    send,
    raws,
    ports,
    users,
    bindings,
    db,
    clock,
    logger,
  };
}

it('[AC-B1-08n#u7] 装配只注册一次 order-sync，不查库、不投递；端口工厂各调一次', () => {
  const s = setup();
  expect(s.register.mock.calls.map(([name]) => name)).toEqual(['order-sync']);
  expect(s.queries).toEqual([]);
  expect(s.send).not.toHaveBeenCalled();
  expect(s.ports.users.mock.calls).toEqual([[s.db]]);
  expect(s.ports.bindings.mock.calls).toEqual([[s.db]]);
  expect(s.ports.quota.mock.calls.map(([endpoint]) => endpoint.platform)).toEqual(['jd', 'pdd']);
  expect(orderSyncToken()).toBe(orderSyncToken());
  expect(typeof orderSyncToken()).toBe('symbol');
});

it('[AC-B1-08n#u8] 映射表启动时读好并缓存；未调度平台报 MISSING_STATUS_MAP', () => {
  const { runtime } = setup();
  const pdd = runtime.statusMaps('pdd');
  expect(pdd.entries.size).toBeGreaterThan(0);
  expect(runtime.statusMaps('pdd')).toBe(pdd);
  expect(() => runtime.statusMaps('taobao')).toThrow(
    expect.objectContaining({ code: 'MISSING_STATUS_MAP' }),
  );
});

it('[AC-B1-08n#u9] registry 回治理包装后的适配器；没有端点的平台拒绝', () => {
  const s = setup();
  const governed = s.runtime.registry.get('pdd');
  expect(governed).not.toBe(s.raws.get('pdd'));
  expect(s.runtime.registry.get('pdd')).toBe(governed);
  expect(() => s.runtime.registry.get('taobao')).toThrow(/no endpoint for taobao/);
});

it('[AC-B1-08n#u10] 注册的处理器与运行体共用 access：演示端点不拉取、不推进', async () => {
  const s = setup();
  const handler = s.register.mock.calls[0]![1];
  await handler({
    id: 'j1',
    queue: 'order-sync',
    name: 'window',
    attempt: 1,
    payload: {
      app_id: 'unit',
      platform: 'pdd',
      union_account_id: '10000000-0000-4000-8000-00000000000a',
      query_kind: 'increment',
      scene: '-',
      window_start: '2026-10-17T00:00:00.000Z',
      window_end: '2026-10-17T00:30:00.000Z',
    },
  });
  expect(s.raws.get('pdd')!.listOrders).not.toHaveBeenCalled();
  expect(s.queries).toEqual([]);
  expect(s.lines.map((l) => l.msg)).toContain('order_sync_window_account_mismatch');
});

it('[AC-B1-08n#u11] start 只起定时器、不投递；stop 后无残留定时器', async () => {
  vi.useFakeTimers();
  const s = setup();
  expect(vi.getTimerCount()).toBe(0);
  const handle = s.runtime.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(2); // one schedule timer per scheduled platform: jd, pdd
  expect(s.send).not.toHaveBeenCalled();
  expect(s.queries).toEqual([]);
  await handle.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B1-08q#u8] 注入 sources：工厂在装配时调一次（db、clock、logger），同一对象与 pids 交给归因和更新，装配不查库', () => {
  const makePipeline = vi.spyOn(pipelinePort, 'createOrderPipeline');
  const makeUpdate = vi.spyOn(updateStep, 'createOrderUpdateStep');
  const sources: OrderSourcePorts = {
    linkLogs: vi.fn(),
    productKey: vi.fn(),
  };
  const factory = vi.fn(() => sources);
  const s = setup(factory);
  expect(factory.mock.calls).toEqual([[s.db, s.clock, s.logger]]);
  expect(s.queries).toEqual([]);
  expect(s.send).not.toHaveBeenCalled();
  expect(sources.linkLogs).not.toHaveBeenCalled();
  expect(sources.productKey).not.toHaveBeenCalled();
  const deps = makePipeline.mock.calls[0]![0];
  const updateDeps = makeUpdate.mock.calls[0]![0];
  expect(deps.sources).toBe(sources);
  expect(updateDeps.sources).toBe(sources);
  expect(updateDeps.pids).toBe(deps.pids);
});

it('[AC-B1-08q#u9] 未注入 sources：归因与更新都不带 sources（来源四列保持 NULL）', () => {
  const makePipeline = vi.spyOn(pipelinePort, 'createOrderPipeline');
  const makeUpdate = vi.spyOn(updateStep, 'createOrderUpdateStep');
  setup();
  expect('sources' in makePipeline.mock.calls[0]![0]).toBe(false);
  expect('sources' in makeUpdate.mock.calls[0]![0]).toBe(false);
});

it('[AC-B1-09b#u1] 注入 blocklist：工厂在装配时调一次（db、clock），同一黑名单对象交给归因和更新，装配不查库；尾号开关未注入取 false', async () => {
  const makePipeline = vi.spyOn(pipelinePort, 'createOrderPipeline');
  const makeUpdate = vi.spyOn(updateStep, 'createOrderUpdateStep');
  const blocklist = { match: vi.fn(), recordHit: vi.fn() };
  const factory = vi.fn(() => blocklist);
  const s = setup(undefined, { blocklist: factory });
  expect(factory.mock.calls).toEqual([[s.db, s.clock]]);
  expect(s.queries).toEqual([]);
  expect(blocklist.match).not.toHaveBeenCalled();
  const deps = makePipeline.mock.calls[0]![0];
  const updateDeps = makeUpdate.mock.calls[0]![0];
  expect(deps.blacklist).toBeDefined();
  expect(updateDeps.blacklist).toBe(deps.blacklist);
  expect(deps.blacklist?.blocklist).toBe(blocklist);
  expect(await deps.blacklist?.suffixVoidEnabled('unit')).toBe(false);
});

it('[AC-B1-09b#u2] 注入尾号开关读法：按 App 读；未注入 blocklist 时整步不装配', async () => {
  const makePipeline = vi.spyOn(pipelinePort, 'createOrderPipeline');
  const makeUpdate = vi.spyOn(updateStep, 'createOrderUpdateStep');
  const read = vi.fn(async (appId: string) => appId === 'on');
  const suffix = vi.fn(() => read);
  setup(undefined, {
    blocklist: () => ({ match: vi.fn(), recordHit: vi.fn() }),
    suffixVoidEnabled: suffix,
  });
  const deps = makePipeline.mock.calls[0]![0];
  expect(await deps.blacklist?.suffixVoidEnabled('on')).toBe(true);
  expect(await deps.blacklist?.suffixVoidEnabled('off')).toBe(false);
  expect(suffix).toHaveBeenCalledTimes(1);
  makePipeline.mockClear();
  makeUpdate.mockClear();
  setup(undefined, { suffixVoidEnabled: suffix });
  expect('blacklist' in makePipeline.mock.calls[0]![0]).toBe(false);
  expect('blacklist' in makeUpdate.mock.calls[0]![0]).toBe(false);
});

const RIGHTS_IMPORT_JOB = {
  id: 'j-ri',
  queue: 'order-sync',
  name: 'rights_import',
  attempt: 1,
  payload: { app_id: 'unit', import_id: '01890000-0000-7000-8000-00000000000a' },
};

it('[AC-B1-09n#u1] 注入 rebate：工厂在装配时调一次（db、clock、logger、events），同一对象交给归因和更新，装配不查库', () => {
  const pipeline = vi.spyOn(pipelinePort, 'createOrderPipeline');
  const update = vi.spyOn(updateStep, 'createOrderUpdateStep');
  const port = {
    onImported: vi.fn(),
    onUpdated: vi.fn(),
    onUnmappedStatus: vi.fn(),
    onBlacklistHit: vi.fn(),
  };
  const rebate = vi.fn(() => port);
  const s = setup(undefined, { rebate });
  expect(rebate).toHaveBeenCalledTimes(1);
  expect(rebate.mock.calls[0]).toEqual([
    { db: s.db, clock: s.clock, logger: s.logger, events: expect.anything() },
  ]);
  expect(pipeline.mock.calls[0]![0].rebate).toBe(port);
  expect(update.mock.calls[0]![0].rebate).toBe(port);
  expect(s.queries).toEqual([]);
});

it('[AC-B1-09n#u2] 未注入 rebate：归因与更新拿到同一个空端口，没有 onBlacklistHit（命中只记复核）', () => {
  const pipeline = vi.spyOn(pipelinePort, 'createOrderPipeline');
  const update = vi.spyOn(updateStep, 'createOrderUpdateStep');
  setup();
  const rebate = pipeline.mock.calls[0]![0].rebate;
  expect(update.mock.calls[0]![0].rebate).toBe(rebate);
  expect(rebate.onBlacklistHit).toBeUndefined();
});

it('[AC-B1-09n#u3] blocklist 工厂答 undefined（本地与测试没有字段密钥）：第 ③ 步整步不装配', () => {
  const pipeline = vi.spyOn(pipelinePort, 'createOrderPipeline');
  const update = vi.spyOn(updateStep, 'createOrderUpdateStep');
  const blocklist = vi.fn(() => undefined);
  setup(undefined, { blocklist });
  expect(blocklist).toHaveBeenCalledTimes(1);
  expect(pipeline.mock.calls[0]![0].blacklist).toBeUndefined();
  expect(update.mock.calls[0]![0].blacklist).toBeUndefined();
});

it('[AC-B1-09g#u1] rights_import 任务分派到导入处理：读任务行，不调用窗口同步', async () => {
  const store = { put: vi.fn(), get: vi.fn(), delete: vi.fn() };
  const process = vi.fn();
  const s = setup(
    undefined,
    {},
    {
      store,
      templates: { find: vi.fn() },
      processors: { rights: { process } },
    },
  );
  const handler = s.register.mock.calls[0]![1];
  await handler(RIGHTS_IMPORT_JOB);
  expect(s.queries.some((q) => q.includes('"rights_imports"'))).toBe(true);
  expect(s.raws.get('pdd')!.listOrders).not.toHaveBeenCalled();
  expect(store.get).not.toHaveBeenCalled();
  expect(process).not.toHaveBeenCalled();
});

it('[AC-B1-09g#u2] 没有装配 rightsImports：rights_import 任务抛错交队列重试，不查库', async () => {
  const s = setup();
  const handler = s.register.mock.calls[0]![1];
  await expect(handler(RIGHTS_IMPORT_JOB)).rejects.toThrow(/rights_import is not configured/);
  expect(s.queries).toEqual([]);
});

it('[AC-B1-09g#u3] rights_import 的载荷不合：抛错（重试后进死信），不查库', async () => {
  const s = setup(
    undefined,
    {},
    {
      store: { put: vi.fn(), get: vi.fn(), delete: vi.fn() },
      templates: { find: vi.fn() },
      processors: {},
    },
  );
  const handler = s.register.mock.calls[0]![1];
  await expect(
    handler({ ...RIGHTS_IMPORT_JOB, payload: { app_id: 'unit', import_id: 'nope' } }),
  ).rejects.toThrow(/import_id/);
  expect(s.queries).toEqual([]);
});
