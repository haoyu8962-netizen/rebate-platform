// B1-34q skeleton (01 F-ADM-26 ②, contract AdminDashboardYesterday; D10-1401, D10-1403): the
// workbench's yesterday overview, one row per (app_id, accounting day) in app.admin_dashboard_days
// (migration 0140). Every body throws NotImplemented until the implementation lands.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, RootLogger } from '../../platform/index.ts';

/** [start, end) of one accounting day as ISO instants (as @couli/domain chinaDayRange). */
export interface DashboardDayRange {
  readonly start: string;
  readonly end: string;
}

/** The four figures of one (app, day), each read through its owning module's index.ts. */
export interface DashboardDaySources {
  countLinks(appId: string, range: DashboardDayRange): Promise<bigint>;
  countPaidOrders(appId: string, range: DashboardDayRange): Promise<bigint>;
  countNewUsers(appId: string, range: DashboardDayRange): Promise<bigint>;
  sumEstimatedRebateFen(appId: string, range: DashboardDayRange): Promise<bigint>;
}

export interface DashboardDayDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly sources: DashboardDaySources;
}

export interface DashboardDaysTickOptions extends DashboardDayDeps {
  readonly logger: RootLogger;
}

export interface DashboardDayInput {
  readonly appId: string;
  /** The accounting day, YYYY-MM-DD (Asia/Shanghai). */
  readonly day: string;
}

/** One stored row: four non-negative figures and the aggregation instant. */
export interface DashboardDayRow {
  readonly app_id: string;
  readonly date: string;
  readonly links: bigint;
  readonly orders: bigint;
  readonly est_rebate_fen: bigint;
  readonly new_users: bigint;
  readonly as_of: Date;
}

export type DashboardYesterday = Omit<DashboardDayRow, 'app_id'>;

/** The four figures of (app, day), upserted with as_of = clock.now(); returns the row. */
export function aggregateDashboardDay(
  deps: DashboardDayDeps,
  input: DashboardDayInput,
): Promise<DashboardDayRow> {
  void deps;
  void input;
  throw new Error('NotImplemented: aggregateDashboardDay');
}

/** One scheduler tick: per app with an admin account, the missing due days of the window. */
export function tickDashboardDays(opts: DashboardDaysTickOptions): Promise<void> {
  void opts;
  throw new Error('NotImplemented: tickDashboardDays');
}

/** Yesterday's row of the app, else its newest row not later than yesterday, else null. */
export function readDashboardYesterday(
  db: Kysely<DB>,
  input: { readonly appId: string; readonly now: Date },
): Promise<DashboardYesterday | null> {
  void db;
  void input;
  throw new Error('NotImplemented: readDashboardYesterday');
}
