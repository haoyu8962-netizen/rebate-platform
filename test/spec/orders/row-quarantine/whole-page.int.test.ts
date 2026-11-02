// B1-04zv（D10-570 ⑥）：一页全坏且 ≥ 5 行多半是上游格式变了：坏行仍写待处理，但任务抛错、水位不动。
// 判的是「全页都坏」，不是坏行数 ≥ 5：4 行全坏、5 坏 1 好都是普通坏行，水位照常前进。任务失败在实现前也成立，
// 所以每条都看待处理记录。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  boundsOf,
  decimalId,
  quarantined,
  WHOLE_PAGE_BAD,
  withWorld,
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

function badRows(w: World, count: number) {
  const ids = Array.from({ length: count }, () => decimalId());
  return { ids, rows: ids.map((id) => w.bad(id)) };
}

it('[AC-B1-04zv#12] 一页全坏且恰 5 行：坏行都写待处理，任务抛错，水位不动', () =>
  withWorld(db, async (w) => {
    const { ids, rows } = badRows(w, WHOLE_PAGE_BAD);
    const run = await w.run('increment', [{ id: '71201', rows }]);
    expect(await w.pending()).toEqual(ids.map((id) => quarantined(w, id, 71201n)));
    expect(run).toMatchObject({ ok: false });
    expect(w.advance).not.toHaveBeenCalled();
    expect(await w.cursor('increment')).toBeNull();
  }));

it('[AC-B1-04zv#12] 4 行全坏：坏行写待处理，任务完成，水位推进', () =>
  withWorld(db, async (w) => {
    const { ids, rows } = badRows(w, WHOLE_PAGE_BAD - 1);
    const run = await w.run('increment', [{ id: '71202', rows }]);
    expect(run).toMatchObject({ ok: true });
    expect(await w.pending()).toEqual(ids.map((id) => quarantined(w, id, 71202n)));
    expect(await w.cursor('increment')).toBe(boundsOf(0).window_end);
  }));

it('[AC-B1-04zv#12] 5 坏 1 好：全页都坏才不前进，好行入库，坏行写待处理，水位推进', () =>
  withWorld(db, async (w) => {
    const { ids, rows } = badRows(w, WHOLE_PAGE_BAD);
    const good = decimalId();
    const run = await w.run('increment', [
      { id: '71203', rows: [...rows.slice(0, 2), w.good(good), ...rows.slice(2)] },
    ]);
    expect(run).toMatchObject({ ok: true });
    expect(await w.subOrders()).toEqual([good]);
    expect(await w.pending()).toEqual(ids.map((id) => quarantined(w, id, 71203n)));
    expect(await w.cursor('increment')).toBe(boundsOf(0).window_end);
  }));

it('[AC-B1-04zv#12] 分页：第 2 页全坏 5 行，前页已入库，坏行写待处理，水位不动', () =>
  withWorld(db, async (w) => {
    const [first, second] = [decimalId(), decimalId()];
    const { ids, rows } = badRows(w, WHOLE_PAGE_BAD);
    const run = await w.run('increment', [
      { id: '71204', rows: [w.good(first), w.good(second)] },
      { id: '71205', rows },
    ]);
    expect(await w.pending()).toEqual(ids.map((id) => quarantined(w, id, 71205n)));
    expect(run).toMatchObject({ ok: false });
    expect(await w.subOrders()).toEqual([first, second].sort());
    expect(w.advance).not.toHaveBeenCalled();
    expect(await w.cursor('increment')).toBeNull();
  }));

it('[AC-B1-04zv#12] 分页：第 1 页全坏 4 行、第 2 页全坏 4 行，不按整窗累计，水位推进', () =>
  withWorld(db, async (w) => {
    const first = badRows(w, WHOLE_PAGE_BAD - 1);
    const second = badRows(w, WHOLE_PAGE_BAD - 1);
    const run = await w.run('increment', [
      { id: '71206', rows: first.rows },
      { id: '71207', rows: second.rows },
    ]);
    expect(run).toMatchObject({ ok: true });
    expect(await w.pending()).toHaveLength((WHOLE_PAGE_BAD - 1) * 2);
    expect(await w.cursor('increment')).toBe(boundsOf(0).window_end);
  }));
