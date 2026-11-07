// The worker's rescan position gauge (B1-01zzr; D10-747 / D10-765 / D10-766 A):
// couli_sync_rescan_position_seconds{app_id, platform, query_kind}. A rescan cursor (query_kind
// 'rescan' or 'rescan_*', B1-04zzr) is a scan position, not a watermark (orders/domain/sync-window.ts rescanStep), so it is
// left out of couli_sync_watermark_lag_seconds and exported here instead: per (app_id, platform,
// query_kind) of the rescan streams, now − min(cursor_at) in whole seconds, never negative; no
// rescan stream, no series. Only the worker exports it, from the same registry and the same
// collect as the business gauges; no alert reads it. "now" is the injected Clock only.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { Clock } from '../clock/index.ts';

/**
 * The query_kind values that are no sync stream: never counted in the watermark lag (B1-04zzr: and
 * every 'rescan_*' tier, see countsInWatermarkLag).
 */
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

/**
 * B1-04zzr (D10-798): a rescan stream's query_kind: 'rescan' or one starting with 'rescan_' (the
 * tiers 'rescan_hour' / 'rescan_week'). Such streams make series of the rescan position gauge.
 */
export function isRescanQueryKind(queryKind: string): boolean {
  return queryKind === RESCAN_QUERY_KIND || queryKind.startsWith(RESCAN_QUERY_KIND_PREFIX);
}

/**
 * B1-04zzr: whether a stream of this query_kind counts in couli_sync_watermark_lag_seconds: every
 * rescan stream (isRescanQueryKind) and exactly 'rights' / 'manual' are left out.
 */
export function countsInWatermarkLag(queryKind: string): boolean {
  return !(isRescanQueryKind(queryKind) || queryKind === 'rights' || queryKind === 'manual');
}

/** The prefix of a tier's rescan query_kind ('rescan_hour', 'rescan_week'). */
export const RESCAN_QUERY_KIND_PREFIX = `${RESCAN_QUERY_KIND}_`;

/**
 * B1-04zzr: the SQL form of isRescanQueryKind over app.sync_cursors.query_kind. starts_with, not
 * LIKE: in LIKE '_' is a wildcard, so 'rescanx' would match.
 */
export const RESCAN_QUERY_KIND_SQL = sql<boolean>`(query_kind = ${RESCAN_QUERY_KIND} OR starts_with(query_kind, ${RESCAN_QUERY_KIND_PREFIX}))`;

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
    WHERE ${RESCAN_QUERY_KIND_SQL}
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
