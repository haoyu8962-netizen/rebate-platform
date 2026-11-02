// B1-04zv：增量、回扫、手动窗口三条路径走同一套：坏行进待处理，一页全坏且 ≥ 5 行不动水位，写待处理失败时任务
// 失败。手动路径本来就不读不推水位，所以它看 order_sync_requests 的进度。同任务重试幂等。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  boundsOf,
  decimalId,
  PENDING_INSERT,
  quarantined,
  ROUTES,
  sabotage,
  WHOLE_PAGE_BAD,
  withWorld,
  type Route,
  type World,
} from './worker-harness.ts';

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

/** The job finished its window on `route`: the cursor moved once, or the manual request ended. */
async function expectFinished(w: World, route: Route, stored: number): Promise<void> {
  if (route === 'manual') {
    expect(w.advance).not.toHaveBeenCalled();
    expect(await w.requests()).toEqual([
      expect.objectContaining({ status: 'done', stored_count: stored, error: null }),
    ]);
    return;
  }
  expect(w.advance).toHaveBeenCalledTimes(1);
  expect(await w.cursor(route)).toBe(boundsOf(0).window_end);
}

/** The job did not finish its window on `route`. */
async function expectUnfinished(w: World, route: Route): Promise<void> {
  expect(w.advance).not.toHaveBeenCalled();
  expect(await w.cursor('increment')).toBeNull();
  expect(await w.cursor('rescan')).toBeNull();
  if (route === 'manual') {
    expect(await w.requests()).toEqual([expect.objectContaining({ finished_at: null })]);
  }
}

it.each(ROUTES)('[AC-B1-04zv#13] %s：好行入库，坏行写待处理并告警，窗口照常结束', (route) =>
  withWorld(db, async (w) => {
    const [good, broken] = [decimalId(), decimalId()];
    const run = await w.run(route, [{ id: '71301', rows: [w.good(good), w.bad(broken)] }]);
    expect(run).toMatchObject({ ok: true });
    expect(await w.subOrders()).toEqual([good]);
    expect(await w.pending()).toEqual([quarantined(w, broken, 71301n, { order_id: null })]);
    expect(w.alerts()).toHaveLength(1);
    await expectFinished(w, route, 1);
  }),
);

it.each(ROUTES)(
  '[AC-B1-04zv#13] %s：一页全坏 5 行，坏行写待处理，任务抛错，窗口不算结束',
  (route) =>
    withWorld(db, async (w) => {
      const ids = Array.from({ length: WHOLE_PAGE_BAD }, () => decimalId());
      const run = await w.run(route, [{ id: '71302', rows: ids.map((id) => w.bad(id)) }]);
      expect(await w.pending()).toEqual(ids.map((id) => quarantined(w, id, 71302n)));
      expect(run).toMatchObject({ ok: false });
      await expectUnfinished(w, route);
    }),
);

it.each(ROUTES)(
  '[AC-B1-04zv#13] %s：写待处理失败时任务失败、窗口不算结束；重试写成后才结束',
  async (route) => {
    const broken = sabotage(db, PENDING_INSERT);
    await withWorld(
      db,
      async (w) => {
        const id = decimalId();
        broken.state.armed = true;
        const failed = await w.run(route, [{ id: '71303', rows: [w.bad(id)] }]);
        broken.state.armed = false;
        expect(broken.state.hits, 'the pending INSERT was reached').toBeGreaterThan(0);
        expect(failed).toMatchObject({ ok: false });
        expect(await w.pending()).toEqual([]);
        await expectUnfinished(w, route);
        if (route === 'manual') return;

        const retried = await w.run(route, [{ id: '71304', rows: [w.bad(id)] }], { attempt: 2 });
        expect(retried).toMatchObject({ ok: true });
        expect(await w.pending()).toEqual([quarantined(w, id, 71304n)]);
        await expectFinished(w, route, 0);
      },
      broken.db,
    );
  },
);

it('[AC-B1-04zv#14] 同任务重试幂等：第 1 次在第 2 页失败，重试后只有一条 open 记录、一条 P1，水位只进一次', () =>
  withWorld(db, async (w) => {
    const [good, broken, later] = [decimalId(), decimalId(), decimalId()];
    const page = { id: '71401', rows: [w.good(good), w.bad(broken)] };
    const failed = await w.run('increment', [page, 'outage']);
    expect(failed).toMatchObject({ ok: false });
    const opened = await w.pending();
    expect(opened).toEqual([quarantined(w, broken, 71401n)]);
    expect(w.advance).not.toHaveBeenCalled();

    w.clock.advanceMs(70_000);
    const retried = await w.run(
      'increment',
      [
        { ...page, id: '71402' },
        { id: '71403', rows: [w.good(later)] },
      ],
      { attempt: 2 },
    );
    expect(retried).toMatchObject({ ok: true });
    expect(await w.pending()).toEqual(
      opened.map((row) => ({ ...row, detected_at: w.clock.now() })),
    );
    expect(w.alerts()).toHaveLength(1);
    expect(await w.subOrders()).toEqual([good, later].sort());
    expect(w.advance).toHaveBeenCalledTimes(1);
    expect(await w.cursor('increment')).toBe(boundsOf(0).window_end);
  }));
