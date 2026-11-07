// growth's invite reward campaign (task B1-35; 08 BR-INV-24 本体与细则, incl. 「有效期」 from couli
// #161; orchestrator rulings §9.2 / §9.3). Service layer only: no route, no contract change, no
// ledger write (the REWARD vouchers come from the funds lane's InviteRewardGrantWriter, B2-16b).
//
// ① qualification (createInviteRewardQualifier): called by the three self-service binding channels
//    after the relation log, in the binding transaction, under its own SAVEPOINT. Writes nothing
//    unless growth.invite_reward.enabled is strictly JSON true, the per-party amount is > 0, the
//    total budget is a non-negative integer and the bind IP is an IP address. One INSERT … ON
//    CONFLICT (app_id, invitee_id) DO NOTHING locks the inviter, the amount, the validity days and
//    the bound instant; then the shared total budget row is locked (FOR UPDATE) and reserved with
//    a conditional UPDATE (reserved + granted + 2 × amount ≤ total). 0 rows → back to the savepoint.
// ② the available budget (createInviteRewardBudgetReader): total − reserved − granted, at least 0.
// ③ the trigger (createInviteRewardTrigger): called in the CREDITED transaction of a sub-order;
//    a self-purchase with B > 0 and paid ≥ min_paid_fen, placed (attr_at) in
//    [qualified_at, qualified_at + days × 24 h), records itself on a qualified row once.
// ④ the payout (createInviteRewardPayout): the judging order 1–7 of BR-INV-24 细则, one transaction
//    per row, locks users → invite_rewards → total budget → the day's budget.
// ⑤ the daily expiry (createInviteRewardExpiry): a due qualified row without a trigger order either
//    waits (an order in the window has no result yet), is triggered late (a CREDITED eligible order
//    in the window), or expires and releases its reservation.
// The scanner and the worker loop drive ④ and ⑤ (worker entry, every 60 seconds; the expiry once
// per +08:00 accounting day).
//
// Amounts are bigint fen through @couli/money; time only from the injected Clock; every status
// change goes through the generated transitionInviteReward() with a status + row_version condition.
// Logs carry app and user ids, reasons and error classes only: never an IP, a phone or a hash.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators, no Nest.
import { isIP } from 'node:net';
import type { DB } from '@couli/db';
import {
  accountingDate,
  isAtLeastAge,
  transitionInviteReward,
  type InviteRewardEvent,
  type InviteRewardState,
} from '@couli/domain';
import { addFen, fenToJsonNumber, subFen } from '@couli/money';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { Clock, FieldCrypto, RootLogger } from '../../platform/index.ts';
import type { SameDeviceAccountsCheck } from '../../risk/index.ts';
import type { InviteBinderDeps } from './invite-binder.ts';

export interface InviteRewardOrder {
  app_id: string;
  order_id: string;
  user_id: string | null;
  buy_type: string | null;
  base_fen: bigint | null;
  pay_amount_fen: bigint | null;
  attr_at: Date;
  credited_at: Date | null;
  rebate_status: string;
  refunded_quantity: number | null;
  refunded_quantity_at_credit: number | null;
  rights_pending: boolean;
  has_rights: boolean;
}

export interface InviteRewardOrderFacts {
  read(
    trx: Transaction<DB>,
    input: { app_id: string; order_id: string },
  ): Promise<InviteRewardOrder | null>;
  listSelfOrdersInWindow(
    trx: Transaction<DB>,
    input: { app_id: string; user_id: string; from: Date; to: Date },
  ): Promise<readonly InviteRewardOrder[]>;
}

export interface InviteRewardGrantInput {
  app_id: string;
  invitee_id: string;
  party: 'inviter' | 'invitee';
  user_id: string;
  amount_fen: bigint;
  at: Date;
}

/** B2-16b supplies this transactional, idempotent REWARD/sub_type=invite writer. */
export interface InviteRewardGrantWriter {
  grant(trx: Transaction<DB>, input: InviteRewardGrantInput): Promise<{ voucher_id: string }>;
}

export interface InviteRewardBaseDeps {
  db: Kysely<DB>;
  config: InviteBinderDeps['config'];
  clock: Clock;
  logger: RootLogger;
}

export interface InviteRewardQualificationInput {
  app_id: string;
  invitee_id: string;
  inviter_id: string;
  bind_source: 'register' | 'backfill' | 'landing' | 'admin';
  client_ip: string;
  at: Date;
}

export interface InviteRewardQualifier {
  qualifyInviteReward(trx: Transaction<DB>, input: InviteRewardQualificationInput): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Shared constants and helpers
// ---------------------------------------------------------------------------------------------

const KEY_ENABLED = 'growth.invite_reward.enabled';
const KEY_AMOUNT = 'growth.invite_reward.amount_fen';
const KEY_DAYS = 'growth.invite_reward.eligibility_days';
const KEY_TOTAL = 'growth.invite_reward.total_budget_fen';
const KEY_DAILY = 'growth.invite_reward.daily_budget_fen';
const KEY_MIN_PAID = 'growth.invite_reward.min_paid_fen';
const KEY_IP_WINDOW = 'growth.invite_reward.ip_window_hours';
const KEY_PAUSED = 'growth.invite_reward.payout_paused';

/** BR-INV-24 细则 默认值. */
const DEFAULT_AMOUNT = 1000;
const DEFAULT_DAYS = 30;
const DEFAULT_IP_WINDOW_HOURS = 24;
const MAX_AMOUNT = 2_147_483_647;
/** Same range as the F1-02zx registry entry of eligibility_days. */
const MAX_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** BR-ID-26: a verified party under this age is not paid. */
const ADULT_AGE = 18;

/** Blind-index context of invite_rewards.bind_ip_hmac (the canonical host() text of the IP). */
export const INVITE_REWARD_BIND_IP_CONTEXT = 'invite_rewards.bind_ip';
const TOTAL_PERIOD = 'total';

type Party = 'inviter' | 'invitee';
const PARTIES: readonly Party[] = ['inviter', 'invitee'];
type BothSkipReason = 'same_device' | 'same_ip' | 'deleted_phone_retained';
type OneSkipReason = 'deleting' | 'risk_restricted' | 'minor' | 'multi_account';
type SkipReason = BothSkipReason | OneSkipReason;
type VoidReason = 'relation_changed' | 'order_clawed_back' | 'order_rights';
type RewardRow = Selectable<DB['invite_rewards']>;
type ConfigItem = { readonly value: unknown; readonly version: number } | null;
/** The parsed value, or `invalid` when the stored value has the wrong shape. */
type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

function errorClass(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || error.name;
  return error === null ? 'null' : typeof error;
}

/** A copy of `at` moved by `ms` (the Clock's instant is never modified; no `new Date(`). */
function shifted(at: Date, ms: number): Date {
  const copy = structuredClone(at);
  copy.setTime(at.getTime() + ms);
  return copy;
}

/** An integer in [min, max]; missing → fallback; anything else → not ok. */
function integerSetting(
  item: ConfigItem,
  fallback: number,
  min: number,
  max: number,
): Parsed<number> {
  if (item === null) return { ok: true, value: fallback };
  const { value } = item;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    return { ok: false };
  }
  return { ok: true, value };
}

/** Switches parsed strictly (§9.2 第 3 条: not switchOn): only JSON true is on. */
function strictlyOn(item: ConfigItem): boolean {
  return item !== null && item.value === true;
}

/** Twice an amount in fen (both parties). */
function bothParties(amount: bigint): bigint {
  return addFen(amount, amount);
}

/** `amount` × `count` parties (count is 0, 1 or 2). */
function partiesAmount(amount: bigint, count: number): bigint {
  let total = 0n;
  for (let i = 0; i < count; i++) total = addFen(total, amount);
  return total;
}

class SavepointRollback extends Error {}

/** Runs `work` under a savepoint; a throw rolls back to it and is rethrown. */
async function underSavepoint<T>(
  trx: Transaction<DB>,
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  const point = sql.raw(name);
  await sql`SAVEPOINT ${point}`.execute(trx);
  let value: T;
  try {
    value = await work();
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT ${point}`.execute(trx);
    await sql`RELEASE SAVEPOINT ${point}`.execute(trx);
    throw error;
  }
  await sql`RELEASE SAVEPOINT ${point}`.execute(trx);
  return value;
}

/** The validity window of a qualification: [qualified_at, qualified_at + days × 24 h). */
function validityEnd(row: Pick<RewardRow, 'qualified_at' | 'eligibility_days'>): Date {
  return shifted(row.qualified_at, row.eligibility_days * DAY_MS);
}

function placedInWindow(
  row: Pick<RewardRow, 'qualified_at' | 'eligibility_days'>,
  attrAt: Date,
): boolean {
  return (
    attrAt.getTime() >= row.qualified_at.getTime() && attrAt.getTime() < validityEnd(row).getTime()
  );
}

/** The next status through the generated state machine; an illegal pair is a programming error. */
function nextStatus(from: string, event: InviteRewardEvent): InviteRewardState {
  const result = transitionInviteReward(from as InviteRewardState, event);
  if (!result.ok) throw new Error(`growth: invite reward ${from} + ${event} is not a transition`);
  return result.to;
}

/** Locks the users rows in ascending id order, as identity's lockUsersForUpdate (B1-02zf). */
async function lockUsers(trx: Transaction<DB>, appId: string, userIds: readonly string[]) {
  const ids = [...new Set(userIds)].sort();
  await trx
    .withSchema('app')
    .selectFrom('users')
    .select('id')
    .where('app_id', '=', appId)
    .where('id', '=', sql<string>`ANY(${ids})`)
    .orderBy('id')
    .forNoKeyUpdate()
    .execute();
}

function lockReward(trx: Transaction<DB>, appId: string, inviteeId: string) {
  return trx
    .withSchema('app')
    .selectFrom('invite_rewards')
    .selectAll()
    .where('app_id', '=', appId)
    .where('invitee_id', '=', inviteeId)
    .forUpdate()
    .executeTakeFirst();
}

function readInviter(trx: Transaction<DB>, appId: string, inviteeId: string) {
  return trx
    .withSchema('app')
    .selectFrom('invite_rewards')
    .select('inviter_id')
    .where('app_id', '=', appId)
    .where('invitee_id', '=', inviteeId)
    .executeTakeFirst();
}

function lockTotal(trx: Transaction<DB>, appId: string) {
  return trx
    .withSchema('app')
    .selectFrom('invite_reward_budgets')
    .select(['reserved_fen', 'granted_fen'])
    .where('app_id', '=', appId)
    .where('period', '=', TOTAL_PERIOD)
    .forUpdate()
    .executeTakeFirst();
}

/** A budget row of (app, period) with zero amounts, unless it exists. */
async function ensureBudgetRow(trx: Transaction<DB>, appId: string, period: string, at: Date) {
  await trx
    .withSchema('app')
    .insertInto('invite_reward_budgets')
    .values({ app_id: appId, period, reserved_fen: 0n, granted_fen: 0n, updated_at: at })
    .onConflict((oc) => oc.columns(['app_id', 'period']).doNothing())
    .execute();
}

class BudgetUnderflow extends Error {}

/** Releases `amount` of the total reservation; a reservation smaller than it is an error. */
async function releaseReserved(
  trx: Transaction<DB>,
  logger: RootLogger,
  row: Pick<RewardRow, 'app_id' | 'invitee_id'>,
  amount: bigint,
  at: Date,
): Promise<void> {
  if (amount === 0n) return;
  const result = await trx
    .withSchema('app')
    .updateTable('invite_reward_budgets')
    .set({
      reserved_fen: sql<bigint>`${sql.ref('reserved_fen')} - ${amount}`,
      row_version: sql<number>`${sql.ref('row_version')} + 1`,
      updated_at: at,
    })
    .where('app_id', '=', row.app_id)
    .where('period', '=', TOTAL_PERIOD)
    .where('reserved_fen', '>=', amount)
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) {
    logger.error(
      { app_id: row.app_id, invitee_id: row.invitee_id },
      'invite_reward_release_underflow',
    );
    throw new BudgetUnderflow('growth: invite reward reservation smaller than its release');
  }
}

// ---------------------------------------------------------------------------------------------
// ① Qualification
// ---------------------------------------------------------------------------------------------

const QUALIFY_SAVEPOINT = 'growth_invite_reward_qualify';

export function createInviteRewardQualifier(
  deps: InviteRewardBaseDeps & { crypto: Pick<FieldCrypto, 'blindIndex'> },
): InviteRewardQualifier {
  async function qualify(trx: Transaction<DB>, input: InviteRewardQualificationInput) {
    const { logger, config, crypto } = deps;
    const appId = input.app_id;
    const fields = { app_id: appId, invitee_id: input.invitee_id };
    if (!strictlyOn(await config.configValue(appId, KEY_ENABLED, trx))) return;

    const amountSetting = integerSetting(
      await config.configValue(appId, KEY_AMOUNT, trx),
      DEFAULT_AMOUNT,
      0,
      MAX_AMOUNT,
    );
    if (!amountSetting.ok)
      logger.warn({ ...fields, config_key: KEY_AMOUNT }, 'invite_reward_config_invalid');
    const amount = BigInt(amountSetting.ok ? amountSetting.value : DEFAULT_AMOUNT);
    // Amount 0: nothing to lock or reserve (§9.2 第 3 条).
    if (amount === 0n) return;

    const daysSetting = integerSetting(
      await config.configValue(appId, KEY_DAYS, trx),
      DEFAULT_DAYS,
      1,
      MAX_DAYS,
    );
    if (!daysSetting.ok)
      logger.warn({ ...fields, config_key: KEY_DAYS }, 'invite_reward_config_invalid');
    const days = daysSetting.ok ? daysSetting.value : DEFAULT_DAYS;

    // Missing total budget = 0 (BR-INV-24 默认): no reservation can succeed.
    const totalSetting = integerSetting(
      await config.configValue(appId, KEY_TOTAL, trx),
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (!totalSetting.ok) {
      logger.warn({ ...fields, config_key: KEY_TOTAL }, 'invite_reward_config_invalid');
      return;
    }
    const total = BigInt(totalSetting.value);

    if (isIP(input.client_ip) === 0) {
      logger.warn(fields, 'invite_reward_bind_ip_invalid');
      return;
    }
    const canonical = await sql<{
      host: string;
    }>`SELECT host(${input.client_ip}::inet) AS host`.execute(trx);
    const host = canonical.rows[0]?.host;
    if (host === undefined) throw new Error('growth: inet canonicalisation returned no row');
    const bindIpHmac = crypto.blindIndex(host, INVITE_REWARD_BIND_IP_CONTEXT);

    const inserted = await trx
      .withSchema('app')
      .insertInto('invite_rewards')
      .values({
        app_id: appId,
        invitee_id: input.invitee_id,
        inviter_id: input.inviter_id,
        amount_fen: amount,
        eligibility_days: days,
        qualified_at: input.at,
        bind_source: input.bind_source,
        bind_ip_hmac: bindIpHmac,
        status: 'qualified',
      })
      .onConflict((oc) => oc.columns(['app_id', 'invitee_id']).doNothing())
      .returning('invitee_id')
      .executeTakeFirst();
    // One qualification per invitee, ever: a replay changes nothing.
    if (inserted === undefined) return;

    const need = bothParties(amount);
    await ensureBudgetRow(trx, appId, TOTAL_PERIOD, input.at);
    // The shared total row is locked before the reservation (D10-102), and the reservation itself
    // is conditional on the available amount: concurrent qualifications never over-reserve.
    await lockTotal(trx, appId);
    const reserved = await trx
      .withSchema('app')
      .updateTable('invite_reward_budgets')
      .set({
        reserved_fen: sql<bigint>`${sql.ref('reserved_fen')} + ${need}`,
        row_version: sql<number>`${sql.ref('row_version')} + 1`,
        updated_at: input.at,
      })
      .where('app_id', '=', appId)
      .where('period', '=', TOTAL_PERIOD)
      .where(
        sql<bigint>`${sql.ref('reserved_fen')} + ${sql.ref('granted_fen')} + ${need}`,
        '<=',
        total,
      )
      .executeTakeFirst();
    if (reserved.numUpdatedRows !== 1n) {
      logger.info(fields, 'invite_reward_budget_insufficient');
      throw new SavepointRollback('growth: invite reward total budget insufficient');
    }
    logger.info(fields, 'invite_reward_qualified');
  }

  return {
    async qualifyInviteReward(trx, input) {
      // The admin channel never qualifies (BR-INV-24 ①).
      if (input.bind_source === 'admin') return;
      try {
        await underSavepoint(trx, QUALIFY_SAVEPOINT, () => qualify(trx, input));
      } catch (error) {
        if (error instanceof SavepointRollback) return;
        deps.logger.error(
          { app_id: input.app_id, invitee_id: input.invitee_id, error_class: errorClass(error) },
          'invite_reward_qualify_failed',
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// ② Available total budget (content's /v1/config port)
// ---------------------------------------------------------------------------------------------

export function createInviteRewardBudgetReader(deps: Pick<InviteRewardBaseDeps, 'db' | 'config'>): {
  available(appId: string): Promise<number | null>;
} {
  return {
    async available(appId) {
      return deps.db.transaction().execute(async (trx) => {
        const setting = integerSetting(
          await deps.config.configValue(appId, KEY_TOTAL, trx),
          0,
          0,
          Number.MAX_SAFE_INTEGER,
        );
        if (!setting.ok) return null;
        const row = await trx
          .withSchema('app')
          .selectFrom('invite_reward_budgets')
          .select(['reserved_fen', 'granted_fen'])
          .where('app_id', '=', appId)
          .where('period', '=', TOTAL_PERIOD)
          .executeTakeFirst();
        const used = row === undefined ? 0n : addFen(row.reserved_fen, row.granted_fen);
        const left = subFen(BigInt(setting.value), used);
        return left < 0n ? 0 : fenToJsonNumber(left);
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// ③ Trigger
// ---------------------------------------------------------------------------------------------

export interface InviteRewardTrigger {
  onCredited(trx: Transaction<DB>, input: { app_id: string; order_id: string }): Promise<void>;
}

const TRIGGER_SAVEPOINT = 'growth_invite_reward_trigger';

/** min_paid_fen: missing → 0; a malformed value → null (the order does not trigger). */
async function minPaid(
  deps: InviteRewardBaseDeps,
  trx: Transaction<DB>,
  appId: string,
  fields: Record<string, unknown>,
): Promise<bigint | null> {
  const setting = integerSetting(
    await deps.config.configValue(appId, KEY_MIN_PAID, trx),
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (!setting.ok) {
    deps.logger.warn({ ...fields, config_key: KEY_MIN_PAID }, 'invite_reward_config_invalid');
    return null;
  }
  return BigInt(setting.value);
}

/** BR-INV-24 ②: a CREDITED self-purchase with B > 0 and paid ≥ min_paid. */
function triggering(order: InviteRewardOrder, min: bigint): boolean {
  return (
    order.rebate_status === 'CREDITED' &&
    order.buy_type === 'self' &&
    order.base_fen !== null &&
    order.base_fen > 0n &&
    order.pay_amount_fen !== null &&
    order.pay_amount_fen >= min
  );
}

/** Records `order` as the trigger of the invitee's qualified row, when placed in its window. */
async function recordTrigger(
  trx: Transaction<DB>,
  order: InviteRewardOrder & { user_id: string },
  at: Date,
): Promise<boolean> {
  const result = await trx
    .withSchema('app')
    .updateTable('invite_rewards')
    .set({
      trigger_order_id: order.order_id,
      triggered_at: at,
      row_version: sql<number>`${sql.ref('row_version')} + 1`,
    })
    .where('app_id', '=', order.app_id)
    .where('invitee_id', '=', order.user_id)
    .where('status', '=', 'qualified')
    .where('trigger_order_id', 'is', null)
    .where('qualified_at', '<=', order.attr_at)
    .where(
      sql<Date>`${sql.ref('qualified_at')} + ${sql.ref('eligibility_days')} * interval '24 hours'`,
      '>',
      order.attr_at,
    )
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

export function createInviteRewardTrigger(
  deps: InviteRewardBaseDeps & { orders: InviteRewardOrderFacts },
): InviteRewardTrigger {
  async function trigger(trx: Transaction<DB>, input: { app_id: string; order_id: string }) {
    const order = await deps.orders.read(trx, input);
    if (order === null || order.app_id !== input.app_id || order.user_id === null) return;
    const owner = order.user_id;
    if (order.buy_type !== 'self' || order.base_fen === null || order.base_fen <= 0n) return;
    const fields = { app_id: input.app_id, invitee_id: owner };
    const min = await minPaid(deps, trx, input.app_id, fields);
    if (min === null || !triggering(order, min)) return;
    if (await recordTrigger(trx, { ...order, user_id: owner }, deps.clock.now())) {
      deps.logger.info(fields, 'invite_reward_triggered');
    }
  }
  return {
    async onCredited(trx, input) {
      try {
        await underSavepoint(trx, TRIGGER_SAVEPOINT, () => trigger(trx, input));
      } catch (error) {
        deps.logger.error(
          { app_id: input.app_id, error_class: errorClass(error) },
          'invite_reward_trigger_failed',
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// ④ Payout
// ---------------------------------------------------------------------------------------------

export interface InviteRewardLoginIps {
  read(
    trx: Transaction<DB>,
    input: { app_id: string; user_id: string; from: Date; to: Date },
  ): Promise<readonly string[]>;
}

export interface InviteRewardDeletedPhone {
  retained(
    trx: Transaction<DB>,
    input: { app_id: string; user_id: string; at: Date },
  ): Promise<boolean>;
}

export interface InviteRewardPayoutDeps extends InviteRewardBaseDeps {
  orders: InviteRewardOrderFacts;
  crypto: Pick<FieldCrypto, 'blindIndex'>;
  loginDevices: InviteBinderDeps['loginDevices'];
  loginIps: InviteRewardLoginIps;
  deletedPhone: InviteRewardDeletedPhone;
  /** The account-deletion stage (BR-INV-24 ③: cooling / processing / done → deleting); absent → none. */
  deletionStatus: {
    read(
      trx: Kysely<DB>,
      input: { app_id: string; user_ids: readonly string[] },
    ): Promise<ReadonlyMap<string, 'none' | 'cooling' | 'processing' | 'done'>>;
  };
  readRisk: InviteBinderDeps['readRisk'];
  verifiedBirthDate?: InviteBinderDeps['verifiedBirthDate'];
  multiAccount: SameDeviceAccountsCheck;
  grantWriter?: InviteRewardGrantWriter;
}

export type InviteRewardProcessResult =
  'ignored' | 'processed' | 'voided' | 'deferred_budget' | 'deferred_paused' | 'deferred_writer';

export interface InviteRewardPayout {
  process(appId: string, inviteeId: string): Promise<InviteRewardProcessResult>;
}

const RESTRICTED_RISK: ReadonlySet<string> = new Set(['banned', 'appealing', 'frozen']);

function resultOf(row: RewardRow, party: Party): string | null {
  return party === 'inviter' ? row.inviter_result : row.invitee_result;
}

function userOf(row: RewardRow, party: Party): string {
  return party === 'inviter' ? row.inviter_id : row.invitee_id;
}

/** Judging order step 1: qualified with a trigger order, or deferred. */
function awaitingPayout(row: RewardRow): boolean {
  return (row.status === 'qualified' && row.trigger_order_id !== null) || row.status === 'deferred';
}

/** Step 3 ⑥: no longer CREDITED, clawed back, or refunded after crediting. */
function clawedBack(order: InviteRewardOrder): boolean {
  if (order.rebate_status !== 'CREDITED') return true;
  return (order.refunded_quantity ?? 0) > (order.refunded_quantity_at_credit ?? 0);
}

/** The columns of one party's result (skipped with its reason, or granted with its voucher). */
function partyColumns(
  party: Party,
  outcome:
    | { readonly result: 'skipped'; readonly reason: SkipReason }
    | {
        readonly result: 'granted';
        readonly voucher: string;
      },
) {
  if (party === 'inviter') {
    return outcome.result === 'skipped'
      ? { inviter_result: 'skipped', inviter_skip_reason: outcome.reason }
      : { inviter_result: 'granted', inviter_voucher_id: outcome.voucher };
  }
  return outcome.result === 'skipped'
    ? { invitee_result: 'skipped', invitee_skip_reason: outcome.reason }
    : { invitee_result: 'granted', invitee_voucher_id: outcome.voucher };
}

export function createInviteRewardPayout(deps: InviteRewardPayoutDeps): InviteRewardPayout {
  const { logger } = deps;

  /** Writes the row's new status and columns under its status + row_version condition. */
  async function writeRow(
    trx: Transaction<DB>,
    row: RewardRow,
    event: InviteRewardEvent,
    columns: Record<string, unknown>,
  ): Promise<void> {
    const status = nextStatus(row.status, event);
    const result = await trx
      .withSchema('app')
      .updateTable('invite_rewards')
      .set({
        ...columns,
        status,
        row_version: sql<number>`${sql.ref('row_version')} + 1`,
      })
      .where('app_id', '=', row.app_id)
      .where('invitee_id', '=', row.invitee_id)
      .where('status', '=', row.status)
      .where('row_version', '=', row.row_version)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new Error('growth: invite reward row changed under its lock');
    }
  }

  function skipColumns(decided: ReadonlyMap<Party, SkipReason>): Record<string, unknown> {
    let columns: Record<string, unknown> = {};
    for (const [party, reason] of decided) {
      columns = { ...columns, ...partyColumns(party, { result: 'skipped', reason }) };
    }
    return columns;
  }

  /** Steps 2–3: void, releasing every still-reserved party. */
  async function voidRow(
    trx: Transaction<DB>,
    row: RewardRow,
    pending: readonly Party[],
    reason: VoidReason,
    at: Date,
  ): Promise<InviteRewardProcessResult> {
    const release = partiesAmount(row.amount_fen, pending.length);
    if (release > 0n) {
      await lockTotal(trx, row.app_id);
      await releaseReserved(trx, logger, row, release, at);
    }
    await writeRow(trx, row, 'VOID', { void_reason: reason });
    logger.info({ app_id: row.app_id, invitee_id: row.invitee_id, reason }, 'invite_reward_voided');
    return 'voided';
  }

  /** Step 6 deferral: new skips are recorded and released now; the rest stays reserved. */
  async function defer(
    trx: Transaction<DB>,
    row: RewardRow,
    decided: ReadonlyMap<Party, SkipReason>,
    kind: 'deferred_budget' | 'deferred_paused' | 'deferred_writer',
    at: Date,
    alreadyReleased = false,
  ): Promise<InviteRewardProcessResult> {
    const release = alreadyReleased ? 0n : partiesAmount(row.amount_fen, decided.size);
    if (release > 0n) {
      await lockTotal(trx, row.app_id);
      await releaseReserved(trx, logger, row, release, at);
    }
    if (row.status !== 'deferred' || decided.size > 0) {
      await writeRow(trx, row, 'DEFER', skipColumns(decided));
    }
    logger.info({ app_id: row.app_id, invitee_id: row.invitee_id, kind }, 'invite_reward_deferred');
    return kind;
  }

  /** Step 4: both parties are not paid. */
  async function bothSidesReason(
    trx: Transaction<DB>,
    row: RewardRow,
    at: Date,
  ): Promise<BothSkipReason | null> {
    const appId = row.app_id;
    const own = new Set(
      await deps.loginDevices.read(trx, { app_id: appId, user_id: row.invitee_id }),
    );
    const theirs = await deps.loginDevices.read(trx, { app_id: appId, user_id: row.inviter_id });
    if (theirs.some((hash) => own.has(hash))) return 'same_device';

    const window = integerSetting(
      await deps.config.configValue(appId, KEY_IP_WINDOW, trx),
      DEFAULT_IP_WINDOW_HOURS,
      1,
      MAX_AMOUNT,
    );
    if (!window.ok) {
      logger.warn(
        { app_id: appId, invitee_id: row.invitee_id, config_key: KEY_IP_WINDOW },
        'invite_reward_config_invalid',
      );
    }
    const hours = window.ok ? window.value : DEFAULT_IP_WINDOW_HOURS;
    // Anchored at the binding instant: a late payout never slides the window.
    const ips = await deps.loginIps.read(trx, {
      app_id: appId,
      user_id: row.inviter_id,
      from: shifted(row.qualified_at, -hours * HOUR_MS),
      to: row.qualified_at,
    });
    if (
      ips.some(
        (ip) => deps.crypto.blindIndex(ip, INVITE_REWARD_BIND_IP_CONTEXT) === row.bind_ip_hmac,
      )
    ) {
      return 'same_ip';
    }

    if (await deps.deletedPhone.retained(trx, { app_id: appId, user_id: row.invitee_id, at })) {
      return 'deleted_phone_retained';
    }
    return null;
  }

  /** Step 5: only this party is not paid (first reason in the ruling's order). */
  async function oneSideReason(
    trx: Transaction<DB>,
    row: RewardRow,
    party: Party,
    at: Date,
  ): Promise<OneSkipReason | null> {
    const subject = { app_id: row.app_id, user_id: userOf(row, party) };
    const deletion = await deps.deletionStatus.read(trx, {
      app_id: subject.app_id,
      user_ids: [subject.user_id],
    });
    const stage = deletion.get(subject.user_id) ?? 'none';
    // BR-INV-24 ③: in the deletion flow (cooling, processing or done) this party is not paid.
    if (stage === 'cooling' || stage === 'processing' || stage === 'done') return 'deleting';

    const risk = await deps.readRisk(trx, subject);
    if (RESTRICTED_RISK.has(risk.state)) return 'risk_restricted';

    const verifiedBirthDate = deps.verifiedBirthDate;
    const birthDate =
      verifiedBirthDate === undefined ? null : await verifiedBirthDate(trx, subject);
    if (birthDate !== null && !isAtLeastAge(birthDate, ADULT_AGE, at)) return 'minor';

    const judged = await deps.multiAccount.judge(trx, {
      app_id: subject.app_id,
      user_id: subject.user_id,
      ref: { type: 'invite_reward', id: row.invitee_id, party },
    });
    if (judged.marked) return 'multi_account';
    return null;
  }

  async function judge(trx: Transaction<DB>, appId: string, inviteeId: string) {
    const at = deps.clock.now();
    const head = await readInviter(trx, appId, inviteeId);
    if (head === undefined) return 'ignored';
    // Lock order users → invite_rewards → total → day (same users-first order as the funds lane).
    await lockUsers(trx, appId, [head.inviter_id, inviteeId]);
    const row = await lockReward(trx, appId, inviteeId);
    // 1. a qualified row with a trigger, or a deferred one.
    if (row === undefined || !awaitingPayout(row) || row.trigger_order_id === null) {
      return 'ignored';
    }
    const fields = { app_id: appId, invitee_id: inviteeId };
    const pending = PARTIES.filter((party) => resultOf(row, party) === null);

    // 2. the invitee's current parent is still the qualified inviter.
    const invitee = await trx
      .withSchema('app')
      .selectFrom('users')
      .select('parent_id')
      .where('app_id', '=', appId)
      .where('id', '=', inviteeId)
      .executeTakeFirst();
    if (invitee?.parent_id !== row.inviter_id) {
      return voidRow(trx, row, pending, 'relation_changed', at);
    }

    // 3. the trigger order is still CREDITED, not clawed back, not in rights.
    const order = await deps.orders.read(trx, { app_id: appId, order_id: row.trigger_order_id });
    if (order === null) throw new Error('growth: invite reward trigger order not found');
    if (clawedBack(order)) return voidRow(trx, row, pending, 'order_clawed_back', at);
    if (order.rights_pending || order.has_rights) {
      return voidRow(trx, row, pending, 'order_rights', at);
    }
    if (!placedInWindow(row, order.attr_at)) {
      // Defensive (attr_at never changes): not a trigger; the daily expiry judges the row.
      logger.warn(fields, 'invite_reward_trigger_outside_window');
      if (row.status === 'qualified') {
        const cleared = await trx
          .withSchema('app')
          .updateTable('invite_rewards')
          .set({
            trigger_order_id: null,
            triggered_at: null,
            row_version: sql<number>`${sql.ref('row_version')} + 1`,
          })
          .where('app_id', '=', appId)
          .where('invitee_id', '=', inviteeId)
          .where('status', '=', 'qualified')
          .where('row_version', '=', row.row_version)
          .executeTakeFirst();
        if (cleared.numUpdatedRows !== 1n) {
          throw new Error('growth: invite reward row changed under its lock');
        }
      }
      return 'ignored';
    }

    // 4. both parties' anti-abuse checks; 5. each party's own.
    const decided = new Map<Party, SkipReason>();
    if (pending.length > 0) {
      const both = await bothSidesReason(trx, row, at);
      for (const party of pending) {
        const reason = both ?? (await oneSideReason(trx, row, party, at));
        if (reason !== null) decided.set(party, reason);
      }
    }
    const toGrant = pending.filter((party) => !decided.has(party));

    // 6. budgets. Nothing left to pay: release the skipped parties and finish.
    if (toGrant.length === 0) {
      const release = partiesAmount(row.amount_fen, decided.size);
      if (release > 0n) {
        await lockTotal(trx, appId);
        await releaseReserved(trx, logger, row, release, at);
      }
      await writeRow(trx, row, 'PROCESS', skipColumns(decided));
      logger.info(fields, 'invite_reward_processed');
      return 'processed';
    }
    const writer = deps.grantWriter;
    if (writer === undefined) {
      // An assembly without ledger's writer: defer, never pay without a voucher.
      logger.warn(fields, 'invite_reward_writer_unavailable');
      return defer(trx, row, decided, 'deferred_writer', at);
    }
    const paused = await deps.config.configValue(appId, KEY_PAUSED, trx);
    if (paused !== null && paused.value !== false) {
      if (paused.value !== true) {
        logger.warn({ ...fields, config_key: KEY_PAUSED }, 'invite_reward_config_invalid');
      }
      return defer(trx, row, decided, 'deferred_paused', at);
    }
    // Missing daily budget = 0 (BR-INV-24 默认): nothing can be paid today.
    const daily = integerSetting(
      await deps.config.configValue(appId, KEY_DAILY, trx),
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (!daily.ok) {
      logger.warn({ ...fields, config_key: KEY_DAILY }, 'invite_reward_config_invalid');
      return defer(trx, row, decided, 'deferred_budget', at);
    }

    await lockTotal(trx, appId);
    await releaseReserved(trx, logger, row, partiesAmount(row.amount_fen, decided.size), at);
    const pay = partiesAmount(row.amount_fen, toGrant.length);
    const day = accountingDate(at);
    await ensureBudgetRow(trx, appId, day, at);
    const counted = await trx
      .withSchema('app')
      .updateTable('invite_reward_budgets')
      .set({
        granted_fen: sql<bigint>`${sql.ref('granted_fen')} + ${pay}`,
        row_version: sql<number>`${sql.ref('row_version')} + 1`,
        updated_at: at,
      })
      .where('app_id', '=', appId)
      .where('period', '=', day)
      .where(sql<bigint>`${sql.ref('granted_fen')} + ${pay}`, '<=', BigInt(daily.value))
      .executeTakeFirst();
    if (counted.numUpdatedRows !== 1n) {
      // The day's budget is short: retried from step 1 after 00:00 +08:00 (by trigger order).
      // The skipped parties' release above stays (it is part of this transaction).
      return defer(trx, row, decided, 'deferred_budget', at, true);
    }
    const moved = await trx
      .withSchema('app')
      .updateTable('invite_reward_budgets')
      .set({
        reserved_fen: sql<bigint>`${sql.ref('reserved_fen')} - ${pay}`,
        granted_fen: sql<bigint>`${sql.ref('granted_fen')} + ${pay}`,
        row_version: sql<number>`${sql.ref('row_version')} + 1`,
        updated_at: at,
      })
      .where('app_id', '=', appId)
      .where('period', '=', TOTAL_PERIOD)
      .where('reserved_fen', '>=', pay)
      .executeTakeFirst();
    if (moved.numUpdatedRows !== 1n) {
      logger.error(fields, 'invite_reward_release_underflow');
      throw new BudgetUnderflow('growth: invite reward reservation smaller than its payout');
    }

    // 7. one REWARD voucher per paid party, then the results.
    let columns = skipColumns(decided);
    for (const party of toGrant) {
      const { voucher_id } = await writer.grant(trx, {
        app_id: appId,
        invitee_id: inviteeId,
        party,
        user_id: userOf(row, party),
        amount_fen: row.amount_fen,
        at,
      });
      columns = { ...columns, ...partyColumns(party, { result: 'granted', voucher: voucher_id }) };
    }
    await writeRow(trx, row, 'PROCESS', { ...columns, granted_at: at });
    logger.info({ ...fields, granted: toGrant.length }, 'invite_reward_processed');
    return 'processed';
  }

  return {
    async process(appId, inviteeId) {
      // Read at call time: callers may rebind db (tests trace its queries).
      return deps.db
        .transaction()
        .execute(async (trx): Promise<InviteRewardProcessResult> => judge(trx, appId, inviteeId));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// ⑤ Daily expiry
// ---------------------------------------------------------------------------------------------

export interface InviteRewardExpiry {
  expireIfDue(appId: string, inviteeId: string): Promise<void>;
}

/** Rebate statuses with a result: every other status still waits for one. */
const SETTLED_REBATE: ReadonlySet<string> = new Set(['CREDITED', 'VOID', 'CLAWED_BACK']);

export function createInviteRewardExpiry(
  deps: InviteRewardBaseDeps & { orders: InviteRewardOrderFacts },
): InviteRewardExpiry {
  const { logger } = deps;

  async function expire(trx: Transaction<DB>, appId: string, inviteeId: string) {
    const at = deps.clock.now();
    const head = await readInviter(trx, appId, inviteeId);
    if (head === undefined) return;
    await lockUsers(trx, appId, [head.inviter_id, inviteeId]);
    const row = await lockReward(trx, appId, inviteeId);
    // A recorded trigger (qualified or deferred) waits for the payout, never expires (B1-35a r2).
    if (row === undefined || row.status !== 'qualified' || row.trigger_order_id !== null) return;
    const end = validityEnd(row);
    if (end.getTime() > at.getTime()) return;
    const fields = { app_id: appId, invitee_id: inviteeId };

    const orders = (
      await deps.orders.listSelfOrdersInWindow(trx, {
        app_id: appId,
        user_id: inviteeId,
        from: row.qualified_at,
        to: end,
      })
    ).filter(
      (order) =>
        order.app_id === appId &&
        order.user_id === inviteeId &&
        order.buy_type === 'self' &&
        placedInWindow(row, order.attr_at),
    );
    const min = await minPaid(deps, trx, appId, fields);
    // A malformed min_paid_fen cannot tell a triggering order: judge again on a later day.
    if (min === null) return;
    const late = orders
      .filter((order) => triggering(order, min) && !clawedBack(order))
      .sort(
        (a, b) =>
          (a.credited_at?.getTime() ?? 0) - (b.credited_at?.getTime() ?? 0) ||
          a.attr_at.getTime() - b.attr_at.getTime(),
      )[0];
    if (late !== undefined) {
      // A CREDITED eligible order placed in the window that never triggered: trigger it now, so
      // the payout scan pays it; the reservation stays.
      await recordTrigger(trx, { ...late, user_id: inviteeId }, at);
      logger.warn(fields, 'invite_reward_late_trigger');
      return;
    }
    if (orders.some((order) => !SETTLED_REBATE.has(order.rebate_status))) return;

    // Nothing in the window can trigger any more: expire and release both parties' reservation.
    await lockTotal(trx, appId);
    await releaseReserved(trx, logger, row, bothParties(row.amount_fen), at);
    const status = nextStatus(row.status, 'EXPIRE');
    const result = await trx
      .withSchema('app')
      .updateTable('invite_rewards')
      .set({ status, row_version: sql<number>`${sql.ref('row_version')} + 1` })
      .where('app_id', '=', appId)
      .where('invitee_id', '=', inviteeId)
      .where('status', '=', row.status)
      .where('row_version', '=', row.row_version)
      .where('trigger_order_id', 'is', null)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new Error('growth: invite reward row changed under its lock');
    }
    logger.info(fields, 'invite_reward_expired');
  }

  return {
    async expireIfDue(appId, inviteeId) {
      await deps.db.transaction().execute((trx) => expire(trx, appId, inviteeId));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Scanner and worker loop
// ---------------------------------------------------------------------------------------------

/** worker calls tick every 60 seconds; expiry runs on the first tick and each accounting day. */
export interface InviteRewardScanner {
  tick(): Promise<void>;
}

const SCAN_PAGE = 200;

/** Nest token of the worker's scanner (app.module provides it; entry.ts starts the loop). */
const INVITE_REWARD_SCANNER = Symbol('GROWTH_INVITE_REWARD_SCANNER');
export function inviteRewardScannerToken(): symbol {
  return INVITE_REWARD_SCANNER;
}

export function createInviteRewardScanner(
  deps: Pick<InviteRewardBaseDeps, 'db' | 'clock' | 'logger'> & {
    payout: InviteRewardPayout;
    expiry: InviteRewardExpiry;
  },
): InviteRewardScanner {
  const { logger } = deps;
  let expiredDay: string | null = null;

  /** Due qualified rows without a trigger, by qualified_at (keyset pages). */
  async function expiryPass(at: Date): Promise<void> {
    let after: { qualified_at: Date; app_id: string; invitee_id: string } | null = null;
    for (;;) {
      let query = deps.db
        .withSchema('app')
        .selectFrom('invite_rewards')
        .select(['qualified_at', 'app_id', 'invitee_id'])
        .where('status', '=', 'qualified')
        .where('trigger_order_id', 'is', null)
        .where(
          sql<Date>`${sql.ref('qualified_at')} + ${sql.ref('eligibility_days')} * interval '24 hours'`,
          '<=',
          at,
        );
      if (after !== null) {
        const last = after;
        query = query.where(
          sql<boolean>`(${sql.ref('qualified_at')}, ${sql.ref('app_id')}, ${sql.ref('invitee_id')}) > (${last.qualified_at}::timestamptz, ${last.app_id}::text, ${last.invitee_id}::uuid)`,
        );
      }
      const page = await query
        .orderBy('qualified_at')
        .orderBy('app_id')
        .orderBy('invitee_id')
        .limit(SCAN_PAGE)
        .execute();
      for (const row of page) {
        try {
          await deps.expiry.expireIfDue(row.app_id, row.invitee_id);
        } catch (error) {
          logger.error(
            { app_id: row.app_id, invitee_id: row.invitee_id, error_class: errorClass(error) },
            'invite_reward_expiry_failed',
          );
        }
      }
      if (page.length < SCAN_PAGE) return;
      after = page[page.length - 1] ?? null;
    }
  }

  /** Triggered qualified and deferred rows, by trigger time; a short day's budget ends its app. */
  async function payoutPass(): Promise<void> {
    const exhausted = new Set<string>();
    let after: { triggered_at: Date; app_id: string; invitee_id: string } | null = null;
    for (;;) {
      let query = deps.db
        .withSchema('app')
        .selectFrom('invite_rewards')
        .select(['triggered_at', 'app_id', 'invitee_id'])
        .where('triggered_at', 'is not', null)
        .where((eb) =>
          eb.or([
            eb.and([eb('status', '=', 'qualified'), eb('trigger_order_id', 'is not', null)]),
            eb('status', '=', 'deferred'),
          ]),
        );
      if (after !== null) {
        const last = after;
        query = query.where(
          sql<boolean>`(${sql.ref('triggered_at')}, ${sql.ref('app_id')}, ${sql.ref('invitee_id')}) > (${last.triggered_at}::timestamptz, ${last.app_id}::text, ${last.invitee_id}::uuid)`,
        );
      }
      const page = await query
        .orderBy('triggered_at')
        .orderBy('app_id')
        .orderBy('invitee_id')
        .limit(SCAN_PAGE)
        .execute();
      for (const row of page) {
        if (exhausted.has(row.app_id)) continue;
        try {
          const result = await deps.payout.process(row.app_id, row.invitee_id);
          // Later rows of this app wait for the next day (BR-INV-24 ④: by trigger order).
          if (result === 'deferred_budget') exhausted.add(row.app_id);
        } catch (error) {
          logger.error(
            { app_id: row.app_id, invitee_id: row.invitee_id, error_class: errorClass(error) },
            'invite_reward_payout_failed',
          );
        }
      }
      if (page.length < SCAN_PAGE) return;
      const last = page[page.length - 1];
      if (last === undefined || last.triggered_at === null) return;
      after = { triggered_at: last.triggered_at, app_id: last.app_id, invitee_id: last.invitee_id };
    }
  }

  return {
    async tick() {
      const at = deps.clock.now();
      const day = accountingDate(at);
      if (expiredDay !== day) {
        // Mark the day only after a whole successful pass: a failed page query is retried
        // on the next tick of the same accounting day, and this round still pays out.
        try {
          await expiryPass(at);
          expiredDay = day;
        } catch (error) {
          logger.error({ error_class: errorClass(error) }, 'invite_reward_expiry_scan_failed');
        }
      }
      await payoutPass();
    },
  };
}

/** The scan interval (§9.2 第 9 条): every 60 seconds after the previous round finished. */
export const INVITE_REWARD_SCAN_INTERVAL_MS = 60_000;

export function startInviteRewardWorker(deps: {
  scanner: InviteRewardScanner;
  logger: RootLogger;
}): { stop(): Promise<void> } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;

  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      running = (async () => {
        try {
          await deps.scanner.tick();
        } catch (error) {
          deps.logger.error({ error_class: errorClass(error) }, 'invite_reward_scan_failed');
        }
      })().finally(() => {
        running = undefined;
        schedule(INVITE_REWARD_SCAN_INTERVAL_MS);
      });
    }, delay);
  };
  // The first round right away; the next ones never overlap a round in flight.
  schedule(0);
  return {
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await running;
    },
  };
}
