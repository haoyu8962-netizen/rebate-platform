// B2-06e: the query job of the payout process (规划/08 BR-WDR-14, BR-WDR-15, BR-WDR-17, BR-WDR-28;
// state machine W5 / W6). createQueryJob(options) is the handler of queue `payout`, job name
// `query`, payload QueryJobPayload { withdrawal_id, execute_seq, app_id, point } (B2-06d enqueues
// point 0; B2-06f registers the handler). Strict order:
//   ① read the withdrawal (app_id and id of the payload, row lock FOR NO KEY UPDATE). Missing,
//      status ≠ PAYING or execute_seq ≠ the payload's → resolve; nothing written, no query.
//   ② needs_manual = true → resolve: automatic queries have stopped (W10's "query now" is B2-09).
//      B2-06h (BR-WDR-17): a transfer attempt of the withdrawal recorded as payer-side (result
//      fail, response kind payer_side: the release judged it, its W9 did not commit) → W9 PAYING →
//      APPROVED hold_reason payer_side_after_transfer (CAS) on this transaction, as the release's
//      ② does; no query, no W6, no next point. Only that durable record counts: a transfer attempt
//      still pending (an ordinary unknown, an unknown_code pause, a crash) is queried as before.
//   ③ T = `at` of the withdrawal's earliest kind=transfer attempt; none → warn and resolve.
//   ④ manualDue(schedule, T, now) → CAS needs_manual = true (row_version + 1, status and amounts
//      unchanged), logger.warn({ withdrawal_id, out_biz_no, point }, 'payout_needs_manual'), no
//      query, no job. needs_manual is granted to couli_payout only (db/schema.sql).
//   ⑤ otherwise channels[payout_channel].query(out_biz_no) at most 3 times, sleep(10 000) between
//      two tries (injected port; default the platform timers); each try writes one kind=query
//      payout_attempts row on attemptsDb (request { out_biz_no, point, try } with try 1, 2, 3,
//      the raw response, resp_code, resp_sub_code, result, latency_ms). success / fail stop the
//      tries. Timeouts, network errors, "order does not exist", processing and statuses outside
//      payout.query_status_map are unknown (the channel judges with the lists).
//   ⑥ success → W5 as in transfer-job.ts (CHANNEL_SUCCESS → PAID_API, channel_order_id, paid_at
//      the channel's time else Clock.now, WITHDRAW:SUCCESS:CASH_<channel> `wd:{id}:PAID`, event);
//      fail → W6 (CHANNEL_FAIL → FAILED, fail_code = sub_code, else the mapped order status,
//      WITHDRAW:RETURN, event); 3 times
//      unknown → stays PAYING and, on one transaction, the next point:
//        queue.send('payout', 'query', { …, point: n + 1 }, { trx,
//          singletonKey: `${withdrawal_id}:${execute_seq}:query:${n + 1}`,
//          delaySeconds: max(0, min(T + queryPointOffsetSeconds(n + 1), T + manual_after) − now) })
//      (the next job never lands after T + manual_after, so that decision is taken on time even
//      when manual_after_min is not one of the points).
//      A CAS that hits nothing (row_version moved) only warns. A query never pauses the queue.
// B2-09s (BR-WDR-15, D10-596 ①): source = 'manual' is 【立即查询】 from the disposal page. It skips all of
// the above: a withdrawal waiting for a person or returned by W9 is asked once, one kind=query row is
// written and nothing moves.
// B2-07c (BR-WDR-23 ①; 编排裁定 D10-415 ②, D10-416): the reconciliation's immediate query carries
// source = 'recon' in its payload. Its result not a success (a definite failure, or unknown after
// the three tries) → no W6 and no next point: on one couli_payout transaction the attempt, the
// conditional update `status = 'PAYING' AND needs_manual = false` → needs_manual = true
// (row_version + 1, still PAYING) and, when it hit the row, the worker's `manual_diff` on queue
// payout-recon (the R2 diff and alert are the worker's, deduplicated per withdrawal). A success
// lands as usual. Against the race, an ordinary query's definite failure goes the same way, not
// W6, when recon_channel (read only for couli_payout) already shows the bill's success for this
// out_biz_no (a channel_status that payout.query_status_map maps to success).
// review-money r1 S1: the reconciliation's query that finds the withdrawal no longer PAYING under
// its execute_seq and not PAID_* (another landing came first; or its W9 here), or that ends in a
// success handed to landing, or in a needs_manual update that hit nothing, sends the worker's
// `recon_check` on the same transaction: the worker rereads the withdrawal and registers ③
// (diff, recon_diff hold, alert) when the bill paid what ours returned.
// No transaction or lock is held across a channel call or a sleep (the ① read ends before ⑤).
// payout.enabled = off and payout.queue_paused = true do not stop queries (BR-WDR-17). Logs carry
// withdrawal_id, out_biz_no, point, code, sub_code only — never the payee's account or name.
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Logger } from 'pino';
import type { Ledger } from '../../ledger/index.ts';
import type { Clock, EventBus, JobHandler, JobQueue, ReceivedJob } from '../../platform/index.ts';
import type { QueryResult } from '../domain/channel-result.ts';
import { readPayoutChannelConfig } from '../application/judgement.ts';
import { handoffLanding, recordedResponse } from '../application/landing-handoff.ts';
import { holdWithdrawal } from '../application/transfer-gates.ts';
import { markNeedsManual, PAYOUT_MANUAL_QUERY_SOURCE } from '../application/query-manual.ts';
import { manualDue, nextQueryDueMs, type QuerySchedule } from '../application/query-schedule.ts';
import {
  PAYOUT_RECON_SOURCE,
  sendReconCheck,
  sendReconManualDiff,
} from '../application/recon-schedule.ts';
import type { WithdrawApplyOptions } from '../application/withdraw-apply.ts';
import type { PayoutConfigPort } from '../application/withdraw-rules.ts';
import type {
  ChannelJudgement,
  PayoutChannel,
  PayoutChannelName,
} from '../infra/channels/payout-channel.ts';
import { PAYOUT_QUERY_JOB, PAYOUT_QUEUE, type QueryJobPayload } from './transfer-job.ts';

export type { QueryJobPayload } from './transfer-job.ts';

/** The alert line when T + manual_after is reached (BR-WDR-14). */
export type QueryAlertMessage = 'payout_needs_manual';

/** needs_manual set because of the bill's success (D10-415 ②). */
export type QueryReconManualMessage = 'payout_needs_manual_by_bill';

/** Waits `ms` milliseconds (the gap between two tries of one point). */
export type QuerySleep = (ms: number) => Promise<void>;

export interface QueryJobLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface QueryJobOptions {
  /** Business handle: withdrawals, ledger, config, events and same-transaction jobs. */
  readonly db: Kysely<DB>;
  /** couli_payout handle: payout_attempts and withdrawals.needs_manual. */
  readonly attemptsDb: Kysely<DB>;
  readonly clock: Clock;
  /** content's configuration reader (payout.query_schedule, payout.query_status_map), direct PG. */
  readonly config: PayoutConfigPort;
  readonly ledger: Ledger;
  /** identity's users row lock (module lock order: users → balances). */
  readonly lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  readonly queue: JobQueue;
  readonly eventBus: EventBus;
  /** One adapter per opened channel (B2-06b); FakeChannel outside prod. */
  readonly channels: Readonly<Partial<Record<PayoutChannelName, PayoutChannel>>>;
  /** Default: the platform timers. */
  readonly sleep?: QuerySleep;
  readonly logger: QueryJobLogger;
}

/** BR-WDR-14: at most this many tries per point, this many milliseconds apart. */
const MAX_TRIES = 3;
const RETRY_GAP_MS = 10_000;
const PAYING = 'PAYING';
const PAID: ReadonlySet<string> = new Set(['PAID_API', 'PAID_MANUAL']);
const CHANNELS: ReadonlySet<string> = new Set(['alipay', 'bank_card', 'wechat']);
const RECON_MANUAL_ALERT: QueryReconManualMessage = 'payout_needs_manual_by_bill';

/** The chain's payload and whether the reconciliation sent it (source = 'recon'). */
interface ParsedQuery extends QueryJobPayload {
  readonly recon: boolean;
  /** B2-09s: 【立即查询】 of the disposal page (source = 'manual'). */
  readonly manual: boolean;
  /** The request's id, the same on every redelivery of its job (one attempt per request). */
  readonly manualRequestId: string | null;
}

interface QueryRow {
  readonly id: string;
  readonly app_id: string;
  readonly user_id: string;
  readonly status: string;
  readonly execute_seq: number;
  readonly row_version: number;
  readonly needs_manual: boolean;
  readonly amount_fen: bigint;
  readonly net_fen: bigint;
  readonly fee_fen: bigint;
  readonly tax_fen: bigint;
  readonly out_biz_no: string;
  readonly payout_channel: string;
}

type Prepared =
  | { readonly kind: 'done' }
  | { readonly kind: 'manual'; readonly row: QueryRow }
  | {
      readonly kind: 'query';
      readonly row: QueryRow;
      readonly firstTransferAt: Date;
      readonly schedule: QuerySchedule;
      /** The app's judgement lists, read with the schedule (BR-WDR-28 query_status_map). */
      readonly judgement: ChannelJudgement;
    };

/** processed_events.consumer of 【立即查询】: one kind=query attempt per request. */
const MANUAL_QUERY_CONSUMER = 'payout-manual-query';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parsePayload(job: ReceivedJob): ParsedQuery | null {
  const payload = job.payload as Record<string, unknown>;
  const withdrawalId = payload['withdrawal_id'];
  const executeSeq = payload['execute_seq'];
  const appId = payload['app_id'];
  const point = payload['point'];
  if (
    typeof withdrawalId !== 'string' ||
    withdrawalId === '' ||
    typeof appId !== 'string' ||
    appId === '' ||
    typeof executeSeq !== 'number' ||
    !Number.isInteger(executeSeq) ||
    typeof point !== 'number' ||
    !Number.isInteger(point) ||
    point < 0
  ) {
    return null;
  }
  return {
    withdrawal_id: withdrawalId,
    execute_seq: executeSeq,
    app_id: appId,
    point,
    recon: payload['source'] === PAYOUT_RECON_SOURCE,
    manual: payload['source'] === PAYOUT_MANUAL_QUERY_SOURCE,
    manualRequestId:
      typeof payload['manual_request_id'] === 'string' ? payload['manual_request_id'] : null,
  };
}

function isChannel(value: string): value is PayoutChannelName {
  return CHANNELS.has(value);
}

async function defaultSleep(ms: number): Promise<void> {
  await wait(ms);
}

export function createQueryJob(options: QueryJobOptions): JobHandler {
  const { db, attemptsDb, clock, config, queue, eventBus, channels, logger } = options;
  const sleep = options.sleep ?? defaultSleep;
  /** readPayoutChannelConfig wants pino's warn; the job's logger has the same two-argument shape. */
  const configLogger = {
    warn: (fields: Record<string, unknown>, message?: string) => logger.warn(fields, message ?? ''),
  } as unknown as Pick<Logger, 'warn'>;

  async function readRow(
    trx: Transaction<DB>,
    appId: string,
    withdrawalId: string,
  ): Promise<QueryRow | null> {
    const row = await trx
      .withSchema('app')
      .selectFrom('withdrawals')
      .select([
        'id',
        'app_id',
        'user_id',
        'status',
        'execute_seq',
        'row_version',
        'needs_manual',
        'amount_fen',
        'net_fen',
        'fee_fen',
        'tax_fen',
        'out_biz_no',
        'payout_channel',
      ])
      .where('app_id', '=', appId)
      .where('id', '=', withdrawalId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    return row ?? null;
  }

  /** T: `at` of the withdrawal's earliest kind=transfer attempt (any result); null without one. */
  async function firstTransferAt(trx: Transaction<DB>, row: QueryRow): Promise<Date | null> {
    const first = await trx
      .withSchema('app')
      .selectFrom('payout_attempts')
      .select((eb) => eb.fn.min('at').as('first_at'))
      .where('app_id', '=', row.app_id)
      .where('withdrawal_id', '=', row.id)
      .where('kind', '=', 'transfer')
      .executeTakeFirst();
    const at = first?.first_at ?? null;
    return at instanceof Date ? at : null;
  }

  /** B2-06h: a transfer attempt of the withdrawal completed with a payer_side result. */
  async function payerSideRecorded(trx: Transaction<DB>, row: QueryRow): Promise<boolean> {
    const found = await trx
      .withSchema('app')
      .selectFrom('payout_attempts')
      .select(['kind', 'result', sql<string | null>`response->>'kind'`.as('response_kind')])
      .where('app_id', '=', row.app_id)
      .where('withdrawal_id', '=', row.id)
      .where('kind', '=', 'transfer')
      .where('result', '=', 'fail')
      .where(sql<string | null>`response->>'kind'`, '=', 'payer_side')
      .execute();
    // Only a row that explicitly carries every column counts; a row lacking them is not one.
    return found.some(
      (a) => a.kind === 'transfer' && a.result === 'fail' && a.response_kind === 'payer_side',
    );
  }

  /** S1: the worker's recon_check of the reconciliation's query, due at once (round 0). */
  async function reconCheck(
    trx: Transaction<DB>,
    payload: QueryJobPayload,
    delaySeconds: number,
  ): Promise<void> {
    await sendReconCheck(
      queue,
      trx,
      {
        app_id: payload.app_id,
        withdrawal_id: payload.withdrawal_id,
        execute_seq: payload.execute_seq,
        round: 0,
      },
      delaySeconds,
    );
    logger.info(
      { withdrawal_id: payload.withdrawal_id, point: payload.point },
      'payout_query_recon_check_sent',
    );
  }

  /** ① to ④'s decision on one short business transaction (the row lock ends with it). */
  async function prepare(payload: ParsedQuery, now: Date): Promise<Prepared> {
    return db.transaction().execute(async (trx): Promise<Prepared> => {
      const row = await readRow(trx, payload.app_id, payload.withdrawal_id);
      if (row === null || row.status !== PAYING || row.execute_seq !== payload.execute_seq) {
        // S1: the bill paid it, ours left PAYING otherwise (W6, W9, …) → the worker judges ③.
        if (payload.recon && row !== null && !PAID.has(row.status)) {
          await reconCheck(trx, payload, 0);
        }
        logger.info(
          {
            withdrawal_id: payload.withdrawal_id,
            execute_seq: payload.execute_seq,
            point: payload.point,
            status: row?.status ?? null,
          },
          'payout_query_skipped',
        );
        return { kind: 'done' };
      }
      if (row.needs_manual) {
        logger.info(
          { withdrawal_id: row.id, out_biz_no: row.out_biz_no, point: payload.point },
          'payout_query_stopped_manual',
        );
        return { kind: 'done' };
      }
      if (await payerSideRecorded(trx, row)) {
        await holdWithdrawal(trx, { eventBus, logger }, row, 'payer_side_after_transfer', now);
        logger.info(
          {
            withdrawal_id: row.id,
            out_biz_no: row.out_biz_no,
            point: payload.point,
            hold_reason: 'payer_side_after_transfer',
          },
          'payout_query_payer_side_held',
        );
        if (payload.recon) await reconCheck(trx, payload, 0);
        return { kind: 'done' };
      }
      const t = await firstTransferAt(trx, row);
      if (t === null) {
        logger.warn(
          { withdrawal_id: row.id, out_biz_no: row.out_biz_no, point: payload.point },
          'payout_query_no_transfer',
        );
        return { kind: 'done' };
      }
      const channelConfig = await readPayoutChannelConfig(row.app_id, trx, config, configLogger);
      const { querySchedule } = channelConfig;
      if (manualDue(querySchedule, t, now)) return { kind: 'manual', row };
      return {
        kind: 'query',
        row,
        firstTransferAt: t,
        schedule: querySchedule,
        judgement: {
          lists: {
            definiteFailCodes: channelConfig.definiteFailCodes,
            payerSideCodes: channelConfig.payerSideCodes,
            queryStatusMap: channelConfig.queryStatusMap,
          },
        },
      };
    });
  }

  async function recordTry(
    executor: Kysely<DB> | Transaction<DB>,
    row: QueryRow,
    point: number,
    tryNo: number,
    result: QueryResult | null,
    errorName: string | null,
    latencyMs: number,
    at: Date,
    manualRequestId?: string,
  ): Promise<string> {
    const id = randomUUID();
    await executor
      .withSchema('app')
      .insertInto('payout_attempts')
      .values({
        id,
        app_id: row.app_id,
        withdrawal_id: row.id,
        kind: 'query',
        request: JSON.stringify({
          out_biz_no: row.out_biz_no,
          point,
          try: tryNo,
          ...(manualRequestId === undefined ? {} : { manual_request_id: manualRequestId }),
        }),
        response: JSON.stringify(
          result === null
            ? { transport_error: true, error: errorName, received_at: at.toISOString() }
            : recordedResponse(result, at),
        ),
        resp_code: result?.raw.code ?? null,
        resp_sub_code: result?.raw.subCode ?? null,
        result: result?.kind ?? 'unknown',
        latency_ms: latencyMs,
        at,
      })
      .execute();
    return id;
  }

  /**
   * D10-415 ②'s evidence: a recon_channel row of this out_biz_no whose channel status the app's
   * query_status_map maps to success (the bill shows the transfer paid).
   */
  async function billSuccessRecorded(
    trx: Transaction<DB>,
    row: QueryRow,
    statusMap: ChannelJudgement['lists']['queryStatusMap'],
  ): Promise<boolean> {
    const found = await trx
      .withSchema('app')
      .selectFrom('recon_channel')
      .select('channel_status')
      .where('app_id', '=', row.app_id)
      .where('out_biz_no', '=', row.out_biz_no)
      .where('channel_status', 'is not', null)
      .execute();
    return found.some(
      (r) =>
        r.channel_status !== null &&
        Object.hasOwn(statusMap, r.channel_status) &&
        statusMap[r.channel_status] === 'success',
    );
  }

  /**
   * D10-415 ②: needs_manual = true on `status = 'PAYING' AND needs_manual = false` (no W6), and the
   * worker's manual_diff on the same transaction when the update hit the row (D10-416).
   */
  async function manualByBill(
    trx: Transaction<DB>,
    row: QueryRow,
    point: number,
    now: Date,
    recon: boolean,
  ): Promise<boolean> {
    const fields = { withdrawal_id: row.id, out_biz_no: row.out_biz_no, point, recon };
    const updated = await trx
      .withSchema('app')
      .updateTable('withdrawals')
      .set((eb) => ({
        needs_manual: true,
        row_version: eb('row_version', '+', 1),
        updated_at: now,
      }))
      .where('app_id', '=', row.app_id)
      .where('id', '=', row.id)
      .where('execute_seq', '=', row.execute_seq)
      .where('status', '=', PAYING)
      .where('needs_manual', '=', false)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) {
      logger.info(fields, 'payout_query_by_bill_skipped');
      return false;
    }
    logger.warn(fields, RECON_MANUAL_ALERT);
    await sendReconManualDiff(queue, trx, {
      app_id: row.app_id,
      withdrawal_id: row.id,
      execute_seq: row.execute_seq,
    });
    return true;
  }

  /** The QueryJobPayload of `row` at `point` (for the worker's recon_check). */
  function payloadOf(row: QueryRow, point: number): QueryJobPayload {
    return { withdrawal_id: row.id, execute_seq: row.execute_seq, app_id: row.app_id, point };
  }

  /** ⑤: up to MAX_TRIES queries, RETRY_GAP_MS apart; the first success / fail ends the point. */
  async function queryPoint(
    row: QueryRow,
    adapter: PayoutChannel,
    point: number,
    judgement: ChannelJudgement,
    recon: boolean,
  ): Promise<QueryResult | null> {
    let last: QueryResult | null = null;
    for (let tryNo = 1; tryNo <= MAX_TRIES; tryNo += 1) {
      if (tryNo > 1) await sleep(RETRY_GAP_MS);
      const started = clock.now();
      let result: QueryResult | null = null;
      let errorName: string | null = null;
      try {
        result = await adapter.query(row.out_biz_no, judgement);
      } catch (error: unknown) {
        errorName = error instanceof Error ? error.name : 'unknown';
        logger.warn(
          {
            withdrawal_id: row.id,
            out_biz_no: row.out_biz_no,
            point,
            try: tryNo,
            error: errorName,
          },
          'payout_query_transport_error',
        );
      }
      const finished = clock.now();
      const latencyMs = Math.max(0, finished.getTime() - started.getTime());
      if (result !== null && result.kind !== 'unknown') {
        // A settled result: recorded and handed to the worker on one couli_payout transaction
        // (D10-326 C; the withdrawal is re-read there, D10-332 ①).
        await attemptsDb.transaction().execute(async (trx) => {
          const attemptId = await recordTry(
            trx,
            row,
            point,
            tryNo,
            result,
            errorName,
            latencyMs,
            finished,
          );
          const byBill =
            result.kind === 'fail' &&
            (recon || (await billSuccessRecorded(trx, row, judgement.lists.queryStatusMap)));
          // S1: a recon query's success handed to landing (an earlier W6 may still beat it), or a
          // needs_manual update that hit nothing → the worker's recon_check judges ③ after landing.
          let hit = false;
          if (byBill) hit = await manualByBill(trx, row, point, finished, recon);
          else await handoffLanding({ trx, queue, row, attemptId, logger });
          if (recon && !hit) await reconCheck(trx, payloadOf(row, point), 0);
        });
      } else {
        await recordTry(attemptsDb, row, point, tryNo, result, errorName, latencyMs, finished);
      }
      logger.info(
        {
          withdrawal_id: row.id,
          out_biz_no: row.out_biz_no,
          point,
          try: tryNo,
          code: result?.raw.code ?? null,
          sub_code: result?.raw.subCode ?? null,
          result: result?.kind ?? 'unknown',
          latency_ms: latencyMs,
        },
        'payout_query_result',
      );
      last = result;
      if (result !== null && result.kind !== 'unknown') return result;
    }
    return last;
  }

  /** ⑥ unknown: the next point's job on one transaction (deduplicated by its singletonKey). */
  async function sendNextPoint(
    row: QueryRow,
    schedule: QuerySchedule,
    firstTransfer: Date,
    point: number,
    now: Date,
  ): Promise<void> {
    const next = point + 1;
    const dueMs = nextQueryDueMs(schedule, firstTransfer, next);
    const delaySeconds = Math.max(0, Math.ceil((dueMs - now.getTime()) / 1000));
    const payload: QueryJobPayload = {
      withdrawal_id: row.id,
      execute_seq: row.execute_seq,
      app_id: row.app_id,
      point: next,
    };
    await db
      .transaction()
      .execute((trx) =>
        queue.send(
          PAYOUT_QUEUE,
          PAYOUT_QUERY_JOB,
          { ...payload },
          { trx, singletonKey: `${row.id}:${row.execute_seq}:query:${next}`, delaySeconds },
        ),
      );
    logger.info(
      {
        withdrawal_id: row.id,
        out_biz_no: row.out_biz_no,
        point: next,
        delay_seconds: delaySeconds,
      },
      'payout_query_scheduled',
    );
  }

  /**
   * B2-09s (BR-WDR-15, D10-595 ③, D10-596 ①): 【立即查询】. Only a withdrawal waiting for a person or
   * returned by W9, once, and one kind=query row: never a transition, a voucher, a next point or a
   * transfer, whatever the channel answers. A person ends the withdrawal.
   */
  async function manualQuery(payload: ParsedQuery): Promise<void> {
    const requestId = payload.manualRequestId;
    if (requestId === null || !UUID.test(requestId)) {
      logger.warn({ withdrawal_id: payload.withdrawal_id }, 'payout_query_bad_payload');
      return;
    }
    const claimed = (executor: Kysely<DB>): Promise<{ event_id: string } | undefined> =>
      executor
        .withSchema('app')
        .selectFrom('processed_events')
        .select('event_id')
        .where('consumer', '=', MANUAL_QUERY_CONSUMER)
        .where('event_id', '=', requestId)
        .executeTakeFirst();
    // A redelivery after the record committed: a second answer must not become the latest query.
    if ((await claimed(attemptsDb)) !== undefined) {
      logger.info({ withdrawal_id: payload.withdrawal_id }, 'payout_manual_query_already_recorded');
      return;
    }
    const row = await db.transaction().execute(async (trx) => {
      const found = await readRow(trx, payload.app_id, payload.withdrawal_id);
      if (found === null || found.execute_seq !== payload.execute_seq) return null;
      const held = await trx
        .withSchema('app')
        .selectFrom('withdrawals')
        .select('hold_reason')
        .where('app_id', '=', found.app_id)
        .where('id', '=', found.id)
        .executeTakeFirst();
      const waiting = found.status === PAYING && found.needs_manual;
      const returned =
        found.status === 'APPROVED' && held?.hold_reason === 'payer_side_after_transfer';
      return waiting || returned ? found : null;
    });
    const fields = { withdrawal_id: payload.withdrawal_id, execute_seq: payload.execute_seq };
    if (row === null) {
      logger.info(fields, 'payout_manual_query_skipped');
      return;
    }
    const adapter = isChannel(row.payout_channel) ? channels[row.payout_channel] : undefined;
    if (adapter === undefined) {
      logger.warn({ ...fields, channel: row.payout_channel }, 'payout_query_no_channel');
      return;
    }
    const channelConfig = await readPayoutChannelConfig(row.app_id, db, config, configLogger);
    const judgement: ChannelJudgement = {
      lists: {
        definiteFailCodes: channelConfig.definiteFailCodes,
        payerSideCodes: channelConfig.payerSideCodes,
        queryStatusMap: channelConfig.queryStatusMap,
      },
    };
    const started = clock.now();
    let result: QueryResult | null = null;
    let errorName: string | null = null;
    try {
      result = await adapter.query(row.out_biz_no, judgement);
    } catch (error: unknown) {
      errorName = error instanceof Error ? error.name : 'unknown';
      logger.warn({ ...fields, error: errorName }, 'payout_query_transport_error');
    }
    const finished = clock.now();
    const latencyMs = Math.max(0, finished.getTime() - started.getTime());
    // The claim and the attempt commit together, on the primary key of processed_events: a delivery
    // that finds the request claimed, or waits for and then loses to another, records nothing.
    await attemptsDb.transaction().execute(async (trx) => {
      const claim = await trx
        .withSchema('app')
        .insertInto('processed_events')
        .values({ consumer: MANUAL_QUERY_CONSUMER, event_id: requestId })
        .onConflict((oc) => oc.columns(['consumer', 'event_id']).doNothing())
        .returning('event_id')
        .executeTakeFirst();
      if (claim === undefined) return;
      await recordTry(
        trx,
        row,
        payload.point,
        1,
        result,
        errorName,
        latencyMs,
        finished,
        requestId,
      );
    });
  }

  return async function queryJob(job: ReceivedJob): Promise<void> {
    const payload = parsePayload(job);
    if (payload === null) {
      logger.warn({ job_id: job.id, queue: job.queue, name: job.name }, 'payout_query_bad_payload');
      return;
    }
    if (payload.manual) {
      await manualQuery(payload);
      return;
    }
    const now = clock.now();
    const prepared = await prepare(payload, now);
    if (prepared.kind === 'done') return;
    if (prepared.kind === 'manual') {
      // ④ after the read transaction: couli_payout's own connection must not wait on the row lock.
      await markNeedsManual(attemptsDb, prepared.row, payload.point, now, logger);
      return;
    }
    const { row, schedule } = prepared;
    const adapter = isChannel(row.payout_channel) ? channels[row.payout_channel] : undefined;
    if (adapter === undefined) {
      logger.warn(
        { withdrawal_id: row.id, out_biz_no: row.out_biz_no, channel: row.payout_channel },
        'payout_query_no_channel',
      );
      return;
    }
    // ⑤ outside any transaction.
    const result = await queryPoint(row, adapter, payload.point, prepared.judgement, payload.recon);
    const landedAt = clock.now();
    // ⑥
    if (result === null || result.kind === 'unknown') {
      if (payload.recon) {
        // D10-415 ②: the reconciliation's query still unknown → needs_manual, no next point.
        await attemptsDb.transaction().execute(async (trx) => {
          const hit = await manualByBill(trx, row, payload.point, landedAt, true);
          if (!hit) await reconCheck(trx, payload, 0);
        });
        return;
      }
      await sendNextPoint(row, schedule, prepared.firstTransferAt, payload.point, landedAt);
    }
    // success / fail: recorded and handed to the worker in queryPoint (jobs/landing-job.ts lands
    // W5 / W6; a query's fail_code falls back to the mapped order status there).
  };
}
