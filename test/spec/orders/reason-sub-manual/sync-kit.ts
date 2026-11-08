// B1-09v round 2 (rule-test review r1, S1 ①): a real automatic source for 08 BR-TEXT-05 子原因
// 写入来源 ① next to the manual one (写入来源 ②). The worker entry's AppModule is built as
// ../rights-mounts/kit.ts builds it, and its real createOrderSyncRuntime is called with the deps
// the worker passes, changed in one place only: Taobao gets a synthetic live endpoint and a
// synthetic union adapter whose listPunishments answers the page a test hands it (大淘客
// get-foul-order-list, normalized as UnionPunish with its violation_type text), with a local quota
// that always admits. Everything after the adapter is real: the worker's governed adapter, the
// order-sync handler routing 'punish.window' to the punishment window, the writer (order key lock,
// re-read FOR UPDATE), settlement's rights.record and whatever the automatic mapping (B2-04zze)
// writes there. As in rights-mounts' `sync`, the credential lookup (queryableAccount) answers the
// scenario's union account; demo credentials are never queryable. No real user or merchant data.
// Nothing here imports the implementation's internals beyond the runtime factory the worker calls.
// Only the container runner executes the integration tests.
import { vi } from 'vitest';
import * as workerRuntime from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import type {
  OrderSyncRuntime,
  OrderSyncRuntimeDeps,
} from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import type {
  RegisteredPlatform,
  UnionAdapter,
  UnionEndpoint,
  UnionPunish,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import { NOW, type Harness } from '../../admin/auth/kit.ts';
import { attributedOrder, worker, type Order, type OrderPatch, type Scenario } from './kit.ts';

/** The violation_type text 08 BR-TEXT-05 names for FAKE_TRADE (「订单虚假交易」映射 FAKE_TRADE). */
export const FAKE_TRADE_TEXT = '订单虚假交易';

/** The synthetic Taobao endpoint (never reached: the adapter behind it is synthetic). */
const TAOBAO: UnionEndpoint = {
  platform: 'taobao',
  mode: 'live',
  baseUrl: 'https://taobao-gateway.invalid/router/rest',
  quotaKey: 'synthetic-reason-sub-punish',
};

/** A punish window as the scheduler sends it: [NOW − 30 days, NOW). */
const WINDOW_START = '2026-09-09T02:00:00.000Z';

type ListPunishments = NonNullable<UnionAdapter['listPunishments']>;

/** The worker's deps with Taobao's endpoint, adapter and quota replaced; the rest as passed. */
function withTaobaoPunishments(
  deps: OrderSyncRuntimeDeps,
  adapter: UnionAdapter,
): OrderSyncRuntimeDeps {
  const { registry, ports } = deps;
  return {
    ...deps,
    endpoints: [...deps.endpoints.filter((entry) => entry.platform !== 'taobao'), TAOBAO],
    registry: {
      registrations: () => registry.registrations(),
      get: (platform: RegisteredPlatform) =>
        platform === 'taobao' ? adapter : registry.get(platform),
    },
    ports: {
      ...ports,
      quota: (endpoint, scheduler) =>
        endpoint.platform === 'taobao'
          ? { bucketKey: endpoint.quotaKey, tryAcquire: () => true }
          : ports.quota(endpoint, scheduler),
    },
  };
}

/**
 * The worker entry (../rights-mounts/kit.ts `worker`: imports, settle, sync) whose Taobao adapter
 * has a punishment source; `punish` runs one 'punish.window' of the scenario's Taobao account
 * through the worker's real order-sync handler, its one page being `items`.
 */
export async function punishWorker(h: Harness) {
  const listPunishments = vi.fn<ListPunishments>();
  const adapter: UnionAdapter = {
    platform: 'taobao',
    searchItems: vi.fn(),
    getItem: vi.fn(),
    resolveLink: vi.fn(),
    convert: vi.fn(),
    listOrders: vi.fn(),
    listPunishments,
  };
  const build = workerRuntime.createOrderSyncRuntime;
  const built: OrderSyncRuntime[] = [];
  const spy = vi.spyOn(workerRuntime, 'createOrderSyncRuntime').mockImplementation((deps) => {
    const runtime = build(withTaobaoPunishments(deps, adapter));
    built.push(runtime);
    return runtime;
  });
  const w = await worker(h).finally(() => spy.mockRestore());
  const runtime = built[0];
  if (built.length !== 1 || runtime === undefined) {
    throw new Error(`kit: the worker built ${String(built.length)} order-sync runtimes, not one`);
  }
  return {
    ...w,
    listPunishments,
    async punish(s: Scenario, unionAccountId: string, items: readonly UnionPunish[]) {
      vi.spyOn(runtime.access, 'queryableAccount').mockResolvedValue(unionAccountId);
      listPunishments.mockResolvedValueOnce({ items, nextCursor: null });
      await w.run({
        queue: 'order-sync',
        name: 'punish.window',
        payload: {
          app_id: s.appId,
          platform: 'taobao',
          union_account_id: unionAccountId,
          query_kind: 'punish',
          scene: '-',
          window_start: WINDOW_START,
          window_end: NOW,
        },
      });
    },
  };
}
export type PunishWorker = Awaited<ReturnType<typeof punishWorker>>;

/** A Taobao sub-order attributed to the scenario's user (ESTIMATED, PAID unless patched). */
export function taobaoOrder(s: Scenario, patch: OrderPatch = {}): Promise<Order> {
  return attributedOrder(s, { platform: 'taobao', product_key: 'taobao:fixture', ...patch });
}

/** The union's punishment of `order` (大淘客 has no deduction amount), with its violation text. */
export function punishmentOf(
  order: Order,
  punishmentId: string,
  violationType: string,
): UnionPunish {
  return {
    order_id: order.sub_order_id,
    punishment_id: punishmentId,
    deduction_fen: null,
    punish_status: '0',
    violation_type: violationType,
    settle_month: '2026-10',
  };
}
