// B1-04zv：坏行的 P1 日志。规则同 B1-04zs：同键 open 已存在且 raw_status、detail 都与本次相同才算真重复，
// 只刷新 detected_at、不重打；坏法变了要再打。日志只打平铺字段，不打子订单号与金额（orders/AGENTS.md 第 10 条）。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { num } from '../../union/jd-orders/kit.ts';
import { BAD_AMOUNT, decimalId, quarantined, REASON, withWorld } from './worker-harness.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-04zv#7] 一条坏行一条 P1 日志，事件名 order_row_invalid，带平台与 App，不带单号与金额', () =>
  withWorld(db, async (w) => {
    const broken = decimalId();
    const run = await w.run('increment', [
      { id: '70701', rows: [w.good(decimalId()), w.bad(broken)] },
    ]);
    expect(run).toMatchObject({ ok: true });
    const alerts = w.alerts();
    expect(alerts).toEqual([expect.objectContaining({ platform: 'jd', app_id: w.app })]);
    const text = JSON.stringify(alerts);
    expect(text).not.toContain(broken);
    expect(text).not.toContain(BAD_AMOUNT);
  }));

it('[AC-B1-04zv#7] 同一坏行重复（同 raw_status、同 detail）：不重打，只刷新 detected_at', () =>
  withWorld(db, async (w) => {
    const broken = decimalId();
    const first = await w.run('increment', [{ id: '70702', rows: [w.bad(broken)] }]);
    expect(first).toMatchObject({ ok: true });
    const opened = await w.pending();
    expect(opened).toEqual([quarantined(w, broken, 70702n, { detected_at: w.clock.now() })]);
    expect(w.alerts()).toHaveLength(1);

    w.clock.advanceMs(70_000);
    const again = await w.run('increment', [{ id: '70703', rows: [w.bad(broken)] }], { window: 1 });
    expect(again).toMatchObject({ ok: true });
    expect(await w.pending()).toEqual(
      opened.map((row) => ({ ...row, detected_at: w.clock.now() })),
    );
    expect(w.alerts()).toHaveLength(1);
  }));

it.each([
  {
    label: 'detail 变了（换了一个坏字段）',
    worse: { estimateFee: num('1.23'), estimateCosPrice: BAD_AMOUNT },
  },
  { label: 'raw_status 变了', worse: { validCode: num('24') } },
])('[AC-B1-04zv#7] 坏法变了要再打：$label，存量行不多开', ({ worse }) =>
  withWorld(db, async (w) => {
    const broken = decimalId();
    const first = await w.run('increment', [{ id: '70704', rows: [w.bad(broken)] }]);
    expect(first).toMatchObject({ ok: true });
    expect(w.alerts()).toHaveLength(1);

    w.clock.advanceMs(70_000);
    const changed = await w.run('increment', [{ id: '70705', rows: [w.bad(broken, worse)] }], {
      window: 1,
    });
    expect(changed).toMatchObject({ ok: true });
    expect(await w.pending()).toEqual([
      expect.objectContaining({
        sub_order_id: broken,
        reason: REASON,
        status: 'open',
        detected_at: w.clock.now(),
      }),
    ]);
    expect(w.alerts()).toHaveLength(2);
  }),
);
