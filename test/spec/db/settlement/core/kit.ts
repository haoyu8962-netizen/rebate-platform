// B2-04a：只验证迁移存储，不执行结算、拆分、审批或状态迁移业务。
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';

export type Row = Record<string, unknown>;
export const TABLES = [
  'settle_jobs',
  'settle_bills',
  'settle_batches',
  'settle_batch_items',
  'beneficiary_credits',
  'settle_adjust_batches',
  'settle_adjustments',
  'recon_union',
] as const;
export type Table = (typeof TABLES)[number];
export const AT = '2032-07-24T09:00:00+08:00';
export const LATER = '2032-07-24T10:00:00+08:00';
// S7 仅确定三态含义；英文编码代理自定，与既有运行任务的命名一致。
export const JOB_STATES = ['running', 'done', 'failed'] as const;

interface Database {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export function harness(createTestDatabase: () => Promise<Database>) {
  let database: Database | undefined;
  let app: Kysely<DB>;
  beforeAll(async () => {
    database = await createTestDatabase();
    app = createDb({ connectionString: database.urlFor('couli_app'), max: 3 });
  }, 60_000);
  afterAll(async () => {
    if (app) await destroyDb(app);
    if (database) await database.drop();
  }, 60_000);
  return {
    get app() {
      return app;
    },
  };
}

// 每条 it 的第一步：缺迁移由断言先红，不让缺表 SQL 错误冒充先红。
export async function ready(db: Kysely<DB>): Promise<void> {
  for (const table of TABLES) {
    const result = await sql<{ present: boolean }>`
      SELECT to_regclass(${`app.${table}`}) IS NOT NULL AS present
    `.execute(db);
    expect(result.rows, `missing app.${table}`).toEqual([{ present: true }]);
  }
}

// The settlement-core migration, followed by the statements of every later migration that ALTER
// app.settle_batches (B2-04zy: credited_count with its named CHECK and its grant); comments
// stripped. Only those statements are taken from a later migration.
export function migrationSource(): string {
  const directory = new URL('../../../../../db/migrations/', import.meta.url);
  const strip = (name: string) =>
    readFileSync(new URL(name, directory), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\n]*/g, '');
  const all = readdirSync(directory)
    .filter((name) => /^\d{4}_[a-z0-9-]+\.sql$/.test(name))
    .sort();
  const names = all.filter((name) => /^\d{4}_settlement-core\.sql$/.test(name));
  expect(names, '迁移按后缀定位，不固定序号').toHaveLength(1);
  const core = names[0]!;
  const alters = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?app\.settle_batches\b/i;
  const touches = /\bapp\.settle_batches\b/i;
  const later = all
    .filter((name) => name > core)
    .map((name) => strip(name).replace(/"/g, ''))
    .filter((source) => alters.test(source))
    .flatMap((source) => source.split(';').filter((statement) => touches.test(statement)))
    .map((statement) => `${statement.trim()};`);
  return [strip(core), ...later].join('\n');
}

export function enumValues(name: string): string[] {
  const source = readFileSync(
    new URL('../../../../../contracts/enums/fund.yaml', import.meta.url),
    'utf8',
  );
  const block =
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  \\w+:|$(?![\\s\\S]))`, 'm').exec(source)?.[1] ?? '';
  const values = [...block.matchAll(/^      ([a-zA-Z_]+):/gm)].map((m) => m[1]!);
  expect(values.length, `fund.yaml/${name}`).toBeGreaterThan(0);
  return values;
}

export async function insert(db: Kysely<DB>, table: string, row: Row): Promise<void> {
  await sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(Object.keys(row).map((key) => sql.ref(key)))})
    VALUES (${sql.join(Object.values(row))})`.execute(db);
}

export async function update(db: Kysely<DB>, table: Table, key: Row, change: Row): Promise<void> {
  await sql`UPDATE ${sql.table(`app.${table}`)} SET
    ${sql.join(Object.entries(change).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
    WHERE ${sql.join(
      Object.entries(key).map(([name, value]) => sql`${sql.ref(name)} = ${value}`),
      sql` AND `,
    )}
  `.execute(db);
}

export async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string' || !['23502', '23503', '23505', '23514', '42501'].includes(code))
      throw error;
    return code;
  }
}

export async function columns(db: Kysely<DB>, table: Table) {
  return (
    await sql<{ name: string; type: string; nullable: boolean; expression: string | null }>`
    SELECT column_name AS name, udt_name AS type, is_nullable = 'YES' AS nullable, column_default AS expression
    FROM information_schema.columns WHERE table_schema = 'app' AND table_name = ${table}
  `.execute(db)
  ).rows;
}

export async function indexes(db: Kysely<DB>, table: Table) {
  return (
    await sql<{
      name: string;
      keys: string[];
      unique: boolean;
      valid: boolean;
      predicate: string | null;
      constraint_backed: boolean;
    }>`
    SELECT c.relname AS name, i.indisunique AS unique, i.indisvalid AND i.indisready AS valid,
      pg_get_expr(i.indpred, i.indrelid) AS predicate,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
        WHERE k.pos <= i.indnkeyatts ORDER BY k.pos) AS keys,
      EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.contype IN ('p', 'u')) AS constraint_backed
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = to_regclass(${`app.${table}`})
  `.execute(db)
  ).rows;
}

export async function parents(db: Kysely<DB>, appId = `core-${randomUUID()}`) {
  const orderId = randomUUID();
  const userId = randomUUID();
  const adminId = randomUUID();
  await insert(db, 'order_keys', {
    app_id: appId,
    order_id: orderId,
    platform: 'taobao',
    sub_order_id: randomUUID(),
    attr_at: AT,
  });
  await insert(db, 'users', {
    id: userId,
    app_id: appId,
    nickname: '结算夹具',
    avatar: '',
    invite_code: randomUUID(),
    attr_code: randomUUID(),
    level: 'L1',
    status: 'normal',
    register_method: 'phone',
  });
  await insert(db, 'admin_users', {
    id: adminId,
    app_id: appId,
    login_name: `core-${adminId}`,
    password_hash: 'test-only',
    is_super: false,
    status: 'active',
  });
  await insert(db, 'order_settlements', {
    app_id: appId,
    order_id: orderId,
    seq: 1,
    source: 'API',
    settle_commission_fen: 100n,
    settled_at: AT,
    content_hash: randomUUID(),
  });
  return { appId, orderId, userId, adminId };
}
export type Parents = Awaited<ReturnType<typeof parents>>;

export function job(values: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id: `job-${randomUUID()}`,
    job: 'bill',
    platform: 'taobao',
    run_at: AT,
    status: 'running',
    processed_count: 0,
    skipped_count: 0,
    started_at: AT,
    finished_at: null,
    ...values,
  };
}
// 出账开始时登记月份与开始时刻；出账完成时回填六个汇总列与 generated_at。
export function bill(p: Parents, values: Row = {}): Row {
  return {
    app_id: p.appId,
    bill_id: '2032-06',
    generation_started_at: AT,
    generated_at: null,
    ...values,
  };
}
export function batch(p: Parents, values: Row = {}): Row {
  return {
    batch_id: randomUUID(),
    app_id: p.appId,
    bill_id: '2032-06',
    platform: 'taobao',
    kind: 'main',
    status: 'DRAFT',
    settle_mode: 'IMMEDIATE',
    scheduled_at: null,
    confirmed_by: null,
    confirmed_at: null,
    cancelled_reason: null,
    settle_run_id: null,
    order_count: 1,
    started_at: null,
    finished_at: null,
    paused_by_switch_at: null,
    ...values,
  };
}
export function credit(p: Parents, values: Row = {}): Row {
  return {
    beneficiary_credit_id: randomUUID(),
    app_id: p.appId,
    order_id: p.orderId,
    user_id: p.userId,
    role: 'self',
    kind: 'first_credit',
    opened_by: 'R5',
    opened_ref: randomUUID(),
    split_ref: p.orderId,
    origin_ledger_type: null,
    origin_sub_type: null,
    status: 'open',
    closed_by: null,
    closed_ref: null,
    voucher_id: null,
    opened_at: AT,
    closed_at: null,
    ...values,
  };
}
export function item(p: Parents, parent: Row, values: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id: p.appId,
    batch_id: parent['batch_id'],
    item_type: 'order',
    order_id: p.orderId,
    user_id: null,
    role: null,
    beneficiary_credit_id: null,
    settle_seq: 1,
    b_settle_fen: 100n,
    amount_fen: null,
    result: null,
    skip_reason: null,
    ...values,
  };
}
export function beneficiaryItem(p: Parents, parent: Row, obligation: Row, values: Row = {}): Row {
  return item(p, parent, {
    item_type: 'beneficiary',
    user_id: obligation['user_id'],
    role: obligation['role'],
    beneficiary_credit_id: obligation['beneficiary_credit_id'],
    ...values,
  });
}
export function adjustBatch(p: Parents, values: Row = {}): Row {
  return {
    batch_id: randomUUID(),
    app_id: p.appId,
    confirmed_by: null,
    confirmed_at: null,
    ...values,
  };
}
export function adjustment(p: Parents, parent: Row, values: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id: p.appId,
    batch_id: parent['batch_id'],
    order_id: p.orderId,
    user_id: p.userId,
    role: 'self',
    commission_version: 1,
    settle_seq: 1,
    diff_fen: 100n,
    reason: '联盟结算额增加',
    status: 'pending',
    approver: null,
    decided_at: null,
    ...values,
  };
}
export function recon(p: Parents, values: Row = {}): Row {
  // order_key 保留联盟业务键（含我方无单的报表项），不冒充 orders 分区表外键。
  return {
    id: randomUUID(),
    app_id: p.appId,
    platform: 'taobao',
    period: '2032-06',
    order_key: `taobao:${randomUUID()}`,
    our_value: 100n,
    union_value: 99n,
    diff_fen: 1n,
    result: 'mismatch',
    ...values,
  };
}

export async function scenario(db: Kysely<DB>) {
  const p = await parents(db);
  const b = batch(p);
  const c = credit(p);
  const ab = adjustBatch(p);
  await insert(db, 'settle_bills', bill(p));
  await insert(db, 'settle_batches', b);
  await insert(db, 'beneficiary_credits', c);
  await insert(db, 'settle_adjust_batches', ab);
  return { p, b, c, ab };
}
