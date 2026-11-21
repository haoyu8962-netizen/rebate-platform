// 生产装配的全流程（任务书 9.2 第 7 条、11.2 第 1 条；08 BR-FUND-22 决-06 实测前 A、BR-FUND-02）：
// createOrderSyncRuntime 注册到 order-sync 队列的处理器，经生产装配的治理包装（分页、配额、熔断）、真实的写入方
// （createRightsSyncWriter，settlement 的 rights.record 是只记调用的替身）和真实的待处理写入，实际消费两页
// 数据——冻结（'0'）、解冻（'1'）、表外值（'2'）各一条。只有联盟适配器换成返回这两页的假实现（不联网）；处理器、
// 分页包装、待处理写入一个都不替换。同一次任务里：解冻与表外值各写一条参数正确的 open 待处理、各发一条 warn，
// 冻结那条交给了写入方，解冻与表外值没有交给写入方；日志不带订单号、违规单号与金额。
// 本文件的库里只有一个淘宝联盟账号（可查账号按全库唯一一行判定），所以只有一条用例。
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { RightsCommandPort } from '../../../../apps/api/src/modules/orders/application/rights-ports.ts';
import * as workerRuntime from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import type { OrderSyncRuntimeDeps } from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import {
  FixedClock,
  createRootLogger,
  type JobHandler,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  Page,
  RegisteredPlatform,
  UnionAdapter,
  UnionEndpoint,
  UnionPunish,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  newAppId,
  open,
  pendingOf,
  rightsOf,
  seedOrder,
  unfreezeRow,
  windowOf,
  type Harness,
} from './db-kit.ts';
import {
  AMOUNT_KEY,
  DONE_EVENT,
  MARKED_FEN,
  NOW,
  PUNISH_JOB,
  UNFREEZE_COUNT,
  UNFREEZE_EVENT,
  UNMAPPED_COUNT,
  UNMAPPED_EVENT,
  job,
  keysOf,
  leaves,
  markersOf,
} from './kit.ts';

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
  quotaKey: 'synthetic-taobao-unfreeze',
};

/** pino levels. */
const INFO = 30;
const WARN = 40;

interface Line {
  readonly level: number;
  readonly msg: string;
  readonly [field: string]: unknown;
}

it('[AC-B1-04zzab#24] 生产 worker 注册的 punish.window 处理器实际消费两页（冻结、解冻、表外值）：同一次任务里解冻与表外值各写一条参数正确的 open 待处理、各发一条 warn，冻结交给写入方，解冻与表外值不交', async () => {
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
  const frozenOrder = await seedOrder(h.db, appId);
  const unfrozenOrder = await seedOrder(h.db, appId);
  const oddOrder = await seedOrder(h.db, appId);
  const frozenRow = unfreezeRow(frozenOrder.sub_order_id, { punish_status: '0' });
  const unfrozenRow = unfreezeRow(unfrozenOrder.sub_order_id, { deduction_fen: MARKED_FEN });
  const oddRow = unfreezeRow(oddOrder.sub_order_id, { punish_status: '2' });
  const pages: readonly (readonly UnionPunish[])[] = [[frozenRow, unfrozenRow], [oddRow]];

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
    events: { publish: vi.fn() },
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
  const rightsBefore = await rightsOf(h.db, appId);

  await expect(
    handler(job(PUNISH_JOB, { ...windowOf(appId), union_account_id: accountId })),
  ).resolves.toBeUndefined();

  // The production paging wrapper read both pages.
  expect(listPunishments).toHaveBeenCalledTimes(2);

  // Only the frozen row reached settlement's rights.record, through the production writer.
  expect(
    record.mock.calls.map(([, input]) => [
      input.order_id,
      input.type,
      input.status,
      input.platform_rights_no,
      input.occurred_at,
    ]),
  ).toEqual([
    [frozenOrder.order_id, 'PUNISH', 'SUCCEEDED', frozenRow.punishment_id, new Date(NOW)],
  ]);
  expect(await rightsOf(h.db, appId)).toEqual(rightsBefore);

  // One open record each, written by the production recorder.
  const pending = await pendingOf(h.db, appId);
  expect(
    pending
      .map((p) => ({
        app_id: p.app_id,
        platform: p.platform,
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
      app_id: appId,
      platform: 'taobao',
      sub_order_id: unfrozenOrder.sub_order_id,
      order_id: unfrozenOrder.order_id,
      reason: 'UNFREEZE_SIGNAL',
      raw_status: '1',
      status: 'open',
      detected_at: new Date(NOW),
    },
    {
      app_id: appId,
      platform: 'taobao',
      sub_order_id: oddOrder.sub_order_id,
      order_id: oddOrder.order_id,
      reason: 'UNMAPPED_STATUS',
      raw_status: '2',
      status: 'open',
      detected_at: new Date(NOW),
    },
  ]);

  // One warn of each kind and the window-end line, from the production logger.
  const parsed = lines.map((line) => JSON.parse(line) as Line);
  const unfreezeWarns = parsed.filter((l) => l.msg === UNFREEZE_EVENT);
  const unmappedWarns = parsed.filter((l) => l.msg === UNMAPPED_EVENT);
  const done = parsed.filter((l) => l.msg === DONE_EVENT);
  expect(unfreezeWarns.map((l) => l.level)).toEqual([WARN]);
  expect(unmappedWarns.map((l) => l.level)).toEqual([WARN]);
  expect(unfreezeWarns[0]).toMatchObject({ [UNFREEZE_COUNT]: 1 });
  expect(unmappedWarns[0]).toMatchObject({ [UNMAPPED_COUNT]: 1 });
  expect(done.map((l) => l.level)).toEqual([INFO]);
  expect(done[0]).toMatchObject({
    pages: 2,
    applied: 1,
    [UNFREEZE_COUNT]: 1,
    [UNMAPPED_COUNT]: 1,
    unknown_status: 0,
  });

  const markers = [...markersOf([frozenRow, unfrozenRow, oddRow]), MARKED_FEN.toString()];
  for (const line of [...unfreezeWarns, ...unmappedWarns, ...done]) {
    expect(leaves(line).filter((leaf) => markers.some((m) => leaf.includes(m)))).toEqual([]);
    expect(keysOf(line).filter((key) => AMOUNT_KEY.test(key))).toEqual([]);
  }
});
