// B2-09zb (D10-769 / D10-770; contract adminRunSettleAdjust, CT-24zv): finance's manual trigger of
// the positive-difference candidate run (08 BR-FUND-09「finance 可手动触发」). The request only
// queues the scheduled run's job — queue settle, job settle_adjust, payload { app_id, platform,
// accounting_date: bill_date }, singletonKey settle_adjust:<app_id>:<platform>:<bill_date> (one still
// queued absorbs it) — and writes one audit record settle_adjust_run_request (platform, bill_date);
// it writes no candidate and no settle_jobs row (the job does, adjust/run-job.ts).
// Under platform idempotency in its transactional mode (subject a:<admin_users.id>, the path, the
// Idempotency-Key header): the send, the audit record and the idempotency record commit together;
// 2xxxx refusals are not stored. A bill_date after the current +08:00 accounting day (injected
// Clock) is 20001 data.fields=[bill_date].
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { accountingDate } from '@couli/domain';
import type { Transaction } from 'kysely';
import {
  fieldsErrorEnvelope,
  type AuditPort,
  type Clock,
  type HandlerResult,
  type Idempotency,
  type JobQueue,
} from '../../platform/index.ts';
import { scheduleSettleAdjust } from '../worker/schedule.ts';

export const RUN_PATH = '/admin/v1/settle-adjust-runs';
export const RUN_AUDIT_ACTION = 'settle_adjust_run_request';

export interface AdminSettleAdjustRunDeps {
  readonly clock: Clock;
  readonly idempotency: Idempotency;
  /** The entry's job queue; the send joins the request's transaction. */
  readonly queue: JobQueue;
  /** admin's audit writer bound to the request's transaction. */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
}

export interface AdminSettleAdjustRunOperator {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface AdminSettleAdjustRunCall {
  readonly body: Schema<'AdminSettleAdjustRunRequest'>;
  /** The Idempotency-Key header, or undefined (→ 20001 by the idempotency module). */
  readonly key: string | undefined;
  readonly traceId: string;
}

/** What the controller sends: the status and the exact bytes (first result on a replay). */
export interface AdminSettleAdjustRunAnswer {
  readonly status: number;
  readonly body: string;
}

export async function runAdminSettleAdjust(
  deps: AdminSettleAdjustRunDeps,
  operator: AdminSettleAdjustRunOperator,
  call: AdminSettleAdjustRunCall,
): Promise<AdminSettleAdjustRunAnswer> {
  const { appId, adminId, ip } = operator;
  const { body, traceId } = call;
  const result = await deps.idempotency.executeInTransaction(
    {
      appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: adminId },
      method: 'POST',
      path: RUN_PATH,
      key: call.key,
      body,
      traceId,
    },
    async (trx): Promise<HandlerResult> => {
      // YYYY-MM-DD (contract format date) orders as text.
      if (body.bill_date > accountingDate(deps.clock.now())) {
        const refused = fieldsErrorEnvelope(['bill_date'], traceId);
        return { status: refused.statusCode, envelope: refused.body };
      }
      await scheduleSettleAdjust(deps.queue, trx, {
        appId,
        platform: body.platform,
        accountingDate: body.bill_date,
      });
      await deps.auditOn(trx).append({
        appId,
        actor: adminId,
        action: RUN_AUDIT_ACTION,
        target: `${body.platform}:${body.bill_date}`,
        before: null,
        after: { platform: body.platform, bill_date: body.bill_date },
        ip,
      });
      const data: Schema<'AdminSettleAdjustRunResponse'>['data'] = { result: 'submitted' };
      return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
    },
  );
  return result;
}
