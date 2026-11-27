import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readOrderAttributionLink } from '../../../../apps/api/src/modules/linking/index.ts';
import {
  createOrderPipeline,
  type OrderPipelineDeps,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { fixture } from '../attribution/kit.ts';
import { GOODS_ID, GOODS_SIGN, LK, params, seedLink } from './kit.ts';

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

async function ingestWithSnapshot(pidScene: 'self_buy' | 'share', linkGoodsSign: string) {
  const f = await fixture(db, {
    goods_id: GOODS_ID,
    goods_sign: GOODS_SIGN,
    attr_params: params({ lk: LK, sc: pidScene }),
    service_fee_fen: 31n,
  });
  f.findPid.mockResolvedValue([{ pid_scene: pidScene, status: 'active', site_id: null }]);
  await seedLink(db, { app_id: f.ctx.app_id, user_id: f.userId }, { raw_item_id: linkGoodsSign });
  const createSnapshot = vi
    .fn<NonNullable<OrderPipelineDeps['snapshots']>['create']>()
    .mockResolvedValue({ kind: 'created' });
  const pipeline = createOrderPipeline({
    ...f.deps,
    readBuyTypeLink: readOrderAttributionLink,
    snapshots: { create: createSnapshot },
  });

  const result = await pipeline.process(f.incoming, f.ctx);
  expect(result.kind).toBe('inserted');
  const row = await db
    .selectFrom('orders')
    .select(['app_id', 'order_id', 'buy_type', 'scene_basis'])
    .where('app_id', '=', f.ctx.app_id)
    .where('sub_order_id', '=', f.incoming.sub_order_id!)
    .executeTakeFirstOrThrow();
  return { row, createSnapshot };
}

it('[AC-B1-08zza#22] 自购推广位命中分享链接，订单和快照均按分享', async () => {
  const { row, createSnapshot } = await ingestWithSnapshot('self_buy', GOODS_SIGN);
  expect(row).toMatchObject({ buy_type: 'share', scene_basis: 'link' });
  // 只把链接判定写进订单、快照仍按推广位取 self 时，快照入参的 orderType 与订单行不符。
  expect(createSnapshot).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    expect.objectContaining({ appId: row.app_id, orderId: row.order_id, orderType: row.buy_type }),
  );
});

it('[AC-B1-08zza#23] 分享推广位的链接商品不符，订单和快照均按自购', async () => {
  const { row, createSnapshot } = await ingestWithSnapshot('share', 'different-goods-sign');
  expect(row).toMatchObject({ buy_type: 'self', scene_basis: 'fallback' });
  // goods_sign 与夹具的 product_key 均不匹配。快照沿用推广位的 share 时，即使订单写对也会红。
  expect(createSnapshot).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    expect.objectContaining({ appId: row.app_id, orderId: row.order_id, orderType: row.buy_type }),
  );
});
