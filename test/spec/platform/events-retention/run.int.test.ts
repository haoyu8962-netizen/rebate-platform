// CT-13f：真库把事件分区、DEFAULT 和去重表放到同一截断两侧，验证 worker 的实际接线。
import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';

import { reduceLine } from '../maintenance/kit.ts';
import { inWorld } from '../retention/kit.ts';
import { CUTOFF, dedupIds, NOW, requireFunction, seedDedup, workerAt } from './kit.ts';

async function seedEvent(db: Kysely<DB>, at: string, clientAt: string): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO app.events
      (app_id, event_id, event_type, name, props, client_at, server_at)
    VALUES ('couli', ${id}::uuid, 'synthetic-retention', 'synthetic-retention', '{}'::jsonb,
      ${clientAt}::timestamptz, ${at}::timestamptz)
  `.execute(db);
  return id;
}

async function eventIds(db: Kysely<DB>): Promise<string[]> {
  const result = await sql<{ id: string }>`
    SELECT event_id::text AS id FROM app.events ORDER BY event_id
  `.execute(db);
  return result.rows.map((row) => row.id);
}

async function partitions(db: Kysely<DB>): Promise<string[]> {
  const result = await sql<{ name: string }>`
    SELECT c.relname::text AS name FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'app.events'::regclass ORDER BY c.relname
  `.execute(db);
  return result.rows.map((row) => row.name);
}

it('[AC-CT-13f#20] 04:00 真库运行：整日旧分区删除、DEFAULT 旧行删除、去重旧行删除；截断当刻与以后保留，依据 server_at 而非 client_at', async () => {
  await inWorld(await createTestDatabase(), async ({ app, maint }) => {
    await requireFunction(maint);
    for (const day of ['2026-07-10', '2026-07-11']) {
      await sql`SELECT app.ensure_events_day_partition(${day}::date)`.execute(maint);
    }
    // 旧日分区、旧 DEFAULT、截断当日分区、较新 DEFAULT；client_at 故意与服务端时间相反。
    await seedEvent(app, '2026-07-10T15:59:59.999999Z', NOW);
    await seedEvent(app, '2026-07-08T16:00:00.000Z', NOW);
    const atId = await seedEvent(app, CUTOFF, '2000-01-01T00:00:00.000Z');
    const laterId = await seedEvent(app, '2026-07-12T16:00:00.000Z', '2000-01-01T00:00:00.000Z');
    await seedDedup(app, '2026-07-10T15:59:59.999999Z');
    await seedDedup(app, '2020-01-01T00:00:00.000Z', 'other-app');
    const dedupAt = await seedDedup(app, CUTOFF);
    const dedupLater = await seedDedup(app, '2026-07-12T16:00:00.000Z', 'other-app');

    const run = workerAt(maint, '2026-10-08T19:59:59.999Z');
    await run.maintenance.runOnce();
    expect(await eventIds(app)).toHaveLength(4);
    expect(await dedupIds(app)).toHaveLength(4);
    expect(await partitions(app)).toContain('events_p20260710');
    run.clock.set(NOW);
    run.lines.length = 0;
    await run.maintenance.runOnce();

    expect(await eventIds(app)).toEqual([atId, laterId].sort());
    expect(await dedupIds(app)).toEqual([dedupAt, dedupLater].sort());
    expect(await partitions(app)).toEqual([
      'events_default',
      'events_p20260711',
      ...Array.from({ length: 15 }, (_, i) => `events_p202610${String(9 + i).padStart(2, '0')}`),
    ]);
    const records = run.lines.map(reduceLine);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 30, table: 'events', partition: 'events_p20260710' }),
        expect.objectContaining({ level: 30, table: 'events_default', rows: 1 }),
        expect.objectContaining({ level: 30, table: 'event_dedup', rows: 2 }),
        expect.objectContaining({
          level: 40,
          table: 'events',
          partition: 'events_default',
          rows: 1,
          msg: 'partition_default_has_rows',
        }),
      ]),
    );
  });
}, 60_000);
