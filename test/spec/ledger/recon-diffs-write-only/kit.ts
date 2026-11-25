import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { PostgresQueryCompiler, sql, type Kysely, type QueryId } from 'kysely';
import { expect } from 'vitest';
import {
  registerReconDiffOnce,
  registerReconDiffWriteOnly,
  type ReconDiff,
  type RegisterReconDiffInput,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { fixture, rows } from '../recon-diffs/kit.ts';

export const REPLAY_AT = '2032-06-16T16:00:00.000Z';

export function difference(overrides: Partial<RegisterReconDiffInput> = {}) {
  return fixture({
    type: 'union_mismatch',
    source: 'R1',
    period: '2032-06',
    refType: 'order',
    // 自拟金额，单位分，覆盖负数和零。
    expectedFen: -12n,
    actualFen: 0n,
    diffFen: -12n,
    dedupeKey: `original-${randomUUID()}`,
    resolution: { evidence: 'original' },
    ...overrides,
  });
}

export function replay(input: RegisterReconDiffInput): RegisterReconDiffInput {
  return {
    ...input,
    source: 'R2',
    refType: 'statement',
    // 自拟金额，三个字段均与原单不同。
    expectedFen: 45n,
    actualFen: 20n,
    diffFen: 25n,
    dedupeKey: `replay-${randomUUID()}`,
    resolution: { evidence: 'replay' },
  };
}

export async function seed(db: Kysely<DB>, { input, clock }: ReturnType<typeof difference>) {
  const first = await db
    .transaction()
    .execute((trx) => registerReconDiffOnce(trx, input, { clock }));
  expect(first.inserted).toBe(true);
  return first.row;
}

export async function expectOnlyRow(db: Kysely<DB>, row: ReconDiff) {
  const stored = await rows(db, row.app_id);
  expect(stored).toHaveLength(1);
  expect(stored).toEqual([row]);
}

// B2-18 的判定口径。约束名不算表名，RETURNING 允许返回本次插入的行。
export function reconDiffStatements(statements: readonly string[]) {
  return statements.filter((statement) => /\brecon_diffs\b/i.test(statement));
}

function isPureReconInsert(statement: string) {
  const unquoted = statement.replaceAll('"', '');
  return (
    /^\s*insert\s+into\s+(?:app\s*\.\s*)?recon_diffs\b/i.test(unquoted) &&
    unquoted.match(/\brecon_diffs\b/gi)?.length === 1 &&
    !/\bdo\s+update\b/i.test(unquoted)
  );
}

export function expectOnlyInsert(statements: readonly string[]) {
  const matching = reconDiffStatements(statements);
  expect(matching).toHaveLength(1);
  const statement = matching[0]!;
  expect(isPureReconInsert(statement), statement).toBe(true);
  expect(statement).toMatch(/\bon\s+conflict\b[\s\S]*\bdo\s+nothing\b[\s\S]*\breturning\b/i);
  return statement;
}

export async function expectWriteOnlyConflict(
  db: Kysely<DB>,
  input: RegisterReconDiffInput,
  clock: ReturnType<typeof difference>['clock'],
) {
  const probe = recordSql(db);
  const result = await probe.db
    .transaction()
    .execute((trx) => registerReconDiffWriteOnly(trx, input, { clock }));
  expect(result).toStrictEqual({ inserted: false });
  expectOnlyInsert(probe.statements);
}

/** 记录传入执行器编译的语句。需要造交错时，在 PostgreSQL 返回空 INSERT 结果后执行回调。 */
export function recordSql(db: Kysely<DB>, afterConflict?: () => Promise<void>) {
  const statements: string[] = [];
  const inserts = new Set<QueryId>();
  const compiler = new PostgresQueryCompiler();
  const recorded = db.withPlugin({
    transformQuery({ node, queryId }) {
      const { sql: statement } = compiler.compileQuery(node, queryId);
      statements.push(statement);
      if (afterConflict && isPureReconInsert(statement)) inserts.add(queryId);
      return node;
    },
    async transformResult({ queryId, result }) {
      if (inserts.delete(queryId) && result.rows.length === 0) await afterConflict?.();
      return result;
    },
  });
  return { db: recorded, statements };
}

/** 在独立连接上观察指定 INSERT 的锁等待。查询次数有上限，登记提前结束时立刻停止。 */
export async function waitsForInsert(
  db: Kysely<DB>,
  waiterPid: number,
  holderPid: number,
  isFinished: () => boolean,
) {
  for (let attempt = 0; attempt < 1000 && !isFinished(); attempt += 1) {
    const { rows } = await sql<{ waiting: boolean }>`
      SELECT wait_event_type = 'Lock'
        AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
        AND query ~* '^insert[[:space:]]+into.*recon_diffs' AS waiting
      FROM pg_stat_activity
      WHERE pid = ${waiterPid}::int
    `.execute(db);
    if (rows[0]?.waiting === true) return true;
  }
  return false;
}

export function billDifference() {
  return difference({
    refId: `taobao:synthetic-${randomUUID()}`,
    dedupeKey: null,
    resolution: null,
  });
}
