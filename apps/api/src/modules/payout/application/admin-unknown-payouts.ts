// B2-09s: D of FU-ADMIN-WITHDRAWAL-OPS, the disposal of withdrawals whose result stayed unknown
// (adminListUnknownPayouts, adminQueryPayoutResult, adminResolveUnknownPayout, CT-24zs; 08 BR-WDR-15,
// BR-WDR-14, BR-WDR-08 W10; 编排裁定 D10-595, D10-596, D10-625, D10-626, D10-628). The controller
// (http/admin/) only authorises through the AdminOperationGuard and takes the parameters.
//
// Query: queues one job on the caller's idempotent transaction and moves nothing. The payout process
// holds the channel keys; jobs/query-job.ts's manual branch asks once and appends one kind=query.
//
// Resolve, under the locks users row → balance row → withdrawal row, in the transactional mode of
// platform idempotency (2xxxx refusals are not stored):
//   paid    the same voucher, tax_ytd and event as W5, with resolver_ids, proof_file and
//           manual_resolution. Refused while the latest query is a definite failure and no bill line
//           says success (resolve_query_failed, D10-628): the member would be told money arrived
//           that the channel says did not, and that day's reconciliation has already run.
//   failed  every condition is the server's to check and none can be vouched for by the request.
//           Refunding money that left is a double payment. There is no read yet that tells a
//           downloaded bill without this line from a bill not downloaded, and not finding a line is
//           never taken as absent, so today every failed is refused and this file has no refund path
//           on purpose (D10-626). That path comes with its own task and rule tests.
import { randomUUID } from 'node:crypto';
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { buildVouchers, transitionWithdrawal } from '@couli/domain';
import { fenToJsonNumber } from '@couli/money';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Logger } from 'pino';
import type { Ledger } from '../../ledger/index.ts';
import {
  fieldsErrorEnvelope,
  type AuditPort,
  type Clock,
  type EventBus,
  type HandlerResult,
  type Idempotency,
  type IdempotentResponse,
  type JobQueue,
} from '../../platform/index.ts';
import { readPayoutChannelConfig } from './judgement.ts';
import { instant } from './payout-landing.ts';
import { PAYOUT_MANUAL_QUERY_SOURCE } from './query-manual.ts';
import { PAYOUT_RECON_CHANNEL, sendLatePaidCheck } from './recon-schedule.ts';
import {
  createTaxYtdAccumulator,
  type TaxYtdIdentityKeyReader,
  type TaxYtdLogger,
} from './tax-ytd.ts';
import type { WithdrawApplyOptions } from './withdraw-apply.ts';
import { CASH_SUBJECT, PAYER_SIDE_HOLD, postingEntries } from './withdrawal-proven-success.ts';
import { isChannelOrderIdCollision } from './withdrawal-manual-paid.ts';
import type { PayoutConfigPort } from './withdraw-rules.ts';

export const PAYOUT_QUERY_REQUEST_AUDIT_ACTION = 'payout_query_request';
export const WITHDRAWAL_RESOLVE_AUDIT_ACTION = 'withdrawal_resolve';

const PAYING = 'PAYING';
const APPROVED = 'APPROVED';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFLICT_MESSAGE = '状态已变化，请刷新后重试';
const HOUR_MS = 60 * 60 * 1000;
const FAIL_AFTER_MS = 24 * HOUR_MS;
/** 代理补全的默认 (contract): how far after the Clock a paid time may lie, as W8. */
const PAID_AT_TOLERANCE_MS = 5 * 60 * 1000;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const SAVEPOINT = sql.raw('payout_unknown_resolve');

type Blocker = Schema<'AdminUnknownPayoutFailBlocker'>;

export interface AdminUnknownPayoutReadDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** identity's masked phones: user_id → 3 + 4, or null without a phone (absent reads as null). */
  readonly phones: (
    appId: string,
    userIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string | null>>;
}

export interface AdminUnknownPayoutWriteDeps {
  readonly clock: Clock;
  readonly idempotency: Idempotency;
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  readonly queue: JobQueue;
  readonly eventBus: EventBus;
  readonly ledger: Ledger;
  readonly lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  readonly config: PayoutConfigPort;
  readonly identityKey: TaxYtdIdentityKeyReader;
  readonly logger: Pick<Logger, 'warn'> & TaxYtdLogger;
}

export interface UnknownPayoutOperator {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface UnknownPayoutWrite<Body> {
  readonly body: Body;
  /** The Idempotency-Key header, or undefined (→ 20001 by the idempotency module). */
  readonly key: string | undefined;
  readonly traceId: string;
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
      data: { resource: 'withdrawal' },
      trace_id: traceId,
    },
  };
}

/** What stops a failed resolution now, in the order of resolve's checks. */
function failBlockers(firstTransferAt: Date, now: Date): Blocker[] {
  const blockers: Blocker[] = [];
  if (now.getTime() - firstTransferAt.getTime() < FAIL_AFTER_MS) {
    blockers.push('resolve_too_early');
  }
  blockers.push('resolve_bill_unverifiable', 'resolve_query_unverifiable');
  return blockers;
}

function latestQueryView(row: {
  readonly result: string;
  readonly at: Date;
  readonly resp_code: string | null;
  readonly resp_sub_code: string | null;
  readonly response: unknown;
}): Schema<'AdminUnknownPayoutLatestQuery'> {
  const response =
    typeof row.response === 'object' && row.response !== null
      ? (row.response as Record<string, unknown>)
      : {};
  const text = (key: string): string | null => {
    const value = response[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  return {
    result: row.result as Schema<'AdminUnknownPayoutLatestQuery'>['result'],
    at: row.at.toISOString(),
    resp_code: row.resp_code,
    resp_sub_code: row.resp_sub_code,
    channel_status: text('status'),
    channel_order_id: text('channel_order_id'),
    paid_at: text('paid_at'),
  };
}

async function latestQuery(trx: Kysely<DB>, appId: string, withdrawalId: string) {
  return trx
    .withSchema('app')
    .selectFrom('payout_attempts')
    .select(['result', 'at', 'resp_code', 'resp_sub_code', 'response'])
    .where('app_id', '=', appId)
    .where('withdrawal_id', '=', withdrawalId)
    .where('kind', '=', 'query')
    .orderBy('at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
}

function firstTransferAt(trx: Kysely<DB>, appId: string, withdrawalId: string) {
  return trx
    .withSchema('app')
    .selectFrom('payout_attempts')
    .select('at')
    .where('app_id', '=', appId)
    .where('withdrawal_id', '=', withdrawalId)
    .where('kind', '=', 'transfer')
    .orderBy('at')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
}

/** The withdrawals of the app waiting for a person, longest waiting first. */
export async function listAdminUnknownPayouts(
  deps: AdminUnknownPayoutReadDeps,
  appId: string,
  query: { readonly page?: number; readonly page_size?: number },
): Promise<Schema<'AdminUnknownPayoutPage'>> {
  const page = query.page ?? DEFAULT_PAGE;
  const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
  const now = deps.clock.now();
  const base = deps.db
    .withSchema('app')
    .selectFrom('withdrawals as w')
    .where('w.app_id', '=', appId)
    .where('w.status', '=', PAYING)
    .where('w.needs_manual', '=', true);
  const counted = await base.select(sql<string>`count(*)::text`.as('total')).executeTakeFirst();
  const rows = await base
    .select([
      'w.id',
      'w.out_biz_no',
      'w.user_id',
      'w.payout_channel',
      'w.amount_fen',
      'w.net_fen',
      (eb) =>
        eb
          .selectFrom('payout_attempts as a')
          .select((inner) => inner.fn.min('a.at').as('first_at'))
          .whereRef('a.app_id', '=', 'w.app_id')
          .whereRef('a.withdrawal_id', '=', 'w.id')
          .where('a.kind', '=', 'transfer')
          .as('first_transfer_at'),
    ])
    .orderBy('first_transfer_at')
    .orderBy('w.id')
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .execute();
  const phones = await deps.phones(appId, [...new Set(rows.map((row) => row.user_id))]);
  const items: Schema<'AdminUnknownPayoutItem'>[] = [];
  for (const row of rows) {
    const firstAt = row.first_transfer_at as Date | null;
    if (firstAt === null) throw new Error(`payout: needs_manual without a transfer: ${row.id}`);
    const latest = await latestQuery(deps.db, appId, row.id);
    items.push({
      withdrawal_id: row.id,
      out_biz_no: row.out_biz_no,
      user: { user_id: row.user_id, phone_masked: phones.get(row.user_id) ?? null },
      payout_channel: row.payout_channel as Schema<'AdminUnknownPayoutItem'>['payout_channel'],
      amount_fen: fenToJsonNumber(row.amount_fen),
      net_fen: fenToJsonNumber(row.net_fen),
      first_transfer_at: firstAt.toISOString(),
      latest_query: latest === undefined ? null : latestQueryView(latest),
      fail_blockers: failBlockers(firstAt, now),
    });
  }
  return { items, page, page_size: pageSize, total: Number(counted?.total ?? 0) };
}

/** Queues one query of a withdrawal waiting for a person, or returned by W9. */
export function queryAdminPayoutResult(
  deps: AdminUnknownPayoutWriteDeps,
  operator: UnknownPayoutOperator,
  rawId: string,
  request: UnknownPayoutWrite<Schema<'AdminPayoutQueryRequest'>>,
): Promise<IdempotentResponse> {
  const { appId, adminId } = operator;
  const { traceId } = request;
  return deps.idempotency.executeInTransaction(
    {
      appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: adminId },
      method: 'POST',
      // Encoded: the idempotency path refuses ? and #, and a bad id must reach the 20001 below.
      path: `/admin/v1/withdrawals/${encodeURIComponent(rawId)}/query`,
      key: request.key,
      body: request.body,
      traceId,
    },
    async (trx): Promise<HandlerResult> => {
      if (!UUID.test(rawId)) return fieldsRefusal(['withdrawal_id'], traceId);
      const id = rawId.toLowerCase();
      const row = await trx
        .withSchema('app')
        .selectFrom('withdrawals')
        .select(['status', 'needs_manual', 'hold_reason', 'execute_seq'])
        .where('app_id', '=', appId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return fieldsRefusal(['withdrawal_id'], traceId);
      const waiting = row.status === PAYING && row.needs_manual;
      const returned = row.status === APPROVED && row.hold_reason === PAYER_SIDE_HOLD;
      if (!waiting && !returned) return conflictRefusal(traceId);
      // Stable across redeliveries of this job: the job records one attempt per request.
      const manualRequestId = randomUUID();
      await deps.queue.send(
        'payout',
        'query',
        {
          withdrawal_id: id,
          execute_seq: row.execute_seq,
          app_id: appId,
          point: 0,
          source: PAYOUT_MANUAL_QUERY_SOURCE,
          manual_request_id: manualRequestId,
        },
        { trx, singletonKey: `${id}:${row.execute_seq}:manual:${manualRequestId}` },
      );
      await deps.auditOn(trx).append({
        appId,
        actor: adminId,
        action: PAYOUT_QUERY_REQUEST_AUDIT_ACTION,
        target: id,
        before: null,
        after: { withdrawal_id: id, status: row.status },
        ip: operator.ip,
      });
      const data: Schema<'AdminPayoutQuerySubmitted'> = {
        withdrawal_id: id,
        result: 'submitted',
      };
      return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
    },
  );
}

/** A recon_channel row of this out_biz_no whose status the app's query_status_map calls success. */
async function billShowsSuccess(
  trx: Transaction<DB>,
  appId: string,
  outBizNo: string,
  statusMap: Readonly<Record<string, string>>,
): Promise<boolean> {
  const rows = await trx
    .withSchema('app')
    .selectFrom('recon_channel')
    .select('channel_status')
    .where('app_id', '=', appId)
    .where('out_biz_no', '=', outBizNo)
    .where('channel_status', 'is not', null)
    .execute();
  return rows.some(
    (row) =>
      row.channel_status !== null &&
      Object.hasOwn(statusMap, row.channel_status) &&
      statusMap[row.channel_status] === 'success',
  );
}

/** W10 of one withdrawal of the operator's app. */
export function resolveAdminUnknownPayout(
  deps: AdminUnknownPayoutWriteDeps,
  operator: UnknownPayoutOperator,
  rawId: string,
  request: UnknownPayoutWrite<Schema<'AdminUnknownPayoutResolveRequest'>>,
): Promise<IdempotentResponse> {
  const { appId, adminId } = operator;
  const { body, traceId } = request;
  const taxYtd = createTaxYtdAccumulator({ identity: deps.identityKey, logger: deps.logger });
  return deps.idempotency.executeInTransaction(
    {
      appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: adminId },
      method: 'POST',
      path: `/admin/v1/withdrawals/${encodeURIComponent(rawId)}/resolve`,
      key: request.key,
      body,
      traceId,
    },
    async (trx): Promise<HandlerResult> => {
      const proof = body.proof_text.trim();
      const missing = [
        ...(proof === '' ? ['proof_text'] : []),
        ...(body.resolution === 'paid' && body.channel_order_id === undefined
          ? ['channel_order_id']
          : []),
        ...(body.resolution === 'paid' && body.paid_at === undefined ? ['paid_at'] : []),
      ];
      if (missing.length > 0) return fieldsRefusal(missing, traceId);
      if (!UUID.test(rawId)) return fieldsRefusal(['withdrawal_id'], traceId);
      const id = rawId.toLowerCase();
      const head = await trx
        .withSchema('app')
        .selectFrom('withdrawals')
        .select(['user_id', 'status', 'needs_manual'])
        .where('app_id', '=', appId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (head === undefined) return fieldsRefusal(['withdrawal_id'], traceId);
      if (head.status !== PAYING || !head.needs_manual) return conflictRefusal(traceId);

      await deps.lockUsersForUpdate(trx, { appId, userIds: [head.user_id] });
      const balances = await deps.ledger.lockBalances(trx, { appId, userIds: [head.user_id] });
      const balance = balances.find((entry) => entry.user_id === head.user_id);
      if (balance === undefined) throw new Error('payout: W10 without a balance row');
      const row = await trx
        .withSchema('app')
        .selectFrom('withdrawals')
        .select([
          'id',
          'user_id',
          'status',
          'needs_manual',
          'out_biz_no',
          'net_fen',
          'fee_fen',
          'tax_fen',
          'amount_fen',
          'payout_channel',
          'row_version',
          'created_at',
        ])
        .where('app_id', '=', appId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (row.status !== PAYING || !row.needs_manual) return conflictRefusal(traceId);
      const first = await firstTransferAt(trx, appId, id);
      if (first === undefined) return conflictRefusal(traceId);
      const now = deps.clock.now();

      if (body.resolution === 'failed') {
        const [reason] = failBlockers(first.at, now);
        return fieldsRefusal(['resolution'], traceId, reason);
      }

      const channelOrderId = body.channel_order_id as string;
      const lists = await readPayoutChannelConfig(appId, trx, deps.config, deps.logger);
      const latest = await latestQuery(trx, appId, id);
      if (
        latest?.result === 'fail' &&
        !(await billShowsSuccess(trx, appId, row.out_biz_no, lists.queryStatusMap))
      ) {
        return fieldsRefusal(['resolution'], traceId, 'resolve_query_failed');
      }
      const paidAtMs = Date.parse(body.paid_at as string);
      if (
        Number.isNaN(paidAtMs) ||
        paidAtMs > now.getTime() + PAID_AT_TOLERANCE_MS ||
        paidAtMs < first.at.getTime()
      ) {
        return fieldsRefusal(['paid_at'], traceId, 'resolve_paid_at_invalid');
      }
      const paidAt = instant(now, paidAtMs);
      const taken = await trx
        .withSchema('app')
        .selectFrom('withdrawals')
        .select('id')
        .where('app_id', '=', appId)
        .where('channel_order_id', '=', channelOrderId)
        .limit(1)
        .executeTakeFirst();
      const takenRefusal = () =>
        fieldsRefusal(['channel_order_id'], traceId, 'resolve_order_id_taken');
      if (taken !== undefined) return takenRefusal();
      const identity = await deps.identityKey.readIdentityKey(trx, {
        appId,
        userId: row.user_id,
      });
      if (identity === null) {
        return fieldsRefusal(['withdrawal_id'], traceId, 'resolve_identity_missing');
      }
      const subject = CASH_SUBJECT[row.payout_channel];
      if (subject === undefined) {
        throw new Error(`payout: no cash subject for ${row.payout_channel}`);
      }
      const transition = transitionWithdrawal('PAYING', 'MANUAL_RESOLVE');
      if (!transition.ok || transition.noop) return conflictRefusal(traceId);

      // A savepoint: losing the serial number to another transaction must not abort this one, so
      // the refusal can still be answered and nothing of this withdrawal stays.
      await sql`SAVEPOINT ${SAVEPOINT}`.execute(trx);
      let updated;
      try {
        updated = await trx
          .withSchema('app')
          .updateTable('withdrawals')
          .set({
            status: transition.to,
            paid_at: paidAt,
            channel_order_id: channelOrderId,
            manual_resolution: 'paid',
            resolver_ids: sql`${JSON.stringify([adminId])}::jsonb`,
            proof_file: proof,
            row_version: row.row_version + 1,
            updated_at: now,
          })
          .where('app_id', '=', appId)
          .where('id', '=', id)
          .where('status', '=', PAYING)
          .where('needs_manual', '=', true)
          .where('row_version', '=', row.row_version)
          .executeTakeFirst();
        await sql`RELEASE SAVEPOINT ${SAVEPOINT}`.execute(trx);
      } catch (error: unknown) {
        if (!isChannelOrderIdCollision(error)) throw error;
        await sql`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`.execute(trx);
        return takenRefusal();
      }
      if (updated.numUpdatedRows !== 1n) return conflictRefusal(traceId);

      const [voucher] = buildVouchers(`WITHDRAW:SUCCESS:${subject}`, {
        withdrawal_id: row.id,
        user_id: row.user_id,
        net_fen: row.net_fen,
        fee_fen: row.fee_fen,
        tax_fen: row.tax_fen,
      });
      if (voucher === undefined) throw new Error('payout: WITHDRAW:SUCCESS built no voucher');
      await deps.ledger.post(trx, {
        appId,
        uniqKey: voucher.uniq_key,
        bizType: 'withdrawal',
        bizId: row.id,
        operator: `admin:${adminId}`,
        memo: null,
        orderKey: null,
        beneficiaryUserId: null,
        role: null,
        voucherKind: null,
        entries: postingEntries(voucher.entries, balance.account_id),
      });
      await taxYtd.accumulate(trx, {
        appId,
        userId: row.user_id,
        withdrawalId: row.id,
        createdAt: row.created_at,
        amountFen: row.amount_fen,
        taxFen: row.tax_fen,
        now,
      });
      await deps.eventBus.publish(trx, {
        appId,
        name: 'wallet.withdrawal_changed',
        payload: { withdrawal_id: row.id, user_id: row.user_id, status: transition.to },
      });
      // B2-09u (BR-WDR-23): the paid_at a person gave may fall on a bill day R2 has finished,
      // which no later daily run picks; the worker's single check commits with it.
      if (row.payout_channel === PAYOUT_RECON_CHANNEL) {
        await sendLatePaidCheck(deps.queue, trx, { app_id: appId, withdrawal_id: id, round: 0 });
      }
      await deps.auditOn(trx).append({
        appId,
        actor: adminId,
        action: WITHDRAWAL_RESOLVE_AUDIT_ACTION,
        target: id,
        before: { withdrawal_id: id, status: PAYING },
        after: {
          withdrawal_id: id,
          status: transition.to,
          resolution: 'paid',
          channel_order_id: channelOrderId,
          paid_at: paidAt.toISOString(),
        },
        ip: operator.ip,
      });
      const data: Schema<'AdminUnknownPayoutResolved'> = {
        withdrawal_id: id,
        status: 'PAID_API',
        manual_resolution: 'paid',
        channel_order_id: channelOrderId,
        paid_at: paidAt.toISOString(),
      };
      return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
    },
  );
}
