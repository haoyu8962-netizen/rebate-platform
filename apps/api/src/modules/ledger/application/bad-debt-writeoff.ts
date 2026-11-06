// B2-12f: 08 BR-FUND-12 负余额坏账核销 (with BR-FUND-10, BR-FUND-16): the daily generation of the
// write-off candidates on the worker entry, and the admin console's contracts/openapi.yaml
// adminListBadDebtWriteoffs (GET /admin/v1/bad-debt-writeoffs, fund.writeoff or fund.view, read
// only) and adminApproveBadDebtWriteoff (POST /admin/v1/bad-debt-writeoffs/{id}/approve,
// fund.writeoff, step-up sms, Idempotency-Key); specs/state-machines/bad-debt-writeoff.yaml (BD1–BD3,
// only through the generated transitionBadDebtWriteoff) and the BAD_DEBT_WRITEOFF template of
// specs/ledger-templates.csv. B2-12g: the linked accounts' risk marks (risk's writer, a port).
//
// - Generation runs on the worker entry only, through LedgerBadDebtWriteoffModule.forWorker
//   (../bad-debt-writeoff.module.ts), which app.module calls once: a timer whose first tick is at
//   most 15 s after bootstrap and then at most every 60 s (no overlap; stopped on destroy).
// - Every tick lists the apps with ledger accounts; for each app, once the daily ledger check (R3)
//   of the day before the Clock's +08:00 accounting day D is recorded done (app.processed_events,
//   consumer ledger.daily_check_done, event_id dailyCheckDoneEventId(app, D − 1)), it generates the
//   candidates of D: account_balances with available_fen < 0, D − negative_since ≥
//   ledger.bad_debt_days (no row: 90) and |available_fen| ≥ ledger.bad_debt_min_fen (no row: 0),
//   no PENDING candidate of the account, the member not deleting or deleted. That scan is only a
//   prefilter: each account then gets its own transaction that locks the users row and then the
//   balance row (ledger.lockBalances) and reads the deletion stage, available and negative_since
//   again under those locks; only a balance still due by them gets a candidate. A candidate is
//   PENDING with candidate_fen = −available_fen, the balance's negative_since (both as locked),
//   initiator_id null and created_at the Clock's now; nothing else is written (the partial unique
//   index on PENDING rows makes a concurrent second insert a no-op). One account's failure does
//   not stop the others.
// - Approval: one transaction under platform idempotency, users row then balance row locked
//   (BR-WDR-07 order), then the candidate FOR UPDATE; the candidate and the balance are read again
//   under the locks; the amount is −available at that moment. negative_since and payout's
//   NEGATIVE_BALANCE block are cleared by the ledger's own recovery path of the posting.
// - B2-12g (BR-FUND-12, trace only): when, and only when, the approval writes the
//   BAD_DEBT_WRITEOFF voucher, risk's linked-accounts marker runs on the same transaction, before
//   the audit row (a failure of either rolls the whole approval back). A CANCELLED candidate and
//   the frozen refusal mark nothing.
// Ledger imports neither identity, content nor risk: their parts arrive as ports from app.module.
import type { DB } from '@couli/db';
import {
  accountingDate,
  buildVouchers,
  chinaDayRange,
  transitionBadDebtWriteoff,
  type BadDebtWriteoffEvent,
} from '@couli/domain';
import { addFen, fenToJsonNumber, subFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import {
  fieldsErrorEnvelope,
  newUuidV7,
  type AuditPort,
  type Clock,
  type HandlerResult,
  type Idempotency,
  type IdempotentResponse,
  type RootLogger,
} from '../../platform/index.ts';
import {
  appsWithUserAccounts,
  approveBadDebtWriteoffRow,
  cancelBadDebtWriteoff,
  countBadDebtWriteoffs,
  findBadDebtWriteoff,
  hasProcessedEvent,
  insertPendingWriteoff,
  lockBadDebtWriteoffStatus,
  negativeBalancesDue,
  pageBadDebtWriteoffs,
  type BadDebtWriteoffRow,
  type NegativeBalanceRow,
} from '../infra/bad-debt-writeoffs-store.ts';
import { DAILY_CHECK_DONE_CONSUMER, dailyCheckDoneEventId } from './daily-check-schedule-done.ts';
import { dailyCheckDayOf } from './daily-check-schedule.ts';
import type { AccountBalance, PostingEntry } from './ledger.ts';
import type { Ledger } from './reverse.ts';

/** bad_debt_writeoffs.status (contracts/enums/fund.yaml bad_debt_writeoff_status). */
export type BadDebtWriteoffStatus = 'PENDING' | 'APPROVED' | 'CANCELLED';

/** ledger.bad_debt_days and ledger.bad_debt_min_fen of one app (no row: 90 and 0). */
export interface BadDebtThresholds {
  readonly days: number;
  readonly minFen: bigint;
}

/** What app.module hands in (identity's and content's parts). */
export interface BadDebtWriteoffPorts {
  /** content: the app's thresholds; a missing row is its default (90 days, 0 fen). */
  readonly thresholds: (db: Kysely<DB>, clock: Clock, appId: string) => Promise<BadDebtThresholds>;
  /** content: ledger.bad_debt_require_no_frozen.enabled, read at approval; a missing row is on. */
  readonly requireNoFrozen: (db: Kysely<DB>, clock: Clock, appId: string) => Promise<boolean>;
  /** identity: of `userIds`, the members whose deletion has started (deleting) or ended (deleted). */
  readonly closingUsers: (
    db: Kysely<DB>,
    input: { readonly appId: string; readonly userIds: readonly string[] },
  ) => Promise<ReadonlySet<string>>;
  /** identity: the users rows FOR UPDATE, before the balance rows (BR-WDR-07). */
  readonly lockUsersForUpdate: (
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly userIds: readonly string[] },
  ) => Promise<unknown>;
  /**
   * risk (B2-12g): marks the accounts linked to the written-off member, on the approving
   * transaction; a replay inserts nothing new.
   */
  readonly markLinkedAccounts: (
    trx: Transaction<DB>,
    clock: Clock,
    input: {
      readonly appId: string;
      readonly sourceUserId: string;
      readonly sourceRef: string;
    },
  ) => Promise<void>;
}

export interface BadDebtCandidateTickDependencies {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly ports: BadDebtWriteoffPorts;
  /** The ledger's balance locks (the generation posts nothing). */
  readonly ledger: Pick<Ledger, 'lockBalances'>;
  readonly isStopped: () => boolean;
}

export interface BadDebtCandidateTickResult {
  /** Candidates written by this tick, all apps together. */
  readonly generated: number;
}

/** The state the generated machine allows for `event` from `from`; anything else is a bug. */
function nextStatus(
  from: BadDebtWriteoffStatus | null,
  event: BadDebtWriteoffEvent,
): BadDebtWriteoffStatus {
  const result = transitionBadDebtWriteoff(from, event);
  if (!result.ok) {
    throw new Error(`ledger: bad debt write-off ${String(from)} --${event}--> is not allowed`);
  }
  return result.to;
}

/**
 * BD1 eligibility of a balance read under its lock: available below 0, D − negative_since at least
 * ledger.bad_debt_days and |available| at least ledger.bad_debt_min_fen.
 */
function dueForCandidate(
  balance: AccountBalance,
  thresholds: BadDebtThresholds,
  day: string,
): balance is AccountBalance & { readonly negative_since: string } {
  if (balance.available_fen >= 0n || balance.negative_since === null) return false;
  if (balance.available_fen > subFen(0n, thresholds.minFen)) return false;
  return daysFrom(balance.negative_since, day) >= thresholds.days;
}

/**
 * One account's candidate in its own transaction: the users row, then the balance row
 * (BR-WDR-07 order, as the deletion flow and every posting take them), then the deletion stage,
 * available and negative_since are read again under those locks and the eligibility is decided
 * on them; the prefilter's snapshot only chose the account. True when a candidate was written.
 */
async function generateForAccount(
  deps: BadDebtCandidateTickDependencies,
  input: {
    readonly appId: string;
    readonly row: NegativeBalanceRow;
    readonly thresholds: BadDebtThresholds;
    readonly day: string;
    readonly now: Date;
    readonly status: BadDebtWriteoffStatus;
  },
): Promise<boolean> {
  const { appId, row } = input;
  return deps.db.transaction().execute(async (trx) => {
    await deps.ports.lockUsersForUpdate(trx, { appId, userIds: [row.user_id] });
    const balance = (await deps.ledger.lockBalances(trx, { appId, userIds: [row.user_id] })).find(
      (locked) => locked.account_id === row.account_id,
    );
    if (balance === undefined) return false;
    const closing = await deps.ports.closingUsers(trx, { appId, userIds: [row.user_id] });
    if (closing.has(row.user_id)) return false;
    if (!dueForCandidate(balance, input.thresholds, input.day)) return false;
    return insertPendingWriteoff(trx, {
      id: newUuidV7(input.now),
      appId,
      accountId: balance.account_id,
      negativeSince: balance.negative_since,
      candidateFen: subFen(0n, balance.available_fen),
      status: input.status,
      at: input.now,
    });
  });
}

/**
 * The candidates of D for one app (D − 1's R3 already done). The scan and the deletion stages
 * read before any lock are a prefilter only; each account is decided again under its locks.
 */
async function generateForApp(
  deps: BadDebtCandidateTickDependencies,
  appId: string,
  day: string,
  now: Date,
): Promise<number> {
  const thresholds = await deps.ports.thresholds(deps.db, deps.clock, appId);
  const due = await negativeBalancesDue(deps.db, {
    appId,
    day,
    days: thresholds.days,
    availableAtMost: subFen(0n, thresholds.minFen),
  });
  if (due.length === 0) return 0;
  const closing = await deps.ports.closingUsers(deps.db, {
    appId,
    userIds: due.map((row) => row.user_id),
  });
  const status = nextStatus(null, 'GENERATE');
  let generated = 0;
  for (const row of due) {
    if (deps.isStopped()) break;
    if (closing.has(row.user_id)) continue;
    try {
      if (await generateForAccount(deps, { appId, row, thresholds, day, now, status })) {
        generated += 1;
      }
    } catch (error: unknown) {
      // One account's failure leaves the others' candidates; the next tick retries it.
      deps.logger.warn(
        {
          app_id: appId,
          account_id: row.account_id,
          accounting_date: day,
          error_name: error instanceof Error ? error.name : typeof error,
        },
        'ledger_bad_debt_candidate_failed',
      );
    }
  }
  return generated;
}

/** One tick of the generation over every app (see the conventions above). */
export async function tickBadDebtWriteoffCandidates(
  deps: BadDebtCandidateTickDependencies,
): Promise<BadDebtCandidateTickResult> {
  const now = deps.clock.now();
  const day = accountingDate(now);
  const checked = dailyCheckDayOf(now);
  let generated = 0;
  for (const appId of await appsWithUserAccounts(deps.db)) {
    if (deps.isStopped()) break;
    const ready = await hasProcessedEvent(
      deps.db,
      DAILY_CHECK_DONE_CONSUMER,
      dailyCheckDoneEventId(appId, checked),
    );
    if (!ready) continue;
    try {
      const count = await generateForApp(deps, appId, day, now);
      generated += count;
      if (count > 0) {
        deps.logger.info(
          { app_id: appId, accounting_date: day, generated: count },
          'ledger_bad_debt_candidates_generated',
        );
      }
    } catch (error: unknown) {
      // One app's failure leaves the others' candidates to be generated; the next tick retries.
      deps.logger.warn(
        {
          app_id: appId,
          accounting_date: day,
          error_name: error instanceof Error ? error.name : typeof error,
        },
        'ledger_bad_debt_candidates_failed',
      );
    }
  }
  return { generated };
}

/** One row of the list and of the approval's answer (AdminBadDebtWriteoff). */
export interface AdminBadDebtWriteoffView {
  readonly id: string;
  readonly account_id: string;
  readonly user_id: string;
  readonly negative_since: string;
  readonly negative_days: number;
  readonly candidate_fen: number;
  readonly available_fen: number;
  readonly frozen_fen: number;
  readonly status: BadDebtWriteoffStatus;
  readonly approve_blocked: boolean;
  readonly initiator_id: string | null;
  readonly approver_id: string | null;
  readonly approved_at: string | null;
  readonly voucher_id: string | null;
  readonly created_at: string;
}

export interface AdminBadDebtWriteoffPageView {
  readonly items: readonly AdminBadDebtWriteoffView[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
}

export interface AdminBadDebtWriteoffListQuery {
  readonly appId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly status: BadDebtWriteoffStatus | null;
  readonly userId: string | null;
}

export interface AdminBadDebtWriteoffReadDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly ports: BadDebtWriteoffPorts;
}

/** A read refusal: 20001 with data.fields (thrown for the controller's error envelope). */
export class AdminBadDebtWriteoffFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`bad debt write-off refused: ${fields.join(',')}`);
    this.name = 'AdminBadDebtWriteoffFieldsError';
    this.fields = fields;
  }
}

/** The audit action of the contract (adminApproveBadDebtWriteoff). */
export const BAD_DEBT_WRITEOFF_APPROVE_ACTION = 'bad_debt_writeoff_approve';
export const BAD_DEBT_WRITEOFFS_PATH = '/admin/v1/bad-debt-writeoffs';
const BIZ_TYPE = 'bad_debt_writeoff';
const TEMPLATE = 'BAD_DEBT_WRITEOFF';
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MS_PER_DAY = 86_400_000;
/** BR-TEXT-14 fallback text of 20902 (contracts/texts.default.json error.20902). */
const CONFLICT_MESSAGE = '状态已变化，请刷新后重试';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whole +08:00 accounting days from `since` to `day` (both YYYY-MM-DD; midnights of +08:00). */
function daysFrom(since: string, day: string): number {
  const from = Date.parse(chinaDayRange(since).start);
  const to = Date.parse(chinaDayRange(day).start);
  return Math.round((to - from) / MS_PER_DAY);
}

function viewOf(
  row: BadDebtWriteoffRow,
  input: {
    readonly day: string;
    readonly available: bigint;
    readonly frozen: bigint;
    readonly blocked: boolean;
  },
): AdminBadDebtWriteoffView {
  return {
    id: row.id,
    account_id: row.account_id,
    user_id: row.user_id,
    negative_since: row.negative_since,
    negative_days: daysFrom(row.negative_since, input.day),
    candidate_fen: fenToJsonNumber(row.candidate_fen),
    available_fen: fenToJsonNumber(input.available),
    frozen_fen: fenToJsonNumber(input.frozen),
    status: row.status as BadDebtWriteoffStatus,
    approve_blocked: input.blocked,
    initiator_id: row.initiator_id,
    approver_id: row.approver_id,
    approved_at: row.approved_at === null ? null : row.approved_at.toISOString(),
    voucher_id: row.voucher_id,
    created_at: row.created_at.toISOString(),
  };
}

/** GET /admin/v1/bad-debt-writeoffs: created_at then id descending; nothing written. */
export async function listAdminBadDebtWriteoffs(
  deps: AdminBadDebtWriteoffReadDeps,
  query: AdminBadDebtWriteoffListQuery,
): Promise<AdminBadDebtWriteoffPageView> {
  if (query.userId !== null && !UUID.test(query.userId)) {
    throw new AdminBadDebtWriteoffFieldsError(['user_id']);
  }
  const filter = {
    appId: query.appId,
    status: query.status,
    userId: query.userId === null ? null : query.userId.toLowerCase(),
  };
  const total = await countBadDebtWriteoffs(deps.db, filter);
  const offset = (query.page - 1) * query.pageSize;
  const rows =
    offset >= total ? [] : await pageBadDebtWriteoffs(deps.db, filter, offset, query.pageSize);
  const day = accountingDate(deps.clock.now());
  const anyFrozenPending = rows.some((row) => row.status === 'PENDING' && row.frozen_fen > 0n);
  const requireNoFrozen = anyFrozenPending
    ? await deps.ports.requireNoFrozen(deps.db, deps.clock, query.appId)
    : false;
  return {
    items: rows.map((row) =>
      viewOf(row, {
        day,
        available: row.available_fen,
        frozen: row.frozen_fen,
        blocked: row.status === 'PENDING' && row.frozen_fen > 0n && requireNoFrozen,
      }),
    ),
    page: query.page,
    page_size: query.pageSize,
    total,
  };
}

/** The schema-checked query of GET /admin/v1/bad-debt-writeoffs. */
export function listQueryOf(
  appId: string,
  raw: {
    readonly page?: number;
    readonly page_size?: number;
    readonly status?: string;
    readonly user_id?: string;
  },
): AdminBadDebtWriteoffListQuery {
  return {
    appId,
    page: raw.page ?? DEFAULT_PAGE,
    pageSize: raw.page_size ?? DEFAULT_PAGE_SIZE,
    status: (raw.status ?? null) as BadDebtWriteoffStatus | null,
    userId: raw.user_id ?? null,
  };
}

export interface AdminBadDebtWriteoffApproveDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly idempotency: Idempotency;
  /** The ledger with the entry's event bus and payout's recovery hook. */
  readonly ledger: Ledger;
  /** admin's audit writer bound to the approving transaction. */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  readonly ports: BadDebtWriteoffPorts;
}

export interface AdminBadDebtWriteoffApproveInput {
  readonly appId: string;
  readonly adminId: string;
  readonly candidateId: string;
  readonly ip: string | null;
  /** The raw request body (the idempotency hash). */
  readonly rawBody: unknown;
  /** The Idempotency-Key header, or undefined (→ 20001 by the idempotency module). */
  readonly key: string | undefined;
  readonly traceId: string;
}

export interface AdminBadDebtWriteoffApproval {
  readonly writeoff: AdminBadDebtWriteoffView;
  /** The voucher's amount; 0 when the candidate was cancelled. */
  readonly written_off_fen: number;
}

function fieldsRefusal(fields: readonly string[], traceId: string, reason?: string): HandlerResult {
  const refused = fieldsErrorEnvelope(fields, traceId);
  if (reason === undefined) return { status: refused.statusCode, envelope: refused.body };
  const body = refused.body as { data?: Record<string, unknown> };
  return {
    status: refused.statusCode,
    envelope: { ...refused.body, data: { ...(body.data ?? {}), reason } },
  };
}

function conflictRefusal(traceId: string): HandlerResult {
  return {
    status: 409,
    envelope: {
      code: 20902,
      msg: CONFLICT_MESSAGE,
      data: { resource: 'bad_debt_writeoff' },
      trace_id: traceId,
    },
  };
}

function approvePathOf(id: string): string {
  return `${BAD_DEBT_WRITEOFFS_PATH}/${encodeURIComponent(id)}/approve`;
}

async function approve(
  deps: AdminBadDebtWriteoffApproveDeps,
  input: AdminBadDebtWriteoffApproveInput,
  trx: Transaction<DB>,
): Promise<HandlerResult> {
  const { appId, adminId, traceId } = input;
  if (!UUID.test(input.candidateId)) return fieldsRefusal(['id'], traceId);
  const id = input.candidateId.toLowerCase();
  const first = await findBadDebtWriteoff(trx, appId, id);
  if (first === undefined) return fieldsRefusal(['id'], traceId);
  if (first.status !== 'PENDING') return conflictRefusal(traceId);

  // BR-WDR-07 order: the users row, then the balance row, then the candidate; everything that
  // decides the outcome is read again under these locks.
  await deps.ports.lockUsersForUpdate(trx, { appId, userIds: [first.user_id] });
  const [balance] = await deps.ledger.lockBalances(trx, { appId, userIds: [first.user_id] });
  if (balance === undefined || balance.account_id !== first.account_id) {
    throw new Error('ledger: the candidate has no balance row of its account');
  }
  const status = await lockBadDebtWriteoffStatus(trx, appId, id);
  if (status !== 'PENDING') return conflictRefusal(traceId);

  const available = balance.available_fen;
  const frozen = balance.frozen_fen;
  if (frozen > 0n && (await deps.ports.requireNoFrozen(trx, deps.clock, appId))) {
    return fieldsRefusal(['id'], traceId, 'writeoff_frozen_pending');
  }

  const now = deps.clock.now();
  const day = accountingDate(now);
  let row: BadDebtWriteoffRow;
  let writtenOff: bigint;
  let after: bigint;
  if (available >= 0n) {
    // BD3: the balance is back at 0 or above; nothing is written off.
    const to = nextStatus('PENDING', 'CANCEL');
    if ((await cancelBadDebtWriteoff(trx, { appId, id, to })) !== 1) {
      throw new Error('ledger: the locked PENDING candidate did not change');
    }
    row = { ...first, status: to };
    writtenOff = 0n;
    after = available;
  } else {
    // BD2: the amount is −available now, not candidate_fen.
    const to = nextStatus('PENDING', 'APPROVE');
    writtenOff = subFen(0n, available);
    const [built, ...extra] = buildVouchers(TEMPLATE, {
      account_id: first.account_id,
      candidate_id: id,
      user_id: first.user_id,
      writeoff_fen: writtenOff,
    });
    if (built === undefined || extra.length > 0) {
      throw new Error('ledger: BAD_DEBT_WRITEOFF must build exactly one voucher');
    }
    const entries: PostingEntry[] = built.entries.map((entry) => ({
      account:
        entry.account.owner_type === 'user'
          ? { ownerType: 'user', accountId: balance.account_id }
          : { ownerType: 'platform', subject: entry.account.subject },
      sub_account: entry.sub_account ?? 'available',
      amount_fen: entry.amount_fen,
      ledger_type: entry.ledger_type,
      sub_type: entry.sub_type,
      income_type: null,
    }));
    const posted = await deps.ledger.post(trx, {
      appId,
      uniqKey: built.uniq_key,
      bizType: BIZ_TYPE,
      bizId: id,
      operator: `admin:${adminId}`,
      memo: null,
      orderKey: null,
      beneficiaryUserId: null,
      role: null,
      voucherKind: null,
      entries,
    });
    if (posted.kind !== 'posted') {
      // The key names this PENDING candidate: an existing voucher contradicts the locked row.
      throw new Error('ledger: the write-off voucher of a PENDING candidate already exists');
    }
    const updated = await approveBadDebtWriteoffRow(trx, {
      appId,
      id,
      to,
      approverId: adminId,
      at: now,
      voucherId: posted.voucherId,
    });
    if (updated !== 1) throw new Error('ledger: the locked PENDING candidate did not change');
    await deps.ports.markLinkedAccounts(trx, deps.clock, {
      appId,
      sourceUserId: first.user_id,
      sourceRef: id,
    });
    row = {
      ...first,
      status: to,
      approver_id: adminId,
      approved_at: now,
      voucher_id: posted.voucherId,
    };
    after = addFen(available, writtenOff);
  }

  await deps.auditOn(trx).append({
    appId,
    actor: adminId,
    action: BAD_DEBT_WRITEOFF_APPROVE_ACTION,
    target: id,
    before: { available_fen: available.toString(), status: 'PENDING' },
    after: {
      id,
      account_id: first.account_id,
      status: row.status,
      written_off_fen: writtenOff.toString(),
      voucher_id: row.voucher_id,
      available_fen: after.toString(),
    },
    ip: input.ip,
  });

  const data: AdminBadDebtWriteoffApproval = {
    writeoff: viewOf(row, { day, available: after, frozen, blocked: false }),
    written_off_fen: fenToJsonNumber(writtenOff),
  };
  return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
}

/** The approval's effects in one transaction (BD2 APPROVE, BD3 CANCEL; contract order of checks). */
export function approveAdminBadDebtWriteoff(
  deps: AdminBadDebtWriteoffApproveDeps,
  input: AdminBadDebtWriteoffApproveInput,
): Promise<IdempotentResponse> {
  return deps.idempotency.executeInTransaction(
    {
      appId: input.appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: input.adminId },
      method: 'POST',
      path: approvePathOf(input.candidateId),
      key: input.key,
      body: input.rawBody,
      traceId: input.traceId,
    },
    (trx) => approve(deps, input, trx),
  );
}
