// B3-08r (D10-972): an independent finalization (live settle S5, worker finalize) reads the daily
// limits (F0, BR-AI-15 落点「上限来源」) without holding a connection of the pool it then needs for
// the configuration refresh. Scene of every test: a business pool of POOL_MAX connections, the
// real createQuotaLimitsSource over a real ContentReader on that very pool, its cache expired, and
// POOL_MAX finalizations started at once. Holding a connection while the refresh waits for another
// one of the same pool deadlocks all of them (and every other DB access of the instance); every
// round must finish within IN_TIME_MS. The outcomes stay those of B3-03g (BR-AI-23 细则「受理记录
// 与收尾」, BR-AI-15 退还 / quota_left): the same as finalizing one after the other, a failed
// limits read writes nothing and is the rolled_back unavailable path, an already final run is
// answered from its final_event and counted once.
import { createTestDatabase } from '@couli/db/testing';
import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  AdmissionUnavailableError,
  type AdmissionTicket,
  type QuotaSubject,
  type RunOutcome,
  type SettleResult,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import type { FinalizeOutcome } from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import type { TerminalFrame } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import {
  APP,
  MutableLimits,
  RECOVERED,
  START_MS,
  TIMINGS,
  accepted,
  doneFrame,
  draftOf,
  instance,
  limits,
  newSession,
  request,
  snapshot,
  stored,
  usedOn,
} from '../stream-finalize/kit.ts';
import { IN_TIME_MS, poolInstance, seedQuota, settledView, usePools, within } from './kit.ts';

const pools = usePools(createTestDatabase);

const POOL_MAX = 3;
const QUOTA = { member: 7, guest: 2, guestIp: 9 };
const ADMIT_LIMITS = limits({ memberDaily: 7, guestDaily: 2, guestIpDaily: 9 });
const DAY = '2026-10-06';
/** The run lock of a run accepted at START_MS ends here (runMaxMs + 30 s). */
const LOCK_END = START_MS + TIMINGS.runMaxMs + TIMINGS.lockGraceMs;
/** A live tail settles while its run lock still holds. */
const LIVE_AT = START_MS + 5_000;
const IN_TIME = `${String(POOL_MAX)} finalizations on a pool of ${String(POOL_MAX)} with the limits cache expired all settle within ${String(IN_TIME_MS)} ms`;

/** card_stop: S3 (card) and S4 stop; crashed: nothing after acceptance; timeout: S4 timeout, no card. */
type Ending = 'card_stop' | 'crashed' | 'timeout';
const ENDINGS: readonly Ending[] = ['card_stop', 'crashed', 'timeout'];

const FACTS: Record<Ending, RunOutcome> = {
  card_stop: { ending: 'stop', cardsDelivered: 1 },
  crashed: { ending: 'server_error', cardsDelivered: 0 },
  timeout: { ending: 'timeout', cardsDelivered: 0 },
};

/** Member limit 7, this member's only run: counted → 6, refunded → 7. */
const FRAME: Record<Ending, TerminalFrame> = {
  card_stop: doneFrame('stop', 6),
  crashed: RECOVERED,
  timeout: doneFrame('timeout', 7),
};
const FINAL: Record<Ending, FinalizeOutcome> = {
  card_stop: {
    kind: 'final',
    frame: FRAME.card_stop,
    refunded: false,
    snapshotQuotaLeft: 6,
    quotaLeft: 6,
    wrote: true,
  },
  crashed: {
    kind: 'final',
    frame: FRAME.crashed,
    refunded: true,
    snapshotQuotaLeft: null,
    quotaLeft: 7,
    wrote: true,
  },
  timeout: {
    kind: 'final',
    frame: FRAME.timeout,
    refunded: true,
    snapshotQuotaLeft: 7,
    quotaLeft: 7,
    wrote: true,
  },
};
const SETTLED: Record<Ending, SettleResult> = {
  card_stop: { refunded: false, quotaLeft: 6 },
  crashed: { refunded: true, quotaLeft: 7 },
  timeout: { refunded: true, quotaLeft: 7 },
};
const END_REASON: Record<Ending, string> = {
  card_stop: 'stop',
  crashed: 'server_error',
  timeout: 'timeout',
};
/** Today's unrefunded runs of the run's member after its finalization. */
const USED: Record<Ending, number> = { card_stop: 1, crashed: 0, timeout: 0 };

function expectedView(ending: Ending, atMs: number) {
  return {
    end_reason: END_REASON[ending],
    card_delivered: ending === 'card_stop',
    settle_result: SETTLED[ending].refunded ? 'refunded' : 'counted',
    final_event: stored(FRAME[ending]),
    settled_at: new Date(atMs),
    ended_at: new Date(atMs),
    finalize_hold: null,
    run_lock_run_id: null,
    run_lock_expires_at: null,
  };
}

interface Left {
  readonly ending: Ending;
  readonly ticket: AdmissionTicket;
  /** The member's quota subject as stored in agent_runs.quota_subjects. */
  readonly subject: string;
}

/**
 * One run per ending, each of its own member and session, accepted at START_MS on the set-up
 * pool; `recordAll` also writes S4 for `crashed` (a live server_error whose tail is still to come).
 */
async function leave(endings: readonly Ending[], recordAll = false): Promise<Left[]> {
  await seedQuota(pools.db, QUOTA);
  const setup = instance(pools.db, {
    clock: new FixedClock(new Date(START_MS)),
    limits: new MutableLimits(ADMIT_LIMITS),
  });
  const left: Left[] = [];
  for (const ending of endings) {
    const userId = randomUUID();
    const user: QuotaSubject = { tier: 'member', userId };
    const session = await newSession(pools.db);
    const { ticket } = accepted(
      await setup.ports.admission.admit(request(user, session), ADMIT_LIMITS),
    );
    const facts = FACTS[ending];
    if (facts.cardsDelivered > 0) {
      await setup.ports.registry.recordFacts(ticket.runId, {
        ending: null,
        cardsDelivered: facts.cardsDelivered,
      });
    }
    if (ending !== 'crashed' || recordAll) {
      await setup.ports.registry.recordEnding(ticket.runId, facts, draftOf(facts.ending));
    }
    left.push({ ending, ticket, subject: JSON.stringify(['member', userId]) });
  }
  return left;
}

/** An instance on a fresh pool of POOL_MAX whose limits cache was filled and then expired. */
async function staleInstance(atMs: number) {
  const inst = poolInstance(pools.small(POOL_MAX), atMs);
  expect(await inst.limits.current(APP), 'the limits come from config_items').toMatchObject({
    memberDaily: QUOTA.member,
    guestDaily: QUOTA.guest,
    guestIpDaily: QUOTA.guestIp,
  });
  inst.reader.expire();
  return inst;
}

it('[B3-08r#1][BR-AI-23][BR-AI-15] 池 3 条连接、上限缓存已过期：3 个 worker 独立收尾同时进 F0，10 s 内全部 final、不互相等死；每个 run 的终态、counted / refunded、quota_left、会话锁释放与当日计数都与串行逐个收尾相同', async () => {
  const runs = await leave(ENDINGS);
  const r = await staleInstance(LOCK_END);
  const round = await within(
    runs.map((run) => () => r.ports.finalizer.finalize(run.ticket.runId)),
    () => r.reader.unstick(),
  );
  expect(round.inTime, IN_TIME).toBe(true);
  for (const [i, run] of runs.entries()) {
    expect(round.results[i], run.ending).toEqual(FINAL[run.ending]);
    expect(await settledView(pools.db, run.ticket.runId), run.ending).toMatchObject(
      expectedView(run.ending, LOCK_END),
    );
    expect(await usedOn(pools.db, run.subject, DAY), run.ending).toBe(USED[run.ending]);
  }

  const serialRuns = await leave(ENDINGS);
  const s = await staleInstance(LOCK_END);
  const serial: FinalizeOutcome[] = [];
  for (const run of serialRuns) serial.push(await s.ports.finalizer.finalize(run.ticket.runId));
  expect(round.results, 'concurrent = serial').toEqual(serial);
  for (const [i, run] of runs.entries()) {
    const twin = serialRuns[i]!;
    expect(await settledView(pools.db, run.ticket.runId), run.ending).toEqual(
      await settledView(pools.db, twin.ticket.runId),
    );
    expect(await usedOn(pools.db, run.subject, DAY), run.ending).toBe(
      await usedOn(pools.db, twin.subject, DAY),
    );
  }
}, 120_000);

it('[B3-08r#2][BR-AI-23][BR-AI-15] 池 3 条连接、上限缓存已过期：3 个活进程 settle（S5）同时进 F0，10 s 内全部返回、不互相等死；refunded / quota_left、final_event、会话锁释放、finish 重放的帧与当日计数都与串行逐个 settle 相同', async () => {
  const runs = await leave(ENDINGS, true);
  const r = await staleInstance(LIVE_AT);
  const round = await within(
    runs.map((run) => () => r.ports.admission.settle(run.ticket, FACTS[run.ending], ADMIT_LIMITS)),
    () => r.reader.unstick(),
  );
  expect(round.inTime, IN_TIME).toBe(true);
  for (const [i, run] of runs.entries()) {
    expect(round.results[i], run.ending).toEqual(SETTLED[run.ending]);
    expect(await settledView(pools.db, run.ticket.runId), run.ending).toMatchObject(
      expectedView(run.ending, LIVE_AT),
    );
    expect(await usedOn(pools.db, run.subject, DAY), run.ending).toBe(USED[run.ending]);
    expect(
      await r.ports.registry.finish(run.ticket.runId, FRAME[run.ending]),
      `${run.ending}: finish replays final_event`,
    ).toEqual(FRAME[run.ending]);
  }

  const serialRuns = await leave(ENDINGS, true);
  const s = await staleInstance(LIVE_AT);
  const serial: SettleResult[] = [];
  for (const run of serialRuns) {
    serial.push(await s.ports.admission.settle(run.ticket, FACTS[run.ending], ADMIT_LIMITS));
  }
  expect(round.results, 'concurrent = serial').toEqual(serial);
  for (const [i, run] of runs.entries()) {
    const twin = serialRuns[i]!;
    expect(await settledView(pools.db, run.ticket.runId), run.ending).toEqual(
      await settledView(pools.db, twin.ticket.runId),
    );
    expect(await usedOn(pools.db, run.subject, DAY), run.ending).toBe(
      await usedOn(pools.db, twin.subject, DAY),
    );
  }
}, 120_000);

it('[B3-08r#3][BR-AI-15][BR-AI-23] 池 3 条连接、上限缓存已过期且刷新读库失败：2 个 worker 收尾 + 1 个活进程 settle 同时进 F0，10 s 内全部是 AdmissionUnavailableError(rolled_back)，agent 三张表逐行逐列不变；读库恢复后同样并发再收尾一次，10 s 内按 B3-03g 结局完成', async () => {
  const [card, crashed, timeout] = await leave(ENDINGS);
  const r = await staleInstance(LOCK_END);
  const works = () => [
    () => r.ports.finalizer.finalize(card!.ticket.runId),
    () => r.ports.finalizer.finalize(crashed!.ticket.runId),
    () => r.ports.admission.settle(timeout!.ticket, FACTS.timeout, ADMIT_LIMITS),
  ];
  const before = await snapshot(pools.db);
  r.reader.failing = true;
  const failed = await within<unknown>(works(), () => r.reader.unstick());
  expect(failed.inTime, IN_TIME).toBe(true);
  expect(r.reader.failedReads, 'the refresh reached the database and failed').toBeGreaterThan(0);
  for (const [i, result] of failed.results.entries()) {
    expect(result, `call ${String(i)}`).toBeInstanceOf(AdmissionUnavailableError);
    expect((result as AdmissionUnavailableError).outcome, `call ${String(i)}`).toBe('rolled_back');
  }
  expect(await snapshot(pools.db), 'a failed limits read writes nothing').toBe(before);

  r.reader.failing = false;
  const recovered = await within<unknown>(works(), () => r.reader.unstick());
  expect(recovered.inTime, IN_TIME).toBe(true);
  expect(recovered.results).toEqual([FINAL.card_stop, FINAL.crashed, SETTLED.timeout]);
  for (const run of [card!, crashed!, timeout!]) {
    expect(await settledView(pools.db, run.ticket.runId), run.ending).toMatchObject(
      expectedView(run.ending, LOCK_END),
    );
    expect(await usedOn(pools.db, run.subject, DAY), run.ending).toBe(USED[run.ending]);
  }
}, 120_000);

it('[B3-08r#4][BR-AI-23][BR-AI-15] 池 3 条连接、上限缓存已过期：同一 run 3 个 worker 收尾同时进 F0，10 s 内完成且只写一次（一个 wrote=true）；再过期后 2 个 worker 收尾 + 1 个活进程 settle 并发重入，10 s 内都按 final_event 回答（wrote=false），不重复计数、三张表不变', async () => {
  const [run] = await leave(['card_stop']);
  const runId = run!.ticket.runId;
  const r = await staleInstance(LOCK_END);
  const first = await within(
    [1, 2, 3].map(() => () => r.ports.finalizer.finalize(runId)),
    () => r.reader.unstick(),
  );
  expect(first.inTime, IN_TIME).toBe(true);
  const wrote = first.results.map((o) =>
    o instanceof Error || o.kind !== 'final' ? null : o.wrote,
  );
  expect(
    wrote.filter((w) => w === true),
    'exactly one call writes',
  ).toHaveLength(1);
  expect(
    wrote.filter((w) => w === false),
    'the others replay',
  ).toHaveLength(2);
  for (const [i, result] of first.results.entries()) {
    expect(result, `call ${String(i)}`).toEqual({ ...FINAL.card_stop, wrote: wrote[i] });
  }
  expect(await settledView(pools.db, runId)).toMatchObject(expectedView('card_stop', LOCK_END));
  expect(await usedOn(pools.db, run!.subject, DAY)).toBe(1);
  const after = await snapshot(pools.db);

  r.reader.expire();
  const again = await within<unknown>(
    [
      () => r.ports.finalizer.finalize(runId),
      () => r.ports.admission.settle(run!.ticket, FACTS.card_stop, ADMIT_LIMITS),
      () => r.ports.finalizer.finalize(runId),
    ],
    () => r.reader.unstick(),
  );
  expect(again.inTime, IN_TIME).toBe(true);
  const replay = { ...FINAL.card_stop, wrote: false };
  expect(again.results).toEqual([replay, SETTLED.card_stop, replay]);
  expect(await snapshot(pools.db), 'a final run is not written again').toBe(after);
  expect(await usedOn(pools.db, run!.subject, DAY), 'counted once').toBe(1);
}, 120_000);
