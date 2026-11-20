// B2-07g rule test (claude-independent, SPEC_REF ba6655b1): next_query_at of a batch member
// (contracts/openapi.yaml getAdminPayoutBatch; 08 BR-WDR-14; ruling D10-2017 ②) as the pure
// memberNextQueryAt of application/admin-payout-batches-read.ts. For a member in PAYING with
// needs_manual=false, a kind=transfer attempt (T = its `at`) and channel_state null or processing:
// T + the offset of the first query point strictly later than the injected Clock, never later than
// T + manual_after_min; null otherwise. The points are those of payout.query_schedule (points_min,
// then one every interval_min) — the same source as the query job (application/query-schedule.ts
// nextQueryPoint / nextQueryDueMs), never a second copy of the defaults. Expected instants are written
// by hand; the properties use a hand-written oracle and the query job's own functions. No database.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  memberNextQueryAt,
  type MemberQueryFacts,
} from '../../../../apps/api/src/modules/payout/application/admin-payout-batches-read.ts';
import {
  nextQueryDueMs,
  nextQueryPoint,
  type QuerySchedule,
} from '../../../../apps/api/src/modules/payout/application/query-schedule.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** payout.query_schedule as 规划/04 §10 and BR-WDR-14 default it: T+1, +5, +30, +120 min, then every 120 min, manual at 24 h. */
const DEFAULT: QuerySchedule = {
  points_min: [1, 5, 30, 120],
  interval_min: 120,
  manual_after_min: 1440,
};
const T = new Date('2026-10-30T01:00:00.000Z');

function at(ms: number): Date {
  return new Date(T.getTime() + ms);
}

/** A member waiting for its next query: PAYING, not manual, transfer at T, no WeChat stage. */
function waiting(overrides: Partial<MemberQueryFacts> = {}): MemberQueryFacts {
  return {
    status: 'PAYING',
    needsManual: false,
    channelState: null,
    firstTransferAt: T,
    ...overrides,
  };
}

/** next_query_at as milliseconds after T (null stays null). */
function offsetOf(schedule: QuerySchedule, facts: MemberQueryFacts, elapsedMs: number) {
  const due = memberNextQueryAt(schedule, facts, at(elapsedMs));
  return due === null ? null : due.getTime() - T.getTime();
}

/** Hand-written oracle: T + offset of the first point > now, capped at T + manual_after_min. */
function oracle(schedule: QuerySchedule, t: number, now: number): number {
  const points = schedule.points_min;
  const last = points.length - 1;
  const minutesOf = (n: number): number =>
    n <= last ? points[n]! : points[last]! + (n - last) * schedule.interval_min;
  let n = 0;
  while (t + minutesOf(n) * MINUTE <= now) n += 1;
  return t + Math.min(minutesOf(n), schedule.manual_after_min) * MINUTE;
}

it('[AC-B2-07g#2] 默认节奏：刚转账（T 当时）下一次是 T+1 分；T+30 秒仍是 T+1 分', () => {
  expect([offsetOf(DEFAULT, waiting(), 0), offsetOf(DEFAULT, waiting(), 30_000)]).toEqual([
    1 * MINUTE,
    1 * MINUTE,
  ]);
});

it('[AC-B2-07g#2] 恰在查询点上取下一个点（严格晚于 Clock）：T+1 分整 → T+5 分；T+5 分整 → T+30 分；T+30 分整 → T+2 小时', () => {
  expect([
    offsetOf(DEFAULT, waiting(), 1 * MINUTE),
    offsetOf(DEFAULT, waiting(), 5 * MINUTE),
    offsetOf(DEFAULT, waiting(), 30 * MINUTE),
  ]).toEqual([5 * MINUTE, 30 * MINUTE, 2 * HOUR]);
});

it('[AC-B2-07g#2] 差 1 毫秒到查询点仍是这个点、刚过 1 毫秒是下一个点：T+5 分 −1ms → T+5 分；T+5 分 +1ms → T+30 分', () => {
  expect([
    offsetOf(DEFAULT, waiting(), 5 * MINUTE - 1),
    offsetOf(DEFAULT, waiting(), 5 * MINUTE + 1),
  ]).toEqual([5 * MINUTE, 30 * MINUTE]);
});

it('[AC-B2-07g#2] 过了最后一个固定点（T+2 小时）之后每 2 小时一次：T+2 小时整 → T+4 小时；T+2 小时 +1ms → T+4 小时；T+4 小时整 → T+6 小时；T+13 小时 → T+14 小时', () => {
  expect([
    offsetOf(DEFAULT, waiting(), 2 * HOUR),
    offsetOf(DEFAULT, waiting(), 2 * HOUR + 1),
    offsetOf(DEFAULT, waiting(), 4 * HOUR),
    offsetOf(DEFAULT, waiting(), 13 * HOUR),
  ]).toEqual([4 * HOUR, 4 * HOUR, 6 * HOUR, 14 * HOUR]);
});

it('[AC-B2-07g#2] 上限截到 T+24 小时：T+22 小时整 → T+24 小时；T+23 小时 59 分 → T+24 小时；到了或过了 T+24 小时而 needs_manual 还没置位 → 仍是 T+24 小时，不往后排', () => {
  expect([
    offsetOf(DEFAULT, waiting(), 22 * HOUR),
    offsetOf(DEFAULT, waiting(), 24 * HOUR - MINUTE),
    offsetOf(DEFAULT, waiting(), 24 * HOUR),
    offsetOf(DEFAULT, waiting(), 30 * HOUR),
  ]).toEqual([24 * HOUR, 24 * HOUR, 24 * HOUR, 24 * HOUR]);
});

it('[AC-B2-07g#2] 节奏照读配置：points_min [2, 10]、interval 60、manual_after 300 → 已过 11 分时是 T+70 分；已过 4 小时 11 分时下一点 T+310 分被截到 T+300 分', () => {
  const schedule: QuerySchedule = { points_min: [2, 10], interval_min: 60, manual_after_min: 300 };
  expect([
    offsetOf(schedule, waiting(), 11 * MINUTE),
    offsetOf(schedule, waiting(), 251 * MINUTE),
  ]).toEqual([70 * MINUTE, 300 * MINUTE]);
});

it('[AC-B2-07g#2] manual_after 落在两个点之间时截到 manual_after：默认点、manual_after 100 分，已过 40 分 → T+100 分（不是 T+120 分）', () => {
  const schedule: QuerySchedule = { ...DEFAULT, manual_after_min: 100 };
  expect(offsetOf(schedule, waiting(), 40 * MINUTE)).toBe(100 * MINUTE);
});

it('[AC-B2-07g#2] channel_state 为 processing 照算；wait_user_confirm / canceling 为 null（BR-WDR-33 ⑥，不按 BR-WDR-14 计时）', () => {
  expect([
    offsetOf(DEFAULT, waiting({ channelState: 'processing' }), 3 * MINUTE),
    offsetOf(DEFAULT, waiting({ channelState: 'wait_user_confirm' }), 3 * MINUTE),
    offsetOf(DEFAULT, waiting({ channelState: 'canceling' }), 3 * MINUTE),
  ]).toEqual([5 * MINUTE, null, null]);
});

it('[AC-B2-07g#2] needs_manual=true、没有转账尝试、不是 PAYING（APPROVED / PAID_API / PAID_MANUAL / FAILED / REJECTED / PENDING_REVIEW）一律为 null', () => {
  const statuses = [
    'APPROVED',
    'PAID_API',
    'PAID_MANUAL',
    'FAILED',
    'REJECTED',
    'PENDING_REVIEW',
  ] as const;
  expect([
    offsetOf(DEFAULT, waiting({ needsManual: true }), 3 * MINUTE),
    offsetOf(DEFAULT, waiting({ firstTransferAt: null }), 3 * MINUTE),
    ...statuses.map((status) => offsetOf(DEFAULT, waiting({ status }), 3 * MINUTE)),
  ]).toEqual([null, null, null, null, null, null, null, null]);
});

const scheduleArb = fc
  .record({
    points: fc.uniqueArray(fc.integer({ min: 1, max: 3000 }), { minLength: 1, maxLength: 6 }),
    interval: fc.integer({ min: 5, max: 600 }),
    manual: fc.integer({ min: 1, max: 5000 }),
  })
  .map(({ points, interval, manual }): QuerySchedule => ({
    points_min: [...points].sort((a, b) => a - b),
    interval_min: interval,
    manual_after_min: manual,
  }));
const elapsedArb = fc.integer({ min: 0, max: 3 * 24 * HOUR });
/** T within 2026 to the millisecond (fc.integer bounds are 32-bit: minutes and milliseconds apart). */
const T_BASE = Date.parse('2026-01-01T00:00:00Z');
const tArb = fc
  .tuple(fc.integer({ min: 0, max: 365 * 24 * 60 }), fc.integer({ min: 0, max: MINUTE - 1 }))
  .map(([minutes, ms]) => T_BASE + minutes * MINUTE + ms);

it('[AC-B2-07g#2] 属性：任意配置、T 与已过时长，可查询的成员 next_query_at = T + 第一个严格晚于 Clock 的点的偏移，且不晚于 T + manual_after_min（手写口径）', () => {
  fc.assert(
    fc.property(
      scheduleArb,
      tArb,
      elapsedArb,
      fc.constantFrom<MemberQueryFacts['channelState']>(null, 'processing'),
      (schedule, t, elapsed, channelState) => {
        const due = memberNextQueryAt(
          schedule,
          waiting({ firstTransferAt: new Date(t), channelState }),
          new Date(t + elapsed),
        );
        expect(due?.getTime() ?? null).toBe(oracle(schedule, t, t + elapsed));
        return true;
      },
    ),
    propParams(),
  );
}, 900_000);

it('[AC-B2-07g#2] 属性：与查询任务同一来源——可查询的成员 next_query_at 恰为 query-schedule.ts 的 nextQueryDueMs(schedule, T, nextQueryPoint(schedule, T, now))', () => {
  fc.assert(
    fc.property(scheduleArb, tArb, elapsedArb, (schedule, t, elapsed) => {
      const first = new Date(t);
      const now = new Date(t + elapsed);
      const due = memberNextQueryAt(schedule, waiting({ firstTransferAt: first }), now);
      expect(due?.getTime() ?? null).toBe(
        nextQueryDueMs(schedule, first, nextQueryPoint(schedule, first, now)),
      );
      return true;
    }),
    propParams(),
  );
}, 900_000);

it('[AC-B2-07g#2] 属性：不是 PAYING、needs_manual=true、没有转账尝试或在微信确认阶段（wait_user_confirm / canceling），任一成立即为 null', () => {
  const blocker = fc.constantFrom<string>('status', 'manual', 'no_transfer', 'wait', 'cancel');
  fc.assert(
    fc.property(
      scheduleArb,
      tArb,
      elapsedArb,
      fc.uniqueArray(blocker, { minLength: 1, maxLength: 5 }),
      fc.constantFrom<MemberQueryFacts['status']>(
        'APPROVED',
        'PAID_API',
        'PAID_MANUAL',
        'FAILED',
        'REJECTED',
        'PENDING_REVIEW',
      ),
      (schedule, t, elapsed, blockers, status) => {
        const has = (name: string): boolean => blockers.includes(name);
        const facts: MemberQueryFacts = {
          status: has('status') ? status : 'PAYING',
          needsManual: has('manual'),
          channelState: has('cancel') ? 'canceling' : has('wait') ? 'wait_user_confirm' : null,
          firstTransferAt: has('no_transfer') ? null : new Date(t),
        };
        expect(memberNextQueryAt(schedule, facts, new Date(t + elapsed))).toBeNull();
        return true;
      },
    ),
    propParams(),
  );
}, 900_000);
