// B1-10u rule tests, the judgment alone (claude-independent, SPEC_REF 62b5c993): 08 BR-ID-15 ④
// (举报在 48 小时内处理完毕……超时告警) and its 细则 (48 小时时限从举报提交起算; 例：9-29 10:00 提交 →
// 最迟 10-01 10:00 前须标为已处理), 编排 D10-1382 ② / D10-1399 (a): isAgentReportOverdue from
// agent/index.ts is true exactly when the report is pending and now ≥ reported_at + 48 hours —
// exactly 48 hours is overdue, 1 ms short is not; handled and never reported are always false.
// The answer depends only on the arguments (the `now` given, never the system clock). No database.
// Top-level it() only (规划/11 §4.3).
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  isAgentReportOverdue,
  type AgentReportOverdueInput,
} from '../../../../apps/api/src/modules/agent/index.ts';
import { DEADLINE_MS, HOUR_MS, expectedOverdue, exported, type ReportStatus } from './rule.ts';

/** BR-ID-15 细则's example: reported 2026-09-29 10:00 (+08:00). */
const REPORTED = new Date('2026-09-29T10:00:00+08:00');
/** The latest moment it may still be pending: 2026-10-01 10:00 (+08:00). */
const DEADLINE = new Date('2026-10-01T10:00:00+08:00');

function after(at: Date, ms: number): Date {
  return new Date(at.getTime() + ms);
}

it('[AC-B1-10u#1][BR-ID-15] 待处理举报：恰好满 48 小时（10-01 10:00 整）算超时，差 1 毫秒不算；更晚恒为超时，提交时刻与之前不算；结果只看传入的 now，入参不被改动', () => {
  exported();
  expect(DEADLINE.getTime() - REPORTED.getTime()).toBe(DEADLINE_MS);
  const report: AgentReportOverdueInput = { reportStatus: 'pending', reportedAt: REPORTED };
  const cases: readonly [string, Date, boolean][] = [
    ['exactly 48 h (10-01 10:00:00.000)', DEADLINE, true],
    ['1 ms short of 48 h (10-01 09:59:59.999)', after(DEADLINE, -1), false],
    ['48 h + 1 ms', after(DEADLINE, 1), true],
    ['47 h 59 min', after(REPORTED, DEADLINE_MS - 60_000), false],
    ['30 days later', after(REPORTED, 30 * 24 * HOUR_MS), true],
    ['at the submission', REPORTED, false],
    ['before the submission', after(REPORTED, -HOUR_MS), false],
  ];
  for (const [label, now, overdue] of cases) {
    expect(isAgentReportOverdue(report, now), label).toBe(overdue);
  }
  // Long past by the wall clock, yet 1 ms short by the `now` given: not overdue (no system clock).
  const old: AgentReportOverdueInput = {
    reportStatus: 'pending',
    reportedAt: new Date('2001-01-01T00:00:00.000Z'),
  };
  expect(isAgentReportOverdue(old, new Date('2001-01-02T23:59:59.999Z')), 'old, 1 ms short').toBe(
    false,
  );
  expect(isAgentReportOverdue(old, new Date('2001-01-03T00:00:00.000Z')), 'old, exactly 48 h').toBe(
    true,
  );
  // Neither argument is changed.
  const now = after(DEADLINE, 5);
  isAgentReportOverdue(report, now);
  expect(report).toEqual({ reportStatus: 'pending', reportedAt: REPORTED });
  expect(report.reportedAt?.getTime()).toBe(REPORTED.getTime());
  expect(now.getTime()).toBe(DEADLINE.getTime() + 5);
});

it('[AC-B1-10u#2][BR-ID-15] 已处理（handled）的举报恒不超时：无论举报多久之前、是否恰好满 48 小时', () => {
  exported();
  // Control first: the same instants are overdue while pending (a skeleton that answers false for
  // everything does not pass this test).
  expect(
    isAgentReportOverdue({ reportStatus: 'pending', reportedAt: REPORTED }, DEADLINE),
    'pending control',
  ).toBe(true);
  const handled: AgentReportOverdueInput = { reportStatus: 'handled', reportedAt: REPORTED };
  const instants: readonly Date[] = [
    REPORTED,
    after(DEADLINE, -1),
    DEADLINE,
    after(DEADLINE, 1),
    after(REPORTED, 365 * 24 * HOUR_MS),
  ];
  for (const now of instants) {
    expect(isAgentReportOverdue(handled, now), `handled at ${now.toISOString()}`).toBe(false);
  }
});

it('[AC-B1-10u#3][BR-ID-15] 未被举报（report_status 为 null）恒不超时：reported_at 为 null，或即便带着时刻', () => {
  exported();
  expect(
    isAgentReportOverdue({ reportStatus: 'pending', reportedAt: REPORTED }, after(DEADLINE, 1)),
    'pending control',
  ).toBe(true);
  const instants: readonly Date[] = [REPORTED, DEADLINE, after(REPORTED, 365 * 24 * HOUR_MS)];
  for (const now of instants) {
    expect(
      isAgentReportOverdue({ reportStatus: null, reportedAt: null }, now),
      `never reported at ${now.toISOString()}`,
    ).toBe(false);
    expect(
      isAgentReportOverdue({ reportStatus: null, reportedAt: REPORTED }, now),
      `status null with a time at ${now.toISOString()}`,
    ).toBe(false);
  }
});

it('[AC-B1-10u#4][BR-ID-15] 性质：任意提交时刻与任意 now，结果 = 待处理且 now − reported_at ≥ 48 小时（毫秒精度，48 小时整两侧加密采样）', () => {
  exported();
  const statuses: readonly ReportStatus[] = ['pending', 'handled', null];
  const base = fc.integer({
    min: Date.parse('2025-01-01T00:00:00.000Z'),
    max: Date.parse('2030-01-01T00:00:00.000Z'),
  });
  const delta = fc.oneof(
    fc.integer({ min: -10 * 24 * HOUR_MS, max: 10 * 24 * HOUR_MS }),
    fc.integer({ min: DEADLINE_MS - 2000, max: DEADLINE_MS + 2000 }),
    fc.constantFrom(DEADLINE_MS - 1, DEADLINE_MS, DEADLINE_MS + 1),
  );
  fc.assert(
    fc.property(fc.constantFrom(...statuses), base, delta, (status, reportedMs, deltaMs) => {
      const reportedAt = new Date(reportedMs);
      const now = new Date(reportedMs + deltaMs);
      const got = isAgentReportOverdue(
        { reportStatus: status, reportedAt: status === null ? null : reportedAt },
        now,
      );
      expect(got).toBe(expectedOverdue(status, status === null ? null : reportedAt, now));
      expect(got).toBe(status === 'pending' && deltaMs >= DEADLINE_MS);
    }),
    { numRuns: 500 },
  );
});
