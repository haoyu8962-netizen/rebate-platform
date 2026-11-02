// B2-04zo (D10-587): one tick of the asset daily snapshot schedule (BR-FUND-18, BR-FUND-20). The
// worker's timer (asset-snapshot.module.ts) calls tickAssetSnapshots; there is no process memory:
// the snapshot rows are their own completion mark, so a restart decides the same way.
//
// For every app with a ledger account (listed again on each tick, as the daily check does), over a
// window of the 7 newest due days, D being due from D+1 00:01:00 +08:00:
// - an app with no snapshot at all gets the newest due day only (no invented history);
// - otherwise every day of the window after the app's oldest row that has no row is missing, holes
//   before the newest row included; a gap reaching behind the window is one error line, not filled;
// - a row of the window still not comparable is replayed through the runner before its 00:30
//   deadline; after it only while event_log has no asset_snapshot.timed_out of (app, D), so the
//   runner raises that alert once;
// - the work runs oldest first and stops at the first failure: newer days wait for the next tick,
//   which restarts from the oldest day still missing. One app's failure never stops the others.
// The runner keeps the nominal time D+1 00:01 and judges lateness itself from the Clock.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { isPastDeadline, snapshotDayOf, snapshotDeadlineMs } from './asset-snapshot-days.ts';
import type { AssetSnapshotLogger, AssetSnapshotRunner } from './asset-snapshot.ts';

/** At most this many days are written back, the newest due day included. */
export const ASSET_SNAPSHOT_WINDOW_DAYS = 7;

const MS_PER_DAY = 86_400_000;
/** D falls due this long after D+1 00:00 +08:00. */
const RUN_AFTER_MIDNIGHT_MS = 60_000;
/** D+1 00:01 is this long before D's deadline, D+1 00:30. */
const RUN_BEFORE_DEADLINE_MS = 29 * 60_000;

export interface AssetSnapshotWindowRow {
  readonly day: string;
  readonly waitingComparable: boolean;
}

/** What is stored of an app around the window. */
export interface AssetSnapshotWindow {
  /** The rows dated inside the window, oldest first. */
  readonly rows: readonly AssetSnapshotWindowRow[];
  /** The date of the newest row before the window; null when there is none. */
  readonly newestBefore: string | null;
}

/** The reads of a tick (infra/asset-snapshot-run-store.ts); no cache across calls. */
export interface AssetSnapshotRunStore {
  /** The apps with a ledger account, the daily check's list. */
  listApps(): Promise<readonly string[]>;
  /** `oldestDay` and `newestDay` are the window's ends, both included. */
  snapshotWindow(appId: string, oldestDay: string, newestDay: string): Promise<AssetSnapshotWindow>;
  /** Those of `days` whose asset_snapshot.timed_out event of this app is stored. */
  timedOutDays(appId: string, days: readonly string[]): Promise<ReadonlySet<string>>;
}

export interface AssetSnapshotTickOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: AssetSnapshotLogger;
  readonly runner: AssetSnapshotRunner;
  readonly runs: AssetSnapshotRunStore;
  /** True once the module is being destroyed: nothing further is started. */
  isStopped(): boolean;
}

/** A copy of `at` set to `ms` (no `new Date(`; the input is never modified). */
function instantLike(at: Date, ms: number): Date {
  const copy = structuredClone(at);
  copy.setTime(ms);
  return copy;
}

/** The newest D whose D+1 00:01:00 +08:00 is not after `now`. */
export function newestDueDay(now: Date): string {
  return snapshotDayOf(instantLike(now, now.getTime() - RUN_AFTER_MIDNIGHT_MS));
}

/** D+1 00:01 +08:00, D's nominal run time; `now` only supplies the Date. */
export function nominalRunAtOf(day: string, now: Date): Date {
  return instantLike(now, snapshotDeadlineMs(day) - RUN_BEFORE_DEADLINE_MS);
}

/** The window ending at `newest`, oldest first. */
export function windowDaysOf(newest: string, now: Date): string[] {
  const nominalMs = nominalRunAtOf(newest, now).getTime();
  const days: string[] = [];
  for (let back = ASSET_SNAPSHOT_WINDOW_DAYS - 1; back >= 0; back -= 1) {
    days.push(snapshotDayOf(instantLike(now, nominalMs - back * MS_PER_DAY)));
  }
  return days;
}

export interface AssetSnapshotAppPlan {
  /** Days of the window to write, oldest first. */
  readonly missing: readonly string[];
  /** Rows of the window not yet comparable, oldest first. */
  readonly unconfirmed: readonly string[];
  /** The newest row before a gap the window cannot reach; null when no such gap exists. */
  readonly gapAfter: string | null;
}

/** The decision of one app over `days` (windowDaysOf): pure, see the file header. */
export function planAssetSnapshotApp(
  days: readonly string[],
  stored: AssetSnapshotWindow,
  now: Date,
): AssetSnapshotAppPlan {
  const oldest = days[0];
  const newest = days.at(-1);
  if (oldest === undefined || newest === undefined) {
    return { missing: [], unconfirmed: [], gapAfter: null };
  }
  const unconfirmed = stored.rows.filter((row) => !row.waitingComparable).map((row) => row.day);
  const firstRow = stored.rows[0]?.day;
  if (stored.newestBefore === null && firstRow === undefined) {
    return { missing: [newest], unconfirmed, gapAfter: null };
  }
  const written = new Set(stored.rows.map((row) => row.day));
  // ISO dates order as text. History starts at the oldest row: nothing is written before it.
  const start = stored.newestBefore === null ? (firstRow ?? newest) : oldest;
  const missing = days.filter((day) => day >= start && !written.has(day));
  // The day just before the window, in the window's own arithmetic: one day before its oldest.
  const beforeWindow = snapshotDayOf(
    instantLike(now, nominalRunAtOf(oldest, now).getTime() - MS_PER_DAY),
  );
  const gap =
    stored.newestBefore !== null && stored.newestBefore < beforeWindow && !written.has(oldest);
  return { missing, unconfirmed, gapAfter: gap ? stored.newestBefore : null };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** One app's tick; the first failed day propagates, so no newer day is started. */
async function tickApp(
  options: AssetSnapshotTickOptions,
  appId: string,
  days: readonly string[],
  now: Date,
): Promise<void> {
  const { db, logger, runner, runs } = options;
  const oldest = days[0];
  const newest = days.at(-1);
  if (oldest === undefined || newest === undefined) return;
  const plan = planAssetSnapshotApp(days, await runs.snapshotWindow(appId, oldest, newest), now);
  if (plan.gapAfter !== null) {
    // Holds until the window's oldest day is written, which ends it: one line per gap.
    logger.error(
      { app_id: appId, newest_before_gap: plan.gapAfter, oldest_written_back: oldest },
      'ledger_asset_snapshot_gap_beyond_window',
    );
  }
  const expired = plan.unconfirmed.filter((day) => isPastDeadline(now, day));
  const alerted =
    expired.length === 0 ? new Set<string>() : await runs.timedOutDays(appId, expired);
  const missing = new Set(plan.missing);
  const unconfirmed = new Set(plan.unconfirmed);
  for (const day of days) {
    if (!missing.has(day) && (!unconfirmed.has(day) || alerted.has(day))) continue;
    if (options.isStopped()) return;
    await runner.run(db, { appId, nominalRunAt: nominalRunAtOf(day, now) });
  }
}

/** One tick: a failed app is one warn line (never its error text) and the next tick retries it. */
export async function tickAssetSnapshots(options: AssetSnapshotTickOptions): Promise<void> {
  const { clock, logger, runs } = options;
  const now = clock.now();
  const days = windowDaysOf(newestDueDay(now), now);
  for (const appId of await runs.listApps()) {
    if (options.isStopped()) return;
    try {
      await tickApp(options, appId, days, now);
    } catch (error: unknown) {
      logger.warn(
        { app_id: appId, error_name: errorName(error) },
        'ledger_asset_snapshot_tick_app_failed',
      );
    }
  }
}
