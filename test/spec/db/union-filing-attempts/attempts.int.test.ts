import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  columns,
  connect,
  foreignKeys,
  newAccount,
  newAuth,
  requireTable,
  sqlState,
} from '../linking-bindings/kit.ts';

const TABLE = 'union_filing_attempts';
const OUTCOMES = ['saved', 'rejected', 'duplicate'] as const;
const START = new Date('2026-11-24T10:00:00Z');
const FINISH = new Date('2026-11-24T10:00:01Z');

let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  connect(app);
});

afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
});

async function filing() {
  await requireTable(TABLE);
  const session = await newAuth({
    created_at: new Date(START.getTime() - 1000),
    expire_at: new Date(START.getTime() + 60_000),
    used_at: START,
  });
  return {
    id: randomUUID(),
    appId: session['app_id'],
    userId: session['user_id'],
    accountId: await newAccount(),
    state: session['state'],
  };
}

type Filing = Awaited<ReturnType<typeof filing>>;

function insert(row: Filing, outcome: string | null, finishedAt: Date | null) {
  return sql`
    INSERT INTO app.union_filing_attempts
      (id, app_id, user_id, platform, union_account_id, state, started_at, outcome, finished_at)
    VALUES (${row.id}, ${row.appId}, ${row.userId}, 'taobao', ${row.accountId}, ${row.state},
      ${START}, ${outcome}, ${finishedAt})
  `.execute(app);
}

function finish(id: string, outcome: string | null, finishedAt: Date | null) {
  return sql`
    UPDATE app.union_filing_attempts SET outcome = ${outcome}, finished_at = ${finishedAt}
    WHERE id = ${id}
  `.execute(app);
}

it('[AC-B1-04zzzzn#1] 备案尝试保存归属、开始时间和结局，state 引用授权会话', async () => {
  await requireTable(TABLE);
  expect(await columns(TABLE)).toEqual(
    expect.arrayContaining(
      [
        ['id', 'uuid', false],
        ['app_id', 'text', false],
        ['user_id', 'uuid', false],
        ['platform', 'text', false],
        ['union_account_id', 'uuid', false],
        ['state', 'text', false],
        ['started_at', 'timestamptz', false],
        ['outcome', 'text', true],
        ['finished_at', 'timestamptz', true],
      ].map(([name, type, nullable]) => expect.objectContaining({ name, type, nullable })),
    ),
  );
  const privateColumn = /token|credential|secret|nick|avatar|account_?name|authorization_code/i;
  expect((await columns(TABLE)).filter(({ name }) => privateColumn.test(name))).toEqual([]);
  expect(await foreignKeys(TABLE)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        target: 'union_auth_sessions',
        source: expect.arrayContaining(['state']),
        referenced: expect.arrayContaining(['state']),
        validated: true,
      }),
    ]),
  );
  const row = await filing();
  expect(await sqlState(insert({ ...row, state: randomUUID() }, null, null))).toBe('23503');
});

it('[AC-B1-04zzzzn#2] 结局只允许 saved、rejected、duplicate，且与完成时间同时有值或为空', async () => {
  for (const outcome of OUTCOMES) {
    const row = await filing();
    await insert(row, null, null);
    expect(await sqlState(finish(row.id, outcome, null)), outcome).toBe('23514');
    expect(await sqlState(finish(row.id, null, FINISH)), outcome).toBe('23514');
    expect(await sqlState(finish(row.id, 'unknown', FINISH)), outcome).toBe('23514');
    expect(await sqlState(finish(row.id, outcome, FINISH)), outcome).toBe('no error');
    const result = await sql`
      SELECT outcome, finished_at FROM app.union_filing_attempts WHERE id = ${row.id}
    `.execute(app);
    expect(result.rows).toEqual([{ outcome, finished_at: FINISH }]);
  }
});

it('[AC-B1-04zzzzn#3] 结局写入后，不能改结果、改完成时间或清空两列', async () => {
  const row = await filing();
  await insert(row, null, null);
  await finish(row.id, 'duplicate', FINISH);

  const later = new Date(FINISH.getTime() + 1000);
  for (const [outcome, finishedAt] of [
    ['saved', FINISH],
    ['duplicate', later],
    [null, null],
  ] as const) {
    // These pairs satisfy the lifecycle CHECK. The couli_app role can update both columns.
    expect(await sqlState(finish(row.id, outcome, finishedAt))).not.toBe('no error');
  }
  const kept = await sql`
    SELECT outcome, finished_at FROM app.union_filing_attempts WHERE id = ${row.id}
  `.execute(app);
  expect(kept.rows).toEqual([{ outcome: 'duplicate', finished_at: FINISH }]);
});

it('[AC-B1-04zzzzn#4] couli_app 可读、可插入且只能更新结局和完成时间', async () => {
  await requireTable(TABLE);
  const tableGrants = await sql<{ privilege: string }>`
    SELECT p.privilege
    FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES',
                      'TRIGGER', 'MAINTAIN']) AS p(privilege)
    WHERE has_table_privilege(current_user, 'app.union_filing_attempts', p.privilege)
    ORDER BY p.privilege
  `.execute(app);
  expect(tableGrants.rows).toEqual([{ privilege: 'INSERT' }, { privilege: 'SELECT' }]);
  const updateGrants = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = ${TABLE}
      AND has_column_privilege(current_user, 'app.union_filing_attempts', column_name::text, 'UPDATE')
    ORDER BY column_name
  `.execute(app);
  expect(updateGrants.rows).toEqual([{ column_name: 'finished_at' }, { column_name: 'outcome' }]);

  const row = await filing();
  await insert(row, null, null);
  const immutable = (await columns(TABLE)).filter(
    ({ name }) => !['outcome', 'finished_at'].includes(name),
  );
  for (const { name } of immutable) {
    const column = sql.ref(name);
    const update = sql`
      UPDATE app.union_filing_attempts SET ${column} = ${column} WHERE id = ${row.id}
    `.execute(app);
    expect(await sqlState(update), name).toBe('42501');
  }
});
