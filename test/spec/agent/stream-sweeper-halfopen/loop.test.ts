// B3-08u 规则测试（claude-independent；SPEC_REF 29c27a1b；BR-AI-23 细则「受理记录与收尾 · 谁来收尾」：没有新请求时由
// worker 定时扫描收尾——锁连接半开时一轮不能把整个 sweeper 挂住约 15 分钟）。任务书 9.3：
// stream/sweeper/loop.ts 一轮钉住的锁连接上三处等待（借连接后的取锁、每步前的 SELECT 1、结束时的解锁）中的一处
// 永不回包（kit 的 HalfOpenDb：从那条语句起该连接什么都不回），这一轮须有上限地放弃。时间只走注入的 schedule 与
// Clock（kit 的 VirtualTime），不等真实时间；测试从不 await 可能被卡住的 promise，卡住只会表现为断言失败。
//
// 本目录钉的可观察结果（上限的取值与写法由实现定，可以是可选配置项，取默认）：
// - 周期取 3 × tickTimeoutMs、无抖动。卡住的那一轮最迟在下一个 'tick' 触发（并让事件循环跑完）时已经结束：交给
//   'tick' 定时器的 promise 已 resolve（不 reject），且到此为止恰有一条 error 行（level 50，msg 以 agent_sweep_
//   开头，除 logger 自带字段外只带 stage / error_name 且为字符串，不带错误消息）。
// - 下一轮照常（不是 busy 跳过）：借一条新连接，在其上依次 取锁 →（SELECT 1 → step）× n → 解锁，连接归还；
//   恰排一个 tick_timeout（时长 tickTimeoutMs），结束时已取消；本轮排的其余定时器除下一个 'tick' 外都不再挂着；
//   一条 agent_sweep_tick，计数与 stream-recovery 同口径；无 warn / error、无 agent_sweep_skipped。
// - 放弃前已派发的那一步不重复派发：下一轮从最后一个按时返回的 step 的 nextCursor 接着走。
// - 被放弃的连接迟到的结果（恢复应答或终于报错）：不再派发 step、不再写任何日志行、游标不变（再下一轮从原处
//   接着走）、没有未处理的拒绝，日志里没有迟到错误的消息。
// 第 7 条是正常连接口径的代表用例（stream-recovery #8 的数字），放在一轮半开之后，主干上同样先红。
import { expect, it } from 'vitest';

import {
  sweepStart,
  type SweepCursor,
  type SweepResult,
} from '../../../../apps/api/src/modules/agent/stream/sweeper/index.ts';
import {
  LATE_FAILURE,
  LEVEL,
  baseFields,
  cursorAt,
  done,
  mark,
  one,
  rig,
  teardown,
  watchUnhandled,
  type LogLine,
  type Mark,
  type Rig,
  type Silence,
} from './kit.ts';

/** The tick timers fired so far, oldest first. */
function ticks(r: Rig) {
  return r.time.fired('tick');
}

/**
 * Exactly one error line so far, carrying only a stage and / or an error name (strings); returns
 * it as written (the abandoned tick may log it as late as when the next tick fires).
 */
function expectOneAbandonError(r: Rig): string {
  const errors = r.logs.all().filter((line) => line.level >= LEVEL.error);
  expect(
    errors.map((line) => line.msg),
    'exactly one error line for the abandoned tick',
  ).toHaveLength(1);
  const line = errors[0]!;
  expect(line.level).toBe(LEVEL.error);
  expect(line.msg).toMatch(/^agent_sweep_/);
  const base = baseFields();
  const extra = Object.keys(line).filter((field) => !base.has(field));
  expect(extra.length, 'the error line names a stage or an error').toBeGreaterThan(0);
  expect(
    extra.filter((field) => field !== 'stage' && field !== 'error_name'),
    'no other field than stage / error_name',
  ).toEqual([]);
  for (const field of extra) expect(typeof line[field], field).toBe('string');
  return r.logs.lines.find((raw) => (JSON.parse(raw) as { level: number }).level >= LEVEL.error)!;
}

/**
 * The tick fired after `m` ran as on a healthy connection (stream-recovery 口径): one new
 * connection, lock → (SELECT 1 → step) per cursor → unlock on it, connection returned, one
 * tick_timeout armed and cancelled, nothing but the next 'tick' left pending, one agent_sweep_tick.
 */
function expectHealthyTick(
  r: Rig,
  m: Mark,
  expected: {
    readonly cursors: readonly SweepCursor[];
    readonly tick: Record<string, unknown>;
    /** The abandonment error line, when it may have been written after the mark. */
    readonly abandonLine?: string;
  },
): void {
  const tick = ticks(r).at(-1)!;
  expect(tick.outcome, 'the healthy tick is over').toBe('resolved');
  expect(r.logs.of('agent_sweep_skipped'), 'not skipped as busy').toEqual([]);

  expect(r.half.lines.length, 'one new connection for the tick').toBe(m.connections + 1);
  const line = r.half.lines.at(-1)!;
  const own = `c${String(line.id)}:`;
  expect(
    r.events
      .slice(m.events)
      .filter((e) => e === 'step' || (e.startsWith(own) && !e.endsWith(':other'))),
    'statements of the tick on its pinned connection',
  ).toEqual([
    `${own}lock`,
    ...expected.cursors.flatMap(() => [`${own}check`, 'step']),
    `${own}unlock`,
  ]);
  expect(line.released, 'the connection went back to the pool').toBe(true);
  expect(r.step.cursors.slice(m.cursors)).toEqual(expected.cursors);

  const armed = r.time.timers.slice(m.timers);
  expect(
    armed.filter((t) => t.purpose === 'tick_timeout').map((t) => [t.delayMs, t.cancelled]),
    'one tick_timeout, cancelled at the end',
  ).toEqual([[r.config.tickTimeoutMs, true]]);
  expect(
    armed.filter((t) => !t.cancelled && !t.fired).map((t) => [t.purpose, t.delayMs]),
    'nothing but the next tick left pending',
  ).toEqual([['tick', r.config.intervalMs]]);

  const lines = r.logs.lines
    .slice(m.lines)
    .filter((raw) => raw !== expected.abandonLine)
    .map((raw) => JSON.parse(raw) as LogLine);
  expect(
    lines.filter((l) => l.level >= LEVEL.warn).map((l) => l.msg),
    'no warn / error by the healthy tick',
  ).toEqual([]);
  expect(lines.filter((l) => l.msg === 'agent_sweep_tick')).toEqual([
    expect.objectContaining({ level: LEVEL.info, ...expected.tick }),
  ]);
}

interface Case {
  readonly no: number;
  readonly title: string;
  /** How the abandoned connection answers late. */
  readonly mode: 'answer' | 'fail';
  readonly silence: Silence;
  /** Step answers of the tick on the silent connection. */
  readonly answers: readonly SweepResult[];
  /** Cursors that tick dispatched before it got stuck. */
  readonly before: readonly SweepCursor[];
  /** Where the next tick goes on (the nextCursor of the last step that answered in time). */
  readonly resume: SweepCursor;
}

const STAGES: readonly Omit<Case, 'no' | 'title' | 'mode'>[] = [
  // 取锁卡住：tick_timeout 还没布，主干上 running 一直不清，此后每轮都 busy。
  {
    silence: { connection: 1, kind: 'lock', nth: 1 },
    answers: [],
    before: [],
    resume: sweepStart(),
  },
  // 第二次 SELECT 1 卡住：第一步已派发并按时返回（游标 1）。
  {
    silence: { connection: 1, kind: 'check', nth: 2 },
    answers: [one(1)],
    before: [sweepStart()],
    resume: cursorAt(1),
  },
  // 解锁卡住：本轮到上限（2 行）正常结束后，解锁不回包。
  {
    silence: { connection: 1, kind: 'unlock', nth: 1 },
    answers: [one(1), one(2)],
    before: [sweepStart(), cursorAt(1)],
    resume: cursorAt(2),
  },
];

const STAGE_TITLES = [
  '取锁卡住（借连接后 pg_try_advisory_lock 不回包）',
  '每步前的 SELECT 1 卡住（第一步已派发并返回之后）',
  '解锁卡住（本轮正常结束后 pg_advisory_unlock 不回包）',
];

const LATE = [
  ['answer', '迟到结果为恢复应答（取锁 true / SELECT 1 / 解锁 true）'],
  ['fail', '迟到结果为报错（连接终于被发现已重置）'],
] as const;

const CASES: Case[] = STAGES.flatMap((stage, i) =>
  LATE.map(([mode, late], j) => ({
    ...stage,
    no: i * LATE.length + j + 1,
    title: `${STAGE_TITLES[i]!}；${late}`,
    mode,
  })),
);

for (const c of CASES) {
  it(`[AC-B3-08u#${String(c.no)}] ${c.title}：最迟到下一个 tick 时本轮已结束（promise resolve、恰一条只带 stage / error_name 的 error），下一轮借新连接照常取锁、派发、解锁，从最后按时返回的游标接着走；被放弃连接的迟到结果不派发、不写日志、不动游标、无未处理的拒绝`, async () => {
    const r = rig({ silence: c.silence, config: { maxPerTick: 2 }, answers: c.answers });
    const watch = watchUnhandled();
    try {
      // The first tick goes stuck on connection 1.
      await r.time.advance(r.config.intervalMs);
      expect(ticks(r), 'the first tick fired').toHaveLength(1);
      expect(r.half.silentLine()?.id, 'connection 1 went silent').toBe(1);
      expect(r.step.cursors).toEqual(c.before);

      // Up to just before the next tick: still nothing more dispatched.
      await r.time.advance(r.config.intervalMs - 1);
      expect(r.step.cursors, 'no step dispatched after the connection went silent').toEqual(
        c.before,
      );

      // The next tick: by now the stuck tick is over, and this one runs as usual.
      r.step.feed(one(101), one(102));
      const m = mark(r);
      await r.time.advance(1);
      expect(ticks(r), 'the second tick fired').toHaveLength(2);
      expect(ticks(r)[0]!.outcome, 'the stuck tick is over by the next tick').toBe('resolved');
      const abandonLine = expectOneAbandonError(r);
      expectHealthyTick(r, m, {
        abandonLine,
        cursors: [c.resume, cursorAt(101)],
        tick: {
          processed: 2,
          finalized: 2,
          skipped_running: 0,
          skipped_held: 0,
          failed: 0,
          wrapped: false,
          duration_ms: 0,
        },
      });

      // The abandoned connection answers late: ignored.
      const cursorsBefore = r.step.cursors.length;
      const linesBefore = r.logs.lines.length;
      expect(r.half.heal(c.mode), 'the stuck statement was still pending').toBeGreaterThan(0);
      await r.time.advance(0);
      expect(r.step.cursors, 'nothing dispatched by the abandoned tick').toHaveLength(
        cursorsBefore,
      );
      expect(r.logs.lines.slice(linesBefore), 'nothing logged by the abandoned tick').toEqual([]);
      expect(watch.reasons, 'no unhandled rejection').toEqual([]);

      // And the tick after that goes on from where the healthy tick stopped.
      const m2 = mark(r);
      await r.time.advance(r.config.intervalMs);
      expect(ticks(r), 'the third tick fired').toHaveLength(3);
      expectHealthyTick(r, m2, {
        cursors: [cursorAt(102)],
        tick: { processed: 0, finalized: 0, failed: 0, wrapped: true, duration_ms: 0 },
      });
      expect(r.logs.all().filter((l) => l.level >= LEVEL.error)).toHaveLength(1);
      expect(r.logs.lines.join('\n')).not.toContain('13800138000');
      expect(r.logs.lines.join('\n')).not.toContain(LATE_FAILURE);
      expect(watch.reasons, 'no unhandled rejection').toEqual([]);
    } finally {
      watch.dispose();
      await teardown(r);
    }
  });
}

it('[AC-B3-08u#7] 正常连接口径未退化（代表用例，同 stream-recovery #8 的数字）：取锁卡住的一轮被放弃后，连着两轮各借一条新连接、各排一个 tick_timeout 并在结束时取消；一轮逐行调用 step，到本轮上限即停、记 agent_sweep_tick（行数合计与 Clock 计的耗时）；下一轮从上一轮停下的游标接着走，wrapped 时本轮结束；每轮结束解锁并归还连接', async () => {
  const r = rig({
    silence: { connection: 1, kind: 'lock', nth: 1 },
    config: { maxPerTick: 2 },
  });
  const watch = watchUnhandled();
  try {
    await r.time.advance(r.config.intervalMs);
    expect(r.half.silentLine()?.id, 'connection 1 went silent on the lock').toBe(1);
    await r.time.advance(r.config.intervalMs - 1);
    expect(r.step.cursors).toEqual([]);

    r.step.costMs = 400;
    r.step.feed(one(1), one(2, 'running'), one(3), done());
    const m = mark(r);
    await r.time.advance(1);
    expect(ticks(r)[0]!.outcome, 'the stuck tick is over by the next tick').toBe('resolved');
    const abandonLine = expectOneAbandonError(r);
    expectHealthyTick(r, m, {
      abandonLine,
      cursors: [sweepStart(), cursorAt(1)],
      tick: {
        processed: 2,
        finalized: 1,
        skipped_running: 1,
        skipped_held: 0,
        failed: 0,
        wrapped: false,
        duration_ms: 800,
      },
    });

    const m2 = mark(r);
    await r.time.advance(r.config.intervalMs);
    expectHealthyTick(r, m2, {
      cursors: [cursorAt(2), cursorAt(3)],
      tick: { processed: 1, finalized: 1, wrapped: true, duration_ms: 800 },
    });
    expect(r.logs.of('agent_sweep_tick')).toHaveLength(2);
    expect(watch.reasons, 'no unhandled rejection').toEqual([]);
  } finally {
    watch.dispose();
    await teardown(r);
  }
});
