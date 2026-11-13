// B1-34q (01 F-ADM-26 ②, contract AdminDashboardYesterday; D10-1401, D10-1403): the workbench's
// yesterday overview, one row per (app_id, accounting day) in app.admin_dashboard_days (migration
// 0141), aggregated after the day instead of live.
//
// - aggregateDashboardDay: the explicit (re)aggregation of (app, D): the four figures from the
//   sources (each through its owning module's index.ts), upserted on (app_id, stat_date) with
//   as_of = the Clock's instant; a rerun overwrites the four figures and as_of in place. An app
//   without data gets a row of true zeros. The stored row is the state at as_of: later changes to
//   orders leave it as it is.
// - One snapshot per row (BR-TEXT-21 数据截至时刻, BR-FUND-18; Codex funds review r1 S0): the four
//   figures are read inside ONE read-only REPEATABLE READ transaction handed to every source, so
//   links, orders, new_users and est_rebate_fen all see the same committed state (an order synced
//   between two reads is in all of them or in none). as_of is the Clock's instant taken inside that
//   transaction right before its first read: PostgreSQL takes a REPEATABLE READ snapshot at the
//   transaction's first statement, not at BEGIN, so that instant is the closest to the snapshot the
//   Clock can give, and the snapshot holds everything committed before as_of. The row is written
//   after the snapshot transaction ends, in a statement of its own on the caller's handle (a
//   read-only transaction cannot write); the figures written are exactly those of the snapshot.
// - tickDashboardDays: one scheduler tick, no process memory (the rows are their own completion
//   mark). D falls due at D+1 00:10:00 +08:00. For every app with an admin account (admin_users),
//   every missing day of the window of the 7 newest due days is aggregated, oldest first; a gap
//   before the window is not filled. A tick only fills (Codex funds review r1 S1): its write is
//   INSERT … ON CONFLICT DO NOTHING, so when two workers tick the same (app, D) at once the first
//   row stays (figures and as_of) and a stored row is never recomputed by a tick; only an explicit
//   aggregateDashboardDay overwrites. One app's failure
//   stops that app's newer days until the next tick and never the other apps; it leaves one error
//   line admin_dashboard_day_failed with the app, the day and the error class only (no message, no
//   amount).
// - readDashboardYesterday: yesterday = the +08:00 accounting day before the one of `now`; that row,
//   else the newest row not later than it (with its own date and as_of), else null.
// The day bounds come from @couli/domain (chinaDayRange, accountingDate); time only from the Clock.
// The new table's Kysely types come with the schema snapshot of 0141, so the statements on it are
// written as SQL over app.admin_dashboard_days.
import type { DB } from '@couli/db';
import { accountingDate, chinaDayRange } from '@couli/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Clock, RootLogger } from '../../platform/index.ts';

/** [start, end) of one accounting day as ISO instants (as @couli/domain chinaDayRange). */
export interface DashboardDayRange {
  readonly start: string;
  readonly end: string;
}

/**
 * The four figures of one (app, day), each read through its owning module's index.ts, all on the
 * snapshot transaction `trx` the aggregation hands in (never on a handle of their own).
 */
export interface DashboardDaySources {
  countLinks(trx: Transaction<DB>, appId: string, range: DashboardDayRange): Promise<bigint>;
  countPaidOrders(trx: Transaction<DB>, appId: string, range: DashboardDayRange): Promise<bigint>;
  countNewUsers(trx: Transaction<DB>, appId: string, range: DashboardDayRange): Promise<bigint>;
  sumEstimatedRebateFen(
    trx: Transaction<DB>,
    appId: string,
    range: DashboardDayRange,
  ): Promise<bigint>;
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

/** The tick writes back at most this many due days, the newest included. */
export const DASHBOARD_DAY_WINDOW_DAYS = 7;
/** D falls due this long after D+1 00:00 +08:00. */
export const DASHBOARD_DAY_DUE_AFTER_MIDNIGHT_MS = 10 * 60_000;
/** The error line of a failed (app, day). */
export const DASHBOARD_DAY_FAILED = 'admin_dashboard_day_failed';

const MS_PER_DAY = 86_400_000;
/** Midday of a +08:00 day, 12 hours after its start: far from both of its edges. */
const HALF_DAY_MS = MS_PER_DAY / 2;

/** A copy of `like` set to `ms` (no `new Date(`; the input is never modified). */
function instantAt(like: Date, ms: number): Date {
  const copy = structuredClone(like);
  copy.setTime(ms);
  return copy;
}

/** The accounting day `offset` days after `day` (negative: before); +08:00 has no DST. */
export function shiftDay(day: string, offset: number, like: Date): string {
  const midday = Date.parse(chinaDayRange(day).start) + HALF_DAY_MS;
  return accountingDate(instantAt(like, midday + offset * MS_PER_DAY));
}

/** The newest D whose D+1 00:10:00 +08:00 is not after `now`. */
export function newestDueDay(now: Date): string {
  return accountingDate(
    instantAt(now, now.getTime() - DASHBOARD_DAY_DUE_AFTER_MIDNIGHT_MS - MS_PER_DAY),
  );
}

/** The window of the tick at `now`: the 7 newest due days, oldest first. */
export function dueWindow(now: Date): string[] {
  const newest = newestDueDay(now);
  const days: string[] = [];
  for (let back = DASHBOARD_DAY_WINDOW_DAYS - 1; back >= 0; back -= 1) {
    days.push(shiftDay(newest, -back, now));
  }
  return days;
}

/** Yesterday of `now`: the +08:00 accounting day before the one `now` falls in. */
export function yesterdayOf(now: Date): string {
  return shiftDay(accountingDate(now), -1, now);
}

interface StoredRow {
  readonly date: string;
  readonly links: bigint | string;
  readonly orders: bigint | string;
  readonly est_rebate_fen: bigint | string;
  readonly new_users: bigint | string;
  readonly as_of: Date;
}

function yesterdayOfRow(row: StoredRow): DashboardYesterday {
  return {
    date: row.date,
    links: BigInt(row.links),
    orders: BigInt(row.orders),
    est_rebate_fen: BigInt(row.est_rebate_fen),
    new_users: BigInt(row.new_users),
    as_of: row.as_of,
  };
}

function nonNegative(name: string, value: bigint): bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new RangeError(`dashboard figure ${name} must be a non-negative bigint`);
  }
  return value;
}

/** The four figures of one snapshot and the instant they are as of. */
interface DayFigures {
  readonly links: bigint;
  readonly orders: bigint;
  readonly newUsers: bigint;
  readonly estRebateFen: bigint;
  readonly asOf: Date;
}

/** Runs on the caller's transaction, or on a read-only REPEATABLE READ one of its own. */
function onSnapshot<T>(db: Kysely<DB>, run: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  if (db.isTransaction) return run(db as Transaction<DB>);
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(run);
}

/** The four figures of (app, range) on one snapshot; as_of right before its first read. */
function readFigures(
  deps: DashboardDayDeps,
  appId: string,
  range: DashboardDayRange,
): Promise<DayFigures> {
  const { db, clock, sources } = deps;
  return onSnapshot(db, async (trx) => {
    // Before the first statement: the snapshot is taken by that statement (see the file header).
    const asOf = clock.now();
    const links = nonNegative('links', await sources.countLinks(trx, appId, range));
    const orders = nonNegative('orders', await sources.countPaidOrders(trx, appId, range));
    const newUsers = nonNegative('new_users', await sources.countNewUsers(trx, appId, range));
    const estRebateFen = nonNegative(
      'est_rebate_fen',
      await sources.sumEstimatedRebateFen(trx, appId, range),
    );
    return { links, orders, newUsers, estRebateFen, asOf };
  });
}

/**
 * How a row is written: 'overwrite' (an explicit aggregation: ON CONFLICT DO UPDATE) or 'fill'
 * (the tick: ON CONFLICT DO NOTHING, a row already there is kept as it is).
 */
export type DashboardDayWriteMode = 'overwrite' | 'fill';

/** The (app, day) row from one snapshot; null when mode 'fill' found the row already stored. */
export async function writeDashboardDay(
  deps: DashboardDayDeps,
  input: DashboardDayInput,
  mode: DashboardDayWriteMode,
): Promise<DashboardDayRow | null> {
  const { appId, day } = input;
  if (typeof appId !== 'string' || appId === '') {
    throw new RangeError('appId must be a non-empty string');
  }
  // Strict YYYY-MM-DD of an existing day; [D 00:00, D+1 00:00) +08:00.
  const range = chinaDayRange(day);
  const f = await readFigures(deps, appId, range);
  const conflict =
    mode === 'fill'
      ? sql`ON CONFLICT (app_id, stat_date) DO NOTHING`
      : sql`ON CONFLICT (app_id, stat_date) DO UPDATE SET
      links = EXCLUDED.links,
      orders = EXCLUDED.orders,
      est_rebate_fen = EXCLUDED.est_rebate_fen,
      new_users = EXCLUDED.new_users,
      as_of = EXCLUDED.as_of,
      updated_at = EXCLUDED.updated_at`;
  const { rows } = await sql<StoredRow>`
    INSERT INTO app.admin_dashboard_days
      (app_id, stat_date, links, orders, est_rebate_fen, new_users, as_of, created_at, updated_at)
    VALUES (${appId}, ${day}::date, ${f.links}, ${f.orders}, ${f.estRebateFen}, ${f.newUsers},
      ${f.asOf}, ${f.asOf}, ${f.asOf})
    ${conflict}
    RETURNING stat_date::text AS date, links, orders, est_rebate_fen, new_users, as_of`.execute(
    deps.db,
  );
  const row = rows[0];
  if (row === undefined) {
    if (mode === 'fill') return null;
    throw new Error('admin_dashboard_days upsert returned no row');
  }
  return { app_id: appId, ...yesterdayOfRow(row) };
}

/** The explicit (re)aggregation of (app, day): overwrites the row with as_of = its snapshot. */
export async function aggregateDashboardDay(
  deps: DashboardDayDeps,
  input: DashboardDayInput,
): Promise<DashboardDayRow> {
  const row = await writeDashboardDay(deps, input, 'overwrite');
  if (row === null) throw new Error('admin_dashboard_days upsert returned no row');
  return row;
}

/** The apps of the tick: those with an admin account. */
async function listApps(db: Kysely<DB>): Promise<string[]> {
  const rows = await db
    .withSchema('app')
    .selectFrom('admin_users')
    .select('app_id')
    .distinct()
    .orderBy('app_id')
    .execute();
  return rows.map((row) => row.app_id);
}

/** The days of [oldest, newest] the app already has a row of. */
async function storedDays(
  db: Kysely<DB>,
  appId: string,
  oldest: string,
  newest: string,
): Promise<Set<string>> {
  const { rows } = await sql<{ readonly date: string }>`
    SELECT stat_date::text AS date FROM app.admin_dashboard_days
    WHERE app_id = ${appId} AND stat_date BETWEEN ${oldest}::date AND ${newest}::date`.execute(db);
  return new Set(rows.map((row) => row.date));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** One scheduler tick: per app with an admin account, the missing due days of the window. */
export async function tickDashboardDays(opts: DashboardDaysTickOptions): Promise<void> {
  const { db, logger } = opts;
  const window = dueWindow(opts.clock.now());
  const oldest = window[0];
  const newest = window.at(-1);
  if (oldest === undefined || newest === undefined) return;
  for (const appId of await listApps(db)) {
    let current = newest;
    try {
      const stored = await storedDays(db, appId, oldest, newest);
      for (const day of window) {
        if (stored.has(day)) continue;
        current = day;
        // Fill only: a row another worker stored meanwhile is kept (null), never overwritten.
        await writeDashboardDay(opts, { appId, day }, 'fill');
      }
    } catch (error: unknown) {
      // The app's newer days wait for the next tick, which restarts from its oldest missing day.
      logger.error(
        { app_id: appId, stat_date: current, error_name: errorName(error) },
        DASHBOARD_DAY_FAILED,
      );
    }
  }
}

/** Yesterday's row of the app, else its newest row not later than yesterday, else null. */
export async function readDashboardYesterday(
  db: Kysely<DB>,
  input: { readonly appId: string; readonly now: Date },
): Promise<DashboardYesterday | null> {
  const yesterday = yesterdayOf(input.now);
  const { rows } = await sql<StoredRow>`
    SELECT stat_date::text AS date, links, orders, est_rebate_fen, new_users, as_of
    FROM app.admin_dashboard_days
    WHERE app_id = ${input.appId} AND stat_date <= ${yesterday}::date
    ORDER BY stat_date DESC
    LIMIT 1`.execute(db);
  const row = rows[0];
  return row === undefined ? null : yesterdayOfRow(row);
}
