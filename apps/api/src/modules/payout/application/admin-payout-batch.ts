// B2-09l: POST /admin/v1/payout-batches (adminCreatePayoutBatch, CT-24zq; 08 BR-WDR-11, BR-WDR-12,
// BR-WDR-18; 编排裁定 D10-595). The controller (http/admin/) only authorises through the
// AdminOperationGuard and takes the parameters; the three steps of EXECUTE are executeBatch.
//
// Runs under platform idempotency in its transactional mode, so the withdrawals, the batch and its
// items, the transfer jobs, the events and the audit record commit together. A refused batch is a
// 200 with an audit record: it is stored, so the same key answers it again even after a fresh W,
// and a retry takes a new key. An id that is not a UUID names no row and never reaches the database.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import {
  fieldsErrorEnvelope,
  type AuditPort,
  type Clock,
  type HandlerResult,
  type Idempotency,
  type IdempotentResponse,
} from '../../platform/index.ts';
import type { PayoutExecute } from './payout-execute.ts';

export const PAYOUT_BATCH_EXECUTE_AUDIT_ACTION = 'payout_batch_execute';

const BATCH_PATH = '/admin/v1/payout-batches';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminPayoutBatchDeps {
  readonly clock: Clock;
  readonly idempotency: Idempotency;
  readonly execute: PayoutExecute;
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
}

/** The guard's verified admin account and the request's address (for the audit row). */
export interface PayoutBatchOperator {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface PayoutBatchWrite {
  readonly body: Schema<'AdminPayoutBatchCreateRequest'>;
  /** The Idempotency-Key header, or undefined (→ 20001 by the idempotency module). */
  readonly key: string | undefined;
  readonly traceId: string;
}

type BatchResult = Schema<'AdminPayoutBatchResult'>;

/** The ids of one request, as sent, keyed by the form the database stores (lower case). */
function canonicalIds(ids: readonly string[]): {
  readonly spelling: ReadonlyMap<string, string>;
  readonly members: readonly string[];
  readonly malformed: readonly string[];
  readonly duplicate: boolean;
} {
  const spelling = new Map<string, string>();
  const members: string[] = [];
  const malformed: string[] = [];
  const seen = new Set<string>();
  let duplicate = false;
  for (const id of ids) {
    const canonical = id.toLowerCase();
    if (seen.has(canonical)) duplicate = true;
    seen.add(canonical);
    if (UUID.test(id)) {
      spelling.set(canonical, id);
      members.push(canonical);
    } else {
      malformed.push(id);
    }
  }
  return { spelling, members, malformed, duplicate };
}

/** Groups the chosen withdrawals into a new kind=manual batch and executes it. */
export function createAdminPayoutBatch(
  deps: AdminPayoutBatchDeps,
  operator: PayoutBatchOperator,
  request: PayoutBatchWrite,
): Promise<IdempotentResponse> {
  const { appId, adminId, ip } = operator;
  const { body, traceId } = request;
  return deps.idempotency.executeInTransaction(
    {
      appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: adminId },
      method: 'POST',
      path: BATCH_PATH,
      key: request.key,
      body,
      traceId,
    },
    async (trx): Promise<HandlerResult> => {
      const ids = canonicalIds(body.withdrawal_ids);
      if (ids.duplicate) {
        const refused = fieldsErrorEnvelope(['withdrawal_ids'], traceId);
        return { status: refused.statusCode, envelope: refused.body };
      }
      const result = await deps.execute.executeBatch(trx, {
        appId,
        members: ids.members,
        executorId: adminId,
        now: deps.clock.now(),
      });
      const asSent = (id: string): string => ids.spelling.get(id) ?? id;
      const data: BatchResult =
        result.kind === 'rejected'
          ? {
              outcome: 'rejected',
              batch_id: null,
              reason: result.reason,
              channel: result.channel ?? null,
              paying: [],
              left: [],
            }
          : {
              outcome: 'executed',
              batch_id: result.batchId,
              reason: null,
              channel: null,
              paying: result.paying.map(asSent),
              left: [
                ...result.left.map((entry) => ({
                  withdrawal_id: asSent(entry.id),
                  reason: entry.reason,
                })),
                ...ids.malformed.map((id) => ({
                  withdrawal_id: id,
                  reason: 'not_approved' as const,
                })),
              ],
            };
      await deps.auditOn(trx).append({
        appId,
        actor: adminId,
        action: PAYOUT_BATCH_EXECUTE_AUDIT_ACTION,
        target: data.batch_id,
        before: null,
        after: {
          outcome: data.outcome,
          batch_id: data.batch_id,
          reason: data.reason,
          channel: data.channel,
          paying: data.paying,
          paying_count: data.paying.length,
          left: data.left,
          left_count: data.left.length,
        },
        ip,
      });
      return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
    },
  );
}
