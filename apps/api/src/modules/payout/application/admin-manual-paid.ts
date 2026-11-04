// B2-09m: POST /admin/v1/withdrawals/batch-manual-paid (adminBatchManualPaid, CT-24zr; 08 BR-WDR-16;
// 编排裁定 D10-595, D10-596). The controller (http/admin/) only authorises through the
// AdminOperationGuard and takes the parameters; W8 itself is withdrawal-manual-paid.ts.
//
// Runs under platform idempotency in its plain mode, because each item has its own transaction and
// its own result: one that cannot be recorded never fails the others. An unexpected failure ends the
// request with 5xx, leaving the items already recorded recorded; the same key then runs the rest
// again and those come back not_approved.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { fenToJsonNumber } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import {
  fieldsErrorEnvelope,
  type AuditPort,
  type Clock,
  type HandlerResult,
  type Idempotency,
  type IdempotentResponse,
} from '../../platform/index.ts';
import { instant } from './payout-landing.ts';
import { TaxYtdIdentityMissingError } from './tax-ytd.ts';
import { isChannelOrderIdCollision, type WithdrawalManualPaid } from './withdrawal-manual-paid.ts';

export const WITHDRAWAL_MANUAL_PAID_AUDIT_ACTION = 'withdrawal_manual_paid';

const PATH = '/admin/v1/withdrawals/batch-manual-paid';
/** withdrawals.id is a uuid column; any other text names no row and must not reach the database. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminManualPaidDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly idempotency: Idempotency;
  readonly manualPaid: WithdrawalManualPaid;
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
}

/** The guard's verified admin account and the request's address (for the audit row). */
export interface ManualPaidOperator {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface ManualPaidWrite {
  readonly body: Schema<'AdminWithdrawalBatchManualPaidRequest'>;
  /** The Idempotency-Key header, or undefined (→ 20001 by the idempotency module). */
  readonly key: string | undefined;
  readonly traceId: string;
}

type Entry = Schema<'AdminWithdrawalManualPaidEntry'>;
type Item = Schema<'AdminWithdrawalBatchManualPaidItem'>;

/** One item on its own transaction; a refusal is its result, anything unexpected propagates. */
async function payOne(
  deps: AdminManualPaidDeps,
  operator: ManualPaidOperator,
  entry: Entry,
): Promise<Item> {
  const rawId = entry.withdrawal_id;
  const skipped = (reason: NonNullable<Item['reason']>): Item => ({
    withdrawal_id: rawId,
    result: 'skipped',
    reason,
  });
  if (!UUID.test(rawId)) return skipped('not_found');
  const id = rawId.toLowerCase();
  const { appId, adminId } = operator;
  const now = deps.clock.now();
  const paidAt = instant(now, Date.parse(entry.paid_at));
  try {
    return await deps.db.transaction().execute(async (trx): Promise<Item> => {
      const result = await deps.manualPaid.record(trx, {
        appId,
        withdrawalId: id,
        channelOrderId: entry.channel_order_id,
        paidAt,
        paidFen: BigInt(entry.paid_fen),
        operatorId: adminId,
        now,
      });
      if (result.kind === 'refused') return skipped(result.reason);
      await deps.auditOn(trx).append({
        appId,
        actor: adminId,
        action: WITHDRAWAL_MANUAL_PAID_AUDIT_ACTION,
        target: id,
        before: { withdrawal_id: id, status: 'APPROVED' },
        after: {
          withdrawal_id: id,
          status: 'PAID_MANUAL',
          channel_order_id: entry.channel_order_id,
          paid_at: paidAt.toISOString(),
          paid_fen: fenToJsonNumber(result.netFen),
        },
        ip: operator.ip,
      });
      return { withdrawal_id: rawId, result: 'paid', reason: null };
    });
  } catch (error: unknown) {
    // Both roll this item's transaction back, so nothing of it stays.
    if (isChannelOrderIdCollision(error)) return skipped('channel_order_id_taken');
    if (error instanceof TaxYtdIdentityMissingError) return skipped('identity_missing');
    throw error;
  }
}

/** W8 for each item, in the order given. */
export function batchManualPaidAdminWithdrawals(
  deps: AdminManualPaidDeps,
  operator: ManualPaidOperator,
  request: ManualPaidWrite,
): Promise<IdempotentResponse> {
  const { appId, adminId } = operator;
  const { body, traceId } = request;
  return deps.idempotency.execute(
    {
      appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: adminId },
      method: 'POST',
      path: PATH,
      key: request.key,
      body,
      traceId,
    },
    async (): Promise<HandlerResult> => {
      const distinct = new Set(body.items.map((item) => item.withdrawal_id.toLowerCase()));
      if (distinct.size !== body.items.length) {
        const refused = fieldsErrorEnvelope(['items'], traceId);
        return { status: refused.statusCode, envelope: refused.body };
      }
      const items: Item[] = [];
      // One at a time: the members' locks are taken in the order given, never two transactions held.
      for (const entry of body.items) items.push(await payOne(deps, operator, entry));
      const data: Schema<'AdminWithdrawalBatchManualPaid'> = { items };
      return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
    },
  );
}
