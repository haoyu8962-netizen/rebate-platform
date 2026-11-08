// B3-08z: agent's read-only port without a database (contract: ./kit.ts header). The stand-in
// database compiles and logs every statement and never connects (B1-01zzi's recordingDb, read only,
// not changed): the port only reads agent_runs / agent_cards / agent_sessions, writes nothing, takes
// no row lock, never reads the database clock, and a failing read rejects with that error.
import { expect, it } from 'vitest';
import { createPgAgentTraceMissingPort } from '../../../../apps/api/src/modules/agent/store/trace-missing/index.ts';
import { SQL_CLOCK, WRITE_SQL, mentions, recordingDb } from '../fund-metrics/kit.ts';
import { NOW, PORT_TABLES, ROW_LOCK, appTables } from './kit.ts';

it('[AC-B3-08z#8] 端口只读：只有读 agent_runs、agent_cards（及 agent_sessions）的语句，不写、不加行锁、不读库时钟；库里没有行时结果为空数组', async () => {
  const queries: string[] = [];
  const port = createPgAgentTraceMissingPort({ db: recordingDb(queries, () => []) });

  expect(await port.countMissing(new Date(NOW))).toEqual([]);

  expect(queries.length, 'the port reads the database').toBeGreaterThan(0);
  expect(
    queries.filter((q) => WRITE_SQL.test(q)),
    'no writes',
  ).toEqual([]);
  expect(
    queries.filter((q) => ROW_LOCK.test(q)),
    'no row locks',
  ).toEqual([]);
  expect(
    queries.filter((q) => SQL_CLOCK.test(q)),
    'no database clock',
  ).toEqual([]);
  expect(
    queries.some((q) => mentions(q, 'agent_runs')),
    'reads agent_runs',
  ).toBe(true);
  expect(
    queries.some((q) => mentions(q, 'agent_cards')),
    'reads agent_cards',
  ).toBe(true);
  const allowed: readonly string[] = PORT_TABLES;
  const others = queries.flatMap(appTables).filter((table) => !allowed.includes(table));
  expect(others, 'tables outside agent_runs / agent_cards / agent_sessions').toEqual([]);
});

it('[AC-B3-08z#9] 读失败时端口原样拒绝，不给空结果、不编 0', async () => {
  const queries: string[] = [];
  const message = 'stand-in: agent trace read unavailable';
  const port = createPgAgentTraceMissingPort({
    db: recordingDb(queries, () => {
      throw new Error(message);
    }),
  });

  await expect(port.countMissing(new Date(NOW))).rejects.toThrow(message);
  expect(queries.length, 'the failing read was tried').toBeGreaterThan(0);
});
