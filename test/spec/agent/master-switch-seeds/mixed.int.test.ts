// B1-22za round 2 (Codex spec-test r1 S1) · BR-AI-12 细则「/v1/config.agent.enabled 的派生」(负责人
// 2026-11-12 选 A, 06 Q-A14, D10-1333). Complements seeds.int.test.ts (#1–#3, unchanged):
// - mixed case: one of agent.enabled / agent.page_guide.enabled already has an operator's false row,
//   the other has no row → after all seeds the existing row is untouched (value, version, row_version,
//   updated_by, updated_at) and only the missing key is inserted as JSON true by 'seed'. A seed that
//   skips both keys as soon as either exists (INSERT … SELECT … WHERE NOT EXISTS over the pair) is red.
// - tightened static check of db/seeds/0007_agent-master-switches.sql: only
//   INSERT INTO app.config_items (app_id, key, value, updated_by) VALUES (…), (…)
//   ON CONFLICT (app_id, key) DO NOTHING, with one literal row per key ('couli', <key>, 'true'::jsonb,
//   'seed'); no INSERT … SELECT, WHERE, EXISTS, UPDATE, DELETE or TRUNCATE.
// Every test first requires the seed file, so all of them are red (assertion failure) while it does
// not exist. Runs seeds the way packages/db/scripts/seed.ts does (file-name order, one transaction per
// file), as couli_app.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { usePgEach } from '../stream-mount/kit.ts';

const pg = usePgEach(createTestDatabase);

const SEEDS = fileURLToPath(new URL('../../../../db/seeds/', import.meta.url));
const SEED_FILE = `${SEEDS}0007_agent-master-switches.sql`;

const AGENT_ENABLED = 'agent.enabled';
const PAGE_GUIDE_ENABLED = 'agent.page_guide.enabled';
const SEEDED_KEYS: readonly string[] = [AGENT_ENABLED, PAGE_GUIDE_ENABLED];

const RULE_TEST_WRITER = 'b1-22za-rule-test-mixed';

interface FullRow {
  readonly value: unknown;
  readonly type: string;
  readonly version: unknown;
  readonly row_version: unknown;
  readonly updated_by: string;
  readonly updated_at: string;
}

function requireSeedFile(): void {
  expect(existsSync(SEED_FILE), 'db/seeds/0007_agent-master-switches.sql exists').toBe(true);
}

async function runSeeds(db: Kysely<DB>): Promise<void> {
  const files = readdirSync(SEEDS)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) {
    const text = readFileSync(`${SEEDS}${name}`, 'utf8');
    await db.transaction().execute(async (trx) => {
      await sql.raw(text).execute(trx);
    });
  }
}

/** The whole config_items rows of app couli for `keys`, by key (missing keys are absent). */
async function rowsOf(db: Kysely<DB>, keys: readonly string[]): Promise<Record<string, FullRow>> {
  const result = await sql<FullRow & { key: string }>`
    SELECT key, value, jsonb_typeof(value) AS type, version, row_version, updated_by,
      updated_at::text AS updated_at
    FROM app.config_items
    WHERE app_id = 'couli' AND key IN (${sql.join([...keys])})`.execute(db);
  return Object.fromEntries(
    result.rows.map((row) => [
      row.key,
      {
        value: row.value,
        type: row.type,
        version: row.version,
        row_version: row.row_version,
        updated_by: row.updated_by,
        updated_at: row.updated_at,
      },
    ]),
  );
}

async function writeFalse(db: Kysely<DB>, key: string): Promise<void> {
  await db
    .insertInto('config_items')
    .values({ app_id: 'couli', key, value: sql`'false'::jsonb`, updated_by: RULE_TEST_WRITER })
    .execute();
}

/**
 * One key has an operator's false row, the other none; after running every seed (twice) the existing
 * row is unchanged and the missing key is seeded as JSON true by 'seed'.
 */
async function expectMixed(db: Kysely<DB>, existing: string, missing: string): Promise<void> {
  requireSeedFile();
  await writeFalse(db, existing);
  const before = await rowsOf(db, SEEDED_KEYS);
  expect(Object.keys(before)).toEqual([existing]);
  expect(before[existing]).toMatchObject({
    value: false,
    type: 'boolean',
    updated_by: RULE_TEST_WRITER,
  });

  await runSeeds(db);
  const afterFirst = await rowsOf(db, SEEDED_KEYS);
  expect(Object.keys(afterFirst).sort()).toEqual([...SEEDED_KEYS].sort());
  expect(afterFirst[existing], existing).toEqual(before[existing]);
  expect(afterFirst[missing], missing).toMatchObject({
    value: true,
    type: 'boolean',
    updated_by: 'seed',
  });

  await runSeeds(db);
  expect(await rowsOf(db, SEEDED_KEYS)).toEqual(afterFirst);
}

it('[AC-B1-22za#4][BR-AI-12] 已有人工写的 agent.enabled=false、agent.page_guide.enabled 无行 → 跑全部种子后 agent.enabled 整行不变（仍 false，version / updated_by 不变），agent.page_guide.enabled 补成 jsonb true、updated_by = seed', async () => {
  await expectMixed(pg.db, AGENT_ENABLED, PAGE_GUIDE_ENABLED);
}, 120_000);

it('[AC-B1-22za#4][BR-AI-12] 反过来：已有人工写的 agent.page_guide.enabled=false、agent.enabled 无行 → 跑全部种子后 page_guide 整行不变，agent.enabled 补成 jsonb true、updated_by = seed', async () => {
  await expectMixed(pg.db, PAGE_GUIDE_ENABLED, AGENT_ENABLED);
}, 120_000);

/** The statements of the seed file (`--` comments removed), trimmed, empty ones dropped. */
function seedStatements(): string[] {
  const text = readFileSync(SEED_FILE, 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  return text
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const INSERT_VALUES =
  /^INSERT\s+INTO\s+app\.config_items\s*\(\s*app_id\s*,\s*key\s*,\s*value\s*,\s*updated_by\s*\)\s*VALUES\s+([\s\S]*?)\s*ON\s+CONFLICT\s*\(\s*app_id\s*,\s*key\s*\)\s*DO\s+NOTHING$/i;

const VALUES_ROW =
  /\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*::\s*jsonb\s*,\s*'([^']*)'\s*\)/gi;

interface SeedRow {
  readonly app_id: string | undefined;
  readonly key: string | undefined;
  readonly value: string | undefined;
  readonly updated_by: string | undefined;
}

it('[AC-B1-22za#3][BR-AI-12] 静态检查 0007 收紧：只能是 INSERT INTO app.config_items (app_id, key, value, updated_by) VALUES 逐行列出两个键（couli、true::jsonb、seed）… ON CONFLICT (app_id, key) DO NOTHING；不得是 INSERT … SELECT / WHERE NOT EXISTS，无 UPDATE / DELETE / TRUNCATE', () => {
  requireSeedFile();
  const statements = seedStatements();
  expect(statements.length).toBeGreaterThan(0);
  const rows: SeedRow[] = [];
  for (const statement of statements) {
    expect(statement).not.toMatch(/\b(SELECT|WHERE|EXISTS|UPDATE|DELETE|TRUNCATE|WITH)\b/i);
    const match = INSERT_VALUES.exec(statement);
    expect(match, statement).not.toBeNull();
    const body = match?.[1] ?? '';
    // Nothing but literal row tuples separated by commas between VALUES and ON CONFLICT.
    expect(body.replace(VALUES_ROW, '').replace(/[\s,]/g, ''), body).toBe('');
    for (const row of body.matchAll(VALUES_ROW)) {
      rows.push({ app_id: row[1], key: row[2], value: row[3], updated_by: row[4] });
    }
  }
  expect(rows.sort((a, b) => String(a.key).localeCompare(String(b.key)))).toEqual([
    { app_id: 'couli', key: AGENT_ENABLED, value: 'true', updated_by: 'seed' },
    { app_id: 'couli', key: PAGE_GUIDE_ENABLED, value: 'true', updated_by: 'seed' },
  ]);
});
