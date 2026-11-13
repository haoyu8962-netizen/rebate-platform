// B1-34q rule-test kit (claude-independent, SPEC_REF 62b5c99): the workbench's yesterday overview,
// 01 F-ADM-26 ② (转链数、成交订单数、预估返利合计、新增用户数, one row per app and accounting day,
// aggregated after the day, not live) with the task brief §9 rulings D10-1401 / D10-1403: only
// event=convert link_logs; ESTIMATED and platform_status≠DEPOSIT_PAID at the aggregation instant
// (BR-TEXT-21 ESTIMATED), user shares priced by BR-CALC-02; zeros for an app without data; D falls
// due at D+1 00:10:00 +08:00; the tick lists the apps of admin_users and fills the missing due
// days of the last 7, oldest first, never recomputing a stored row; the read returns yesterday's
// row, else the newest row not later than yesterday, else null.
// Real pieces: PostgreSQL as couli_app and the production sources (createDashboardDaySources).
// Synthetic: every row. Accounting-day bounds are written out by hand at +08:00 (D 00:00 +08:00 is
// the previous day 16:00 UTC); no domain calendar function computes an expected value.
// The new table only exists with migration 0140: every test calls one of the skeleton functions
// before this kit reads app.admin_dashboard_days, so on the skeleton the red is NotImplemented.
// The admin module is loaded through URL imports (as in ../system-audit/kit.ts): the production
// sources import module index files that the erasable-only rule-test TS project must not compile;
// a missing export is an assertion here, never a TypeError.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';
import {
  createRootLogger,
  FixedClock,
  type Clock,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { seed, type Person } from '../../settlement/pending-earnings/fixtures.ts';

export type { Person } from '../../settlement/pending-earnings/fixtures.ts';

const ROOT = new URL('../../../../', import.meta.url);

export const TIMEOUT = 120_000;

// ---------------------------------------------------------------------------------------------
// The accounting day D and its bounds, by hand at +08:00.

export const D = '2032-06-15';
/** D 00:00:00.000 +08:00: the first instant of D. */
export const D_START = '2032-06-14T16:00:00.000Z';
/** D 12:00 +08:00. */
export const D_NOON = '2032-06-15T04:00:00.000Z';
/** D 23:59:59.999 +08:00: the last millisecond of D. */
export const D_LAST = '2032-06-15T15:59:59.999Z';
/** D+1 00:00:00.000 +08:00: already the next day. */
export const D_NEXT = '2032-06-15T16:00:00.000Z';
/** D−1 23:59:59.999 +08:00: still the previous day. */
export const D_PREV_LAST = '2032-06-14T15:59:59.999Z';
/** D+1 03:00 +08:00: an aggregation instant after D fell due. */
export const AGG_AT = '2032-06-15T19:00:00.000Z';
/** D+1 09:00 +08:00: a later aggregation instant. */
export const AGG_AGAIN_AT = '2032-06-16T01:00:00.000Z';

/** H:mm:ss.SSS of day `day` at +08:00, as a UTC instant (+08:00 is 8 hours ahead of UTC). */
export function at(day: string, time: string): string {
  return new Date(Date.parse(`${day}T${time}+08:00`)).toISOString();
}

// ---------------------------------------------------------------------------------------------
// Database.

/** One fresh database for the file (couli_app), dropped at the end. */
export function useDatabase(): { readonly db: Kysely<DB> } {
  let database: TestDatabase | undefined;
  let handle: Kysely<DB> | undefined;
  beforeAll(async () => {
    database = await createTestDatabase();
    handle = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  }, 60_000);
  afterAll(async () => {
    try {
      if (handle) await destroyDb(handle);
    } finally {
      await database?.drop();
    }
  }, 60_000);
  return {
    get db(): Kysely<DB> {
      if (handle === undefined) throw new Error('the test database is not ready');
      return handle;
    },
  };
}

export function newApp(label: string): string {
  return `dash-${label}-${randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------------------------
// The functions under test, loaded by URL.

/** What createDashboardDaySources returns; this kit only hands it on. */
interface Sources {
  readonly __sources?: never;
}

interface DayDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly sources: Sources;
}

interface DashboardDaysModule {
  readonly aggregateDashboardDay: (
    deps: DayDeps,
    input: { readonly appId: string; readonly day: string },
  ) => Promise<unknown>;
  readonly tickDashboardDays: (opts: DayDeps & { readonly logger: RootLogger }) => Promise<unknown>;
}

export interface Yesterday {
  readonly date: string;
  readonly links: bigint;
  readonly orders: bigint;
  readonly est_rebate_fen: bigint;
  readonly new_users: bigint;
  readonly as_of: Date;
}

type ReadYesterday = (
  db: Kysely<DB>,
  input: { readonly appId: string; readonly now: Date },
) => Promise<Yesterday | null>;

async function exported<T>(path: string, name: string): Promise<T> {
  const loaded = (await import(new URL(path, ROOT).href)) as Record<string, unknown>;
  expect(typeof loaded[name], `${path} does not export ${name}`).toBe('function');
  return loaded[name] as T;
}

function days(): Promise<DashboardDaysModule> {
  return Promise.all([
    exported<DashboardDaysModule['aggregateDashboardDay']>(
      'apps/api/src/modules/admin/application/dashboard-days.ts',
      'aggregateDashboardDay',
    ),
    exported<DashboardDaysModule['tickDashboardDays']>(
      'apps/api/src/modules/admin/application/dashboard-days.ts',
      'tickDashboardDays',
    ),
  ]).then(([aggregateDashboardDay, tickDashboardDays]) => ({
    aggregateDashboardDay,
    tickDashboardDays,
  }));
}

/** The production sources over `db` (createDashboardDaySources, task brief §9). */
export async function sources(db: Kysely<DB>, clock: Clock): Promise<Sources> {
  const create = await exported<(deps: { db: Kysely<DB>; clock: Clock }) => Sources>(
    'apps/api/src/modules/admin/infra/dashboard-day-sources.ts',
    'createDashboardDaySources',
  );
  return create({ db, clock });
}

/** aggregateDashboardDay of (appId, day) with the production sources, at `now`. */
export async function aggregate(
  db: Kysely<DB>,
  appId: string,
  day: string,
  now: string | Clock,
): Promise<void> {
  const clock = typeof now === 'string' ? new FixedClock(now) : now;
  const { aggregateDashboardDay } = await days();
  await aggregateDashboardDay({ db, clock, sources: await sources(db, clock) }, { appId, day });
}

/** One tickDashboardDays with the production sources; `sourceDb` defaults to `db`. */
export async function tick(
  db: Kysely<DB>,
  clock: Clock,
  logger: RootLogger,
  sourceDb: Kysely<DB> = db,
): Promise<void> {
  const { tickDashboardDays } = await days();
  await tickDashboardDays({ db, clock, logger, sources: await sources(sourceDb, clock) });
}

/** readDashboardYesterday as other code gets it: admin's index.ts. */
export async function readYesterday(
  db: Kysely<DB>,
  appId: string,
  now: string,
): Promise<Yesterday | null> {
  const read = await exported<ReadYesterday>(
    'apps/api/src/modules/admin/index.ts',
    'readDashboardYesterday',
  );
  return read(db, { appId, now: new Date(now) });
}

// ---------------------------------------------------------------------------------------------
// The stored rows (read only after a skeleton function was called).

export interface DayRow {
  readonly day: string;
  readonly links: bigint;
  readonly orders: bigint;
  readonly est_rebate_fen: bigint;
  readonly new_users: bigint;
  readonly as_of: string;
}

interface RawRow {
  readonly day: string;
  readonly links: string;
  readonly orders: string;
  readonly est_rebate_fen: string;
  readonly new_users: string;
  readonly as_of: string;
}

/** The app's rows of app.admin_dashboard_days, oldest day first; as_of as an ISO instant. */
export async function rowsOf(db: Kysely<DB>, appId: string): Promise<DayRow[]> {
  const { rows } = await sql<RawRow>`SELECT stat_date::text AS day, links::text AS links,
      orders::text AS orders, est_rebate_fen::text AS est_rebate_fen,
      new_users::text AS new_users,
      to_char(as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS as_of
    FROM app.admin_dashboard_days WHERE app_id = ${appId} ORDER BY stat_date`.execute(db);
  return rows.map((row) => ({
    day: row.day,
    links: BigInt(row.links),
    orders: BigInt(row.orders),
    est_rebate_fen: BigInt(row.est_rebate_fen),
    new_users: BigInt(row.new_users),
    as_of: row.as_of,
  }));
}

/** The app's single row of `day`; asserts there is exactly one. */
export async function rowOf(db: Kysely<DB>, appId: string, day: string): Promise<DayRow> {
  const rows = (await rowsOf(db, appId)).filter((row) => row.day === day);
  expect(rows, `rows of ${appId} on ${day}`).toHaveLength(1);
  return rows[0]!;
}

export async function daysOf(db: Kysely<DB>, appId: string): Promise<string[]> {
  return (await rowsOf(db, appId)).map((row) => row.day);
}

// ---------------------------------------------------------------------------------------------
// Fixtures. Expected figures are written by hand in the tests.

/** An admin account: puts the app on the tick's list. */
export async function adminOf(db: Kysely<DB>, appId: string): Promise<void> {
  const id = randomUUID();
  await db
    .withSchema('app')
    .insertInto('admin_users')
    .values({
      id,
      app_id: appId,
      login_name: `dash_${id}`,
      password_hash: 'unused-test-login',
      is_super: false,
      status: 'active',
    })
    .execute();
}

export type LinkEvent = 'convert' | 'precompute' | 'register' | 'open';

/** One link_logs row of `event` created at `createdAt`. */
export async function linkLog(
  db: Kysely<DB>,
  appId: string,
  createdAt: string,
  event: LinkEvent = 'convert',
): Promise<void> {
  await db
    .withSchema('app')
    .insertInto('link_logs')
    .values({
      app_id: appId,
      link_id: null,
      user_id: null,
      platform: 'taobao',
      event,
      result_code: 0,
      created_at: new Date(createdAt),
    })
    .execute();
}

/** One users row registered at `createdAt`; a deleted account keeps its row (status=deleted). */
export async function userOf(
  db: Kysely<DB>,
  appId: string,
  createdAt: string,
  status: 'normal' | 'deleted' = 'normal',
): Promise<string> {
  const id = randomUUID();
  await db
    .withSchema('app')
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname: 'synthetic',
      avatar: '',
      invite_code: id,
      attr_code: id,
      level: 'L1',
      register_method: 'sms',
      status,
      deleted_reason: status === 'deleted' ? 'synthetic' : null,
      created_at: new Date(createdAt),
      updated_at: new Date(createdAt),
    })
    .execute();
  return id;
}

/** The app's published rule version (the foreign key of commission_splits). */
export async function rulesOf(db: Kysely<DB>, appId: string): Promise<string> {
  const id = randomUUID();
  const effective = new Date('2026-01-01T00:00:00.000Z');
  await db
    .withSchema('app')
    .insertInto('commission_rule_versions')
    .values({
      app_id: appId,
      rule_version_id: id,
      status: 'published',
      effective_from: effective,
      indirect_enabled: true,
      created_at: effective,
    })
    .execute();
  return id;
}

export type PlatformStatus = 'DEPOSIT_PAID' | 'PAID' | 'RECEIVED' | 'SETTLED' | 'INVALID';
export type RebateStatus =
  'UNATTRIBUTED' | 'ESTIMATED' | 'WAITING' | 'CREDITED' | 'VOID' | 'CLAWED_BACK';

export interface OrderSpec {
  /** orders.paid_at; null = not paid. */
  readonly paidAt: string | null;
  readonly platformStatus?: PlatformStatus;
  readonly rebateStatus?: RebateStatus;
  /** est_commission_fen; 1000 by default. */
  readonly estFen?: bigint;
  readonly settleFen?: bigint | null;
  /** Snapshot beneficiaries; the buyer as self at 5000 bp by default. */
  readonly people?: readonly Person[];
  /** Snapshot reserve_bp; 1500 by default. */
  readonly reserveBp?: number;
  readonly tljDeductFen?: bigint;
}

/**
 * One sub-order with its v1 commission snapshot (the pending-earnings fixture), returns order_id.
 * UNATTRIBUTED orders have no user; every other order has a buyer (registered 2026-10-20, far
 * from D).
 */
export async function orderOf(
  db: Kysely<DB>,
  appId: string,
  rules: string,
  spec: OrderSpec,
): Promise<string> {
  const rebateStatus = spec.rebateStatus ?? 'ESTIMATED';
  const buyer = randomUUID();
  const attrAt = new Date(spec.paidAt ?? D_NOON);
  return seed(
    db,
    { appId, userId: buyer, ruleVersionId: rules },
    {
      people: spec.people ?? [{ userId: buyer, role: 'self', ratioBp: 5000 }],
      reserveBp: spec.reserveBp ?? 1500,
      tljDeductFen: spec.tljDeductFen ?? 0n,
      order: {
        user_id: rebateStatus === 'UNATTRIBUTED' ? null : buyer,
        buy_type: rebateStatus === 'UNATTRIBUTED' ? null : 'self',
        platform_status: spec.platformStatus ?? 'PAID',
        rebate_status: rebateStatus,
        attr_at: attrAt,
        paid_at: spec.paidAt === null ? null : new Date(spec.paidAt),
        est_commission_fen: spec.estFen ?? 1000n,
        settle_commission_fen: spec.settleFen ?? null,
      },
    },
  );
}

/** An open rights deduction of the order (RIGHTS, SUCCEEDED, not yet answered by the union). */
export async function openRightsDeduction(
  db: Kysely<DB>,
  appId: string,
  orderId: string,
  deductionFen: bigint,
): Promise<void> {
  await db
    .withSchema('app')
    .insertInto('order_rights')
    .values({
      id: randomUUID(),
      app_id: appId,
      order_id: orderId,
      source: 'API',
      type: 'RIGHTS',
      status: 'SUCCEEDED',
      amount_fen: null,
      deduction_commission_fen: deductionFen,
      occurred_at: new Date(D_NOON),
      platform_rights_no: `rights-${randomUUID()}`,
      answered_at: null,
    })
    .execute();
}

/** Moves an order to another status pair directly (what a later sync would have left). */
export async function setStatus(
  db: Kysely<DB>,
  appId: string,
  orderId: string,
  rebateStatus: RebateStatus,
  platformStatus: PlatformStatus,
): Promise<void> {
  await db
    .withSchema('app')
    .updateTable('orders')
    .set({ rebate_status: rebateStatus, platform_status: platformStatus })
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .execute();
}

// ---------------------------------------------------------------------------------------------
// Clocks and logs.

/** A clock that moves `stepMs` forward after every read: the order of its reads is visible. */
export class SteppingClock implements Clock {
  private epochMs: number;
  private readonly stepMs: number;

  constructor(start: string, stepMs: number) {
    this.epochMs = Date.parse(start);
    this.stepMs = stepMs;
  }

  now(): Date {
    const current = new Date(this.epochMs);
    this.epochMs += this.stepMs;
    return current;
  }
}

/** pino error level. */
export const LOG_ERROR = 50;
export const DAY_FAILED = 'admin_dashboard_day_failed';

export function captureLogs(): {
  readonly logger: RootLogger;
  lines(): Record<string, unknown>[];
} {
  const raw: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void raw.push(line) },
  );
  return {
    logger,
    lines: () => raw.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** Error lines of admin_dashboard_day_failed (as the event field or the message). */
export function failureLines(lines: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return lines.filter(
    (line) =>
      Number(line['level']) >= LOG_ERROR &&
      (line['event'] === DAY_FAILED || line['msg'] === DAY_FAILED),
  );
}

// ---------------------------------------------------------------------------------------------
// A failing source.

export class SyntheticLinkFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyntheticLinkFailure';
  }
}

/** A distinctive token of the synthetic failure's message (never meant for the log). */
export const FAILURE_TOKEN = 'ztoken-7f3a91';

/** A statement on link_logs with `appId` among its values throws SyntheticLinkFailure. */
export function failLinksOf(appId: string): KyselyPlugin {
  return {
    transformQuery({ node }) {
      const text = JSON.stringify(node, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      if (text.includes('link_logs') && text.includes(`"${appId}"`)) {
        throw new SyntheticLinkFailure(`synthetic link_logs failure ${FAILURE_TOKEN}`);
      }
      return node;
    },
    transformResult({ result }) {
      return Promise.resolve(result);
    },
  };
}
