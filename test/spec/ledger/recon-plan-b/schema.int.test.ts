// B2-17 storage (claude-independent): BR-FUND-24 ⑨ 「同一差错单对同一受益用户至多关联一张已执行、未被红冲的
// 调账单」 as a database constraint, with the shapes of the task's §9.2 (编排 D10-3185, D10-3191) and §9.3
// ⑤⑮: table app.adjustment_recon_diffs (columns, primary key, four foreign keys that never cascade,
// partial unique index adjustment_recon_diffs_active_key, two named CHECKs, grants: couli_app SELECT /
// INSERT and UPDATE of reversed_by_adjust_id only, couli_readonly SELECT, no DELETE), the nullable
// app.recon_diffs.involved_user_ids that couli_app may not UPDATE, and the unique index
// recon_diffs_app_id_id_key (an index, not a table constraint). The migration is located by its
// file-name suffix (no number reserved). Runs as couli_app; role privileges are read with
// has_table_privilege / has_column_privilege.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { columns, indexes } from '../../db/settlement/ledger-owned/kit.ts';
import {
  fixture,
  member,
  newAppId,
  seedForm,
  seedReconDiff,
  suite,
  type AdjustFixture,
} from '../admin-adjustments/kit.ts';
import { ACTIVE_KEY, LINKS, LIST_COLUMN, outcome, schemaReady, type PgOutcome } from './kit.ts';

const s = suite();

const TABLE = `app.${LINKS}`;
const LINK_COLUMNS = [
  'adjust_id',
  'app_id',
  'created_at',
  'recon_diff_id',
  'reversed_by_adjust_id',
  'user_id',
];
const OK: PgOutcome = { code: 'ok', constraint: null };

interface LinkValues {
  readonly app_id?: string;
  readonly adjust_id: string;
  readonly recon_diff_id: string;
  readonly user_id: string;
  readonly reversed_by_adjust_id?: string | null;
}

/** INSERT of one link row as couli_app at the fixture's clock; 'ok' or the error. */
function insertLink(f: AdjustFixture, values: LinkValues): Promise<PgOutcome> {
  const appId = values.app_id ?? f.appId;
  const reversedBy = values.reversed_by_adjust_id ?? null;
  const at = f.clock.now();
  const statement = sql`INSERT INTO app.adjustment_recon_diffs
    (app_id, adjust_id, recon_diff_id, user_id, reversed_by_adjust_id, created_at)
    VALUES (${appId}, ${values.adjust_id}, ${values.recon_diff_id}, ${values.user_id},
      ${reversedBy}, ${at})`;
  return outcome(statement.execute(f.db));
}

function refused(code: string, constraint: string): PgOutcome {
  return { code, constraint };
}

interface ForeignKey {
  readonly name: string;
  readonly columns: string[];
  readonly target: string;
  readonly target_columns: string[];
  readonly on_delete: string;
  readonly on_update: string;
}

/** A foreign key as `columns → schema.table(columns)`. */
function describeKey(key: ForeignKey): string {
  return `${key.columns.join(',')} → ${key.target}(${key.target_columns.join(',')})`;
}

it('[AC-B2-17#23] 迁移按后缀 _adjustment-recon-diffs.sql 定位；app.adjustment_recon_diffs 恰有六列（app_id text、adjust_id / recon_diff_id / user_id uuid 非空，reversed_by_adjust_id uuid 可空，created_at timestamptz 非空），都没有默认值；主键 (adjust_id, recon_diff_id)；部分唯一索引 adjustment_recon_diffs_active_key (app_id, recon_diff_id, user_id) WHERE reversed_by_adjust_id IS NULL；两条具名 CHECK；四条外键都不级联', async () => {
  const f = fixture(s);
  await schemaReady(f.db);
  const directory = new URL('../../../../db/migrations/', import.meta.url);
  const names = readdirSync(directory).filter((name) =>
    /^\d{4}_adjustment-recon-diffs\.sql$/u.test(name),
  );
  expect(names, '按后缀定位迁移，不预留编号').toHaveLength(1);
  const text = readFileSync(new URL(names[0]!, directory), 'utf8');
  for (const word of [LINKS, ACTIVE_KEY, LIST_COLUMN, 'recon_diffs_app_id_id_key']) {
    expect(text, word).toContain(word);
  }

  const stored = await columns(f.db, LINKS);
  const shape: Record<string, unknown[]> = {};
  for (const c of stored) shape[c.name] = [c.type, c.nullable, c.expression];
  expect(Object.keys(shape).sort()).toEqual(LINK_COLUMNS);
  expect(shape).toEqual({
    adjust_id: ['uuid', false, null],
    app_id: ['text', false, null],
    created_at: ['timestamptz', false, null],
    recon_diff_id: ['uuid', false, null],
    reversed_by_adjust_id: ['uuid', true, null],
    user_id: ['uuid', false, null],
  });

  const found = await indexes(f.db, LINKS);
  const primary = found.find((index) => index.name === `${LINKS}_pkey`);
  expect(primary, `${LINKS}_pkey`).toMatchObject({
    keys: ['adjust_id', 'recon_diff_id'],
    unique: true,
    predicate: null,
    constraint_backed: true,
  });
  const active = found.find((index) => index.name === ACTIVE_KEY);
  expect(active, ACTIVE_KEY).toMatchObject({
    keys: ['app_id', 'recon_diff_id', 'user_id'],
    unique: true,
    valid: true,
    constraint_backed: false,
  });
  const predicate = active?.predicate ?? '';
  expect(predicate, '谓词恰为 reversed_by_adjust_id IS NULL').toMatch(/^\(?\w+ IS NULL\)?$/u);
  expect(predicate).toContain('reversed_by_adjust_id IS NULL');

  const constraints = await sql<{ name: string; kind: string }>`
    SELECT conname::text AS name, contype::text AS kind FROM pg_constraint
    WHERE conrelid = to_regclass(${TABLE}) AND contype IN ('p', 'u', 'c', 'f')
    ORDER BY conname`.execute(f.db);
  expect(constraints.rows).toEqual([
    { name: `${LINKS}_adjust_fkey`, kind: 'f' },
    { name: `${LINKS}_app_id_check`, kind: 'c' },
    { name: `${LINKS}_diff_fkey`, kind: 'f' },
    { name: `${LINKS}_pkey`, kind: 'p' },
    { name: `${LINKS}_reversed_by_check`, kind: 'c' },
    { name: `${LINKS}_reversed_by_fkey`, kind: 'f' },
    { name: `${LINKS}_user_fkey`, kind: 'f' },
  ]);

  const keys = await sql<ForeignKey>`
    SELECT c.conname::text AS name,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.pos)
        AS columns,
      n.nspname || '.' || r.relname AS target,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.pos)
        AS target_columns,
      c.confdeltype::text AS on_delete, c.confupdtype::text AS on_update
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE c.conrelid = to_regclass(${TABLE}) AND c.contype = 'f'`.execute(f.db);
  const described: Record<string, string> = {};
  for (const key of keys.rows) described[key.name.replace(`${LINKS}_`, '')] = describeKey(key);
  expect(described).toEqual({
    adjust_fkey: 'app_id,adjust_id → app.admin_adjustments(app_id,adjust_id)',
    diff_fkey: 'app_id,recon_diff_id → app.recon_diffs(app_id,id)',
    reversed_by_fkey: 'app_id,reversed_by_adjust_id → app.admin_adjustments(app_id,adjust_id)',
    user_fkey: 'app_id,user_id → app.users(app_id,id)',
  });
  for (const key of keys.rows) {
    // a = NO ACTION, r = RESTRICT; c / n / d would cascade, set null or set default.
    expect(['a', 'r'], `${key.name} ON DELETE 不级联`).toContain(key.on_delete);
    expect(['a', 'r'], `${key.name} ON UPDATE 不级联`).toContain(key.on_update);
  }
});

it('[AC-B2-17#24] app.recon_diffs.involved_user_ids 为可空 uuid[]、没有默认值；recon_diffs_app_id_id_key 是 (app_id, id) 上的唯一索引（不是表约束、没有谓词）；授权：couli_app 对关联表只有 SELECT、INSERT 与 reversed_by_adjust_id 的 UPDATE，couli_readonly 只有 SELECT，谁都没有 DELETE；couli_app 对 involved_user_ids 有 INSERT、没有 UPDATE', async () => {
  const f = fixture(s);
  await schemaReady(f.db);
  const stored = await columns(f.db, 'recon_diffs');
  const list = stored.find((c) => c.name === LIST_COLUMN);
  expect(list, LIST_COLUMN).toMatchObject({ type: '_uuid', nullable: true, expression: null });
  const named = await indexes(f.db, 'recon_diffs');
  const index = named.find((found) => found.name === 'recon_diffs_app_id_id_key');
  expect(index, 'recon_diffs_app_id_id_key').toMatchObject({
    keys: ['app_id', 'id'],
    unique: true,
    valid: true,
    predicate: null,
    constraint_backed: false,
  });

  const table = await sql<{ role: string; privilege: string; granted: boolean }>`
    SELECT r.role, p.privilege,
      has_table_privilege(r.role, ${TABLE}::text, p.privilege) AS granted
    FROM (VALUES ('couli_app'), ('couli_readonly')) AS r(role),
      (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(privilege)
    ORDER BY r.role, p.privilege`.execute(f.db);
  const granted = table.rows.filter((row) => row.granted);
  const grants = granted.map((row) => `${row.role} ${row.privilege}`).sort();
  expect(grants).toEqual(['couli_app INSERT', 'couli_app SELECT', 'couli_readonly SELECT']);

  const perColumn = await sql<{ name: string; granted: boolean }>`
    SELECT c.name, has_column_privilege('couli_app', ${TABLE}::text, c.name, 'UPDATE') AS granted
    FROM unnest(${LINK_COLUMNS}::text[]) AS c(name) ORDER BY c.name`.execute(f.db);
  const updatable = perColumn.rows.filter((row) => row.granted).map((row) => row.name);
  expect(updatable).toEqual(['reversed_by_adjust_id']);
  const viewer = await sql<{ granted: boolean }>`
    SELECT has_column_privilege('couli_readonly', ${TABLE}::text, 'reversed_by_adjust_id', 'UPDATE')
      AS granted`.execute(f.db);
  expect(viewer.rows).toEqual([{ granted: false }]);

  const listGrants = await sql<{ may_insert: boolean; may_update: boolean }>`
    SELECT has_column_privilege('couli_app', 'app.recon_diffs', ${LIST_COLUMN}::text, 'INSERT')
        AS may_insert,
      has_column_privilege('couli_app', 'app.recon_diffs', ${LIST_COLUMN}::text, 'UPDATE')
        AS may_update`.execute(f.db);
  expect(listGrants.rows).toEqual([{ may_insert: true, may_update: false }]);
});

it('[AC-B2-17#25] 库约束（直接写入，couli_app）：同一（app_id、recon_diff_id、user_id）第二行未红冲的关联 → 23505 adjustment_recon_diffs_active_key；前一行写上 reversed_by_adjust_id 后可以再插；别的会员不受影响；同一（调账单，差错单）两行 → 主键冲突；app_id 为空串、reversed_by_adjust_id = adjust_id → 23514 具名 CHECK；四条外键各自拒绝（23503）；couli_app 改 involved_user_ids、改关联行别的列、删关联行都 42501', async () => {
  const f = fixture(s);
  await schemaReady(f.db);
  const u1 = await member(f, { available: 1000n });
  const u2 = await member(f, { available: 1000n });
  const diff = await seedReconDiff(f);
  const a1 = await seedForm(f, { userId: u1 });
  const a2 = await seedForm(f, { userId: u1 });
  const a3 = await seedForm(f, { userId: u2 });
  const marker = await seedForm(f, { userId: u1 });
  const link = (adjustId: string, userId: string): LinkValues => ({
    adjust_id: adjustId,
    recon_diff_id: diff.id,
    user_id: userId,
  });

  expect(await insertLink(f, link(a1.adjust_id, u1)), '第一行').toEqual(OK);
  const second = await insertLink(f, link(a2.adjust_id, u1));
  expect(second, '同一会员第二行未红冲').toEqual(refused('23505', ACTIVE_KEY));
  expect(await insertLink(f, link(a3.adjust_id, u2)), '别的会员').toEqual(OK);
  const mark = sql`UPDATE app.adjustment_recon_diffs
    SET reversed_by_adjust_id = ${marker.adjust_id}
    WHERE app_id = ${f.appId} AND adjust_id = ${a1.adjust_id}`;
  const marked = await outcome(mark.execute(f.db));
  expect(marked, 'couli_app 可写 reversed_by_adjust_id').toEqual(OK);
  expect(await insertLink(f, link(a2.adjust_id, u1)), '前一行已红冲').toEqual(OK);
  const twice = await insertLink(f, link(a2.adjust_id, u1));
  expect(twice, '同一（调账单，差错单）').toEqual(refused('23505', `${LINKS}_pkey`));

  const fresh = await seedReconDiff(f);
  const another = (patch: Partial<LinkValues>): LinkValues => ({
    adjust_id: marker.adjust_id,
    recon_diff_id: fresh.id,
    user_id: u1,
    ...patch,
  });
  const blank = await insertLink(f, another({ app_id: '' }));
  expect(blank, 'app_id 空串').toEqual(refused('23514', `${LINKS}_app_id_check`));
  const self = await insertLink(f, another({ reversed_by_adjust_id: marker.adjust_id }));
  expect(self, '自指').toEqual(refused('23514', `${LINKS}_reversed_by_check`));
  const elsewhere = await seedReconDiff(f, { app_id: newAppId() });
  const strangers: readonly (readonly [Partial<LinkValues>, string])[] = [
    [{ adjust_id: randomUUID() }, `${LINKS}_adjust_fkey`],
    [{ recon_diff_id: randomUUID() }, `${LINKS}_diff_fkey`],
    [{ recon_diff_id: elsewhere.id }, `${LINKS}_diff_fkey`],
    [{ user_id: randomUUID() }, `${LINKS}_user_fkey`],
    [{ reversed_by_adjust_id: randomUUID() }, `${LINKS}_reversed_by_fkey`],
  ];
  for (const [patch, constraint] of strangers) {
    const result = await insertLink(f, another(patch));
    expect(result, constraint).toEqual(refused('23503', constraint));
  }

  const denied = [
    sql`UPDATE app.recon_diffs SET involved_user_ids = NULL
      WHERE app_id = ${f.appId} AND id = ${diff.id}`,
    sql`UPDATE app.adjustment_recon_diffs SET user_id = ${u2}
      WHERE app_id = ${f.appId} AND adjust_id = ${a1.adjust_id}`,
    sql`UPDATE app.adjustment_recon_diffs SET created_at = ${f.clock.now()}
      WHERE app_id = ${f.appId} AND adjust_id = ${a1.adjust_id}`,
    sql`DELETE FROM app.adjustment_recon_diffs WHERE app_id = ${f.appId}`,
  ];
  for (const statement of denied) {
    expect((await outcome(statement.execute(f.db))).code).toBe('42501');
  }
});
