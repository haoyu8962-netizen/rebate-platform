// B2-18a 规则测试夹具（claude-independent，SPEC_REF 6c631c2）：BR-FUND-04 ④ 2026-11-21 改写——
// settle_period = 账单月、未 hold、未维权而截至生成开始仍无联盟结算数据的子订单只计入账单的「应结未结」数，
// 不生成差错单；app.settle_bills 新增 unsettled_count（应结未结数）与 amount_mismatch_count（B2-18 用，
// 本单只建列）。新列经本文件的读取函数读：列不存在时返回 COLUMN_MISSING，让先红红在断言上，
// 而不是红在「列不存在」的 SQL 错误上。
import { readdirSync, readFileSync } from 'node:fs';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, PostgresQueryCompiler, type Kysely, type QueryId } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';

/** 新列尚不存在时读取函数返回的标记（不是任何合法取值）。 */
export const COLUMN_MISSING = 'column-missing';
export type NewCount = number | null | typeof COLUMN_MISSING;

export const NEW_COLUMNS = ['unsettled_count', 'amount_mismatch_count'] as const;
export type NewColumn = (typeof NEW_COLUMNS)[number];

export const CHECKS: Record<NewColumn, string> = {
  unsettled_count: 'settle_bills_unsettled_count_check',
  amount_mismatch_count: 'settle_bills_amount_mismatch_count_check',
};

export interface ColumnShape {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly defaultValue: string | null;
}

/** information_schema 里 app.settle_bills 的这些列（不存在的列不出现）。 */
export async function settleBillColumns(
  db: Kysely<DB>,
  names: readonly string[],
): Promise<ColumnShape[]> {
  const { rows } = await sql<{
    name: string;
    data_type: string;
    nullable: boolean;
    default_value: string | null;
  }>`
    SELECT column_name AS name, data_type, is_nullable = 'YES' AS nullable,
      column_default AS default_value
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'settle_bills'
      AND column_name IN (${sql.join(names)})
    ORDER BY column_name
  `.execute(db);
  return rows.map((r) => ({
    name: r.name,
    dataType: r.data_type,
    nullable: r.nullable,
    defaultValue: r.default_value,
  }));
}

/** 两个新列各自在不在（information_schema）。 */
export async function newColumnsPresent(db: Kysely<DB>): Promise<Record<NewColumn, boolean>> {
  const present = new Set((await settleBillColumns(db, NEW_COLUMNS)).map((c) => c.name));
  return {
    unsettled_count: present.has('unsettled_count'),
    amount_mismatch_count: present.has('amount_mismatch_count'),
  };
}

export interface BillCounts {
  readonly error_count: number | null;
  readonly held_count: number | null;
  readonly unsettled_count: NewCount;
  readonly amount_mismatch_count: NewCount;
}

/**
 * 一张账单的四个计数；账单行不存在时为 null。整行经 to_jsonb 读出，不在 SQL 里点名新列，
 * 列不存在时对应字段是 COLUMN_MISSING。
 */
export async function billCounts(
  db: Kysely<DB>,
  appId: string,
  billId = '2032-06',
): Promise<BillCounts | null> {
  const present = await newColumnsPresent(db);
  const { rows } = await sql<{ row: Record<string, unknown> }>`
    SELECT to_jsonb(b) AS row FROM app.settle_bills AS b
    WHERE b.app_id = ${appId} AND b.bill_id = ${billId}
  `.execute(db);
  const row = rows[0]?.row;
  if (row === undefined) return null;
  const count = (value: unknown): number | null => (typeof value === 'number' ? value : null);
  const newCount = (column: NewColumn): NewCount =>
    present[column] && column in row ? count(row[column]) : COLUMN_MISSING;
  return {
    error_count: count(row['error_count']),
    held_count: count(row['held_count']),
    unsettled_count: newCount('unsettled_count'),
    amount_mismatch_count: newCount('amount_mismatch_count'),
  };
}

/** 迁移前形状的账单行：只写已有列，新列不出现在 INSERT 里。 */
export async function legacyBill(
  db: Kysely<DB>,
  appId: string,
  values: {
    readonly billId?: string;
    readonly platformOrderCounts?: Record<string, number>;
    readonly platformCommissionTotals?: Record<string, string>;
    readonly errorCount?: number;
    readonly heldCount?: number;
  } = {},
): Promise<void> {
  const at = new Date('2032-07-24T00:05:00+08:00');
  await sql`
    INSERT INTO app.settle_bills
      (app_id, bill_id, generation_started_at, generated_at, platform_order_counts,
       platform_settle_commission_totals, beneficiary_total_fen, platform_retained_fen,
       error_count, held_count)
    VALUES (${appId}, ${values.billId ?? '2032-06'}, ${at}, ${at},
      ${JSON.stringify(values.platformOrderCounts ?? {})}::jsonb,
      ${JSON.stringify(values.platformCommissionTotals ?? {})}::jsonb,
      ${0n}, ${0n}, ${values.errorCount ?? 0}, ${values.heldCount ?? 0})
  `.execute(db);
}

// ---------------------------------------------------------------------------------------------
// 第 3 次写测追加（评审 r1 的 5 条 S1）：独立连接与库层屏障、计数写入后注入故障、语句记录、迁移源读取。

type TestDatabaseLike = { urlFor(role: 'couli_app'): string; drop(): Promise<void> };

/** 一个测试库上的四个连接池：db 供夹具与断言，left / right 各一条连接跑并发任务，control 观察锁等待。 */
export interface Pools {
  readonly db: Kysely<DB>;
  readonly left: Kysely<DB>;
  readonly right: Kysely<DB>;
  readonly control: Kysely<DB>;
}

export function poolsFixture(create: () => Promise<TestDatabaseLike>, timeout: number): Pools {
  let database: TestDatabaseLike | undefined;
  let pools: Pools | undefined;
  beforeAll(async () => {
    database = await create();
    const connectionString = database.urlFor('couli_app');
    pools = {
      db: createDb({ connectionString, max: 6 }),
      left: createDb({ connectionString, max: 1 }),
      right: createDb({ connectionString, max: 1 }),
      control: createDb({ connectionString, max: 1 }),
    };
  }, timeout);
  afterAll(async () => {
    try {
      const open: Kysely<DB>[] = [];
      if (pools !== undefined) open.push(pools.db, pools.left, pools.right, pools.control);
      await Promise.all(open.map((db) => destroyDb(db)));
    } finally {
      await database?.drop();
    }
  }, timeout);
  const get = (): Pools => {
    if (pools === undefined) throw new Error('bill-unsettled-count pools are not open');
    return pools;
  };
  return {
    get db() {
      return get().db;
    },
    get left() {
      return get().left;
    },
    get right() {
      return get().right;
    },
    get control() {
      return get().control;
    },
  };
}

/** 单连接池当前那条连接的后端 pid。 */
export async function backendPid(db: Kysely<DB>): Promise<number> {
  const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db);
  expect(rows).toHaveLength(1);
  return rows[0]!.pid;
}

/** 在服务端观察到 waiter 正等着 holder 的锁（pg_blocking_pids），不靠 sleep 推断。 */
export async function waitBlocked(db: Kysely<DB>, waiter: number, holder: number): Promise<void> {
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    const { rows } = await sql<{ blocked: boolean }>`
      SELECT ${holder}::int = ANY(pg_blocking_pids(${waiter}::int)) AS blocked
    `.execute(db);
    if (rows[0]?.blocked === true) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect.fail(`backend ${String(waiter)} did not wait for ${String(holder)}`);
}

function compiled(node: Parameters<PostgresQueryCompiler['compileQuery']>[0], id: QueryId) {
  return new PostgresQueryCompiler().compileQuery(node, id).sql;
}

const BILL_TABLE = /(?:"?app"?\.)?"?settle_bills"?/i;
/** 写 settle_bills 的语句（查询构造器与原生 SQL 都算，CTE 里的也算）。 */
const BILL_WRITE =
  /\b(?:update\s+(?:only\s+)?|insert\s+into\s+|merge\s+into\s+|delete\s+from\s+(?:only\s+)?)(?:"?app"?\.)?"?settle_bills"?/i;

/** 取得 settle_bills 行锁的语句：SELECT … FOR [NO KEY] UPDATE、UPDATE、INSERT … ON CONFLICT DO UPDATE。 */
function locksBillRow(text: string): boolean {
  if (!BILL_TABLE.test(text)) return false;
  return (
    /\bfor\s+(?:no\s+key\s+)?update\b/i.test(text) ||
    /^\s*update\b/i.test(text) ||
    /\bon\s+conflict\b[\s\S]*\bdo\s+update\b/i.test(text)
  );
}

/**
 * 库层屏障：经返回的 db 执行的第一条取得 settle_bills 行锁的语句在 PostgreSQL 执行完之后停住（锁已拿到、
 * 事务未提交），直到 release()。reached 在停住时兑现。
 */
export function pauseAtBillLock(db: Kysely<DB>) {
  let onReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    onReached = resolve;
  });
  let onRelease!: () => void;
  const released = new Promise<void>((resolve) => {
    onRelease = resolve;
  });
  const pending = new Set<QueryId>();
  let armed = true;
  const paused = db.withPlugin({
    transformQuery(args) {
      if (armed && locksBillRow(compiled(args.node, args.queryId))) {
        armed = false;
        pending.add(args.queryId);
      }
      return args.node;
    },
    async transformResult(args) {
      if (pending.delete(args.queryId)) {
        onReached();
        await released;
      }
      return args.result;
    },
  });
  return { db: paused, reached, release: () => onRelease() };
}

/**
 * 写入账单应结未结数的那条 SQL（写 settle_bills 且点名 unsettled_count）在 PostgreSQL 执行之后抛错；
 * fired 记注入次数。查询构造器与原生 SQL 同经此执行器。
 */
export function failAfterCountWrite(db: Kysely<DB>) {
  const pending = new Set<QueryId>();
  const record = { fired: 0 };
  const faulty = db.withPlugin({
    transformQuery(args) {
      const text = compiled(args.node, args.queryId);
      if (BILL_WRITE.test(text) && /\bunsettled_count\b/i.test(text)) pending.add(args.queryId);
      return args.node;
    },
    async transformResult(args) {
      if (pending.delete(args.queryId)) {
        record.fired += 1;
        throw new Error('injected count write failure');
      }
      return args.result;
    },
  });
  return {
    db: faulty,
    get fired() {
      return record.fired;
    },
  };
}

/** 记下经返回的 db 执行的每条语句（查询构造器与原生 SQL）。 */
export function tracing(db: Kysely<DB>) {
  const queries: string[] = [];
  const traced = db.withPlugin({
    transformQuery(args) {
      queries.push(compiled(args.node, args.queryId));
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  return { db: traced, queries };
}

/** 这些语句里写 settle_bills 的。 */
export function billWrites(queries: readonly string[]): string[] {
  return queries.filter((q) => BILL_WRITE.test(q));
}

/** 这些语句里提到 settle_bills 的（读或写）。 */
export function billTouches(queries: readonly string[]): string[] {
  return queries.filter((q) => BILL_TABLE.test(q));
}

const MIGRATIONS = new URL('../../../../db/migrations/', import.meta.url);

/**
 * 本单迁移：文件名 NNNN_settle-bills-….sql 且内容提到 unsettled_count 的那一个（不写死序号）。
 * 在 it 里调用：文件不存在或不唯一时红在断言上。
 */
export function billCountsMigration(): { name: string; source: string } {
  const names = readdirSync(MIGRATIONS)
    .filter((name) => /^\d{4}_settle-bills-[a-z0-9-]+\.sql$/.test(name))
    .filter((name) => readFileSync(new URL(name, MIGRATIONS), 'utf8').includes('unsettled_count'));
  const message = '本单迁移 NNNN_settle-bills-….sql（含 unsettled_count）不存在或不唯一';
  expect(names, message).toHaveLength(1);
  const name = names[0]!;
  return { name, source: readFileSync(new URL(name, MIGRATIONS), 'utf8') };
}

/**
 * 把迁移 SQL 按语句切开：去掉注释，单引号字面量换成空串 ''（字面量里的字不算 SQL），双引号去掉，
 * 美元引号正文（DO 块、函数体）保留原文、整体留在所在语句里；空白压成一个空格。
 */
export function migrationStatements(source: string): string[] {
  const tokens = source.matchAll(
    /--[^\n]*|\/\*[\s\S]*?\*\/|(?:[EeUu]&?)?'(?:''|\\.|[^'\\])*'|"(?:""|[^"])*"|(\$[A-Za-z_0-9]*\$)[\s\S]*?\1|[^;'"$/-]+|./gs,
  );
  const result: string[] = [];
  let current = '';
  const push = () => {
    const text = current.replace(/\s+/g, ' ').trim();
    if (text !== '') result.push(text);
    current = '';
  };
  for (const [token] of tokens) {
    if (token.startsWith('--') || token.startsWith('/*')) current += ' ';
    else if (token === ';') push();
    else if (/^(?:[EeUu]&?)?'/.test(token)) current += "''";
    else if (token.startsWith('"')) current += token.slice(1, -1).replaceAll('""', '"');
    else current += token;
  }
  push();
  return result;
}

/** 按顶层逗号切开（括号内的逗号不切）。 */
export function topLevelClauses(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

/** 对 app.settle_bills 的 ALTER TABLE 语句的子句（去掉 ALTER TABLE … app.settle_bills 前缀）。 */
export function settleBillAlterClauses(statements: readonly string[]): string[] {
  const head = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?app\s*\.\s*settle_bills\s+/i;
  return statements
    .filter((s) => head.test(s))
    .flatMap((s) => topLevelClauses(s.replace(head, '')));
}

/** 迁移全文（含 DO 块等美元引号正文）里对 app.settle_bills 的数据修改语句（回填）。 */
export function settleBillDataWrites(statements: readonly string[]): string[] {
  const write =
    /\b(?:UPDATE\s+(?:ONLY\s+)?|INSERT\s+INTO\s+|MERGE\s+INTO\s+|DELETE\s+FROM\s+(?:ONLY\s+)?|TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?|COPY\s+)(?:app\s*\.\s*)?settle_bills\b/i;
  return statements.filter((s) => write.test(s));
}
