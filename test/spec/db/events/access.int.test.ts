// CT-13e §10: D10-1489's explicitly requested default is tested, not treated as approval.
// Cleanup option: couli_maint receives SELECT/DELETE on event_dedup (no DDL).
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  close,
  dedup,
  ensure,
  event,
  insert,
  open,
  person,
  read,
  ready,
  state,
  update,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
});
afterAll(async () => {
  await close(h);
});

it('[AC-CT-13e#5] app may INSERT/SELECT both tables; only events.user_id has column UPDATE permission', async () => {
  await ready(h);
  for (const table of ['events', 'event_dedup'] as const) {
    const row = await insert(h.app, table, table === 'events' ? event() : dedup());
    expect(await read(h, table, row['event_id'])).toEqual([row]);
    for (const privilege of [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
      'MAINTAIN',
    ]) {
      const result =
        await sql`SELECT has_table_privilege('couli_app', ${`app.${table}`}, ${privilege}) AS allowed`.execute(
          h.app,
        );
      expect(result.rows, `${table}/${privilege}`).toEqual([
        { allowed: privilege === 'SELECT' || privilege === 'INSERT' },
      ]);
    }
    const columns = await sql<{ name: string; allowed: boolean }>`SELECT a.attname::text AS name,
      has_column_privilege('couli_app', a.attrelid, a.attname, 'UPDATE') AS allowed
      FROM pg_attribute a WHERE a.attrelid = to_regclass(${`app.${table}`})
      AND a.attnum > 0 AND NOT a.attisdropped`.execute(h.app);
    for (const column of columns.rows) {
      expect(column.allowed, `${table}/${column.name}`).toBe(
        table === 'events' && column.name === 'user_id',
      );
    }
    expect(
      await state(
        sql`DELETE FROM ${sql.table(`app.${table}`)} WHERE event_id = ${row['event_id']}`.execute(
          h.app,
        ),
      ),
    ).toBe('42501');
    expect(await state(sql`TRUNCATE ${sql.table(`app.${table}`)}`.execute(h.app))).toBe('42501');
    if (table === 'event_dedup') {
      for (const key of ['event_type', 'event_id', 'created_at', 'app_id']) {
        expect(await state(update(h, table, row['event_id'], { [key]: row[key] }))).toBe('42501');
      }
    }
    expect(await read(h, table, row['event_id'])).toEqual([row]);
  }
});

it('[AC-CT-13e#6] detachment clears only user_id, in both DEFAULT and a runtime daily partition', async () => {
  await ready(h);
  await ensure(h, 'events', '2031-06-05');
  const user = await person(h);
  const device = randomUUID();
  await insert(h.app, 'devices', {
    id: device,
    app_id: 'couli',
    user_id: null,
    device_hash: 'a'.repeat(64),
    id_source: 'idfv',
    platform: 'ios',
    app_version: '1.0.0',
    install_secret_cipher: Buffer.from('synthetic-install-secret'),
    last_seen_at: '2031-06-05T00:00:00Z',
  });
  for (const server_at of ['2031-06-05T00:00:00Z', '2031-06-07T00:00:00Z']) {
    const row = await insert(
      h.app,
      'events',
      event({ user_id: user, device_id: device, server_at }),
    );
    expect(await state(update(h, 'events', row['event_id'], { user_id: null }))).toBe('ok');
    expect(await read(h, 'events', row['event_id'])).toEqual([{ ...row, user_id: null }]);
  }
});

it('[AC-CT-13e#7] BEFORE UPDATE guard rejects reassignment, attaching guests and repeated/no-op detachment', async () => {
  await ready(h);
  await ensure(h, 'events', '2032-06-05');
  const user = await person(h);
  const other = await person(h);
  for (const server_at of ['2032-06-05T00:00:00Z', '2032-06-07T00:00:00Z']) {
    const row = await insert(h.app, 'events', event({ user_id: user, server_at }));
    for (const user_id of [other, user]) {
      expect(['23001', 'P0001']).toContain(
        await state(update(h, 'events', row['event_id'], { user_id })),
      );
      expect(await read(h, 'events', row['event_id'])).toEqual([row]);
    }
    expect(await state(update(h, 'events', row['event_id'], { user_id: null }))).toBe('ok');
    for (const user_id of [user, null]) {
      expect(['23001', 'P0001']).toContain(
        await state(update(h, 'events', row['event_id'], { user_id })),
      );
      expect(await read(h, 'events', row['event_id'])).toEqual([{ ...row, user_id: null }]);
    }
    const guest = await insert(h.app, 'events', event({ server_at }));
    expect(['23001', 'P0001']).toContain(
      await state(update(h, 'events', guest['event_id'], { user_id: user })),
    );
    expect(await read(h, 'events', guest['event_id'])).toEqual([guest]);
  }
  const triggers = await sql`SELECT c.relname::text AS name FROM pg_class c
    WHERE (c.oid = to_regclass('app.events') OR c.oid IN (
      SELECT inhrelid FROM pg_inherits WHERE inhparent = to_regclass('app.events')
    )) AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid
      AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')
      AND (t.tgtype::integer & 19) = 19)`.execute(h.app);
  expect(triggers.rows).toEqual([]);
});

it('[AC-CT-13e#8] app cannot smuggle any other field change into a detachment, including moving partitions', async () => {
  await ready(h);
  const user = await person(h);
  const row = await insert(h.app, 'events', event({ user_id: user }));
  const changes = {
    app_id: 'other-app',
    event_id: randomUUID(),
    event_type: 'link_jump',
    name: 'link_jump',
    props: JSON.stringify({ page: 'other' }),
    device_id: randomUUID(),
    client_at: '2027-01-01T00:00:00Z',
    server_at: '2027-01-01T00:00:00Z',
  };
  for (const [key, value] of Object.entries(changes)) {
    for (const values of [{ [key]: value }, { [key]: value, user_id: null }]) {
      expect(await state(update(h, 'events', row['event_id'], values)), key).toBe('42501');
      expect(await read(h, 'events', row['event_id'])).toEqual([row]);
    }
  }
});

it('[AC-CT-13e#9] maint can delete dedup rows by created_at while app cannot; cleanup leaves boundary/new rows', async () => {
  await ready(h);
  const rows = [];
  for (const created_at of [
    '2026-11-01T15:59:59.999Z',
    '2026-11-01T16:00:00Z',
    '2026-11-02T00:00:00Z',
  ]) {
    rows.push(await insert(h.app, 'event_dedup', dedup({ created_at })));
  }
  const ids = rows.map((row) => row['event_id']);
  const statement = sql`DELETE FROM app.event_dedup
    WHERE event_id IN (${sql.join(ids)}) AND created_at < '2026-11-02T00:00:00+08:00'::timestamptz`;
  expect(await state(statement.execute(h.app))).toBe('42501');
  expect(await state(statement.execute(h.maint))).toBe('ok');
  expect(await read(h, 'event_dedup', ids[0])).toEqual([]);
  expect(await read(h, 'event_dedup', ids[1])).toEqual([rows[1]]);
  expect(await read(h, 'event_dedup', ids[2])).toEqual([rows[2]]);
  for (const privilege of ['INSERT', 'UPDATE', 'TRUNCATE']) {
    const result =
      await sql`SELECT has_table_privilege('couli_maint', 'app.event_dedup', ${privilege}) AS allowed`.execute(
        h.app,
      );
    expect(result.rows).toEqual([{ allowed: false }]);
  }
});
