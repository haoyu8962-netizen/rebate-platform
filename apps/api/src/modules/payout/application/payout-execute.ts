// B2-06c: the EXECUTE command (规划/08 BR-WDR-12, BR-WDR-11, BR-WDR-18, BR-WDR-05; state machine W4).
// executeBatch(trx, input) groups the members into a new batch (kind=manual for an admin,
// kind=auto for 'system:auto_payout', one withdrawal) and executes it on the caller's transaction:
//   ① batch level, refusing the whole batch: payout.enabled on, payout.queue_paused off
//      → { kind: 'rejected', reason: 'payout_disabled' | 'queue_paused' }.
//   ② per withdrawal, under FOR UPDATE: still APPROVED (else skipped / not_approved); no withdrawal
//      block of the member (BR-WDR-05: risk state frozen / banned / appealing over either, an
//      effective withdraw hold, available_fen < 0, blocked_reason set → blocked / member_blocked);
//      no kind=transfer attempt of any result (blocked / has_transfer_attempt); the snapshot
//      channel enabled and not paused (payout.channel_enabled.<channel> on,
//      payout.channel_paused.<channel> off; else blocked / channel_disabled).
//   ③ the watermark of the executable set, per channel (domain/watermark.ts); any channel failing
//      → { kind: 'rejected', reason, channel }.
// A rejection moves no withdrawal, writes no item, enqueues nothing. Otherwise each executable
// withdrawal: CAS APPROVED → PAYING through transitionWithdrawal(…, 'EXECUTE') with execute_seq + 1,
// executor_id (null for the system), batch_id, executed_at = now, row_version + 1 (0 rows →
// skipped / not_approved, no throw); an item 'paying'; JobQueue.send('payout', 'transfer',
// { withdrawal_id, execute_seq, app_id }, { trx, singletonKey: `${withdrawal_id}:${execute_seq}` });
// wallet.withdrawal_changed. A manual member already on another batch is moved first by a CAS on
// (status = APPROVED, batch_id = the old batch), the old batch getting an item 'moved_out'.
//
// Locks, in the module's fixed order: the members' balance rows (ledger.lockBalances: the
// BR-WDR-05 (a) guard reads available_fen under the same lock a clawback holds) → the withdrawal
// rows FOR UPDATE (a second admin grouping the same withdrawal waits here and then finds PAYING).
// No users row lock: EXECUTE changes no balance and no hold.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { transitionWithdrawal, type WithdrawalState } from '@couli/domain';
import { addFen } from '@couli/money';
import { sql, type Transaction } from 'kysely';
import type { Ledger } from '../../ledger/index.ts';
import type { EventBus, JobQueue } from '../../platform/index.ts';
import type { AppealPrevStateReader, RiskStateBatchReader } from '../../risk/index.ts';
import { judgeWatermark, type WatermarkRejectReason } from '../domain/watermark.ts';
import {
  createPayoutAttemptsStore,
  type PayoutAttemptsStore,
} from '../infra/payout-attempts-store.ts';
import {
  createPayoutBatchesStore,
  type NewPayoutBatchItem,
  type PayoutBatchesStore,
} from '../infra/payout-batches-store.ts';
import {
  createWatermarkReader,
  lockWatermarkChannel,
  type PayoutChannelName,
  type WatermarkReader,
} from './watermark.ts';
import type { PayoutConfigPort } from './withdraw-rules.ts';

/** The executor of an automatic batch (BR-WDR-30): no admin, executor_id stays null. */
export type SystemAutoPayoutExecutor = 'system:auto_payout';

/** Why a member stays where it is (payout_batch_items.reason, the admin list's result column). */
export type PayoutLeftReason =
  | 'not_approved'
  | 'member_blocked'
  | 'has_transfer_attempt'
  | 'channel_disabled'
  | WatermarkRejectReason;

export type PayoutBatchRejectReason = 'payout_disabled' | 'queue_paused' | WatermarkRejectReason;

export interface ExecuteBatchInput {
  appId: string;
  /** The ticked withdrawals; exactly one for an automatic batch. */
  members: readonly string[];
  /** The admin's id (kind=manual), or 'system:auto_payout' (kind=auto). */
  executorId: string;
  /** The caller's Clock instant; every time written or compared comes from it. */
  now: Date;
}

export type ExecuteBatchResult =
  | {
      kind: 'executed';
      batchId: string;
      paying: string[];
      left: { id: string; reason: PayoutLeftReason }[];
    }
  | {
      kind: 'rejected';
      reason: PayoutBatchRejectReason;
      /** The failing channel of a watermark rejection. */
      channel?: PayoutChannelName;
    };

export interface PayoutExecuteOptions {
  /** content's configuration reader (payout.* switches and payout.watermark_usable_bp). */
  config: PayoutConfigPort;
  risk: RiskStateBatchReader;
  appeal: AppealPrevStateReader;
  ledger: Pick<Ledger, 'getBalances' | 'lockBalances'>;
  queue: JobQueue;
  eventBus: EventBus;
  logger: { warn(fields: Record<string, unknown>, message: string): void };
  /** Module-internal stores and readers (defaults: the real ones; tests may swap them). */
  batches?: PayoutBatchesStore;
  attempts?: PayoutAttemptsStore;
  watermark?: WatermarkReader;
}

export interface PayoutExecute {
  executeBatch(trx: Transaction<DB>, input: ExecuteBatchInput): Promise<ExecuteBatchResult>;
}

export const SYSTEM_AUTO_PAYOUT: SystemAutoPayoutExecutor = 'system:auto_payout';

/** Configuration keys of BR-WDR-12 ①② and BR-WDR-18 ③ (content's switch and config registries). */
export const PAYOUT_EXECUTE_CONFIG_KEYS = {
  enabled: 'payout.enabled',
  queuePaused: 'payout.queue_paused',
  channelEnabled: (channel: PayoutChannelName) => `payout.channel_enabled.${channel}`,
  channelPaused: (channel: PayoutChannelName) => `payout.channel_paused.${channel}`,
  watermarkUsableBp: 'payout.watermark_usable_bp',
} as const;

/**
 * Code defaults when a key is absent or unreadable (content's switch registry: payout.enabled on,
 * queue_paused off, channel_paused off; BR-WDR-32 / 33: only the Alipay channel is on by default;
 * BR-WDR-18: watermark_usable_bp 9000).
 */
export const PAYOUT_EXECUTE_DEFAULTS = {
  enabled: true,
  queuePaused: false,
  channelEnabled: { alipay: true, bank_card: false, wechat: false } as const,
  channelPaused: false,
  watermarkUsableBp: 9000,
} as const;

const CHANNELS: ReadonlySet<string> = new Set(['alipay', 'bank_card', 'wechat']);
const PAYING: WithdrawalState = 'PAYING';
const APPROVED: WithdrawalState = 'APPROVED';

interface MemberRow {
  readonly id: string;
  readonly user_id: string;
  readonly status: string;
  readonly net_fen: bigint;
  readonly payout_channel: string;
  readonly batch_id: string | null;
  readonly blocked_reason: string | null;
}

export type PayoutSettingParsed<T> = { ok: true; value: T } | { ok: false };

/** A switch as content's registry stores it. */
export function parsePayoutSwitch(value: unknown): PayoutSettingParsed<boolean> {
  if (typeof value === 'boolean') return { ok: true, value };
  if (value === 'on' || value === 'true') return { ok: true, value: true };
  if (value === 'off' || value === 'false') return { ok: true, value: false };
  return { ok: false };
}

/** Basis points, 0 to 10000. */
export function parsePayoutBp(value: unknown): PayoutSettingParsed<number> {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000
    ? { ok: true, value }
    : { ok: false };
}

/** A configuration value parsed with `parse`; absent or invalid → the code default (warned). */
export async function readPayoutSetting<T>(
  ports: Pick<PayoutExecuteOptions, 'config' | 'logger'>,
  trx: Transaction<DB>,
  appId: string,
  key: string,
  parse: (value: unknown) => PayoutSettingParsed<T>,
  fallback: T,
): Promise<T> {
  const row = await ports.config.configValue(appId, key, trx);
  if (row === null) return fallback;
  const parsed = parse(row.value);
  if (parsed.ok) return parsed.value;
  ports.logger.warn({ app_id: appId, config_key: key }, 'payout_config_default');
  return fallback;
}

function isChannel(value: string): value is PayoutChannelName {
  return CHANNELS.has(value);
}

export function createPayoutExecute(options: PayoutExecuteOptions): PayoutExecute {
  const { config, risk, appeal, ledger, queue, eventBus, logger } = options;
  const batches = options.batches ?? createPayoutBatchesStore();
  const attempts = options.attempts ?? createPayoutAttemptsStore();
  const watermark = options.watermark ?? createWatermarkReader();

  function setting<T>(
    trx: Transaction<DB>,
    appId: string,
    key: string,
    parse: (value: unknown) => PayoutSettingParsed<T>,
    fallback: T,
  ): Promise<T> {
    return readPayoutSetting({ config, logger }, trx, appId, key, parse, fallback);
  }

  async function readMembers(
    trx: Transaction<DB>,
    appId: string,
    ids: readonly string[],
    lock: boolean,
  ): Promise<Map<string, MemberRow>> {
    if (ids.length === 0) return new Map();
    let query = trx
      .withSchema('app')
      .selectFrom('withdrawals')
      .select([
        'id',
        'user_id',
        'status',
        'net_fen',
        'payout_channel',
        'batch_id',
        'blocked_reason',
      ])
      .where('app_id', '=', appId)
      .where('id', 'in', [...ids]);
    if (lock) query = query.forUpdate();
    const rows = await query.execute();
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** BR-WDR-05: the member's withdrawal block, judged on the caller's instant. */
  async function memberBlocked(
    trx: Transaction<DB>,
    appId: string,
    userId: string,
    now: Date,
    riskRows: ReadonlyMap<string, { state: string; frozen_until: Date | null }>,
    available: ReadonlyMap<string, bigint>,
  ): Promise<boolean> {
    const state = riskRows.get(userId) ?? { state: 'normal', frozen_until: null };
    // A freeze with an expiry is over the moment the clock reaches it (B1-02zf: judged here).
    const expired =
      state.state === 'frozen' &&
      state.frozen_until !== null &&
      state.frozen_until.getTime() <= now.getTime();
    if (!expired && (state.state === 'frozen' || state.state === 'banned')) return true;
    if (state.state === 'appealing') {
      const prev = await appeal.read(trx, { appId, userId });
      if (prev === 'frozen' || prev === 'banned') return true;
    }
    if ((available.get(userId) ?? 0n) < 0n) return true;
    const hold = await trx
      .withSchema('app')
      .selectFrom('withdraw_holds')
      .select('id')
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .where('released_at', 'is', null)
      .where((eb) => eb.or([eb('hold_until', 'is', null), eb('hold_until', '>', now)]))
      .limit(1)
      .executeTakeFirst();
    return hold !== undefined;
  }

  async function executeBatch(
    trx: Transaction<DB>,
    input: ExecuteBatchInput,
  ): Promise<ExecuteBatchResult> {
    const { appId, now } = input;
    const members = [...new Set(input.members)];
    const kind = input.executorId === SYSTEM_AUTO_PAYOUT ? 'auto' : 'manual';
    const executorId = kind === 'auto' ? null : input.executorId;

    // ① batch level.
    const enabled = await setting(
      trx,
      appId,
      PAYOUT_EXECUTE_CONFIG_KEYS.enabled,
      parsePayoutSwitch,
      PAYOUT_EXECUTE_DEFAULTS.enabled,
    );
    if (!enabled) return { kind: 'rejected', reason: 'payout_disabled' };
    const paused = await setting(
      trx,
      appId,
      PAYOUT_EXECUTE_CONFIG_KEYS.queuePaused,
      parsePayoutSwitch,
      PAYOUT_EXECUTE_DEFAULTS.queuePaused,
    );
    if (paused) return { kind: 'rejected', reason: 'queue_paused' };

    // Owners first (the user of a withdrawal never changes), then the locks in the fixed order.
    const preview = await readMembers(trx, appId, members, false);
    const owners = [...new Set([...preview.values()].map((row) => row.user_id))];
    const available = new Map<string, bigint>();
    if (owners.length > 0) {
      for (const balance of await ledger.lockBalances(trx, { appId, userIds: owners })) {
        available.set(balance.user_id, balance.available_fen);
      }
    }
    const rows = await readMembers(trx, appId, members, true);
    const riskRows =
      owners.length > 0 ? await risk.read(trx, { appId, userIds: owners }) : new Map();

    // ② per withdrawal.
    const channelOn = new Map<PayoutChannelName, boolean>();
    async function channelEnabled(channel: PayoutChannelName): Promise<boolean> {
      const known = channelOn.get(channel);
      if (known !== undefined) return known;
      const on = await setting(
        trx,
        appId,
        PAYOUT_EXECUTE_CONFIG_KEYS.channelEnabled(channel),
        parsePayoutSwitch,
        PAYOUT_EXECUTE_DEFAULTS.channelEnabled[channel],
      );
      const stopped = await setting(
        trx,
        appId,
        PAYOUT_EXECUTE_CONFIG_KEYS.channelPaused(channel),
        parsePayoutSwitch,
        PAYOUT_EXECUTE_DEFAULTS.channelPaused,
      );
      const value = on && !stopped;
      channelOn.set(channel, value);
      return value;
    }
    const executable: MemberRow[] = [];
    const left: { row: MemberRow | null; id: string; reason: PayoutLeftReason; move: boolean }[] =
      [];
    for (const id of members) {
      const row = rows.get(id);
      if (row === undefined) {
        left.push({ row: null, id, reason: 'not_approved', move: false });
        continue;
      }
      const transition = transitionWithdrawal(row.status as WithdrawalState, 'EXECUTE');
      if (!transition.ok || transition.noop || transition.to !== PAYING) {
        left.push({ row, id, reason: 'not_approved', move: false });
        continue;
      }
      if (
        row.blocked_reason !== null ||
        (await memberBlocked(trx, appId, row.user_id, now, riskRows, available))
      ) {
        left.push({ row, id, reason: 'member_blocked', move: true });
        continue;
      }
      if (await attempts.hasTransfer(trx, { appId, withdrawalId: id })) {
        left.push({ row, id, reason: 'has_transfer_attempt', move: true });
        continue;
      }
      if (!isChannel(row.payout_channel) || !(await channelEnabled(row.payout_channel))) {
        left.push({ row, id, reason: 'channel_disabled', move: true });
        continue;
      }
      executable.push(row);
    }

    // ③ the watermark of the executable set, per channel (W and P both per channel, D10-285 /
    // D10-288 Q2), before any write. One channel in the set: a failure refuses the whole batch.
    // Several channels (D10-288 Q3 / D10-290): a failing channel only keeps its own withdrawals
    // where they are (left / item blocked with the watermark reason, not moved, no job).
    const perChannel = new Map<PayoutChannelName, bigint>();
    for (const row of executable) {
      const channel = row.payout_channel as PayoutChannelName;
      perChannel.set(channel, addFen(perChannel.get(channel) ?? 0n, row.net_fen));
    }
    const failing = new Map<PayoutChannelName, WatermarkRejectReason>();
    if (perChannel.size > 0) {
      const usableBp = await setting(
        trx,
        appId,
        PAYOUT_EXECUTE_CONFIG_KEYS.watermarkUsableBp,
        parsePayoutBp,
        PAYOUT_EXECUTE_DEFAULTS.watermarkUsableBp,
      );
      // One EXECUTE per (app, channel) at a time: the Σ PAYING of ③ must see every concurrent
      // EXECUTE's PAYING rows, which READ COMMITTED alone would miss (write skew). Channels in a
      // fixed order so two batches never wait on each other crosswise.
      const channels = [...perChannel.keys()].sort();
      for (const channel of channels) {
        await lockWatermarkChannel(trx, appId, channel);
      }
      for (const channel of channels) {
        const batchNetFen = perChannel.get(channel) ?? 0n;
        const reading = await watermark.latest(trx, { appId, channel });
        const forecastFen = await watermark.forecast(trx, { appId, channel, now });
        const committed =
          reading === null
            ? { payingNetFen: 0n, paidSinceNetFen: 0n }
            : await watermark.committed(trx, { appId, channel, since: reading.measuredAt });
        const verdict = judgeWatermark({
          now,
          reading,
          forecastFen,
          batchNetFen,
          payingNetFen: committed.payingNetFen,
          paidSinceNetFen: committed.paidSinceNetFen,
          usableBp,
        });
        if (verdict.ok) continue;
        if (perChannel.size === 1) return { kind: 'rejected', reason: verdict.reason, channel };
        failing.set(channel, verdict.reason);
      }
    }
    const toExecute: MemberRow[] = [];
    for (const row of executable) {
      const reason = failing.get(row.payout_channel as PayoutChannelName);
      if (reason === undefined) toExecute.push(row);
      else left.push({ row, id: row.id, reason, move: false });
    }

    // Writes: the batch, the moves, the transitions, the items, the jobs, the events.
    const batchId = randomUUID();
    await batches.insertBatch(trx, {
      id: batchId,
      appId,
      kind,
      createdBy: executorId,
      createdAt: now,
    });
    const items: NewPayoutBatchItem[] = [];
    const movedOut = (row: MemberRow): void => {
      if (row.batch_id !== null && row.batch_id !== batchId) {
        items.push({
          appId,
          batchId: row.batch_id,
          withdrawalId: row.id,
          result: 'moved_out',
          reason: null,
          movedToBatchId: batchId,
          at: now,
        });
      }
    };
    const paying: string[] = [];
    const leftOut: { id: string; reason: PayoutLeftReason }[] = [];
    for (const entry of left) {
      leftOut.push({ id: entry.id, reason: entry.reason });
      if (entry.row === null) continue;
      if (
        entry.move &&
        entry.row.status === APPROVED &&
        entry.row.batch_id !== null &&
        entry.row.batch_id !== batchId
      ) {
        // Still APPROVED but on another batch: moved to this batch by a CAS on the old one.
        const moved = await trx
          .withSchema('app')
          .updateTable('withdrawals')
          .set({ batch_id: batchId, row_version: sql`row_version + 1`, updated_at: now })
          .where('app_id', '=', appId)
          .where('id', '=', entry.id)
          .where('status', '=', APPROVED)
          .where('batch_id', '=', entry.row.batch_id)
          .executeTakeFirst();
        if (moved.numUpdatedRows === 1n) movedOut(entry.row);
      }
      items.push({
        appId,
        batchId,
        withdrawalId: entry.id,
        result: entry.reason === 'not_approved' ? 'skipped' : 'blocked',
        reason: entry.reason,
        movedToBatchId: null,
        at: now,
      });
    }
    for (const row of toExecute) {
      const updated = await trx
        .withSchema('app')
        .updateTable('withdrawals')
        .set({
          status: PAYING,
          execute_seq: sql`execute_seq + 1`,
          executor_id: executorId,
          batch_id: batchId,
          executed_at: now,
          row_version: sql`row_version + 1`,
          updated_at: now,
        })
        .where('app_id', '=', appId)
        .where('id', '=', row.id)
        .where('status', '=', APPROVED)
        .returning(['execute_seq'])
        .executeTakeFirst();
      if (updated === undefined) {
        leftOut.push({ id: row.id, reason: 'not_approved' });
        items.push({
          appId,
          batchId,
          withdrawalId: row.id,
          result: 'skipped',
          reason: 'not_approved',
          movedToBatchId: null,
          at: now,
        });
        continue;
      }
      movedOut(row);
      paying.push(row.id);
      items.push({
        appId,
        batchId,
        withdrawalId: row.id,
        result: 'paying',
        reason: null,
        movedToBatchId: null,
        at: now,
      });
      await queue.send(
        'payout',
        'transfer',
        { withdrawal_id: row.id, execute_seq: updated.execute_seq, app_id: appId },
        { trx, singletonKey: `${row.id}:${updated.execute_seq}` },
      );
      await eventBus.publish(trx, {
        appId,
        name: 'wallet.withdrawal_changed',
        payload: { withdrawal_id: row.id, user_id: row.user_id, status: PAYING },
      });
    }
    await batches.insertItems(trx, items);
    return { kind: 'executed', batchId, paying, left: leftOut };
  }

  return { executeBatch };
}
