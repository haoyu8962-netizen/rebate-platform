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
const SEED_FILE = `${SEEDS}0008_quote-tech-fee.sql`;

const KEY = 'tech_fee_bp';
const SEEDED_VALUE = { taobao: 0, jd: 0, pdd: 0 };

/** The leading ('<app_id>', '<key>' of each VALUES tuple of the seed file. */
const TUPLE = /\(\s*'([^']*)'\s*,\s*'([^']*)'/g;

interface TechFeeRow {
  readonly value: unknown;
  readonly type: string;
  readonly version: unknown;
  readonly updated_by: string;
}

/** An (app_id, key) pair of a VALUES tuple of the seed file. */
interface SeedKey {
  readonly app_id: string | undefined;
  readonly key: string | undefined;
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

/** The statements of the seed file (`--` comments removed), trimmed, empty ones dropped. */
function seedStatements(): string[] {
  const text = readFileSync(SEED_FILE, 'utf8')
    .split('\n')
    .map((line): string => line.replace(/--.*$/, ''))
    .join('\n');
  return text
    .split(';')
    .map((statement): string => statement.trim())
    .filter((statement): boolean => statement.length > 0);
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
  const rows = [...statement.matchAll(TUPLE)].map((match): SeedKey => ({
    app_id: match[1],
    key: match[2],
  }));
  expect(rows).toEqual([{ app_id: 'couli', key: KEY }]);
});
