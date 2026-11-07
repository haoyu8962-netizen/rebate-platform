// Whole-database worker metrics (B1-01zzh; 规划/02 §11, §13; ADR-0001 §4.2 #14). Read-only SQL over
// pgboss.queue, pgboss.job and app.sync_cursors; "now" is the injected Clock only (never the
// database's now()). Only the worker exports them. B1-01zzr: the watermark lag leaves out the
// streams of the exclusion table (rescan / rights / manual, and B1-04zzr every rescan_* tier); the rescan positions come with the
// same collect.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { Clock } from '../clock/index.ts';
import {
  NON_SYNC_QUERY_KINDS,
  RESCAN_QUERY_KIND_SQL,
  collectRescanPositions,
  type RescanPositionSnapshot,
} from './rescan-position.ts';

/** One scrape's values, keyed by the label value (queue name or platform). */
export interface WorkerMetricsSnapshot {
  /** Every queue (business queues and their `<q>.dead`): jobs in state failed. */
  readonly queueFailed: Readonly<Record<string, number>>;
  /** Every `<q>.dead` queue: jobs still waiting there (state created or retry). */
  readonly deadLetters: Readonly<Record<string, number>>;
  /** Every business queue: jobs in state created whose start_after is at or before now. */
  readonly backlog: Readonly<Record<string, number>>;
  /** Every `evt.*` queue: max(now - start_after) in seconds of its created, due jobs; 0 if none. */
  readonly oldestDueEvtAgeSeconds: Readonly<Record<string, number>>;
  /**
   * Per platform with a sync stream: now - min(cursor_at) in whole seconds, over its streams whose
   * query_kind is not in the exclusion table (rescan / rights / manual, B1-01zzr).
   */
  readonly syncWatermarkLagSeconds: Readonly<Record<string, number>>;
}

/**
 * What the worker's collect hands to the registry: the frozen B1-01zzh snapshot plus the rescan
 * positions, optional so a bare WorkerMetricsSnapshot still renders (no rescan series).
 */
export interface WorkerCollection extends WorkerMetricsSnapshot {
  readonly rescanPositionSeconds?: RescanPositionSnapshot;
}

/**
 * The global dead letter queue of the catalog before B1-01zzg (dead-letter-scan.ts): jobs may still
 * wait there, so it counts as a dead letter queue, never as a business queue.
 */
const LEGACY_DEAD_LETTER = 'dead-letter';

function isDeadLetterQueue(name: string): boolean {
  return name.endsWith('.dead') || name === LEGACY_DEAD_LETTER;
}

interface QueueRow {
  queue: string;
  failed: number;
  waiting: number;
  due: number;
  oldest: number;
}

interface CursorRow {
  platform: string;
  lag: number;
}

/**
 * Queues are found in SQL (every row of pgboss.queue; jobs reference it by foreign key), so a queue
 * added later is listed without changing this file, with 0 when nothing matches. Only the states
 * read here are joined (created / retry / failed), never the retained completed rows.
 */
export async function collectWorkerMetrics(
  db: Kysely<DB>,
  clock: Clock,
): Promise<WorkerCollection> {
  const now = clock.now().toISOString();
  const queues = await sql<QueueRow>`
    SELECT
      q.name AS queue,
      count(j.name) FILTER (WHERE j.state = 'failed')::integer AS failed,
      count(j.name) FILTER (WHERE j.state IN ('created', 'retry'))::integer AS waiting,
      count(j.name) FILTER (
        WHERE j.state = 'created' AND j.start_after <= ${now}::timestamptz
      )::integer AS due,
      COALESCE(
        floor(extract(epoch FROM (${now}::timestamptz - min(j.start_after) FILTER (
          WHERE j.state = 'created' AND j.start_after <= ${now}::timestamptz
        )))),
        0
      )::integer AS oldest
    FROM pgboss.queue q
    LEFT JOIN pgboss.job j
      ON j.name = q.name AND j.state IN ('created', 'retry', 'failed')
    GROUP BY q.name
    ORDER BY q.name
  `.execute(db);
  const cursors = await sql<CursorRow>`
    SELECT
      platform,
      GREATEST(0, floor(extract(epoch FROM (${now}::timestamptz - min(cursor_at)))))::integer AS lag
    FROM app.sync_cursors
    WHERE query_kind NOT IN (${sql.join([...NON_SYNC_QUERY_KINDS])}) AND NOT ${RESCAN_QUERY_KIND_SQL}
    GROUP BY platform
    ORDER BY platform
  `.execute(db);

  const queueFailed: Record<string, number> = {};
  const deadLetters: Record<string, number> = {};
  const backlog: Record<string, number> = {};
  const oldestDueEvtAgeSeconds: Record<string, number> = {};
  for (const row of queues.rows) {
    queueFailed[row.queue] = Number(row.failed);
    if (isDeadLetterQueue(row.queue)) {
      deadLetters[row.queue] = Number(row.waiting);
      continue;
    }
    backlog[row.queue] = Number(row.due);
    if (row.queue.startsWith('evt.')) oldestDueEvtAgeSeconds[row.queue] = Number(row.oldest);
  }
  const syncWatermarkLagSeconds: Record<string, number> = {};
  for (const row of cursors.rows) syncWatermarkLagSeconds[row.platform] = Number(row.lag);
  // The rescan positions of the same scrape (B1-01zzr): a scan position, not a watermark.
  const rescanPositionSeconds = await collectRescanPositions(db, clock);
  return {
    queueFailed,
    deadLetters,
    backlog,
    oldestDueEvtAgeSeconds,
    syncWatermarkLagSeconds,
    rescanPositionSeconds,
  };
}
