// B2-09i: POST /admin/v1/payout-watermarks (adminCreatePayoutWatermark, CT-24zn; 08 BR-WDR-18 细则
// 「W 的取数时刻」「多通道的 W」; 04 §3.2 payout_watermarks; 编排裁定 D10-241, D10-248, D10-285,
// D10-592). Finance enters the balance W of a channel; the latest row is what the channel's next
// EXECUTE judges. The controller (http/admin/) only authorises through the AdminOperationGuard and
// takes the parameters.
//
// Runs under platform idempotency in its transactional mode (subject a:<admin_users.id>); 2xxxx
// refusals are not stored. Any failure rolls back the row and the audit record together (5xx) and
// leaves no idempotency record.
//
// The measuring time is judged in payout's domain and only here, against the injected Clock, never
// by a database constraint (D10-241). "Before the channel's latest" reads the latest row under the
// channel's lock, the same lock EXECUTE takes, so two racing entries cannot both pass on one latest
// row and an entry never lands between EXECUTE's reading of W and its commit.
//
// Writes one row and one audit record: no voucher, no balance, no withdrawal changes.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  fieldsErrorEnvelope,
  newUuidV7,
  type AuditPort,
  type Clock,
  type HandlerResult,
  type Idempotency,
  type IdempotentResponse,
} from '../../platform/index.ts';
import { readingTimeAcceptable } from '../domain/watermark.ts';
import { createWatermarkReader, lockWatermarkChannel } from './watermark.ts';

/** The audit action of the contract. */
export const PAYOUT_WATERMARK_CREATE_AUDIT_ACTION = 'payout_watermark_create';

const PATH = '/admin/v1/payout-watermarks';

export interface AdminPayoutWatermarkNameReader {
  /** admin_id → display name; unknown ids are left out and shown as null. */
  displayNames(appId: string, adminIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

/** What app.module hands in: the other modules' ports (payout imports neither of them). */
export interface AdminPayoutWatermarkPorts {
  /** Binds the audit port to a transaction handle (app.module: admin's createAuditWriter). */
  readonly auditWriter: (db: Kysely<DB>, clock: Clock) => AuditPort;
  /** admin's createAdminDisplayNameReader. */
  readonly adminNames: (db: Kysely<DB>) => AdminPayoutWatermarkNameReader;
}

export interface AdminPayoutWatermarkDeps {
  readonly clock: Clock;
  readonly idempotency: Idempotency;
  readonly ports: AdminPayoutWatermarkPorts;
}

/** The guard's verified admin account and the request's address (for the audit row). */
export interface PayoutWatermarkOperator {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface PayoutWatermarkWrite {
  readonly body: Schema<'AdminPayoutWatermarkCreateRequest'>;
  /** The Idempotency-Key header, or undefined (→ 20001 by the idempotency module). */
  readonly key: string | undefined;
  readonly traceId: string;
}

function fieldsRefusal(fields: readonly string[], traceId: string): HandlerResult {
  const refused = fieldsErrorEnvelope(fields, traceId);
  return { status: refused.statusCode, envelope: refused.body };
}

/** One reading of a channel's balance: the row and its audit record, in one transaction. */
export function createAdminPayoutWatermark(
  deps: AdminPayoutWatermarkDeps,
  operator: PayoutWatermarkOperator,
  request: PayoutWatermarkWrite,
): Promise<IdempotentResponse> {
  const { appId, adminId } = operator;
  const { body, traceId } = request;
  return deps.idempotency.executeInTransaction(
    {
      appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: adminId },
      method: 'POST',
      path: PATH,
      key: request.key,
      body,
      traceId,
    },
    async (trx): Promise<HandlerResult> => {
      // A JSON number above 2^53 − 1 has already lost its exact value: never store it.
      if (!Number.isSafeInteger(body.available_fen)) {
        return fieldsRefusal(['available_fen'], traceId);
      }
      const note = body.note?.trim();
      if (note !== undefined && note === '') return fieldsRefusal(['note'], traceId);
      const now = deps.clock.now();
      // The route schema's date-time format has already validated the text.
      const measuredMs = Date.parse(body.measured_at);
      if (!readingTimeAcceptable({ now, measuredMs, latest: null })) {
        return fieldsRefusal(['measured_at'], traceId);
      }
      await lockWatermarkChannel(trx, appId, body.channel);
      const latest = await createWatermarkReader().latest(trx, { appId, channel: body.channel });
      if (!readingTimeAcceptable({ now, measuredMs, latest })) {
        return fieldsRefusal(['measured_at'], traceId);
      }

      const watermarkId = newUuidV7(now);
      const measuredAt = structuredClone(now);
      measuredAt.setTime(measuredMs);
      const amount = BigInt(body.available_fen);
      await trx
        .withSchema('app')
        .insertInto('payout_watermarks')
        .values({
          id: watermarkId,
          app_id: appId,
          channel: body.channel,
          available_fen: amount,
          measured_at: measuredAt,
          entered_by: adminId,
          created_at: now,
        })
        .execute();
      await deps.ports.auditWriter(trx, deps.clock).append({
        appId,
        actor: adminId,
        action: PAYOUT_WATERMARK_CREATE_AUDIT_ACTION,
        target: watermarkId,
        before: null,
        after: {
          watermark_id: watermarkId,
          channel: body.channel,
          available_fen: amount.toString(),
          measured_at: measuredAt.toISOString(),
          ...(note === undefined ? {} : { note }),
        },
        ip: operator.ip,
      });
      const names = await deps.ports.adminNames(trx).displayNames(appId, [adminId]);
      const data: Schema<'AdminPayoutWatermarkResult'> = {
        watermark: {
          watermark_id: watermarkId,
          channel: body.channel,
          available_fen: body.available_fen,
          measured_at: measuredAt.toISOString(),
          entered_by: adminId,
          entered_by_name: names.get(adminId) ?? null,
          created_at: now.toISOString(),
        },
      };
      return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
    },
  );
}
