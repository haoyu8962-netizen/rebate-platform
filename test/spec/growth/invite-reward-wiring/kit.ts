// B2-16c rule-test kit (08 BR-INV-24 ③ ⑦; D10-805 ①; FU-INVITE-REWARD-WIRING). The gap under test
// is the assembly itself, so nothing here injects growth's ports: the invite reward scanner is the
// one a real AppModule.forEntry({ entry: 'worker' }) provides (inviteRewardScannerToken), over a real
// field keyring (the scanner is null without FIELD_CRYPTO, which a plain test config does not give),
// the platform's real event bus, PostgreSQL as couli_app and ledger's real writer. Only the job queue
// is a recording stub (as test/spec/orders/rebate-wiring/kit.ts). Every row is synthetic.
// Integration tests pass the database in: this file never imports @couli/db/testing.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Selectable } from 'kysely';
import { expect, vi } from 'vitest';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import type { FixedClock, RootLogger } from '../../../../apps/api/src/modules/platform/index.ts';

const ROOT = new URL('../../../../', import.meta.url);

export const TIMEOUT = 120_000;
/** Binding instant (qualified_at) of every seeded reward. */
export const QUALIFIED = '2026-10-20T02:00:00.000Z';
/** The trigger order's placing instant: inside the 30-day window. */
export const ATTR_AT = '2026-10-22T02:00:00.000Z';
/** Credit of the trigger order and the first payout round. */
export const PAID = '2026-11-25T02:00:00.000Z';
/** The next round, one scan interval later (same accounting day). */
export const NEXT_ROUND = '2026-11-25T02:01:00.000Z';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The per-party amount locked on the qualification record (deliberately not the config value). */
export const LOCKED_AMOUNT = 777n;
/** growth.invite_reward.amount_fen today: a payout must not read it. */
export const CONFIG_AMOUNT = 1000;
export const DAILY_BUDGET = 20_000;
export const WRITER_UNAVAILABLE = 'invite_reward_writer_unavailable';

export type Party = 'inviter' | 'invitee';
export const PARTIES: readonly Party[] = ['inviter', 'invitee'];
export type Reward = Selectable<DB['invite_rewards']>;
export type RequestStatus = 'cooling' | 'processing' | 'done' | 'cancelled';

interface Context {
  get(token: unknown, options?: { strict: boolean }): unknown;
  close(): Promise<void>;
}

interface WorkerPlatform {
  PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
  JOB_QUEUE: symbol;
  FixedClock: new (instant: string) => FixedClock;
  createRootLogger(
    options: { level: string; entry: string; appEnv: string },
    stream: { write(line: string): void },
  ): RootLogger;
  loadConfig(env: Record<string, string>): unknown;
}

interface Scanner {
  tick(): Promise<void>;
}

export interface LogLine {
  readonly level: number;
  readonly msg: string;
  readonly [field: string]: unknown;
}

/**
 * A real worker entry with a field keyring over `db`, and the invite reward scanner it assembled.
 * `scanner` is null when app.module provides none (the caller asserts it).
 */
export async function worker(db: Kysely<DB>) {
  // URL imports keep decorated HTTP controllers out of the spec project's TS compilation.
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: object): unknown };
  };
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as WorkerPlatform;
  const growth = (await import(
    new URL('apps/api/src/modules/growth/application/invite-reward.ts', ROOT).href
  )) as { inviteRewardScannerToken(): symbol };
  const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: { createApplicationContext(module: unknown, options: object): Promise<Context> };
  };
  const clock = new platform.FixedClock(PAID);
  const lines: string[] = [];
  const logger = platform.createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const queue = {
    send: vi.fn(async () => 'fixture-job'),
    register: vi.fn(),
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
  const dir = mkdtempSync(join(tmpdir(), 'b2-16c-'));
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
        clock,
        logger,
        dbHandles: { db, dbRead: null, close: async () => undefined },
      }),
      { logger: false, abortOnError: false },
    );
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    spy.mockRestore();
  }
  const scanner = context.get(growth.inviteRewardScannerToken(), {
    strict: false,
  }) as Scanner | null;
  return {
    clock,
    lines,
    scanner,
    /** Parsed log lines (optionally of one app only). */
    logs(appId?: string): LogLine[] {
      return lines
        .map((line) => JSON.parse(line) as LogLine)
        .filter((line) => appId === undefined || line['app_id'] === appId);
    },
    async close() {
      try {
        await context.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
export type Worker = Awaited<ReturnType<typeof worker>>;

/** One scanner round at `instant` (an assertion fails when app.module provides no scanner). */
export async function round(w: Worker, instant: string = PAID): Promise<void> {
  w.clock.set(instant);
  expect(w.scanner, 'the worker entry assembles no invite reward scanner').not.toBeNull();
  await w.scanner?.tick();
}

// ---- seeding ---------------------------------------------------------------------------------

function app(db: Kysely<DB>) {
  return db.withSchema('app');
}

export function hex(): string {
  return randomBytes(32).toString('hex');
}

export function newAppId(): string {
  return `b216c_${randomBytes(8).toString('hex')}`;
}

/** A user of the app (users.status normal unless given; a phone HMAC of its own unless given). */
export async function user(
  db: Kysely<DB>,
  appId: string,
  options: { readonly parent?: string; readonly status?: string; readonly phoneHmac?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await app(db)
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname: 'invite wiring fixture',
      avatar: 'fixture',
      invite_code: randomBytes(8).toString('hex'),
      attr_code: randomBytes(4).toString('hex'),
      register_method: 'sms',
      level: 'L1',
      status: options.status ?? 'normal',
      phone_hmac: options.phoneHmac ?? hex(),
      parent_id: options.parent ?? null,
      parent_bind_source: options.parent === undefined ? null : 'register',
      parent_bound_at: options.parent === undefined ? null : new Date(QUALIFIED),
      created_at: new Date(QUALIFIED),
      updated_at: new Date(QUALIFIED),
    })
    .execute();
  return id;
}

/** config_items of the app: the reward is on, unpaused, with a daily budget that covers it. */
export async function configure(db: Kysely<DB>, appId: string): Promise<void> {
  const values: Record<string, unknown> = {
    'growth.invite_reward.enabled': true,
    'growth.invite_reward.amount_fen': CONFIG_AMOUNT,
    'growth.invite_reward.eligibility_days': 30,
    'growth.invite_reward.total_budget_fen': 100_000,
    'growth.invite_reward.daily_budget_fen': DAILY_BUDGET,
    'growth.invite_reward.min_paid_fen': 0,
    'growth.invite_reward.ip_window_hours': 24,
    'growth.invite_reward.payout_paused': false,
  };
  for (const [key, value] of Object.entries(values)) {
    await app(db)
      .insertInto('config_items')
      .values({ app_id: appId, key, value: JSON.stringify(value), updated_by: 'b2-16c-fixture' })
      .execute();
  }
}

/** A credited self-purchase order of the invitee, placed inside the window, no refund or rights. */
async function triggerOrder(db: Kysely<DB>, appId: string, inviteeId: string): Promise<string> {
  const orderId = randomUUID();
  const subOrderId = randomUUID();
  await app(db)
    .insertInto('order_keys')
    .values({
      app_id: appId,
      order_id: orderId,
      platform: 'taobao',
      sub_order_id: subOrderId,
      attr_at: new Date(ATTR_AT),
    })
    .execute();
  await app(db)
    .insertInto('orders')
    .values({
      app_id: appId,
      order_id: orderId,
      platform: 'taobao',
      sub_order_id: subOrderId,
      raw_item_id: 'b2-16c-fixture',
      user_id: inviteeId,
      buy_type: 'self',
      attr_at: new Date(ATTR_AT),
      credited_at: new Date(PAID),
      rebate_status: 'CREDITED',
      platform_status: 'SETTLED',
      base_fen: 320n,
      pay_amount_fen: 4990n,
      refunded_quantity: 0,
      refunded_quantity_at_credit: 0,
      created_at: new Date(ATTR_AT),
      updated_at: new Date(PAID),
    })
    .execute();
  return orderId;
}

export interface Pair {
  readonly appId: string;
  readonly inviter: string;
  readonly invitee: string;
}

/**
 * A configured app (unless `appId` is given and already configured) with an inviter, its invitee
 * and a triggered qualification record of LOCKED_AMOUNT per party, both parties still reserved on
 * the total budget: due on the next scanner round.
 */
export async function duePair(
  db: Kysely<DB>,
  options: {
    readonly appId?: string;
    readonly inviterStatus?: string;
    readonly inviteeStatus?: string;
    readonly inviteePhoneHmac?: string;
  } = {},
): Promise<Pair> {
  const appId = options.appId ?? newAppId();
  if (options.appId === undefined) await configure(db, appId);
  const inviter = await user(db, appId, {
    ...(options.inviterStatus === undefined ? {} : { status: options.inviterStatus }),
  });
  const invitee = await user(db, appId, {
    parent: inviter,
    ...(options.inviteeStatus === undefined ? {} : { status: options.inviteeStatus }),
    ...(options.inviteePhoneHmac === undefined ? {} : { phoneHmac: options.inviteePhoneHmac }),
  });
  const orderId = await triggerOrder(db, appId, invitee);
  await app(db)
    .insertInto('invite_rewards')
    .values({
      app_id: appId,
      invitee_id: invitee,
      inviter_id: inviter,
      amount_fen: LOCKED_AMOUNT,
      eligibility_days: 30,
      qualified_at: new Date(QUALIFIED),
      bind_source: 'register',
      bind_ip_hmac: hex(),
      status: 'qualified',
      trigger_order_id: orderId,
      triggered_at: new Date(PAID),
      granted_at: null,
      inviter_result: null,
      invitee_result: null,
      inviter_skip_reason: null,
      invitee_skip_reason: null,
      void_reason: null,
      inviter_voucher_id: null,
      invitee_voucher_id: null,
      row_version: 0,
    })
    .execute();
  await app(db)
    .insertInto('invite_reward_budgets')
    .values({
      app_id: appId,
      period: 'total',
      reserved_fen: LOCKED_AMOUNT * 2n,
      granted_fen: 0n,
      updated_at: new Date(PAID),
    })
    .onConflict((oc) =>
      oc.columns(['app_id', 'period']).doUpdateSet({
        reserved_fen: sql<bigint>`invite_reward_budgets.reserved_fen + ${LOCKED_AMOUNT * 2n}`,
      }),
    )
    .execute();
  return { appId, inviter, invitee };
}

export function partyUser(pair: Pair, party: Party): string {
  return party === 'inviter' ? pair.inviter : pair.invitee;
}

/** A deletion request of the user (synthetic; identity's own table, written directly). */
export async function deletionRequest(
  db: Kysely<DB>,
  appId: string,
  userId: string,
  status: RequestStatus,
): Promise<string> {
  const now = Date.parse(PAID);
  // cooling / cancelled: the 7-day window is still running at PAID; processing / done: it ended.
  const coolingUntil =
    status === 'cooling' || status === 'cancelled'
      ? new Date(now + 6 * DAY_MS)
      : new Date(now - DAY_MS);
  const applyAt = new Date(coolingUntil.getTime() - 7 * DAY_MS);
  const id = randomUUID();
  await app(db)
    .insertInto('deletion_requests')
    .values({
      id,
      app_id: appId,
      user_id: userId,
      status,
      apply_at: applyAt,
      cooling_until: coolingUntil,
      cancelled_at: status === 'cancelled' ? new Date(applyAt.getTime() + HOUR_MS) : null,
      cancel_reason: status === 'cancelled' ? 'user' : null,
      processed_at: status === 'done' ? coolingUntil : null,
      balance_snapshot_fen: 0n,
      created_at: applyAt,
      updated_at: applyAt,
    })
    .execute();
  return id;
}

/** The user withdraws a cooling request (BR-ID-27: cancelled by the user inside the window). */
export async function withdrawRequest(db: Kysely<DB>, id: string): Promise<void> {
  const cancelledAt = new Date(Date.parse(PAID) + 30_000);
  await app(db)
    .updateTable('deletion_requests')
    .set({
      status: 'cancelled',
      cancelled_at: cancelledAt,
      cancel_reason: 'user',
      updated_at: cancelledAt,
      row_version: sql<number>`row_version + 1`,
    })
    .where('id', '=', id)
    .where('status', '=', 'cooling')
    .execute();
}

// ---- reading ---------------------------------------------------------------------------------

export async function reward(db: Kysely<DB>, pair: Pair): Promise<Reward | undefined> {
  return app(db)
    .selectFrom('invite_rewards')
    .selectAll()
    .where('app_id', '=', pair.appId)
    .where('invitee_id', '=', pair.invitee)
    .executeTakeFirst();
}

export async function userStatus(db: Kysely<DB>, appId: string, userId: string) {
  const row = await app(db)
    .selectFrom('users')
    .select('status')
    .where('app_id', '=', appId)
    .where('id', '=', userId)
    .executeTakeFirst();
  return row?.status;
}

export async function budget(db: Kysely<DB>, appId: string, period = 'total') {
  const row = await app(db)
    .selectFrom('invite_reward_budgets')
    .select(['reserved_fen', 'granted_fen'])
    .where('app_id', '=', appId)
    .where('period', '=', period)
    .executeTakeFirst();
  return row === undefined ? undefined : { ...row };
}

/** specs/ledger-rules.md §3: INVITE_REWARD:{invitee_user_id}:{side}. */
export function rewardKey(inviteeId: string, party: Party): string {
  return `INVITE_REWARD:${inviteeId}:${party}`;
}

/** Every voucher of the app, by uniq_key. */
export async function vouchers(db: Kysely<DB>, appId: string) {
  return app(db)
    .selectFrom('ledger_vouchers')
    .select(['id', 'uniq_key', 'biz_type', 'biz_id', 'order_key'])
    .where('app_id', '=', appId)
    .orderBy('uniq_key')
    .execute();
}

/** The entries of one voucher with their account owner, platform line first. */
export async function voucherLines(db: Kysely<DB>, appId: string, voucherId: string) {
  const rows = await app(db)
    .selectFrom('ledger_entries as e')
    .innerJoin('ledger_accounts as a', 'a.id', 'e.account_id')
    .select([
      'a.owner_type',
      'a.owner_id',
      'a.subject',
      'e.sub_account',
      'e.amount_fen',
      'e.ledger_type',
      'e.sub_type',
    ])
    .where('e.app_id', '=', appId)
    .where('e.voucher_id', '=', voucherId)
    .execute();
  return rows
    .map((row) => ({ ...row }))
    .sort((a, b) => (a.owner_type === b.owner_type ? 0 : a.owner_type === 'platform' ? -1 : 1));
}

/** specs/ledger-templates.csv 252–253 (REWARD:INVITE) for one beneficiary, platform line first. */
export function rewardLines(userId: string, amount: bigint) {
  return [
    {
      owner_type: 'platform',
      owner_id: 'platform',
      subject: 'MKT_EXPENSE',
      sub_account: 'available',
      amount_fen: amount,
      ledger_type: 'REWARD',
      sub_type: 'invite',
    },
    {
      owner_type: 'user',
      owner_id: userId,
      subject: 'USER_BALANCE',
      sub_account: 'available',
      amount_fen: -amount,
      ledger_type: 'REWARD',
      sub_type: 'invite',
    },
  ];
}
