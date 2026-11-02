// B1-09n rule-test kit (D10-548, D10-550, D10-551, FU-REBATE-PORT-WIRING). The gap under test came
// from tests that inject their own ports, so nothing here does: every order goes through the
// pipeline of a real AppModule.forEntry({ entry: 'worker' }), over a real field keyring (risk's
// order blocklist needs FIELD_CRYPTO, which a plain test config does not provide). Only the job
// queue is a stub, as in ../wiring/context-kit.ts: the bus still writes event_log.
// Expected amounts are written by hand in the tests. The rule version is the commission fixture's:
// reserve 0, own share 50 %, and jd deducts no service fee, so N = 1000 gives 500. pdd's commission
// includes the service fee (BR-CALC-03): commission 1000 with fee 100 is N = 900, which gives 450.
// Integration tests pass the database in: this file never imports @couli/db/testing.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import type { OrderSyncRuntime } from '../../../../apps/api/src/modules/orders/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import type { EventBus, ReceivedJob } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import { BEFORE, level, PAID } from '../../commission/resolver/kit.ts';
import { seedVersion, version } from '../../commission/snapshot/fixtures.ts';
import { ports } from '../../risk/freeze-expiry/kit.ts';
import { capture, order } from '../attribution/kit.ts';
import { compileOnlyDb, runtime } from '../wiring/context-kit.ts';
import { account, at, pid, user } from '../wiring/db-kit.ts';

export { AFTER_CREDIT } from '../blacklist/plan-kit.ts';
export { capture } from '../attribution/kit.ts';
export { PAID } from '../../commission/resolver/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);

export const TIMEOUT = 90_000;
/** A jd sync moment after PAID (the rule version is effective before it). */
export const SYNCED = '2026-10-22T03:00:00.000Z';
export const ATTR_CODE = 'abcd1234';
export const UNKNOWN_CODE = 'zzzz9999';
export const RELATION = 'channel-synthetic';
/** specs/order-status-map/jd.csv. */
export const JD_PAID = '16';
export const JD_RECEIVED = '17';
export const JD_INVALID = '3';
export const JD_DEPOSIT = '24';
export const JD_UNMAPPED = 'synthetic-unmapped';
/** specs/order-status-map/pdd.csv. */
export const PDD_PAID = '0';
/** A receipt after PAID: settle_period 2026-10. */
export const RECEIVED_AT = at('2026-10-21T02:00:00.000Z');

/** The platforms with a status map file today. */
type FixturePlatform = 'jd' | 'pdd';

interface Context {
  get(token: unknown, options?: { strict: boolean }): unknown;
  close(): Promise<void>;
}

interface WorkerPlatform {
  PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
  JOB_QUEUE: symbol;
  EVENT_BUS: symbol;
  CLOCK: symbol;
  FIELD_CRYPTO: symbol;
  loadConfig(env: Record<string, string>): unknown;
}

/** A real worker entry with a field keyring, on `db` or on a compile-only database. */
export async function keyedWorker(db?: Kysely<DB>) {
  // URL imports keep decorated HTTP controllers out of the spec project's TS compilation.
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: object): unknown };
  };
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as WorkerPlatform;
  const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: { createApplicationContext(module: unknown, options: object): Promise<Context> };
  };
  const p = await ports();
  const queue = {
    send: vi.fn(async () => 'fixture'),
    register: vi.fn<(name: string, handler: (job: ReceivedJob) => Promise<void>) => void>(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const original = platform.PlatformModule.forRoot.bind(platform.PlatformModule);
  const spy = vi.spyOn(platform.PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = original(options);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === platform.JOB_QUEUE
          ? { provide: platform.JOB_QUEUE, useValue: queue }
          : provider,
      ),
    };
  });
  const dir = mkdtempSync(join(tmpdir(), 'b1-09n-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  let context: Context;
  try {
    context = await NestFactory.createApplicationContext(
      AppModule.forEntry({
        entry: 'worker',
        config: platform.loadConfig({
          APP_ENV: 'test',
          FIELD_KEY_PROVIDER: 'local',
          FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
          FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
        }),
        clock: p.clock,
        logger: p.logger,
        dbHandles: {
          db: db ?? compileOnlyDb([]),
          dbRead: null,
          close: async () => undefined,
        },
      }),
      { logger: false, abortOnError: false },
    );
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    spy.mockRestore();
  }
  return {
    context,
    platform,
    clock: context.get(platform.CLOCK, { strict: false }) as typeof p.clock,
    async close() {
      await context.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Owner {
  readonly appId: string;
  readonly userId: string;
}

/**
 * The app's union account, its promotion slot, the published rule version and the owner's level
 * at paid_at. The owner is a new user with ATTR_CODE unless the caller already has one.
 */
async function seedApp(db: Kysely<DB>, platform: FixturePlatform, given?: Owner) {
  const a = await account(db, {
    platform,
    ...(given === undefined ? {} : { app_id: given.appId }),
  });
  const userId = given?.userId ?? (await user(db, a.app_id, { attr_code: ATTR_CODE })).id;
  await pid(db, a);
  await level(db, a.app_id, userId, 'L1', BEFORE);
  await seedVersion(db, a.app_id, version());
  return { account: a, appId: a.app_id, userId };
}

/** One sub-order of the owner as jd reports it: paid, N = 1000, attribution code in sub_union_id. */
function jdOrder(patch: Partial<UnionOrder> = {}): UnionOrder {
  return order({
    platform: 'jd',
    sub_order_id: randomUUID(),
    raw_status: JD_PAID,
    attr_params: {
      relation_id: RELATION,
      sub_union_id: `n_${ATTR_CODE}`,
      custom_parameters: null,
    },
    commission_fen: 1000n,
    est_commission_fen: 1000n,
    paid_at: PAID,
    modified_at: at('2026-10-20T03:00:00.000Z'),
    ...patch,
  });
}

/** One sub-order of the owner as pdd reports it: paid, commission 1000 including a fee of 100. */
function pddOrder(patch: Partial<UnionOrder> = {}): UnionOrder {
  return order({
    platform: 'pdd',
    sub_order_id: randomUUID(),
    raw_status: PDD_PAID,
    attr_params: {
      relation_id: null,
      sub_union_id: null,
      custom_parameters: JSON.stringify({ app: 'n', uid: ATTR_CODE }),
    },
    commission_fen: 1000n,
    est_commission_fen: 1000n,
    service_fee_fen: 100n,
    paid_at: PAID,
    modified_at: at('2026-10-20T03:00:00.000Z'),
    ...patch,
  });
}

const ORDER_OF: Record<FixturePlatform, (patch?: Partial<UnionOrder>) => UnionOrder> = {
  jd: jdOrder,
  pdd: pddOrder,
};

interface FixtureOptions {
  /** The order's platform; jd unless the case is about another platform's rules. */
  readonly platform?: FixturePlatform;
  /** An existing app and user (the api entry's member) instead of a new one. */
  readonly owner?: Owner;
  /** The worker's Clock; the sync moment by default. */
  readonly now?: string;
  readonly patch?: Partial<UnionOrder>;
}

/** A seeded app and a production worker over `db`; the caller closes it. */
export async function syncFixture(db: Kysely<DB>, options: FixtureOptions = {}) {
  const platform = options.platform ?? 'jd';
  const seeded = await seedApp(db, platform, options.owner);
  const { appId, userId } = seeded;
  const worker = await keyedWorker(db);
  try {
    const r: OrderSyncRuntime = await runtime(worker.context);
    const clock = worker.clock;
    clock.set(options.now ?? SYNCED);
    const events = worker.context.get(worker.platform.EVENT_BUS, { strict: false }) as EventBus;
    const incoming = ORDER_OF[platform](options.patch);
    let sequence = 0;

    /** One report of the order through the production pipeline, one minute after the last. */
    async function report(patch: Partial<UnionOrder> = {}) {
      sequence += 1;
      clock.advanceMs(60_000);
      return r.pipeline.process(
        { ...incoming, ...patch, raw_payload_id: `${100 + sequence}` },
        {
          app_id: appId,
          platform,
          union_account_id: seeded.account.id,
          query_kind: 'increment',
          scene: '-',
          window_start: '2026-10-01T02:03:04.000Z',
          window_end: clock.now().toISOString(),
          requestId: randomUUID(),
        },
      );
    }

    /** report() that must go through. */
    async function sync(patch: Partial<UnionOrder> = {}): Promise<void> {
      const result = await capture(() => report(patch));
      expect(result).toMatchObject({ ok: true });
    }

    /** The same order again with only the mtime moved: its content hash changes, nothing else. */
    function touch(minute: number, patch: Partial<UnionOrder> = {}): Partial<UnionOrder> {
      const minutes = String(minute).padStart(2, '0');
      return { modified_at: at(`2026-10-21T01:${minutes}:00.000Z`), ...patch };
    }

    const row = () =>
      db.selectFrom('orders').selectAll().where('app_id', '=', appId).executeTakeFirstOrThrow();

    return {
      db,
      appId,
      userId,
      clock,
      events,
      incoming,
      close: worker.close,
      sync,
      report,
      touch,
      row,
      splits: () =>
        db.selectFrom('commission_splits').selectAll().where('app_id', '=', appId).execute(),
      amounts: () =>
        db
          .selectFrom('commission_split_amounts')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('commission_version')
          .execute(),
      totals: () =>
        db
          .selectFrom('commission_split_totals')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('commission_version')
          .execute(),
      hits: () => db.selectFrom('risk_hits').selectAll().where('app_id', '=', appId).execute(),
      pending: () =>
        db.selectFrom('order_sync_pending').selectAll().where('app_id', '=', appId).execute(),
      async eventNames() {
        const rows = await db
          .selectFrom('event_log')
          .select('name')
          .where('app_id', '=', appId)
          .execute();
        return rows.map((event) => event.name);
      },
      async setConfig(key: string, value: unknown) {
        await db
          .insertInto('config_items')
          .values({
            app_id: appId,
            key,
            value: JSON.stringify(value),
            version: 1,
            updated_by: 'fixture',
          })
          .execute();
      },
      /** An active channel entry of this union account, covering the order's attr_at. */
      async blockChannel() {
        const since = at('2026-10-01T00:00:00.000Z');
        await db
          .insertInto('blocklist')
          .values({
            id: randomUUID(),
            app_id: appId,
            dimension: 'channel',
            value: RELATION,
            value_hmac: null,
            platform,
            union_account_id: seeded.account.id,
            start_at: since,
            end_at: null,
            expire_at: null,
            status: 'active',
            violation_type: 'other',
            created_by: 'fixture-admin',
            created_at: since,
            updated_at: since,
          })
          .execute();
      },
    };
  } catch (error) {
    await worker.close();
    throw error;
  }
}

/** Runs `test` on a fresh fixture and always closes its worker. */
export async function withFixture(
  db: Kysely<DB>,
  test: (f: Awaited<ReturnType<typeof syncFixture>>) => Promise<void>,
  options: FixtureOptions = {},
): Promise<void> {
  const f = await syncFixture(db, options);
  try {
    await test(f);
  } finally {
    await f.close();
  }
}
