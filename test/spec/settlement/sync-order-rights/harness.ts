// B2-04zzr rule-test harness (claude-independent, SPEC_REF b1410c4f; FU-P7-ORDER-RIGHTS-ROW, 编排
// D10-1118 / D10-1124 / D10-1125 / D10-1133). BR-FUND-01 P 表: P7 (SETTLED, PLATFORM_INVALID,
// platform_status unchanged) writes order_rights(type INVALID_AFTER_SETTLE, status SUCCEEDED); P8 for
// a punishment (PLATFORM_PUNISH on PAID / RECEIVED / SETTLED, before settlement too) writes
// order_rights(type PUNISH, status SUCCEEDED) (BR-FUND-02). The settlement side is unchanged: R8 on a
// credited order (key P{row_version}, BR-FUND-08), R6 before the credit.
// What is under test is the production assembly of the worker entry
// (../settlement-records/kit.ts: AppModule.forEntry({ entry: 'worker' }), its pipeline, update step,
// rebate port + clawback, bill and credit). The only stand-in is the pdd status map
// (./status-codes.ts, mocked in by each test file), whose two synthetic codes carry the events.
// Expected values are written by hand: the default rule version (reserve 0, own share 50 %, role share)
// credits N 1000 as member 500 and platform 500, so a full clawback takes 500 / 500 back.
// The P7 row's platform_rights_no is 'P' || the orders.row_version written by the sync update that
// carried the event (the BR-FUND-08 clawback key; R8 / R6 bump row_version once more afterwards and
// that later value is not the key, D10-1133 ①); a punishment has no rights number (one row per
// order, K-2, D10-346). Integration tests pass the database in: this file never imports
// @couli/db/testing.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import { credited, observations, type SyncedOrder } from '../settle-diff-sync/kit.ts';
import { received, settled, touched, type App, type Worker } from '../settlement-records/kit.ts';
import { SYNTHETIC_INVALID, SYNTHETIC_PUNISH } from './status-codes.ts';

export { databaseFixture } from '../credit/kit.ts';
export { credited, MEMBER_ROLE } from '../settle-diff-sync/kit.ts';
export type { SyncedOrder } from '../settle-diff-sync/kit.ts';
export { received, settled, touched, withWorker } from '../settlement-records/kit.ts';
export type { App, Worker } from '../settlement-records/kit.ts';

/** A real credit runs sync, bill and batch before the event under test. */
export const TIMEOUT = 180_000;

/** The settled report of every order here: N 1000 (the estimate and the settlement). */
export const N = 1000n;

type Patch = Parameters<SyncedOrder['sync']>[0];

/** The union reports the settled order invalid: P7 (platform_status stays SETTLED). */
export function invalidAfterSettle(minute: number): Patch {
  return settled(N, { raw_status: SYNTHETIC_INVALID, ...touched(minute) });
}

/** A punishment on a settled order (P8). */
export function punishSettled(minute: number): Patch {
  return settled(N, { raw_status: SYNTHETIC_PUNISH, ...touched(minute) });
}

/** A punishment on a received, not yet settled order (P8 before settlement). */
export function punishReceived(minute: number): Patch {
  return received({ raw_status: SYNTHETIC_PUNISH, ...touched(minute) });
}

/** A punishment on a paid order (P8 before settlement). */
export function punishPaid(minute: number): Patch {
  return { raw_status: SYNTHETIC_PUNISH, ...touched(minute) };
}

/** The union reports a paid order invalid before settlement: P6 (platform_status INVALID). */
export function invalidBeforeSettle(minute: number): Patch {
  return { raw_status: SYNTHETIC_INVALID, ...touched(minute) };
}

/** A real credit (sync → bill → batch, R5) of N 1000 on a new app; the clawback read helpers. */
export async function creditedOrder(db: Kysely<DB>, w: Worker) {
  const c = await credited(db, w, { n: N });
  expect(await c.o.row(), 'the credited order').toMatchObject({
    rebate_status: 'CREDITED',
    platform_status: 'SETTLED',
    booked_n_fen: N,
    rights_pending: false,
  });
  expect(await clawbacks(c.read), 'no clawback before the event').toEqual([]);
  return c;
}

/** A new app's order synced settled and not credited: WAITING. */
export async function waitingOrder(db: Kysely<DB>, w: Worker) {
  const app = await w.app();
  const o = w.order(app, { est_commission_fen: N, commission_fen: N });
  await o.sync(settled(N));
  expect(await o.row(), 'the waiting order').toMatchObject({
    rebate_status: 'WAITING',
    platform_status: 'SETTLED',
    rights_pending: false,
  });
  return { app, o, read: observations(db, app, o) };
}

/** A new app's order synced paid (ESTIMATED, platform PAID). */
export async function paidOrder(db: Kysely<DB>, w: Worker) {
  const app = await w.app();
  const o = w.order(app, { est_commission_fen: N, commission_fen: N });
  await o.sync();
  expect(await o.row(), 'the paid order').toMatchObject({
    rebate_status: 'ESTIMATED',
    platform_status: 'PAID',
    rights_pending: false,
  });
  return { app, o, read: observations(db, app, o) };
}

/** A new app's order synced received, not settled (platform RECEIVED). */
export async function receivedOrder(db: Kysely<DB>, w: Worker) {
  const app = await w.app();
  const o = w.order(app, { est_commission_fen: N, commission_fen: N });
  await o.sync(received());
  expect(await o.row(), 'the received order').toMatchObject({
    platform_status: 'RECEIVED',
    rights_pending: false,
  });
  return { app, o, read: observations(db, app, o) };
}

/** The rebate-owned columns a replay must leave as they were, and row_version. */
export async function rebateColumns(o: SyncedOrder) {
  const row = await o.row();
  return {
    rebate_status: row.rebate_status,
    platform_status: row.platform_status,
    reason: row.reason,
    booked_base_fen: row.booked_base_fen,
    booked_n_fen: row.booked_n_fen,
    rights_pending: row.rights_pending,
    row_version: row.row_version,
  };
}

export type Observations = ReturnType<typeof observations>;

/**
 * One report through the production pipeline; returns the orders.row_version that report's sync
 * update writes (the row_version before it + 1: orders' one CAS UPDATE, update-step.ts).
 */
export async function report(o: SyncedOrder, patch: Patch): Promise<number> {
  const before = await o.row();
  await o.sync(patch);
  return before.row_version + 1;
}

/** The order's order_rights rows, oldest first, with what the tests compare. */
export async function rightsOf(db: Kysely<DB>, app: App, o: SyncedOrder) {
  const { order_id: orderId } = await o.row();
  return db
    .selectFrom('order_rights')
    .select(['id', 'type', 'status', 'platform_rights_no', 'created_at', 'updated_at'])
    .where('app_id', '=', app.appId)
    .where('order_id', '=', orderId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

/** type / status / platform_rights_no of each row. */
export async function rightsBrief(db: Kysely<DB>, app: App, o: SyncedOrder) {
  return (await rightsOf(db, app, o)).map((row) => ({
    type: row.type,
    status: row.status,
    platform_rights_no: row.platform_rights_no,
  }));
}

/** A row written directly as SUCCEEDED: its success instant is its creation (updated_at = created_at). */
export async function expectWrittenSucceeded(db: Kysely<DB>, app: App, o: SyncedOrder) {
  for (const row of await rightsOf(db, app, o)) {
    expect(row.updated_at, `order_rights ${row.id}`).toEqual(row.created_at);
  }
}

/** The order's CLAWBACK lines as `uniq|subject|owner|amount|ledger_type|sub_type`, sorted. */
export async function clawbacks(read: Observations): Promise<string[]> {
  return (await read.lines())
    .filter((line) => line.uniq_key.includes(':CLAWBACK:'))
    .map(
      (line) =>
        `${line.uniq_key}|${line.subject}|${String(line.owner_id)}|${String(line.amount_fen)}|${String(line.ledger_type)}|${String(line.sub_type)}`,
    )
    .sort();
}

/**
 * A full clawback of event `event` (BR-FUND-08): the member debits USER_BALANCE 500, the platform
 * debits COMMISSION_REVENUE 500, each against UNION_RECEIVABLE:pdd.
 */
export function fullClawback(
  read: Observations,
  app: App,
  event: string,
  subType: 'FULL' | 'PUNISH',
): string[] {
  const member = `${read.orderRef}:${app.userId}:share:CLAWBACK:${event}`;
  const house = `${read.orderRef}:PLATFORM:CLAWBACK:${event}`;
  return [
    `${member}|USER_BALANCE|${app.userId}|500|CLAWBACK|${subType}`,
    `${member}|UNION_RECEIVABLE:pdd|platform|-500|CLAWBACK|${subType}`,
    `${house}|COMMISSION_REVENUE|platform|500|CLAWBACK|${subType}`,
    `${house}|UNION_RECEIVABLE:pdd|platform|-500|CLAWBACK|${subType}`,
  ].sort();
}

/**
 * A platform restore R12 (VOID → WAITING, BR-FUND-22) written as the restore entry leaves it: the
 * rebate column through one row_version bump and one rebate history row (ADMIN_RESTORE, admin) at
 * the worker's clock. The restore itself is B2-09gb's and not under test here.
 */
export async function restoredByHand(db: Kysely<DB>, w: Worker, app: App, o: SyncedOrder) {
  const row = await o.row();
  expect(row.rebate_status, 'restorable').toBe('VOID');
  await db
    .updateTable('orders')
    .set({ rebate_status: 'WAITING', reason: null, row_version: row.row_version + 1 })
    .where('app_id', '=', app.appId)
    .where('order_id', '=', row.order_id)
    .execute();
  await db
    .insertInto('order_status_history')
    .values({
      app_id: app.appId,
      order_id: row.order_id,
      field: 'rebate',
      from_status: 'VOID',
      event: 'ADMIN_RESTORE',
      to_status: 'WAITING',
      source: 'admin',
      at: w.clock.now(),
    })
    .execute();
}
