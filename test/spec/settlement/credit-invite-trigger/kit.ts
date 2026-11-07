// B2-04zzc rule-test kit (claude-independent; 编排 D10-805 ②, D10-810; 08 BR-INV-24 ②「触发与发放时点」,
// ⑥, 细则「有效期」「判定顺序」). The settle worker credits orders (R5) through
// SettlementModule.forWorker; its invite trigger port is the one app.module hands in on the worker
// entry (captured from AppModule.forEntry, never built here), optionally behind a pass-through
// recorder. Everything else comes from the B2-04ze worker kits (the owners' real readers, the
// B2-04m harness ledger, the B2-04p batch fixture), so the trigger sees real orders rows and real
// invite_rewards rows on the credit's own transaction.
// The payout / expiry side is growth's real createInviteRewardPayout / Expiry / Scanner over
// orders' real fact reader and ledger's real REWARD:INVITE writer; its anti-abuse readers answer
// "nothing found" (they are not under test here).
// Conventions fixed by these tests (task brief §10):
// - SettlementWorkerPorts.inviteRewardTrigger(runtime) → { onCredited(trx, { app_id, order_id }) },
//   runtime = the worker's { db, clock, logger }; createCreditOrder's inviteTrigger;
// - the call sits after the R5 CAS and before order.credited, on the credit's transaction;
// - only R5 calls it; booked_base_fen = 0 never triggers.
// Synthetic rows only (no real user data).
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { PostgresQueryCompiler, sql, type Insertable, type Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  createInviteRewardExpiry,
  createInviteRewardPayout,
  createInviteRewardScanner,
  type InviteRewardGrantWriter,
} from '../../../../apps/api/src/modules/growth/application/invite-reward.ts';
import { createInviteRewardGrantWriter } from '../../../../apps/api/src/modules/ledger/index.ts';
import { createInviteRewardOrderFacts } from '../../../../apps/api/src/modules/orders/ports/invite-reward.ts';
import {
  createRootLogger,
  type EventBus,
  type JobHandler,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type { SettlementWorkerPorts } from '../../../../apps/api/src/modules/settlement/worker/index.ts';
import type { Fixture, SeededBatch } from '../batch-executor/kit.ts';
import type { OrderSpec, SeededOrder } from '../credit/kit.ts';
import { workerPorts } from '../worker/credit-kit.ts';
import {
  EXECUTE,
  FAKE_CRYPTO,
  TAOBAO,
  capturedPorts,
  fakeQueue,
  isTransaction,
  receivedJob,
  settleHandler,
  settlementModule,
  workerContext,
} from '../worker/kit.ts';

export { TIMEOUT } from '../batch-executor/kit.ts';

/** Qualified before the harness orders were placed (their attr_at is 2032-06-20 10:00 +08:00). */
export const QUALIFIED_AT = '2032-06-15T10:00:00+08:00';
/** 60 days: the window ends 2032-08-14, after every clock of these tests (never due to expire). */
export const ELIGIBILITY_DAYS = 60;
/** With 30 days the window of this qualification ended 2032-05-01, before the orders were placed. */
export const LAPSED_QUALIFIED_AT = '2032-04-01T10:00:00+08:00';
export const LAPSED_DAYS = 30;
/** The per-party amount locked on the qualification (BR-INV-24 默认 1000 分). */
export const AMOUNT_FEN = 1000n;
/** orders.pay_amount_fen of the seeded orders (min_paid_fen unset = 0, BR-INV-24 默认). */
export const PAID_FEN = 4990n;
export const MIN_PAID_KEY = 'growth.invite_reward.min_paid_fen';

// ---------------------------------------------------------------------------------------------
// The production trigger port.

export type TriggerFactory = NonNullable<SettlementWorkerPorts['inviteRewardTrigger']>;

/** The port app.module hands to SettlementModule.forWorker on the worker entry (or undefined). */
export async function productionTrigger(): Promise<TriggerFactory | undefined> {
  const ports = await capturedPorts('worker');
  expect(ports, 'app.module does not assemble SettlementModule.forWorker').not.toBeNull();
  return ports?.inviteRewardTrigger;
}

export interface TriggerCall {
  readonly inTransaction: boolean;
  readonly appId: string;
  readonly orderId: string;
}

/** A pass-through recorder around a trigger factory; undefined stays undefined (nothing wired). */
export function recorded(factory: TriggerFactory | undefined): {
  readonly factory: TriggerFactory | undefined;
  readonly calls: TriggerCall[];
} {
  const calls: TriggerCall[] = [];
  if (factory === undefined) return { factory, calls };
  const wrapped: TriggerFactory = (runtime) => {
    const inner = factory(runtime);
    return {
      async onCredited(trx, input) {
        calls.push({
          inTransaction: isTransaction(trx),
          appId: input.app_id,
          orderId: input.order_id,
        });
        await inner.onCredited(trx, input);
      },
    };
  };
  return { factory: wrapped, calls };
}

// ---------------------------------------------------------------------------------------------
// Logging.

export interface CapturedLogs {
  readonly logger: RootLogger;
  readonly lines: Record<string, unknown>[];
}

export function captureLogger(): CapturedLogs {
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'worker', appEnv: 'test' },
    {
      write(line: string) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { logger, lines };
}

/** pino's numeric error level. */
export const ERROR_LEVEL = 50;

export function errorLines(logs: CapturedLogs): Record<string, unknown>[] {
  return logs.lines.filter((line) => line['level'] === ERROR_LEVEL);
}

// ---------------------------------------------------------------------------------------------
// The worker.

export interface WorkerOptions {
  /** The trigger port (production, recorded, or undefined). */
  readonly trigger: TriggerFactory | undefined;
  /** Replaces identity's users lock port (pauses are built on it). */
  readonly lockUsers?: SettlementWorkerPorts['lockUsers'];
  /** Replaces the transactional event writer (default: the harness's event_log writer). */
  readonly publish?: EventBus['publish'];
  readonly logger?: RootLogger;
  /** The worker's database handle (default: the fixture's pool). */
  readonly db?: Kysely<DB>;
}

/** credit.enabled.taobao on; settle.auto.enabled unset (its default is on). */
function creditOn(): Map<string, unknown> {
  return new Map<string, unknown>([[`credit.enabled.${TAOBAO}`, true]]);
}

/**
 * SettlementModule.forWorker over the B2-04ze worker ports of the fixture plus the given trigger,
 * in a Nest context at the fixture's clock; runs `body` with the settle handler.
 */
export async function withWorker(
  f: Fixture,
  options: WorkerOptions,
  body: (handler: JobHandler) => Promise<void>,
): Promise<void> {
  const base = workerPorts(f.h, creditOn()).ports;
  const ports: SettlementWorkerPorts = {
    ...base,
    ...(options.lockUsers === undefined ? {} : { lockUsers: options.lockUsers }),
    ...(options.trigger === undefined ? {} : { inviteRewardTrigger: options.trigger }),
  };
  const SettlementModule = await settlementModule();
  const queue = fakeQueue();
  const events: EventBus = { publish: options.publish ?? f.h.publish };
  const context = await workerContext(SettlementModule.forWorker(ports), {
    clock: f.h.clock,
    logger: options.logger ?? captureLogger().logger,
    db: options.db ?? f.db,
    queue,
    crypto: FAKE_CRYPTO,
    events,
  });
  try {
    await body(settleHandler(queue));
  } finally {
    await context.close();
  }
}

/** One delivery of batch_execute for `batch`. */
export function execute(handler: JobHandler, f: Fixture, batch: SeededBatch): Promise<void> {
  return handler(receivedJob(EXECUTE, { app_id: f.appId, batch_id: batch.batchId }));
}

/** Credits `orders` in one fresh batch through a worker with `trigger`; the batch ends DONE. */
export async function creditInBatch(
  f: Fixture,
  orders: readonly SeededOrder[],
  options: WorkerOptions,
): Promise<SeededBatch> {
  const batch = await f.batch(orders);
  await withWorker(f, options, (handler) => execute(handler, f, batch));
  expect((await f.stored(batch)).status).toBe('DONE');
  return batch;
}

// ---------------------------------------------------------------------------------------------
// Seeding.

/** A member of the fixture's app (users row and wallet account), with an optional parent. */
export async function member(f: Fixture, parent: string | null = null): Promise<string> {
  const id = await f.h.user('normal');
  if (parent !== null) {
    await f.db
      .withSchema('app')
      .updateTable('users')
      .set({ parent_id: parent })
      .where('app_id', '=', f.appId)
      .where('id', '=', id)
      .execute();
  }
  return id;
}

export interface Pair {
  readonly inviter: string;
  readonly invitee: string;
}

/** An inviter and an invitee bound to it (users.parent_id). */
export async function pair(f: Fixture): Promise<Pair> {
  const inviter = await member(f);
  const invitee = await member(f, inviter);
  return { inviter, invitee };
}

/**
 * A qualified invite reward of `p` (BR-INV-24 ①, as growth's qualifier leaves it): 1000 per party,
 * the total budget reserved by 2000 on the same app.
 */
export async function qualify(
  f: Fixture,
  p: Pair,
  patch: Partial<Insertable<DB['invite_rewards']>> = {},
): Promise<void> {
  const amount = patch.amount_fen === undefined ? AMOUNT_FEN : BigInt(patch.amount_fen);
  await f.db
    .withSchema('app')
    .insertInto('invite_rewards')
    .values({
      app_id: f.appId,
      invitee_id: p.invitee,
      inviter_id: p.inviter,
      amount_fen: amount,
      eligibility_days: ELIGIBILITY_DAYS,
      qualified_at: new Date(QUALIFIED_AT),
      bind_source: 'register',
      bind_ip_hmac: randomBytes(32).toString('hex'),
      status: 'qualified',
      trigger_order_id: null,
      triggered_at: null,
      row_version: 0,
      ...patch,
    })
    .execute();
  const reserve = amount * 2n;
  await f.db
    .withSchema('app')
    .insertInto('invite_reward_budgets')
    .values({
      app_id: f.appId,
      period: 'total',
      reserved_fen: reserve,
      granted_fen: 0n,
      updated_at: new Date(QUALIFIED_AT),
    })
    .onConflict((oc) =>
      oc.columns(['app_id', 'period']).doUpdateSet({
        reserved_fen: sql<bigint>`invite_reward_budgets.reserved_fen + ${reserve}`,
      }),
    )
    .execute();
}

export interface OrderOptions {
  /** A share order (buy_type share) of the owner instead of a self-purchase. */
  readonly share?: boolean;
  readonly settleFen?: bigint;
  readonly reserveBp?: number;
  /** orders columns over the defaults (pay_amount_fen = PAID_FEN). */
  readonly patch?: OrderSpec['patch'];
}

/**
 * A WAITING order of `p.invitee` (self 4000 bp, the inviter as direct 800 bp; N 1000, no reserve
 * unless given: booked_base_fen 1000), placed 2032-06-20 10:00 +08:00, paid PAID_FEN.
 */
export async function inviteeOrder(
  f: Fixture,
  p: Pair,
  options: OrderOptions = {},
): Promise<SeededOrder> {
  return f.h.order({
    people: [
      { role: options.share === true ? 'share' : 'self', ratioBp: 4000, userId: p.invitee },
      { role: 'direct', ratioBp: 800, userId: p.inviter },
    ],
    reserveBp: options.reserveBp ?? 0,
    settleFen: options.settleFen ?? 1000n,
    subOrderId: `cit-${randomUUID()}`,
    patch: { pay_amount_fen: PAID_FEN, ...options.patch },
  });
}

// ---------------------------------------------------------------------------------------------
// Reads.

export async function rewardOf(f: Fixture, invitee: string) {
  return f.db
    .withSchema('app')
    .selectFrom('invite_rewards')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('invitee_id', '=', invitee)
    .executeTakeFirstOrThrow();
}

/** The trigger columns and status of the invitee's qualification. */
export async function triggerOf(f: Fixture, invitee: string) {
  const row = await rewardOf(f, invitee);
  return {
    status: row.status,
    trigger_order_id: row.trigger_order_id,
    triggered_at: row.triggered_at?.toISOString() ?? null,
  };
}

/** The untouched qualification: still qualified, no trigger. */
export const UNTRIGGERED = { status: 'qualified', trigger_order_id: null, triggered_at: null };

export async function budgetsOf(f: Fixture) {
  const rows = await f.db
    .withSchema('app')
    .selectFrom('invite_reward_budgets')
    .select(['period', 'reserved_fen', 'granted_fen'])
    .where('app_id', '=', f.appId)
    .orderBy('period')
    .execute();
  return rows;
}

/** The REWARD:INVITE voucher keys of the app (INVITE_REWARD:{invitee}:{side}). */
export async function rewardVoucherKeys(f: Fixture): Promise<string[]> {
  return (await f.h.voucherKeys()).filter((key) => key.startsWith('INVITE_REWARD:'));
}

/** The R5 rows of an order (each credit writes exactly one). */
export async function creditedRows(f: Fixture, o: SeededOrder): Promise<number> {
  return f.creditedHistory(o);
}

// ---------------------------------------------------------------------------------------------
// Faults and waits.

/**
 * A real SQL error on the first statement that touches invite_rewards (the trigger port's write):
 * PostgreSQL runs `SELECT 1 / 0` in its place, so the transaction really is in error.
 */
export function failingRewardStatement(db: Kysely<DB>): {
  readonly db: Kysely<DB>;
  injected(): number;
} {
  let injected = 0;
  const faulty = db.withPlugin({
    transformQuery(args) {
      if (injected > 0) return args.node;
      const compiled = new PostgresQueryCompiler().compileQuery(args.node, args.queryId);
      if (!/"invite_rewards"/u.test(compiled.sql)) return args.node;
      injected += 1;
      return sql`SELECT 1 / 0 AS injected_sql_error`.toOperationNode() as unknown as typeof args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  return { db: faulty, injected: () => injected };
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * identity's users lock that, on its first call naming `userId`, holds the locks it took until
 * `release` resolves (`entered` resolves once they are held).
 */
export function pausingLock(
  base: SettlementWorkerPorts['lockUsers'],
  userId: string,
): {
  readonly lockUsers: SettlementWorkerPorts['lockUsers'];
  readonly entered: Promise<void>;
  release(): void;
} {
  const entered = deferred();
  const release = deferred();
  let armed = true;
  const lockUsers: SettlementWorkerPorts['lockUsers'] = async (trx, input) => {
    const locked = await base(trx, input);
    if (armed && input.userIds.includes(userId)) {
      armed = false;
      entered.resolve();
      await release.promise;
    }
    return locked;
  };
  return { lockUsers, entered: entered.promise, release: () => release.resolve() };
}

/** Polls until at least `count` backends of this database wait on a lock. */
export async function waitLockWaiters(db: Kysely<DB>, count: number): Promise<void> {
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    const result = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(db);
    if ((result.rows[0]?.n ?? 0) >= count) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect.fail(`fewer than ${String(count)} backends waited on a lock`);
}

// ---------------------------------------------------------------------------------------------
// growth's payout and expiry (the side that runs after the credit committed).

const PAYOUT_SETTINGS: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['growth.invite_reward.daily_budget_fen', 20000],
  ['growth.invite_reward.payout_paused', false],
  ['growth.invite_reward.ip_window_hours', 24],
  ['growth.invite_reward.min_paid_fen', 0],
]);

/** growth's payout, daily expiry and scanner on `db`, paying through ledger's REWARD:INVITE writer. */
export function rewardSide(f: Fixture, db: Kysely<DB> = f.db) {
  const logger = captureLogger().logger;
  const orders = createInviteRewardOrderFacts();
  const writer = createInviteRewardGrantWriter({ ledger: f.h.ledger });
  const grantWriter: InviteRewardGrantWriter = {
    async grant(trx, input) {
      const answer = await writer.grant(trx, input);
      if (answer.voucher_id === null) throw new Error('synthetic payout: no voucher written');
      return { voucher_id: answer.voucher_id };
    },
  };
  const base = {
    db,
    clock: f.h.clock,
    logger,
    config: {
      configValue: async (_appId: string, key: string) =>
        PAYOUT_SETTINGS.has(key) ? { value: PAYOUT_SETTINGS.get(key), version: 1 } : null,
    },
  };
  const payout = createInviteRewardPayout({
    ...base,
    orders,
    crypto: { blindIndex: () => '0'.repeat(64) },
    loginDevices: { read: async () => [] },
    loginIps: { read: async () => [] },
    deletedPhone: { retained: async () => false },
    deletionStatus: {
      read: async (_trx, input) =>
        new Map(input.user_ids.map((id) => [id, 'none' as const] as const)),
    },
    readRisk: async () => ({ state: 'normal' as const, reason_category: null, frozen_until: null }),
    multiAccount: { judge: async () => ({ marked: false, devices: [] }) },
    grantWriter,
  });
  const expiry = createInviteRewardExpiry({ ...base, orders });
  const scanner = createInviteRewardScanner({ db, clock: f.h.clock, logger, payout, expiry });
  return { payout, expiry, scanner };
}
