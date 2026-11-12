// B1-10u rule tests, the per-app count on a real database (claude-independent, SPEC_REF 62b5c993):
// 08 BR-ID-15 ④ (举报 48 小时内处理完毕，超时告警) and 编排 D10-1382 ② / D10-1399 (a):
// countOverdueAgentReports(db, appId, now) from agent/index.ts counts exactly the app's replies
// whose report is still pending with now ≥ reported_at + 48 hours — handled, not yet due, never
// reported and other apps' reports are not counted; it reads the `now` given (not the database's
// clock) and changes nothing in agent_messages (or the other agent tables).
// Fixture rows are written directly into agent_messages' report columns (../admin-traces/kit.ts).
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  countOverdueAgentReports,
  isAgentReportOverdue,
} from '../../../../apps/api/src/modules/agent/index.ts';
import {
  agentTables,
  fixture,
  newAppId,
  overdueAt,
  reportSession,
  seedBatch,
  seedReport,
  suite,
} from './kit.ts';
import { DEADLINE_MS, HOUR_MS, exported } from './rule.ts';

const s = suite();

it('[AC-B1-10u#5][BR-ID-15] 计数只算本 app 待处理且已到期的举报：恰好满 48 小时计入、差 1 毫秒不计；已处理、未到期、未被举报、别的 app 都不计；没有举报的 app 为 0', async () => {
  exported();
  const f = fixture(s);
  const batch = await seedBatch(f, newAppId());
  const now = f.clock.now();
  const expected = overdueAt(batch.own, now);
  expect(expected.map((row) => row.label).sort()).toEqual([
    'pending T-30d',
    'pending T-48h',
    'pending T-72h',
  ]);
  expect(await countOverdueAgentReports(f.db, f.appId, now), 'the fixture app').toBe(3);
  expect(await countOverdueAgentReports(f.db, batch.foreignAppId, now), 'the other app').toBe(2);
  expect(await countOverdueAgentReports(f.db, newAppId(), now), 'an app without reports').toBe(0);
  // The count agrees with the shared judgment applied row by row.
  const judged = batch.own.filter((row) =>
    isAgentReportOverdue({ reportStatus: row.status, reportedAt: row.reportedAt }, now),
  );
  expect(judged.map((row) => row.label).sort()).toEqual(expected.map((row) => row.label).sort());
});

it('[AC-B1-10u#6][BR-ID-15] 计数按传入的 now 判定（不取数据库时钟）：同一批数据，now 早 1 毫秒少计恰满 48 小时的一条，晚 1 毫秒多计差 1 毫秒的一条，再过 47 小时待处理的全部计入', async () => {
  exported();
  const f = fixture(s);
  const batch = await seedBatch(f, newAppId());
  const T = f.clock.now().getTime();
  const at = (ms: number): Date => new Date(T + ms);
  const cases: readonly [string, Date, number][] = [
    ['T - 1 ms', at(-1), 2],
    ['T', at(0), 3],
    ['T + 1 ms', at(1), 4],
    ['T + 47 h - 1 ms (the T-1h report 1 ms short)', at(DEADLINE_MS - HOUR_MS - 1), 4],
    ['T + 47 h (the T-1h report exactly due)', at(DEADLINE_MS - HOUR_MS), 5],
    ['T + 30 days', at(30 * 24 * HOUR_MS), 5],
    ['T - 30 days', at(-30 * 24 * HOUR_MS), 0],
  ];
  for (const [label, now, count] of cases) {
    expect(overdueAt(batch.own, now), `oracle at ${label}`).toHaveLength(count);
    expect(await countOverdueAgentReports(f.db, f.appId, now), label).toBe(count);
  }
  // A fresh app whose only report was handled long ago: 0 at any later instant.
  const g = fixture(s);
  const session = await reportSession(g);
  await seedReport(g, session, {
    label: 'handled long ago',
    status: 'handled',
    reportedAt: new Date(T - 10 * DEADLINE_MS),
  });
  expect(await countOverdueAgentReports(g.db, g.appId, at(30 * 24 * HOUR_MS))).toBe(0);
});

it('[AC-B1-10u#7][BR-ID-15] 只读：计数前后 agent_messages（及其余 agent 表）逐行不变', async () => {
  exported();
  const f = fixture(s);
  const batch = await seedBatch(f, newAppId());
  const before = await agentTables(f.db);
  expect(before['agent_messages']?.length ?? 0).toBeGreaterThanOrEqual(
    batch.own.length + batch.foreign.length,
  );
  const now = f.clock.now();
  expect(await countOverdueAgentReports(f.db, f.appId, now)).toBe(3);
  expect(await countOverdueAgentReports(f.db, batch.foreignAppId, now)).toBe(2);
  expect(await agentTables(f.db)).toEqual(before);
});
