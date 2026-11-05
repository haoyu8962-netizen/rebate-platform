// B2-12a：只验证 admin_adjustments、bad_debt_writeoffs 两表的迁移存储（约束、外键、授权、快照），
// 不执行调账、核销、记账或状态迁移业务（BR-FUND-24、BR-FUND-12；形状见 04 §3.2，D10-534、D10-590）。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';

export type Row = Record<string, unknown>;
export const TABLES = ['admin_adjustments', 'bad_debt_writeoffs'] as const;
export type Table = (typeof TABLES)[number];
export const AT = '2032-07-24T09:00:00+08:00';
export const LATER = '2032-07-24T10:00:00+08:00';

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

export function repoFile(path: string): URL {
  return new URL(`../../../../${path}`, import.meta.url);
}

export function enumValues(name: string): string[] {
  const source = readFileSync(repoFile('contracts/enums/fund.yaml'), 'utf8');
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

// 只把约束类与权限类错误转成码；其余错误（缺列、语法）照常抛出，不算先红。
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

export async function foreignKeys(db: Kysely<DB>, table: Table) {
  return (
    await sql<{
      name: string;
      target: string;
      on_delete: string;
      on_update: string;
      keys: string[];
      refs: string[];
    }>`
    SELECT c.conname AS name, n.nspname || '.' || r.relname AS target,
      c.confdeltype AS on_delete, c.confupdtype AS on_update,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.pos) AS keys,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.pos) AS refs
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE c.contype = 'f' AND c.conrelid = to_regclass(${`app.${table}`})
  `.execute(db)
  ).rows;
}

// 一个 app 下的父行：会员、其余额账户、后台账号与一张凭证生成器。
export async function parents(db: Kysely<DB>, appId = `adj-${randomUUID()}`) {
  const userId = randomUUID();
  const adminId = randomUUID();
  const accountId = randomUUID();
  await insert(db, 'users', {
    id: userId,
    app_id: appId,
    nickname: '调账夹具',
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
    login_name: `adj-${adminId}`,
    password_hash: 'test-only',
    is_super: false,
    status: 'active',
  });
  await insert(db, 'ledger_accounts', {
    id: accountId,
    app_id: appId,
    owner_type: 'user',
    owner_id: userId,
    subject: 'USER_BALANCE',
  });
  return { appId, userId, adminId, accountId };
}
export type Parents = Awaited<ReturnType<typeof parents>>;

// 另一位会员与其余额账户（同一 app），供「同一账户 / 同一用户」唯一性对照。
export async function otherMember(db: Kysely<DB>, p: Parents) {
  const userId = randomUUID();
  const accountId = randomUUID();
  await insert(db, 'users', {
    id: userId,
    app_id: p.appId,
    nickname: '调账夹具二',
    avatar: '',
    invite_code: randomUUID(),
    attr_code: randomUUID(),
    level: 'L1',
    status: 'normal',
    register_method: 'phone',
  });
  await insert(db, 'ledger_accounts', {
    id: accountId,
    app_id: p.appId,
    owner_type: 'user',
    owner_id: userId,
    subject: 'USER_BALANCE',
  });
  return { userId, accountId };
}

export async function voucher(db: Kysely<DB>, p: Parents, uniqKey?: string): Promise<string> {
  const id = randomUUID();
  await insert(db, 'ledger_vouchers', {
    id,
    app_id: p.appId,
    biz_type: 'ADMIN_ADJUST',
    biz_id: id,
    uniq_key: uniqKey ?? `ADJ:${id}`,
    accounting_date: '2032-07-24',
    operator: `admin:${p.adminId}`,
  });
  return id;
}

export function refs(count: number): string {
  return JSON.stringify(
    Array.from({ length: count }, () => ({ ref_type: 'recon_diff', ref_id: randomUUID() })),
  );
}

// 人工单：一步提交即 APPROVED（BR-FUND-24 后台入口）。
export function manual(p: Parents, voucherId: string | null, values: Row = {}): Row {
  return {
    adjust_id: randomUUID(),
    app_id: p.appId,
    user_id: p.userId,
    direction: 'increase',
    amount_fen: 500n,
    reason_code: 'RECON_FIX',
    refs: refs(1),
    contra_subject: 'COMMISSION_REVENUE',
    contra_platform: null,
    note: '对账差错更正',
    status: 'APPROVED',
    reverses_adjust_id: null,
    created_by: p.adminId,
    reviewed_by: p.adminId,
    reviewed_at: AT,
    reject_note: null,
    voucher_id: voucherId,
    ...values,
  };
}

// 系统预填的 ACCOUNT_CLOSED 调减单：金额批准时才定，发起人为空（BR-FUND-24 ⑧）。
export function prefill(p: Parents, values: Row = {}): Row {
  return {
    adjust_id: randomUUID(),
    app_id: p.appId,
    user_id: p.userId,
    direction: 'decrease',
    amount_fen: null,
    reason_code: 'ACCOUNT_CLOSED',
    refs: JSON.stringify([{ ref_type: 'account_deletion', ref_id: randomUUID() }]),
    contra_subject: 'COMMISSION_REVENUE',
    contra_platform: null,
    note: null,
    status: 'PENDING',
    reverses_adjust_id: null,
    created_by: null,
    reviewed_by: null,
    reviewed_at: null,
    reject_note: null,
    voucher_id: null,
    ...values,
  };
}

// 红冲单：以原单为关联、refs 为空，方向相反、金额等于原单（BR-FUND-24 细则「红冲只按原单整笔」）。
export function reversal(
  p: Parents,
  original: Row,
  voucherId: string | null,
  values: Row = {},
): Row {
  return manual(p, voucherId, {
    direction: original['direction'] === 'increase' ? 'decrease' : 'increase',
    amount_fen: original['amount_fen'],
    reason_code: original['reason_code'],
    refs: '[]',
    reverses_adjust_id: original['adjust_id'],
    ...values,
  });
}

// 核销候选单：每日任务生成时发起人为空（BR-FUND-12；契约 AdminBadDebtWriteoff）。
export function candidate(p: Parents, values: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id: p.appId,
    account_id: p.accountId,
    negative_since: '2032-04-20',
    candidate_fen: 800n,
    status: 'PENDING',
    initiator_id: null,
    approver_id: null,
    approved_at: null,
    voucher_id: null,
    ...values,
  };
}
