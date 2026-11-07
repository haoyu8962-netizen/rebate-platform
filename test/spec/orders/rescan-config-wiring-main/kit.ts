// B1-04zzzu rule-test kit (claude-independent, SPEC_REF b79958d; FU-RESCAN-CONFIG-WIRING, D10-845):
// the Taobao rescan settings as the production worker reads them.
// Real pieces: AppModule.forEntry({ entry: 'worker' }) (the composition root, not started: what it
// hands to OrdersModule.forWorker is captured, then the original runs as usual), its rescanConfig
// factory called with the worker's database and clock as the runtime calls it, content's config_items
// of ORDER_SYNC_APP_ID on PostgreSQL as couli_app (one fresh database per case: couli_app cannot
// delete config_items rows, and the app id is fixed), and the rescan scheduler's round
// (scheduleOrderRescan, what every tier's timer runs) over that port.
// Synthetic: the union side of a round (one Taobao account, queryable, circuit closed, site auth
// available, the increment caught up with the clock, no rescan cursor yet) and the recording queue,
// from ../rescan/kit.ts; no union is called. Time is the injected FixedClock only.
// A fixture that cannot be built throws a plain Error; only the wiring may be what is missing.
// Nothing here imports the test-database base (`@couli/db/testing`): only *.int.test.ts may, and
// each such file hands its createTestDatabase to installCaseDatabase at top level.
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { scheduleOrderRescan } from '../../../../apps/api/src/modules/orders/application/order-rescan.ts';
import type {
  OrderRescanWindow,
  SyncAccount,
} from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';
import type { SyncIntervalConfig } from '../../../../apps/api/src/modules/orders/application/sync-scheduler.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig, type Clock } from '../../../../apps/api/src/modules/platform/index.ts';
import { memoryLogger } from '../../platform/queue/kit.ts';
import { MINUTE_MS, NOW, TAOBAO_ACCOUNT, fixture } from '../rescan/kit.ts';

/** app.module's ORDER_SYNC_APP_ID: the app whose config_items rows hold order_sync.*. */
export const ORDER_SYNC_APP_ID = 'couli';
/** Another app's rows, which the worker's rescan never reads. */
export const OTHER_APP_ID = 'rescan-config-wiring-other';

export const PROMO_MODE = 'order_sync.promo_mode';
export const ENABLED = 'order_sync.rescan.taobao.enabled';
export const DAYS = 'order_sync.rescan.taobao.days';
export const HOUR_ENABLED = 'order_sync.rescan.taobao.hour.enabled';
export const WEEK_ENABLED = 'order_sync.rescan.taobao.week.enabled';
export const WINDOW_MINUTES = 'order_sync.rescan.taobao.window_minutes';

/** The orders defaults with no row: day 180 minutes (update), hour 20 (pay), week off. */
export const DEFAULT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  rescan: 180,
  rescan_hour: 20,
});

const TAOBAO: SyncAccount = {
  app_id: 'rescan-config-wiring',
  platform: 'taobao',
  union_account_id: TAOBAO_ACCOUNT,
  sync_start_at: '2026-01-01T00:00:00.000Z',
};

/** The members of the test-database base's database this kit uses (structural, no import). */
export interface CaseDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

let database: CaseDatabase | undefined;
let db: Kysely<DB> | undefined;

/**
 * Registers the per-case database lifecycle: a fresh database before each case, connected as
 * couli_app, and after it the mocks restored, the pool closed and the database dropped. Call it
 * once at the top level of the *.int.test.ts file, with `createTestDatabase` from `@couli/db/testing`.
 */
export function installCaseDatabase(create: () => Promise<CaseDatabase>): void {
  beforeEach(async () => {
    database = await create();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  }, 180_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      if (db !== undefined) await destroyDb(db);
    } finally {
      db = undefined;
      await database?.drop();
      database = undefined;
    }
  }, 60_000);
}

function caseDb(): Kysely<DB> {
  if (db === undefined) throw new Error('kit: the case database is not ready');
  return db;
}

interface WorkerOptions {
  readonly rescanConfig?: (db: Kysely<DB>, clock: Clock) => SyncIntervalConfig;
}

/**
 * The rescanConfig factory app.module hands to OrdersModule.forWorker on the worker entry, called
 * as createOrderSyncRuntime calls it: once, with the worker's database and clock.
 */
async function productionRescanConfig(
  handle: Kysely<DB>,
  clock: Clock,
): Promise<SyncIntervalConfig> {
  // URL imports keep decorated HTTP controllers out of the spec project's TS compilation.
  const { AppModule } = (await import(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as { AppModule: { forEntry(options: object): unknown } };
  const { OrdersModule } = (await import(
    new URL('../../../../apps/api/src/modules/orders/index.ts', import.meta.url).href
  )) as { OrdersModule: { forWorker(options: WorkerOptions): unknown } };
  const spy = vi.spyOn(OrdersModule, 'forWorker');
  let captured: WorkerOptions[] = [];
  try {
    AppModule.forEntry({
      entry: 'worker',
      config: loadConfig({ APP_ENV: 'test' }),
      clock,
      logger: memoryLogger('worker').logger,
      dbHandles: { db: handle, dbRead: null, close: async () => undefined },
    });
    captured = spy.mock.calls.map(([options]) => options);
  } finally {
    spy.mockRestore();
  }
  expect(captured, 'the worker entry assembles OrdersModule.forWorker once').toHaveLength(1);
  const factory = captured[0]!.rescanConfig;
  expect(typeof factory, 'the worker hands orders a rescanConfig port').toBe('function');
  return factory!(handle, clock);
}

/** One round's windows: minutes per query_kind, their time bases, and the round's warnings. */
export interface Round {
  readonly minutes: Readonly<Record<string, number>>;
  readonly timeBasis: Readonly<Record<string, string | undefined>>;
  /** How many warn calls carried exactly `{ key }` (the orders invalid-setting warning). */
  warned(key: string): number;
}

/** The production port over this case's database, and a writer for its config_items rows. */
export async function scene() {
  const handle = caseDb();
  const clock = new FixedClock(NOW);
  const config = await productionRescanConfig(handle, clock);

  /** Upserts (appId, key) as an admin save would leave it: the JSON value. */
  async function set(key: string, value: unknown, appId = ORDER_SYNC_APP_ID): Promise<void> {
    const json = JSON.stringify(value);
    await handle
      .insertInto('config_items')
      .values({ app_id: appId, key, value: json, updated_by: 'synthetic-b1-04zzz' })
      .onConflict((oc) =>
        oc
          .columns(['app_id', 'key'])
          .doUpdateSet({ value: json, updated_by: 'synthetic-b1-04zzz' }),
      )
      .execute();
  }

  /** The next Taobao round over every tier, as the tiers' timers run it. */
  async function round(): Promise<Round> {
    const f = fixture({ accounts: [TAOBAO] });
    await scheduleOrderRescan({ ...f.ruleTableCaps, config }, ['taobao']);
    const windows = f.sent().map((payload) => payload as OrderRescanWindow);
    const minutes: Record<string, number> = {};
    const timeBasis: Record<string, string | undefined> = {};
    for (const win of windows) {
      if (Object.hasOwn(minutes, win.query_kind)) {
        throw new Error(`kit: two ${win.query_kind} windows in one round`);
      }
      minutes[win.query_kind] =
        (Date.parse(win.window_end) - Date.parse(win.window_start)) / MINUTE_MS;
      timeBasis[win.query_kind] = win.timeBasis;
    }
    const warns = f.logger.warn.mock.calls.map((call: readonly unknown[]) =>
      JSON.stringify(call[0]),
    );
    return {
      minutes,
      timeBasis,
      warned: (key) => warns.filter((fields) => fields === JSON.stringify({ key })).length,
    };
  }

  return { set, round };
}
