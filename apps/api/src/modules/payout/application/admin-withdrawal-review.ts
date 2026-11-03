// B2-09k: POST /admin/v1/withdrawals/batch-approve and POST /admin/v1/withdrawals/{id}/reject
// (adminBatchApproveWithdrawals, adminRejectWithdrawal, CT-24zp; 08 BR-WDR-10, BR-WDR-05, BR-WDR-17;
// 编排裁定 D10-595). The controller (http/admin/) only authorises through the AdminOperationGuard and
// takes the parameters; W2 and W3 themselves are withdrawalCommands.
//
// Approve runs under platform idempotency in its plain mode, because each id has its own transaction
// and its own result: one that cannot be approved never fails the others. An unexpected failure ends
// the request with 5xx, leaving the ids already approved approved; the same key then runs the rest
// again and those come back not_pending.
//
// Reject runs under platform idempotency in its transactional mode: the status, the WITHDRAW:RETURN
// voucher, the event and the audit record commit together, and 2xxxx refusals are not stored.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { WithdrawalState } from '@couli/domain';
import type { Kysely, Transaction } from 'kysely';
import {
  fieldsErrorEnvelope,
  type AuditPort,
  type Clock,
  type HandlerResult,
  type Idempotency,
  type IdempotentResponse,
} from '../../platform/index.ts';
import {
  WithdrawalConflictError,
  type RejectWithdrawalCommand,
  type WithdrawalCommands,
} from './withdrawal-commands.ts';

export const WITHDRAWAL_APPROVE_AUDIT_ACTION = 'withdrawal_approve';
export const WITHDRAWAL_REJECT_AUDIT_ACTION = 'withdrawal_reject';

const BATCH_PATH = '/admin/v1/withdrawals/batch-approve';
/** BR-TEXT-14 fallback text of 20902 (contracts/texts.default.json error.20902). */
const CONFLICT_MESSAGE = '状态已变化，请刷新后重试';
/** withdrawals.id is a uuid column; any other text names no row and must not reach the database. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REJECTABLE: readonly string[] = ['PENDING_REVIEW', 'APPROVED'];

export interface AdminWithdrawalReviewDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly idempotency: Idempotency;
  readonly commands: WithdrawalCommands;
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
}

/** The guard's verified admin account and the request's address (for the audit row). */
export interface WithdrawalReviewOperator {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface WithdrawalReviewWrite<Body> {
  readonly body: Body;
  /** The Idempotency-Key header, or undefined (→ 20001 by the idempotency module). */
  readonly key: string | undefined;
  readonly traceId: string;
}

type BatchItem = Schema<'AdminWithdrawalBatchApproveItem'>;

function fieldsRefusal(fields: readonly string[], traceId: string): HandlerResult {
  const refused = fieldsErrorEnvelope(fields, traceId);
  return { status: refused.statusCode, envelope: refused.body };
}

function reasonRefusal(reason: string, traceId: string): HandlerResult {
  const refused = fieldsErrorEnvelope(['withdrawal_id'], traceId);
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
      data: { resource: 'withdrawal' },
      trace_id: traceId,
    },
  };
}

function readHead(trx: Transaction<DB>, appId: string, id: string) {
  return trx
    .withSchema('app')
    .selectFrom('withdrawals')
    .select(['status', 'row_version'])
    .where('app_id', '=', appId)
    .where('id', '=', id)
    .executeTakeFirst();
}

/** One id on its own transaction; a refusal is its result, anything unexpected propagates. */
function approveOne(
  deps: AdminWithdrawalReviewDeps,
  operator: WithdrawalReviewOperator,
  rawId: string,
): Promise<BatchItem> {
  const skipped = (reason: NonNullable<BatchItem['reason']>): BatchItem => ({
    withdrawal_id: rawId,
    result: 'skipped',
    reason,
  });
  if (!UUID.test(rawId)) return Promise.resolve(skipped('not_found'));
  const id = rawId.toLowerCase();
  const { appId, adminId } = operator;
  return deps.db.transaction().execute(async (trx) => {
    const head = await readHead(trx, appId, id);
    if (head === undefined) return skipped('not_found');
    if (head.status !== 'PENDING_REVIEW') return skipped('not_pending');
    let result;
    try {
      result = await deps.commands.approve(trx, {
        appId,
        withdrawalId: id,
        expectedStatus: 'PENDING_REVIEW',
        expectedRowVersion: head.row_version,
        reviewerId: adminId,
      });
    } catch (error: unknown) {
      if (error instanceof WithdrawalConflictError) return skipped('not_pending');
      throw error;
    }
    if (result.kind === 'refused') {
      if (result.reason === 'negative_balance' || result.reason === 'blocked') {
        return skipped(result.reason);
      }
      return skipped('not_pending');
    }
    await deps.auditOn(trx).append({
      appId,
      actor: adminId,
      action: WITHDRAWAL_APPROVE_AUDIT_ACTION,
      target: id,
      before: { withdrawal_id: id, status: 'PENDING_REVIEW' },
      after: { withdrawal_id: id, status: result.status },
      ip: operator.ip,
    });
    return { withdrawal_id: rawId, result: 'approved', reason: null } satisfies BatchItem;
  });
}

/** W2 for each id, in the order given. */
export function batchApproveAdminWithdrawals(
  deps: AdminWithdrawalReviewDeps,
  operator: WithdrawalReviewOperator,
  request: WithdrawalReviewWrite<Schema<'AdminWithdrawalBatchApproveRequest'>>,
): Promise<IdempotentResponse> {
  const { appId, adminId } = operator;
  const { body, traceId } = request;
  return deps.idempotency.execute(
    {
      appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: adminId },
      method: 'POST',
      path: BATCH_PATH,
      key: request.key,
      body,
      traceId,
    },
    async (): Promise<HandlerResult> => {
      const ids = body.withdrawal_ids;
      const distinct = new Set(ids.map((id) => id.toLowerCase()));
      if (distinct.size !== ids.length) return fieldsRefusal(['withdrawal_ids'], traceId);
      const items: BatchItem[] = [];
      // One at a time: the members' locks are taken in the order given, never two transactions held.
      for (const id of ids) items.push(await approveOne(deps, operator, id));
      const data: Schema<'AdminWithdrawalBatchApprove'> = { items };
      return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
    },
  );
}

/** W3 of one withdrawal of the operator's app, with the money back in available. */
export function rejectAdminWithdrawal(
  deps: AdminWithdrawalReviewDeps,
  operator: WithdrawalReviewOperator,
  rawId: string,
  request: WithdrawalReviewWrite<Schema<'AdminWithdrawalRejectRequest'>>,
): Promise<IdempotentResponse> {
  const { appId, adminId } = operator;
  const { body, traceId } = request;
  return deps.idempotency.executeInTransaction(
    {
      appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: adminId },
      method: 'POST',
      // Encoded: the idempotency path refuses ? and #, and a bad id must reach the 20001 below.
      path: `/admin/v1/withdrawals/${encodeURIComponent(rawId)}/reject`,
      key: request.key,
      body,
      traceId,
    },
    async (trx): Promise<HandlerResult> => {
      const note = body.note?.trim();
      if (note === '' || (body.reason_code === 'USER_REQUEST' && note === undefined)) {
        return fieldsRefusal(['note'], traceId);
      }
      if (!UUID.test(rawId)) return fieldsRefusal(['withdrawal_id'], traceId);
      const id = rawId.toLowerCase();
      const head = await readHead(trx, appId, id);
      if (head === undefined) return fieldsRefusal(['withdrawal_id'], traceId);
      if (!REJECTABLE.includes(head.status)) return conflictRefusal(traceId);

      const command: RejectWithdrawalCommand = {
        appId,
        withdrawalId: id,
        expectedStatus: head.status as WithdrawalState,
        expectedRowVersion: head.row_version,
        reviewerId: adminId,
        reasonCode: body.reason_code,
        note: note ?? null,
      };
      let result;
      try {
        result = await deps.commands.reject(trx, command);
      } catch (error: unknown) {
        if (error instanceof WithdrawalConflictError) return conflictRefusal(traceId);
        throw error;
      }
      if (result.kind === 'refused') {
        if (result.reason === 'attempt_exists') {
          return reasonRefusal('reject_attempt_exists', traceId);
        }
        if (result.reason === 'query_required') {
          return reasonRefusal('reject_query_required', traceId);
        }
        if (result.reason === 'query_success') {
          return reasonRefusal('reject_query_success', traceId);
        }
        return conflictRefusal(traceId);
      }
      await deps.auditOn(trx).append({
        appId,
        actor: adminId,
        action: WITHDRAWAL_REJECT_AUDIT_ACTION,
        target: id,
        before: { withdrawal_id: id, status: head.status },
        after: {
          withdrawal_id: id,
          status: result.status,
          reason_code: body.reason_code,
          note: note ?? null,
        },
        ip: operator.ip,
      });
      // reviewed_at as stored, so the answer and its replay match the detail.
      const stored = await trx
        .withSchema('app')
        .selectFrom('withdrawals')
        .select('reviewed_at')
        .where('app_id', '=', appId)
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      const data: Schema<'AdminWithdrawalRejected'> = {
        withdrawal_id: id,
        status: 'REJECTED',
        reject_reason_code: body.reason_code,
        reviewer_id: adminId,
        reviewed_at: (stored.reviewed_at as Date).toISOString(),
      };
      return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
    },
  );
}
