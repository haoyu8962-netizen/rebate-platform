// money r1 S2 ①（编排 D10-699 第 3 条）：淘宝没配大淘客订单源时不投 rights / punish 任务。
// union/infra/registry.ts 只在 taobaoLive.orderSource 给出时把 DataokeClient 交给 TaobaoUnionAdapter；没有它，
// 适配器与包装层照旧带着 listRefunds / listPunishments 方法，只是一调用就 adapter_unimplemented、不发请求（冻结
// [AC-B1-04z#70]）。所以「有没有方法」不足以判来源：这种平台既不投维权 / 违规窗（增量、回扫都不投），也不起
// 维权定时器（同 [AC-B1-04zza#19] / #41「没有来源不起」）；配了订单源的同一适配器照投、照起（对照）。
// 适配器是真实的 TaobaoUnionAdapter（test/spec/union/taobao-refunds/kit.ts 的夹具，传输层是假的、不联网），
// 调度看到的是 worker 用的包装层（createGovernedSyncAdapter）。
import { afterEach, expect, it, vi } from 'vitest';
import {
  scheduleRightsRescan,
  scheduleRightsSync,
} from '../../../../apps/api/src/modules/orders/application/rights-sync.ts';
import * as workerRuntime from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import type { OrderSyncRuntimeDeps } from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import {
  FixedClock,
  createRootLogger,
  type JobHandler,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createGovernedSyncAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import type {
  RegisteredPlatform,
  UnionAdapter,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  endpoint,
  refundOf,
  refundPage,
  scheduler,
  setup,
} from '../../union/taobao-refunds/kit.ts';
import { compileOnlyDb } from '../wiring/context-kit.ts';
import { HOUR_MS, INCREMENT, NOW, NOW_MS, PUNISH_JOB, RIGHTS_JOB, fixture, iso } from './kit.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** A live Taobao adapter with or without the 大淘客 order source (fake transport, no network). */
function taobao(source: boolean) {
  return setup(refundPage([refundOf(1)]), { source });
}

/** The scheduler fixture whose Taobao entry is the governed real adapter. */
function governedFixture(source: boolean) {
  const s = taobao(source);
  const { adapter } = createGovernedSyncAdapter(s.adapter, {
    endpoint,
    scheduler,
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: () => true },
  });
  const f = fixture({ cursors: { [INCREMENT]: iso(NOW_MS - 10 * HOUR_MS) } });
  f.get.mockImplementation((platform) => {
    if (platform !== 'taobao') throw new Error(`union: no endpoint for ${platform}`);
    return adapter;
  });
  return { f, s };
}

it('[AC-B1-04zza#47] 淘宝没配大淘客订单源：调度轮与回扫都不投 rights.window / punish.window，不取数；配了订单源的同一适配器照投', async () => {
  const sourced = governedFixture(true);
  await scheduleRightsSync(sourced.f.scheduler);
  await scheduleRightsRescan(sourced.f.scheduler);
  expect(sourced.f.sent().map((call) => [call.name, call.payload['scene']])).toEqual(
    expect.arrayContaining([
      [RIGHTS_JOB, '-'],
      [PUNISH_JOB, '-'],
      [RIGHTS_JOB, 'rescan'],
    ]),
  );
  // 调度只投递，不取数。
  expect(sourced.s.transport).not.toHaveBeenCalled();

  const bare = governedFixture(false);
  await expect(scheduleRightsSync(bare.f.scheduler)).resolves.toBeUndefined();
  await expect(scheduleRightsRescan(bare.f.scheduler)).resolves.toBeUndefined();
  expect(bare.f.send).not.toHaveBeenCalled();
  expect(bare.f.advance).not.toHaveBeenCalled();
  expect(bare.f.rewind).not.toHaveBeenCalled();
  expect(bare.s.transport).not.toHaveBeenCalled();
  expect(bare.s.dataokeCredentials).not.toHaveBeenCalled();
});

/** Worker deps (compile-only database, no network) whose only adapter is `adapter` for taobao. */
function runtimeDeps(adapter: UnionAdapter, rightsSync: boolean): OrderSyncRuntimeDeps {
  return {
    db: compileOnlyDb([]),
    clock: new FixedClock(NOW),
    logger: createRootLogger({ level: 'error', entry: 'worker', appEnv: 'test' }, { write() {} }),
    queue: {
      register: vi.fn<(queue: string, handler: JobHandler) => void>(),
      send: vi.fn(async () => 'synthetic'),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    },
    events: { publish: vi.fn() },
    endpoints: [endpoint],
    registry: {
      registrations: () => [],
      get: vi.fn((platform: RegisteredPlatform) => {
        if (platform !== 'taobao') throw new Error(`union: no adapter for ${platform}`);
        return adapter;
      }),
    },
    ports: {
      users: () => ({ findByAttrCode: vi.fn() }),
      bindings: () => ({ findByRelation: vi.fn() }),
      quota: (entry) => ({ bucketKey: entry.quotaKey, tryAcquire: () => true }),
      ...(rightsSync ? { rightsSync: () => ({ record: vi.fn() }) } : {}),
    },
  };
}

/** The timers of a started runtime, then stopped: none may be left. */
async function armedTimers(deps: OrderSyncRuntimeDeps): Promise<number> {
  const running = workerRuntime.createOrderSyncRuntime(deps).start();
  await vi.advanceTimersByTimeAsync(0);
  const armed = vi.getTimerCount();
  await running.stop();
  expect(vi.getTimerCount()).toBe(0);
  return armed;
}

it('[AC-B1-04zza#48] worker 注入 rightsSync：淘宝没配大淘客订单源时不多起维权定时器（同未注入）；配了订单源才多起', async () => {
  vi.useFakeTimers();
  const baseline = await armedTimers(runtimeDeps(taobao(false).adapter, false));
  expect(await armedTimers(runtimeDeps(taobao(true).adapter, true))).toBeGreaterThan(baseline);
  expect(await armedTimers(runtimeDeps(taobao(false).adapter, true))).toBe(baseline);
});
