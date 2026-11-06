// worker 装配（任务书第 9 节第 6、7 条）：照 rescanConfig 可选注入——ports.rightsSync（settlement 的
// rights.record）未注入或答 undefined 时不起维权 / 违规定时器；注入时只给适配器有 listRefunds /
// listPunishments 的平台起（按能力，不看平台名），停止后不留定时器；'rights.window' / 'punish.window' 路由到
// 维权处理器，原有任务照旧。生产 worker（app.module）注入 rightsSync。
// 数据库是只编译不连接的 DummyDriver（不连库、不监听端口）；没有 live 端点时可查账号答 null，路由到的任务
// 不取数就结束：看的是哪个解析器收下、哪个拒绝。
import { afterEach, expect, it, vi } from 'vitest';
import { compileOnlyDb, contextOf, runtime } from '../wiring/context-kit.ts';
import { capture } from '../attribution/kit.ts';
import { fakePort } from '../commission-snapshot/db-kit.ts';
import {
  FixedClock,
  createRootLogger,
  type JobHandler,
  type JobPayload,
  type ReceivedJob,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { OrderSyncPayloadError } from '../../../../apps/api/src/modules/orders/jobs/order-sync.ts';
import * as workerRuntime from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import type { OrderSyncRuntimeDeps } from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import type {
  RegisteredPlatform,
  UnionAdapter,
  UnionEndpoint,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  HOUR_MS,
  JD_ACCOUNT,
  NOW,
  NOW_MS,
  PUNISH_JOB,
  RIGHTS_JOB,
  iso,
  punishWindow,
  rightsWindow,
} from './kit.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const BRANCHES = [
  { label: '未注入 snapshots', withSnapshots: false },
  { label: '注入 snapshots', withSnapshots: true },
];

const taobaoEndpoint: UnionEndpoint = {
  platform: 'taobao',
  mode: 'live',
  baseUrl: 'https://taobao-gateway.invalid/router/rest',
  quotaKey: 'synthetic-taobao-rights-sync',
};

/** A synthetic adapter; `rights` decides whether it offers listRefunds / listPunishments. */
function fakeAdapter(rights: boolean): UnionAdapter {
  const empty = async () => ({ items: [], nextCursor: null });
  return {
    platform: 'taobao',
    searchItems: vi.fn(),
    getItem: vi.fn(),
    resolveLink: vi.fn(),
    convert: vi.fn(),
    listOrders: vi.fn(),
    ...(rights ? { listRefunds: vi.fn(empty), listPunishments: vi.fn(empty) } : {}),
  };
}

function harness(options: {
  readonly endpoints: readonly UnionEndpoint[];
  readonly rights: boolean;
}) {
  const register = vi.fn<(queue: string, handler: JobHandler) => void>();
  const adapter = fakeAdapter(options.rights);
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
    endpoints: options.endpoints,
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
    },
  };
  return { deps, register };
}

function withRightsSync(deps: OrderSyncRuntimeDeps, answer: 'port' | 'undefined') {
  return {
    ...deps,
    ports: {
      ...deps.ports,
      rightsSync: () => (answer === 'port' ? { record: vi.fn() } : undefined),
    },
  } satisfies OrderSyncRuntimeDeps;
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

function named(name: string, payload: JobPayload): ReceivedJob {
  return { id: 'synthetic-rights-wiring-job', queue: 'order-sync', name, payload, attempt: 1 };
}

it.each(BRANCHES)(
  '[AC-B1-04zza#41] $label：注入 rightsSync 且平台有维权来源才多出定时器；未注入、答 undefined、没有来源都不多',
  async ({ withSnapshots }) => {
    vi.useFakeTimers();
    const plain = (rights: boolean): OrderSyncRuntimeDeps => {
      const { deps } = harness({ endpoints: [taobaoEndpoint], rights });
      return withSnapshots ? { ...deps, snapshots: fakePort() } : deps;
    };
    const baseline = await armedTimers(plain(true));
    expect(await armedTimers(withRightsSync(plain(true), 'port'))).toBeGreaterThan(baseline);
    expect(await armedTimers(withRightsSync(plain(true), 'undefined'))).toBe(baseline);
    expect(await armedTimers(withRightsSync(plain(false), 'port'))).toBe(baseline);
    expect(await armedTimers(plain(false))).toBe(baseline);
  },
);

it.each(BRANCHES)(
  '[AC-B1-04zza#42] $label：注入 rightsSync 后 rights.window / punish.window 走维权处理器，增量窗照旧',
  async ({ withSnapshots }) => {
    const { deps, register } = harness({ endpoints: [], rights: true });
    const wired = withRightsSync(withSnapshots ? { ...deps, snapshots: fakePort() } : deps, 'port');
    const built = await capture(() => workerRuntime.createOrderSyncRuntime(wired));
    expect(built).toMatchObject({ ok: true });
    const registrations = register.mock.calls.filter(([queue]) => queue === 'order-sync');
    expect(registrations).toHaveLength(1);
    const handler = registrations[0]![1];

    const rights = rightsWindow(iso(NOW_MS - 10 * HOUR_MS), {
      platform: 'jd',
      union_account_id: JD_ACCOUNT,
    });
    const punish = punishWindow({ platform: 'jd', union_account_id: JD_ACCOUNT });
    const increment = { ...rights, query_kind: 'increment' };

    // 维权解析器收下 rights 窗（可查账号为 null，不取数就结束）。
    expect(await capture(() => handler(named(RIGHTS_JOB, rights)))).toMatchObject({ ok: true });
    // 维权解析器拒绝别的 query_kind：增量解析器会收下这一份，所以拒绝说明走的是维权处理器。
    const wrongKind = await capture(() => handler(named(RIGHTS_JOB, increment)));
    expect(wrongKind.ok ? null : wrongKind.error).toBeInstanceOf(OrderSyncPayloadError);

    expect(await capture(() => handler(named(PUNISH_JOB, punish)))).toMatchObject({ ok: true });
    const punishAsRights = await capture(() =>
      handler(named(PUNISH_JOB, { ...punish, query_kind: 'rights' })),
    );
    expect(punishAsRights.ok ? null : punishAsRights.error).toBeInstanceOf(OrderSyncPayloadError);

    // 原有的增量窗照旧由增量处理器收下。
    expect(await capture(() => handler(named('window', increment)))).toMatchObject({ ok: true });
    const rightsAsWindow = await capture(() => handler(named('window', rights)));
    expect(rightsAsWindow.ok ? null : rightsAsWindow.error).toBeInstanceOf(OrderSyncPayloadError);
  },
);

it('[AC-B1-04zza#43] 生产 worker 入口（app.module）给订单同步注入 rightsSync', async () => {
  const build = vi.spyOn(workerRuntime, 'createOrderSyncRuntime');
  const f = await contextOf('worker', true);
  try {
    await runtime(f.context);
    expect(build).toHaveBeenCalledTimes(1);
    const deps = build.mock.calls[0]![0];
    expect(typeof deps.ports.rightsSync).toBe('function');
  } finally {
    await f.context.close();
  }
});
