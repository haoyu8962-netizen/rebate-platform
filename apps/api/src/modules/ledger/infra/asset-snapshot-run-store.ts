// B2-04zo: AssetSnapshotRunStore over PostgreSQL (couli_app). Reads only; the store holds nothing in
// memory, so a restarted worker answers the same.
//
// app.event_log does not belong to ledger (the platform event bus writes it): it is read here only
// to tell whether the timeout event of this app's own snapshot day was already recorded, and is
// never written. The lookup goes through the indexed event_id, the deterministic id of
// (app, D, kind), and still matches the event name, the app and D, so no other event can count.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type {
  AssetSnapshotRunStore,
  AssetSnapshotWindow,
} from '../application/asset-snapshot-schedule.ts';
import { alertEventId } from '../application/asset-snapshot-write.ts';

/** 规划/02 §11. */
const TIMED_OUT_EVENT = 'asset_snapshot.timed_out';

/** The event id the runner publishes the timeout of (app, D) under (asset-snapshot-write.ts). */
export function timedOutEventId(appId: string, day: string): string {
  return alertEventId(JSON.stringify([appId, day, 'asset_snapshot_timeout']));
}

export function createAssetSnapshotRunStore(db: Kysely<DB>): AssetSnapshotRunStore {
  const snapshots = db.withSchema('app').selectFrom('asset_snapshots');
  return {
    async listApps() {
      const rows = await db
        .withSchema('app')
        .selectFrom('ledger_accounts')
        .select('app_id')
        .distinct()
        .orderBy('app_id')
        .execute();
      return rows.map((row) => row.app_id);
    },
    async snapshotWindow(appId, oldestDay, newestDay): Promise<AssetSnapshotWindow> {
      const rows = await snapshots
        .select((eb) => [eb.cast<string>('snapshot_date', 'text').as('day'), 'waiting_comparable'])
        .where('app_id', '=', appId)
        .where('snapshot_date', '>=', sql<Date>`${oldestDay}::date`)
        .where('snapshot_date', '<=', sql<Date>`${newestDay}::date`)
        .orderBy('snapshot_date')
        .execute();
      const before = await snapshots
        .select((eb) => eb.cast<string>('snapshot_date', 'text').as('day'))
        .where('app_id', '=', appId)
        .where('snapshot_date', '<', sql<Date>`${oldestDay}::date`)
        .orderBy('snapshot_date', 'desc')
        .limit(1)
        .executeTakeFirst();
      return {
        rows: rows.map((row) => ({
          day: row.day,
          waitingComparable: row.waiting_comparable,
        })),
        newestBefore: before?.day ?? null,
      };
    },
    async timedOutDays(appId, days) {
      const eventIds = days.map((day) => timedOutEventId(appId, day));
      const { rows } = await sql<{ readonly day: string }>`
        SELECT payload -> 'data' ->> 'accounting_date' AS day
        FROM app.event_log
        WHERE event_id = ANY(${eventIds}::uuid[])
          AND app_id = ${appId}
          AND name = ${TIMED_OUT_EVENT}
          AND payload -> 'data' ->> 'accounting_date' = ANY(${[...days]}::text[])
      `.execute(db);
      return new Set(rows.map((row) => row.day));
    },
  };
}
