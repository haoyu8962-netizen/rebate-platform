// B1-34q skeleton (D10-1464 ①): the worker's lag gauge of the workbench's daily rows, one sample per
// app_id with an admin account: the days between the newest due accounting day (D falls due at
// D+1 00:10:00 +08:00) and the app's newest app.admin_dashboard_days stat_date; 0 once the newest
// due day is stored; 7 (the tick's window) for an app without any row. "now" is the injected
// Clock's instant. The body throws NotImplemented until the implementation lands.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** The gauge's name (the implementation registers it; label app_id). */
export type DashboardDayLagGaugeName = 'couli_admin_dashboard_day_lag_days';

/** One app's sample. */
export interface DashboardDayLagSample {
  readonly appId: string;
  /** Whole days behind the newest due day, at least 0. */
  readonly lagDays: number;
}

/** Read-only: one sample per app with an admin account, at `now`. */
export function readDashboardDayLag(
  db: Kysely<DB>,
  now: Date,
): Promise<readonly DashboardDayLagSample[]> {
  void db;
  void now;
  throw new Error('NotImplemented: readDashboardDayLag');
}
