// B1-04zzr (D10-798 ③④⑤): the worker's assembly over a compile-only database (no connection, no
// listen), as test/spec/orders/rescan/wiring.test.ts. The worker's account lookup answers null
// without live endpoints, so a routed window ends without fetching: what shows the route is which
// parser accepts or refuses which payload. The tier keys are read through the same rescanConfig port.
import { afterEach, expect, it, vi } from 'vitest';
import { compileOnlyDb } from '../wiring/context-kit.ts';
import { capture } from '../attribution/kit.ts';
import {
  FixedClock,
  createRootLogger,
  type JobHandler,
  type JobPayload,
  type ReceivedJob,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { OrderSyncPayloadError } from '../../../../apps/api/src/modules/orders/jobs/order-sync.ts';
import {
  createOrderSyncRuntime,
  type OrderSyncRuntimeDeps,
} from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import {
  HOUR_ENABLED,
  HOUR_MS,
  NOW,
  NOW_MS,
  PROMO_MODE,
  PROMO_WINDOW_MS,
  WEEK_ENABLED,
  WINDOW_MINUTES,
  tierWindow,
} from './kit.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function named(name: string, payload: JobPayload): ReceivedJob {
  return { id: 'synthetic-tier-wiring-job', queue: 'order-sync', name, payload, attempt: 1 };
}

function harness() {
  const register = vi.fn<(queue: string, handler: JobHandler) => void>();
  const deps: OrderSyncRuntimeDeps = {
    db: compileOnlyDb([]),
    clock: new FixedClock(NOW),
    logger: createRootLogger({ level: 'error', entry: 'worker', appEnv: 'test' }, { write() {} }),
    queue: {
      register,
      send: vi.fn(async () => 'synthetic'),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    },
    events: { publish: vi.fn() },
    endpoints: [],
    registry: { registrations: () => [], get: vi.fn() },
    ports: {
      users: () => ({ findByAttrCode: vi.fn() }),
      bindings: () => ({ findByRelation: vi.fn() }),
      quota: (endpoint) => ({ bucketKey: endpoint.quotaKey, tryAcquire: () => true }),
    },
  };
  return { deps, register };
}

it('[AC-B1-04zzr#34] rescan.window 收淘宝 rescan_hour / rescan_week 载荷（带 timeBasis）交回扫处理器；未知档名与坏 timeBasis 仍校验失败', async () => {
  const { deps, register } = harness();
  const built = await capture(() => createOrderSyncRuntime(deps));
  expect(built).toMatchObject({ ok: true });
  const registrations = register.mock.calls.filter(([queue]) => queue === 'order-sync');
  expect(registrations).toHaveLength(1);
  const handler = registrations[0]![1];

  const hour = tierWindow('rescan_hour', NOW_MS - 2 * HOUR_MS, PROMO_WINDOW_MS, 'pay');
  const week = tierWindow('rescan_week', NOW_MS - 60 * 86_400_000, PROMO_WINDOW_MS, 'pay');
  for (const payload of [hour, week]) {
    expect(
      await capture(() => handler(named('rescan.window', payload))),
      String(payload.query_kind),
    ).toMatchObject({ ok: true });
  }
  const unknownKind = await capture(() =>
    handler(named('rescan.window', { ...hour, query_kind: 'rescan_month' })),
  );
  expect(unknownKind.ok ? null : unknownKind.error).toBeInstanceOf(OrderSyncPayloadError);
  const badBasis = await capture(() =>
    handler(named('rescan.window', { ...hour, timeBasis: 'synthetic-basis' })),
  );
  expect(badBasis.ok ? null : badBasis.error).toBeInstanceOf(OrderSyncPayloadError);
});

it('[AC-B1-04zzr#35] 注入 rescanConfig 后淘宝各档的键经同一端口读：小时档 / 周档开关、window_minutes、promo_mode；停止后不留定时器', async () => {
  vi.useFakeTimers();
  const { deps } = harness();
  const get = vi.fn<(key: string) => Promise<unknown>>(async () => undefined);
  const runtime = createOrderSyncRuntime({
    ...deps,
    ports: { ...deps.ports, rescanConfig: () => ({ get }) },
  });
  const running = runtime.start();
  try {
    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
  } finally {
    await running.stop();
  }
  const asked = new Set(get.mock.calls.map(([key]) => key));
  for (const key of [HOUR_ENABLED, WEEK_ENABLED, WINDOW_MINUTES, PROMO_MODE]) {
    expect(asked.has(key), key).toBe(true);
  }
  expect(vi.getTimerCount()).toBe(0);
});
