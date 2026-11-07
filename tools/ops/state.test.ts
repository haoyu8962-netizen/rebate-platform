import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { LEASE_MS } from './lock.ts';
import {
  ATTEMPT_LIMITS,
  BUMP_CLOCK_SKEW_MS,
  BUMP_MATCH_WINDOW_MS,
  bumpAttempt,
  type CallMeta,
  callKind,
  claimDir,
  claimTask,
  listStates,
  MAX_CALLS_PER_TASK,
  MAX_CONSECUTIVE_NO_OUTPUT,
  migrateState,
  parseCallMeta,
  readState,
  recordOpusRun,
  releaseTask,
  reviewKind,
  settleCall,
  stateFile,
  taskCalls,
  uncountedReason,
  updateState,
} from './state.ts';
import { CLI_TIMEOUT, removeDir, runCli, scratchDir } from './test-helpers.ts';

const T0 = new Date('2026-10-01T04:00:00.000Z');
const later = (ms: number): Date => new Date(T0.getTime() + ms);
/** A bump one second before a call that started at `iso` (the runners bump right before). */
const before = (iso: string): Date => new Date(Date.parse(iso) - 1000);

let runs = '';

beforeAll(() => {
  runs = join(scratchDir('state'), 'runs');
  process.env.COULI_RUNS = runs;
});
afterAll(() => removeDir(join(runs, '..')));

it('creates the state file on first use and writes it atomically', () => {
  expect(readState('A1-01')).toBeNull();
  const state = updateState('A1-01', { state: 'doing', pid: 4242 }, T0);
  expect(state).toEqual({
    id: 'A1-01',
    state: 'doing',
    attempts: { test: 0, impl: 0, handover: 0, 'spec-test': 0, code: 0 },
    spec_commit: null,
    implementer: null,
    pid: 4242,
    started_at: T0.toISOString(),
    owner_session: null,
    lease_until: null,
    ask_created_at: null,
    last_error: null,
    uncounted_calls: [],
    pending_bumps: [],
    opus_failures: { total: 0, consecutive: 0, last_reason: null },
    opus_runs: [],
    updated_at: T0.toISOString(),
  });
  expect(JSON.parse(readFileSync(stateFile('A1-01'), 'utf8'))).toEqual(state);
  // No temporary file is left next to it.
  expect(readdirSync(join(runs, 'state'))).toEqual(['A1-01.json']);
});

it('records when a task entered `ask` and forgets it when the task leaves', () => {
  updateState('A1-02', { state: 'ask' }, T0);
  const again = updateState('A1-02', { last_error: '/x/err.txt' }, later(3600_000));
  expect(again.ask_created_at).toBe(T0.toISOString());
  expect(updateState('A1-02', { state: 'doing' }, later(7200_000)).ask_created_at).toBeNull();
});

it('counts attempts before dispatch and refuses to go past the limits', () => {
  expect(bumpAttempt('A1-03', 'impl', T0).attempts).toEqual({
    test: 0,
    impl: 1,
    handover: 0,
    'spec-test': 0,
    code: 0,
  });
  bumpAttempt('A1-03', 'impl', T0);
  expect(bumpAttempt('A1-03', 'impl', T0).attempts.impl).toBe(3);
  // Persisted: a crash right after the bump still counts the attempt.
  expect(readState('A1-03')?.attempts.impl).toBe(3);
  expect(() => bumpAttempt('A1-03', 'impl', T0)).toThrow(/impl attempts exhausted \(3 of 3/);
  expect(readState('A1-03')?.attempts.impl).toBe(3);
});

it('[规划/11 §2.5] rule-test review has 2 rounds, code review 3, each its own counter', () => {
  expect(ATTEMPT_LIMITS).toEqual({ test: 3, impl: 3, handover: 1, 'spec-test': 2, code: 3 });
  expect(reviewKind('spec-test')).toBe('spec-test');
  for (const type of ['money', 'general', 'contract'] as const)
    expect(reviewKind(type)).toBe('code');
  bumpAttempt('A1-07', 'spec-test', T0);
  bumpAttempt('A1-07', 'spec-test', T0);
  expect(() => bumpAttempt('A1-07', 'spec-test', T0)).toThrow(
    /spec-test attempts exhausted \(2 of 2/,
  );
  // Two spec-test rounds used up do not take anything from the code review.
  bumpAttempt('A1-07', 'code', T0);
  bumpAttempt('A1-07', 'code', T0);
  expect(bumpAttempt('A1-07', 'code', T0).attempts).toEqual({
    test: 0,
    impl: 0,
    handover: 0,
    'spec-test': 2,
    code: 3,
  });
  expect(() => bumpAttempt('A1-07', 'code', T0)).toThrow(/code attempts exhausted \(3 of 3/);
});

function meta(over: Partial<CallMeta> = {}): CallMeta {
  return {
    mode: 'review',
    review_type: 'spec-test',
    phase: null,
    started_at: '2026-10-02T03:14:01Z',
    exit_code: 0,
    has_output: true,
    idle_killed: false,
    validation: 'ok',
    ...over,
  };
}

it('[规划/11 §2.5] only a call that ended without output gives its round back', () => {
  const noOutput = { has_output: false, validation: 'not-run' };
  expect(uncountedReason(meta())).toBeNull();
  expect(uncountedReason(meta({ ...noOutput, exit_code: 124 }))).toBe('timeout');
  expect(uncountedReason(meta({ ...noOutput, exit_code: 124, idle_killed: true }))).toBe(
    'inactivity-kill',
  );
  expect(uncountedReason(meta({ ...noOutput, exit_code: 11 }))).toBe('capacity');
  // No -o file, turn.failed, non-zero Codex exit: the wrapper never validated an answer.
  expect(uncountedReason(meta({ ...noOutput, exit_code: 10 }))).toBe('no-output');
  // An answer that failed validation, and a position assertion failure, stay counted.
  expect(uncountedReason(meta({ has_output: false, exit_code: 10, validation: 'failed' }))).toBe(
    null,
  );
  expect(uncountedReason(meta({ ...noOutput, exit_code: 12 }))).toBeNull();
});

it('[规划/11 §2.5] settle takes a timed-out review back once, on its own counter', () => {
  bumpAttempt('A1-08', 'spec-test', before('2026-10-02T03:14:01Z'));
  bumpAttempt('A1-08', 'code', before('2026-10-02T04:00:00Z'));
  const timedOut = meta({ exit_code: 124, has_output: false, validation: 'not-run' });
  const first = settleCall('A1-08', timedOut, later(1000));
  expect(first).toMatchObject({ kind: 'spec-test', counted: false, changed: true });
  expect(first.state?.attempts).toEqual({ test: 0, impl: 0, handover: 0, 'spec-test': 0, code: 1 });
  expect(first.state?.uncounted_calls).toEqual([
    { kind: 'spec-test', started_at: timedOut.started_at, exit_code: 124, reason: 'timeout' },
  ]);
  // Idempotent: settling the same call again (post-run, a retry of the wrapper) changes nothing.
  expect(settleCall('A1-08', timedOut, later(2000))).toMatchObject({ changed: false });
  expect(readState('A1-08')?.attempts).toEqual({
    test: 0,
    impl: 0,
    handover: 0,
    'spec-test': 0,
    code: 1,
  });
  // A call with output keeps its round (and spends its bump).
  const ok = meta({ review_type: 'money', started_at: '2026-10-02T04:00:00Z' });
  expect(settleCall('A1-08', ok, later(3000))).toMatchObject({
    counted: true,
    pre_counted: true,
    changed: true,
  });
  expect(readState('A1-08')?.attempts.code).toBe(1);
  // An implementation killed by the hard timeout does not use up an attempt either.
  bumpAttempt('A1-08', 'impl', before('2026-10-02T05:00:00Z'));
  const implTimeout = meta({
    mode: 'impl',
    review_type: null,
    started_at: '2026-10-02T05:00:00Z',
    exit_code: 124,
    has_output: false,
    validation: 'not-run',
  });
  expect(settleCall('A1-08', implTimeout, later(4000)).state?.attempts.impl).toBe(0);
  // Without a state file there is nothing to settle.
  expect(settleCall('Z9-99', timedOut, T0)).toMatchObject({ state: null, changed: false });
});

const NO_OUTPUT = { exit_code: 10, has_output: false, validation: 'not-run' } as const;

it('[CT-06zxk] settle gives back a bumped round without output, keeps one with output', () => {
  const id = 'H1-01';
  const s1 = '2026-10-03T01:00:00Z';
  bumpAttempt(id, 'spec-test', before(s1));
  expect(readState(id)?.pending_bumps).toEqual([
    {
      kind: 'spec-test',
      engine: 'codex',
      bumped_at: before(s1).toISOString(),
      consumed_by: null,
      outcome: null,
    },
  ]);
  expect(settleCall(id, meta({ ...NO_OUTPUT, started_at: s1 }), T0)).toMatchObject({
    counted: false,
    pre_counted: true,
    changed: true,
  });
  expect(readState(id)?.attempts['spec-test']).toBe(0);
  expect(readState(id)?.pending_bumps?.[0]).toMatchObject({ consumed_by: s1, outcome: 'refunded' });
  // With output: the round stays counted, the bump is spent all the same.
  const s2 = '2026-10-03T02:00:00Z';
  bumpAttempt(id, 'spec-test', before(s2));
  expect(settleCall(id, meta({ started_at: s2 }), T0)).toMatchObject({
    counted: true,
    pre_counted: true,
    changed: true,
  });
  const state = readState(id);
  expect(state?.attempts['spec-test']).toBe(1);
  expect(state?.pending_bumps?.[1]).toMatchObject({ consumed_by: s2, outcome: 'kept' });
  // A later call without output cannot pair with the spent bump.
  const s3 = '2026-10-03T02:10:00Z';
  expect(settleCall(id, meta({ ...NO_OUTPUT, started_at: s3 }), T0)).toMatchObject({
    pre_counted: false,
  });
  expect(readState(id)?.attempts['spec-test']).toBe(1);
  removeDir(stateFile(id));
});

it('[CT-06zxk] a call that was never counted leaves attempts alone, but is still recorded', () => {
  const id = 'H1-02';
  // Three rounds used, the fourth bump refused at the limit; the call starts anyway and aborts.
  for (const n of [1, 2, 3]) {
    const s = `2026-10-03T0${n}:00:00Z`;
    bumpAttempt(id, 'test', before(s));
    const ok = meta({ mode: 'impl', review_type: null, phase: 'test', started_at: s });
    expect(settleCall(id, ok, T0).pre_counted).toBe(true);
  }
  expect(() => bumpAttempt(id, 'test', before('2026-10-03T04:00:00Z'))).toThrow(/exhausted/);
  const stray = meta({
    mode: 'impl',
    review_type: null,
    phase: 'test',
    ...NO_OUTPUT,
    started_at: '2026-10-03T04:00:00Z',
  });
  const res = settleCall(id, stray, T0);
  expect(res).toMatchObject({ kind: 'test', counted: false, pre_counted: false, changed: true });
  expect(res.state?.attempts.test).toBe(3);
  expect(res.state?.uncounted_calls).toEqual([
    {
      kind: 'test',
      started_at: stray.started_at,
      exit_code: 10,
      reason: 'no-output',
      refunded: false,
    },
  ]);
  // Idempotent: settling it again changes nothing.
  expect(settleCall(id, stray, T0)).toMatchObject({ pre_counted: false, changed: false });
  expect(readState(id)?.attempts.test).toBe(3);
  // An orchestrator exception round (no bump at all) of another kind: same.
  const review = meta({ ...NO_OUTPUT, review_type: 'money', started_at: '2026-10-03T05:00:00Z' });
  expect(settleCall(id, review, T0)).toMatchObject({ kind: 'code', pre_counted: false });
  expect(readState(id)?.attempts.code).toBe(0);
  // A bump of another engine is no bump of this call.
  bumpAttempt(id, 'code', before('2026-10-03T06:00:00Z'), 'claude-independent');
  const codex = meta({ ...NO_OUTPUT, review_type: 'money', started_at: '2026-10-03T06:00:00Z' });
  expect(settleCall(id, codex, T0).pre_counted).toBe(false);
  expect(readState(id)?.attempts.code).toBe(1);
  removeDir(stateFile(id));
});

it('[CT-06zxk] settling twice is idempotent; two bumps and two calls pair one to one', () => {
  const id = 'H1-03';
  const s1 = '2026-10-03T01:00:00Z';
  const s2 = '2026-10-03T01:20:00Z';
  // Bumped right before each call; the first call's meta.json has whole seconds, bumped 0.7 s
  // "after" it (clock skew).
  bumpAttempt(id, 'code', new Date(Date.parse(s1) + 700));
  const first = meta({ ...NO_OUTPUT, review_type: 'general', started_at: s1 });
  expect(settleCall(id, first, T0)).toMatchObject({ pre_counted: true, changed: true });
  expect(settleCall(id, first, T0)).toMatchObject({ pre_counted: true, changed: false });
  expect(readState(id)?.attempts.code).toBe(0);
  bumpAttempt(id, 'code', before(s2));
  bumpAttempt(id, 'code', before('2026-10-03T01:40:00Z'));
  const second = meta({ ...NO_OUTPUT, review_type: 'general', started_at: s2 });
  expect(settleCall(id, second, T0)).toMatchObject({ pre_counted: true, changed: true });
  expect(settleCall(id, second, T0).changed).toBe(false);
  // Two bumps outstanding minus one given back: one round counted, for the third call.
  expect(readState(id)?.attempts.code).toBe(1);
  const third = meta({ review_type: 'general', started_at: '2026-10-03T01:40:00Z' });
  expect(settleCall(id, third, T0)).toMatchObject({ pre_counted: true, changed: true });
  expect(settleCall(id, third, T0)).toMatchObject({ pre_counted: true, changed: false });
  expect(readState(id)?.pending_bumps?.map((b) => [b.consumed_by, b.outcome])).toEqual([
    [s1, 'refunded'],
    [s2, 'refunded'],
    ['2026-10-03T01:40:00Z', 'kept'],
  ]);
  expect(readState(id)?.attempts.code).toBe(1);
  removeDir(stateFile(id));
});

it('[CT-06zxk] a bump whose call died without a trace is not given back by a later call', () => {
  const id = 'H1-04';
  // Superseded: the next paired call spends the older bump too, which stays counted.
  bumpAttempt(id, 'test', before('2026-10-03T01:00:00Z'));
  bumpAttempt(id, 'test', before('2026-10-03T02:00:00Z'));
  const next = meta({
    mode: 'impl',
    review_type: null,
    phase: 'test',
    ...NO_OUTPUT,
    started_at: '2026-10-03T02:00:00Z',
  });
  expect(settleCall(id, next, T0).state?.attempts.test).toBe(1);
  expect(readState(id)?.pending_bumps?.map((b) => b.outcome)).toEqual(['superseded', 'refunded']);
  // Too old: a stray call long after the last bump does not pair with it.
  bumpAttempt(id, 'test', before('2026-10-03T03:00:00Z'));
  const stray = { ...next, started_at: '2026-10-03T04:00:00Z' };
  expect(settleCall(id, stray, T0)).toMatchObject({ pre_counted: false });
  expect(readState(id)?.attempts.test).toBe(2);
  // A bump after the call started (beyond the clock skew) is the next call's.
  const early = { ...next, started_at: '2026-10-03T02:59:00Z' };
  expect(settleCall(id, early, T0).pre_counted).toBe(false);
  removeDir(stateFile(id));
});

it('[CT-06zxk] a state file without pending bumps: an old call is not given back', () => {
  const id = 'H1-05';
  // The shape before CT-06zxk: a round counted, no pending_bumps.
  bumpAttempt(id, 'code', before('2026-10-03T01:00:00Z'));
  const raw = JSON.parse(readFileSync(stateFile(id), 'utf8')) as Record<string, unknown>;
  delete raw.pending_bumps;
  writeFileSync(stateFile(id), JSON.stringify(raw));
  expect(readState(id)?.pending_bumps).toEqual([]);
  const old = meta({ ...NO_OUTPUT, review_type: 'money', started_at: '2026-10-03T01:00:00Z' });
  expect(settleCall(id, old, T0)).toMatchObject({ pre_counted: false, changed: true });
  expect(readState(id)?.attempts.code).toBe(1);
  // An uncounted call of an older file (no `refunded`) was given back: settling it is a no-op.
  const prior = meta({ ...NO_OUTPUT, review_type: 'money', started_at: '2026-10-02T01:00:00Z' });
  const withOld = JSON.parse(readFileSync(stateFile(id), 'utf8')) as Record<string, unknown>;
  writeFileSync(
    stateFile(id),
    JSON.stringify({
      ...withOld,
      uncounted_calls: [
        { kind: 'code', started_at: prior.started_at, exit_code: 10, reason: 'no-output' },
      ],
    }),
  );
  expect(settleCall(id, prior, T0)).toMatchObject({ pre_counted: true, changed: false });
  // A damaged pending bump is refused.
  writeFileSync(stateFile(id), JSON.stringify({ ...raw, pending_bumps: [{ kind: 'code' }] }));
  expect(() => readState(id)).toThrow(/pending_bumps\[0\]/);
  removeDir(stateFile(id));
});

it('[CT-06zxk] an Opus run spends its impl bump, so a later Codex impl call cannot pair with it', () => {
  const id = 'H1-06';
  bumpAttempt(id, 'impl', T0);
  recordOpusRun(id, 'opus-1', 'ok', 'RV1', later(3600_000));
  expect(readState(id)?.pending_bumps?.[0]).toMatchObject({
    consumed_by: 'opus:opus-1',
    outcome: 'kept',
  });
  const legacy = meta({
    mode: 'impl',
    review_type: null,
    phase: 'impl',
    ...NO_OUTPUT,
    started_at: later(60_000).toISOString(),
  });
  expect(settleCall(id, legacy, T0).pre_counted).toBe(false);
  expect(readState(id)?.attempts.impl).toBe(1);
  removeDir(stateFile(id));
});

it('[CT-06zxk] an Opus run started after a refused impl bump gives no round back', () => {
  const id = 'H1-07';
  for (const n of [1, 2, 3]) expect(bumpAttempt(id, 'impl', T0).attempts.impl).toBe(n);
  for (const r of ['o1', 'o2', 'o3']) recordOpusRun(id, r, 'ok', 'RV1', T0);
  expect(() => bumpAttempt(id, 'impl', T0)).toThrow(/impl attempts exhausted \(3 of 3/);
  // Started anyway (or an exception round that never bumped) and produced nothing.
  const run = recordOpusRun(id, 'o4', 'no-output', 'RV1', later(60_000));
  expect(run.state.attempts.impl).toBe(3);
  expect(run.state.uncounted_calls.at(-1)).toEqual({
    kind: 'impl',
    started_at: 'o4',
    exit_code: -1,
    reason: 'no-output',
    refunded: false,
  });
  // It still counts as an Opus failure, and settling it again changes nothing.
  expect(run.state.opus_failures).toMatchObject({ total: 1, consecutive: 1 });
  expect(recordOpusRun(id, 'o4', 'no-output', 'RV1', later(120_000)).state.attempts.impl).toBe(3);
  expect(readState(id)?.uncounted_calls).toHaveLength(1);
  removeDir(stateFile(id));
});

it('[ops/approvals.yaml id 19] Codex writing tests, the Opus implementation and a handover count apart', () => {
  // Codex writes the rule tests: its rounds never use up an implementation attempt.
  for (const n of [1, 2, 3]) expect(bumpAttempt('E1-01', 'test', T0).attempts.test).toBe(n);
  expect(() => bumpAttempt('E1-01', 'test', T0)).toThrow(/test attempts exhausted \(3 of 3/);
  expect(readState('E1-01')?.attempts).toEqual({
    test: 3,
    impl: 0,
    handover: 0,
    'spec-test': 0,
    code: 0,
  });
  // The Opus subagent still has its three attempts; the handover to Codex is one.
  expect(bumpAttempt('E1-01', 'impl', T0).attempts.impl).toBe(1);
  expect(bumpAttempt('E1-01', 'handover', T0).attempts.handover).toBe(1);
  expect(() => bumpAttempt('E1-01', 'handover', T0)).toThrow(
    /handover attempts exhausted \(1 of 1/,
  );
  removeDir(stateFile('E1-01'));
});

it('[ops/approvals.yaml id 19] an impl-mode Codex call is counted by its phase', () => {
  const impl = { mode: 'impl' as const, review_type: null };
  expect(callKind(meta({ ...impl, phase: 'test' }))).toBe('test');
  expect(callKind(meta({ ...impl, phase: 'handover' }))).toBe('handover');
  // The old flow of a legacy ledger: a Codex implementation is an implementation attempt.
  expect(callKind(meta({ ...impl, phase: 'impl' }))).toBe('impl');
  // A meta.json from before 2026-10-05 (no phase) was a Codex implementation.
  expect(callKind(meta({ ...impl, phase: null }))).toBe('impl');
  expect(
    parseCallMeta({ ...meta({ ...impl }), phase: 'test', finished_at: '2026-10-05T01:00:00Z' })
      ?.phase,
  ).toBe('test');
  expect(
    parseCallMeta({ ...meta(), phase: 'test', finished_at: '2026-10-05T01:00:00Z' })?.phase,
  ).toBeNull();
  // A test-writing call killed by the hard timeout gives its round back to `test`, not `impl`.
  bumpAttempt('E1-02', 'test', before('2026-10-05T02:00:00Z'));
  bumpAttempt('E1-02', 'impl', T0);
  const timedOut = meta({
    ...impl,
    phase: 'test',
    started_at: '2026-10-05T02:00:00Z',
    exit_code: 124,
    has_output: false,
    validation: 'not-run',
  });
  expect(settleCall('E1-02', timedOut, later(1000))).toMatchObject({ kind: 'test', changed: true });
  expect(readState('E1-02')?.attempts).toMatchObject({ test: 0, impl: 1 });
  removeDir(stateFile('E1-02'));
});

it('[RO2-03, CR-07] count, run, settle, dispatch again: an Opus run without a result gives its round back', () => {
  const id = 'E1-04';
  // capacity → output → capacity: the implementation still has two of its three rounds.
  expect(bumpAttempt(id, 'impl', T0).attempts.impl).toBe(1);
  expect(recordOpusRun(id, 'opus-1', 'capacity', 'RV1', T0)).toMatchObject({ next: 'continue' });
  expect(readState(id)?.attempts.impl).toBe(0);
  expect(bumpAttempt(id, 'impl', T0).attempts.impl).toBe(1);
  expect(recordOpusRun(id, 'opus-2', 'ok', 'RV1', T0).state.attempts.impl).toBe(1);
  expect(bumpAttempt(id, 'impl', T0).attempts.impl).toBe(2);
  expect(recordOpusRun(id, 'opus-3', 'capacity', 'RV1', T0).state.attempts.impl).toBe(1);
  // Settling the same run twice changes nothing (no double give-back, no double failure).
  const again = recordOpusRun(id, 'opus-3', 'capacity', 'RV1', T0);
  expect(again.state.attempts.impl).toBe(1);
  expect(again.state.opus_failures).toEqual({ total: 2, consecutive: 1, last_reason: 'capacity' });
  expect(
    again.state.uncounted_calls.filter((c) => c.kind === 'impl').map((c) => c.started_at),
  ).toEqual(['opus-1', 'opus-3']);
  // The next round can still be dispatched.
  expect(bumpAttempt(id, 'impl', T0).attempts.impl).toBe(2);
  // Three in a row without a result: handover for RV0 / RV1.
  recordOpusRun(id, 'opus-4', 'timeout', 'RV1', T0);
  bumpAttempt(id, 'impl', T0);
  const third = recordOpusRun(id, 'opus-5', 'no-output', 'RV1', T0);
  expect(third).toMatchObject({ next: 'handover' });
  expect(third.reason).toContain('连续 3 次');
  // Opus runs are no Codex calls: the per-task Codex call cap does not move.
  expect(taskCalls(id).calls).toBe(0);
  expect(() => recordOpusRun(id, 'bad id!', 'ok', 'RV1', T0)).toThrow(/invalid Opus run id/);
  removeDir(stateFile(id));
});

it('[RO2-03] five Opus runs without a result in total block an RV2 task (no handover)', () => {
  const id = 'E1-05';
  // Never three in a row, two runs with a result: the fifth failure in total stops the task.
  const outcomes = ['timeout', 'no-output', 'ok', 'capacity', 'timeout', 'ok'] as const;
  outcomes.forEach((o, i) => {
    bumpAttempt(id, 'impl', T0);
    expect(recordOpusRun(id, `r${i}`, o, 'RV2', T0).next).toBe('continue');
  });
  expect(readState(id)?.opus_failures).toEqual({
    total: 4,
    consecutive: 0,
    last_reason: 'timeout',
  });
  expect(readState(id)?.attempts.impl).toBe(2);
  bumpAttempt(id, 'impl', T0);
  const fifth = recordOpusRun(id, 'r9', 'no-output', 'RV2', T0);
  expect(fifth.next).toBe('blocked');
  expect(fifth.reason).toContain('累计 5 次');
  expect(fifth.reason).toContain('RV2 不换家');
  const cli = runCli(
    'state.ts',
    ['opus-run', 'E1-06', '--run-id', 'x1', '--outcome', 'timeout', '--risk', 'RV1'],
    { COULI_RUNS: runs },
  );
  expect(cli.status, cli.stderr).toBe(0);
  expect(JSON.parse(cli.stdout)).toMatchObject({ next: 'continue', opus_failures: { total: 1 } });
  expect(
    runCli('state.ts', ['opus-run', 'E1-06', '--outcome', 'timeout', '--risk', 'RV1'], {
      COULI_RUNS: runs,
    }).status,
  ).toBe(2);
  for (const t of [id, 'E1-06']) removeDir(stateFile(t));
});

it('reads a state file of the three-counter shape with the later counters at 0', () => {
  writeFileSync(
    stateFile('E1-03'),
    JSON.stringify({
      id: 'E1-03',
      state: 'doing',
      attempts: { impl: 2, 'spec-test': 1, code: 0 },
      spec_commit: null,
      pid: null,
      started_at: null,
      owner_session: null,
      lease_until: null,
      ask_created_at: null,
      last_error: null,
      uncounted_calls: [],
      updated_at: T0.toISOString(),
    }),
  );
  expect(readState('E1-03')?.attempts).toEqual({
    test: 0,
    impl: 2,
    handover: 0,
    'spec-test': 1,
    code: 0,
  });
  expect(bumpAttempt('E1-03', 'test', T0).attempts).toMatchObject({ test: 1, impl: 2 });
  removeDir(stateFile('E1-03'));
});

it('[规划/11 §2.5] migrates the old shared review counter from the run history', () => {
  // The B2-01a history of 2026-10-02: one implementation, then a spec-test review killed by the
  // hard timeout (exit 124, no output) and a spec-test review that returned "fail".
  const id = 'B9-01a';
  writeFileSync(
    stateFile(id),
    JSON.stringify({
      id,
      state: 'blocked',
      attempts: { impl: 1, review: 2 },
      spec_commit: '4de67a1808681f7085c49adf5a64c8aaa6ddcfa4',
      pid: null,
      started_at: null,
      owner_session: null,
      lease_until: null,
      ask_created_at: null,
      last_error: '/runs/B9-01a/r2-fix-input.txt',
      updated_at: T0.toISOString(),
    }),
  );
  expect(() => readState(id)).toThrow(/old shape .*state\.ts migrate B9-01a/);
  const run = join(runs, id);
  const call = (over: Record<string, unknown>) => ({
    task: id,
    finished_at: '2026-10-02T03:59:00Z',
    has_output: false,
    idle_killed: false,
    ...over,
  });
  mkdirSync(join(run, 'attempts', '1'), { recursive: true });
  const files: Record<string, unknown> = {
    'meta.impl.json': call({
      mode: 'impl',
      started_at: '2026-10-01T19:40:00Z',
      exit_code: 0,
      has_output: true,
      validation: 'ok',
    }),
    'attempts/1/meta.json': call({
      mode: 'review',
      review_type: 'spec-test',
      started_at: '2026-10-02T03:14:01Z',
      exit_code: 124,
      timed_out: true,
      validation: 'not-run',
    }),
    'meta.review.json': call({
      mode: 'review',
      review_type: 'spec-test',
      started_at: '2026-10-02T03:32:41Z',
      exit_code: 0,
      has_output: true,
      validation: 'ok',
    }),
  };
  for (const [rel, doc] of Object.entries(files))
    writeFileSync(join(run, rel), JSON.stringify(doc));
  // meta.json is a copy of the latest call and must not be counted twice.
  writeFileSync(join(run, 'meta.json'), JSON.stringify(files['meta.review.json']));

  const dry = migrateState(id, { dryRun: true, now: later(1000) });
  expect(dry.attempts).toEqual({ test: 0, impl: 1, handover: 0, 'spec-test': 1, code: 0 });
  expect(() => readState(id)).toThrow(/old shape/);
  const migrated = migrateState(id, { now: later(1000) });
  expect(migrated).toMatchObject({
    state: 'blocked',
    attempts: { test: 0, impl: 1, handover: 0, 'spec-test': 1, code: 0 },
    last_error: '/runs/B9-01a/r2-fix-input.txt',
    uncounted_calls: [
      { kind: 'spec-test', started_at: '2026-10-02T03:14:01Z', exit_code: 124, reason: 'timeout' },
    ],
  });
  expect(readState(id)).toEqual(migrated);
  // Running it again is a no-op; the second spec-test round is still available.
  expect(migrateState(id, { now: later(2000) })).toEqual(migrated);
  expect(bumpAttempt(id, 'spec-test', later(3000)).attempts['spec-test']).toBe(2);
  removeDir(stateFile(id));
  removeDir(run);
});

/** Writes finished calls of a task as the wrapper archives them: attempts/<n>/meta.json. */
function writeCalls(id: string, outcomes: ('ok' | 'none' | 'capacity' | 'invalid')[]): void {
  const dir = join(runs, id, 'attempts');
  outcomes.forEach((o, i) => {
    mkdirSync(join(dir, String(i + 1)), { recursive: true });
    const started = new Date(T0.getTime() + i * 60_000).toISOString();
    const doc = {
      mode: i % 2 === 0 ? 'impl' : 'review',
      review_type: i % 2 === 0 ? null : 'general',
      task: id,
      started_at: started,
      finished_at: started,
      exit_code: { ok: 0, none: 124, capacity: 11, invalid: 10 }[o],
      has_output: o === 'ok',
      idle_killed: false,
      validation: { ok: 'ok', none: 'not-run', capacity: 'not-run', invalid: 'failed' }[o],
    };
    writeFileSync(join(dir, String(i + 1), 'meta.json'), JSON.stringify(doc));
  });
}

it('[规划/11 §2.5] per-task failure breakers: 10 calls, 3 in a row without output', () => {
  // Owner 2026-10-02 (ops/approvals.yaml id 15): no quota gate, only these failure breakers.
  expect(MAX_CALLS_PER_TASK).toBe(10);
  expect(MAX_CONSECUTIVE_NO_OUTPUT).toBe(3);
  expect(taskCalls('D1-01')).toEqual({
    task: 'D1-01',
    calls: 0,
    consecutive_no_output: 0,
    reasons: [],
  });

  // Capacity errors neither extend nor end a run of calls without output; an answer that failed
  // validation is output and ends it.
  writeCalls('D1-02', ['ok', 'none', 'capacity', 'none']);
  expect(taskCalls('D1-02')).toMatchObject({ calls: 4, consecutive_no_output: 2, reasons: [] });
  writeCalls('D1-02', ['ok', 'none', 'capacity', 'none', 'invalid']);
  expect(taskCalls('D1-02').consecutive_no_output).toBe(0);
  writeCalls('D1-02', ['ok', 'none', 'capacity', 'none', 'invalid', 'none', 'none', 'none']);
  const silent = taskCalls('D1-02');
  expect(silent.consecutive_no_output).toBe(3);
  expect(silent.reasons.map((r) => r.breaker)).toEqual(['no_output']);
  expect(silent.reasons[0]?.message).toContain('D1-02: 连续 3 次调用没有产出');
  // The breaker stops only this task, before anything is counted.
  updateState('D1-02', { state: 'doing' }, T0);
  expect(() => bumpAttempt('D1-02', 'impl', T0)).toThrow(/连续 3 次调用没有产出/);
  expect(readState('D1-02')?.attempts.impl).toBe(0);
  expect(bumpAttempt('D1-03', 'impl', T0).attempts.impl).toBe(1);

  // Every finished call counts towards the cap of 10, also calls that gave their round back.
  writeCalls('D1-04', ['ok', 'none', 'ok', 'capacity', 'ok', 'none', 'ok', 'capacity', 'ok']);
  expect(taskCalls('D1-04')).toMatchObject({ calls: 9, reasons: [] });
  expect(bumpAttempt('D1-04', 'code', T0).attempts.code).toBe(1);
  writeCalls('D1-04', ['ok', 'none', 'ok', 'capacity', 'ok', 'none', 'ok', 'capacity', 'ok', 'ok']);
  const capped = taskCalls('D1-04');
  expect(capped.reasons.map((r) => r.breaker)).toEqual(['task_calls']);
  expect(capped.reasons[0]?.message).toContain('达到每任务上限 10 次');
  expect(() => bumpAttempt('D1-04', 'code', T0)).toThrow(/每任务上限 10 次/);
  expect(readState('D1-04')?.attempts.code).toBe(1);
  for (const id of ['D1-02', 'D1-03', 'D1-04']) {
    removeDir(stateFile(id));
    removeDir(join(runs, id));
  }
});

it('refuses to guess when counted review rounds left no meta.json', () => {
  const id = 'B9-02a';
  writeFileSync(
    stateFile(id),
    JSON.stringify({
      id,
      state: 'review',
      attempts: { impl: 1, review: 1 },
      spec_commit: null,
      pid: null,
      started_at: null,
      owner_session: null,
      lease_until: null,
      ask_created_at: null,
      last_error: null,
      updated_at: T0.toISOString(),
    }),
  );
  expect(() => migrateState(id, { now: T0 })).toThrow(/--unattributed-review/);
  expect(migrateState(id, { now: T0, unattributedReview: 'code' }).attempts).toEqual({
    test: 0,
    impl: 1,
    handover: 0,
    'spec-test': 0,
    code: 1,
  });
  removeDir(stateFile(id));
});

it('lets one session claim a task, with a 20 minute lease that can be renewed', () => {
  const claimed = claimTask('A1-04', { owner: 'session-a', now: T0 });
  expect(claimed.owner_session).toBe('session-a');
  expect(claimed.lease_until).toBe(later(LEASE_MS).toISOString());
  expect(existsSync(claimDir('A1-04'))).toBe(true);
  expect(() => claimTask('A1-04', { owner: 'session-b', now: later(1000) })).toThrow(
    /already claimed by session-a/,
  );
  // Even the same session must renew explicitly.
  expect(() => claimTask('A1-04', { owner: 'session-a', now: later(1000) })).toThrow(
    /already claimed/,
  );
  const renewed = claimTask('A1-04', { owner: 'session-a', renew: true, now: later(600_000) });
  expect(renewed.lease_until).toBe(later(600_000 + LEASE_MS).toISOString());
  expect(() => claimTask('A1-04', { owner: 'session-b', renew: true, now: T0 })).toThrow(
    /no claim held by session-b/,
  );
});

it('hands an expired claim to another session and releases claims', () => {
  claimTask('A1-05', { owner: 'session-a', now: T0 });
  expect(() => claimTask('A1-05', { owner: 'session-b', now: later(LEASE_MS) })).toThrow();
  const taken = claimTask('A1-05', { owner: 'session-b', now: later(LEASE_MS + 1000) });
  expect(taken.owner_session).toBe('session-b');
  expect(() => releaseTask('A1-05', { owner: 'session-a', now: later(LEASE_MS + 2000) })).toThrow(
    /claim is held by session-b/,
  );
  const released = releaseTask('A1-05', { owner: 'session-b', now: later(LEASE_MS + 3000) });
  expect(released).toMatchObject({ owner_session: null, lease_until: null, pid: null });
  expect(existsSync(claimDir('A1-05'))).toBe(false);
  expect(
    claimTask('A1-05', { owner: 'session-a', now: later(LEASE_MS + 4000) }).owner_session,
  ).toBe('session-a');
});

it('lists every state file and rejects a damaged one', () => {
  expect(listStates().map((s) => s.id)).toEqual([
    'A1-01',
    'A1-02',
    'A1-03',
    'A1-04',
    'A1-05',
    'A1-07',
    'A1-08',
  ]);
  writeFileSync(stateFile('A1-06'), JSON.stringify({ id: 'A1-06', state: 'flying' }));
  expect(() => readState('A1-06')).toThrow(/state must be one of/);
  writeFileSync(stateFile('A1-06'), '{ not json');
  expect(() => listStates()).toThrow(/invalid JSON/);
  removeDir(stateFile('A1-06'));
});

it(
  'follows the exit code convention on the command line',
  () => {
    const env = { COULI_RUNS: runs };
    expect(runCli('state.ts', ['get', 'C1-01'], env).status).toBe(1);
    expect(runCli('state.ts', ['claim', 'C1-01', '--owner', 's1'], env).status).toBe(0);
    const second = runCli('state.ts', ['claim', 'C1-01', '--owner', 's2'], env);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('already claimed by s1');
    expect(runCli('state.ts', ['claim', 'C1-01', '--owner', 's1', '--renew'], env).status).toBe(0);
    for (const n of [1, 2, 3]) {
      const res = runCli('state.ts', ['bump-attempt', 'C1-01', 'impl'], env);
      expect(JSON.parse(res.stdout)).toMatchObject({ attempts: { impl: n } });
    }
    expect(runCli('state.ts', ['bump-attempt', 'C1-01', 'impl'], env).status).toBe(1);
    const set = runCli(
      'state.ts',
      ['set', 'C1-01', '--state', 'verify', '--spec-commit', 'abc1234', '--last-error', 'none'],
      env,
    );
    expect(JSON.parse(set.stdout)).toMatchObject({ state: 'verify', spec_commit: 'abc1234' });
    expect(JSON.parse(runCli('state.ts', ['get', 'C1-01'], env).stdout)).toMatchObject({
      id: 'C1-01',
      state: 'verify',
      owner_session: 's1',
      attempts: { test: 0, impl: 3, handover: 0, 'spec-test': 0, code: 0 },
    });
    expect(runCli('state.ts', ['release', 'C1-01', '--owner', 's2'], env).status).toBe(1);
    expect(runCli('state.ts', ['release', 'C1-01', '--owner', 's1'], env).status).toBe(0);
    expect(runCli('state.ts', ['set', 'C1-01', '--state', 'flying'], env).status).toBe(2);
    expect(runCli('state.ts', ['bump-attempt', 'C1-01', 'deploy'], env).status).toBe(2);
    // A review round needs its type: each type has its own counter.
    expect(runCli('state.ts', ['bump-attempt', 'C1-01', 'review'], env).status).toBe(2);
    const spec = runCli(
      'state.ts',
      ['bump-attempt', 'C1-01', 'review', '--review-type', 'spec-test'],
      env,
    );
    expect(JSON.parse(spec.stdout)).toMatchObject({ attempts: { 'spec-test': 1, code: 0 } });
    const money = runCli(
      'state.ts',
      ['bump-attempt', 'C1-01', 'review', '--review-type', 'money'],
      env,
    );
    expect(JSON.parse(money.stdout)).toMatchObject({ attempts: { 'spec-test': 1, code: 1 } });
    const metaFile = join(runs, 'C1-01-meta.json');
    writeFileSync(
      metaFile,
      JSON.stringify({
        mode: 'review',
        review_type: 'money',
        // After the bumps above (real clock): the call pairs with the money round's bump.
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        exit_code: 124,
        has_output: false,
        idle_killed: false,
        validation: 'not-run',
      }),
    );
    const settled = runCli('state.ts', ['settle', 'C1-01', '--meta', metaFile], env);
    expect(settled.status).toBe(0);
    expect(JSON.parse(settled.stdout)).toMatchObject({
      kind: 'code',
      counted: false,
      pre_counted: true,
      changed: true,
      attempts: { test: 0, impl: 3, handover: 0, 'spec-test': 1, code: 0 },
    });
    expect(runCli('state.ts', ['get', '../../etc/passwd'], env).status).toBe(2);

    // An open failure breaker refuses the next round with exit 3 and says why.
    writeCalls('C1-02', ['none', 'none', 'none']);
    const stopped = runCli('state.ts', ['bump-attempt', 'C1-02', 'impl'], env);
    expect(stopped.status).toBe(3);
    expect(stopped.stderr).toContain('C1-02: 连续 3 次调用没有产出');
    expect(existsSync(stateFile('C1-02'))).toBe(false);
    removeDir(join(runs, 'C1-02'));
  },
  CLI_TIMEOUT,
);

/** Like writeCalls, with an `engine` on every meta.json (claude-run.sh, ops/approvals.yaml id 36). */
function writeEngineCalls(
  id: string,
  calls: { engine?: string; outcome: 'ok' | 'none' }[],
  from = 0,
): void {
  const dir = join(runs, id, 'attempts');
  calls.forEach((c, i) => {
    const n = from + i;
    mkdirSync(join(dir, String(n + 1)), { recursive: true });
    const started = new Date(T0.getTime() + n * 60_000).toISOString();
    writeFileSync(
      join(dir, String(n + 1), 'meta.json'),
      JSON.stringify({
        mode: 'impl',
        phase: 'test',
        ...(c.engine === undefined ? {} : { engine: c.engine }),
        task: id,
        started_at: started,
        finished_at: started,
        exit_code: c.outcome === 'ok' ? 0 : 124,
        has_output: c.outcome === 'ok',
        idle_killed: false,
        validation: c.outcome === 'ok' ? 'ok' : 'not-run',
      }),
    );
  });
}

it('[approvals 36] the failure breakers count each engine apart; a meta.json without engine is Codex', () => {
  const id = 'G7-01';
  const independent = 'claude-independent';
  // Three Codex calls in a row without output stop Codex for the task, not the Claude calls.
  writeEngineCalls(id, [
    { outcome: 'none' },
    { engine: 'codex', outcome: 'none' },
    { outcome: 'none' },
  ]);
  expect(taskCalls(id).reasons.map((r) => r.breaker)).toEqual(['no_output']);
  expect(taskCalls(id, independent)).toEqual({
    task: id,
    calls: 0,
    consecutive_no_output: 0,
    reasons: [],
  });
  expect(() => bumpAttempt(id, 'test', T0)).toThrow(/连续 3 次调用没有产出/);
  expect(bumpAttempt(id, 'test', T0, independent).attempts.test).toBe(1);
  // And the other way round, with its own message.
  writeEngineCalls(
    id,
    [
      { engine: independent, outcome: 'none' },
      { engine: independent, outcome: 'none' },
      { engine: independent, outcome: 'none' },
    ],
    3,
  );
  const claude = taskCalls(id, independent);
  expect(claude).toMatchObject({ calls: 3, consecutive_no_output: 3 });
  expect(claude.reasons[0]?.message).toContain(
    'G7-01: 独立 Claude（claude-run.sh）连续 3 次调用没有产出',
  );
  expect(() => bumpAttempt(id, 'test', T0, independent)).toThrow(/独立 Claude/);
  // A Claude call with output does not end the Codex run of failures.
  writeEngineCalls(id, [{ engine: independent, outcome: 'ok' }], 6);
  expect(taskCalls(id).consecutive_no_output).toBe(3);
  expect(taskCalls(id, independent).reasons).toEqual([]);
  // An unknown engine value counts as Codex (the stricter default).
  expect(
    parseCallMeta({
      mode: 'impl',
      engine: 'gemini',
      started_at: 'x',
      finished_at: 'x',
      exit_code: 0,
    })?.engine,
  ).toBe('codex');
  removeDir(stateFile(id));
  removeDir(join(runs, id));
});

it("[approvals 36] the rounds are the task's whoever runs them: same counters, same limits", () => {
  const id = 'G7-02';
  const independent = 'claude-independent';
  expect(bumpAttempt(id, 'test', T0).attempts.test).toBe(1);
  expect(bumpAttempt(id, 'test', T0, independent).attempts.test).toBe(2);
  expect(bumpAttempt(id, 'test', T0, independent).attempts.test).toBe(3);
  expect(() => bumpAttempt(id, 'test', T0)).toThrow(/test attempts exhausted \(3 of 3/);
  expect(() => bumpAttempt(id, 'test', T0, independent)).toThrow(/test attempts exhausted/);
  // A Claude call without output gives its round back, recorded with its engine; settling the
  // same call again changes nothing, and a Codex call of the same second is another call.
  const meta: CallMeta = {
    mode: 'impl',
    engine: independent,
    review_type: null,
    phase: 'test',
    started_at: T0.toISOString(),
    exit_code: 11,
    has_output: false,
    idle_killed: false,
    validation: 'not-run',
  };
  expect(settleCall(id, meta, T0)).toMatchObject({ kind: 'test', counted: false, changed: true });
  expect(readState(id)?.uncounted_calls).toEqual([
    {
      kind: 'test',
      engine: independent,
      started_at: T0.toISOString(),
      exit_code: 11,
      reason: 'capacity',
    },
  ]);
  expect(settleCall(id, meta, T0).changed).toBe(false);
  const codexMeta: CallMeta = { ...meta };
  delete codexMeta.engine;
  const codex = settleCall(id, codexMeta, T0);
  expect(codex.changed).toBe(true);
  expect(readState(id)?.uncounted_calls[1]).not.toHaveProperty('engine');
  expect(readState(id)?.attempts.test).toBe(1);
  // A state file whose uncounted call names an unknown engine is refused.
  const raw = JSON.parse(readFileSync(stateFile(id), 'utf8')) as Record<string, unknown>;
  writeFileSync(
    stateFile(id),
    JSON.stringify({
      ...raw,
      uncounted_calls: [{ ...meta, kind: 'test', reason: 'capacity', engine: 'x' }],
    }),
  );
  expect(() => readState(id)).toThrow(/uncounted_calls\[0\]/);
  removeDir(stateFile(id));
});

it('[approvals 36] bump-attempt --engine on the command line', { timeout: CLI_TIMEOUT }, () => {
  const ok = runCli('state.ts', [
    'bump-attempt',
    'G7-03',
    'test',
    '--engine',
    'claude-independent',
  ]);
  expect(ok.status, ok.stderr).toBe(0);
  expect(readState('G7-03')?.attempts.test).toBe(1);
  const review = runCli('state.ts', [
    'bump-attempt',
    'G7-03',
    'review',
    '--review-type',
    'money',
    '--engine',
    'claude-independent',
  ]);
  expect(review.status, review.stderr).toBe(0);
  expect(readState('G7-03')?.attempts.code).toBe(1);
  const bad = runCli('state.ts', ['bump-attempt', 'G7-03', 'test', '--engine', 'gemini']);
  expect(bad.status).toBe(2);
  expect(bad.stderr).toContain('--engine must be codex or claude-independent');
  removeDir(stateFile('G7-03'));
});

it(
  '[approvals 36] breakers <id> --engine: exit 3 when that engine is stopped, 0 otherwise',
  { timeout: CLI_TIMEOUT },
  () => {
    const id = 'G7-04';
    writeEngineCalls(id, [{ outcome: 'none' }, { outcome: 'none' }, { outcome: 'none' }]);
    const codex = runCli('state.ts', ['breakers', id]);
    expect(codex.status).toBe(3);
    expect(codex.stderr).toContain(`${id}: 连续 3 次调用没有产出`);
    const claude = runCli('state.ts', ['breakers', id, '--engine', 'claude-independent']);
    expect(claude.status, claude.stderr).toBe(0);
    expect(JSON.parse(claude.stdout)).toMatchObject({
      task: id,
      engine: 'claude-independent',
      calls: 0,
    });
    expect(runCli('state.ts', ['breakers', id, '--engine', 'gemini']).status).toBe(2);
    removeDir(join(runs, id));
  },
);

// CT-06zzzp (FU-CODEX-RUN-REJECT-COUNT, D10-898): `release <id> <kind> [--review-type …]
// [--engine …] --reason <text>` gives back the round a caller bumped for a call that
// codex-run.sh / claude-run.sh refused before it started (no meta.json, so settle never ran).
// Not to be confused with `release <id> [--owner …]`, which drops a claim.

const SPEC_REVIEW = ['review', '--review-type', 'spec-test'];

/** The pending bumps of a state file as plain records (a released bump carries more fields). */
function bumpsOf(id: string): Record<string, unknown>[] {
  return (readState(id)?.pending_bumps ?? []) as unknown as Record<string, unknown>[];
}

function releaseBump(id: string, args: string[], reason = 'refused before the call') {
  return runCli('state.ts', ['release', id, ...args, '--reason', reason]);
}

/** Exit 0, the hint, and the state file byte for byte as it was. */
function expectNothingReleased(id: string, args: string[]): void {
  const before = readFileSync(stateFile(id), 'utf8');
  const res = releaseBump(id, args);
  expect(res.status, `${args.join(' ')}: ${res.stderr}`).toBe(0);
  expect(res.stdout + res.stderr, args.join(' ')).toContain('nothing to release');
  expect(readFileSync(stateFile(id), 'utf8'), args.join(' ')).toBe(before);
}

it(
  '[CT-06zzzp] release consumes the bump of a refused call: outcome refused, attempts as before the bump, reason and time recorded',
  { timeout: CLI_TIMEOUT },
  () => {
    const id = 'R9-01';
    claimTask(id, { owner: 'session-r' });
    // One round used by a call with output, then a bump for a call that was refused.
    expect(runCli('state.ts', ['bump-attempt', id, ...SPEC_REVIEW]).status).toBe(0);
    expect(settleCall(id, meta({ started_at: new Date().toISOString() })).pre_counted).toBe(true);
    expect(runCli('state.ts', ['bump-attempt', id, ...SPEC_REVIEW]).status).toBe(0);
    expect(readState(id)?.attempts['spec-test']).toBe(2);
    const from = Date.now();
    const res = releaseBump(id, SPEC_REVIEW, 'tester: none');
    const to = Date.now();
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout + res.stderr).not.toContain('nothing to release');
    const state = readState(id);
    expect(state?.attempts).toEqual({ test: 0, impl: 0, handover: 0, 'spec-test': 1, code: 0 });
    const [kept, refused] = bumpsOf(id);
    expect(kept).toMatchObject({ outcome: 'kept' });
    expect(refused).toMatchObject({
      kind: 'spec-test',
      engine: 'codex',
      outcome: 'refused',
      reason: 'tester: none',
    });
    expect(typeof refused?.['consumed_by']).toBe('string');
    const at = Date.parse(String(refused?.['released_at']));
    expect(at).toBeGreaterThanOrEqual(from - 1000);
    expect(at).toBeLessThanOrEqual(to + 1000);
    // Giving back a bump is no claim release.
    expect(state?.owner_session).toBe('session-r');
    expect(existsSync(claimDir(id))).toBe(true);
    removeDir(claimDir(id));
    removeDir(stateFile(id));
  },
);

it(
  '[CT-06zzzp] release gives back only the latest unconsumed bump of the kind',
  { timeout: CLI_TIMEOUT },
  () => {
    const id = 'R9-02';
    const now = Date.now();
    bumpAttempt(id, 'spec-test', new Date(now - 120_000));
    bumpAttempt(id, 'spec-test', new Date(now - 60_000));
    expect(readState(id)?.attempts['spec-test']).toBe(2);
    const res = releaseBump(id, SPEC_REVIEW);
    expect(res.status, res.stderr).toBe(0);
    expect(readState(id)?.attempts['spec-test']).toBe(1);
    const [older, later] = bumpsOf(id);
    expect(older).toMatchObject({
      bumped_at: new Date(now - 120_000).toISOString(),
      consumed_by: null,
      outcome: null,
    });
    expect(later).toMatchObject({
      bumped_at: new Date(now - 60_000).toISOString(),
      outcome: 'refused',
    });
    removeDir(stateFile(id));
  },
);

it(
  '[CT-06zzzp] release leaves a bump of another kind, review type or engine alone',
  { timeout: CLI_TIMEOUT },
  () => {
    const id = 'R9-03';
    const now = Date.now();
    bumpAttempt(id, 'spec-test', new Date(now - 60_000));
    bumpAttempt(id, 'test', new Date(now - 60_000), 'claude-independent');
    for (const args of [
      // A money / general review is no spec-test review.
      ['review', '--review-type', 'money'],
      ['review', '--review-type', 'general'],
      // Codex and the independent Claude never give back each other's rounds.
      [...SPEC_REVIEW, '--engine', 'claude-independent'],
      ['test'],
      ['test', '--engine', 'codex'],
      ['handover', '--engine', 'claude-independent'],
    ]) {
      expectNothingReleased(id, args);
    }
    expect(readState(id)?.attempts).toMatchObject({ test: 1, 'spec-test': 1 });
    // Each is given back by its own kind and engine.
    expect(releaseBump(id, SPEC_REVIEW).status).toBe(0);
    expect(releaseBump(id, ['test', '--engine', 'claude-independent']).status).toBe(0);
    expect(readState(id)?.attempts).toMatchObject({ test: 0, 'spec-test': 0 });
    expect(bumpsOf(id).map((b) => [b['kind'], b['engine'], b['outcome']])).toEqual([
      ['spec-test', 'codex', 'refused'],
      ['test', 'claude-independent', 'refused'],
    ]);
    removeDir(stateFile(id));
  },
);

it(
  "[CT-06zzzp] release gives back no bump older than settle's matching window",
  { timeout: CLI_TIMEOUT },
  () => {
    const id = 'R9-04';
    const stale = new Date(Date.now() - BUMP_MATCH_WINDOW_MS - BUMP_CLOCK_SKEW_MS - 60_000);
    bumpAttempt(id, 'code', stale);
    expectNothingReleased(id, ['review', '--review-type', 'money']);
    expect(readState(id)?.attempts.code).toBe(1);
    // Inside the window it is given back; the stale one stays pending (and counted).
    bumpAttempt(id, 'code', new Date(Date.now() - BUMP_MATCH_WINDOW_MS + 60_000));
    expect(releaseBump(id, ['review', '--review-type', 'money']).status).toBe(0);
    expect(readState(id)?.attempts.code).toBe(1);
    expect(bumpsOf(id).map((b) => b['outcome'])).toEqual([null, 'refused']);
    removeDir(stateFile(id));
  },
);

it(
  '[CT-06zzzp] release and settle exclude each other: a kept or refunded bump is not released, a released one is not settled',
  { timeout: CLI_TIMEOUT },
  () => {
    const id = 'R9-05';
    // Kept by a call with output.
    bumpAttempt(id, 'spec-test', new Date(Date.now() - 1000));
    const s1 = new Date().toISOString();
    expect(settleCall(id, meta({ started_at: s1 })).pre_counted).toBe(true);
    expectNothingReleased(id, SPEC_REVIEW);
    expect(readState(id)?.attempts['spec-test']).toBe(1);
    // Refunded by a call without output.
    bumpAttempt(id, 'spec-test', new Date(Date.now() - 1000));
    const s2 = new Date().toISOString();
    expect(settleCall(id, meta({ ...NO_OUTPUT, started_at: s2 })).pre_counted).toBe(true);
    expect(readState(id)?.attempts['spec-test']).toBe(1);
    expectNothingReleased(id, SPEC_REVIEW);
    expect(readState(id)?.attempts['spec-test']).toBe(1);
    // Released first: a later call without output cannot give it back a second time.
    bumpAttempt(id, 'spec-test', new Date(Date.now() - 1000));
    expect(releaseBump(id, SPEC_REVIEW).status).toBe(0);
    expect(readState(id)?.attempts['spec-test']).toBe(1);
    const s3 = new Date().toISOString();
    expect(settleCall(id, meta({ ...NO_OUTPUT, started_at: s3 })).pre_counted).toBe(false);
    expect(readState(id)?.attempts['spec-test']).toBe(1);
    expect(bumpsOf(id).map((b) => b['outcome'])).toEqual(['kept', 'refunded', 'refused']);
    removeDir(stateFile(id));
  },
);

it(
  '[CT-06zzzp] release is idempotent: a second call finds nothing, changes nothing and exits 0',
  { timeout: CLI_TIMEOUT },
  () => {
    const id = 'R9-06';
    bumpAttempt(id, 'test', new Date(Date.now() - 1000));
    const first = releaseBump(id, ['test']);
    expect(first.status, first.stderr).toBe(0);
    expect(readState(id)?.attempts.test).toBe(0);
    expectNothingReleased(id, ['test']);
    expect(readState(id)?.attempts.test).toBe(0);
    expect(bumpsOf(id).map((b) => b['outcome'])).toEqual(['refused']);
    removeDir(stateFile(id));
  },
);

it(
  '[CT-06zzzp] release without a state file or without a pending bump exits 0 and writes nothing',
  { timeout: CLI_TIMEOUT },
  () => {
    const id = 'R9-07';
    const none = releaseBump(id, ['test']);
    expect(none.status, none.stderr).toBe(0);
    expect(existsSync(stateFile(id))).toBe(false);
    expect(existsSync(claimDir(id))).toBe(false);
    updateState(id, { state: 'doing' }, T0);
    const before = readFileSync(stateFile(id), 'utf8');
    const empty = releaseBump(id, SPEC_REVIEW);
    expect(empty.status, empty.stderr).toBe(0);
    expect(readFileSync(stateFile(id), 'utf8')).toBe(before);
    removeDir(stateFile(id));
  },
);

it(
  '[CT-06zzzp] release of a bump checks its arguments like bump-attempt and needs --reason',
  { timeout: CLI_TIMEOUT },
  () => {
    const id = 'R9-08';
    bumpAttempt(id, 'code', new Date(Date.now() - 1000));
    const before = readFileSync(stateFile(id), 'utf8');
    for (const args of [
      ['review', '--reason', 'r'],
      ['review', '--review-type', 'unknown', '--reason', 'r'],
      ['deploy', '--reason', 'r'],
      ['test', '--review-type', 'money', '--reason', 'r'],
      ['review', '--review-type', 'money', '--engine', 'gemini', '--reason', 'r'],
      ['review', '--review-type', 'money'],
    ]) {
      const res = runCli('state.ts', ['release', id, ...args]);
      expect(res.status, args.join(' ')).toBe(2);
      expect(readFileSync(stateFile(id), 'utf8'), args.join(' ')).toBe(before);
    }
    removeDir(stateFile(id));
  },
);

// CT-06zzzu (FU-CODEX-RUN-REJECT-COUNT-REST, #2709 Codex r1 S2 ①): `release <id> <kind> …
// --reason <text> --call <id of the refused call>`. The released bump records `call`; a call that
// already gave back its round gives back nothing more (exit 0, "nothing to release", the state
// file unchanged), instead of releasing an older pending bump of the same kind and engine.

it(
  '[CT-06zzzu] release --call records the call on the bump it gives back, besides refused, reason and released_at',
  { timeout: CLI_TIMEOUT },
  () => {
    const id = 'R9-11';
    bumpAttempt(id, 'test', new Date(Date.now() - 1000));
    expect(readState(id)?.attempts.test).toBe(1);
    const from = Date.now();
    const res = releaseBump(id, ['test', '--call', 'C1'], 'tester: none');
    const to = Date.now();
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout + res.stderr).not.toContain('nothing to release');
    // readState validates the file: a bump with `call` is a valid state file.
    const state = readState(id);
    expect(state?.attempts.test).toBe(0);
    const [refused] = bumpsOf(id);
    expect(refused).toMatchObject({
      kind: 'test',
      engine: 'codex',
      outcome: 'refused',
      reason: 'tester: none',
      call: 'C1',
    });
    expect(typeof refused?.['consumed_by']).toBe('string');
    const at = Date.parse(String(refused?.['released_at']));
    expect(at).toBeGreaterThanOrEqual(from - 1000);
    expect(at).toBeLessThanOrEqual(to + 1000);
    removeDir(stateFile(id));
  },
);

it(
  '[CT-06zzzu] the same --call twice with two pending bumps: the second gives back nothing, the older bump stays pending',
  { timeout: CLI_TIMEOUT },
  () => {
    // #2709 Codex r1 S2: a repeated release of one refused call took the older bump as well.
    const id = 'R9-12';
    const now = Date.now();
    bumpAttempt(id, 'spec-test', new Date(now - 120_000));
    bumpAttempt(id, 'spec-test', new Date(now - 60_000));
    expect(readState(id)?.attempts['spec-test']).toBe(2);
    const first = releaseBump(id, [...SPEC_REVIEW, '--call', 'C1']);
    expect(first.status, first.stderr).toBe(0);
    expect(readState(id)?.attempts['spec-test']).toBe(1);
    let [older, later] = bumpsOf(id);
    expect(later).toMatchObject({
      bumped_at: new Date(now - 60_000).toISOString(),
      outcome: 'refused',
      call: 'C1',
    });
    expect(older).toMatchObject({ consumed_by: null, outcome: null });
    // The same call again: exit 0, "nothing to release", the file byte for byte as it was.
    expectNothingReleased(id, [...SPEC_REVIEW, '--call', 'C1']);
    expect(readState(id)?.attempts['spec-test']).toBe(1);
    [older, later] = bumpsOf(id);
    expect(older).toMatchObject({
      bumped_at: new Date(now - 120_000).toISOString(),
      consumed_by: null,
      outcome: null,
    });
    expect(older?.['call'] ?? null).toBeNull();
    expect(later).toMatchObject({ outcome: 'refused', call: 'C1' });
    removeDir(stateFile(id));
  },
);

it(
  '[CT-06zzzu] another --call gives back the next pending bump, the older one',
  { timeout: CLI_TIMEOUT },
  () => {
    const id = 'R9-13';
    const now = Date.now();
    bumpAttempt(id, 'test', new Date(now - 120_000));
    bumpAttempt(id, 'test', new Date(now - 60_000));
    expect(releaseBump(id, ['test', '--call', 'C1']).status).toBe(0);
    expectNothingReleased(id, ['test', '--call', 'C1']);
    expect(readState(id)?.attempts.test).toBe(1);
    const res = releaseBump(id, ['test', '--call', 'C2']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout + res.stderr).not.toContain('nothing to release');
    expect(readState(id)?.attempts.test).toBe(0);
    expect(bumpsOf(id).map((b) => [b['bumped_at'], b['outcome'], b['call']])).toEqual([
      [new Date(now - 120_000).toISOString(), 'refused', 'C2'],
      [new Date(now - 60_000).toISOString(), 'refused', 'C1'],
    ]);
    // Both calls have given back their round: neither gives back anything more.
    expectNothingReleased(id, ['test', '--call', 'C1']);
    expectNothingReleased(id, ['test', '--call', 'C2']);
    removeDir(stateFile(id));
  },
);

it(
  '[CT-06zzzu] release without --call works as in CT-06zzzp: each release gives back the latest pending bump',
  { timeout: CLI_TIMEOUT },
  () => {
    const id = 'R9-14';
    const now = Date.now();
    bumpAttempt(id, 'code', new Date(now - 120_000));
    bumpAttempt(id, 'code', new Date(now - 60_000));
    const money = ['review', '--review-type', 'money'];
    expect(releaseBump(id, money).status).toBe(0);
    expect(readState(id)?.attempts.code).toBe(1);
    expect(bumpsOf(id).map((b) => b['outcome'])).toEqual([null, 'refused']);
    expect(releaseBump(id, money).status).toBe(0);
    expect(readState(id)?.attempts.code).toBe(0);
    const bumps = bumpsOf(id);
    expect(bumps.map((b) => b['outcome'])).toEqual(['refused', 'refused']);
    // A release without --call records no call.
    for (const b of bumps) expect(b['call'] ?? null).toBeNull();
    expectNothingReleased(id, money);
    removeDir(stateFile(id));
  },
);

it(
  '[CT-06zzzu] release --call needs a value that is not blank, and only with a kind',
  { timeout: CLI_TIMEOUT },
  () => {
    const id = 'R9-15';
    claimTask(id, { owner: 'session-c' });
    bumpAttempt(id, 'test', new Date(Date.now() - 1000));
    const before = readFileSync(stateFile(id), 'utf8');
    for (const args of [
      ['test', '--reason', 'r', '--call', ''],
      ['test', '--reason', 'r', '--call', '   '],
      ['test', '--reason', 'r', '--call', '\t'],
      ['test', '--reason', 'r', '--call=   '],
      ['test', '--reason', 'r', '--call'],
      // --call belongs to giving back a round, not to dropping the claim.
      ['--call', 'C1'],
    ]) {
      const res = runCli('state.ts', ['release', id, ...args]);
      expect(res.status, JSON.stringify(args)).toBe(2);
      expect(readFileSync(stateFile(id), 'utf8'), JSON.stringify(args)).toBe(before);
    }
    expect(existsSync(claimDir(id))).toBe(true);
    // With a value the same bump is given back.
    expect(releaseBump(id, ['test', '--call', 'C1']).status).toBe(0);
    expect(readState(id)?.attempts.test).toBe(0);
    removeDir(claimDir(id));
    removeDir(stateFile(id));
  },
);
