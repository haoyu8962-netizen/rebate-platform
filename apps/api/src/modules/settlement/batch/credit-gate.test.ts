// 单元测试（不连库）：B2-04re 平台结算互斥锁（BR-FUND-16 加锁流程第 0 步）的键拼法、两条语句的文本与参数，
// 以及源码级约束：命名空间只在本文件拼一次；本文件只有事务级共享 / 排他两条咨询锁语句；补充与账单日任务的
// 源码里没有会话级取锁、解锁与试锁。
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
import { creditGateKey, lockCreditGateExclusive, lockCreditGateShared } from './credit-gate.ts';

const SHARED = 'select pg_advisory_xact_lock_shared(hashtext($1), hashtext($2))';
const EXCLUSIVE = 'select pg_advisory_xact_lock(hashtext($1), hashtext($2))';

function recordingDb() {
  const statements: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(compiled);
      return Promise.resolve({ rows: [] } as QueryResult<R>);
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
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
}

it('[AC-B2-04re-UNIT#9] creditGateKey：命名空间 settlement.credit_gate，键 `${appId}:${platform}`', () => {
  expect(creditGateKey('app-1', 'taobao')).toEqual({
    namespace: 'settlement.credit_gate',
    key: 'app-1:taobao',
  });
  expect(creditGateKey('app-2', 'jd').key).toBe('app-2:jd');
});

it('[AC-B2-04re-UNIT#10] 共享 / 排他各一条语句，文本逐字同头注释，参数 (命名空间, 键)', async () => {
  const { db, statements } = recordingDb();
  await db.transaction().execute(async (trx) => {
    await lockCreditGateShared(trx, 'app-1', 'pdd');
    await lockCreditGateExclusive(trx, 'app-1', 'jd');
  });
  expect(statements.map((s) => [s.sql, s.parameters])).toEqual([
    [SHARED, ['settlement.credit_gate', 'app-1:pdd']],
    [EXCLUSIVE, ['settlement.credit_gate', 'app-1:jd']],
  ]);
});

/** 去掉 // 行注释与块注释（源码扫描只看代码）。 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function sourcesUnder(dir: URL): URL[] {
  const out: URL[] = [];
  for (const name of readdirSync(dir)) {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) out.push(...sourcesUnder(new URL(`${name}/`, dir)));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(url);
  }
  return out;
}

it('[AC-B2-04re-UNIT#11] 源码：命名空间文本只出现在 batch/credit-gate.ts；该文件咨询锁语句恰两条（事务级共享、事务级排他），无会话级、解锁、试锁；补充与账单日任务源码不出现会话级取锁 / 解锁 / 试锁', () => {
  const modules = new URL('../../', import.meta.url);
  const gateFile = new URL('./credit-gate.ts', import.meta.url).href;
  const holders = sourcesUnder(modules)
    .filter((u) => readFileSync(u, 'utf8').includes('settlement.credit_gate'))
    .map((u) => u.href);
  expect(holders).toEqual([gateFile]);

  const gate = code(readFileSync(new URL('./credit-gate.ts', import.meta.url), 'utf8'));
  const advisory = gate.match(/pg_\w*advisory\w*\(/g) ?? [];
  expect(advisory).toEqual(['pg_advisory_xact_lock_shared(', 'pg_advisory_xact_lock(']);
  expect(gate).toMatch(
    /sql`select pg_advisory_xact_lock_shared\(hashtext\(\$\{gate\.namespace\}\), hashtext\(\$\{gate\.key\}\)\)`/,
  );
  expect(gate).toMatch(
    /sql`select pg_advisory_xact_lock\(hashtext\(\$\{gate\.namespace\}\), hashtext\(\$\{gate\.key\}\)\)`/,
  );

  const forbidden =
    /pg_advisory_lock\(|pg_advisory_lock_shared\(|pg_advisory_unlock|pg_try_advisory/;
  const bill = new URL('../bill/', import.meta.url);
  const files = [...sourcesUnder(new URL('supplement/', bill)), new URL('job.ts', bill)];
  expect(files.length).toBeGreaterThan(1);
  for (const file of [...files, new URL('./credit-gate.ts', import.meta.url)]) {
    expect(forbidden.test(readFileSync(file, 'utf8')), file.pathname).toBe(false);
  }
});
