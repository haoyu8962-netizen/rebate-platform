// B1-04zz（BR-CALC-03、BR-CALC-18、D10-588）：淘宝订单经真实适配器进真实流水线，N 是净额；未结算行服务费两处都缺时
// 不按 0，不生成快照，待处理原因是 SERVICE_FEE_RATE_MISSING（serviceFeeDeducted 为 true）。走 settled-flow 的
// 路径：首次导入未归因，后到的行归因并生成快照。已结算行拿不到结算额时进 ORDER_ROW_INVALID，库里的 est 不当 N
// （编排第 4 次 ①）。已有 est 的单后续缺服务费，只有拼多多计数（编排 05:25）。真实库，假传输，报文全部合成。
import { randomBytes } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fetchWindow } from '../../../../apps/api/src/modules/orders/application/fetch-window.ts';
import { quarantineRejected } from '../../../../apps/api/src/modules/orders/application/row-quarantine.ts';
import {
  createOrderPipeline,
  createOrderUpdateStep,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { createMetricsRegistry } from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import type { CallCtx, UnionOrder } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  capture,
  fakePort,
  runUpdate,
  scenario,
  type SnapshotPort,
} from '../../orders/commission-snapshot/db-kit.ts';
import { bindMember, taobaoPort } from '../../orders/taobao-negative/settled-flow.ts';
import { ctx, listed, num, onePage, setup, visible, win } from '../taobao-orders/kit.ts';
import { netRow, paidRow } from './net-row.ts';

const COLLECT: CallCtx = { ...ctx, rowErrors: 'collect' };
const FEE_MISSING_EVENT = 'pdd_service_fee_missing';
const registry = createMetricsRegistry({ entry: 'worker' });

/** Times inside the attribution fixture's world (its clock is 2026-10-17T17:30:00Z). */
const COMMON_ROW = {
  relation_id: num('3200000002'),
  tk_create_time: '2026-10-15 10:00:01',
  tk_paid_time: '2026-10-15 10:00:05',
  tb_paid_time: '2026-10-15 10:00:05',
  click_time: '2026-10-15 09:58:00',
};
const PAID_TIMES = { ...COMMON_ROW, modified_time: '2026-10-15 10:10:00' };
const SETTLED_TIMES = {
  ...COMMON_ROW,
  tk_earning_time: '2026-10-17 11:00:00',
  modified_time: '2026-10-17 11:05:00',
};
/** 服务费拿不到的两种报文：两处都缺；dto 非法（alimama_share_fee 还在，也不回退）。 */
const FEE_GONE: readonly {
  readonly label: string;
  readonly amounts: Readonly<Record<string, unknown>>;
}[] = [
  {
    label: '服务费两处都缺',
    amounts: { alimm_share_info_dto: undefined, alimama_share_fee: undefined },
  },
  {
    label: 'dto 服务费非法',
    amounts: {
      alimm_share_info_dto: {
        alimm_tech_service_pre_fee: '-1.00',
        alimm_tech_service_fee: '-1.00',
      },
    },
  },
];

/** 已结算行拿不到结算额的报文：上面两种，再加只缺结算服务费、只缺结算佣金字段。 */
const SETTLE_GONE: readonly {
  readonly label: string;
  readonly amounts: Readonly<Record<string, unknown>>;
}[] = [
  ...FEE_GONE,
  {
    label: '只缺结算服务费',
    amounts: {
      alimm_share_info_dto: { alimm_tech_service_pre_fee: num('1.00') },
      alimama_share_fee: undefined,
    },
  },
  { label: '只缺结算佣金字段', amounts: { pub_share_fee_for_commission: undefined } },
];

/** /metrics 里 couli_pdd_service_fee_missing_total 各序列的合计；还没有序列时是 0。 */
async function missingTotal(): Promise<number> {
  let total = 0;
  for (const line of (await registry.render()).split('\n')) {
    const match = /^couli_pdd_service_fee_missing_total(?:\{.*\})? (\S+)$/.exec(line);
    if (match !== null) total += Number(match[1]);
  }
  return total;
}

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

/** A 19-digit trade id of its own: order_keys is global across apps. */
function tradeId(): string {
  return `${2_910_000_000_000_000_000n + BigInt(`0x${randomBytes(7).toString('hex')}`)}`;
}

async function throughAdapter(input: Record<string, unknown>, payloadId: string) {
  const { adapter } = setup(onePage([input], payloadId));
  const page = await listed(adapter.listOrders(win, {}, COLLECT));
  expect(page.items).toHaveLength(1);
  return page.items[0]!;
}

/** The paid order imported unattributed, its relation_id then bound: the next row attributes it. */
async function boundOrder(paid: UnionOrder, trade_id: string) {
  const f = await scenario(db, { ...paid, platform: 'taobao', raw_status: 'paid' });
  const flow = { ...f, trade_id };
  const port = await taobaoPort(db, flow);
  bindMember(flow);
  return { f, port };
}

/**
 * One window through fetchWindow, wired as jobs/order-sync.ts wires it. raw_status becomes the
 * attribution fixture's label (same swap as settled-flow), so a row that reaches onPage really moves
 * the order to SETTLED and takes a snapshot: that is what "no snapshot" below is measured against.
 */
function syncWindow(
  f: Awaited<ReturnType<typeof scenario>>,
  snapshots: SnapshotPort,
  input: Record<string, unknown>,
  payloadId: string,
) {
  const { adapter } = setup(onePage([input], payloadId));
  const pipeline = createOrderPipeline({
    ...f.deps,
    updateStep: createOrderUpdateStep({ ...f.updateDeps, pids: f.deps.pids, snapshots }),
  });
  return capture(() =>
    fetchWindow(win, {
      adapter,
      call: ctx,
      onPage: async (orders) => {
        for (const order of orders) {
          await pipeline.process(f.next({ ...order, raw_status: 'settled' }), f.ctx);
        }
      },
      onRejected: (rows) => quarantineRejected(pipeline, rows, f.ctx),
    }),
  );
}

it('[AC-B1-04zz#16][BR-CALC-03][BR-CALC-18] 净额入库：orders 的 est 900、settle 820，快照 N 取 820，补贴不进 N', async () => {
  const trade_id = tradeId();
  const paid = await throughAdapter(paidRow(1, { ...PAID_TIMES, trade_id }), '70811');
  const settled = await throughAdapter(netRow(1, { ...SETTLED_TIMES, trade_id }), '70812');
  const { f, port } = await boundOrder(paid, trade_id);
  const incoming = f.next({ ...settled, raw_status: 'settled' });
  expect(await runUpdate(f, port, incoming)).toMatchObject({
    ok: true,
    value: { kind: 'updated' },
  });
  const { orders, pending } = await f.read();
  expect(orders).toHaveLength(1);
  expect(orders[0]).toMatchObject({ est_commission_fen: 900n, settle_commission_fen: 820n });
  expect(port.create).toHaveBeenCalledTimes(1);
  expect(port.create.mock.calls[0]?.[1]).toMatchObject({ nBaseFen: 820n });
  expect(pending.map((row) => row.reason)).not.toContain('SERVICE_FEE_RATE_MISSING');
});

// 已结算行不再走到这里（collect 下进 rejected，#22）；这条只剩未结算行：留在 items，归属时拿不到 N。
it.each(FEE_GONE)(
  '[AC-B1-04zz#17][BR-CALC-03] 未结算行$label：est 为 null，归属时不调快照端口，待处理 SERVICE_FEE_RATE_MISSING',
  async ({ amounts }) => {
    const trade_id = tradeId();
    const paid = await throughAdapter(paidRow(1, { ...PAID_TIMES, ...amounts, trade_id }), '70811');
    expect(paid.est_commission_fen).toBeNull();
    const later = await throughAdapter(
      paidRow(1, { ...PAID_TIMES, modified_time: '2026-10-15 10:20:00', ...amounts, trade_id }),
      '70812',
    );
    expect(later.est_commission_fen).toBeNull();
    const { f, port } = await boundOrder(paid, trade_id);
    const incoming = f.next({ ...later, raw_status: 'paid' });
    expect(await runUpdate(f, port, incoming)).toMatchObject({
      ok: true,
      value: { kind: 'updated' },
    });
    const { orders, pending } = await f.read();
    expect(orders[0]).toMatchObject({ est_commission_fen: null, settle_commission_fen: null });
    expect(port.create).not.toHaveBeenCalled();
    expect(pending).toContainEqual(
      expect.objectContaining({
        reason: 'SERVICE_FEE_RATE_MISSING',
        status: 'open',
        order_id: orders[0]!.order_id,
      }),
    );
  },
);

// 已结算行留在 items 的话，est 不覆盖（库里 900）、settle 为空，快照 N 就是预估。后半段是对照：同一单、同一路径，
// 字段齐了才入账，证明前半段「不生成快照」不是因为这条路本来走不到快照。
it.each(SETTLE_GONE)(
  '[AC-B1-04zz#22][BR-CALC-03] 库里已有 est 900 的单，已结算行$label：经 fetchWindow 进 ORDER_ROW_INVALID，不生成快照，不按预估，订单各列不变；字段齐了才入账 820，待处理解决',
  async ({ amounts }) => {
    const trade_id = tradeId();
    const paid = await throughAdapter(paidRow(1, { ...PAID_TIMES, trade_id }), '70815');
    expect(paid.est_commission_fen).toBe(900n);
    const { f, port } = await boundOrder(paid, trade_id);

    const broken = netRow(1, { ...SETTLED_TIMES, ...amounts, trade_id });
    expect(await syncWindow(f, port, broken, '70816')).toMatchObject({ ok: true });
    const afterBroken = await f.read();
    expect(afterBroken.orders).toEqual(f.before.orders);
    expect(afterBroken.orders[0]).toMatchObject({
      est_commission_fen: 900n,
      settle_commission_fen: null,
    });
    expect(port.create).not.toHaveBeenCalled();
    expect(afterBroken.pending).toContainEqual(
      expect.objectContaining({
        reason: 'ORDER_ROW_INVALID',
        status: 'open',
        sub_order_id: trade_id,
        order_id: afterBroken.orders[0]!.order_id,
        raw_payload_id: 70816n,
      }),
    );

    const repaired = netRow(1, { ...SETTLED_TIMES, trade_id });
    expect(await syncWindow(f, port, repaired, '70817')).toMatchObject({ ok: true });
    const afterRepair = await f.read();
    expect(afterRepair.orders[0]).toMatchObject({ settle_commission_fen: 820n });
    expect(port.create).toHaveBeenCalledTimes(1);
    expect(port.create.mock.calls[0]?.[1]).toMatchObject({ nBaseFen: 820n });
    expect(afterRepair.pending).toContainEqual(
      expect.objectContaining({ reason: 'ORDER_ROW_INVALID', status: 'resolved' }),
    );
  },
);

// 这个计数器和日志事件都是拼多多的（couli_pdd_*、CouliPddServiceFeeMissing）。淘宝的 serviceFeeDeducted 打开后不能
// 混进来。淘宝不计数这件事现实现本来成立，所以先看净额（新口径之前是红的），拼多多放在后面证明计数器确实活着。
it.each(FEE_GONE)(
  '[AC-B1-04zz#21][BR-CALC-03] 已有 est 的单后续$label：淘宝 est、版本不变，不计入 couli_pdd_service_fee_missing_total，不打 pdd_service_fee_missing；拼多多缺费仍计一次、打一条',
  async ({ amounts }) => {
    const trade_id = tradeId();
    const paid = await throughAdapter(paidRow(1, { ...PAID_TIMES, trade_id }), '70813');
    expect(paid.est_commission_fen).toBe(900n);
    const f = await scenario(db, { ...paid, platform: 'taobao', raw_status: 'paid' });
    const later = await throughAdapter(
      paidRow(1, { ...PAID_TIMES, modified_time: '2026-10-15 10:20:00', ...amounts, trade_id }),
      '70814',
    );
    expect(later).toMatchObject({ est_commission_fen: null, service_fee_fen: null });
    const before = await missingTotal();

    const taobaoReport = f.next({ ...later, raw_status: 'paid' });
    expect(await runUpdate(f, fakePort(), taobaoReport)).toMatchObject({
      ok: true,
      value: { kind: 'updated' },
    });

    const { orders, pending } = await f.read();
    expect(orders[0]).toMatchObject({
      est_commission_fen: 900n,
      commission_version: f.original.commission_version,
    });
    expect(pending.map((row) => row.reason)).not.toContain('SERVICE_FEE_RATE_MISSING');
    expect(await missingTotal()).toBe(before);
    expect(visible(f.logger.warn.mock.calls)).not.toContain(FEE_MISSING_EVENT);

    const pdd = await scenario(db, {
      platform: 'pdd',
      est_commission_fen: 900n,
      commission_fen: 1000n,
      service_fee_fen: 100n,
    });
    const pddReport = pdd.next({
      est_commission_fen: null,
      commission_fen: 1200n,
      service_fee_fen: null,
    });
    expect(await runUpdate(pdd, fakePort(), pddReport)).toMatchObject({
      ok: true,
      value: { kind: 'updated' },
    });
    expect(await missingTotal()).toBe(before + 1);
    expect(visible(pdd.logger.warn.mock.calls)).toContain(FEE_MISSING_EVENT);
  },
);
