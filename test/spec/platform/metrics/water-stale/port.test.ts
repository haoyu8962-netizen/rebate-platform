// B2-09ze: payout's read-only stale W port, exported from payout's index.ts (the worker reaches other
// modules only through it). Called on a Kysely that compiles and logs every query but never connects
// (B1-01zzi's recordingDb): it reads the waiting withdrawals and the W rows, reads no other module's
// fund table, writes nothing and reads no database clock. A failed read rejects: no 0 and no partial
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
import { HOUR_MS, NOW, W_30000, clockAt, shift } from '../water-level/water-harness.ts';

const APP_A = 'water_stale_port_a';
const APP_B = 'water_stale_port_b';

function isWatermarkRead(query: string): boolean {
  return mentions(query, 'payout_watermarks');
}

function isWithdrawalRead(query: string): boolean {
  return mentions(query, 'withdrawals');
}

/**
 * One row answering every query the port may make: an app (app_id) with a waiting withdrawal
 * (status, payout_channel, a count) and a W row (available_fen, measured_at three hours old).
 */
function standInRow(appId: string): Record<string, unknown> {
  return {
    app_id: appId,
    status: 'APPROVED',
    payout_channel: 'alipay',
    channel: 'alipay',
    count: '1',
    n: '1',
    available_fen: W_30000,
    measured_at: new Date(shift(NOW, -3 * HOUR_MS)),
    created_at: new Date(shift(NOW, -3 * HOUR_MS)),
    entered_by: 'finance:synthetic',
  };
}

function answers(query: string): readonly Record<string, unknown>[] {
  return isWatermarkRead(query) || isWithdrawalRead(query)
    ? [standInRow(APP_A), standInRow(APP_B)]
    : [];
}

it('[AC-B2-09ze#10] payout 端口经 payout/index.ts 导出：读 payout_watermarks 与 withdrawals；不读别的模块的资金表、不写、不读数据库时钟', async () => {
  expect(typeof payoutIndex.readPayoutWaterStale, 'exported from payout/index.ts').toBe('function');
  const queries: string[] = [];
  await Promise.resolve()
    .then(() => payoutIndex.readPayoutWaterStale(recordingDb(queries, answers), clockAt(NOW)))
    .catch(() => undefined);
  expect(queries.some(isWatermarkRead), 'reads W from payout_watermarks').toBe(true);
  expect(queries.some(isWithdrawalRead), 'reads the waiting withdrawals').toBe(true);
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

it('[AC-B2-09ze#11] 端口的任一库读失败时端口拒绝（原错误）：W 读失败、提现读失败都不以 0 或只含部分 app 的结果代替', async () => {
  const cases: readonly (readonly [string, (query: string) => boolean])[] = [
    ['W', isWatermarkRead],
    ['withdrawals', isWithdrawalRead],
  ];
  for (const [label, fails] of cases) {
    const message = `stand-in: ${label} read unavailable`;
    const queries: string[] = [];
    const db = recordingDb(queries, (query) => {
      if (fails(query)) throw new Error(message);
      return answers(query);
    });
    await expect(
      Promise.resolve().then(() => payoutIndex.readPayoutWaterStale(db, clockAt(NOW))),
      label,
    ).rejects.toThrow(message);
  }
});
