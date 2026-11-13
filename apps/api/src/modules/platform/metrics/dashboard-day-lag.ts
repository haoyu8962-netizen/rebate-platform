// The worker's lag gauge of the workbench's daily rows (B1-34q; D10-1401, D10-1464 ①):
// couli_admin_dashboard_day_lag_days{app_id}, one sample per app with an admin account
// (admin_users, the list admin's tick works on). Value: the whole days between the newest due
// accounting day (D falls due at D+1 00:10:00 +08:00, as admin/application/dashboard-days.ts) and
// the app's newest app.admin_dashboard_days stat_date not later than it; 0 once the newest due day
// is stored; holes before the newest row do not count; 7 (the tick's window, the most it can be
// asked to fill) for an app without any such row. Read-only SQL over the two tables, as
// rescan-position.ts reads sync_cursors (platform imports no business module); "now" is the
// injected Clock's instant and the day arithmetic is @couli/domain's, never the SQL clock. Only the
// worker exports it; couli.yaml alerts on it. A failed read fails the scrape (registry rule), no
// value is made up.
import type { DB } from '@couli/db';
import { accountingDate, chinaDayRange } from '@couli/domain';
import { sql, type Kysely } from 'kysely';
import type { Clock } from '../clock/index.ts';
import { cacheCollector } from './cache.ts';

/** The gauge's name (the implementation registers it; label app_id). */
export type DashboardDayLagGaugeName = 'couli_admin_dashboard_day_lag_days';

/** One app's sample. */
export interface DashboardDayLagSample {
  readonly appId: string;
  /** Whole days behind the newest due day, at least 0. */
  readonly lagDays: number;
}

/** One scrape's values. */
export interface DashboardDayLagSnapshot {
  /** app_id → days behind; an app without an admin account has no key. */
  readonly lagDays: Readonly<Record<string, number>>;
}

/** The gauge and its label. */
export const DASHBOARD_DAY_LAG_GAUGE = {
  name: 'couli_admin_dashboard_day_lag_days' satisfies DashboardDayLagGaugeName,
  help: 'Days between the newest due accounting day (D due at D+1 00:10 +08:00) and the newest workbench daily row, per app_id with an admin account; 7 (the tick window) when the app has no row.',
  label: 'app_id',
} as const;

/** The lag of an app without any row: the tick's window (admin's DASHBOARD_DAY_WINDOW_DAYS). */
export const DASHBOARD_DAY_LAG_NO_ROW = 7;

const MS_PER_DAY = 86_400_000;
/** D falls due this long after D+1 00:00 +08:00. */
const DUE_AFTER_MIDNIGHT_MS = 10 * 60_000;

/** A copy of `like` set to `ms` (no `new Date(`; the input is never modified). */
function instantAt(like: Date, ms: number): Date {
  const copy = structuredClone(like);
  copy.setTime(ms);
  return copy;
}

/** The newest D whose D+1 00:10:00 +08:00 is not after `now`. */
export function newestDueDayAt(now: Date): string {
  return accountingDate(instantAt(now, now.getTime() - DUE_AFTER_MIDNIGHT_MS - MS_PER_DAY));
}

/** Whole +08:00 days from `from` to `to` (both YYYY-MM-DD); +08:00 has no DST. */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(chinaDayRange(to).start) - Date.parse(chinaDayRange(from).start)) / MS_PER_DAY,
  );
}

interface LagRow {
  readonly app_id: string;
  readonly newest: string | null;
}

/** Read-only: one sample per app with an admin account, at `now`. */
export async function readDashboardDayLag(
  db: Kysely<DB>,
  now: Date,
): Promise<readonly DashboardDayLagSample[]> {
  const newestDue = newestDueDayAt(now);
  const { rows } = await sql<LagRow>`
    SELECT a.app_id,
      (SELECT max(d.stat_date)::text FROM app.admin_dashboard_days d
        WHERE d.app_id = a.app_id AND d.stat_date <= ${newestDue}::date) AS newest
    FROM (SELECT DISTINCT app_id FROM app.admin_users) a
    ORDER BY a.app_id`.execute(db);
  return rows.map((row) => ({
    appId: row.app_id,
    lagDays:
      row.newest === null
        ? DASHBOARD_DAY_LAG_NO_ROW
        : Math.max(0, daysBetween(row.newest, newestDue)),
  }));
}

/** The worker's collection: readDashboardDayLag at the Clock's instant, keyed by app_id. */
export async function collectDashboardDayLag(
  db: Kysely<DB>,
  clock: Clock,
): Promise<DashboardDayLagSnapshot> {
  return snapshotOf(await readDashboardDayLag(db, clock.now()));
}

/** The samples as a snapshot (one key per app). */
export function snapshotOf(samples: readonly DashboardDayLagSample[]): DashboardDayLagSnapshot {
  const lagDays: Record<string, number> = {};
  for (const { appId, lagDays: days } of samples) lagDays[appId] = days;
  return { lagDays };
}

/** Default freshness of a cached snapshot: 60 seconds, the admin tick's interval. */
const DEFAULT_TTL_MS = 60_000;

/**
 * The worker's collection cached for 60 seconds by default and within the +08:00 day: never a
 * rejected snapshot, so a failed read fails the scrape and the next scrape reads again.
 */
export function cacheDashboardDayLagCollector(
  collect: () => Promise<DashboardDayLagSnapshot>,
  clock: Clock,
  ttlMs = DEFAULT_TTL_MS,
): () => Promise<DashboardDayLagSnapshot> {
  return cacheCollector(collect, clock, ttlMs, accountingDate);
}
