// B1-04zzr (D10-798 ⑧, linked B1-01zzr): the watermark lag leaves out query_kind 'rescan' and every
// 'rescan_*' (rights / manual still by exact value), and couli_sync_rescan_position_seconds takes
// the same streams, one series per (app_id, platform, query_kind), so each Taobao tier has its own.
// A 'rescanx' stream (what LIKE 'rescan_%' would also take) is a sync stream. Asserted through
// collectWorkerMetrics(db, clock) on a READ ONLY session and the rendered worker registry, with the
// fixtures of test/spec/platform/metrics-sync-streams/kit.ts (read, not changed).
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  collectWorkerMetrics,
  createMetricsRegistry,
} from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import { cursorSnapshot, readOnlyUrl } from '../../platform/metrics/kit.ts';
import {
  NOW,
  OTHER_APP,
  at,
  insertAccount,
  insertStream,
  lagSeries,
  rescanKey,
  rescanSeries,
} from '../../platform/metrics-sync-streams/kit.ts';

async function open() {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  const readOnly = createDb({ connectionString: readOnlyUrl(database), max: 2 });
  return {
    db,
    readOnly,
    async close() {
      await destroyDb(readOnly);
      await destroyDb(db);
      await database.drop();
    },
  };
}

it('[AC-B1-04zzr#38] 水位滞后排除 rescan 与 rescan_* 各档（rescanx、rights_x 照常计入），回扫位置 gauge 每档一条序列；下次 scrape 跟注入时钟、不写库', async () => {
  const t = await open();
  try {
    const taobao1 = await insertAccount(t.db, 'taobao');
    const taobao2 = await insertAccount(t.db, 'taobao');
    const jd = await insertAccount(t.db, 'jd');
    const pdd = await insertAccount(t.db, 'pdd');
    const otherTaobao = await insertAccount(t.db, 'taobao', OTHER_APP);
    // [app_id, platform, account, query_kind, offset from NOW in seconds]
    const rows: readonly (readonly [string, string, string, string, number])[] = [
      // taobao sync streams: increment −100, 'rescanx' −300, 'rights_x' −400 → lag 400. Its rescan
      // tiers (far older) and rights / manual are left out.
      ['couli', 'taobao', taobao1, 'increment', -100],
      ['couli', 'taobao', taobao1, 'rescanx', -300],
      ['couli', 'taobao', taobao1, 'rights_x', -400],
      ['couli', 'taobao', taobao1, 'rescan', -90_000],
      ['couli', 'taobao', taobao1, 'rescan_hour', -7200],
      ['couli', 'taobao', taobao2, 'rescan_hour', -9000],
      ['couli', 'taobao', taobao1, 'rescan_week', -7_000_000],
      ['couli', 'taobao', taobao1, 'rights', -80_000],
      ['couli', 'taobao', taobao1, 'manual', -85_000],
      // jd: increment only → lag 60.
      ['couli', 'jd', jd, 'increment', -60],
      // pdd: only a rescan_* stream → no lag series; its position −3000.5 → 3000.
      ['couli', 'pdd', pdd, 'rescan_hour', -3000.5],
      // The other App's taobao week tier: a series of its own app_id.
      [OTHER_APP, 'taobao', otherTaobao, 'rescan_week', -50],
    ];
    for (const [appId, platform, accountId, queryKind, offset] of rows) {
      await insertStream(t.db, { appId, platform, accountId, queryKind, cursorAt: at(offset) });
    }
    const before = await cursorSnapshot(t.db);
    const clock = new FixedClock(NOW);

    const snapshot = await collectWorkerMetrics(t.readOnly, clock);
    expect(snapshot.syncWatermarkLagSeconds).toEqual({ taobao: 400, jd: 60 });
    const positions = Object.fromEntries(
      (snapshot.rescanPositionSeconds ?? []).map((s) => [
        rescanKey(s.appId, s.platform, s.queryKind),
        s.seconds,
      ]),
    );
    const expected = {
      [rescanKey('couli', 'taobao', 'rescan')]: 90_000,
      [rescanKey('couli', 'taobao', 'rescan_hour')]: 9000,
      [rescanKey('couli', 'taobao', 'rescan_week')]: 7_000_000,
      [rescanKey('couli', 'pdd', 'rescan_hour')]: 3000,
      [rescanKey(OTHER_APP, 'taobao', 'rescan_week')]: 50,
    };
    expect(positions).toEqual(expected);

    const registry = createMetricsRegistry({
      entry: 'worker',
      collect: () => collectWorkerMetrics(t.readOnly, clock),
    });
    const text = await registry.render();
    expect(lagSeries(text)).toEqual({ taobao: 400, jd: 60 });
    expect(rescanSeries(text)).toEqual(expected);

    clock.advanceMs(60_000);
    const later = await registry.render();
    expect(lagSeries(later)).toEqual({ taobao: 460, jd: 120 });
    expect(rescanSeries(later)).toEqual(
      Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, value + 60])),
    );

    expect(await cursorSnapshot(t.db)).toEqual(before);
  } finally {
    await t.close();
  }
}, 60_000);
