// B1-03zk：走 orders 更新路径的再命中豁免（08 BR-ATTR-26「申诉撤销后的再命中」，D10-1093）。夹具沿用
// test/spec/orders/blacklist/kit.ts：真实 risk 名单端口，返利端口与事件总线是假实现，rebate_status 由夹具直接置好。
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import {
  existing,
  ownership,
  publishedOf,
  seedChannel,
  seedSuffix,
} from '../../orders/blacklist/kit.ts';
import { AFTER_CREDIT, CHANNEL, PARENT_HIT, SUFFIX } from '../../orders/blacklist/plan-kit.ts';
import { databaseFixture } from '../order-blocklist/kit.ts';

const database = databaseFixture();

type Existing = Awaited<ReturnType<typeof existing>>;
type Dimension = 'channel' | 'order_no_suffix';
type Action = 'manual_review' | 'void_commission';

async function priorHit(
  db: Kysely<DB>,
  f: Existing,
  dimension: Dimension,
  value: string,
  action: Action,
) {
  await db.transaction().execute((trx) =>
    f.recordHit(trx, {
      app_id: f.ctx.app_id,
      user_id: f.userId,
      order_id: f.before.order_id,
      dimension,
      value,
      risk_action: action,
    }),
  );
  f.recordHit.mockClear();
}

/** 申诉结案为撤销：结案时刻晚于已写的命中，之后的同步再晚于结案。 */
async function revoke(db: Kysely<DB>, f: Existing) {
  f.clock.advanceMs(1_000);
  const closedAt = f.clock.now();
  await db
    .insertInto('appeals')
    .values({
      id: randomUUID(),
      app_id: f.ctx.app_id,
      user_id: f.userId,
      target_type: 'order',
      target_id: f.before.order_id,
      status: 'revoked',
      content: 'fixture appeal',
      deadline_at: closedAt,
      handler_id: 'fixture-handler',
      closed_at: closedAt,
      created_at: closedAt,
      updated_at: closedAt,
    })
    .execute();
  f.clock.advanceMs(1_000);
}

async function blockStatuses(db: Kysely<DB>, f: Existing) {
  const rows = await db
    .selectFrom('blocklist')
    .select('status')
    .where('app_id', '=', f.ctx.app_id)
    .execute();
  return rows.map((row) => row.status);
}

it.each(['void_commission', 'manual_review'] as const)(
  '[AC-B1-03zk#10] WAITING 的单 content_hash 变化，名单值仍 active 且已豁免：不作废、仍 WAITING、不新增 risk_hits（结案前处置 %s）',
  async (action) => {
    const db = database();
    const f = await existing(db, 'WAITING');
    await seedChannel(db, f);
    await priorHit(db, f, 'channel', CHANNEL, action);
    await revoke(db, f);
    const prior = await f.read();

    expect(await f.update()).toMatchObject({ ok: true, value: { kind: 'updated' } });

    expect(f.match).toHaveBeenCalledTimes(1);
    expect(f.onBlacklistHit).not.toHaveBeenCalled();
    expect(f.recordHit).not.toHaveBeenCalled();
    expect(f.onUpdated).toHaveBeenCalledTimes(1);
    const after = await f.read();
    expect(after.hits).toEqual(prior.hits);
    expect(after.orders[0]?.rebate_status).toBe('WAITING');
    expect(ownership(after.orders[0]!)).toEqual(ownership(f.before));
    expect(await blockStatuses(db, f)).toEqual(['active']);
  },
  120_000,
);

it('[AC-B1-03zk#10] ESTIMATED 的单曾因渠道值进人工复核，申诉撤销后 content_hash 变化：不调 onBlacklistHit、不新增 risk_hits、仍 ESTIMATED', async () => {
  const db = database();
  const f = await existing(db, 'ESTIMATED');
  await seedChannel(db, f);
  await priorHit(db, f, 'channel', CHANNEL, 'manual_review');
  await revoke(db, f);
  const prior = await f.read();
  expect(prior.orders[0]?.rebate_status).toBe('ESTIMATED');
  expect(prior.hits.map((row) => row.risk_action)).toEqual(['manual_review']);

  expect(await f.update()).toMatchObject({ ok: true, value: { kind: 'updated' } });

  expect(f.match).toHaveBeenCalledTimes(1);
  expect(f.onBlacklistHit).not.toHaveBeenCalled();
  expect(f.recordHit).not.toHaveBeenCalled();
  expect(f.onUpdated).toHaveBeenCalledTimes(1);
  const after = await f.read();
  expect(after.hits).toEqual(prior.hits);
  expect(after.orders[0]?.rebate_status).toBe('ESTIMATED');
  expect(ownership(after.orders[0]!)).toEqual(ownership(f.before));
  expect(await blockStatuses(db, f)).toEqual(['active']);
}, 120_000);

it('[AC-B1-03zk#10] CREDITED 的单已豁免：不发 order.blacklist_hit_after_credit，不新增 risk_hits', async () => {
  const db = database();
  const f = await existing(db, 'CREDITED');
  await seedChannel(db, f);
  await priorHit(db, f, 'channel', CHANNEL, 'manual_review');
  await revoke(db, f);
  const prior = await f.read();

  expect(await f.update()).toMatchObject({ ok: true, value: { kind: 'updated' } });

  expect(f.match).toHaveBeenCalledTimes(1);
  expect(publishedOf(f, AFTER_CREDIT)).toHaveLength(0);
  expect(f.onBlacklistHit).not.toHaveBeenCalled();
  expect(f.recordHit).not.toHaveBeenCalled();
  expect((await f.read()).hits).toEqual(prior.hits);
}, 120_000);

it.each([
  ['channel', CHANNEL, 'order_no_suffix'],
  ['order_no_suffix', SUFFIX, 'channel'],
] as const)(
  '[AC-B1-03zk#10] 结案后新增的名单值命中时仍作废：已豁免 %s=%s，新增 %s 维度',
  async (dimension, value, added) => {
    const db = database();
    const f = await existing(db, 'WAITING', { parent_order_id: PARENT_HIT }, { suffixOn: true });
    if (dimension === 'channel') await seedChannel(db, f);
    else await seedSuffix(db, f);
    // 结案前的处置取 manual_review：豁免失效时同值会多写一条 void_commission，可被下面的断言看到。
    await priorHit(db, f, dimension, value, 'manual_review');
    await revoke(db, f);
    if (added === 'channel') await seedChannel(db, f);
    else await seedSuffix(db, f);

    expect(await f.update()).toMatchObject({ ok: true, value: { kind: 'updated' } });

    expect(f.onBlacklistHit).toHaveBeenCalledTimes(1);
    expect((await f.read()).hits.map((row) => [row.dimension, row.risk_action])).toEqual([
      [dimension, 'manual_review'],
      [added, 'void_commission'],
    ]);
  },
  120_000,
);
