// B2-04zzb: the ordinary order sync (no rights record) on the assembled worker, as B2-04zi tests it
// (../settle-diff-sync/kit.ts over ../settlement-records/kit.ts): every report goes through the real
// pipeline, the union's new settlement amount is written by settlements recordApi (the record that
// decides the amount, newDecidingSeq), and the clawback's R10 runs in that same sync transaction.
// Nothing here seeds order_settlements or calls onUpdated directly.
//
// Order of the worker kit: pdd, the member's own attribution code (one beneficiary, role `share`),
// own share 50 %; reserve 0 unless `reserveBp` selects a later version. With `held` the member is
// frozen at credit: an open first_credit obligation (pending = its share) and no member voucher,
// the platform credit voucher = N − share. The first report writes seq 1; the next settled report
// with a new amount writes seq 2, so R10's platform voucher is `pdd:{sub}:PLATFORM:ADJ:2` and
// closed_ref is `S2`.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  credited,
  risk,
  type App,
  type SyncedOrder,
  type Worker,
} from '../settle-diff-sync/kit.ts';
import type { LaterState, ObligationRow } from './kit.ts';

export { MEMBER_ROLE, settled, touched, withSync } from '../settle-diff-sync/kit.ts';
export type { App, SyncedOrder, Worker } from '../settle-diff-sync/kit.ts';

/** The order observations of the worker kit (settle-diff-sync observations). */
export type SyncRead = Awaited<ReturnType<typeof credited>>['read'];

/** The order key of a worker-kit order (pdd). */
export function syncOrderKey(o: SyncedOrder): string {
  return `pdd:${o.subOrderId}`;
}

/** R10's platform voucher of a worker-kit order on settlement record `seq`. */
export function syncPlatformAdjKey(o: SyncedOrder, seq: number): string {
  return `${syncOrderKey(o)}:PLATFORM:ADJ:${String(seq)}`;
}

/** The platform clawback voucher of a worker-kit order for event `ref` (R8: `C{version}`). */
export function syncPlatformClawbackKey(o: SyncedOrder, ref: string): string {
  return `${syncOrderKey(o)}:PLATFORM:CLAWBACK:${ref}`;
}

/** The member's later state (BR-CALC-09): risk state for banned, users.status for deleting / deleted. */
export async function setMemberState(
  db: Kysely<DB>,
  w: Worker,
  app: App,
  state: LaterState,
): Promise<void> {
  if (state === 'deleting' || state === 'deleted') {
    await db
      .updateTable('users')
      .set({ status: state })
      .where('app_id', '=', app.appId)
      .where('id', '=', app.userId)
      .execute();
    return;
  }
  await risk(db, w, app, state);
}

/** The order's only obligation (fails the test when there is not exactly one). */
export async function memberObligation(read: SyncRead): Promise<ObligationRow> {
  const rows = await read.obligations();
  expect(rows, 'member obligations').toHaveLength(1);
  return rows[0]!;
}

/**
 * A CREDITED worker-kit order whose member was frozen at credit (open first_credit obligation, no
 * voucher), then moved to `later` before anything else happens.
 */
export async function heldThenSynced(
  db: Kysely<DB>,
  w: Worker,
  later: LaterState,
  options: { readonly n?: bigint; readonly reserveBp?: number } = {},
) {
  const seeded = await credited(db, w, { ...options, held: true });
  const opened = await memberObligation(seeded.read);
  expect(opened).toMatchObject({ kind: 'first_credit', status: 'open', voucher_id: null });
  await setMemberState(db, w, seeded.app, later);
  return { ...seeded, opened };
}

/** The order's vouchers whose uniq_key is `uniqKey` (this app). */
export async function syncVouchersByKey(db: Kysely<DB>, app: App, uniqKey: string) {
  return db
    .selectFrom('ledger_vouchers')
    .selectAll()
    .where('app_id', '=', app.appId)
    .where('uniq_key', '=', uniqKey)
    .execute();
}

/**
 * The member's obligation is forfeited by R10 with `closedRef`, and its voucher_id is the platform
 * voucher `uniqKey` this sync transaction wrote (same app, same order, SETTLE_ADJUST, no
 * beneficiary), read back through (app_id, voucher_id).
 */
export async function expectSyncLinked(
  db: Kysely<DB>,
  app: App,
  o: SyncedOrder,
  read: SyncRead,
  close: { readonly closedRef: string; readonly uniqKey: string },
): Promise<ObligationRow> {
  const vouchers = await syncVouchersByKey(db, app, close.uniqKey);
  expect(vouchers, close.uniqKey).toHaveLength(1);
  expect(vouchers[0]).toMatchObject({
    order_key: syncOrderKey(o),
    voucher_kind: 'SETTLE_ADJUST',
    beneficiary_user_id: null,
    role: null,
  });
  const voucherId = vouchers[0]!.id;
  const row = await memberObligation(read);
  expect(row).toMatchObject({
    status: 'forfeited',
    closed_by: 'R10',
    closed_ref: close.closedRef,
  });
  expect(row.voucher_id, 'member voucher_id').toBe(voucherId);
  const referenced = await db
    .selectFrom('ledger_vouchers')
    .select(['id', 'app_id', 'uniq_key', 'order_key', 'voucher_kind'])
    .where('app_id', '=', row.app_id)
    .where('id', '=', voucherId)
    .execute();
  expect(referenced).toEqual([
    {
      id: voucherId,
      app_id: app.appId,
      uniq_key: close.uniqKey,
      order_key: syncOrderKey(o),
      voucher_kind: 'SETTLE_ADJUST',
    },
  ]);
  return row;
}
