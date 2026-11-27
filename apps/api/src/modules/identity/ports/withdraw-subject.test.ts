// B2-05v (D10-3619): identity's two withdrawal read ports on a scripted query handle (no database:
// the driver records each compiled statement and answers with the given rows). The behaviour on a
// real database — the current row's id after a rebind back to the same account — is pinned by the
// rule test [AC-B2-05v#11] through the real AppModule.
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
import {
  createWithdrawPayeeSnapshotReader,
  createWithdrawSubjectReader,
} from './withdraw-subject.ts';

const SUBJECT = { appId: 'b2_05v_identity_unit', userId: '019a0000-0000-7000-8000-000000000001' };
const ROW_ID = '019a0000-0000-7000-8000-0000000000aa';
const HMAC = 'b'.repeat(64);

/** A Kysely whose driver records each compiled statement and answers with the given rows. */
function stubDb(rows: readonly Record<string, unknown>[]): {
  db: Kysely<DB>;
  queries: CompiledQuery[];
} {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(query);
      return { rows: rows as R[] };
    },
    async *streamQuery(): AsyncIterableIterator<never> {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    async init(): Promise<void> {},
    async acquireConnection(): Promise<DatabaseConnection> {
      return connection;
    },
    async beginTransaction(): Promise<void> {},
    async commitTransaction(): Promise<void> {},
    async rollbackTransaction(): Promise<void> {},
    async releaseConnection(): Promise<void> {},
    async destroy(): Promise<void> {},
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: (): PostgresAdapter => new PostgresAdapter(),
      createDriver: (): Driver => driver,
      createIntrospector: (kysely: Kysely<unknown>): PostgresIntrospector =>
        new PostgresIntrospector(kysely),
      createQueryCompiler: (): PostgresQueryCompiler => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
}

const CURRENT_ROW = {
  id: ROW_ID,
  payout_method: 'alipay',
  payee_name: '合成姓名',
  alipay_hmac: HMAC,
  alipay_logon_id_cipher: Buffer.from('synthetic-cipher'),
  bank_card_hmac: null,
  bank_card_no_cipher: null,
  bank_name: null,
};

it('[AC-B2-05v#11-UNIT#6] read 的返回值仍恰好是三个字段（假查询句柄，行里多给 id 也不带出）', async (): Promise<void> => {
  const { db, queries } = stubDb([CURRENT_ROW]);
  const answer = await createWithdrawSubjectReader().read(db, SUBJECT);
  expect(answer).toStrictEqual({
    payout_method: 'alipay',
    payee_name: '合成姓名',
    payee_hmac: HMAC,
  });
  expect(queries).toHaveLength(1);
  await db.destroy();
});

it('[AC-B2-05v#11-UNIT#7] bindingId：一条 SELECT 只取当前行的 id，没有当前行返回 null', async (): Promise<void> => {
  const bound = stubDb([{ id: ROW_ID }]);
  expect(await createWithdrawSubjectReader().bindingId(bound.db, SUBJECT)).toBe(ROW_ID);
  expect(bound.queries).toHaveLength(1);
  const [query] = bound.queries;
  expect(query!.sql).toBe(
    'select "id" from "app"."payout_accounts" where "app_id" = $1 and "user_id" = $2 and "is_current" = $3',
  );
  expect(query!.parameters).toEqual([SUBJECT.appId, SUBJECT.userId, true]);
  const unbound = stubDb([]);
  expect(await createWithdrawSubjectReader().bindingId(unbound.db, SUBJECT)).toBeNull();
  await bound.db.destroy();
  await unbound.db.destroy();
});

it('[AC-B2-05v#11-UNIT#8] 收款人快照带上它读到的那一行的 binding_id', async (): Promise<void> => {
  const { db, queries } = stubDb([CURRENT_ROW]);
  const reader = createWithdrawPayeeSnapshotReader({
    decrypt: (): string => 'synthetic@example.test',
  });
  const snapshot = await reader.read(db, SUBJECT);
  expect(snapshot).toMatchObject({
    payout_method: 'alipay',
    payee_hmac: HMAC,
    binding_id: ROW_ID,
    account: 'synthetic@example.test',
  });
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).toContain('"is_current" = $3');
  await db.destroy();
});
