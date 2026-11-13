// CT-13e §10; 04 §3.2 / §6.4; D10-1488 option (1).
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { close, dedup, event, insert, open, read, ready, state, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
});
afterAll(async () => {
  await close(h);
});

it('[AC-CT-13e#1] events has the analytics columns, nullable identities and RANGE(server_at); dedup is unpartitioned', async () => {
  await ready(h);
  const columns = await sql`SELECT table_name, column_name, udt_name, is_nullable
    FROM information_schema.columns WHERE table_schema = 'app'
    AND table_name IN ('events', 'event_dedup')`.execute(h.app);
  for (const [table, fields] of [
    [
      'events',
      [
        ['app_id', 'text', 'NO'],
        ['event_id', 'uuid', 'NO'],
        ['event_type', 'text', 'NO'],
        ['name', 'text', 'NO'],
        ['props', 'jsonb', 'NO'],
        ['user_id', 'uuid', 'YES'],
        ['device_id', 'uuid', 'YES'],
        ['client_at', 'timestamptz', 'NO'],
        ['server_at', 'timestamptz', 'NO'],
      ],
    ],
    [
      'event_dedup',
      [
        ['app_id', 'text', 'NO'],
        ['event_type', 'text', 'NO'],
        ['event_id', 'uuid', 'NO'],
        ['created_at', 'timestamptz', 'NO'],
      ],
    ],
  ] as const) {
    for (const [column, type, nullable] of fields) {
      expect(columns.rows).toContainEqual({
        table_name: table,
        column_name: column,
        udt_name: type,
        is_nullable: nullable,
      });
    }
  }
  const shape = await sql`SELECT relname::text AS name, relkind::text AS kind,
    pg_get_partkeydef(oid) AS key FROM pg_class
    WHERE oid IN (to_regclass('app.events'), to_regclass('app.event_dedup')) ORDER BY relname`.execute(
    h.app,
  );
  expect(shape.rows).toEqual([
    { name: 'event_dedup', kind: 'r', key: null },
    { name: 'events', kind: 'p', key: 'RANGE (server_at)' },
  ]);
  const primaryKey = await sql`SELECT ARRAY(
    SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, pos)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.pos
    ) AS columns FROM pg_constraint c
    WHERE c.conrelid = to_regclass('app.event_dedup') AND c.contype = 'p'`.execute(h.app);
  expect(primaryKey.rows).toEqual([{ columns: ['event_type', 'event_id'] }]);
});

it('[AC-CT-13e#2] dedup rejects repeats across dates and apps; distinct type or UUID remains insertable', async () => {
  await ready(h);
  const row = dedup();
  await insert(h.app, 'event_dedup', row);
  for (const override of [{}, { created_at: '2027-01-01T00:00:00Z' }, { app_id: 'other-app' }]) {
    expect(await state(insert(h.app, 'event_dedup', { ...row, ...override }))).toBe('23505');
  }
  expect(await state(insert(h.app, 'event_dedup', { ...row, event_type: 'link_jump' }))).toBe('ok');
  expect(await state(insert(h.app, 'event_dedup', { ...row, event_id: randomUUID() }))).toBe('ok');
  expect(await read(h, 'event_dedup', row['event_id'])).toHaveLength(2);
});

it('[AC-CT-13e#3] concurrent dedup inserts have exactly one winner at the PG unique constraint', async () => {
  await ready(h);
  const row = dedup();
  const outcomes = await Promise.all([
    state(insert(h.app, 'event_dedup', row)),
    state(insert(h.app, 'event_dedup', row)),
  ]);
  expect(outcomes.sort()).toEqual(['23505', 'ok']);
  expect(await read(h, 'event_dedup', row['event_id'])).toHaveLength(1);
});

it('[AC-CT-13e#4] events stores JSON and both clocks; global event uniqueness belongs to the separate dedup table', async () => {
  await ready(h);
  const row = event();
  for (const server_at of ['2026-11-02T00:00:00Z', '2026-11-03T00:00:00Z']) {
    expect(await state(insert(h.app, 'events', { ...row, server_at }))).toBe('ok');
  }
  const stored = await read(h, 'events', row['event_id']);
  expect(stored).toHaveLength(2);
  for (const item of stored) {
    expect(item).toMatchObject({
      app_id: 'couli',
      event_id: row['event_id'],
      name: 'page_view',
      event_type: 'page_view',
      props: { page: 'home', version: 1 },
      user_id: null,
      device_id: null,
      client_at: new Date('2026-11-01T00:00:00Z'),
    });
  }
  expect(stored.map((item) => (item['server_at'] as Date).toISOString()).sort()).toEqual([
    '2026-11-02T00:00:00.000Z',
    '2026-11-03T00:00:00.000Z',
  ]);
});
