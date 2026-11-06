// Unit tests of the withdrawal review hit writer without a database (B2-05q): Kysely runs on a
// scripted driver that records every connection checkout, transaction boundary and compiled
// statement, to pin that the writer
//   - works on the caller's transaction only (no second connection, no transaction of its own);
//   - registers the rule with ON CONFLICT DO NOTHING before the hit, never updating a rule;
//   - never reads the rule status;
//   - writes the hit as ref_type withdrawal / risk_action manual_review with the request-only
//     columns null, and the registration and the hit at one Clock instant.
// The SQL itself runs against PostgreSQL in the rule tests
// (test/spec/payout/withdraw-blocklist-hits).
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import type { Clock } from '../../platform/index.ts';
import { createWithdrawalReviewHits } from './withdrawal-review-hits.ts';

const START_MS = Date.parse('2026-11-06T02:00:00.000Z');
const USER = '018f0000-0000-7000-8000-00000000000a';
const WITHDRAWAL = '018f0000-0000-7000-8000-00000000000b';

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** Each read moves 700 ms on: a second read of the Clock would show in the rows. */
class SteppingClock implements Clock {
  private epochMs = START_MS;
  now(): Date {
    const instant = new Date(this.epochMs);
    this.epochMs += 700;
    return instant;
  }
}

function setup() {
  const statements: Statement[] = [];
  const events: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push({ sql: compiled.sql, parameters: compiled.parameters });
      events.push(compiled.sql.split(' ')[0] ?? '');
      return Promise.resolve({ rows: [] } as unknown as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => {
      events.push('acquire');
      return connection;
    },
    beginTransaction: async () => void events.push('begin'),
    commitTransaction: async () => void events.push('commit'),
    rollbackTransaction: async () => void events.push('rollback'),
    releaseConnection: async () => void events.push('release'),
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements, events };
}

/** The named columns of a single-row insert; `$n` placeholders resolve to parameters. */
function insertedRow(statement: Statement): Record<string, unknown> {
  const columns = /\(([^)]*)\) values/.exec(statement.sql)?.[1];
  const tuple = /\) values \(([^)]*)\)/.exec(statement.sql)?.[1];
  if (columns === undefined || tuple === undefined) throw new Error('not an insert');
  const names = columns.split(',').map((column) => column.trim().replaceAll('"', ''));
  const cells = tuple.split(',').map((cell) => cell.trim());
  const row: Record<string, unknown> = {};
  names.forEach((name, index) => {
    const cell = cells[index] ?? '';
    const placeholder = /^\$(\d+)$/.exec(cell);
    row[name] = placeholder === null ? cell : statement.parameters[Number(placeholder[1]) - 1];
  });
  return row;
}

it('[AC-B2-05q-UNIT#4][BR-ID-36][BR-WDR-29] 只用调用方事务：先懒登记规则（冲突不改），再写一条 manual_review 命中，同一时刻', async () => {
  const { db, statements, events } = setup();
  const writer = createWithdrawalReviewHits({ clock: new SteppingClock() });
  await db.transaction().execute((trx) =>
    writer.record(trx, {
      app_id: 'couli',
      user_id: USER,
      withdrawal_id: WITHDRAWAL,
      dimension: 'phone',
      value_hmac: 'digest',
      rule_id: 'BLACKLIST_PHONE',
    }),
  );
  // One connection, one transaction: the caller's.
  expect(events).toEqual(['acquire', 'begin', 'insert', 'insert', 'commit', 'release']);
  const [rule, hit] = statements;
  expect(rule!.sql).toContain('insert into "app"."risk_rules"');
  expect(rule!.sql).toContain('on conflict ("app_id", "rule_id") do nothing');
  expect(rule!.sql).not.toContain('do update');
  expect(insertedRow(rule!)).toMatchObject({
    app_id: 'couli',
    rule_id: 'BLACKLIST_PHONE',
    scene: 'withdraw',
    risk_action: 'block',
    status: 'active',
    version: 1,
    created_at: new Date(START_MS),
    updated_at: new Date(START_MS),
  });
  expect(hit!.sql).toContain('insert into "app"."risk_hits"');
  expect(insertedRow(hit!)).toEqual({
    app_id: 'couli',
    user_id: USER,
    rule_id: 'BLACKLIST_PHONE',
    risk_action: 'manual_review',
    dimension: 'phone',
    value_hmac: 'digest',
    ref_type: 'withdrawal',
    ref_id: WITHDRAWAL,
    request_type: null,
    related_phone_hmac: null,
    related_phone_masked: null,
    amount_fen: null,
    created_at: new Date(START_MS),
  });
});

it('[AC-B2-05q-UNIT#5][BR-ID-36] 写口不读规则状态、不改已有规则：没有 select / update 语句', async () => {
  const { db, statements } = setup();
  const writer = createWithdrawalReviewHits({ clock: new SteppingClock() });
  await db.transaction().execute((trx) =>
    writer.record(trx, {
      app_id: 'couli',
      user_id: USER,
      withdrawal_id: WITHDRAWAL,
      dimension: 'device',
      value_hmac: 'd'.repeat(64),
      rule_id: 'BLACKLIST_DEVICE',
    }),
  );
  expect(statements.map((statement) => statement.sql.split(' ')[0])).toEqual(['insert', 'insert']);
});
