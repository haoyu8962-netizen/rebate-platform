// B2-02p: the execution step of the daily ledger check (BR-FUND-19 R3; BR-WDR-05). It takes the
// differences of one run (each with the invariant file it came from) and acts on them, per app:
// - every difference is registered as a ledger_mismatch recon diff (source R3, period = the
//   checked accounting day D) through registerReconDiffOnce; ref_type ledger_account (account
//   level), voucher (②) or order (③④⑤⑧⑨, order_key); ref_id `<invariant>:<entity id>`;
//   dedupe_key `R3:<D>:<invariant>:<entity id>`; expected / actual / diff from the detail's paired
//   amounts (diff = expected − actual), else 0 / 0 / 0; the detail kept in resolution;
// - B2-17 (⑭, task §16.2 / D10-3237 (二)): the diff is registered with involved_user_ids = the
//   involved users of the group (the ones held below), and for a sub-order group (ref_type order)
//   also every beneficiary of that sub-order (BR-FUND-24 细则「按子订单登记的差异为该子订单的全部
//   受益人」); lower case, unique, ascending; NULL when there is none. The holds are unchanged;
// - for a non pay- difference, in the same transaction and only when that call inserted the diff,
//   one withdraw_holds row per involved user through the injected payout port (reason
//   ledger_mismatch, source_ref `recon_diff:<id>`, created_by system); a difference whose users
//   cannot be resolved is registered and logged, never held on a guess;
// - an app with any non pay- global difference (⑧ excepted: account level by BR-FUND-19) gets
//   settle.auto.enabled switched off once through the injected content port, in its own
//   transaction and before the diffs (the safe direction first); the alert only after the commit.
// Each switch and each diff (with its holds) commits on its own; a failing one is rolled back
// whole and logged, the rest still run, and the run then throws DAILY_CHECK_FAILED. A rerun of
// the same day is idempotent (diffs by their unique keys, holds only with a first insert).
// pay- differences (collections, D10-358 ②) are only registered. Ports are declared here and
// injected by the assembly (ledger never imports payout or content; B2-09b precedent).
import type { DB } from '@couli/db';
import { chinaDayRange } from '@couli/domain';
import { InvalidAmount, parseFen, subFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, JobPayload } from '../../platform/index.ts';
import {
  orderBeneficiaries,
  userAccountOwners,
  voucherUserOwners,
} from '../infra/daily-check-execute-store.ts';
import type { DailyCheckLogger } from './daily-check.ts';
import type { DailyCheckFiledDifference, LedgerDifference } from './daily-check-types.ts';
import { LedgerError } from './errors.ts';
import { registerReconDiffOnce } from './recon-diffs.ts';

/** One withdrawal hold of a ledger mismatch (same shape as payout's AddWithdrawHold). */
export interface LedgerMismatchHoldInput {
  readonly appId: string;
  readonly userId: string;
  readonly reason: 'ledger_mismatch';
  /** Exactly `recon_diff:<recon_diffs.id>` (released by the close of that diff, B2-09b). */
  readonly sourceRef: string;
  readonly createdBy: 'system';
  readonly holdUntil: null;
}

/** The payout port: adds one withdraw_holds row on the caller's transaction. */
export interface LedgerMismatchHolds {
  add(trx: Transaction<DB>, input: LedgerMismatchHoldInput): Promise<{ readonly id: string }>;
}

/** Same shape as content's SystemSwitchInput (F1-02zk). */
export interface AutoSettlementSwitchInput {
  readonly appId: string;
  readonly key: 'settle.auto.enabled';
  readonly source: string;
  readonly reason: string;
}

/** Same shape as content's SystemSwitchResult (F1-02zk). */
export interface AutoSettlementSwitchResult {
  readonly key: 'settle.auto.enabled';
  readonly changed: boolean;
  readonly version: number;
  readonly fromValue: unknown;
}

/** The content port (shape of SystemSwitchWriter): switch off in a transaction, alert after it. */
export interface AutoSettlementSwitch {
  turnOff(
    trx: Transaction<DB>,
    input: AutoSettlementSwitchInput,
  ): Promise<AutoSettlementSwitchResult>;
  /** Called only after the transaction of turnOff committed. */
  alertCommitted(input: AutoSettlementSwitchInput, result: AutoSettlementSwitchResult): void;
}

export interface DailyCheckExecuteDependencies {
  readonly clock: Clock;
  readonly logger: DailyCheckLogger;
  readonly holds: LedgerMismatchHolds;
  readonly autoSettlement: AutoSettlementSwitch;
}

// One reported difference and the invariant file it came from (shared with the runner).
export type { DailyCheckFiledDifference } from './daily-check-types.ts';

export interface DailyCheckExecutionInput {
  /** The checked accounting day D (YYYY-MM-DD), the period of every diff. */
  readonly accountingDate: string;
  readonly differences: readonly DailyCheckFiledDifference[];
}

/** One registered recon diff of the run. */
export interface DailyCheckExecutedDiff {
  readonly appId: string;
  readonly reconDiffId: string;
  readonly invariant: string;
  readonly refType: string;
  readonly refId: string;
  /** true only when this run inserted the diff (a rerun of the same day sees false). */
  readonly inserted: boolean;
  /** Users a hold was added for by this run (empty on a rerun, for pay- and unresolved). */
  readonly heldUserIds: readonly string[];
}

export interface DailyCheckExecution {
  readonly accountingDate: string;
  readonly reconDiffs: readonly DailyCheckExecutedDiff[];
  /** Apps whose settle.auto.enabled was switched off by this run (turnOff called). */
  readonly autoSettlementOff: readonly string[];
}

export interface DailyCheckExecutor {
  execute(db: Kysely<DB>, input: DailyCheckExecutionInput): Promise<DailyCheckExecution>;
}

/** content's source of this writer (snake case, at most 32 characters). */
const SWITCH_SOURCE = 'ledger_daily_check';
/** content's reason limit, counted in code points. */
const SWITCH_REASON_MAX = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CONTROL = /\p{Cc}/gu;
/** ⑧ is account level whatever the scope of its row (BR-FUND-19: 账户级差异（①⑥⑦⑧）). */
const INVALID_STILL_CREDITED = '08';
/** ⑤: an order-level difference; every beneficiary of the sub-order is involved. */
const UNION_RECEIVABLE = '05';

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** One recon diff to register: every difference of the run with the same (app, invariant, entity). */
interface DiffGroup {
  readonly appId: string;
  readonly invariant: string;
  readonly refType: string;
  readonly refId: string;
  readonly rows: DailyCheckFiledDifference[];
}

/** pay- files (collections, D10-358 ②): decided by the file's basename, never the code. */
function isPayFile(file: string): boolean {
  const base = file.slice(file.lastIndexOf('/') + 1);
  return base.startsWith('pay-');
}

function detailOf(difference: LedgerDifference): Record<string, unknown> {
  const detail = difference.detail;
  return typeof detail === 'object' && detail !== null && !Array.isArray(detail)
    ? (detail as Record<string, unknown>)
    : {};
}

function textField(detail: Record<string, unknown>, key: string): string | undefined {
  const value = detail[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The entity a difference is registered on: ref_type and the id after `<invariant>:`. */
function entityOf(difference: DailyCheckFiledDifference): { refType: string; id: string } {
  const detail = detailOf(difference);
  const orderKey = textField(detail, 'order_key');
  if (difference.invariant === INVALID_STILL_CREDITED && orderKey !== undefined) {
    return { refType: 'order', id: orderKey };
  }
  if (difference.scope === 'account' && difference.account_id !== null) {
    return { refType: 'ledger_account', id: difference.account_id };
  }
  if (orderKey !== undefined) return { refType: 'order', id: orderKey };
  const voucherId = textField(detail, 'voucher_id');
  if (voucherId !== undefined) return { refType: 'voucher', id: voucherId };
  const payOrderId = textField(detail, 'pay_order_id');
  if (payOrderId !== undefined) return { refType: 'pay_order', id: payOrderId };
  const payRefundId = textField(detail, 'pay_refund_id');
  if (payRefundId !== undefined) return { refType: 'pay_refund', id: payRefundId };
  // A whole-app difference (e.g. pay-04 suspense): one diff per app and day.
  return { refType: 'app', id: difference.app_id };
}

/** Whether this difference switches settle.auto.enabled off for its app. */
function switchesOff(difference: DailyCheckFiledDifference): boolean {
  return (
    difference.scope === 'global' &&
    !isPayFile(difference.file) &&
    difference.invariant !== INVALID_STILL_CREDITED
  );
}

/**
 * The paired amounts of a detail: `expected_<x>_fen` with `actual_<x>_fen` (or `<x>_fen`), both
 * integer fen; anything else is 0 / 0 / 0. diff = expected − actual (contract AdminReconDiff).
 */
function amountsOf(detail: Record<string, unknown>): {
  expectedFen: bigint;
  actualFen: bigint;
  diffFen: bigint;
} {
  for (const key of Object.keys(detail).sort()) {
    const match = /^expected_(.+_fen)$/u.exec(key);
    if (match === null) continue;
    const name = match[1]!;
    const actualKey = `actual_${name}` in detail ? `actual_${name}` : name;
    if (!(actualKey in detail)) continue;
    try {
      const expectedFen = parseFen(detail[key]);
      const actualFen = parseFen(detail[actualKey]);
      return { expectedFen, actualFen, diffFen: subFen(expectedFen, actualFen) };
    } catch (error) {
      if (error instanceof InvalidAmount) continue;
      throw error;
    }
  }
  return { expectedFen: 0n, actualFen: 0n, diffFen: 0n };
}

/** A JSON-safe copy (bigint as decimal text; anything else non-JSON as text). */
function toJson(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => toJson(item));
  if (typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined) out[key] = toJson(item);
    }
    return out;
  }
  return String(value);
}

function resolutionOf(accountingDate: string, group: DiffGroup): JobPayload {
  const resolution = {
    source: 'ledger_daily_check',
    accounting_date: accountingDate,
    invariant: group.invariant,
    files: [...new Set(group.rows.map((row) => row.file))],
    differences: group.rows.map((row) => ({
      scope: row.scope,
      account_id: row.account_id,
      detail: toJson(row.detail),
    })),
  };
  return toJson(resolution) as JobPayload;
}

function textList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** Users named by a detail (as the invariant SQL emits them). */
function detailUsers(detail: Record<string, unknown>): string[] {
  const users = [
    ...textList(detail['user_id']),
    ...textList(detail['beneficiary_user_id']),
    ...textList(detail['beneficiary_user_ids']),
    ...textList(detail['unlocated_user_ids']),
  ];
  const items = detail['pending_items'];
  if (Array.isArray(items)) {
    for (const item of items) {
      if (typeof item === 'object' && item !== null) {
        users.push(...textList((item as Record<string, unknown>)['user_id']));
      }
    }
  }
  return users;
}

/** The involved users of a group, sorted and unique; only well-formed user ids are kept. */
async function involvedUsers(trx: Transaction<DB>, group: DiffGroup): Promise<string[]> {
  const candidates: string[] = [];
  const accountIds: string[] = [];
  const voucherIds: string[] = [];
  for (const row of group.rows) {
    const detail = detailOf(row);
    if (row.scope === 'account' && row.account_id !== null) accountIds.push(row.account_id);
    candidates.push(...detailUsers(detail));
    const voucherId = textField(detail, 'voucher_id');
    if (group.refType === 'voucher' && voucherId !== undefined) voucherIds.push(voucherId);
  }
  const wellFormed = (ids: readonly string[]) => [...new Set(ids.filter((id) => UUID.test(id)))];
  candidates.push(...(await userAccountOwners(trx, group.appId, wellFormed(accountIds))));
  candidates.push(...(await voucherUserOwners(trx, group.appId, wellFormed(voucherIds))));
  if (group.refType === 'order' && group.invariant === UNION_RECEIVABLE) {
    const keys = group.refId.slice(group.invariant.length + 1);
    candidates.push(...(await orderBeneficiaries(trx, group.appId, [keys])));
  }
  return userList(candidates);
}

/** Lower case, unique, ascending; only well-formed user ids are kept. */
function userList(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => UUID.test(id)).map((id) => id.toLowerCase()))].sort();
}

/**
 * B2-17 (task §16.2, D10-3237 (二)): the involved_user_ids registered with the diff. For a
 * sub-order group it is `held` ∪ every beneficiary on the sub-order's vouchers; for any other
 * group it is `held` itself. `held` (involvedUsers) stays the list of users the holds are added for.
 */
async function registeredUsers(
  trx: Transaction<DB>,
  group: DiffGroup,
  held: readonly string[],
): Promise<string[]> {
  if (group.refType !== 'order') return [...held];
  const orderKey = group.refId.slice(group.invariant.length + 1);
  const beneficiaries = await orderBeneficiaries(trx, group.appId, [orderKey]);
  return userList([...held, ...beneficiaries]);
}

function validateInput(input: DailyCheckExecutionInput): void {
  if (typeof input !== 'object' || input === null) {
    throw new LedgerError('INVALID_INPUT', 'execution input must be an object');
  }
  try {
    chinaDayRange(input.accountingDate);
  } catch (error) {
    throw new LedgerError('INVALID_INPUT', 'accountingDate must be an existing YYYY-MM-DD', {
      cause: error,
    });
  }
  if (!Array.isArray(input.differences)) {
    throw new LedgerError('INVALID_INPUT', 'differences must be an array');
  }
  for (const difference of input.differences as readonly unknown[]) {
    const d = difference as Partial<DailyCheckFiledDifference> | null;
    if (
      typeof d !== 'object' ||
      d === null ||
      typeof d.file !== 'string' ||
      d.file === '' ||
      typeof d.invariant !== 'string' ||
      d.invariant === '' ||
      (d.scope !== 'account' && d.scope !== 'global') ||
      typeof d.app_id !== 'string' ||
      d.app_id === '' ||
      (d.account_id !== null && (typeof d.account_id !== 'string' || d.account_id === '')) ||
      (d.scope === 'account' && d.account_id === null)
    ) {
      throw new LedgerError('INVALID_INPUT', 'malformed daily check difference');
    }
  }
}

/** Groups by (app, invariant, entity), in the order first seen. */
function groupDifferences(differences: readonly DailyCheckFiledDifference[]): DiffGroup[] {
  const groups = new Map<string, DiffGroup>();
  for (const difference of differences) {
    const entity = entityOf(difference);
    const refId = `${difference.invariant}:${entity.id}`;
    const key = JSON.stringify([difference.app_id, entity.refType, refId]);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        appId: difference.app_id,
        invariant: difference.invariant,
        refType: entity.refType,
        refId,
        rows: [],
      };
      groups.set(key, group);
    }
    group.rows.push(difference);
  }
  return [...groups.values()];
}

function switchReason(accountingDate: string, invariants: readonly string[]): string {
  const codes = invariants.map((code) => code.replace(CONTROL, ' ')).join(', ');
  const reason = `ledger daily check ${accountingDate}: global differences ${codes}`;
  return [...reason].slice(0, SWITCH_REASON_MAX).join('');
}

/** The SQLSTATE of a PostgreSQL error (for the log line); undefined for anything else. */
function sqlState(error: unknown): string | undefined {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code) ? code : undefined;
}

export function createDailyCheckExecutor(
  dependencies: DailyCheckExecuteDependencies,
): DailyCheckExecutor {
  const { clock, logger, holds, autoSettlement } = dependencies;

  /** One recon diff and its holds in one transaction; holds only when this call inserted it. */
  async function registerGroup(
    db: Kysely<DB>,
    accountingDate: string,
    group: DiffGroup,
  ): Promise<DailyCheckExecutedDiff> {
    const first = group.rows[0]!;
    const holdable = group.rows.some((row) => !isPayFile(row.file));
    const outcome = await db.transaction().execute(async (trx) => {
      // B2-17 (⑭, D10-2417; §16.2): the list goes into the INSERT (couli_app has no UPDATE on
      // involved_user_ids); NULL when empty. Only `users` (involvedUsers) is held below; a
      // sub-order group's list also names the sub-order's other beneficiaries.
      const users = await involvedUsers(trx, group);
      const listed = await registeredUsers(trx, group, users);
      const registration = await registerReconDiffOnce(
        trx,
        {
          appId: group.appId,
          type: 'ledger_mismatch',
          source: 'R3',
          period: accountingDate,
          refType: group.refType,
          refId: group.refId,
          ...amountsOf(detailOf(first)),
          dedupeKey: `R3:${accountingDate}:${group.refId}`,
          resolution: resolutionOf(accountingDate, group),
          involvedUserIds: listed.length === 0 ? null : listed,
        },
        { clock },
      );
      const held: string[] = [];
      let unresolved = false;
      if (registration.inserted && holdable) {
        unresolved = users.length === 0;
        for (const userId of users) {
          await holds.add(trx, {
            appId: group.appId,
            userId,
            reason: 'ledger_mismatch',
            sourceRef: `recon_diff:${registration.row.id}`,
            createdBy: 'system',
            holdUntil: null,
          });
          held.push(userId);
        }
      }
      return { registration, held, unresolved };
    });
    const { registration, held, unresolved } = outcome;
    const fields = {
      accounting_date: accountingDate,
      invariant: group.invariant,
      scope: first.scope,
      app_id: group.appId,
      ref_type: group.refType,
      recon_diff_id: registration.row.id,
    };
    logger.warn(
      {
        ...fields,
        event: 'ledger_daily_check_recon_diff',
        inserted: registration.inserted,
        held_users: held.length,
      },
      'ledger daily check recon diff registered',
    );
    if (unresolved) {
      logger.warn(
        { ...fields, event: 'ledger_daily_check_hold_unresolved' },
        'ledger daily check difference names no user to hold',
      );
    }
    return {
      appId: group.appId,
      reconDiffId: registration.row.id,
      invariant: group.invariant,
      refType: group.refType,
      refId: group.refId,
      inserted: registration.inserted,
      heldUserIds: held,
    };
  }

  /** Switches settle.auto.enabled off in its own transaction; alerts only after the commit. */
  async function switchOff(
    db: Kysely<DB>,
    accountingDate: string,
    appId: string,
    invariants: readonly string[],
  ): Promise<void> {
    const input: AutoSettlementSwitchInput = {
      appId,
      key: 'settle.auto.enabled',
      source: SWITCH_SOURCE,
      reason: switchReason(accountingDate, invariants),
    };
    const result = await db.transaction().execute((trx) => autoSettlement.turnOff(trx, input));
    logger.warn(
      {
        event: 'ledger_daily_check_auto_settlement_off',
        accounting_date: accountingDate,
        app_id: appId,
        invariants: invariants.join(','),
        changed: result.changed,
      },
      'ledger daily check switched automatic settlement off',
    );
    try {
      autoSettlement.alertCommitted(input, result);
    } catch (error) {
      // The switch is committed; a failed alert is logged, never undoes it.
      logger.error(
        {
          event: 'ledger_daily_check_execute_failed',
          step: 'alert',
          accounting_date: accountingDate,
          app_id: appId,
        },
        'ledger daily check switch alert failed',
      );
      void error;
    }
  }

  return {
    async execute(db, input) {
      validateInput(input);
      const { accountingDate, differences } = input;
      const failures: unknown[] = [];

      // 1. Switch first (the safe direction), per app with a non pay- global difference.
      const switchApps = new Map<string, string[]>();
      for (const difference of differences) {
        if (!switchesOff(difference)) continue;
        const codes = switchApps.get(difference.app_id) ?? [];
        if (!codes.includes(difference.invariant)) codes.push(difference.invariant);
        switchApps.set(difference.app_id, codes);
      }
      const autoSettlementOff: string[] = [];
      for (const [appId, codes] of [...switchApps].sort(([a], [b]) => (a < b ? -1 : 1))) {
        try {
          await switchOff(db, accountingDate, appId, [...codes].sort());
          autoSettlementOff.push(appId);
        } catch (error) {
          failures.push(error);
          logger.error(
            {
              event: 'ledger_daily_check_execute_failed',
              step: 'auto_settlement',
              accounting_date: accountingDate,
              app_id: appId,
              sqlstate: sqlState(error),
            },
            'ledger daily check could not switch automatic settlement off',
          );
        }
      }

      // 2. One recon diff (with its holds) per (app, invariant, entity), each in its own
      // transaction: a failure rolls that diff back whole and the others still go through.
      const reconDiffs: DailyCheckExecutedDiff[] = [];
      for (const group of groupDifferences(differences)) {
        try {
          reconDiffs.push(await registerGroup(db, accountingDate, group));
        } catch (error) {
          failures.push(error);
          logger.error(
            {
              event: 'ledger_daily_check_execute_failed',
              step: 'recon_diff',
              accounting_date: accountingDate,
              invariant: group.invariant,
              app_id: group.appId,
              ref_type: group.refType,
              sqlstate: sqlState(error),
            },
            'ledger daily check could not register a difference',
          );
        }
      }

      if (failures.length > 0) {
        throw new LedgerError(
          'DAILY_CHECK_FAILED',
          `daily check execution of ${accountingDate}: ${failures.length} step(s) failed`,
          { cause: failures.length === 1 ? failures[0] : new AggregateError(failures) },
        );
      }
      return { accountingDate, reconDiffs, autoSettlementOff };
    },
  };
}
