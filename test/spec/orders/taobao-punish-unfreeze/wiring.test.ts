// 生产装配（任务书 9.2 第 7 条；参照 ../taobao-rights-sync/wiring.test.ts 的看法）：order-sync worker 注入
// rightsSync（settlement 的 rights.record）后，punish.window 的处理器依赖里必须带真实的待处理写入——写的是
// app.order_sync_pending（订单模块自己的表，装配时不读库）。数据库是只编译不连接的 DummyDriver（不连库、不监听
// 端口）；处理器本身被替身接住，这里只看 worker-runtime 交给它的依赖。
import { afterEach, expect, it, vi } from 'vitest';
import { compileOnlyDb } from '../wiring/context-kit.ts';
import {
  FixedClock,
  createRootLogger,
  type JobHandler,
  type ReceivedJob,
} from '../../../../apps/api/src/modules/platform/index.ts';
import * as rightsSyncJobs from '../../../../apps/api/src/modules/orders/jobs/rights-sync.ts';
import type { RightsSyncHandlerDeps } from '../../../../apps/api/src/modules/orders/jobs/rights-sync.ts';
import * as workerRuntime from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import type { OrderSyncRuntimeDeps } from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import type {
  RegisteredPlatform,
  UnionAdapter,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import { NOW, PUNISH_JOB, punishWindow, signalOf, unfrozen } from './kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeAdapter(): UnionAdapter {
  const empty = async () => ({ items: [], nextCursor: null });
  return {
    platform: 'taobao',
    searchItems: vi.fn(),
    getItem: vi.fn(),
    resolveLink: vi.fn(),
    convert: vi.fn(),
    listOrders: vi.fn(),
    listRefunds: vi.fn(empty),
    listPunishments: vi.fn(empty),
  };
}

/** A worker runtime over a compile-only db, with settlement's rights.record injected. */
function harness() {
  const queries: string[] = [];
  const db = compileOnlyDb(queries);
  const register = vi.fn<(queue: string, handler: JobHandler) => void>();
  const adapter = fakeAdapter();
  const deps: OrderSyncRuntimeDeps = {
    db,
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
      quota: (endpoint) => ({ bucketKey: endpoint.quotaKey, tryAcquire: () => true }),
      rightsSync: () => ({ record: vi.fn() }),
    },
  };
  return { deps, register, queries };
}

function punishJob(): ReceivedJob {
  return {
    id: 'synthetic-unfreeze-wiring-job',
    queue: 'order-sync',
    name: PUNISH_JOB,
    payload: punishWindow(),
    attempt: 1,
  };
}

/** The deps worker-runtime hands handlePunishWindow for one punish.window job. */
async function punishDeps(): Promise<{ deps: RightsSyncHandlerDeps; queries: string[] }> {
  const seen = vi.spyOn(rightsSyncJobs, 'handlePunishWindow').mockResolvedValue(undefined);
  const h = harness();
  workerRuntime.createOrderSyncRuntime(h.deps);
  const registrations = h.register.mock.calls.filter(([queue]) => queue === 'order-sync');
  expect(registrations).toHaveLength(1);
  await registrations[0]![1](punishJob());
  expect(seen).toHaveBeenCalledTimes(1);
  return { deps: seen.mock.calls[0]![1], queries: h.queries };
}

it('[AC-B1-04zzab#12] 生产装配：注入 rightsSync 后 punish.window 的处理器依赖带待处理写入端口', async () => {
  const { deps } = await punishDeps();
  expect(deps.pending).toBeDefined();
  expect(typeof deps.pending?.record).toBe('function');
});

it('[AC-B1-04zzab#13] 生产装配的待处理写入是真实的：一条解冻信号写进 app.order_sync_pending（同键 open 冲突由唯一索引处理），装配本身不读库', async () => {
  const { deps, queries } = await punishDeps();
  expect(queries).toEqual([]);
  const pending = deps.pending;
  expect(pending).toBeDefined();
  await pending!.record(signalOf(unfrozen(1), 'UNFREEZE_SIGNAL', '1'));
  const inserts = queries.filter((q) => /insert into ("app"\.)?"order_sync_pending"/i.test(q));
  expect(inserts).toHaveLength(1);
  expect(inserts[0]).toMatch(/on conflict/i);
  expect(queries.some((q) => /"order_rights"/i.test(q))).toBe(false);
  expect(queries.some((q) => /"ledger_entries"/i.test(q))).toBe(false);
  expect(queries.some((q) => /update ("app"\.)?"orders"/i.test(q))).toBe(false);
});
