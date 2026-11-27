// Unit tests of readAppH5Origins (B1-01zzz): the union over Apps of bridge_origins, else the
// h5_base_url origin, read afresh on every call. Fake Kysely driver: no database.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { afterEach, expect, it } from 'vitest';
import { readAppH5Origins } from './app-h5-origins.ts';

type Config = Map<string, Map<string, unknown>>;

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

async function fakeDb(apps: Config) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    const [key] = query.parameters;
    const rows = [...apps].map(([app_id, items]) => ({
      app_id,
      value: items.get(String(key)) ?? null,
      has_key: items.has(String(key)),
    }));
    return { rows: rows as R[] };
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  handles.push(db);
  return { db, queries };
}

function app(entries: Record<string, unknown>): Map<string, unknown> {
  return new Map(Object.entries(entries));
}

it('[AC-B1-01zzz] union of each App’s bridge_origins, else its h5_base_url origin', async () => {
  const apps: Config = new Map([
    [
      'a',
      app({
        h5_base_url: 'https://h5.a.example.test/releases/stable/',
        bridge_origins: {
          origins: ['https://h5.a.example.test', 'https://web.a.example.test:8443'],
        },
      }),
    ],
    ['b', app({ h5_base_url: 'https://H5.b.example.test:443/index.html?x=1' })],
    // Unusable stored value (lacks the home origin): the home origin only, as the signer does.
    [
      'c',
      app({
        h5_base_url: 'https://h5.c.example.test/',
        bridge_origins: { origins: ['https://elsewhere.example.test'] },
      }),
    ],
    // No https h5_base_url: nothing can be signed, nothing is trusted.
    [
      'd',
      app({
        h5_base_url: 'http://h5.d.example.test/',
        bridge_origins: { origins: ['http://h5.d.example.test'] },
      }),
    ],
    ['e', app({ kf: { url: 'https://support.example.test/' } })],
  ]);
  const { db } = await fakeDb(apps);
  expect([...(await readAppH5Origins(db))].sort()).toEqual([
    'https://h5.a.example.test',
    'https://h5.b.example.test',
    'https://h5.c.example.test',
    'https://web.a.example.test:8443',
  ]);
});

it('[AC-B1-01zzz] every call reads the table again (no cache)', async () => {
  const items = app({ h5_base_url: 'https://h5.a.example.test/' });
  const { db, queries } = await fakeDb(new Map([['a', items]]));
  expect([...(await readAppH5Origins(db))]).toEqual(['https://h5.a.example.test']);
  items.set('bridge_origins', {
    origins: ['https://h5.a.example.test', 'https://new.a.example.test'],
  });
  expect([...(await readAppH5Origins(db))].sort()).toEqual([
    'https://h5.a.example.test',
    'https://new.a.example.test',
  ]);
  expect(queries).toHaveLength(4);
  expect(queries.every((query) => /config_items/.test(query.sql))).toBe(true);
});
