// B1-08zj rule-test kit (08 BR-INV-24 ⑥ 细则 判定顺序 3；编排 D10-814 ⑥ / D10-854 ② / D10-868 ①；
// FU-INVITE-REWARD-ORDER-PLATFORM). The gap under test is the order fact read port of the production
// assembly: growth only exempts a jd trigger order whose refunded quantity grew after crediting
// while orders.jd.refunded_quantity_r9_enabled is off, so the port must hand growth o.platform.
// Rounds are the invite reward scanner a real AppModule.forEntry({ entry: 'worker' }) assembles
// (B2-16c's worker kit, imported read-only); the fact reader of case 4 is assembled exactly as
// app.module assembles it (bookedBaseOrderFacts over orders' createInviteRewardOrderFacts).
// Every row is synthetic. Integration tests pass the database in: this file never imports
// @couli/db/testing.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  ATTR_AT,
  LOCKED_AMOUNT,
  PAID,
  QUALIFIED,
  configure,
  hex,
  newAppId,
  user,
  type Pair,
} from '../invite-reward-wiring/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);

/** B1-08zi's switch: jd's refunded quantity drives R9 and voids the invite reward only when on. */
export const JD_SWITCH = 'orders.jd.refunded_quantity_r9_enabled';
/** BR-INV-24 ④ emergency pause: a paused round defers the row (status deferred), never voids it. */
export const PAUSED = 'growth.invite_reward.payout_paused';
/** The end of the 30-day window of every seeded qualification (exclusive). */
export const WINDOW_END = '2026-11-19T02:00:00.000Z';

export type OrderPlatform = 'jd' | 'taobao' | 'pdd';

export interface DuePair extends Pair {
  readonly platform: OrderPlatform;
  readonly orderId: string;
}

function app(db: Kysely<DB>) {
  return db.withSchema('app');
}

/** A configured app (B2-16c's configure: reward on, unpaused, budgets that cover every pair). */
export async function configuredApp(db: Kysely<DB>): Promise<string> {
  const appId = newAppId();
  await configure(db, appId);
  return appId;
}

/** Sets one config_items value of the app (inserted when absent; version bumped when present). */
export async function setConfig(
  db: Kysely<DB>,
  appId: string,
  key: string,
  value: boolean,
): Promise<void> {
  const updated = await app(db)
    .updateTable('config_items')
    .set({
      value: JSON.stringify(value),
      version: sql<number>`version + 1`,
      row_version: sql<number>`row_version + 1`,
      updated_by: 'b1-08zj-fixture',
    })
    .where('app_id', '=', appId)
    .where('key', '=', key)
    .executeTakeFirst();
  if (updated.numUpdatedRows === 1n) return;
  await app(db)
    .insertInto('config_items')
    .values({ app_id: appId, key, value: JSON.stringify(value), updated_by: 'b1-08zj-fixture' })
    .execute();
}

/**
 * A credited self-purchase sub-order of `userId` on `platform`, placed inside the window, no rights,
 * with the refunded quantity and its frozen value at credit as given (default 1 > 0: refunded after
 * crediting). booked_base_fen 320 (R5's booked base), base_fen 320, paid 4990.
 */
export async function creditedOrder(
  db: Kysely<DB>,
  appId: string,
  userId: string,
  platform: OrderPlatform,
  refund: { readonly refunded: number; readonly atCredit: number } = { refunded: 1, atCredit: 0 },
): Promise<string> {
  const orderId = randomUUID();
  const subOrderId = randomUUID();
  await app(db)
    .insertInto('order_keys')
    .values({
      app_id: appId,
      order_id: orderId,
      platform,
      sub_order_id: subOrderId,
      attr_at: new Date(ATTR_AT),
    })
    .execute();
  await app(db)
    .insertInto('orders')
    .values({
      app_id: appId,
      order_id: orderId,
      platform,
      sub_order_id: subOrderId,
      raw_item_id: 'b1-08zj-fixture',
      user_id: userId,
      buy_type: 'self',
      attr_at: new Date(ATTR_AT),
      credited_at: new Date(PAID),
      rebate_status: 'CREDITED',
      platform_status: 'SETTLED',
      base_fen: 320n,
      booked_base_fen: 320n,
      pay_amount_fen: 4990n,
      quantity: 3,
      refunded_quantity: refund.refunded,
      refunded_quantity_at_credit: refund.atCredit,
      created_at: new Date(ATTR_AT),
      updated_at: new Date(PAID),
    })
    .execute();
  return orderId;
}

/**
 * An inviter, its invitee and a triggered qualification record of LOCKED_AMOUNT per party whose
 * trigger order is a credited `platform` self-purchase refunded after crediting (1 > 0); both
 * parties still reserved on the app's total budget: due on the next scanner round.
 */
export async function duePair(
  db: Kysely<DB>,
  appId: string,
  platform: OrderPlatform,
): Promise<DuePair> {
  const inviter = await user(db, appId);
  const invitee = await user(db, appId, { parent: inviter });
  const orderId = await creditedOrder(db, appId, invitee, platform);
  await app(db)
    .insertInto('invite_rewards')
    .values({
      app_id: appId,
      invitee_id: invitee,
      inviter_id: inviter,
      amount_fen: LOCKED_AMOUNT,
      eligibility_days: 30,
      qualified_at: new Date(QUALIFIED),
      bind_source: 'register',
      bind_ip_hmac: hex(),
      status: 'qualified',
      trigger_order_id: orderId,
      triggered_at: new Date(PAID),
      granted_at: null,
      inviter_result: null,
      invitee_result: null,
      inviter_skip_reason: null,
      invitee_skip_reason: null,
      void_reason: null,
      inviter_voucher_id: null,
      invitee_voucher_id: null,
      row_version: 0,
    })
    .execute();
  await app(db)
    .insertInto('invite_reward_budgets')
    .values({
      app_id: appId,
      period: 'total',
      reserved_fen: LOCKED_AMOUNT * 2n,
      granted_fen: 0n,
      updated_at: new Date(PAID),
    })
    .onConflict((oc) =>
      oc.columns(['app_id', 'period']).doUpdateSet({
        reserved_fen: sql<bigint>`invite_reward_budgets.reserved_fen + ${LOCKED_AMOUNT * 2n}`,
      }),
    )
    .execute();
  return { appId, inviter, invitee, platform, orderId };
}

/** One order fact as the production reader returns it (only the fields the rule tests look at). */
export interface ReadFact {
  readonly app_id: string;
  readonly order_id: string;
  readonly [field: string]: unknown;
}

export interface FactReader {
  read(trx: Transaction<DB>, input: { app_id: string; order_id: string }): Promise<ReadFact | null>;
  listSelfOrdersInWindow(
    trx: Transaction<DB>,
    input: { app_id: string; user_id: string; from: Date; to: Date },
  ): Promise<readonly ReadFact[]>;
}

/**
 * The invite reward order fact readers the way production builds them: orders' public export
 * (modules/orders/index.ts) alone, and wrapped in app.module's bookedBaseOrderFacts (what the
 * worker's payout, expiry and R5's trigger receive). URL imports keep decorated controllers out of
 * the spec project's TS compilation.
 */
export async function productionFactReaders(): Promise<{
  readonly port: FactReader;
  readonly assembled: FactReader;
}> {
  const orders = (await import(new URL('apps/api/src/modules/orders/index.ts', ROOT).href)) as {
    createInviteRewardOrderFacts(): FactReader;
  };
  const appModule = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    bookedBaseOrderFacts(facts: FactReader): FactReader;
  };
  return {
    port: orders.createInviteRewardOrderFacts(),
    assembled: appModule.bookedBaseOrderFacts(orders.createInviteRewardOrderFacts()),
  };
}
