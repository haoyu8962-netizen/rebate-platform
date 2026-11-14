// CT-13i §9 / D10-1519–1520. Local AC labels; refs is empty for this technical hardening task.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { recordEvents } from '../../../../apps/api/src/modules/analytics/index.ts';
import { batch, close, event, keys, open, rows, TIMEOUT, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-CT-13i#1] 去重表的真实主键依次为 app_id、event_type、event_id，不绑定迁移编号', async () => {
  const result = await sql<{ name: string }>`
    select a.attname as name
    from pg_constraint c
    cross join lateral unnest(c.conkey) with ordinality as k(attnum, position)
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.conrelid = 'app.event_dedup'::regclass and c.contype = 'p'
    order by k.position
  `.execute(h.observer);
  expect(result.rows.map((row) => row.name)).toEqual(['app_id', 'event_type', 'event_id']);
});

it('[AC-CT-13i#2] 两 app 的同类型同 ID 各接受一次，各自读取原内容；重放只在本 app 内去重', async () => {
  const shared = event();
  const left = batch([{ ...shared, props: { owner: 'left' } }]);
  const right = batch([{ ...shared, props: { owner: 'right' } }]);
  await expect(recordEvents(h.left, left)).resolves.toEqual({ accepted: 1, duplicates: 0 });
  await expect(recordEvents(h.right, right)).resolves.toEqual({ accepted: 1, duplicates: 0 });
  const leftRows = await rows(h.observer, left.appId);
  const rightRows = await rows(h.observer, right.appId);
  expect(leftRows).toHaveLength(1);
  expect(rightRows).toHaveLength(1);
  expect(leftRows[0]).toMatchObject({
    app_id: left.appId,
    event_id: shared.eventId,
    props: { owner: 'left' },
  });
  expect(rightRows[0]).toMatchObject({
    app_id: right.appId,
    event_id: shared.eventId,
    props: { owner: 'right' },
  });
  for (const input of [left, right]) {
    const replay = { ...input, events: [{ ...shared, props: { replaced: true } }, shared] };
    await expect(recordEvents(h.left, replay)).resolves.toEqual({ accepted: 0, duplicates: 2 });
    expect(await keys(h.observer, input.appId)).toEqual([
      expect.objectContaining({
        app_id: input.appId,
        event_type: shared.eventType,
        event_id: shared.eventId,
      }),
    ]);
  }
  expect(await rows(h.observer, left.appId)).toEqual(leftRows);
  expect(await rows(h.observer, right.appId)).toEqual(rightRows);
});
