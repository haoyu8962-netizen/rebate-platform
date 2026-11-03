// B1-04zw（BR-CALC-02 异常：联盟 N 为负 → raw_n_fen 记原值，B=0；BR-CALC-26；D10-572），B1-04zz 改口径
// （D10-588）：淘宝已结算行的负结算额（pub_share_fee_for_commission 减结算服务费 1.00）经真实适配器进真实
// 流水线，写进 orders，快照按它算，不回退到预估。settled-flow 的 settledIncoming 没有结算佣金字段，这里的已结算行
// 自己写，不动夹具。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { CallCtx, UnionOrder } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { ctx, listed, num, onePage, row, setup, win } from '../../union/taobao-orders/kit.ts';
import { runUpdate } from '../commission-snapshot/db-kit.ts';
import { splits } from '../commission-snapshot/real-kit.ts';
import {
  bindMember,
  paidUnattributed,
  shareAmounts,
  taobaoPort,
  type PaidFlow,
} from './settled-flow.ts';

const COLLECT: CallCtx = { ...ctx, rowErrors: 'collect' };

/** 与 settled-flow 的已结算行相同，时间落在归因夹具的时钟里。 */
const SETTLED_ROW = {
  relation_id: num('3200000001'),
  tk_create_time: '2026-10-15 10:00:01',
  tk_paid_time: '2026-10-15 10:00:05',
  tb_paid_time: '2026-10-15 10:00:05',
  click_time: '2026-10-15 09:58:00',
  tk_status: num('3'),
  tk_earning_time: '2026-10-17 11:00:00',
  modified_time: '2026-10-17 11:05:00',
};

async function settledIncoming(f: PaidFlow, fee: string): Promise<UnionOrder> {
  const input = row({ ...SETTLED_ROW, trade_id: f.trade_id, pub_share_fee_for_commission: fee });
  const { adapter } = setup(onePage([input], '70802'));
  const page = await listed(adapter.listOrders(win, {}, COLLECT));
  expect(page.items).toHaveLength(1);
  return f.next({ ...page.items[0]!, raw_status: 'settled' });
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

it.each([
  ['-1.00', -200n],
  ['-3.205', -421n],
] as const)(
  '[AC-B1-04zw#8] 已结算行 pub_share_fee_for_commission「%s」入库：orders.settle_commission_fen %s，快照 raw_n_fen 记原值、B=0，三方分到的金额都是 0，不回退到预估 724',
  async (fee, fen) => {
    const f = await paidUnattributed(db);
    const port = await taobaoPort(db, f);
    bindMember(f);
    const incoming = await settledIncoming(f, fee);

    expect(await runUpdate(f, port, incoming)).toMatchObject({
      ok: true,
      value: { kind: 'updated' },
    });

    const { orders } = await f.read();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      platform_status: 'SETTLED',
      user_id: f.userId,
      est_commission_fen: 724n,
      settle_commission_fen: fen,
    });
    expect(port.create).toHaveBeenCalledTimes(1);
    expect(port.create.mock.calls[0]?.[1]).toMatchObject({ nBaseFen: fen });
    expect(await splits(db, f.ctx.app_id)).toEqual([
      expect.objectContaining({
        order_id: orders[0]!.order_id,
        raw_n_fen: fen,
        base_fen: 0n,
        reserve_fen: 0n,
        platform_retain_fen: 0n,
        // 比例照常冻结：金额为 0 是因为 B=0，不是比例被清零或有人被漏掉。
        beneficiaries: [
          expect.objectContaining({ user_id: f.userId, ratio_bp: 5000 }),
          expect.objectContaining({ user_id: port.direct, role: 'direct', ratio_bp: 1000 }),
          expect.objectContaining({ user_id: port.indirect, role: 'indirect', ratio_bp: 500 }),
        ],
      }),
    ]);
    const amounts = await shareAmounts(db, f.ctx.app_id, orders[0]!.order_id);
    expect(Object.fromEntries(amounts.map((share) => [share.user_id, share.amount_fen]))).toEqual({
      [f.userId]: 0n,
      [port.direct]: 0n,
      [port.indirect]: 0n,
    });
  },
);
