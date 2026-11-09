// B2-02v: ledger's read-only port behind the gauge, exported from ledger's index.ts (the worker
// reaches other modules only through it). Called on a Kysely that compiles and logs every query but
// never connects (B1-01zzi's recordingDb): it reads recon_diffs, reads no other module's fund table,
// writes nothing and reads no database clock. A failed read rejects: no 0 and no partial snapshot in
// its place. The values themselves are checked against PostgreSQL in port.int.test.ts.
import { expect, it } from 'vitest';
import * as ledgerIndex from '../../../../../apps/api/src/modules/ledger/index.ts';
import {
  FUND_TABLES,
  SQL_CLOCK,
  WRITE_SQL,
  mentions,
  numericRow,
  recordingDb,
} from '../../fund-metrics/kit.ts';

function isDiffRead(query: string): boolean {
  return mentions(query, 'recon_diffs');
}

function answers(query: string): readonly Record<string, unknown>[] {
  return isDiffRead(query) ? [numericRow('1', { app_id: 'postcheck_port' })] : [];
}

it('[AC-B2-02v#10] ledger 端口经 ledger/index.ts 导出：读 recon_diffs；不读别的模块的资金表、不写、不读数据库时钟', async () => {
  expect(typeof ledgerIndex.readCreditPostcheckOpen, 'exported from ledger/index.ts').toBe(
    'function',
  );
  const queries: string[] = [];
  await Promise.resolve()
    .then(() => ledgerIndex.readCreditPostcheckOpen(recordingDb(queries, answers)))
    .catch(() => undefined);
  expect(queries.some(isDiffRead), 'reads recon_diffs').toBe(true);
  expect(
    FUND_TABLES.filter((table) => queries.some((q) => mentions(q, table))),
    'reads another module fund table',
  ).toEqual([]);
  expect(
    queries.filter((q) => WRITE_SQL.test(q)),
    'writes',
  ).toEqual([]);
  expect(
    queries.filter((q) => SQL_CLOCK.test(q)),
    'reads the SQL clock',
  ).toEqual([]);
});

it('[AC-B2-02v#11] 库读失败时端口拒绝（原错误），不以 0 或空结果代替', async () => {
  const message = 'stand-in: recon_diffs read unavailable';
  const queries: string[] = [];
  const db = recordingDb(queries, (query) => {
    if (isDiffRead(query)) throw new Error(message);
    return [];
  });
  await expect(
    Promise.resolve().then(() => ledgerIndex.readCreditPostcheckOpen(db)),
  ).rejects.toThrow(message);
});
