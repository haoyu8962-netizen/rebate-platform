// The worker's rescan position gauge (B1-01zzr; D10-747 / D10-765 / D10-766 A):
// couli_sync_rescan_position_seconds{app_id, platform, query_kind}. A rescan cursor (query_kind
// 'rescan') is a scan position, not a watermark (orders/domain/sync-window.ts rescanStep), so it is
// left out of couli_sync_watermark_lag_seconds and exported here instead: per (app_id, platform,
// query_kind) of the rescan streams, now − min(cursor_at) in whole seconds, never negative; no
// rescan stream, no series. Only the worker exports it, from the same registry and the same
// collect as the business gauges; no alert reads it. "now" is the injected Clock only.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { Clock } from '../clock/index.ts';

/** The query_kind values that are no sync stream: never counted in the watermark lag. */
export type NonSyncQueryKind = 'rescan' | 'rights' | 'manual';

/** One series of couli_sync_rescan_position_seconds. */
export interface RescanPositionSample {
  readonly appId: string;
  readonly platform: string;
  readonly queryKind: string;
  /** now − min(cursor_at) of the group's streams, in whole seconds (rounded down), at least 0. */
  readonly seconds: number;
}

/** Every rescan position series of one scrape. */
export type RescanPositionSnapshot = readonly RescanPositionSample[];

/** The query_kind of the rescan streams: the only streams of couli_sync_rescan_position_seconds. */
export const RESCAN_QUERY_KIND = 'rescan';

/** The exclusion table of couli_sync_watermark_lag_seconds (every other query_kind counts). */
export const NON_SYNC_QUERY_KINDS: readonly NonSyncQueryKind[] = ['rescan', 'rights', 'manual'];

interface RescanRow {
  app_id: string;
  platform: string;
  query_kind: string;
  seconds: number;
}

/** The rescan positions at the injected clock's now (read-only SQL over app.sync_cursors). */
export async function collectRescanPositions(
  db: Kysely<DB>,
  clock: Clock,
): Promise<RescanPositionSnapshot> {
  const now = clock.now().toISOString();
  // Same rounding as the watermark lag: whole seconds rounded down, never negative.
  const result = await sql<RescanRow>`
    SELECT
      app_id,
      platform,
      query_kind,
      GREATEST(0, floor(extract(epoch FROM (${now}::timestamptz - min(cursor_at)))))::integer
        AS seconds
    FROM app.sync_cursors
    WHERE query_kind = ${RESCAN_QUERY_KIND}
    GROUP BY app_id, platform, query_kind
    ORDER BY app_id, platform, query_kind
  `.execute(db);
  return result.rows.map((row) => ({
    appId: row.app_id,
    platform: row.platform,
    queryKind: row.query_kind,
    seconds: Number(row.seconds),
  }));
}
