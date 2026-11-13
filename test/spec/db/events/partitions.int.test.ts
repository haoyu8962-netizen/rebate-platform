// CT-13e §10; ADR-0001 §4.2 #4/#5/#8; BR-ID-30 events retention is 90 days.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  close,
  ensure,
  event,
  insert,
  open,
  partitions,
  read,
  ready,
  state,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
});
afterAll(async () => {
  await close(h);
});

it('[AC-CT-13e#10] migration creates only DEFAULT; ensure routes server_at across exact +08:00 day boundaries', async () => {
  await ready(h);
  const initial = await partitions(h, 'events');
  expect(initial).toHaveLength(1);
  expect(initial[0]?.bound).toBe('DEFAULT');
  await ensure(h, 'events', '2035-03-01');
  await ensure(h, 'events', '2035-03-02');
  await ensure(h, 'events', '2035-03-01'); // Repeated calls must be idempotent.
  expect(await partitions(h, 'events')).toHaveLength(3);
  const cases = [
    ['2035-02-28T15:59:59.999999Z', `app.${initial[0]!.name}`],
    ['2035-02-28T16:00:00Z', 'app.events_p20350301'],
    ['2035-03-01T15:59:59.999999Z', 'app.events_p20350301'],
    ['2035-03-01T16:00:00Z', 'app.events_p20350302'],
    ['2035-03-02T16:00:00Z', `app.${initial[0]!.name}`],
  ];
  for (const [server_at, destination] of cases) {
    const row = await insert(
      h.app,
      'events',
      event({
        server_at,
        client_at: '2000-01-01T00:00:00Z',
      }),
    );
    const actual = await sql`SELECT tableoid::regclass::text AS destination
      FROM app.events WHERE event_id = ${row['event_id']}`.execute(h.app);
    expect(actual.rows).toEqual([{ destination }]);
  }
});

it('[AC-CT-13e#11] DEFAULT rows prevent overlapping partition creation without losing data', async () => {
  await ready(h);
  const row = await insert(h.app, 'events', event({ server_at: '2036-02-29T00:00:00+08:00' }));
  const before = await partitions(h, 'events');
  expect(
    await state(sql`SELECT app.ensure_events_day_partition('2036-02-29'::date)`.execute(h.maint)),
  ).toBe('23514');
  expect(await partitions(h, 'events')).toEqual(before);
  expect(await read(h, 'events', row['event_id'])).toEqual([row]);
});

it('[AC-CT-13e#12] drop uses supplied +08:00 midnight minus 90 days, preserving cutoff day and DEFAULT; link_logs still works', async () => {
  await ready(h);
  // 2024-04-01 minus 90 calendar days = 2024-01-02 (leap year).
  for (const table of ['events', 'link_logs']) {
    for (const day of ['2024-01-01', '2024-01-02', '2024-01-03']) {
      await ensure(h, table, day);
    }
  }
  const old = await insert(h.app, 'events', event({ server_at: '2024-01-01T23:59:59.999+08:00' }));
  const boundary = await insert(h.app, 'events', event({ server_at: '2024-01-02T00:00:00+08:00' }));
  const fallback = await insert(h.app, 'events', event({ server_at: '2001-01-01T00:00:00Z' }));
  const log = await sql`INSERT INTO app.link_logs (app_id, event, result_code, created_at)
    VALUES ('couli', 'convert', 0, '2024-01-01T23:59:59+08:00')
    RETURNING tableoid::regclass::text AS destination`.execute(h.app);
  expect(log.rows).toEqual([{ destination: 'app.link_logs_p20240101' }]);
  for (const table of ['events', 'link_logs']) {
    const run = (now: string) => {
      const statement =
        table === 'events'
          ? sql<{ dropped: string[] }>`SELECT
          app.drop_expired_events_day_partitions(${now}::timestamptz) AS dropped`
          : sql<{ dropped: string[] }>`SELECT
          app.drop_expired_day_partitions(${table}, ${now}::timestamptz) AS dropped`;
      return statement.execute(h.maint);
    };
    // One microsecond before +08 midnight still belongs to March 31: keep January 1.
    expect((await run('2024-03-31T15:59:59.999999Z')).rows).toEqual([{ dropped: [] }]);
    expect((await run('2024-03-31T16:00:00Z')).rows).toEqual([{ dropped: [`${table}_p20240101`] }]);
    expect((await run('2024-04-01T20:00:00+08:00')).rows).toEqual([{ dropped: [] }]);
    const remaining = await partitions(h, table);
    expect(remaining.map((part) => part.name)).toEqual(
      expect.arrayContaining([`${table}_p20240102`, `${table}_p20240103`]),
    );
    expect(remaining.filter((part) => part.bound === 'DEFAULT')).toHaveLength(1);
    expect(remaining.map((part) => part.name)).not.toContain(`${table}_p20240101`);
  }
  expect(await read(h, 'events', old['event_id'])).toEqual([]);
  expect(await read(h, 'events', boundary['event_id'])).toEqual([boundary]);
  expect(await read(h, 'events', fallback['event_id'])).toEqual([fallback]);
});

it('[AC-CT-13e#13] shared functions still reject events with 22023; dedicated functions validate arguments without mutating partitions', async () => {
  await ready(h);
  await ensure(h, 'events', '2037-01-01');
  const before = await partitions(h, 'events');
  for (const table of [
    'events',
    'event_dedup',
    'event_log',
    'orders',
    'ledger_entries',
    'EVENTS',
    ' events',
    'events ',
    'app.events',
    'events_default',
    'events_p20370101',
    '',
    "events'; DROP TABLE app.events;--",
  ]) {
    expect(
      await state(
        sql`SELECT app.ensure_day_partition(${table}, '2037-01-02'::date)`.execute(h.maint),
      ),
      table,
    ).toBe('22023');
    expect(
      await state(
        sql`SELECT app.drop_expired_day_partitions(${table}, '2100-01-01'::timestamptz)`.execute(
          h.maint,
        ),
      ),
      table,
    ).toBe('22023');
  }
  for (const day of ['1999-12-31', '10000-01-01', 'infinity', '-infinity']) {
    expect(
      await state(sql`SELECT app.ensure_events_day_partition(${day}::date)`.execute(h.maint)),
    ).toBe('22023');
  }
  for (const now of ['infinity', '-infinity']) {
    expect(
      await state(
        sql`SELECT app.drop_expired_events_day_partitions(${now}::timestamptz)`.execute(h.maint),
      ),
    ).toBe('22023');
  }
  expect(
    await state(sql`SELECT app.ensure_events_day_partition(NULL::date)`.execute(h.maint)),
  ).toBe('22004');
  expect(
    await state(
      sql`SELECT app.drop_expired_events_day_partitions(NULL::timestamptz)`.execute(h.maint),
    ),
  ).toBe('22004');
  expect(await partitions(h, 'events')).toEqual(before);
});

it('[AC-CT-13e#14] functions retain owner, SECURITY DEFINER, fixed search_path/settings and maint-only execution; maint has no DDL', async () => {
  await ready(h);
  for (const name of ['ensure_events_day_partition', 'drop_expired_events_day_partitions']) {
    const definition = await sql<{
      owner: string;
      definer: boolean;
      config: string[];
      acl: string[];
    }>`SELECT
      pg_get_userbyid(p.proowner)::text AS owner, p.prosecdef AS definer,
      p.proconfig AS config, p.proacl::text[] AS acl
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname = ${name}`.execute(h.app);
    expect(definition.rows).toHaveLength(1);
    const row = definition.rows[0]!;
    expect(row.owner).toBe('couli_migrator');
    expect(row.definer).toBe(true);
    expect(row.config).toEqual(
      expect.arrayContaining([
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s',
        'DateStyle=ISO, YMD',
        'TimeZone=UTC',
      ]),
    );
    expect(row.acl).toEqual(
      expect.arrayContaining(['couli_maint=X/couli_migrator', 'couli_migrator=X/couli_migrator']),
    );
    expect(row.acl).toHaveLength(2);
  }
  expect(
    await state(sql`SELECT app.ensure_events_day_partition('2038-01-01'::date)`.execute(h.app)),
  ).toBe('42501');
  expect(
    await state(
      sql`SELECT app.drop_expired_events_day_partitions('2100-01-01'::timestamptz)`.execute(h.app),
    ),
  ).toBe('42501');
  await ensure(h, 'events', '2038-01-01');
  expect(
    await state(
      sql`CREATE TABLE app.events_p20380102 PARTITION OF app.events
    FOR VALUES FROM ('2038-01-02T00:00:00+08:00') TO ('2038-01-03T00:00:00+08:00')`.execute(
        h.maint,
      ),
    ),
  ).toBe('42501');
  expect(
    await state(sql`ALTER TABLE app.events DETACH PARTITION app.events_p20380101`.execute(h.maint)),
  ).toBe('42501');
  expect(await state(sql`DROP TABLE app.events_p20380101`.execute(h.maint))).toBe('42501');
});

it('[AC-CT-13e#15] ensure and drop retain their shared bounded advisory lock, with no partial creation/deletion', async () => {
  await ready(h);
  await ensure(h, 'events', '2023-01-01');
  await h.maint.transaction().execute(async (holder) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(
      'app.ensure_events_day_partition:events_p20390101', 0))`.execute(holder);
    expect(
      await state(sql`SELECT app.ensure_events_day_partition('2039-01-01'::date)`.execute(h.maint)),
    ).toBe('55P03');
  });
  expect((await partitions(h, 'events')).map((part) => part.name)).not.toContain(
    'events_p20390101',
  );
  const before = await partitions(h, 'events');
  await h.maint.transaction().execute(async (holder) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(
      'app.ensure_events_day_partition:events_p20230101', 0))`.execute(holder);
    expect(
      await state(
        sql`SELECT app.drop_expired_events_day_partitions('2023-06-01'::timestamptz)`.execute(
          h.maint,
        ),
      ),
    ).toBe('55P03');
  });
  expect(await partitions(h, 'events')).toEqual(before);
  await ensure(h, 'events', '2039-01-01');
  const dropped =
    await sql`SELECT app.drop_expired_events_day_partitions('2023-06-01'::timestamptz) AS dropped`.execute(
      h.maint,
    );
  expect(dropped.rows).toEqual([{ dropped: ['events_p20230101'] }]);
}, 20_000);

it('[AC-CT-13e#16] maint-only DEFAULT purge validates time and deletes only rows before the +08:00 90-day cutoff', async () => {
  await ready(h);
  // Assert existence before calling: a missing function must fail an assertion in the red run.
  const definition = await sql<{
    owner: string;
    definer: boolean;
    returns: string;
    acl: string[];
  }>`SELECT pg_get_userbyid(p.proowner)::text AS owner, p.prosecdef AS definer,
    p.prorettype::regtype::text AS returns, p.proacl::text[] AS acl
    FROM pg_proc p
    WHERE p.oid = to_regprocedure('app.purge_expired_events_default(timestamptz)')`.execute(h.app);
  expect(definition.rows).toHaveLength(1);
  expect(definition.rows[0]).toEqual({
    owner: 'couli_migrator',
    definer: true,
    returns: 'bigint',
    acl: expect.arrayContaining([
      'couli_maint=X/couli_migrator',
      'couli_migrator=X/couli_migrator',
    ]),
  });
  expect(definition.rows[0]!.acl).toHaveLength(2);

  // These dates precede the other cases' DEFAULT fixtures. April 2 minus 90 days is January 3.
  // UTC is still April 1, and local time is 04:00: neither UTC midnight nor now - 90 days works.
  const now = '2000-04-01T20:00:00Z';
  await ensure(h, 'events', '2000-01-01');
  const partitioned = await insert(
    h.app,
    'events',
    event({ server_at: '2000-01-01T12:00:00+08:00' }),
  );
  const fallback = [];
  for (const server_at of [
    '1999-12-31T00:00:00+08:00',
    '2000-01-02T23:59:59.999999+08:00',
    '2000-01-03T00:00:00+08:00',
    '2000-01-03T01:00:00+08:00',
  ]) {
    const row = await insert(h.app, 'events', event({ server_at }));
    fallback.push(row);
    const destination = await sql`SELECT tableoid::regclass::text AS destination
      FROM app.events WHERE event_id = ${row['event_id']}`.execute(h.app);
    expect(destination.rows).toEqual([{ destination: 'app.events_default' }]);
  }
  const dedupRow = await insert(h.app, 'event_dedup', {
    app_id: 'couli',
    event_type: fallback[0]!['event_type'],
    event_id: fallback[0]!['event_id'],
    created_at: '1999-12-31T00:00:00+08:00',
  });
  const before = await partitions(h, 'events');

  expect(
    await state(sql`SELECT app.purge_expired_events_default(${now}::timestamptz)`.execute(h.app)),
  ).toBe('42501');
  expect(
    await state(sql`SELECT app.purge_expired_events_default(NULL::timestamptz)`.execute(h.maint)),
  ).toBe('22004');
  for (const invalid of ['infinity', '-infinity']) {
    expect(
      await state(
        sql`SELECT app.purge_expired_events_default(${invalid}::timestamptz)`.execute(h.maint),
      ),
    ).toBe('22023');
  }

  const purged = await sql<{ deleted: bigint }>`SELECT
    app.purge_expired_events_default(${now}::timestamptz) AS deleted`.execute(h.maint);
  expect(purged.rows).toEqual([{ deleted: 2n }]);
  for (const row of fallback.slice(0, 2)) {
    expect(await read(h, 'events', row['event_id'])).toEqual([]);
  }
  for (const row of [...fallback.slice(2), partitioned]) {
    expect(await read(h, 'events', row['event_id'])).toEqual([row]);
  }
  expect(await read(h, 'event_dedup', dedupRow['event_id'])).toEqual([dedupRow]);
  expect(await partitions(h, 'events')).toEqual(before);
  const repeated = await sql<{ deleted: bigint }>`SELECT
    app.purge_expired_events_default(${now}::timestamptz) AS deleted`.execute(h.maint);
  expect(repeated.rows).toEqual([{ deleted: 0n }]);
});
