// B2-09gg rule-test kit (claude-independent, SPEC_REF 03383a10): 08 BR-FUND-22 申诉恢复 ② (编排 D10-1180,
// D10-1181, contract line CT-24zzh) and BR-ID-36 ② — an order clawed back by a confirmed blacklist hit
// (R8, BLACKLIST_CONFIRMED) can be appealed; a revoked appeal registers one appeal_restore difference;
// that difference is handled by the existing R13.
// Real pieces: the credit (the order reaches CREDITED through the B2-04m service), the blacklist
// confirmation that claws it back (POST .../blacklist-clawback, `B{recon_diff_id}` vouchers), the
// console registration and resolution of the appeal, the production worker's consumer of
// appeal.resolved, the restore (POST .../restore, real order.restore permission and totp step-up),
// ledger, PostgreSQL through @couli/db/testing as couli_app, Redis for the admin sessions. One admin
// entry serves all four console operations.
// Synthetic, and named where a test does it: the blacklist difference the confirmation works on (as
// the B2-04zzl kit seeds it), the union's later figures on the order row, a successful
// INVALID_AFTER_SETTLE record, a VOID order for the regression of the first appeal path, a
// platform_restore difference used only to bring an order back to CREDITED, and the appeal.resolved
// jobs of the producer tests (the end-to-end test delivers the event the console logged). No real
// user or merchant data. Expected amounts are written by hand in the tests (BR-CALC-02 / BR-CALC-04).
//
// Default order of the credit harness (N = 1000, reserve_bp 1500 → base 850; self 5000 / direct 1000
// / indirect 500 → 425 / 85 / 42): beneficiaries 552, platform 448.
//
// The handling path already runs R13 for a difference of this shape, so every restore test gets its
// difference from the real producer: nothing here writes the appeal_restore row by hand. Missing
// pieces fail as assertions (20001 target_id from the console, no difference from the consumer).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  REDIS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
  type FixedClock,
  type ReceivedEvent,
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { newKey, RESTORE, type AdminSent as RestoreSent } from '../admin-recon-restore/kit.ts';
import {
  PERMISSION as BLACKLIST_CLAWBACK,
  confirmed,
  everything,
  seedBlacklistDiff,
  type AdminCaller,
  type AdminSent as ClawbackSent,
  type App,
  type DiffRow,
  type Envelope,
  type SeededOrder,
} from '../blacklist-clawback/kit.ts';
import {
  QUEUE,
  appealDiffs,
  appealEvent,
  jobOf,
  rawEvent,
  withWorker,
  type AppealEventInput,
  type Worker,
} from '../order-appeal-restore/kit.ts';
import { rebateHistory, refIdOf, seedPlatformDiff } from '../platform-restore/kit.ts';

export {
  SUFFIX,
  app,
  everything,
  suite,
  type App,
  type DiffRow,
  type SeededOrder,
} from '../blacklist-clawback/kit.ts';
export {
  CONSUMER,
  QUEUE,
  TIMEOUT,
  appealDiffs,
  jobOf,
  processedOf,
  type Worker,
} from '../order-appeal-restore/kit.ts';

/** specs/permissions.yaml: registers and resolves appeals (no step-up for an order appeal). */
const APPEAL = 'risk.appeal';
/** The accounting month at the credit harness' clock (2032-07-24T10:00:00+08:00). */
export const PERIOD = '2032-07';
/** The month after PERIOD, for a second appeal of the same clawback. */
export const NEXT_MONTH = '2032-08-03T10:00:00+08:00';

const ROOT = new URL('../../../../', import.meta.url);

// ---------------------------------------------------------------------------------------------
// One admin entry with the four console operations of this task.

export interface Sent {
  readonly statusCode: number;
  readonly body: string;
  json(): Envelope;
}

export interface RestoreRequest {
  /** Idempotency-Key: a fresh one by default. */
  readonly key?: string;
}

export interface ConsoleEntry {
  /** An account with order.blacklist_clawback, order.restore and risk.appeal. */
  readonly operator: AdminCaller;
  /** POST /admin/v1/recon-diffs/{recon_diff_id}/blacklist-clawback (real totp step-up). */
  confirm(reconDiffId: string): Promise<ClawbackSent>;
  /** POST /admin/v1/recon-diffs/{recon_diff_id}/restore (real totp step-up). */
  restore(reconDiffId: string, body?: unknown, request?: RestoreRequest): Promise<RestoreSent>;
  /** POST /admin/v1/appeals. */
  register(body: unknown): Promise<Sent>;
  /** POST /admin/v1/appeals/{appeal_id}/resolve. */
  resolve(appealId: string, body: unknown): Promise<Sent>;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    payload: string;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}

/** Runs `run` against a started admin entry on the app's database, clock and Redis. */
export async function withConsole<T>(a: App, run: (admin: ConsoleEntry) => Promise<T>): Promise<T> {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'admin',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: RootLogger;
        dbHandles: DbHandles;
        redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  const { f } = a;
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b2-09gg-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
  let started: HttpApp | undefined;
  try {
    started = await createHttpApp('admin', {
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
        FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
        ADMIN_TOKEN_SIGNING_KEY: tokenKey.toString('base64url'),
        ADMIN_IP_ALLOWLIST: '127.0.0.1,::1',
        ADMIN_CORS_ORIGIN: 'https://admin.example.invalid',
        JWT_KEY_ID: 'b2_09gg_test',
        JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock: f.clock,
      logger: createRootLogger(
        { entry: 'admin', appEnv: 'test', level: 'silent' },
        { write: () => undefined },
      ),
      dbHandles: { db: f.db, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('admin', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        DATABASE_READ_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: f.s.redisUrl(),
      }).redisUrl,
    });
    await started.init();
    const server = started;
    const redis = server.get<RedisHandle>(REDIS);

    const operatorId = randomUUID();
    const permissions = [BLACKLIST_CLAWBACK, RESTORE, APPEAL];
    await f.db
      .insertInto('admin_users')
      .values({
        id: operatorId,
        app_id: f.appId,
        login_name: `console_${operatorId}`,
        password_hash: 'unused-test-login',
        is_super: false,
        status: 'active',
        password_must_change: false,
        totp_bound_at: f.clock.now(),
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
      })
      .execute();
    await f.db
      .insertInto('admin_permissions')
      .values(
        permissions.map((permission_key) => ({
          app_id: f.appId,
          admin_id: operatorId,
          permission_key,
          granted_by: operatorId,
          granted_at: f.clock.now(),
        })),
      )
      .execute();
    const { token, claims } = await createAdminTokens({ key: tokenKey, clock: f.clock }).issue({
      adminId: operatorId,
      appId: f.appId,
    });
    await createAdminSessions({ redis: redis.namespace('admin-auth'), clock: f.clock }).create(
      claims.sessionId,
      {
        adminId: operatorId,
        appId: f.appId,
        expiresAtMs: claims.expiresAt * 1000,
        lastSeenMs: f.clock.now().getTime(),
      },
    );
    const operator: AdminCaller = { id: operatorId, token, sessionId: claims.sessionId };

    /** A step-up token of the operator's session, as a correct authenticator code issues it. */
    const stepUp = async (): Promise<string> => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({
        appId: f.appId,
        adminId: operator.id,
        sessionId: operator.sessionId,
        tier: 'totp',
      });
      return grant.step_up_token;
    };

    const post = async (
      url: string,
      body: unknown,
      extra: Record<string, string> = {},
    ): Promise<Sent> => {
      const response = await server.inject({
        method: 'POST',
        url,
        headers: {
          'content-type': 'application/json',
          'x-trace-id': randomUUID(),
          authorization: `Bearer ${operator.token}`,
          ...extra,
        },
        payload: JSON.stringify(body),
        remoteAddress: '127.0.0.1',
      });
      return {
        statusCode: response.statusCode,
        body: response.body,
        json: () => JSON.parse(response.body) as Envelope,
      };
    };
    const diffPath = (id: string, action: string): string =>
      `/admin/v1/recon-diffs/${encodeURIComponent(id)}/${action}`;

    return await run({
      operator,
      async confirm(reconDiffId) {
        return post(
          diffPath(reconDiffId, 'blacklist-clawback'),
          {},
          { 'idempotency-key': newKey(), 'x-step-up-token': await stepUp() },
        );
      },
      async restore(reconDiffId, body = {}, request = {}) {
        const sent = await post(diffPath(reconDiffId, 'restore'), body, {
          'idempotency-key': request.key ?? newKey(),
          'x-step-up-token': await stepUp(),
        });
        return { ...sent, op: 'restore' };
      },
      register: (body) => post('/admin/v1/appeals', body),
      resolve: (appealId, body) =>
        post(`/admin/v1/appeals/${encodeURIComponent(appealId)}/resolve`, body),
    });
  } finally {
    try {
      await started?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** The admin entry and the production worker on the same app. */
export function withConsoleAndWorker<T>(
  a: App,
  run: (admin: ConsoleEntry, worker: Worker) => Promise<T>,
): Promise<T> {
  return withConsole(a, (admin) => withWorker(a.f, (worker) => run(admin, worker)));
}

// ---------------------------------------------------------------------------------------------
// The real clawback.

export interface ClawedBack {
  readonly order: SeededOrder;
  /** The blacklist difference the confirmation handled; its `B{id}` names the vouchers. */
  readonly clawbackDiff: DiffRow;
  /** The rebate-history row by which the order entered CLAWED_BACK. */
  readonly entryId: bigint;
}

/** The order's latest rebate-history row into CLAWED_BACK. */
export async function clawedBackEntry(a: App, orderId: string): Promise<bigint> {
  const rows = (await rebateHistory(a.f, orderId)).filter((r) => r.to_status === 'CLAWED_BACK');
  expect(rows.length, `history row entering CLAWED_BACK of ${orderId}`).toBeGreaterThan(0);
  return rows.at(-1)!.id;
}

/** Claws a CREDITED order back through the real confirmation (R8, BLACKLIST_CONFIRMED). */
export async function blacklistClawback(
  a: App,
  admin: ConsoleEntry,
  order: SeededOrder,
  dimensions?: readonly string[],
): Promise<ClawedBack> {
  const clawbackDiff = await seedBlacklistDiff(
    a,
    order,
    dimensions === undefined ? {} : { dimensions },
  );
  const data = await confirmed(await admin.confirm(clawbackDiff.id));
  expect(data.rebate_status_after).toBe('CLAWED_BACK');
  expect(await a.h.rebateColumns(order)).toMatchObject({
    rebate_status: 'CLAWED_BACK',
    reason: 'BLACKLIST',
    booked_base_fen: 0n,
    booked_n_fen: 0n,
  });
  return { order, clawbackDiff, entryId: await clawedBackEntry(a, order.orderId) };
}

/** A default order credited for real and then clawed back through the real confirmation. */
export async function clawedOrder(a: App, admin: ConsoleEntry): Promise<ClawedBack> {
  return blacklistClawback(a, admin, await a.h.credited());
}

/** A credited order clawed back by an ordinary R8: CLAWED_BACK with a reason other than BLACKLIST. */
export async function refundClawback(a: App): Promise<SeededOrder> {
  const order = await a.h.credited();
  expect(
    await a.h.apply(order, { cause: 'INVALID_AFTER_SETTLE', ref: { kind: 'platform' } }),
  ).toMatchObject({ outcome: 'clawed_back', transition: 'R8' });
  const row = await a.h.read(order);
  expect(row.rebate_status).toBe('CLAWED_BACK');
  expect(row.reason).not.toBe('BLACKLIST');
  return order;
}

/** The union's later figures on the order row (synthetic: order sync writes them in production). */
export async function setOrderFigures(
  a: App,
  order: SeededOrder,
  figures: {
    readonly settleFen?: bigint | null;
    readonly quantity?: number;
    readonly refundedQuantity?: number;
  },
): Promise<void> {
  await a.h.db
    .updateTable('orders')
    .set({
      ...(figures.settleFen === undefined ? {} : { settle_commission_fen: figures.settleFen }),
      ...(figures.quantity === undefined ? {} : { quantity: figures.quantity }),
      ...(figures.refundedQuantity === undefined
        ? {}
        : { refunded_quantity: figures.refundedQuantity }),
    })
    .where('app_id', '=', a.h.appId)
    .where('order_id', '=', order.orderId)
    .execute();
}

// ---------------------------------------------------------------------------------------------
// The difference, from the real producer.

/** `appeal_restore:order:{app_id}:{order_key}:{entry_id}`. */
export function dedupeKeyOf(a: App, order: SeededOrder, entryId: bigint): string {
  return `appeal_restore:order:${a.h.appId}:${order.orderKey}:${entryId.toString(10)}`;
}

export function refId(order: SeededOrder, entryId: bigint): string {
  return refIdOf(order.orderKey, entryId);
}

/** appeal.resolved of the order's appeal, revoked unless `input` says otherwise. */
export function resolvedEvent(
  a: App,
  order: SeededOrder,
  input: Omit<AppealEventInput, 'targetId' | 'userId'> = {},
): ReceivedEvent {
  return appealEvent(a.f, { targetId: order.orderId, userId: order.user('self'), ...input });
}

/** Delivers a revoked appeal of the order and returns the difference registered for `entryId`. */
export async function registeredDiff(
  a: App,
  worker: Worker,
  order: SeededOrder,
  entryId: bigint,
): Promise<DiffRow> {
  await worker.handlerOn(QUEUE)(jobOf(resolvedEvent(a, order)));
  const ref = refId(order, entryId);
  const row = (await appealDiffs(a.f)).find((r) => r.ref_id === ref);
  expect(row, `appeal_restore difference ${ref}`).toBeDefined();
  return row!;
}

export interface LoggedResolution {
  readonly eventId: string;
  readonly data: Record<string, unknown>;
}

/** The app's appeal.resolved events as the event bus logged them (`{ v: 1, data }`). */
export async function loggedResolutions(a: App): Promise<LoggedResolution[]> {
  const rows = await a.h.db
    .selectFrom('event_log')
    .select(['event_id', 'payload'])
    .where('app_id', '=', a.h.appId)
    .where('name', '=', 'appeal.resolved')
    .orderBy('id')
    .execute();
  return rows.map((row) => ({
    eventId: row.event_id,
    data: (row.payload as unknown as { data: Record<string, unknown> }).data,
  }));
}

/** Hands a logged appeal.resolved to the consumer the worker registered. */
export function deliverLogged(a: App, worker: Worker, logged: LoggedResolution): Promise<void> {
  const event = rawEvent(a.f, logged.data, logged.eventId as Parameters<typeof rawEvent>[2]);
  return worker.handlerOn(QUEUE)(jobOf(event));
}

// ---------------------------------------------------------------------------------------------
// Bringing an order back to CREDITED some other way (for the out-of-date difference).

/** A platform_restore difference of the same CLAWED_BACK entry (R13 runs on it for real). */
export function platformDiffOf(a: App, target: ClawedBack): Promise<DiffRow> {
  const { order, entryId } = target;
  return seedPlatformDiff(a.f, {
    orderId: order.orderId,
    platform: order.platform,
    subOrderId: order.subOrderId,
    orderKey: order.orderKey,
    entryId,
    rebate: 'CLAWED_BACK',
    reason: 'BLACKLIST',
    platformStatus: 'SETTLED',
    commissionFen: 1000n,
    trigger: 'status',
  });
}

// ---------------------------------------------------------------------------------------------
// Rights records and reads.

/** A successful INVALID_AFTER_SETTLE record that became successful at `at`. */
export async function succeededInvalid(a: App, order: SeededOrder, at: Date): Promise<void> {
  const id = randomUUID();
  await a.h.db
    .insertInto('order_rights')
    .values({
      id,
      app_id: a.h.appId,
      order_id: order.orderId,
      source: 'API',
      type: 'INVALID_AFTER_SETTLE',
      status: 'SUCCEEDED',
      amount_fen: null,
      deduction_commission_fen: null,
      occurred_at: at,
      platform_rights_no: `rights-${id}`,
      created_at: at,
      updated_at: at,
    })
    .execute();
}

/** Everything of the app but its differences (what registering one may not change). */
export async function allButDiffs(a: App) {
  return { ...(await everything(a)), diffs: null };
}

/** The `B{id}` vouchers of a confirmation and their entries. */
export async function clawbackRecords(a: App, clawbackDiff: DiffRow) {
  const marker = `:CLAWBACK:B${clawbackDiff.id}`;
  return {
    vouchers: (await a.h.vouchers()).filter((v) => v.uniq_key.endsWith(marker)),
    lines: (await a.h.lines())
      .filter((l) => l.uniq_key.endsWith(marker))
      .sort((x, y) =>
        `${x.uniq_key}|${x.subject}|${x.owner_id}` < `${y.uniq_key}|${y.subject}|${y.owner_id}`
          ? -1
          : 1,
      ),
  };
}
