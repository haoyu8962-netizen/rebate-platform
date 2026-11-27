import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createOrderPipeline,
  type OrderPipelineContext,
} from '../../../../apps/api/src/modules/orders/application/pipeline-port.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createUnionOrderReaders,
  type UnionOrder,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  requireTaobaoOrder,
  TaobaoRawNumber,
} from '../../../../apps/api/src/modules/union/infra/taobao/orders.ts';
import { at, capture, NOW, order, snapshot } from '../attribution/kit.ts';
import { account, built, pid, START } from '../wiring/db-kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

const SITE = '3001';
const ADZONE = '2002';
const TAOBAO_PID = 'mm_1001_3001_2002';

function taobaoOrder(tradeId: string, site: string, paidTime: string) {
  return built(() =>
    requireTaobaoOrder(
      {
        trade_id: tradeId,
        item_id: 'synthetic-item',
        adzone_id: new TaobaoRawNumber(ADZONE),
        site_id: new TaobaoRawNumber(site),
        tk_status: new TaobaoRawNumber('12'),
        tk_paid_time: paidTime,
        alipay_total_price: '100.00',
        pub_share_pre_fee: '10.00',
        pub_share_pre_fee_for_commission: '10.00',
        alimama_share_fee: '1.00',
      },
      { rawPayloadId: null, like: at(NOW) },
      undefined,
    ),
  );
}

async function harness() {
  const paid = { event: 'PLATFORM_PAID', source: 'synthetic', verified: false, note: '' } as const;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const readers = await built(() => createUnionOrderReaders(db));
  const pipeline = await built(() =>
    createOrderPipeline({
      db,
      clock: new FixedClock(NOW),
      statusMaps: (platform) => ({
        platform,
        entries: new Map([
          ['12', paid],
          ['paid', paid],
        ]),
      }),
      ...readers,
      users: { findByAttrCode: async () => null },
      bindings: { findByRelation: async () => [] },
      rebate: { onImported: async () => undefined },
      logger,
    }),
  );
  return {
    process(
      platform: OrderPipelineContext['platform'],
      incoming: UnionOrder,
      acc: Awaited<ReturnType<typeof account>>,
      windowStart = START,
    ) {
      const ctx: OrderPipelineContext = {
        app_id: acc.app_id,
        union_account_id: acc.id,
        platform,
        query_kind: 'increment',
        scene: '-',
        window_start: windowStart,
        window_end: NOW,
        requestId: randomUUID(),
      };
      return capture(() => pipeline.process(incoming, ctx));
    },
    p1: () =>
      [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].filter(
        ([fields]) => fields?.alert === 'P1',
      ),
  };
}

it('[AC-B1-08zzc#8] 淘宝媒体不符优先于同步起点判定，按归因日计数并发一条 P1', async () => {
  const acc = await account(db, { platform: 'taobao', sync_start_at: at(START) });
  await pid(db, acc, { site_id: SITE, pid: TAOBAO_PID });
  const incoming = await taobaoOrder('4910000000000000001', '3003', '2026-09-20 10:00:00');
  const h = await harness();
  const result = await h.process('taobao', incoming, acc, '2026-09-19T00:00:00.000Z');

  expect(result).toMatchObject({ ok: true, value: { kind: 'dropped', reason: 'SITE_MISMATCH' } });
  const { orders, keys, dropKeys, drops } = await snapshot(db, acc.app_id);
  expect(orders).toEqual([]);
  expect(keys).toEqual([]);
  // 完整核对两张丢弃表的记录，同时排除额外写入 BEFORE_SYNC_START。
  expect(dropKeys).toMatchObject([
    {
      app_id: acc.app_id,
      platform: 'taobao',
      sub_order_id: incoming.sub_order_id,
      reason: 'SITE_MISMATCH',
    },
  ]);
  expect(drops).toMatchObject([
    {
      app_id: acc.app_id,
      platform: 'taobao',
      day: '2026-09-20',
      reason: 'SITE_MISMATCH',
      count: 1n,
    },
  ]);
  expect(h.p1()).toHaveLength(1);
});

it('[AC-B1-08zzc#9] 同一 App 下京东按数字 positionId、拼多多按完整 PID、淘宝按广告位和媒体匹配', async () => {
  const taobao = await account(db, { platform: 'taobao' });
  await pid(db, taobao, { site_id: SITE, pid: TAOBAO_PID });
  const h = await harness();

  for (const [platform, registeredSlot, unregisteredSlot] of [
    ['jd', ADZONE, '12002'],
    ['pdd', '1001_2002', '9001_2002'],
  ] as const) {
    const acc = await account(db, { platform, app_id: taobao.app_id });
    await pid(db, acc, { pid: registeredSlot });
    const miss = await h.process(
      platform,
      order({
        platform,
        sub_order_id: randomUUID(),
        promotion_slot: unregisteredSlot,
        raw_payload_id: null,
      }),
      acc,
    );
    expect(miss).toMatchObject({ ok: true, value: { kind: 'dropped', reason: 'PID_NOT_OURS' } });
    const match = await h.process(
      platform,
      order({
        platform,
        sub_order_id: randomUUID(),
        promotion_slot: registeredSlot,
        raw_payload_id: null,
      }),
      acc,
    );
    expect(match).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  }

  const incoming = await taobaoOrder('4910000000000000002', SITE, '2026-10-16 00:00:00');
  const match = await h.process('taobao', incoming, taobao);
  expect(match).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  expect(h.p1()).toEqual([]);
});
