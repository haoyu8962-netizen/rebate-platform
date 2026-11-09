// B2-09zj: payout's read-only payout failure port, exported from payout's index.ts (the worker
// reaches other modules only through it). Called on a Kysely that compiles and logs every query but
// never connects (B1-01zzi's recordingDb): it reads payout's own withdrawals and payout_attempts (the
// W6 instant is an attempt's `at`), reads no other module's fund table, writes nothing and reads no
// database clock (the day is the injected clock's). A failed read rejects: no 0 and no partial
// snapshot in its place. The values themselves are checked against PostgreSQL in port.int.test.ts.
import { expect, it } from 'vitest';
import * as payoutIndex from '../../../../../apps/api/src/modules/payout/index.ts';
import {
  FUND_TABLES,
  SQL_CLOCK,
  WRITE_SQL,
  mentions,
  recordingDb,
} from '../../fund-metrics/kit.ts';
import { HOUR_MS, NOW, clockAt, shift } from '../water-level/water-harness.ts';

const APP_A = 'withdrawal_fail_port_a';
const APP_B = 'withdrawal_fail_port_b';
const WITHDRAWAL_ID = '00000000-0000-4000-8000-0000000009a1';

function isWithdrawalRead(query: string): boolean {
  return mentions(query, 'withdrawals');
}

function isAttemptRead(query: string): boolean {
  return mentions(query, 'payout_attempts');
}

/**
 * One row answering every query the port may make: a FAILED withdrawal of `appId` without a manual
 * resolution, its fail attempt an hour ago, a count of '1' for any other column, a Date for any
 * other column named like an instant.
 */
function standInRow(appId: string): Record<string, unknown> {
  const instant = new Date(shift(NOW, -HOUR_MS));
  const fixed: Record<string, unknown> = {
    app_id: appId,
    id: WITHDRAWAL_ID,
    withdrawal_id: WITHDRAWAL_ID,
    status: 'FAILED',
    manual_resolution: null,
    needs_manual: false,
    result: 'fail',
    kind: 'transfer',
    outcome: 'W6',
  };
  return new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, column) {
        if (typeof column !== 'string') return undefined;
        if (Object.hasOwn(fixed, column)) return fixed[column];
        if (/(^|_)at$/.test(column)) return instant;
        return '1';
      },
      has: (_target, column) => typeof column === 'string',
    },
  );
}

function answers(query: string): readonly Record<string, unknown>[] {
  return isWithdrawalRead(query) || isAttemptRead(query)
    ? [standInRow(APP_A), standInRow(APP_B)]
    : [];
}

it('[AC-B2-09zj#10] payout 端口经 payout/index.ts 导出：读 withdrawals 与 payout_attempts；不读别的模块的资金表、不写、不读数据库时钟', async () => {
  expect(typeof payoutIndex.readPayoutWithdrawalFail, 'exported from payout/index.ts').toBe(
    'function',
  );
  const queries: string[] = [];
  await Promise.resolve()
    .then(() => payoutIndex.readPayoutWithdrawalFail(recordingDb(queries, answers), clockAt(NOW)))
    .catch(() => undefined);
  expect(queries.some(isWithdrawalRead), 'reads withdrawals').toBe(true);
  expect(queries.some(isAttemptRead), 'reads payout_attempts (the W6 instant)').toBe(true);
  const foreign = FUND_TABLES.filter(
    (table) => table !== 'withdrawals' && queries.some((q) => mentions(q, table)),
  );
  expect(foreign, 'reads another module fund table').toEqual([]);
  expect(
    queries.filter((q) => WRITE_SQL.test(q)),
    'writes',
  ).toEqual([]);
  expect(
    queries.filter((q) => SQL_CLOCK.test(q)),
    'reads the SQL clock',
  ).toEqual([]);
});

it('[AC-B2-09zj#11] 端口的任一库读失败时端口拒绝（原错误）：提现读失败、尝试记录读失败都不以 0 或只含部分 app 的结果代替', async () => {
  const cases: readonly (readonly [string, (query: string) => boolean])[] = [
    ['withdrawals', isWithdrawalRead],
    ['payout_attempts', isAttemptRead],
  ];
  for (const [label, fails] of cases) {
    const message = `stand-in: ${label} read unavailable`;
    const db = recordingDb([], (query) => {
      if (fails(query)) throw new Error(message);
      return answers(query);
    });
    await expect(
      Promise.resolve().then(() => payoutIndex.readPayoutWithdrawalFail(db, clockAt(NOW))),
      label,
    ).rejects.toThrow(message);
  }
});
