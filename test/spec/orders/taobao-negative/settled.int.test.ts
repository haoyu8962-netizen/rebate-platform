// B1-04zw（BR-CALC-02 异常：联盟 N 为负 → raw_n_fen 记原值，B=0；BR-CALC-26；D10-572）：淘宝已结算行的负
// pub_share_fee 经真实适配器进真实流水线，写进 orders，快照按它算，不回退到预估。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runUpdate } from '../commission-snapshot/db-kit.ts';
import { splits } from '../commission-snapshot/real-kit.ts';
import {
  bindMember,
  paidUnattributed,
  settledIncoming,
  shareAmounts,
  taobaoPort,
} from './settled-flow.ts';

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
  ['-1.00', -100n],
  ['-3.205', -321n],
] as const)(
  '[AC-B1-04zw#8] 已结算行 pub_share_fee「%s」入库：orders.settle_commission_fen %s，快照 raw_n_fen 记原值、B=0，三方分到的金额都是 0，不回退到预估 799',
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
      est_commission_fen: 799n,
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
