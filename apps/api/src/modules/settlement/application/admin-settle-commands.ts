// B2-09f: the five writes of the settlement console (CT-24zd confirmAdminSettleBill,
// cancelAdminSettleBatchSchedule, rejectAdminSettleBatch, resumeAdminSettleBatch,
// createAdminSettleSupplementBatches; 08 BR-FUND-04 ⑥ ⑧, 迁移表 SB2 / SB3 / SB4 / SB8; 04 §3.2,
// §11.2 settle.bill). The controller (http/admin/) only authorises through the AdminOperationGuard
// (settle.bill, step-up totp) and takes the parameters; this file calls the batch command service
// (B2-04o) and the supplement command (B2-04r) and maps their refusals to the contract.
//
// Batches change only inside those two, through the generated transition(); nothing here writes a
// batch. Every write and its audit record (admin's writer bound to the command's transaction) commit
// together, and the bill the batch commands answer with is read on that same transaction, so the
// response is what GET returns afterwards. No money moves and no batch_execute job is sent: running
// a confirmed batch is the worker's (B2-04ze).
//
// Refusals: 20902 data.resource=settle_batch (out of date, not the bill's DRAFT set, a status that
// does not allow it), 20001 data.fields, with data.reason on the guards. An unknown bill reaches the
// confirmation as bill_not_ready from the command service (schedule checks come first), so the bill
// is only read to tell the two apart once the command has refused. The launch reads the bill first:
// [bill_id] goes before the launch guard. round_unavailable is not a client's refusal (50001).
//
// The launch runs under platform idempotency in its transactional mode (subject a:<admin_users.id>,
// the concrete path, the Idempotency-Key header): checks, differences, batches, the audit record and
// the idempotency record commit together; 2xxxx refusals are not stored. Each launch's nominal moment
// is the injected Clock, so the same instant is a replay of settle_jobs' key (outcome duplicate). A
// failed launch rolls all of that back and records nothing: no settle_jobs row stays claimed, and the
// retry under the same key is a launch of its own at its own moment.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { accountingDate } from '@couli/domain';
import type { Kysely, Transaction } from 'kysely';
import type { Logger } from 'pino';
import {
  fieldsErrorEnvelope,
  type AuditPort,
  type Clock,
  type HandlerResult,
  type Idempotency,
} from '../../platform/index.ts';
import { autoSwitchValue } from '../batch/executor/executor.ts';
import { previousDay, switchOn } from '../batch/executor/rules.ts';
import {
  BatchCommandRejectedError,
  BatchConflictError,
  IllegalTransitionError,
  createBatchCommandService,
  type BatchChange,
  type BatchCommandDeps,
  type BatchCommandService,
  type ConfirmChange,
} from '../batch/commands/service.ts';
import {
  createBillSourceReader,
  saveBillValidations,
  createBillSnapshotRegeneration,
  type BillJobDependencies,
  type BillSnapshotRegenerationDependencies,
  type BillSourceDependencies,
} from '../bill/index.ts';
import {
  SupplementRejectedError,
  createSupplementCommand,
  type SupplementCommand,
} from '../bill/supplement/command.ts';
import { getAdminSettleBill } from './admin-settle-bills.ts';

/** The audit actions of the contract. */
export const CONFIRM_AUDIT_ACTION = 'settle_bill_confirm';
export const CANCEL_SCHEDULE_AUDIT_ACTION = 'settle_batch_cancel_schedule';
export const REJECT_AUDIT_ACTION = 'settle_batch_reject';
export const RESUME_AUDIT_ACTION = 'settle_batch_resume';
export const SUPPLEMENT_AUDIT_ACTION = 'settle_supplement_create';

/** Contract AdminSettleBatchRejectRequest.reason: 1–200 characters after trimming. */
const REASON_MAX = 200;

/** BR-TEXT-14 fallback text of 20902 (contracts/texts.default.json error.20902). */
const CONFLICT_MESSAGE = '状态已变化，请刷新后重试';

const AUTO_SWITCH = 'settle.auto.enabled';

export interface AdminSettleConfigReader {
  get(appId: string, key: string): Promise<unknown>;
}

/** What app.module hands in: the other modules' ports (settlement imports none of them). */
export interface AdminSettleCommandPorts {
  /** Binds the audit port to a transaction handle (app.module: admin's createAuditWriter). */
  readonly auditWriter: (db: Kysely<DB>, clock: Clock) => AuditPort;
  /** content's configuration, read fresh on the given handle. */
  readonly config: (db: Kysely<DB>, clock: Clock) => AdminSettleConfigReader;
  /** ledger's getAssetSnapshotStatus. */
  readonly snapshotStatus: BillJobDependencies['snapshotStatus'];
  /** commission's read ports. */
  readonly readSnapshot: BillJobDependencies['readSnapshot'];
  readonly readTljDeductFen: BillJobDependencies['readTljDeductFen'];
  /** ledger's registerReconDiff. */
  readonly registerDiff: BillJobDependencies['registerDiff'];
  /** ledger's readUnionAuthoritativeOrderKeys. B2-18: kept in the shape, never called (D10-2415 ③). */
  readonly readUnionAuthoritative: BillSourceDependencies['readUnionAuthoritative'];
  /**
   * B2-18 (BR-FUND-04 ④, BR-FUND-01 R7): commission's estimates refresh with an explicit value over
   * the entry's clock; the supplement's snapshot regeneration writes the new version through it.
   * Optional: absent, an amount mismatch is a failed regeneration (alert, not batched).
   */
  readonly regenerationRefresh?: (clock: Clock) => BillSnapshotRegenerationDependencies['refresh'];
}

export interface AdminSettleCommandDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly idempotency: Idempotency;
  readonly commands: BatchCommandService;
  /** The supplement command with its configuration read on `handle`. */
  readonly supplement: (handle: Kysely<DB>) => SupplementCommand;
  /** admin's audit writer bound to the command's transaction (the single writer of audit_logs). */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
}

/** Every DRAFT batch of the bill, whatever its round and platform (编排裁定 D10-444). */
const draftBatchIds: BatchCommandDeps['currentRound'] = async (trx, { appId, billId }) => {
  const rows = await trx
    .withSchema('app')
    .selectFrom('settle_batches')
    .select('batch_id')
    .where('app_id', '=', appId)
    .where('bill_id', '=', billId)
    .where('status', '=', 'DRAFT')
    .execute();
  return rows.map((row) => row.batch_id);
};

/** SB8's guard facts: read as the executor reads them (BR-FUND-04 ⑦, BR-FUND-18). */
function readinessOf(
  ports: AdminSettleCommandPorts,
  db: Kysely<DB>,
  clock: Clock,
): BatchCommandDeps['readiness'] {
  const config = ports.config(db, clock);
  return async ({ appId, platform, at }) => {
    const auto = autoSwitchValue(await config.get(appId, AUTO_SWITCH));
    const credit = await config.get(appId, `credit.enabled.${platform}`);
    const snapshot = await ports.snapshotStatus(
      db,
      { appId, accountingDate: previousDay(accountingDate(at)) },
      clock,
    );
    return {
      autoEnabled: switchOn(auto),
      creditEnabled: switchOn(credit),
      snapshotCompleted: snapshot.state === 'complete',
      snapshotTimedOut: snapshot.state === 'timed_out',
    };
  };
}

/** The use case dependencies over the entry's handle, clock and idempotency primitive. */
export function createAdminSettleCommandDeps(
  ports: AdminSettleCommandPorts,
  runtime: {
    readonly db: Kysely<DB>;
    readonly clock: Clock;
    readonly idempotency: Idempotency;
    readonly logger: Pick<Logger, 'warn' | 'error'>;
  },
): AdminSettleCommandDeps {
  const { db, clock, idempotency, logger } = runtime;
  // The conclusion port is passed for the shape only; the reader never calls it (D10-2415 ③).
  const readSource = createBillSourceReader({
    readUnionAuthoritative: ports.readUnionAuthoritative,
  });
  // B2-18: the supplement's amount mismatch follows the union in the launch's own transaction.
  const refresh = ports.regenerationRefresh?.(clock);
  const regeneration =
    refresh === undefined
      ? {}
      : { regenerateSnapshot: createBillSnapshotRegeneration({ clock, refresh }) };
  return {
    db,
    clock,
    idempotency,
    commands: createBatchCommandService({
      db,
      clock,
      currentRound: draftBatchIds,
      readiness: readinessOf(ports, db, clock),
      readinessOn: (trx) => readinessOf(ports, trx, clock),
    }),
    supplement: (handle) =>
      createSupplementCommand({
        clock,
        config: ports.config(handle, clock),
        readSource,
        readSnapshot: ports.readSnapshot,
        readTljDeductFen: ports.readTljDeductFen,
        registerDiff: ports.registerDiff,
        saveValidations: saveBillValidations,
        logger,
        ...regeneration,
      }),
    auditOn: (trx) => ports.auditWriter(trx, clock),
  };
}

/** The guard's verified admin account and the request's address (for the audit row). */
export interface AdminSettleOperator {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

/** What the controller sends: the status and the exact bytes. */
export interface AdminSettleAnswer {
  readonly status: number;
  readonly body: string;
}

function answerOf(result: HandlerResult): AdminSettleAnswer {
  return { status: result.status, body: JSON.stringify(result.envelope) };
}

function fieldsRefusal(fields: readonly string[], traceId: string, reason?: string): HandlerResult {
  const refused = fieldsErrorEnvelope(fields, traceId);
  return {
    status: refused.statusCode,
    envelope:
      reason === undefined
        ? refused.body
        : { ...refused.body, data: { ...refused.body.data, reason } },
  };
}

function conflictRefusal(traceId: string): HandlerResult {
  return {
    status: 409,
    envelope: {
      code: 20902,
      msg: CONFLICT_MESSAGE,
      data: { resource: 'settle_batch' },
      trace_id: traceId,
    },
  };
}

/** The contract's answer to a refusal of the command service; null when it is not one. */
function commandRefusal(error: unknown, traceId: string): HandlerResult | null {
  if (error instanceof BatchConflictError || error instanceof IllegalTransitionError) {
    return conflictRefusal(traceId);
  }
  if (!(error instanceof BatchCommandRejectedError)) return null;
  switch (error.reason) {
    case 'invalid_schedule':
      return fieldsRefusal(['scheduled_at'], traceId);
    case 'reason_required':
      return fieldsRefusal(['reason'], traceId);
    case 'batch_not_found':
      return fieldsRefusal(['batch_id'], traceId);
    case 'bill_not_ready':
      return fieldsRefusal(['bill_id'], traceId, 'bill_not_ready');
    case 'switches_off':
    case 'snapshot_pending':
      return fieldsRefusal(['batch_id'], traceId, error.reason);
    case 'round_unavailable':
      return null;
  }
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** The bill as GET returns it, read on the command's transaction. */
async function billResponse(
  deps: AdminSettleCommandDeps,
  trx: Transaction<DB>,
  appId: string,
  billId: string,
  traceId: string,
): Promise<HandlerResult> {
  const data = await getAdminSettleBill({ db: trx, now: () => deps.clock.now() }, appId, billId);
  return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
}

/**
 * Runs one batch command: `run` gets the callback the command calls on its transaction before
 * commit, `respond` there leaves the response. A refusal of the command becomes its contract answer.
 */
async function batchCommand(
  traceId: string,
  run: (respond: (result: HandlerResult) => void) => Promise<void>,
  refusal: (error: unknown) => Promise<HandlerResult | null> = (error) =>
    Promise.resolve(commandRefusal(error, traceId)),
): Promise<AdminSettleAnswer> {
  let answer: HandlerResult | undefined;
  try {
    await run((result) => {
      answer = result;
    });
  } catch (error: unknown) {
    const refused = await refusal(error);
    if (refused === null) throw error;
    return answerOf(refused);
  }
  if (answer === undefined) throw new Error('settlement: batch command returned no answer');
  return answerOf(answer);
}

/** A parsed date-time as the Date the command takes (no `new Date(`; the clock's value is a copy). */
function instant(deps: AdminSettleCommandDeps, text: string): Date {
  const at = structuredClone(deps.clock.now());
  at.setTime(Date.parse(text));
  return at;
}

async function billExists(deps: AdminSettleCommandDeps, appId: string, billId: string) {
  const bill = await deps.db
    .withSchema('app')
    .selectFrom('settle_bills')
    .select('bill_id')
    .where('app_id', '=', appId)
    .where('bill_id', '=', billId)
    .executeTakeFirst();
  return bill !== undefined;
}

export function confirmAdminSettleBill(
  deps: AdminSettleCommandDeps,
  operator: AdminSettleOperator,
  billId: string,
  body: Schema<'AdminSettleBillConfirmRequest'>,
  traceId: string,
): Promise<AdminSettleAnswer> {
  const { appId, adminId, ip } = operator;
  return batchCommand(
    traceId,
    (respond) =>
      deps.commands.confirmBill(
        {
          appId,
          adminId,
          billId,
          expectedBatches: body.expected_batches.map((batch) => ({
            batchId: batch.batch_id,
            expectedRowVersion: batch.expected_row_version,
          })),
          ...(body.settle_mode === undefined ? {} : { mode: body.settle_mode }),
          ...(body.scheduled_at === undefined
            ? {}
            : { scheduledAt: instant(deps, body.scheduled_at) }),
        },
        async (trx, change: ConfirmChange) => {
          await deps.auditOn(trx).append({
            appId,
            actor: adminId,
            action: CONFIRM_AUDIT_ACTION,
            target: change.billId,
            before: {
              batches: change.batches.map((batch) => ({
                batch_id: batch.batchId,
                status: batch.from,
              })),
            },
            after: {
              settle_mode: change.mode,
              scheduled_at: iso(change.scheduledAt),
              batches: change.batches.map((batch) => ({
                batch_id: batch.batchId,
                status: batch.to,
              })),
            },
            ip,
          });
          respond(await billResponse(deps, trx, appId, change.billId, traceId));
        },
      ),
    // The command answers bill_not_ready for an unknown bill as well: the contract tells them apart.
    async (error) =>
      error instanceof BatchCommandRejectedError &&
      error.reason === 'bill_not_ready' &&
      !(await billExists(deps, appId, billId))
        ? fieldsRefusal(['bill_id'], traceId)
        : commandRefusal(error, traceId),
  );
}

export function cancelAdminSettleBatchSchedule(
  deps: AdminSettleCommandDeps,
  operator: AdminSettleOperator,
  batchId: string,
  body: Schema<'AdminSettleBatchVersionRequest'>,
  traceId: string,
): Promise<AdminSettleAnswer> {
  const { appId, adminId, ip } = operator;
  return batchCommand(traceId, (respond) =>
    deps.commands.cancelSchedule(
      { appId, adminId, batchId, expectedRowVersion: body.expected_row_version },
      async (trx, change: BatchChange) => {
        const facts = (side: BatchChange['before']) => ({
          status: side.status,
          settle_mode: side.settleMode,
          scheduled_at: iso(side.scheduledAt),
        });
        await deps.auditOn(trx).append({
          appId,
          actor: adminId,
          action: CANCEL_SCHEDULE_AUDIT_ACTION,
          target: change.batchId,
          before: facts(change.before),
          after: facts(change.after),
          ip,
        });
        respond(await billResponse(deps, trx, appId, change.billId, traceId));
      },
    ),
  );
}

export async function rejectAdminSettleBatch(
  deps: AdminSettleCommandDeps,
  operator: AdminSettleOperator,
  batchId: string,
  body: Schema<'AdminSettleBatchRejectRequest'>,
  traceId: string,
): Promise<AdminSettleAnswer> {
  const { appId, adminId, ip } = operator;
  const reason = body.reason.trim();
  const length = [...reason].length;
  if (length < 1 || length > REASON_MAX) return answerOf(fieldsRefusal(['reason'], traceId));
  return batchCommand(traceId, (respond) =>
    deps.commands.rejectBatch(
      { appId, adminId, batchId, expectedRowVersion: body.expected_row_version, reason },
      async (trx, change: BatchChange) => {
        await deps.auditOn(trx).append({
          appId,
          actor: adminId,
          action: REJECT_AUDIT_ACTION,
          target: change.batchId,
          before: { status: change.before.status },
          after: { status: change.after.status, reason },
          ip,
        });
        respond(await billResponse(deps, trx, appId, change.billId, traceId));
      },
    ),
  );
}

export function resumeAdminSettleBatch(
  deps: AdminSettleCommandDeps,
  operator: AdminSettleOperator,
  batchId: string,
  body: Schema<'AdminSettleBatchVersionRequest'>,
  traceId: string,
): Promise<AdminSettleAnswer> {
  const { appId, adminId, ip } = operator;
  return batchCommand(traceId, (respond) =>
    deps.commands.resumeBatch(
      { appId, adminId, batchId, expectedRowVersion: body.expected_row_version },
      async (trx, change: BatchChange) => {
        await deps.auditOn(trx).append({
          appId,
          actor: adminId,
          action: RESUME_AUDIT_ACTION,
          target: change.batchId,
          before: { status: change.before.status },
          after: { status: change.after.status },
          ip,
        });
        respond(await billResponse(deps, trx, appId, change.billId, traceId));
      },
    ),
  );
}

function supplementRefusal(error: SupplementRejectedError, traceId: string): HandlerResult {
  switch (error.reason) {
    case 'bill_not_found':
      return fieldsRefusal(['bill_id'], traceId);
    case 'credit_disabled':
      return fieldsRefusal(['platform'], traceId, error.reason);
    case 'bill_not_ready':
    case 'pending_draft':
      return fieldsRefusal(['bill_id'], traceId, error.reason);
  }
}

export interface AdminSettleSupplementCall {
  readonly body: Schema<'AdminSettleSupplementRequest'>;
  /** The Idempotency-Key header, or undefined (→ 20001 by the idempotency module). */
  readonly key: string | undefined;
  readonly traceId: string;
}

/** Launches the supplement check of one platform; the response bytes (first result on replay). */
export async function launchAdminSettleSupplement(
  deps: AdminSettleCommandDeps,
  operator: AdminSettleOperator,
  billId: string,
  call: AdminSettleSupplementCall,
): Promise<AdminSettleAnswer> {
  const { appId, adminId, ip } = operator;
  const { body, traceId } = call;
  const launch = { appId, billId, platform: body.platform, requestedAt: deps.clock.now() };
  return deps.idempotency.executeInTransaction(
    {
      appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: adminId },
      method: 'POST',
      path: `/admin/v1/settle-bills/${billId}/supplement-batches`,
      key: call.key,
      body,
      traceId,
    },
    async (trx): Promise<HandlerResult> => {
      const bill = await trx
        .withSchema('app')
        .selectFrom('settle_bills')
        .select('bill_id')
        .where('app_id', '=', appId)
        .where('bill_id', '=', billId)
        .executeTakeFirst();
      if (bill === undefined) return fieldsRefusal(['bill_id'], traceId);
      let result;
      try {
        result = await deps.supplement(trx).launchInTransaction(trx, launch);
      } catch (error: unknown) {
        if (!(error instanceof SupplementRejectedError)) throw error;
        return supplementRefusal(error, traceId);
      }
      const data: Schema<'AdminSettleSupplementResponse'>['data'] = {
        bill_id: result.billId,
        platform: body.platform,
        outcome: result.outcome,
        batch_ids: [...result.batchIds],
      };
      await deps.auditOn(trx).append({
        appId,
        actor: adminId,
        action: SUPPLEMENT_AUDIT_ACTION,
        target: result.billId,
        before: null,
        after: { ...data },
        ip,
      });
      return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
    },
  );
}
