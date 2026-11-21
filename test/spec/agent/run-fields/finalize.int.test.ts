import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import * as pgPorts from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import {
  FakeReply,
  framesOf,
  message,
  newMember,
  openSession,
  retrace,
  send,
  stepUntil,
  until,
  usePgEach,
} from '../stream-mount/kit.ts';
import { eventually, finishOf, runIdOf } from '../trace-persist/kit.ts';
import {
  gate,
  intent,
  observeRunUpdates,
  PROMPT,
  QUESTION,
  runtimeRig,
  SPEC_TIMEOUT,
  storedRun,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

it.each([
  ['cancelled', false],
  ['timeout', false],
  ['cancelled', true],
  ['timeout', true],
] as const)(
  '[AC-B3-08t#5] %s 结束且审核通过=%s，终态只记录结束前已通过的审核',
  async (reason, passed) => {
    const release = gate();
    let waiting = false;
    async function hold() {
      waiting = true;
      await release.promise;
    }
    const x = await runtimeRig(pg.db, {
      steps: [{ ...intent('out_of_scope'), before: passed ? hold : () => undefined }],
      reviewTimeoutMs: 60_000,
      review: async () => {
        if (!passed) await hold();
        return 'pass';
      },
    });
    try {
      const active = x.start(await openSession(x.r, x.caller));
      await until('已进入等待中的审核或模型调用', () => waiting);
      const runId = runIdOf(active.frames());
      if (reason === 'cancelled') {
        const answer = new FakeReply();
        await x.r.runtime.http.cancelRun(retrace(x.caller), runId, answer);
        expect(answer.single().status).toBe(200);
      }
      let finished = false;
      void active.settled.then(() => {
        finished = true;
      });
      const limit = reason === 'cancelled' ? 10_000 : x.r.runtime.timings.runMaxMs + 5_000;
      expect(await stepUntil(x.r, pg.db, () => finished, x.r.time.t + limit)).toBe(true);
      expect(finishOf(active.frames())).toBe(reason);
      const expected = { intent: null, input_passed: passed, final_event: expect.any(Object) };
      expect(await storedRun(pg.db, x.appId, runId)).toMatchObject(expected);
      release.open();
      expect(await active.settled).toEqual({ ok: true });
      expect(x.complete).toHaveBeenCalledTimes(passed ? 1 : 0);
      await x.r.runtime.close();
      expect(await storedRun(pg.db, x.appId, runId)).toMatchObject(expected);
    } finally {
      release.open();
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

it(
  '[AC-B3-08t#8] 终态提交的当下即可读到同一事务写入的意图和输入标记',
  async () => {
    const release = gate();
    let committed = false;
    const makePorts = pgPorts.createPgRunPorts;
    vi.spyOn(pgPorts, 'createPgRunPorts').mockImplementation((deps) =>
      makePorts({
        ...deps,
        hooks: {
          async afterCommit(step) {
            if (step !== 'settle') return;
            committed = true;
            await release.promise;
          },
        },
      }),
    );
    const x = await runtimeRig(pg.db, { steps: [intent('out_of_scope')] });
    try {
      const active = x.start(await openSession(x.r, x.caller));
      await until('终态事务已经提交但流式处理尚未继续', () => committed);
      expect(
        active.frames().some((frame) => frame.event === 'done' || frame.event === 'error'),
      ).toBe(false);
      const runId = runIdOf(active.frames());
      expect(await storedRun(pg.pool(), x.appId, runId)).toMatchObject({
        intent: 'out_of_scope',
        input_passed: true,
        final_event: expect.any(Object),
      });
      release.open();
      expect(await active.settled).toEqual({ ok: true });
      expect(finishOf(active.frames())).toBe('stop');
    } finally {
      release.open();
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

it(
  '[AC-B3-08t#8] 收尾提交前看不到新字段，强制回滚后 intent、input_passed 与 final_event 都未写入',
  async () => {
    const commit = gate();
    let atCommit = false;
    const makePorts = pgPorts.createPgRunPorts;
    vi.spyOn(pgPorts, 'createPgRunPorts').mockImplementation((deps) =>
      makePorts({
        ...deps,
        hooks: {
          async beforeCommit(step) {
            if (step !== 'settle') return;
            atCommit = true;
            await commit.promise;
            throw new Error('合成故障：终态事务提交前回滚');
          },
        },
      }),
    );
    const x = await runtimeRig(pg.db, { steps: [intent('out_of_scope')] });
    try {
      const active = x.start(await openSession(x.r, x.caller));
      await until('终态事务已到提交前', () => atCommit);
      const runId = runIdOf(active.frames());
      const observer = pg.pool();
      const before = await storedRun(observer, x.appId, runId);
      expect(before.final_event).toBeNull();
      expect(
        active.frames().some((frame) => frame.event === 'done' || frame.event === 'error'),
      ).toBe(false);

      commit.open();
      await active.settled;
      await x.r.runtime.close();
      const after = await storedRun(observer, x.appId, runId);
      expect(before).toMatchObject({ intent: null, input_passed: false });
      expect(after).toMatchObject({ intent: null, input_passed: false, final_event: null });
      expect(
        active.frames().some((frame) => frame.event === 'done' || frame.event === 'error'),
      ).toBe(false);
    } finally {
      commit.open();
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

it.each(['重复受理', '独立收尾'] as const)(
  '[AC-B3-08t#5][AC-B3-08t#6] 进程中断后由另一连接%s，已审核但未提交的标记不补写',
  async (by) => {
    const makePorts = pgPorts.createPgRunPorts;
    const ports = vi.spyOn(pgPorts, 'createPgRunPorts').mockImplementation((deps) =>
      makePorts({
        ...deps,
        hooks: {
          crash(point, phase) {
            if (point === 'settle' && phase === 'before') throw new Error('合成故障：运行进程退出');
          },
        },
      }),
    );
    const x = await runtimeRig(pg.db, { steps: [{ degrade: true }] });
    const db = pg.pool();
    try {
      const session = await openSession(x.r, x.caller);
      const body = message(QUESTION);
      const active = x.start(session, body);
      await active.settled;
      expect(x.complete).toHaveBeenCalledOnce();
      const runId = runIdOf(active.frames());
      const before = await storedRun(db, x.appId, runId);
      expect(before).toMatchObject({
        final_event: null,
        prompt_version: PROMPT,
      });

      const original = ports.mock.calls[0]?.[0];
      expect(original).toBeDefined();
      if (original === undefined) return;
      ports.mockRestore();
      vi.restoreAllMocks();
      const other = await runtimeRig(db, { caller: x.caller });
      try {
        await other.r.time.by(
          other.r.runtime.timings.runMaxMs + other.r.runtime.timings.lockGraceMs + 1_000,
        );
        if (by === '重复受理') {
          const reply = await send(other.r, x.caller, session, body);
          expect(framesOf(reply.chunks)[0]?.data['duplicate']).toBe(true);
        } else {
          const fresh = makePorts({ ...original, db, clock: other.r.time.clock });
          expect(await fresh.finalizer.finalize(runId)).toMatchObject({
            kind: 'final',
            wrote: true,
          });
        }
        expect(await storedRun(db, x.appId, runId)).toMatchObject({
          final_event: expect.any(Object),
          input_passed: false,
          intent: null,
          prompt_version: PROMPT,
        });
      } finally {
        await other.r.runtime.close();
      }
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

it(
  '[AC-B3-08t#8] 终态重放与独立重复收尾都保留首次写入的意图和输入标记',
  async () => {
    const makePorts = pgPorts.createPgRunPorts;
    const ports = vi.spyOn(pgPorts, 'createPgRunPorts');
    const x = await runtimeRig(pg.db, { steps: [intent('out_of_scope')] });
    try {
      const session = await openSession(x.r, x.caller);
      const body = message(QUESTION);
      const first = framesOf((await send(x.r, x.caller, session, body)).chunks);
      const runId = runIdOf(first);
      const before = await storedRun(pg.db, x.appId, runId);
      const replay = framesOf((await send(x.r, x.caller, session, body)).chunks);
      expect(replay[0]?.data['duplicate']).toBe(true);
      expect(replay.at(-1)?.data).toEqual(first.at(-1)?.data);
      const deps = ports.mock.calls[0]?.[0];
      expect(deps).toBeDefined();
      if (deps === undefined) return;
      expect(await makePorts({ ...deps, db: pg.pool() }).finalizer.finalize(runId)).toMatchObject({
        kind: 'final',
        wrote: false,
      });
      const expected = {
        intent: 'out_of_scope',
        input_passed: true,
        final_event: expect.any(Object),
      };
      expect(before).toMatchObject(expected);
      expect(await storedRun(pg.db, x.appId, runId)).toMatchObject({
        ...expected,
        final_event: before.final_event,
      });
      expect(x.complete).toHaveBeenCalledOnce();
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

it(
  '[AC-B3-08t#9] 另一 app 用相同的 run ID 不能改动正在运行的记录',
  async () => {
    const resume = gate();
    const makePorts = pgPorts.createPgRunPorts;
    const ports = vi.spyOn(pgPorts, 'createPgRunPorts');
    const statements: string[] = [];
    const observed = observeRunUpdates(pg.db, (statement) => {
      if (
        /\b(?:intent|input_passed|input_tokens)\b/iu.test(statement.split(/\bwhere\b/iu)[0] ?? '')
      ) {
        statements.push(statement);
      }
    });
    let modelStarted = false;
    const x = await runtimeRig(observed, {
      steps: [
        {
          ...intent('out_of_scope'),
          usage: { input_tokens: 36, output_tokens: 5 },
          before: async () => {
            modelStarted = true;
            await resume.promise;
          },
        },
      ],
    });
    const appB = `synthetic-run-fields-${randomUUID()}`;
    const callerB = await newMember(pg.db, { appId: appB });
    try {
      const active = x.start(await openSession(x.r, x.caller));
      await until('A 已通过输入审核，开始调用模型', () => modelStarted);
      const runId = runIdOf(active.frames());
      // 同一个真实 run ID，只替换调用的 app。直接进入 PG 端口，绕开 HTTP 的归属检查。
      const deps = ports.mock.calls[0]?.[0];
      expect(deps).toBeDefined();
      if (deps === undefined) return;
      const other = makePorts({ ...deps, db: pg.pool() });
      expect(await other.cancel({ appId: callerB.appId, runId })).toBe('not_running');
      const during = await storedRun(pg.db, x.appId, runId);
      expect(during).toMatchObject({ cancel_requested_at: null, intent: null, final_event: null });
      resume.open();
      await active.settled;
      expect(finishOf(active.frames())).toBe('stop');
      expect(await storedRun(pg.db, x.appId, runId)).toMatchObject({
        intent: 'out_of_scope',
        input_passed: true,
        final_event: expect.any(Object),
      });
      await eventually(
        'A 的模型用量已落库',
        () => storedRun(pg.db, x.appId, runId),
        (row) => row.input_tokens === 36,
      );
      // run ID 在表内全局唯一，额外核对更新谓词可发现遗漏 app_id 的实现。
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement).toMatch(/\bwhere\b[\s\S]*\bapp_id\b\s*=/iu);
      }
    } finally {
      resume.open();
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);
