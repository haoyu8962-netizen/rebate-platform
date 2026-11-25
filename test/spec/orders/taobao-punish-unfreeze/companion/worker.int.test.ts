// B1-04zzac 伴随测试（FU-B1-04ZZAB-SPEC-R3-GAP；08 BR-FUND-22 决-06 实测前 A、BR-FUND-02；编排 D10-3221 ②）：
// 生产 worker 注册到 order-sync 队列的 punish.window 处理器（createOrderSyncRuntime，写法同 ../worker.int.test.ts，
// 其 kit 只读引用），经生产装配的治理包装、真实写入方（settlement 的 rights.record 是只记调用的替身）和真实待处理
// 写入，消费一页数据：两张已付款未收货订单（platform_status PAID、rebate_status ESTIMATED）分别收到 punish_status
// 1（解冻）与 2（表外值）。跑完读回：两张订单的 platform_status、rebate_status 与金额列不变（hold 不判，D10-3221
// 另登 FU-PUNISH-UNMAPPED-HOLD-SCOPE）；各写一条对应原因的 open 待处理；没有处罚写入（rights.record 没被调用、
// order_rights 无新行），没有状态迁移，没有点名它们的失效 / 处罚事件（事件表里没有，任务执行期间经
// events.publish 替身新增的调用里，payload 点名这两张订单的也没有失效 / 处罚类事件）。
// 本文件的库里只有一个淘宝联盟账号（可查账号按全库唯一一行判定），所以只有一条用例。会抛的调用先 settle 再判。
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { RightsCommandPort } from '../../../../../apps/api/src/modules/orders/application/rights-ports.ts';
import * as workerRuntime from '../../../../../apps/api/src/modules/orders/worker-runtime.ts';
import type { OrderSyncRuntimeDeps } from '../../../../../apps/api/src/modules/orders/worker-runtime.ts';
import {
  FixedClock,
  createRootLogger,
  type EventBus,
  type JobHandler,
} from '../../../../../apps/api/src/modules/platform/index.ts';
import type {
  Page,
  RegisteredPlatform,
  UnionAdapter,
  UnionEndpoint,
  UnionPunish,
} from '../../../../../apps/api/src/modules/union/domain/types.ts';
import {
  newAppId,
  open,
  pendingOf,
  rightsOf,
  seedOrder,
  seedUser,
  trailOf,
  unfreezeRow,
  windowOf,
  type Harness,
  type Order,
  type Trail,
} from '../db-kit.ts';
import {
  NOW,
  PUNISH_JOB,
  UNFREEZE_COUNT,
  UNFREEZE_EVENT,
  UNMAPPED_COUNT,
  UNMAPPED_EVENT,
  job,
  leaves,
} from '../kit.ts';

let database: TestDatabase | undefined;
let h: Harness;
beforeAll(async () => {
  database = await createTestDatabase();
  h = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    await database?.drop();
  }
}, 30_000);

const taobaoEndpoint: UnionEndpoint = {
  platform: 'taobao',
  mode: 'live',
  baseUrl: 'https://taobao-gateway.invalid/router/rest',
  quotaKey: 'synthetic-taobao-unfreeze-companion',
};

/** pino warn level. */
const WARN = 40;

interface Line {
  readonly level: number;
  readonly msg: string;
  readonly [field: string]: unknown;
}

/** A run's outcome, read after it settles (no .resolves / .rejects). */
async function settle(run: Promise<void>): Promise<PromiseSettledResult<void>> {
  const [out] = await Promise.allSettled([run] as const);
  return out;
}

/** platform_status, rebate_status and every amount column (`*_fen`) of each order, by order_id. */
function moneyStateOf(trail: Trail) {
  return trail.orders.map((o) => ({
    order_id: o.order_id,
    platform_status: o.platform_status,
    rebate_status: o.rebate_status,
    amounts: Object.entries(o).filter(([key]) => key.endsWith('_fen')),
  }));
}

/** A paid, not yet received order of a member (platform_status PAID, rebate_status ESTIMATED). */
async function seedPaidOrder(appId: string): Promise<Order> {
  const userId = await seedUser(h.db, appId);
  return seedOrder(h.db, appId, {
    platform_status: 'PAID',
    rebate_status: 'ESTIMATED',
    user_id: userId,
    received_at: null,
    settle_period: null,
  });
}

it('[AC-B1-04zzac#13] 生产 worker 注册的 punish.window 处理器：两张已付款未收货订单（PAID / ESTIMATED）分别收到 punish_status 1 与 2，platform_status、rebate_status 与金额列不变，各写一条对应原因的 open 待处理，没有处罚写入（order_rights 无新行）与失效事件', async () => {
  const appId = newAppId();
  const accountId = randomUUID();
  await h.db
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: appId,
      platform: 'taobao',
      account_name: 'synthetic',
      status: 'pending',
      auth_status: 'active',
      auth_expires_at: null,
      sync_start_at: new Date('2026-10-01T00:00:00.000Z'),
      created_at: new Date('2026-09-01T00:00:00.000Z'),
      updated_at: new Date('2026-09-01T00:00:00.000Z'),
    })
    .execute();
  const unfrozenOrder = await seedPaidOrder(appId);
  const oddOrder = await seedPaidOrder(appId);
  const unfrozenRow = unfreezeRow(unfrozenOrder.sub_order_id, { punish_status: '1' });
  const oddRow = unfreezeRow(oddOrder.sub_order_id, { punish_status: '2' });
  const pages: readonly (readonly UnionPunish[])[] = [[unfrozenRow, oddRow]];

  const listPunishments = vi.fn<NonNullable<UnionAdapter['listPunishments']>>(
    async (_win, _ctx, opt): Promise<Page<UnionPunish>> => {
      const index = opt?.cursor === undefined ? 0 : Number(opt.cursor.replace('page-', ''));
      return {
        items: pages[index] ?? [],
        nextCursor: index + 1 < pages.length ? `page-${index + 1}` : null,
      };
    },
  );
  const adapter: UnionAdapter = {
    platform: 'taobao',
    searchItems: vi.fn(),
    getItem: vi.fn(),
    resolveLink: vi.fn(),
    convert: vi.fn(),
    listOrders: vi.fn(),
    listRefunds: vi.fn(async () => ({ items: [], nextCursor: null })),
    listPunishments,
  };
  const record = vi.fn<RightsCommandPort['record']>(async () => ({ kind: 'applied' }));
  const lines: string[] = [];
  const register = vi.fn<(queue: string, handler: JobHandler) => void>();
  const publish = vi.fn<EventBus['publish']>();
  const deps: OrderSyncRuntimeDeps = {
    db: h.db,
    clock: new FixedClock(NOW),
    logger: createRootLogger(
      { level: 'info', entry: 'worker', appEnv: 'test' },
      {
        write(line: string) {
          lines.push(line);
        },
      },
    ),
    queue: {
      register,
      send: vi.fn(async () => 'synthetic'),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    },
    events: { publish },
    endpoints: [taobaoEndpoint],
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
      rightsSync: () => ({ record }),
    },
  };
  workerRuntime.createOrderSyncRuntime(deps);
  const registrations = register.mock.calls.filter(([queue]) => queue === 'order-sync');
  expect(registrations).toHaveLength(1);
  const handler = registrations[0]![1];
  const orders = [unfrozenOrder, oddOrder];
  const before = await trailOf(h.db, appId, orders);
  expect(await rightsOf(h.db, appId)).toEqual([]);
  expect(await pendingOf(h.db, appId)).toEqual([]);
  const publishesBefore = publish.mock.calls.length;

  const out = await settle(
    handler(job(PUNISH_JOB, { ...windowOf(appId), union_account_id: accountId })),
  );
  expect(out.status).toBe('fulfilled');
  expect(listPunishments).toHaveBeenCalledTimes(1);

  // Both orders: platform_status, rebate_status and the amount columns as they were.
  const after = await trailOf(h.db, appId, orders);
  const state = moneyStateOf(after);
  expect(state.map((o) => o.platform_status)).toEqual(['PAID', 'PAID']);
  expect(state.map((o) => o.rebate_status)).toEqual(['ESTIMATED', 'ESTIMATED']);
  expect(state).toEqual(moneyStateOf(before));

  // No punishment written: settlement's rights.record never called, no order_rights row.
  expect(record).not.toHaveBeenCalled();
  expect(await rightsOf(h.db, appId)).toEqual([]);
  expect(after.rights).toEqual([]);

  // No status transition and no invalid / punish event naming them.
  expect(after.history).toEqual([]);
  const eventTexts = after.events.map((e) => `${e.name} ${JSON.stringify(e.payload)}`);
  expect(eventTexts.filter((text) => /invalid|punish/i.test(text))).toEqual([]);

  // Nor through the events.publish stand-in during the run: of the calls added while the job ran,
  // those whose payload names either order (order_id or sub_order_id) carry no invalid / punish
  // event (e.g. order.invalidated, or an order.updated moving it to INVALID / VOID).
  const markers = orders.flatMap((o) => [o.order_id, o.sub_order_id]);
  const names = (leaf: string) => markers.some((m) => leaf.includes(m));
  const naming = publish.mock.calls
    .slice(publishesBefore)
    .map(([, event]) => event)
    .filter((event) => leaves(event.payload).some(names));
  expect(
    naming
      .map((event) => `${event.name} ${leaves(event.payload).join(' ')}`)
      .filter((text) => /invalid|punish|void|claw/i.test(text)),
  ).toEqual([]);

  // One open record each, of the matching reason, by the production recorder.
  const pending = await pendingOf(h.db, appId);
  expect(
    pending
      .map((p) => ({
        sub_order_id: p.sub_order_id,
        order_id: p.order_id,
        reason: p.reason,
        raw_status: p.raw_status,
        status: p.status,
        detected_at: p.detected_at,
      }))
      .sort((a, b) => a.reason.localeCompare(b.reason)),
  ).toEqual([
    {
      sub_order_id: unfrozenOrder.sub_order_id,
      order_id: unfrozenOrder.order_id,
      reason: 'UNFREEZE_SIGNAL',
      raw_status: '1',
      status: 'open',
      detected_at: new Date(NOW),
    },
    {
      sub_order_id: oddOrder.sub_order_id,
      order_id: oddOrder.order_id,
      reason: 'UNMAPPED_STATUS',
      raw_status: '2',
      status: 'open',
      detected_at: new Date(NOW),
    },
  ]);

  // One warn of each kind, from the production logger.
  const parsed = lines.map((line) => JSON.parse(line) as Line);
  const unfreezeWarns = parsed.filter((l) => l.msg === UNFREEZE_EVENT);
  const unmappedWarns = parsed.filter((l) => l.msg === UNMAPPED_EVENT);
  expect(unfreezeWarns.map((l) => l.level)).toEqual([WARN]);
  expect(unmappedWarns.map((l) => l.level)).toEqual([WARN]);
  expect(unfreezeWarns[0]).toMatchObject({ [UNFREEZE_COUNT]: 1 });
  expect(unmappedWarns[0]).toMatchObject({ [UNMAPPED_COUNT]: 1 });
});
