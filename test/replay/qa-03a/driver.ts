// Test infrastructure only. Business writes below are fixture configuration/users, never orders,
// commission results, balances or status transitions. HTTP and order-sync own all result rows.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { accountingDate, settlementBillPeriod } from '@couli/domain';
import type { Kysely, PostgresPool } from 'kysely';
import { expect, vi } from 'vitest';
import { createCatalog } from '../../../apps/api/src/modules/catalog/index.ts';
import {
  createContentReader,
  createSystemSwitchWriter,
} from '../../../apps/api/src/modules/content/index.ts';
import {
  AttrCodeReader,
  CallerContext,
  LinkingModule,
  createOrderBindingReader,
  createOrderSourceReader,
} from '../../../apps/api/src/modules/linking/index.ts';
import type { JdPddIdentity } from '../../../apps/api/src/modules/linking/application/link-open-conversion.ts';
import { createDailyCheck } from '../../../apps/api/src/modules/ledger/application/daily-check.ts';
import { createDailyCheckExecutor } from '../../../apps/api/src/modules/ledger/application/daily-check-execute.ts';
import { directoryInvariantSource } from '../../../apps/api/src/modules/ledger/infra/invariant-files.ts';
import {
  createOrderPipeline,
  createOrderSourcePorts,
  createOrderUpdateStep,
} from '../../../apps/api/src/modules/orders/index.ts';
import type { CommissionSnapshotPort } from '../../../apps/api/src/modules/orders/application/commission-snapshot-step.ts';
import type { OrderPipelineDeps } from '../../../apps/api/src/modules/orders/application/pipeline-types.ts';
import type {
  OrderRebateAssembly,
  OrderSyncRebatePort,
} from '../../../apps/api/src/modules/orders/worker-runtime.ts';
import { loadStatusMap } from '../../../apps/api/src/modules/orders/domain/status-map.ts';
import { createSyncCursorStore } from '../../../apps/api/src/modules/orders/infra/sync-cursors.ts';
import { handleOrderSyncWindow } from '../../../apps/api/src/modules/orders/jobs/order-sync.ts';
import { createWithdrawHolds } from '../../../apps/api/src/modules/payout/index.ts';
import {
  EVENT_BUS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type AuditPort,
  type Clock,
  type DbHandles,
  type EventBus,
  type RootLogger,
} from '../../../apps/api/src/modules/platform/index.ts';
import {
  LocalKeyProvider,
  createWrappedKeyring,
} from '../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  DemoUnionAdapter,
  UnionError,
  createUnionOrderReaders,
  createUnionSyncAccess,
} from '../../../apps/api/src/modules/union/index.ts';
import type { DemoOrderSeed } from '../../../apps/api/src/modules/union/infra/demo/demo-order-stream.ts';
import { seedVersion, version } from '../../spec/commission/snapshot/fixtures.ts';
import { PAID, RECEIVED, START, demoStream, replayClock } from './stream-fixture.ts';

const root = new URL('../../../', import.meta.url);
// Runtime public entry, erased leaf type queries: keep Nest decorators out of test/tsconfig.
const { createOrderUserReader, lockUsersForUpdate } = (await import(
  new URL('apps/api/src/modules/identity/index.ts', root).href
)) as {
  createOrderUserReader: typeof import('../../../apps/api/src/modules/identity/infra/order-user-reader.ts').createOrderUserReader;
  lockUsersForUpdate: typeof import('../../../apps/api/src/modules/identity/ports/lock-users.ts').lockUsersForUpdate;
};
const requireApi = createRequire(new URL('apps/api/package.json', root));
const logger = createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });

interface Response {
  statusCode: number;
  json<T = unknown>(): T;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: symbol): T;
  inject(request: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<Response>;
}

/** Matches production assembly's audit for system withdrawal holds (no admin actor exists). */
function holdAudit(): AuditPort {
  return {
    append: async (input) => {
      logger.info(
        { app_id: input.appId, actor: input.actor, action: input.action, target: input.target },
        'withdraw_hold_system_audit',
      );
    },
  };
}

export async function checkpoint(db: Kysely<DB>, clock: Clock, appId: string) {
  const day = accountingDate(clock.now());
  const source = directoryInvariantSource();
  const files = await source.load();
  expect(files.length).toBeGreaterThan(0);
  // No app filter: every active ledger SQL must run and any difference must fail the stage.
  const result = await createDailyCheck({ clock, logger, invariants: source }).runDailyCheck(db, {
    accountingDate: day,
  });
  expect(result.checks.map((check) => check.file).sort()).toEqual(
    files.map((file) => file.name).sort(),
  );
  const execution = await createDailyCheckExecutor({
    clock,
    logger,
    holds: createWithdrawHolds({ clock, lockUsersForUpdate, audit: holdAudit() }),
    autoSettlement: createSystemSwitchWriter({ clock, logger }),
  }).execute(db, { accountingDate: day, differences: result.filedDifferences });
  expect(result.accountDifferences).toEqual([]);
  expect(result.globalDifferences).toEqual([]);
  expect(result.filedDifferences).toEqual([]);
  expect(execution).toEqual({ accountingDate: day, reconDiffs: [], autoSettlementOff: [] });
  expect(
    await db
      .selectFrom('recon_diffs')
      .select('id')
      .where('app_id', '=', appId)
      .where('type', '=', 'ledger_mismatch')
      .execute(),
  ).toEqual([]);
  return { day, billPeriod: settlementBillPeriod(clock.now()), files: result.checks.length };
}

// The test-database factories come from the *.int.test.ts caller (depcruise rule
// testcontainers-only-in-int-tests): this helper never imports @couli/db/testing itself.
export type ReplayTestInfra = {
  createTestDatabase(): Promise<{ urlFor(role: 'couli_app'): string; drop(): Promise<void> }>;
  acquireTestRedis(): Promise<{ url: string; stop(): Promise<unknown> }>;
};

export async function startReplay({ createTestDatabase, acquireTestRedis }: ReplayTestInfra) {
  const cleanups: (() => Promise<unknown>)[] = [];
  const close = async () => {
    const failures: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'replay cleanup failed');
  };
  try {
    // createTestDatabase consumes the integration globalSetup's TEST_PG_ADMIN_URL.
    const database = await createTestDatabase();
    cleanups.push(() => database.drop());
    const pg = requireApi('pg') as { Pool: new (config: object) => PostgresPool };
    const db = createDb({
      connectionString: database.urlFor('couli_app'),
      max: 8,
      poolFactory: (options) => new pg.Pool({ ...options, connectionTimeoutMillis: 5_000 }),
    });
    cleanups.push(() => destroyDb(db));
    const redis = await acquireTestRedis();
    cleanups.push(() => redis.stop());
    const base = fileURLToPath(new URL('.tmp/', root));
    mkdirSync(base, { recursive: true });
    const directory = mkdtempSync(join(base, 'qa03a-'));
    cleanups.push(async () => rmSync(directory, { recursive: true, force: true }));
    // Ephemeral synthetic field-encryption material, as in linking/wiring/app.int.test.ts.
    const material = randomBytes(32);
    const ring = await createWrappedKeyring(new LocalKeyProvider(material));
    const materialFile = join(directory, 'synthetic-master.hex');
    const ringFile = join(directory, 'synthetic-keyring.json');
    writeFileSync(materialFile, material.toString('hex'), { mode: 0o600 });
    writeFileSync(ringFile, JSON.stringify(ring), { mode: 0o600 });
    const config = loadConfig({
      APP_ENV: 'test',
      CLOCK_NOW: START,
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: materialFile,
      FIELD_KEYRING_FILE: ringFile,
    });
    const time = replayClock();
    expect(config.clockNow).toBe(START);
    time.moveTo('2026-10-05T09:00:00+08:00');
    const { clock } = time;
    const appId = `qa03a_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const userId = randomUUID();
    const accountId = randomUUID();
    const attrCode = 'demo0001';
    await db
      .insertInto('users')
      .values({
        id: userId,
        app_id: appId,
        nickname: '合成回放用户',
        avatar: '',
        invite_code: 'qa03ainvite',
        attr_code: attrCode,
        level: 'L1',
        register_method: 'synthetic',
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
    await db
      .insertInto('union_accounts')
      .values({
        id: accountId,
        app_id: appId,
        platform: 'pdd',
        account_name: 'synthetic replay',
        status: 'active',
        auth_status: 'active',
        sync_start_at: new Date(START),
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
    for (const scene of ['query', 'self_buy'] as const) {
      await db
        .insertInto('union_pids')
        .values({
          id: randomUUID(),
          app_id: appId,
          platform: 'pdd',
          union_account_id: accountId,
          pid: `synthetic-${scene}`,
          pid_scene: scene,
          status: 'active',
          // Synthetic evidence only, matching the full-app linking fixture's active PID setup.
          hjy_ignore_confirmed_at: clock.now(),
          hjy_ignore_evidence_path: 'https://example.test/qa-03a/synthetic-evidence',
          created_at: clock.now(),
          updated_at: clock.now(),
        })
        .execute();
    }
    await db
      .updateTable('platforms')
      .set({ search_support: 'supported', key_stability: 'stable_24h', updated_at: clock.now() })
      .where('code', '=', 'pdd')
      .execute();
    const settings: [string, boolean | number | Record<string, number>][] = [
      ['search.enabled.pdd', true],
      ['convert.enabled.pdd', true],
      ['attr.click_code.pdd', true],
      ['tech_fee_bp', { taobao: 0, jd: 0, pdd: 0 }],
      ['link.open.requote_after_sec', 0],
      ['rebate.pdd.compare_rate_ratio_bp', 5000],
      ['demo.rebate_quote_rule', { reserve_bp: 0, self_share_bp: 10000 }],
    ];
    await db
      .insertInto('config_items')
      .values(
        settings.map(([key, value]) => ({
          app_id: appId,
          key,
          value,
          updated_by: 'synthetic-replay',
        })),
      )
      .execute();
    // Configuration fixtures only; no monetary expected result is taken from these helpers.
    await seedVersion(db, appId, version({ effective_from: new Date(START) }));

    // Same two identity seam replacements as the reference linking full-app test. All request
    // checks, signatures, HTTP handlers, union conversion, PG and Redis remain real.
    const originalLinking = LinkingModule.forRoot;
    const identity = vi.spyOn(LinkingModule, 'forRoot').mockImplementation((...args) => {
      const module = originalLinking(...args);
      return {
        ...module,
        providers: [
          ...(module.providers ?? []).filter(
            (provider) =>
              !(
                typeof provider === 'object' &&
                (provider.provide === CallerContext || provider.provide === AttrCodeReader)
              ),
          ),
          {
            provide: CallerContext,
            useValue: { current: async () => ({ appId, userId, deviceId: null }) },
          },
          { provide: AttrCodeReader, useValue: { attrCode: async () => attrCode } },
        ],
      };
    });
    cleanups.push(async () => identity.mockRestore());
    const converts = vi.spyOn(DemoUnionAdapter.prototype, 'convert');
    cleanups.push(async () => converts.mockRestore());
    const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', root).href)) as {
      createHttpApp(
        entry: 'api',
        options: {
          config: typeof config;
          clock: Clock;
          logger: RootLogger;
          dbHandles: DbHandles;
          redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
        },
      ): Promise<HttpApp>;
    };
    const app = await createHttpApp('api', {
      config,
      clock,
      logger,
      dbHandles: { db, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('api', {
        DATABASE_URL: database.urlFor('couli_app'),
        REDIS_URL: redis.url,
      }).redisUrl,
    });
    cleanups.push(() => app.close());
    await app.init();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-app-id': appId,
      'x-platform': 'ios',
      'x-app-version': '2.0.0',
      'x-device-id': randomUUID(),
      'x-trace-id': randomUUID(),
    };
    const registered = await app.inject({
      method: 'POST',
      url: '/v1/devices',
      headers,
      payload: JSON.stringify({
        device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
        id_source: 'idfv',
      }),
    });
    expect(registered.statusCode).toBe(200);
    const device = registered.json<{ data: { device_id: string; install_secret: string } }>().data;
    headers['x-device-id'] = device.device_id;

    async function follow() {
      const found = await app.inject({
        method: 'GET',
        url: '/v1/products/search?platform=pdd&q=%E6%BC%94%E7%A4%BA&limit=1',
        headers,
      });
      expect(found.statusCode).toBe(200);
      const cards = found.json<{ code: number; data: { items: { link_id: string }[] } }>();
      expect(cards.code).toBe(0);
      expect(cards.data.items).toHaveLength(1);
      const linkId = cards.data.items[0]!.link_id;
      const path = `/v1/links/${linkId}/open`;
      const payload = JSON.stringify({ installed: 'true', no_rebate: false });
      const timestamp = String(Math.floor(clock.now().getTime() / 1000));
      const nonce = randomBytes(16).toString('hex');
      const signature = createHmac('sha256', device.install_secret)
        .update(
          ['POST', path, timestamp, nonce, createHash('sha256').update(payload).digest('hex')].join(
            '\n',
          ),
        )
        .digest('hex');
      converts.mockClear();
      const opened = await app.inject({
        method: 'POST',
        url: path,
        payload,
        headers: {
          ...headers,
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-sign': signature,
          'idempotency-key': randomUUID(),
        },
      });
      expect(opened.statusCode).toBe(200);
      expect(opened.json()).toMatchObject({ code: 0 });
      expect(converts).toHaveBeenCalled();
      const [request, serverIdentity] = converts.mock.calls.at(-1)!;
      const claims = serverIdentity as JdPddIdentity;
      expect(claims.claims.userId).toBe(attrCode);
      expect(claims.custom_parameters?.uid).toBe(attrCode);
      const logs = await db
        .selectFrom('link_logs')
        .selectAll()
        .where('app_id', '=', appId)
        .where('user_id', '=', userId)
        .where('event', '=', 'open')
        .where('result_code', '=', 0)
        .execute();
      expect(logs.length).toBeGreaterThan(0);
      return { request, claims, linkId: logs.at(-1)!.link_id };
    }

    async function syncDriver(orders: readonly DemoOrderSeed[]) {
      const assembly = (await import(new URL('apps/api/src/app.module.ts', root).href)) as {
        orderSnapshotPort(db: Kysely<DB>, clock: Clock, logger: RootLogger): CommissionSnapshotPort;
        rebatePortFactory(): (input: OrderRebateAssembly) => OrderSyncRebatePort;
      };
      const events = app.get<EventBus>(EVENT_BUS);
      const readers = createUnionOrderReaders(db);
      const logs = createOrderSourceReader(db);
      const catalog = createCatalog({ db, clock, warn: () => undefined });
      const sources = createOrderSourcePorts({
        linkLogs: (input) => logs.linkLogs(input),
        linkByCode: (input) => logs.linkByCode(input),
        keyPrefix: async (platform) =>
          (await catalog.listPlatforms()).find((row) => row.code === platform)?.key_prefix ?? null,
        configValue: (app, key) => createContentReader({ db, clock }).configValue(app, key),
      });
      // This map is part of the synthetic fixture, never a claim about vendor status codes.
      const map = loadStatusMap(
        'pdd',
        'raw_code,event,source,verified,note\ndemo:paid,PLATFORM_PAID,synthetic,false,synthetic\ndemo:received,PLATFORM_RECEIVED,synthetic,false,synthetic\ndemo:refunded,PLATFORM_INVALID,synthetic,false,synthetic\n',
      );
      const deps = {
        db,
        clock,
        ...readers,
        users: createOrderUserReader(db),
        bindings: createOrderBindingReader(db),
        statusMaps: () => map,
        sources,
        snapshots: assembly.orderSnapshotPort(db, clock, logger),
        rebate: assembly.rebatePortFactory()({ db, clock, logger, events }),
        events,
        logger,
      } satisfies OrderPipelineDeps;
      const pipeline = createOrderPipeline({
        ...deps,
        updateStep: createOrderUpdateStep(deps),
      });
      // Only PDD participates in this scenario; quiet platforms explicitly opt into an empty
      // stream. An omitted stream must keep reporting adapter_unimplemented (GOV#6).
      const adapters = {
        pdd: demoStream(clock, orders),
        jd: demoStream(clock, [], undefined, 'jd'),
        taobao: demoStream(clock, [], undefined, 'taobao'),
      };
      const access = createUnionSyncAccess({
        db,
        clock,
        logger,
        endpoints: [],
        breaker: () => 'closed',
      });
      const cursors = createSyncCursorStore(db, clock);
      return async (from: string, to: string) => {
        const result = await handleOrderSyncWindow(
          {
            id: randomUUID(),
            queue: 'order-sync',
            name: 'window',
            attempt: 1,
            payload: {
              app_id: appId,
              platform: 'pdd',
              union_account_id: accountId,
              query_kind: 'increment',
              scene: '-',
              window_start: from,
              window_end: to,
            },
          },
          {
            // Production account discovery intentionally refuses demo credentials. The fixture
            // explicitly selects its own synthetic account; authorization still reads real PG.
            access: { ...access, queryableAccount: async () => accountId },
            cursors,
            registry: { get: (platform) => adapters[platform] },
            pipeline,
            logger,
          },
        ).then(
          () => ({ ok: true }),
          (error: unknown) => {
            if (error instanceof UnionError && error.code === 'adapter_unimplemented') {
              return { ok: false, error };
            }
            throw error;
          },
        );
        expect(
          result,
          'order-sync must ingest demo listOrders, not adapter_unimplemented',
        ).toMatchObject({ ok: true });
      };
    }
    return {
      db,
      clock,
      time,
      appId,
      userId,
      accountId,
      follow,
      syncDriver,
      close,
      orderSeeds: (followed: Awaited<ReturnType<typeof follow>>): DemoOrderSeed[] =>
        Array.from({ length: 3 }, (_, i) => ({
          key: `followed-${i}`,
          appId,
          item: followed.request.item,
          promotionSlot: followed.claims.claims.promotionSlot,
          attrParams: {
            relation_id: null,
            sub_union_id: null,
            custom_parameters: JSON.stringify(followed.claims.custom_parameters),
          },
          paidAt: PAID,
          receivedAt: RECEIVED,
          refundedAt: null,
        })),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
