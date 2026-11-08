// B1-03zk：订单侧黑名单再命中豁免（08 BR-ATTR-26「申诉撤销后的再命中」，D10-1093）的端口层 harness。
// 名单端口是真实的 risk 端口（经 ../order-blocklist/kit.ts 的公共出口加载），数据库是真实 PG。
// order_id 在本目录用交叉类型表达：实现把它加进 OrderBlocklistQuery 之后，这里仍然成立。
// 本文件不是 *.int.test.ts，不静态依赖测试数据库基座（databaseFixture 在运行时才加载）。
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import type {
  OrderBlocklistDimension,
  OrderBlocklistHitInput,
  OrderBlocklistMatch,
  OrderBlocklistQuery,
} from '../../../../apps/api/src/modules/risk/application/order-blocklist.ts';
import { END, RULE, START, seedUser, setup, state } from '../order-blocklist/kit.ts';

export { ABORT, END, START, databaseFixture, seedBlock } from '../order-blocklist/kit.ts';

/** 申诉结案时刻；名单与 attr_at 取上游 kit 的 START（早于结案）。 */
export const CLOSED = new Date('2026-11-01T08:00:00.000Z');
export const shift = (instant: Date, ms: number) => new Date(instant.getTime() + ms);
export const BEFORE = shift(CLOSED, -60_000);
export const AFTER = shift(CLOSED, 60_000);

export type ExemptQuery = OrderBlocklistQuery & { readonly order_id?: string };
export type Matches = readonly OrderBlocklistMatch[];
export type HitAction = OrderBlocklistHitInput['risk_action'];

export interface HitSeed {
  readonly order_id: string;
  readonly dimension: OrderBlocklistDimension;
  readonly value: string;
  readonly at: Date;
  readonly risk_action?: HitAction;
  readonly app_id?: string;
}

/** 绕过端口写的 risk_hits 行：只用来造端口写不出的组合（别的 ref_type、错位的 hmac）。 */
export interface RawHitSeed {
  readonly ref_id: string;
  readonly dimension: string;
  readonly value_hmac: string;
  readonly at: Date;
  readonly ref_type?: string;
}

export interface AppealSeed {
  readonly target_id: string;
  readonly status: 'revoked' | 'upheld' | 'processing';
  readonly closed_at: Date | null;
  readonly app_id?: string;
  readonly user_id?: string;
  readonly target_type?: 'order' | 'blocked_request';
}

export async function scene(db: Kysely<DB>) {
  const f = setup(db);
  const user = await seedUser(db, f.app);
  const orderId = randomUUID();
  const otherApp = `${f.app}_other`;
  /** 别的 app 的申诉要有该 app 的用户（appeals_user_fkey）。 */
  const foreignUser = () => seedUser(db, otherApp);

  const query = (overrides: Partial<ExemptQuery> = {}): ExemptQuery => ({
    ...f.query,
    ...overrides,
  });
  const match = (overrides: Partial<ExemptQuery> = {}): Promise<Matches> =>
    db.transaction().execute((trx) => f.ports.match(trx, query(overrides)));

  /** 经真实端口写命中，created_at 取端口读到的时钟。 */
  const hit = async (seed: HitSeed) => {
    f.clock.set(seed.at);
    await db.transaction().execute((trx) =>
      f.ports.recordHit(trx, {
        app_id: seed.app_id ?? f.app,
        user_id: null,
        order_id: seed.order_id,
        dimension: seed.dimension,
        value: seed.value,
        risk_action: seed.risk_action ?? 'void_commission',
      }),
    );
  };

  const hmac = (dimension: string, value: string) =>
    f.crypto.blindIndex(value, `blocklist.${dimension}`);

  const rawHit = async (seed: RawHitSeed) => {
    await db
      .insertInto('risk_rules')
      .values({
        id: randomUUID(),
        app_id: f.app,
        rule_id: RULE,
        scene: 'order',
        conditions: {},
        risk_action: 'void_commission',
        status: 'active',
        version: 1,
        created_at: START,
        updated_at: START,
      })
      .onConflict((oc) => oc.columns(['app_id', 'rule_id']).doNothing())
      .execute();
    await db
      .insertInto('risk_hits')
      .values({
        app_id: f.app,
        user_id: null,
        rule_id: RULE,
        risk_action: 'void_commission',
        dimension: seed.dimension,
        value_hmac: seed.value_hmac,
        ref_type: seed.ref_type ?? 'order',
        ref_id: seed.ref_id,
        created_at: seed.at,
      })
      .execute();
  };

  const appeal = async (seed: AppealSeed) => {
    const id = randomUUID();
    const targetType = seed.target_type ?? 'order';
    await db
      .insertInto('appeals')
      .values({
        id,
        app_id: seed.app_id ?? f.app,
        user_id: seed.user_id ?? user,
        target_type: targetType,
        request_type: targetType === 'blocked_request' ? 'withdraw' : null,
        target_id: seed.target_id,
        status: seed.status,
        content: 'fixture appeal',
        deadline_at: END,
        handler_id: seed.status === 'processing' ? null : 'fixture-handler',
        closed_at: seed.closed_at,
        created_at: START,
        updated_at: START,
      })
      .execute();
    return id;
  };

  /** 给该订单造「结案前留下命中 + 申诉撤销」：豁免成立的完整前提。 */
  const exempt = async (
    target: string = orderId,
    dimension: OrderBlocklistDimension = 'channel',
    value = 'R8',
  ) => {
    await hit({ order_id: target, dimension, value, at: BEFORE });
    await appeal({ target_id: target, status: 'revoked', closed_at: CLOSED });
  };

  /** 申诉结案之后才进名单的同值渠道条目（created_at 晚于结案）。 */
  const lateChannel = async (value: string) => {
    const id = randomUUID();
    await db
      .insertInto('blocklist')
      .values({
        id,
        app_id: f.app,
        dimension: 'channel',
        value,
        value_hmac: null,
        platform: 'taobao',
        union_account_id: f.account,
        start_at: START,
        end_at: null,
        expire_at: null,
        status: 'active',
        violation_type: 'other',
        created_by: 'fixture-late-admin',
        created_at: AFTER,
        updated_at: AFTER,
      })
      .execute();
    return id;
  };

  const snapshot = async () => ({
    ...(await state(db, f.app)),
    appeals: await db
      .selectFrom('appeals')
      .selectAll()
      .where('app_id', '=', f.app)
      .orderBy('id')
      .execute(),
  });

  return {
    f,
    user,
    orderId,
    otherApp,
    foreignUser,
    query,
    match,
    hit,
    hmac,
    rawHit,
    appeal,
    exempt,
    lateChannel,
    snapshot,
  };
}
export type Scene = Awaited<ReturnType<typeof scene>>;

/** 命中集合相等，不钉两种维度之间的返回顺序。 */
export function expectEntries(rows: Matches, expected: Matches) {
  expect(rows).toHaveLength(expected.length);
  expect(rows).toEqual(expect.arrayContaining([...expected]));
}
