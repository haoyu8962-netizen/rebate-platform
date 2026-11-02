import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type Transaction,
} from 'kysely';
import { afterEach, expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { RebateDependencies } from '../../settlement/index.ts';
import { createSystemAuditWriter } from './system-audit.ts';

const AT = '2026-10-08T03:00:00.123Z';
const ORDER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';
const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

// Real Kysely SQL compilation with an in-memory driver; no socket or database.
async function recording() {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    return { rows: [] as R[] };
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

const input = {
  appId: 'couli',
  orderId: ORDER,
  attrAt: new Date(Date.parse('2001-02-03T04:05:06.000Z')),
  actor: 'system:risk',
  reason: 'UNMAPPED_STATUS',
  before: { hold: false, holdReason: null },
  after: { hold: true, holdReason: 'UNMAPPED_STATUS' },
  at: new Date(Date.parse('2001-02-03T04:05:06.000Z')),
} as const;

it('[AC-B1-34p] the insert runs on the handle it is given, one statement, at from the Clock', async () => {
  const { db, queries } = await recording();
  const clock = new FixedClock(AT);
  const writer: RebateDependencies['audit'] = createSystemAuditWriter({ clock });
  await writer.append(db as Transaction<DB>, input);
  expect(queries).toHaveLength(1);
  expect(queries[0]?.sql).toMatch(/^insert into app\.audit_logs/);
  expect(queries[0]?.parameters).toEqual([
    'couli',
    'system:risk',
    'order_auto_hold',
    `orders:${ORDER}`,
    '{"hold":false,"hold_reason":null}',
    '{"hold":true,"hold_reason":"UNMAPPED_STATUS"}',
    clock.now(),
  ]);
});

it('[AC-B1-34p] the snapshots go through the audit redaction', async () => {
  const { db, queries } = await recording();
  const writer = createSystemAuditWriter({ clock: new FixedClock(AT) });
  await writer.append(db as Transaction<DB>, {
    ...input,
    before: { hold: false, holdReason: '13800138000' },
  });
  expect(queries[0]?.parameters[4]).not.toContain('13800138000');
});
