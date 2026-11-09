// B2-09gd rule-test kit (claude-independent, SPEC_REF d5713bf4): the producer of order-appeal restore
// differences (08 BR-FUND-22 申诉恢复 ①; 编排 D10-1091, D10-1093, D10-1105, D10-1117) and R12 with its
// snapshot made up on the restore's transaction (BR-CALC-10, BR-FUND-22 迁移表 R12、处理时再核).
// Real pieces: the admin entry (../admin-recon-restore/kit.ts withRestoreAdmin), the production
// worker (AppModule.forEntry({ entry: 'worker' }) over a real field keyring; only the job queue is a
// stub, its handlers are the ones the worker registered), ledger, commission's real snapshot port
// and beneficiary resolver, PostgreSQL through @couli/db/testing as couli_app.
// Synthetic, written directly as the earlier steps would have left them: a VOID order that never got
// a snapshot (BR-ATTR-01 ③ before ⑥: voided by the blacklist in its first import, commission_version
// 0), its rebate history, optionally an existing snapshot or a settlement record, the rule versions,
// and the appeal.resolved job as the event bus delivers it. No real user or merchant data.
// Expected amounts are written by hand in the tests (BR-CALC-02 / BR-CALC-04).
// Missing pieces fail as assertions: no handler on the new queue, 20001 restore_not_supported from
// the route; nothing here imports code that does not exist yet.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import { createLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
import { lockOrderKey } from '../../../../apps/api/src/modules/orders/infra/order-lock.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import type {
  JobHandler,
  QueueRuntime,
  ReceivedEvent,
  ReceivedJob,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { version } from '../../commission/snapshot/fixtures.ts';
import { fixture as appFixture } from '../../ledger/admin-recon-close/kit.ts';
import type { DiffSeed } from '../../ledger/admin-recon-diffs/kit.ts';
import type { Suite } from '../../payment/orders/kit.ts';
import {
  answer,
  diffNow,
  memberOf,
  seedDiff,
  type AdminSent,
  type DiffRow,
  type Envelope,
  type RestoreFixture,
} from '../admin-recon-restore/kit.ts';
import {
  addRebateStep,
  orderHistory,
  orderRow,
  refIdOf,
  type HistoryRow,
  type OrderRow,
  type PlatformDiffTarget,
  type PlatformStatus,
} from '../platform-restore/kit.ts';

export const TIMEOUT = 180_000;

/** task brief 9.2 A: the consumer of EVENT_SUBSCRIPTIONS and its event queue. */
export const CONSUMER = 'settlement-order-appeal-restore';
export const QUEUE = 'evt.settlement-order-appeal-restore';

const ROOT = new URL('../../../../', import.meta.url);

/** The orders of the fixture were placed then (the B2-09g kit's instant). */
const ATTR_AT = new Date('2026-08-20T00:00:00.000Z');
/** Paid inside the first rule version of `fixture` (effective 2026-08-20). */
export const PAID_AT = new Date('2026-09-01T00:00:00.000Z');
/** When the blacklist voided the order. */
const VOIDED_AT = new Date('2026-09-02T00:00:00.000Z');
/** 2026-10-01 01:00 +08:00: settle_period 2026-10 (BR-FUND-04 ②). */
export const RECEIVED_AT = new Date('2026-09-30T17:00:00.000Z');
const BILL = '2026-10';
export const HOUR_MS = 3_600_000;

export type Platform = 'jd' | 'pdd' | 'taobao';

// ---------------------------------------------------------------------------------------------
// One app with no published rule version at all (`fixture` of the B2-09g kit has one).

/** An app with no rule version; ruleVersionId names nothing and must not be used for a snapshot. */
export function bareFixture(s: Suite): RestoreFixture {
  const base = appFixture(s);
  return {
    ...base,
    ledger: createLedger({ clock: base.clock }),
    ruleVersionId: randomUUID(),
    accounts: new Map(),
  };
}

// ---------------------------------------------------------------------------------------------
// Rule rows of the version `fixture` publishes (it has none of its own).

export interface RuleOptions {
  /** r_own_bp of every rule row (default 5000). */
  readonly ownBp?: number;
  /** reserve_bp of every reserve row (default 1500). */
  readonly reserveBp?: number;
  /** The platforms with rule rows (default all three). */
  readonly rulePlatforms?: readonly Platform[];
  /** The platforms with a reserve row (default all three). */
  readonly reservePlatforms?: readonly Platform[];
}

const ALL_PLATFORMS: readonly Platform[] = ['jd', 'pdd', 'taobao'];

/** The rule and reserve rows of `f`'s published version (self / share, L1–L3 of each platform). */
export async function seedRules(f: RestoreFixture, options: RuleOptions = {}): Promise<void> {
  const rulePlatforms: readonly string[] = options.rulePlatforms ?? ALL_PLATFORMS;
  const reservePlatforms: readonly Platform[] = options.reservePlatforms ?? ALL_PLATFORMS;
  const rows = version()
    .rules.filter((rule) => rulePlatforms.includes(rule.platform))
    .map((rule) => ({
      ...rule,
      r_own_bp: options.ownBp ?? 5000,
      app_id: f.appId,
      rule_version_id: f.ruleVersionId,
    }));
  if (rows.length > 0) await f.db.insertInto('commission_rules').values(rows).execute();
  if (reservePlatforms.length > 0) {
    await f.db
      .insertInto('commission_rule_reserves')
      .values(
        reservePlatforms.map((platform) => ({
          app_id: f.appId,
          rule_version_id: f.ruleVersionId,
          platform,
          reserve_bp: options.reserveBp ?? 1500,
        })),
      )
      .execute();
  }
}

// ---------------------------------------------------------------------------------------------
// The order.

export interface VoidSpec {
  /** jd by default (no pid scene in play). */
  readonly platform?: Platform;
  /** The attributed member; null: unattributed; omitted: a new member. */
  readonly userId?: string | null;
  /** The current platform_status (default PAID). */
  readonly platformStatus?: PlatformStatus;
  /** orders.rebate_status (default VOID). */
  readonly rebate?: 'VOID' | 'ESTIMATED';
  /** orders.reason (default BLACKLIST). */
  readonly reason?: string | null;
  /** est_commission_fen (default 800). */
  readonly est?: bigint | null;
  /** settle_commission_fen (default none); a value also writes order_settlements seq 1. */
  readonly settle?: bigint | null;
  /** orders.paid_at (default PAID_AT). */
  readonly paidAt?: Date | null;
  /** orders.paid_at_source (default platform; any text, the column has no check). */
  readonly paidAtSource?: string | null;
  /** The order_status_history row of field platform by which it first reached PAID. */
  readonly firstPaidAt?: Date;
  readonly receivedAt?: Date | null;
  /** orders.pid. */
  readonly pid?: string | null;
  readonly serviceFeeFen?: bigint | null;
  /** An existing snapshot (commission_version 1); default none (commission_version 0). */
  readonly snapshot?: boolean;
  /** Writes no rebate-history row entering VOID (a damaged order). */
  readonly noEntry?: boolean;
}

export interface VoidOrder extends PlatformDiffTarget {
  readonly userId: string | null;
}

/**
 * A VOID order of the fixture's app that never got a snapshot, with its rebate history: imported,
 * then the row by which it entered VOID (BLACKLIST_HIT).
 */
export async function seedVoid(f: RestoreFixture, spec: VoidSpec = {}): Promise<VoidOrder> {
  const orderId = randomUUID();
  const platform = spec.platform ?? 'jd';
  const subOrderId = `a-${orderId}`;
  const orderKey = `${platform}:${subOrderId}`;
  const userId = spec.userId === undefined ? await memberOf(f) : spec.userId;
  const platformStatus = spec.platformStatus ?? 'PAID';
  const rebate = spec.rebate ?? 'VOID';
  const reason = spec.reason === undefined ? 'BLACKLIST' : spec.reason;
  const est = spec.est === undefined ? 800n : spec.est;
  const settle = spec.settle === undefined ? null : spec.settle;
  const snapshot = spec.snapshot === true;
  await f.db
    .insertInto('order_keys')
    .values({
      app_id: f.appId,
      order_id: orderId,
      platform,
      sub_order_id: subOrderId,
      attr_at: ATTR_AT,
      created_at: ATTR_AT,
    })
    .execute();
  await f.db
    .insertInto('orders')
    .values({
      app_id: f.appId,
      order_id: orderId,
      platform,
      sub_order_id: subOrderId,
      attr_at: ATTR_AT,
      raw_item_id: 'synthetic',
      user_id: userId,
      user_basis: userId === null ? null : 'param',
      buy_type: userId === null ? null : 'self',
      platform_status: platformStatus,
      rebate_status: rebate,
      reason,
      hold: false,
      rights_pending: false,
      commission_version: snapshot ? 1 : 0,
      est_commission_fen: est,
      settle_commission_fen: settle,
      service_fee_fen: spec.serviceFeeFen ?? null,
      paid_at: spec.paidAt === undefined ? PAID_AT : spec.paidAt,
      paid_at_source: spec.paidAtSource === undefined ? 'platform' : spec.paidAtSource,
      received_at: spec.receivedAt ?? null,
      settle_period: null,
      pid: spec.pid ?? null,
      quantity: 1,
      refunded_quantity: 0,
      row_version: 2,
      created_at: ATTR_AT,
      updated_at: VOIDED_AT,
    })
    .execute();
  if (settle !== null) {
    await f.db
      .insertInto('order_settlements')
      .values({
        app_id: f.appId,
        order_id: orderId,
        seq: 1,
        source: 'STATEMENT',
        settle_commission_fen: settle,
        settled_at: ATTR_AT,
        content_hash: randomUUID(),
        created_at: ATTR_AT,
      })
      .execute();
  }
  if (spec.firstPaidAt !== undefined) {
    await f.db
      .insertInto('order_status_history')
      .values({
        app_id: f.appId,
        order_id: orderId,
        field: 'platform',
        from_status: null,
        event: 'PLATFORM_PAID',
        to_status: 'PAID',
        source: 'sync',
        at: spec.firstPaidAt,
      })
      .execute();
  }
  const start = userId === null ? 'UNATTRIBUTED' : 'ESTIMATED';
  await addRebateStep(f, orderId, {
    from: null,
    event: userId === null ? 'IMPORT_UNATTRIBUTED' : 'IMPORT_ATTRIBUTED',
    to: start,
    at: ATTR_AT,
  });
  const entryId =
    spec.noEntry === true
      ? 0n
      : await addRebateStep(f, orderId, {
          from: start,
          event: 'BLACKLIST_HIT',
          to: 'VOID',
          at: VOIDED_AT,
        });
  if (snapshot) {
    await f.db
      .insertInto('commission_splits')
      .values({
        app_id: f.appId,
        order_id: orderId,
        rule_version_id: f.ruleVersionId,
        order_type: 'self',
        activity_type: null,
        rebate_mode: null,
        paid_at: PAID_AT,
        paid_at_source: 'platform',
        raw_n_fen: 800n,
        subsidy_commission_fen: 0n,
        reserve_bp: 1500,
        reserve_fen: 120n,
        tlj_deduct_fen: 0n,
        base_fen: 680n,
        platform_retain_fen: 340n,
        beneficiaries: JSON.stringify([
          {
            user_id: userId,
            role: 'self',
            ratio_bp: 5000,
            level: 'L1',
            initial_status: 'active',
            forfeit_reason: null,
          },
        ]),
        created_at: ATTR_AT,
      })
      .execute();
  }
  const effective = settle ?? est ?? 0n;
  return {
    orderId,
    platform,
    subOrderId,
    orderKey,
    userId,
    entryId,
    rebate: 'VOID',
    reason,
    platformStatus,
    commissionFen: effective > 0n ? effective : 0n,
    trigger: 'status',
  };
}

// ---------------------------------------------------------------------------------------------
// The difference.

/** `appeal_restore:order:{app_id}:{order_key}:{entry_id}` (task brief 9.2 A). */
export function dedupeKeyOf(f: RestoreFixture, order: VoidOrder, entryId = order.entryId): string {
  return `appeal_restore:order:${f.appId}:${order.orderKey}:${entryId.toString(10)}`;
}

/** The difference of a revoked order appeal, as the producer registers it (task brief 9.2 A). */
export function seedAppealDiff(
  f: RestoreFixture,
  order: VoidOrder,
  patch: DiffSeed = {},
): Promise<DiffRow> {
  return seedDiff(f, {
    source: 'R3',
    type: 'appeal_restore',
    period: '2026-10',
    ref_type: 'order',
    ref_id: refIdOf(order.orderKey, order.entryId),
    expected_fen: order.commissionFen,
    actual_fen: 0n,
    diff_fen: order.commissionFen,
    dedupe_key: dedupeKeyOf(f, order),
    resolution: {
      reason_code: 'BLACKLIST',
      appeal_id: randomUUID(),
      order_id: order.orderId,
      order_key: order.orderKey,
      user_id: order.userId,
      rebate_status: 'VOID',
      platform_status: order.platformStatus,
    },
    ...patch,
  });
}

// ---------------------------------------------------------------------------------------------
// appeal.resolved as the event bus delivers it.

/** An appeal.resolved event with the given data (malformed data is the tests' point). */
export function rawEvent(
  f: RestoreFixture,
  data: Record<string, unknown>,
  eventId = randomUUID(),
): ReceivedEvent {
  return {
    eventId,
    appId: f.appId,
    name: 'appeal.resolved',
    version: 1,
    occurredAt: f.clock.now().toISOString(),
    payload: data as unknown as ReceivedEvent['payload'],
    consumer: CONSUMER,
    attempt: 1,
  };
}

export interface AppealEventInput {
  readonly targetId: string;
  readonly userId: string | null;
  readonly targetType?: 'account' | 'order' | 'blocked_request';
  readonly status?: 'revoked' | 'upheld';
  readonly appealId?: string;
  readonly eventId?: string;
}

/** appeal.resolved of a closed appeal (data as adminResolveAppeal queues it). */
export function appealEvent(f: RestoreFixture, input: AppealEventInput): ReceivedEvent {
  return rawEvent(
    f,
    {
      app_id: f.appId,
      appeal_id: input.appealId ?? randomUUID(),
      user_id: input.userId,
      target_type: input.targetType ?? 'order',
      target_id: input.targetId,
      status: input.status ?? 'revoked',
      need_reauth: false,
    },
    input.eventId as Parameters<typeof rawEvent>[2],
  );
}

/** The job registerEventConsumer receives for an event. */
export function jobOf(event: ReceivedEvent): ReceivedJob {
  return {
    id: event.eventId,
    queue: QUEUE,
    name: event.name,
    attempt: event.attempt,
    payload: {
      app_id: event.appId,
      v: event.version,
      occurred_at: event.occurredAt,
      data: event.payload,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The production worker.

export interface Worker {
  /** Every log line of the worker, as JSON objects. */
  readonly lines: readonly Record<string, unknown>[];
  /** The one handler the worker registered on `queue` (an assertion when there is none). */
  handlerOn(queue: string): JobHandler;
}

interface WorkerPlatform {
  PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
  JOB_QUEUE: symbol;
  loadConfig(env: Record<string, string>): unknown;
}

/** Runs `run` against AppModule.forEntry({ entry: 'worker' }) on the fixture's database and clock. */
export async function withWorker<T>(
  f: RestoreFixture,
  run: (worker: Worker) => Promise<T>,
): Promise<T> {
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
    NestFactory: {
      createApplicationContext(
        module: unknown,
        options: object,
      ): Promise<{ close(): Promise<void> }>;
    };
  };
  const registrations: { readonly name: string; readonly handler: JobHandler }[] = [];
  const queue: QueueRuntime = {
    register(name, handler) {
      registrations.push({ name, handler });
    },
    send: vi.fn<QueueRuntime['send']>(async () => 'fixture-job'),
    async start() {},
    async stop() {},
  };
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'worker', appEnv: 'test' },
    {
      write(line: string) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
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
  const dir = mkdtempSync(join(tmpdir(), 'b2-09gd-'));
  try {
    const master = randomBytes(32);
    const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
    writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
    writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
    let context: { close(): Promise<void> };
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
          clock: f.clock,
          logger,
          dbHandles: { db: f.db, dbRead: null, close: async () => undefined },
        }),
        { logger: false, abortOnError: false },
      );
    } finally {
      spy.mockRestore();
    }
    try {
      return await run({
        lines,
        handlerOn(name) {
          const handlers = registrations.filter((r) => r.name === name).map((r) => r.handler);
          expect(handlers, `handlers the worker registered on ${name}`).toHaveLength(1);
          return handlers[0]!;
        },
      });
    } finally {
      await context.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** pino's numeric warn level. */
const WARN_LEVEL = 40;

/** The worker's warnings as JSON text. */
export function warnings(worker: Worker): string {
  return JSON.stringify(worker.lines.filter((line) => line['level'] === WARN_LEVEL));
}

/**
 * Runs `run` while every entry started inside it logs to `lines`: PlatformModule.forRoot
 * (ROOT_LOGGER) gets a collecting logger, as withRestoreAdmin starts the admin entry silent.
 */
export async function withEntryLog<T>(
  run: (lines: readonly Record<string, unknown>[]) => Promise<T>,
): Promise<T> {
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as WorkerPlatform;
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'admin', appEnv: 'test' },
    {
      write(line: string) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  const original = platform.PlatformModule.forRoot.bind(platform.PlatformModule);
  const spy = vi
    .spyOn(platform.PlatformModule, 'forRoot')
    .mockImplementation((options) => original({ ...options, logger }));
  try {
    return await run(lines);
  } finally {
    spy.mockRestore();
  }
}

/** `lines` holds a warning with these fields. */
export function expectWarned(
  lines: readonly Record<string, unknown>[],
  fields: Record<string, unknown>,
): void {
  expect(lines).toContainEqual(expect.objectContaining({ ...fields, level: WARN_LEVEL }));
}

/**
 * The CONFIRMED (IMMEDIATE) batch of one order on its settlement record seq 1, handed to the settle
 * handler the worker registered (job batch_execute), credit.enabled.<platform> on. Returns the
 * batch item.
 */
export async function settleOrder(
  f: RestoreFixture,
  worker: Worker,
  order: VoidOrder,
  input: { readonly adminId: string; readonly settleFen: bigint },
) {
  const at = f.clock.now();
  await f.db
    .insertInto('config_items')
    .values({
      app_id: f.appId,
      key: `credit.enabled.${order.platform}`,
      value: JSON.stringify(true),
      version: 1,
      updated_by: 'fixture',
    })
    .execute();
  await f.db
    .insertInto('settle_bills')
    .values({
      app_id: f.appId,
      bill_id: BILL,
      generation_started_at: at,
      generated_at: at,
      created_at: at,
    })
    .execute();
  const batchId = randomUUID();
  const itemId = randomUUID();
  await f.db
    .insertInto('settle_batches')
    .values({
      batch_id: batchId,
      app_id: f.appId,
      bill_id: BILL,
      platform: order.platform,
      kind: 'main',
      status: 'CONFIRMED',
      settle_mode: 'IMMEDIATE',
      scheduled_at: null,
      confirmed_by: input.adminId,
      confirmed_at: at,
      cancelled_reason: null,
      settle_run_id: null,
      order_count: 1,
      started_at: null,
      finished_at: null,
      paused_by_switch_at: null,
      row_version: 3,
      created_at: at,
    })
    .execute();
  await f.db
    .insertInto('settle_batch_items')
    .values({
      id: itemId,
      app_id: f.appId,
      batch_id: batchId,
      item_type: 'order',
      order_id: order.orderId,
      user_id: null,
      role: null,
      beneficiary_credit_id: null,
      settle_seq: 1,
      b_settle_fen: input.settleFen,
      amount_fen: null,
      result: null,
      skip_reason: null,
      created_at: at,
    })
    .execute();
  const job: ReceivedJob = {
    id: randomUUID(),
    queue: 'settle',
    name: 'batch_execute',
    attempt: 1,
    payload: { app_id: f.appId, batch_id: batchId },
  };
  await worker.handlerOn('settle')(job);
  return f.db
    .selectFrom('settle_batch_items')
    .select(['result', 'skip_reason'])
    .where('app_id', '=', f.appId)
    .where('id', '=', itemId)
    .executeTakeFirstOrThrow();
}

/** One delivery of the compensation scan to the handler the worker registered on order-sync. */
export function scanSnapshots(f: RestoreFixture, worker: Worker): Promise<void> {
  return worker.handlerOn('order-sync')({
    id: randomUUID(),
    queue: 'order-sync',
    name: 'snapshot_retry',
    attempt: 1,
    payload: { app_id: f.appId },
  });
}

// ---------------------------------------------------------------------------------------------
// The lock barrier: real connections and PostgreSQL's own view of who waits for whom.

export interface HeldTransaction {
  /** The backend of the open transaction. */
  readonly pid: number;
  /** Ends the transaction and waits for it; once it has ended, a later call changes nothing. */
  finish(how: 'commit' | 'rollback'): Promise<void>;
}

class ParkedRollback extends Error {}

/** Runs `body` in a transaction on `db` and leaves that transaction open until finish(). */
export async function holdOpen(
  db: Kysely<DB>,
  body: (trx: Transaction<DB>) => Promise<void>,
): Promise<HeldTransaction> {
  const opened = Promise.withResolvers<number>();
  const gate = Promise.withResolvers<'commit' | 'rollback'>();
  const done = db
    .transaction()
    .execute(async (trx) => {
      const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);
      await body(trx);
      opened.resolve(rows[0]!.pid);
      if ((await gate.promise) === 'rollback') throw new ParkedRollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof ParkedRollback)) throw error;
    });
  await Promise.race([opened.promise, done]);
  return {
    pid: await opened.promise,
    finish(how) {
      gate.resolve(how);
      return done;
    },
  };
}

/**
 * Waits until PostgreSQL shows a backend blocked by `holderPid` on a lock of `kind` and returns that
 * backend. An assertion fails when `waiter` ends first (it did not wait) or nothing ever blocks.
 */
export async function untilBlockedBy(
  db: Kysely<DB>,
  holderPid: number,
  kind: 'advisory' | 'transactionid',
  waiter: { readonly settled: boolean },
): Promise<number> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    expect(waiter.settled, `must wait on ${kind} held by backend ${holderPid}`).toBe(false);
    const { rows } = await sql<{ pid: number }>`select pid from pg_stat_activity
      where ${holderPid} = any(pg_blocking_pids(pid)) and wait_event_type = 'Lock'
      and wait_event = ${kind}`.execute(db);
    const blocked = rows[0];
    if (blocked !== undefined) return blocked.pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return expect.fail(`PostgreSQL showed no ${kind} wait behind backend ${holderPid}`);
}

/** The standard advisory lock of the order's key (orders/infra/order-lock.ts). */
export function lockOrder(trx: Transaction<DB>, order: VoidOrder): Promise<void> {
  return lockOrderKey(trx, order.platform, order.subOrderId);
}

/** On `trx`: the order leaves VOID / BLACKLIST by R12, with its history row. */
export async function moveOffVoid(
  f: RestoreFixture,
  trx: Transaction<DB>,
  order: VoidOrder,
): Promise<void> {
  await trx
    .updateTable('orders')
    .set({ rebate_status: 'ESTIMATED', reason: null })
    .where('app_id', '=', f.appId)
    .where('order_id', '=', order.orderId)
    .execute();
  await addRebateStep({ ...f, db: trx }, order.orderId, {
    from: 'VOID',
    event: 'ADMIN_RESTORE',
    to: 'ESTIMATED',
    source: 'admin',
  });
}

/** On `trx`: the order enters VOID / BLACKLIST; returns the id of the history row of that entry. */
export async function moveIntoVoid(
  f: RestoreFixture,
  trx: Transaction<DB>,
  order: VoidOrder,
): Promise<bigint> {
  await trx
    .updateTable('orders')
    .set({ rebate_status: 'VOID', reason: 'BLACKLIST' })
    .where('app_id', '=', f.appId)
    .where('order_id', '=', order.orderId)
    .execute();
  return addRebateStep({ ...f, db: trx }, order.orderId, {
    from: 'ESTIMATED',
    event: 'BLACKLIST_HIT',
    to: 'VOID',
  });
}

// ---------------------------------------------------------------------------------------------
// Reads.

/** The app's appeal_restore differences, by id. */
export function appealDiffs(f: RestoreFixture): Promise<DiffRow[]> {
  return f.db
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('type', '=', 'appeal_restore')
    .orderBy('id')
    .execute();
}

export type SplitRow = Selectable<DB['commission_splits']>;

/** The order's commission_splits rows. */
export function splitsOf(f: RestoreFixture, orderId: string): Promise<SplitRow[]> {
  return f.db
    .selectFrom('commission_splits')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('order_id', '=', orderId)
    .execute();
}

/** The order's order_sync_pending rows, oldest first. */
export function pendingOf(f: RestoreFixture, orderId: string) {
  return f.db
    .selectFrom('order_sync_pending')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('order_id', '=', orderId)
    .orderBy('id')
    .execute();
}

/** What the consumer recorded for an event (at most one row). */
export function processedOf(eventId: string, f: RestoreFixture) {
  return f.db
    .selectFrom('processed_events')
    .select(['consumer', 'event_id'])
    .where('consumer', '=', CONSUMER)
    .where('event_id', '=', eventId)
    .execute();
}

/** The balances, entries and order state a difference may not touch while it is registered. */
export const UNCHANGED_BY_REGISTRATION = [
  'orders',
  'history',
  'shareEvents',
  'vouchers',
  'entries',
  'balances',
  'audits',
] as const;

type RegistrationView = Readonly<Record<(typeof UNCHANGED_BY_REGISTRATION)[number], unknown>>;

/** Two reads of platform-restore's world(): what registering a difference may not change. */
export function expectUnchangedByRegistration(
  before: RegistrationView,
  after: RegistrationView,
): void {
  for (const key of UNCHANGED_BY_REGISTRATION) expect(after[key], key).toEqual(before[key]);
}

/** The 20001 of a restore whose snapshot cannot be generated (BR-CALC-10, BR-FUND-22 处理时再核). */
export function unavailable(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20001, {
    fields: ['recon_diff_id'],
    reason: 'restore_snapshot_unavailable',
  });
}

export interface VoidState {
  readonly order: OrderRow;
  readonly history: readonly HistoryRow[];
}

/** The order and its history, before a restore. */
export async function stateOf(f: RestoreFixture, order: VoidOrder): Promise<VoidState> {
  return {
    order: await orderRow(f, order.orderId),
    history: await orderHistory(f, order.orderId),
  };
}

/**
 * A refused restore: the order and its history as they were (still VOID), the difference as it was
 * (open), no snapshot and no pending row.
 */
export async function expectStillVoid(
  f: RestoreFixture,
  order: VoidOrder,
  before: VoidState,
  diff: DiffRow,
): Promise<void> {
  expect(await orderRow(f, order.orderId)).toEqual(before.order);
  expect(before.order.rebate_status).toBe('VOID');
  expect(await orderHistory(f, order.orderId)).toEqual(before.history);
  expect(await diffNow(f, diff.id)).toEqual(diff);
  expect(diff.status).toBe('open');
  expect(await splitsOf(f, order.orderId)).toEqual([]);
  expect(await pendingOf(f, order.orderId)).toEqual([]);
}
