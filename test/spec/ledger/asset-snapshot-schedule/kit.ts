// B2-04zo rule-test kit (claude-independent, SPEC_REF 7acc0969): the schedule of the asset daily
// snapshot, 08 BR-FUND-18 (D+1 00:01:00 +08:00 写 D；余额按 accounting_date ≤ D；最晚等到 00:30，超时告警并
// 标记 waiting_comparable=false) and BR-FUND-20 (合计 > ledger.advance_alert_fen 的每一天告警 1 次).
// Conventions from the task brief §9 (D10-587): LedgerAssetSnapshotModule.forWorker, worker entry
// only; first tick about 15 s after bootstrap, then every 60 s; each tick lists the apps that have a
// ledger account and writes, per app, the due days after its newest snapshot, at most 7, oldest
// first; an older gap is one error line; an app without any snapshot gets only the newest due day.
// Rulings of review round 1 (编排会话): a failed day stops that app's newer days for the tick and the
// next tick restarts from the oldest missing day; a hole before the newest row, inside the 7-day
// window, is missing too; an unconfirmed row in the window is replayed before its 00:30, and after
// it only while event_log has no asset_snapshot.timed_out of (app, D).
// Real pieces: PostgreSQL as couli_app, a real AppModule.forEntry (no port injected by these tests),
// the platform EVENT_BUS (it writes event_log), settlement's real pending source and batch executor.
// Synthetic: the job queue (a recorder, as in ../../orders/rebate-wiring/kit.ts: nothing is worked
// unless a test calls a registered handler) and every row. Fake timers replace setTimeout /
// setInterval only, so PostgreSQL I/O and the polling below stay on real time; the other modules of
// the worker keep their own timers, which only read and send to the recorder.
// LedgerAssetSnapshotModule does not exist on the skeleton: it is reached through a cast, so its
// absence is an assertion here, never a compile error or a missing module.
// Integration tests pass the database in: this file never imports the test-database base.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely, type KyselyPlugin, type QueryId } from 'kysely';
import { expect, vi } from 'vitest';
import * as ledger from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  FixedClock,
  JOB_QUEUE,
  PlatformModule,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { account, entry, platform, voucher, type Account } from '../../db/ledger/invariants/kit.ts';
import { fakeQueue, rootLogger } from '../daily-check-schedule/kit.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const TIMEOUT = 120_000;

export const APP = 'ass-app-a';
export const OTHER = 'ass-app-b';
export const THIRD = 'ass-app-c';
export const BEFORE = '2032-06-14';
export const DAY = '2032-06-15';
export const NEXT_DAY = '2032-06-16';
export const ADVANCE_KEY = 'ledger.advance_alert_fen';
/** The two names of 规划/02 §11, copied by hand. */
export const TIMED_OUT = 'asset_snapshot.timed_out';
export const EXPOSURE = 'union_receivable.exposure_exceeded';
/** Task brief §9, written out by hand. */
export const FIRST_TICK_MS = 15_000;
export const TICK_MS = 60_000;
/** pino levels. */
export const LOG_WARN = 40;
export const LOG_ERROR = 50;

/** Rounds of tickUntil and the real time each round waits for the tick's I/O. */
const TICK_ROUNDS = 8;
const ROUND_WAIT_MS = 1_500;
const WAIT_MS = 6_000;
const QUIET_TICKS = 3;
const QUIET_PAUSE_MS = 200;

/** D+1 00:mm:ss +08:00 is D 16:mm:ss UTC. */
export function afterMidnight(day: string, minuteSecond: string): string {
  return `${day}T16:${minuteSecond}.000Z`;
}

/** D+1 00:01:00 +08:00: the moment D falls due. */
export function runAt(day: string): string {
  return afterMidnight(day, '01:00');
}

// ---------------------------------------------------------------------------------------------
// Real time.

/** The real setTimeout, taken before any fake timers are installed. */
const realSetTimeout = globalThis.setTimeout;

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    realSetTimeout(resolve, ms);
  });
}

/** Polls `check` on real time, without moving the fake timers. */
export async function waitFor(check: () => Promise<boolean>, ms = WAIT_MS): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await pause(20);
  }
  return check();
}

// ---------------------------------------------------------------------------------------------
// The assembly.

type Entry = 'worker' | 'api' | 'stream' | 'admin' | 'payout';

interface Forwarding {
  forWorker(...args: unknown[]): unknown;
}

interface AppModuleShape {
  AppModule: { forEntry(options: object): unknown };
}

interface Context {
  close(): Promise<void>;
}

async function appModule(): Promise<AppModuleShape['AppModule']> {
  // A URL import keeps the decorated HTTP controllers out of the spec project's TS compilation.
  const loaded = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as AppModuleShape;
  return loaded.AppModule;
}

/** The module under test; on the skeleton it is not exported and this assertion is the red. */
export function snapshotModule(): Forwarding {
  const target = (ledger as unknown as { LedgerAssetSnapshotModule?: Forwarding })
    .LedgerAssetSnapshotModule;
  expect(
    typeof target?.forWorker,
    'ledger/index.ts does not export LedgerAssetSnapshotModule.forWorker',
  ).toBe('function');
  return target!;
}

/** The forWorker calls of app.module on `entry` (captured; the module is not built). */
export async function assembledBy(entry: Entry): Promise<unknown[][]> {
  const target = snapshotModule();
  const AppModule = await appModule();
  const forWorker = vi.spyOn(target, 'forWorker').mockReturnValue({ module: target });
  try {
    AppModule.forEntry({
      entry,
      config: loadConfig({ APP_ENV: 'test' }),
      clock: new FixedClock(runAt(DAY)),
      logger: rootLogger().logger,
    });
    return [...forWorker.mock.calls];
  } finally {
    forWorker.mockRestore();
  }
}

interface BootOptions {
  /** The worker's Clock, or a new one at `now`; D+1 00:01:00 of DAY by default. */
  readonly clock?: FixedClock;
  readonly now?: string;
  readonly entry?: Entry;
  /** A handle of the same database (with a plugin of this kit). */
  readonly db?: Kysely<DB>;
}

interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

/** A field keyring on disk: settlement's worker needs FIELD_CRYPTO. */
async function keyFiles() {
  const dir = mkdtempSync(join(tmpdir(), 'b2-04zo-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  return {
    dir,
    env: {
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
      FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
    },
  };
}

/** One real process entry over `db`, under the fake timers inWorkerTime installed. */
async function bootEntry(db: Kysely<DB>, env: Record<string, string>, options: BootOptions) {
  const AppModule = await appModule();
  const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: { createApplicationContext(module: unknown, options: object): Promise<Context> };
  };
  const clock = options.clock ?? new FixedClock(options.now ?? runAt(DAY));
  const entryName = options.entry ?? 'worker';
  const root = rootLogger();
  const queue = fakeQueue();
  const original = PlatformModule.forRoot.bind(PlatformModule);
  const forRoot = vi.spyOn(PlatformModule, 'forRoot').mockImplementation((platformOptions) => {
    const module = original(platformOptions);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) =>
        typeof provider === 'object' && 'provide' in provider && provider.provide === JOB_QUEUE
          ? { provide: JOB_QUEUE, useValue: queue }
          : provider,
      ),
    };
  });
  let context: Context;
  try {
    context = await NestFactory.createApplicationContext(
      AppModule.forEntry({
        entry: entryName,
        config: loadConfig(
          entryName === 'worker' ? { APP_ENV: 'test', ...env } : { APP_ENV: 'test' },
        ),
        clock,
        logger: root.logger,
        dbHandles: { db: options.db ?? db, dbRead: null, close: async () => undefined },
      }),
      { logger: false, abortOnError: false },
    );
  } finally {
    forRoot.mockRestore();
  }

  let closing: { done: boolean; readonly failures: unknown[] } | undefined;
  /** Starts the shutdown once; the fake timers do not move. */
  function beginClose() {
    if (closing !== undefined) return closing;
    const state = { done: false, failures: [] as unknown[] };
    closing = state;
    void context.close().then(
      () => {
        state.done = true;
      },
      (error: unknown) => {
        state.failures.push(error);
        state.done = true;
      },
    );
    return state;
  }

  return {
    clock,
    queue,
    logs: root.lines,
    beginClose,
    /** Ends the shutdown; the fake timers move so every bounded stop of the worker can end. */
    async close(): Promise<void> {
      const state = beginClose();
      while (!state.done) {
        await pause(20);
        await vi.advanceTimersByTimeAsync(100);
      }
      if (state.failures.length > 0) throw state.failures[0];
    },
    /** Fires ticks (a skipped one is fired again) until `check` holds; false when it never does. */
    async tickUntil(check: () => Promise<boolean>): Promise<boolean> {
      for (let round = 0; round < TICK_ROUNDS; round += 1) {
        await vi.advanceTimersByTimeAsync(TICK_MS);
        if (await waitFor(check, ROUND_WAIT_MS)) return true;
      }
      return check();
    },
    /** Fires a few ticks with time for their I/O: for what must not happen. */
    async quiet(): Promise<void> {
      for (let round = 0; round < QUIET_TICKS; round += 1) {
        await vi.advanceTimersByTimeAsync(TICK_MS);
        await pause(QUIET_PAUSE_MS);
      }
    },
  };
}

type Worker = Awaited<ReturnType<typeof bootEntry>>;

/**
 * A fresh database (a tick lists every app, so each test owns one) with `db` as couli_app and the
 * fake timers installed. Entries booted through it are closed at the end, whatever happened.
 */
export async function inWorkerTime(
  create: () => Promise<TestDatabase>,
  run: (world: {
    readonly db: Kysely<DB>;
    boot(options?: BootOptions): Promise<Worker>;
    withWorker(options: BootOptions, work: (worker: Worker) => Promise<void>): Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const database = await create();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 10 });
  const keys = await keyFiles();
  await appModule();
  const booted: Worker[] = [];
  async function boot(options: BootOptions = {}): Promise<Worker> {
    const worker = await bootEntry(db, keys.env, options);
    booted.push(worker);
    return worker;
  }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  try {
    await run({
      db,
      boot,
      async withWorker(options, work) {
        const worker = await boot(options);
        await work(worker);
        await worker.close();
      },
    });
  } finally {
    try {
      // One after the other: a close moves the shared fake timers.
      for (const worker of booted) await worker.close();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      rmSync(keys.dir, { recursive: true, force: true });
      await destroyDb(db);
      await database.drop();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Fixtures. Amounts are written by hand in the tests.

/** Any ledger account puts the app on the tick's list (the daily check's list). */
export async function ledgerApp(db: Kysely<DB>, appId: string): Promise<Account> {
  return account(db, { app_id: appId });
}

export function union(db: Kysely<DB>, appId: string, name = 'taobao'): Promise<Account> {
  return platform(db, `UNION_RECEIVABLE:${name}`, appId);
}

/** One entry of `amount` on a UNION_RECEIVABLE account, dated `day`. */
export async function book(
  db: Kysely<DB>,
  receivable: Account,
  day: string,
  amount: bigint,
): Promise<void> {
  const dated = await voucher(db, { app_id: receivable.app_id, accounting_date: day });
  await entry(db, receivable, dated, amount);
}

/** Stores a config_items row (or changes it), never through the seed. */
export async function setConfig(
  db: Kysely<DB>,
  appId: string,
  key: string,
  value: unknown,
): Promise<void> {
  await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
    VALUES (${appId}, ${key}, ${JSON.stringify(value)}::jsonb, 'synthetic')
    ON CONFLICT (app_id, key) DO UPDATE SET value = EXCLUDED.value`.execute(db);
}

// ---------------------------------------------------------------------------------------------
// What the ticks left behind.

export function snapshotRows(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('asset_snapshots')
    .selectAll()
    .select((eb) => eb.cast<string>('snapshot_date', 'text').as('day'))
    .where('app_id', '=', appId)
    .orderBy('snapshot_date')
    .execute();
}

export async function days(db: Kysely<DB>, appId: string): Promise<string[]> {
  return (await snapshotRows(db, appId)).map((row) => row.day);
}

export async function hasDay(db: Kysely<DB>, appId: string, day: string): Promise<boolean> {
  return (await days(db, appId)).includes(day);
}

/** The day's row exists and is confirmed (it is committed false and confirmed afterwards). */
export async function comparable(db: Kysely<DB>, appId: string, day: string): Promise<boolean> {
  const rows = await snapshotRows(db, appId);
  return rows.some((row) => row.day === day && row.waiting_comparable);
}

export function receivablesOf(db: Kysely<DB>, appId: string, day: string) {
  return db
    .withSchema('app')
    .selectFrom('asset_snapshot_receivables as r')
    .innerJoin('asset_snapshots as s', (join) =>
      join.onRef('s.app_id', '=', 'r.app_id').onRef('s.id', '=', 'r.asset_snapshot_id'),
    )
    .select(['r.platform', 'r.union_receivable_fen'])
    .where('s.app_id', '=', appId)
    .where('s.snapshot_date', '=', sql<Date>`${day}::date`)
    .orderBy('r.platform')
    .execute();
}

/** The app's two alert events in the order they were published. */
export async function alertEvents(db: Kysely<DB>, appId: string) {
  const rows = await db
    .withSchema('app')
    .selectFrom('event_log')
    .select(['name', 'payload'])
    .where('app_id', '=', appId)
    .where('name', 'in', [TIMED_OUT, EXPOSURE])
    .orderBy('id')
    .execute();
  return rows.map((row) => ({
    name: row.name,
    data: (row.payload as unknown as { data: Record<string, unknown> }).data,
  }));
}

/** 02 §11 union_receivable.exposure_exceeded; amounts are JSON integers of fen. */
export function exposure(appId: string, day: string, sumFen: number, thresholdFen: number) {
  return {
    name: EXPOSURE,
    data: {
      app_id: appId,
      accounting_date: day,
      type: 'ledger_advance_exposure',
      sum_fen: sumFen,
      threshold_fen: thresholdFen,
    },
  };
}

/** 02 §11 asset_snapshot.timed_out. */
export function timedOut(appId: string, day: string) {
  return {
    name: TIMED_OUT,
    data: {
      app_id: appId,
      accounting_date: day,
      type: 'asset_snapshot_timeout',
      waiting_comparable: false,
    },
  };
}

/** Log lines at or above `level` that speak of a snapshot and name the app. */
export function snapshotLogs(
  lines: readonly Record<string, unknown>[],
  appId: string,
  level: number,
): Record<string, unknown>[] {
  return lines.filter((line) => {
    const text = JSON.stringify(line);
    return Number(line['level']) >= level && text.includes(appId) && /snapshot/iu.test(text);
  });
}

/** Log lines of one alert event (the runner logs each alert it raised, once). */
export function eventLines(
  lines: readonly Record<string, unknown>[],
  event: string,
): Record<string, unknown>[] {
  return lines.filter((line) => line['event'] === event);
}

// ---------------------------------------------------------------------------------------------
// Kysely plugins on a handle of the same database.

type QueryNode = Parameters<KyselyPlugin['transformQuery']>[0]['node'];

function insertsSnapshot(node: QueryNode): boolean {
  return node.kind === 'InsertQueryNode' && node.into?.table.identifier.name === 'asset_snapshots';
}

/**
 * Holds every INSERT into asset_snapshots after it ran, its transaction still open, until released.
 * `attempts` counts the inserts that were started.
 */
export function snapshotGate() {
  const release = Promise.withResolvers<void>();
  const marked = new WeakSet<QueryId>();
  let attempts = 0;
  let entered = false;
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (insertsSnapshot(node)) {
        attempts += 1;
        marked.add(queryId);
      }
      return node;
    },
    async transformResult({ queryId, result }) {
      if (marked.has(queryId)) {
        entered = true;
        await release.promise;
      }
      return result;
    },
  };
  return {
    plugin,
    attempts: () => attempts,
    entered: () => entered,
    release: () => {
      release.resolve();
    },
  };
}

/** The INSERT into asset_snapshots of an app in `failing` throws `message`. */
export function failSnapshotWrite(failing: ReadonlySet<string>, message: string): KyselyPlugin {
  return {
    transformQuery({ node }) {
      if (insertsSnapshot(node)) {
        const text = JSON.stringify(node, (_key, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        );
        for (const appId of failing) {
          if (text.includes(appId)) throw new Error(message);
        }
      }
      return node;
    },
    transformResult({ result }) {
      return Promise.resolve(result);
    },
  };
}

/** A query node as text; bigint parameters become decimal strings. */
function nodeText(node: QueryNode): string {
  return JSON.stringify(node, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

/**
 * Until cleared, the INSERT into asset_snapshots of (appId, day) throws; other days and apps go
 * through. `attempts` lists the days of every INSERT of `appId` in order, failed ones included.
 * The day is the quoted parameter: created_at has more after the date, so it cannot match.
 */
export function failSnapshotDay(appId: string, day: string) {
  const attempts: string[] = [];
  let armed = true;
  let tripped = 0;
  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      if (insertsSnapshot(node)) {
        const text = nodeText(node);
        const written = /"(\d{4}-\d{2}-\d{2})"/u.exec(text)?.[1];
        if (written !== undefined && text.includes(`"${appId}"`)) {
          attempts.push(written);
          if (armed && written === day) {
            tripped += 1;
            throw new Error('synthetic failure of one day of the snapshot');
          }
        }
      }
      return node;
    },
    transformResult({ result }) {
      return Promise.resolve(result);
    },
  };
  return {
    plugin,
    attempts: () => [...attempts],
    tripped: () => tripped,
    clear: () => {
      armed = false;
    },
  };
}

/** The first UPDATE of asset_snapshots (the only one is the confirmation) throws, once. */
export function failConfirmOnce() {
  let armed = true;
  let tripped = 0;
  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      if (
        armed &&
        node.kind === 'UpdateQueryNode' &&
        JSON.stringify(node.table ?? null).includes('"name":"asset_snapshots"')
      ) {
        armed = false;
        tripped += 1;
        throw new Error('synthetic failure of the confirmation');
      }
      return node;
    },
    transformResult({ result }) {
      return Promise.resolve(result);
    },
  };
  return { plugin, tripped: () => tripped };
}

/**
 * Until cleared, a read of ledger_accounts that does not touch ledger_entries throws: the app list
 * of a tick (Kysely or raw), not the balance sums of a day. The daily check's list fails with it
 * and survives on its own guard, so `tripped` alone does not prove the snapshot tick was hit.
 */
export function failAppListing() {
  let armed = true;
  let tripped = 0;
  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      if (armed && (node.kind === 'SelectQueryNode' || node.kind === 'RawNode')) {
        const text = nodeText(node);
        if (text.includes('ledger_accounts') && !text.includes('ledger_entries')) {
          tripped += 1;
          throw new Error('synthetic failure of the app list');
        }
      }
      return node;
    },
    transformResult({ result }) {
      return Promise.resolve(result);
    },
  };
  return {
    plugin,
    tripped: () => tripped,
    clear: () => {
      armed = false;
    },
  };
}
