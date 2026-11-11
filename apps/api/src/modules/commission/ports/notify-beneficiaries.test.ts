// Unit tests without a database: Kysely runs on a scripted driver that records each compiled
// statement and answers with canned rows. The SQL itself runs against PostgreSQL in the rule tests
// (test/spec/notification/trade-read-ports).
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
import { readNotifyBeneficiaries } from './notify-beneficiaries.ts';

function setup(rows: readonly Record<string, unknown>[]) {
  const statements: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(compiled);
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

const INPUT = { app_id: 'app-a', order_id: '00000000-0000-4000-8000-000000000001' };

it('[AC-B1-12j-UNIT#1] 一条 SELECT：按订单行当前版本联结金额行，两表都带 app_id 与 order_id，按 role、user_id 排序', async () => {
  const { db, statements } = setup([]);
  expect(await readNotifyBeneficiaries(db, INPUT)).toEqual([]);
  expect(statements).toHaveLength(1);
  const sql = statements[0]?.sql ?? '';
  expect(sql.startsWith('select ')).toBe(true);
  expect(sql).toContain('from "app"."commission_split_amounts" as "a"');
  expect(sql).toContain('inner join "app"."orders" as "o"');
  expect(sql).toContain('"o"."commission_version" = "a"."commission_version"');
  expect(sql).toContain('"a"."app_id" = $1');
  expect(sql).toContain('"a"."order_id" = $2');
  expect(sql).toContain('"o"."app_id" = $3');
  expect(sql).toContain('"o"."order_id" = $4');
  expect(sql).toContain('order by "a"."role", "a"."user_id"');
  expect(sql).not.toMatch(/for (update|share)/i);
  expect(statements[0]?.parameters).toEqual([
    INPUT.app_id,
    INPUT.order_id,
    INPUT.app_id,
    INPUT.order_id,
  ]);
});

it('[AC-B1-12j-UNIT#2] 行原样返回：零份额保留、bigint 不转换、只投影 user_id、role、amount_fen', async () => {
  const rows = [
    { user_id: 'u1', role: 'direct', amount_fen: 0n },
    { user_id: 'u2', role: 'self', amount_fen: 9007199254740993n },
  ];
  const { db } = setup(rows.map((r) => ({ ...r, base_fen: 1n })));
  expect(await readNotifyBeneficiaries(db, INPUT)).toEqual(rows);
});

it('[AC-B1-18kn-UNIT#1] exclude_terminal 为真：终态过滤加在 orders 内连接上（not in VOID、CLAWED_BACK），其余语句不变', async () => {
  const { db, statements } = setup([]);
  expect(await readNotifyBeneficiaries(db, { ...INPUT, exclude_terminal: true })).toEqual([]);
  expect(statements).toHaveLength(1);
  const sql = statements[0]?.sql ?? '';
  expect(sql).toContain(
    'inner join "app"."orders" as "o" on "o"."app_id" = "a"."app_id" and "o"."order_id" = "a"."order_id" and "o"."commission_version" = "a"."commission_version" and "o"."rebate_status" not in ($1, $2)',
  );
  expect(sql).toContain('"a"."app_id" = $3');
  expect(sql).toContain('"a"."order_id" = $4');
  expect(sql).toContain('"o"."app_id" = $5');
  expect(sql).toContain('"o"."order_id" = $6');
  expect(sql).toContain('order by "a"."role", "a"."user_id"');
  expect(sql).not.toMatch(/for (update|share)/i);
  expect(statements[0]?.parameters).toEqual([
    'VOID',
    'CLAWED_BACK',
    INPUT.app_id,
    INPUT.order_id,
    INPUT.app_id,
    INPUT.order_id,
  ]);
});

it('[AC-B1-18kn-UNIT#2] 默认不变：不传与 exclude_terminal 为假编出的语句和参数与旧口径完全相同，不看 rebate_status', async () => {
  const plain = setup([]);
  const off = setup([]);
  await readNotifyBeneficiaries(plain.db, INPUT);
  await readNotifyBeneficiaries(off.db, { ...INPUT, exclude_terminal: false });
  expect(plain.statements[0]?.sql).not.toContain('rebate_status');
  expect(off.statements[0]?.sql).toBe(plain.statements[0]?.sql);
  expect(off.statements[0]?.parameters).toEqual(plain.statements[0]?.parameters);
});
