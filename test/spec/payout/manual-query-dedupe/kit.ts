// B2-09y rule-test kit (claude-independent, SPEC_REF 18f0015e): FU-W10-QUERY-DEDUPE (编排 D10-702 ③,
// D10-707 ②; 08 BR-WDR-15, BR-WDR-14). The disposal page's 【立即查询】 (adminQueryPayoutResult) keeps at
// most one manual query of a withdrawal and execute_seq in flight: while one is queued, waiting for
// its retry or running, another click (another Idempotency-Key, or another person) answers submitted
// and records its audit but queues nothing; once that job is completed or finally failed a click
// queues a new one. Same-key replays, query-only (no transfer) and evidence-only (no state, no
// voucher) are unchanged.
// Real pieces: the admin entry and its started JOB_QUEUE (../admin-unknown-payouts/unknown-harness.ts),
// the payout queue's rows in pgboss.job, the real query job (jobs/query-job.ts) over fake channels.
// What the payout process's queue runtime does to a job row after its handler (completed; retry;
// active on the retry's run; failed once retries are spent) is written to pgboss.job directly as
// couli_app, which db/migrations/0002 grants UPDATE on the pgboss tables (the worker and payout
// roles move job rows the same way). The exclusive index there (job_i6: name +
// COALESCE(singleton_key, '') WHERE state <= 'active') is what holds a key in created / retry /
// active and releases it in completed / failed; expectHeld proves a moved row still holds its key.
// No sleep, no channel credentials, synthetic data only.
import { sql } from 'kysely';
import { expect, vi } from 'vitest';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import type { QueryResult } from '../../../../apps/api/src/modules/payout/domain/channel-result.ts';
import type { PayoutChannel } from '../../../../apps/api/src/modules/payout/infra/channels/payout-channel.ts';
import { createQueryJob } from '../../../../apps/api/src/modules/payout/jobs/query-job.ts';
import type { ReceivedJob } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  answer,
  audits,
  queuedQueries,
  textOf,
  type AdminSent,
  type ReviewFixture,
  type UnknownAdmin,
  type WithdrawalRow,
  type WriteOptions,
} from '../admin-unknown-payouts/unknown-harness.ts';
import { configPort } from '../proven-success/kit.ts';

/** The audit action of every click of 【立即查询】 (contract adminQueryPayoutResult). */
export const QUERY_AUDIT = 'payout_query_request';

/** One click of 【立即查询】 on `w`: always the submitted answer, contract checked. */
export async function click(
  h: UnknownAdmin,
  w: WithdrawalRow,
  options: WriteOptions = {},
): Promise<AdminSent> {
  const sent = await h.query(w.id, options);
  await answer(sent, 0, { withdrawal_id: w.id, result: 'submitted' });
  return sent;
}

/** The query jobs of the payout queue naming `w`, in the order they were queued. */
export async function jobsOf(f: ReviewFixture, w: WithdrawalRow): Promise<ReceivedJob[]> {
  return (await queuedQueries(f)).filter((job) => job.payload['withdrawal_id'] === w.id);
}

/** The ids of the query jobs naming `w`, in the order they were queued. */
export async function jobIdsOf(f: ReviewFixture, w: WithdrawalRow): Promise<string[]> {
  return (await jobsOf(f, w)).map((job) => job.id);
}

/** The manual request id the HTTP enqueue gave the job (a non-empty string). */
export function requestIdOf(job: ReceivedJob): string {
  const id = job.payload['manual_request_id'];
  expect(typeof id === 'string' && id !== '', `manual_request_id of job ${job.id}`).toBe(true);
  return id as string;
}

/** The pg-boss state of the job's row now. */
export async function stateOfJob(f: ReviewFixture, job: ReceivedJob): Promise<string> {
  const result = await sql<{ state: string }>`SELECT state::text AS state FROM pgboss.job
    WHERE name = 'payout' AND id = ${job.id}::uuid`.execute(f.db);
  expect(result.rows, `pgboss.job ${job.id}`).toHaveLength(1);
  return result.rows[0]!.state;
}

export type MovedState = 'retry' | 'active' | 'completed' | 'failed';

/**
 * The job's row as the payout process's queue leaves it: `completed` after its handler resolved,
 * `retry` after a failure with retries left, `active` while a run holds it, `failed` once the
 * retries are spent. Exactly this one row moves.
 */
export async function moveJob(f: ReviewFixture, job: ReceivedJob, to: MovedState): Promise<void> {
  const failure = to === 'retry' || to === 'failed';
  const ended = to === 'completed' || to === 'failed';
  const result = await sql`UPDATE pgboss.job SET
      state = ${to}::pgboss.job_state,
      retry_count = retry_count + ${to === 'retry' ? 1 : 0}::integer,
      started_on = CASE WHEN ${to === 'active'}::boolean THEN now() ELSE started_on END,
      completed_on = CASE WHEN ${ended}::boolean THEN now() ELSE completed_on END,
      output = CASE WHEN ${failure}::boolean
        THEN ${JSON.stringify({ error: 'handler_failed' })}::jsonb ELSE output END
    WHERE name = 'payout' AND id = ${job.id}::uuid`.execute(f.db);
  expect(result.numAffectedRows, `pgboss.job ${job.id} → ${to}`).toBe(1n);
  expect(await stateOfJob(f, job)).toBe(to);
}

/**
 * The moved row still holds its dedup key on the exclusive payout queue: a send of that very key
 * is dropped (null), whatever the key's format. Proves the state was set the way the queue reads it.
 */
export async function expectHeld(
  f: ReviewFixture,
  h: UnknownAdmin,
  job: ReceivedJob,
): Promise<void> {
  const result = await sql<{ singleton_key: string | null }>`SELECT singleton_key FROM pgboss.job
    WHERE name = 'payout' AND id = ${job.id}::uuid`.execute(f.db);
  const held = result.rows[0]?.singleton_key ?? null;
  expect(held, `the manual query job ${job.id} carries a dedup key`).toEqual(expect.any(String));
  expect(
    await h.queue.send('payout', 'query', job.payload, { trx: null, singletonKey: held! }),
    `a send of the key of job ${job.id} is dropped while it is ${await stateOfJob(f, job)}`,
  ).toBeNull();
}

/** The app's payout_query_request records naming the admin (as actor). */
export async function auditsBy(f: ReviewFixture, adminId: string) {
  return (await audits(f, QUERY_AUDIT)).filter((record) => textOf(record).includes(adminId));
}

/** latest_query of `w` on the unknown-payout list. */
export async function latestOf(
  h: UnknownAdmin,
  w: WithdrawalRow,
): Promise<Record<string, unknown> | null> {
  const page = await answer(await h.list(), 0);
  const items = (page.data as { items: Array<Record<string, unknown>> }).items;
  const item = items.find((candidate) => candidate['withdrawal_id'] === w.id);
  expect(item, `${w.id} on the unknown-payout list`).toBeDefined();
  return item!['latest_query'] as Record<string, unknown> | null;
}

/** The real query job over three fake channels with their own spies; transfer must never run. */
export function channelWorker(f: ReviewFixture, h: UnknownAdmin, answerWith?: QueryResult) {
  function fake() {
    return {
      query: vi
        .fn<PayoutChannel['query']>()
        .mockResolvedValue(answerWith ?? { kind: 'unknown', raw: { code: 'SYNTHETIC_UNKNOWN' } }),
      transfer: vi.fn<PayoutChannel['transfer']>().mockResolvedValue({
        kind: 'unknown',
        raw: { code: 'SYNTHETIC_TRANSFER_MUST_NOT_RUN' },
        latencyMs: 0,
      }),
    };
  }
  const channels = { alipay: fake(), bank_card: fake(), wechat: fake() };
  const handler = createQueryJob({
    db: f.db,
    attemptsDb: f.payout,
    clock: f.clock,
    config: configPort(),
    ledger: f.ledger,
    lockUsersForUpdate,
    queue: h.queue,
    eventBus: h.events,
    channels,
    sleep: async () => undefined,
    logger: { info: () => undefined, warn: () => undefined },
  });
  return { handler, channels };
}

export type ChannelWorker = ReturnType<typeof channelWorker>;

/** Every out_biz_no any fake channel was queried with, in call order per channel. */
export function queriedWith(worker: ChannelWorker): string[] {
  return Object.values(worker.channels).flatMap((channel) =>
    channel.query.mock.calls.map((call) => call[0]),
  );
}

/** No fake channel's transfer was called (BR-WDR-14: only query, never resend). */
export function expectNoTransfer(worker: ChannelWorker): void {
  for (const channel of Object.values(worker.channels)) {
    expect(channel.transfer).not.toHaveBeenCalled();
  }
}
