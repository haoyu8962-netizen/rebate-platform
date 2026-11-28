// B2-03za · BR-CALC-20 (负责人 2026-11-22: 报价技术服务费率 tech_fee_bp 各平台统一为 0, D10-2592 ②,
// D10-2595; FU-QUOTE-TECH-FEE-DEFAULT-ZERO, D10-3358 ①, D10-3676): the quote read side still refuses
// a missing or malformed tech_fee_bp (quote-config.ts techFeeConfig; [AC-B2-03c#19] / [#21] are not
// touched), so a fresh database needs the row from a seed. After every seed file of db/seeds/** has
// run (file-name order, each in its own transaction, as packages/db/scripts/seed.ts runs them; the
// same runSeeds as test/spec/agent/master-switch-seeds/seeds.int.test.ts) app couli has tech_fee_bp
// = {"taobao":0,"jd":0,"pdd":0}, written by 'seed'. db/seeds/0008_quote-tech-fee.sql only inserts a
// missing row (INSERT … ON CONFLICT (app_id, key) DO NOTHING, app couli only): a value an operator
// already saved in the admin keeps its value, version and updated_by. Every test first requires the
// seed file, so all of them are red while it does not exist. Runs as couli_app.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { usePgEach } from '../../agent/stream-mount/kit.ts';
import { fixture, item, NORMAL, PLATFORMS, viewer, type ConfigValue } from '../quoter/fixtures.ts';

const pg = usePgEach(createTestDatabase);

const SEEDS = fileURLToPath(new URL('../../../../db/seeds/', import.meta.url));
const SEED_NAME = '0008_quote-tech-fee.sql';
const SEED_FILE = `${SEEDS}${SEED_NAME}`;

const KEY = 'tech_fee_bp';
const SEEDED_VALUE = { taobao: 0, jd: 0, pdd: 0 };

/** Order-sync fallback keys (BR-CALC-03 旁注): not set to 0 by BR-CALC-20, so 0008 leaves them alone. */
const FALLBACK_KEYS = ['union.taobao.service_fee_bp', 'union.pdd.service_fee_bp'];

/**
 * Shape of the one 0008 statement once every top-level parenthesised group is replaced by `()`:
 * a column list, exactly one VALUES tuple and the conflict target, nothing else.
 */
const STATEMENT_SHAPE =
  /^INSERT\s+INTO\s+app\.config_items\s*\(\)\s*VALUES\s*\(\)\s*ON\s+CONFLICT\s*\(\)\s*DO\s+NOTHING$/i;

interface TechFeeRow {
  readonly value: unknown;
  readonly type: string;
  readonly version: unknown;
  readonly updated_by: string;
}

/** One row of app.config_items (every app, every key). */
interface ConfigRow {
  readonly app_id: string;
  readonly key: string;
  readonly value: unknown;
  readonly version: unknown;
  readonly row_version: unknown;
  readonly updated_by: string;
}

/** Top-level parenthesised groups of a statement and its text with each group replaced by `()`. */
interface Groups {
  readonly groups: string[];
  readonly outside: string;
}

function requireSeedFile(): void {
  expect(existsSync(SEED_FILE), 'db/seeds/0008_quote-tech-fee.sql exists').toBe(true);
}

async function runSeeds(db: Kysely<DB>): Promise<void> {
  const files = readdirSync(SEEDS)
    .filter((name): boolean => name.endsWith('.sql'))
    .sort();
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) {
    const text = readFileSync(`${SEEDS}${name}`, 'utf8');
    await db.transaction().execute(async (trx): Promise<void> => {
      await sql.raw(text).execute(trx);
    });
  }
}

/** The config_items row of app couli for tech_fee_bp, or undefined when it is missing. */
async function techFeeRow(db: Kysely<DB>): Promise<TechFeeRow | undefined> {
  const result = await sql<TechFeeRow>`
    SELECT value, jsonb_typeof(value) AS type, version, updated_by FROM app.config_items
    WHERE app_id = 'couli' AND key = ${KEY}`.execute(db);
  expect(result.rows.length).toBeLessThanOrEqual(1);
  return result.rows[0];
}

/** Runs one seed file in its own transaction, as packages/db/scripts/seed.ts does. */
async function runSeedFile(db: Kysely<DB>, name: string): Promise<void> {
  const text = readFileSync(`${SEEDS}${name}`, 'utf8');
  await db.transaction().execute(async (trx): Promise<void> => {
    await sql.raw(text).execute(trx);
  });
}

/** Every row of app.config_items, ordered by (app_id, key). */
async function configSnapshot(db: Kysely<DB>): Promise<ConfigRow[]> {
  const result = await sql<ConfigRow>`
    SELECT app_id, key, value, version, row_version, updated_by FROM app.config_items
    ORDER BY app_id, key`.execute(db);
  return result.rows;
}

/** Index just past the quoted literal or identifier starting at `start` (doubled quotes stay inside). */
function quotedEnd(text: string, start: number): number {
  const quote = text.charAt(start);
  let i = start + 1;
  while (i < text.length) {
    if (text.charAt(i) !== quote) i += 1;
    else if (text.charAt(i + 1) === quote) i += 2;
    else return i + 1;
  }
  return text.length;
}

/**
 * The SQL text with `--` line comments and (nested) block comments replaced by one space each;
 * text inside '…' literals and "…" identifiers is kept as is.
 */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === "'" || ch === '"') {
      const end = quotedEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (text.startsWith('--', i)) {
      const newline = text.indexOf('\n', i);
      i = newline === -1 ? text.length : newline;
      out += ' ';
    } else if (text.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text.startsWith('/*', i)) {
          depth += 1;
          i += 2;
        } else if (text.startsWith('*/', i)) {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      expect(depth, 'every block comment of 0008 is closed').toBe(0);
      out += ' ';
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Splits at `separator` where it is outside quotes and parentheses. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === "'" || ch === '"') {
      i = quotedEnd(text, i);
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  parts.push(text.slice(start));
  return parts;
}

/** The top-level parenthesised groups of a statement (contents only) and the text around them. */
function topLevelGroups(text: string): Groups {
  const groups: string[] = [];
  let outside = '';
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === "'" || ch === '"') {
      const end = quotedEnd(text, i);
      if (depth === 0) outside += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '(') {
      if (depth === 0) {
        outside += '()';
        start = i + 1;
      }
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) groups.push(text.slice(start, i));
    } else if (depth === 0) outside += ch;
    i += 1;
  }
  expect(depth, 'parentheses of 0008 are balanced').toBe(0);
  return { groups, outside };
}

/** The statements of the seed file (`--` and block comments removed), trimmed, empty ones dropped. */
function seedStatements(): string[] {
  return splitTopLevel(stripComments(readFileSync(SEED_FILE, 'utf8')), ';')
    .map((statement): string => statement.trim())
    .filter((statement): boolean => statement.length > 0);
}

/** A column name of the INSERT column list, unquoted and lower-cased. */
function columnName(column: string): string {
  return column
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .toLowerCase();
}

/** Whether a VALUES field is the text literal `'<text>'` (optionally cast `::text`). */
function isTextLiteral(field: string | undefined, text: string): boolean {
  const trimmed = (field ?? '').trim();
  return trimmed === `'${text}'` || new RegExp(`^'${text}'\\s*::\\s*text$`, 'i').test(trimmed);
}

it('[AC-B2-03za#1][BR-CALC-20] 新建库跑完全部种子后 couli 的 tech_fee_bp 恰为 jsonb 对象 {"taobao":0,"jd":0,"pdd":0}（三键都在、都为 0、无别的键），updated_by = seed', async (): Promise<void> => {
  requireSeedFile();
  await runSeeds(pg.db);
  const row = await techFeeRow(pg.db);
  expect(row, 'couli tech_fee_bp row').toBeDefined();
  expect(row?.type).toBe('object');
  expect(row?.value).toStrictEqual(SEEDED_VALUE);
  expect(row?.updated_by).toBe('seed');
}, 120_000);

it('[AC-B2-03za#2][BR-CALC-20] 后台先写 couli 的 tech_fee_bp = {"taobao":120,"jd":0,"pdd":0} 再跑两遍全部种子 → 整行（值、version、updated_by）不变', async (): Promise<void> => {
  requireSeedFile();
  await pg.db
    .insertInto('config_items')
    .values({
      app_id: 'couli',
      key: KEY,
      value: sql`'{"taobao":120,"jd":0,"pdd":0}'::jsonb`,
      updated_by: 'b2-03za-rule-test',
    })
    .execute();
  const before = await techFeeRow(pg.db);
  expect(before).toMatchObject({
    value: { taobao: 120, jd: 0, pdd: 0 },
    type: 'object',
    updated_by: 'b2-03za-rule-test',
  });
  await runSeeds(pg.db);
  await runSeeds(pg.db);
  const after = await techFeeRow(pg.db);
  expect(after?.value).toStrictEqual({ taobao: 120, jd: 0, pdd: 0 });
  expect(after?.updated_by).toBe('b2-03za-rule-test');
  expect(after).toEqual(before);
}, 120_000);

it('[AC-B2-03za#3][BR-CALC-20] 只靠种子：跑完全部种子后从库里读出 couli 的 tech_fee_bp 放进报价器，淘宝、京东、拼多多 NORMAL 报价都不拒绝，且与费率 0 的报价相同', async (): Promise<void> => {
  requireSeedFile();
  await runSeeds(pg.db);
  const row = await techFeeRow(pg.db);
  for (const platform of PLATFORMS) {
    // Reference: the fixture's own tech_fee_bp ({taobao: 0, jd: 0, pdd: 0}), built before the
    // seeded case so a rejection below is only the seeded value's.
    const reference = fixture();
    const expected = await reference.quoter.quote(item({ platform }), viewer(), NORMAL);
    const seeded = fixture();
    if (row === undefined) seeded.values.delete(KEY);
    else seeded.values.set(KEY, row.value as ConfigValue);
    const quoted = seeded.quoter.quote(item({ platform }), viewer(), NORMAL);
    await expect(quoted, platform).resolves.toEqual(expected);
  }
}, 120_000);

it('[AC-B2-03za#4][BR-CALC-20] 静态检查 0008：去掉注释后只有一条 INSERT INTO app.config_items … ON CONFLICT (app_id, key) DO NOTHING，无 UPDATE / DELETE / TRUNCATE，只写 app_id = couli 的 tech_fee_bp', (): void => {
  requireSeedFile();
  const statements = seedStatements();
  expect(statements).toHaveLength(1);
  const [statement = ''] = statements;
  expect(statement).toMatch(/^INSERT\s+INTO\s+app\.config_items\s*\(/i);
  expect(statement).toMatch(/ON\s+CONFLICT\s*\(\s*app_id\s*,\s*key\s*\)\s*DO\s+NOTHING$/i);
  expect(statement).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE)\b/i);
  // Exactly one VALUES tuple: the statement is a column list, one top-level VALUES group and the
  // conflict target, so a second tuple (however its first field is written) does not fit.
  const { groups, outside } = topLevelGroups(statement);
  expect(outside.trim()).toMatch(STATEMENT_SHAPE);
  expect(groups).toHaveLength(3);
  const [columnList = '', tuple = ''] = groups;
  const columns = splitTopLevel(columnList, ',').map(columnName);
  const fields = splitTopLevel(tuple, ',');
  expect(fields).toHaveLength(columns.length);
  expect(columns.slice(0, 2)).toEqual(['app_id', 'key']);
  expect(isTextLiteral(fields[0], 'couli'), `app_id field ${fields[0] ?? ''}`).toBe(true);
  expect(isTextLiteral(fields[1], KEY), `key field ${fields[1] ?? ''}`).toBe(true);
});

it('[AC-B2-03za#5][BR-CALC-20][BR-CALC-03] 新库先跑完 0008 以外的全部种子、再单独执行 0008：config_items 恰多出 couli 的 tech_fee_bp 一行（{"taobao":0,"jd":0,"pdd":0}，updated_by = seed），原有行原样不变，union.taobao / union.pdd.service_fee_bp 兜底键不受影响', async (): Promise<void> => {
  requireSeedFile();
  const others = readdirSync(SEEDS)
    .filter((name): boolean => name.endsWith('.sql') && name !== SEED_NAME)
    .sort();
  expect(others.length).toBeGreaterThan(0);
  for (const name of others) await runSeedFile(pg.db, name);
  const before = await configSnapshot(pg.db);
  const isTechFee = (row: ConfigRow): boolean => row.app_id === 'couli' && row.key === KEY;
  expect(before.filter(isTechFee), 'no couli tech_fee_bp before 0008').toEqual([]);

  await runSeedFile(pg.db, SEED_NAME);
  const after = await configSnapshot(pg.db);

  expect(after).toHaveLength(before.length + 1);
  const added = after.filter(isTechFee);
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ app_id: 'couli', key: KEY, updated_by: 'seed' });
  expect(added[0]?.value).toStrictEqual(SEEDED_VALUE);
  // Every row present before 0008 is still there with the same value, version and updated_by,
  // and nothing else was added.
  const kept = after.filter((row): boolean => !isTechFee(row));
  expect(kept).toEqual(before);
  for (const key of FALLBACK_KEYS) {
    const hasKey = (row: ConfigRow): boolean => row.key === key;
    expect(after.filter(hasKey), key).toEqual(before.filter(hasKey));
  }
}, 120_000);
