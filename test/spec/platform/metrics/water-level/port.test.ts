// B2-09j: payout's read-only water level port, exported from payout's index.ts (the worker reaches
// other modules only through it). Called on a Kysely that compiles and logs every query but never
// connects (B1-01zzi's recordingDb): it reads W and P, reads no other module's fund table, writes
// nothing and reads no database clock. A failed read rejects: no 0 and no partial snapshot in its
// place. The conclusions themselves are checked against PostgreSQL in port.int.test.ts; the amounts
// past 2^53 are checked here because the stand-in hands them over as PostgreSQL's driver would.
import { expect, it } from 'vitest';
import * as payoutIndex from '../../../../../apps/api/src/modules/payout/index.ts';
import {
  FUND_TABLES,
  SQL_CLOCK,
  WRITE_SQL,
  mentions,
  recordingDb,
} from '../../fund-metrics/kit.ts';
import {
  EXAMPLE_TOTAL_FEN,
  NOW,
  W_30000,
  clockAt,
  isAppWatermarkRead,
  isForecastRead,
  isWaterLowRead,
  isWatermarkRead,
  waterRow,
} from './water-harness.ts';

const APP_A = 'water_port_a';
const APP_B = 'water_port_b';

/** The queries one call compiles. */
async function queriesOf(): Promise<string[]> {
  const queries: string[] = [];
  const db = recordingDb(queries, (query) =>
    isWaterLowRead(query) ? [waterRow(APP_A, W_30000, EXAMPLE_TOTAL_FEN)] : [],
  );
  await Promise.resolve()
    .then(() => payoutIndex.readPayoutWaterLow(db, clockAt(NOW)))
    .catch(() => undefined);
  return queries;
}

it('[AC-B2-09j#1] payout 端口经 payout/index.ts 导出：读 payout_watermarks 与 withdrawals（按通道）；不读别的模块的资金表、不写、不读数据库时钟', async () => {
  expect(typeof payoutIndex.readPayoutWaterLow, 'exported from payout/index.ts').toBe('function');
  const queries = await queriesOf();
  expect(queries.some(isWatermarkRead), 'reads W from payout_watermarks').toBe(true);
  expect(queries.some(isForecastRead), 'reads P from withdrawals by channel').toBe(true);
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

it('[AC-B2-09j#2] 端口的任一库读失败时端口拒绝（原错误）：W 读失败、P 读失败、第二个 app 的 P 读失败都不以 0 或只含部分 app 的结果代替', async () => {
  const twoApps = [
    waterRow(APP_A, W_30000, EXAMPLE_TOTAL_FEN),
    waterRow(APP_B, W_30000, EXAMPLE_TOTAL_FEN),
  ];
  let forecastReads = 0;
  const cases: readonly (readonly [string, (query: string) => boolean])[] = [
    ['W', (query) => isWatermarkRead(query)],
    ['P', (query) => isForecastRead(query)],
    [
      'the second app P',
      (query) => {
        if (!isForecastRead(query)) return false;
        forecastReads += 1;
        return forecastReads === 2;
      },
    ],
  ];
  for (const [label, fails] of cases) {
    const message = `stand-in: ${label} read unavailable`;
    const queries: string[] = [];
    const db = recordingDb(queries, (query) => {
      if (fails(query)) throw new Error(message);
      return isWaterLowRead(query) ? twoApps : [];
    });
    await expect(
      Promise.resolve().then(() => payoutIndex.readPayoutWaterLow(db, clockAt(NOW))),
      label,
    ).rejects.toThrow(message);
  }
});

it('[AC-B2-09j#3] 整数比较，不用浮点：超过 2^53 的金额仍分得清差 1 分（P = 1.2e16 分，W 比 1.5P 少 1 分值 1，W 恰为 1.5P 值 0）', async () => {
  const total = 28_000_000_000_000_000n;
  const oneFenBelow = 17_999_999_999_999_999n;
  const exactly = 18_000_000_000_000_000n;
  // As doubles the two W are the same number, so only an integer comparison tells them apart.
  expect(Number(oneFenBelow)).toBe(Number(exactly));

  const read = (availableFen: bigint) =>
    payoutIndex.readPayoutWaterLow(
      recordingDb([], (query) =>
        isWaterLowRead(query) ? [waterRow(APP_A, availableFen, total)] : [],
      ),
      clockAt(NOW),
    );
  expect(await read(oneFenBelow)).toEqual({ waterLow: { [APP_A]: 1 } });
  expect(await read(exactly)).toEqual({ waterLow: { [APP_A]: 0 } });
});

it('[AC-B2-09j#27] app 列表读成功、某个 app 的 W 读失败时端口也拒绝（原错误）：第一个、第二个 app 都一样，不留没有 key 的结果', async () => {
  const twoApps = [
    waterRow(APP_A, W_30000, EXAMPLE_TOTAL_FEN),
    waterRow(APP_B, W_30000, EXAMPLE_TOTAL_FEN),
  ];
  for (const failing of [1, 2]) {
    const message = `stand-in: W read ${failing} unavailable`;
    let appWatermarkReads = 0;
    const db = recordingDb([], (query) => {
      if (isAppWatermarkRead(query)) {
        appWatermarkReads += 1;
        if (appWatermarkReads === failing) throw new Error(message);
      }
      return isWaterLowRead(query) ? twoApps : [];
    });
    // Only the per-app read throws this message, so the rejection also shows the list went through.
    await expect(
      Promise.resolve().then(() => payoutIndex.readPayoutWaterLow(db, clockAt(NOW))),
      `app W read ${failing}`,
    ).rejects.toThrow(message);
  }
});
