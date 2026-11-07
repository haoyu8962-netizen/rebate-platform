// Unit tests without a database: Kysely runs on a scripted driver that records each compiled
// statement and answers from a queue of canned row sets. The SQL itself runs against PostgreSQL in
// the rule tests (test/spec/growth/invite-reward-jd-platform).
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
import { createInviteRewardOrderFacts } from './invite-reward.ts';

function setup(answers: Record<string, unknown>[][]) {
  const statements: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(compiled);
      const rows = answers.shift() ?? [];
      return Promise.resolve({ rows } as unknown as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
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
  return { db, statements };
}

const ORDER = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';

function row(platform: string): Record<string, unknown> {
  return {
    app_id: 'app-a',
    order_id: ORDER,
    user_id: USER,
    buy_type: 'self',
    base_fen: 100n,
    pay_amount_fen: 1000n,
    attr_at: new Date('2026-11-01T00:00:00Z'),
    credited_at: new Date('2026-11-02T00:00:00Z'),
    rebate_status: 'CREDITED',
    refunded_quantity: 1,
    refunded_quantity_at_credit: 0,
    rights_pending: false,
    platform,
    has_rights: false,
  };
}

it('[AC-B1-08zj-UNIT#1] read 选出 o.platform，并把订单平台原样交给 growth', async () => {
  const { db, statements } = setup([[row('jd')]]);
  const fact = await db
    .transaction()
    .execute((trx) =>
      createInviteRewardOrderFacts().read(trx, { app_id: 'app-a', order_id: ORDER }),
    );
  expect(statements).toHaveLength(1);
  expect(statements[0]?.sql ?? '').toContain('"o"."platform"');
  expect(fact?.platform).toBe('jd');
});

it('[AC-B1-08zj-UNIT#2] listSelfOrdersInWindow 也选出 o.platform', async () => {
  const { db, statements } = setup([[row('taobao'), { ...row('pdd'), order_id: USER }]]);
  const list = await db.transaction().execute((trx) =>
    createInviteRewardOrderFacts().listSelfOrdersInWindow(trx, {
      app_id: 'app-a',
      user_id: USER,
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-11-08T00:00:00Z'),
    }),
  );
  expect(statements).toHaveLength(1);
  expect(statements[0]?.sql ?? '').toContain('"o"."platform"');
  expect(list.map((fact) => fact.platform)).toEqual(['taobao', 'pdd']);
});
