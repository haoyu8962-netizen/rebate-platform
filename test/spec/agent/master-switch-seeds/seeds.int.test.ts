// B1-22za · BR-AI-12 细则「/v1/config.agent.enabled 的派生」(负责人 2026-11-12 选 A, 06 Q-A14,
// D10-1333): the default on of agent.enabled and agent.page_guide.enabled (04 §10.2; BR-AI-01 细则
// 「页面引导」) is written by a seed, not by a read-side default. After every seed file of db/seeds/**
// has run (file-name order, each in its own transaction, as packages/db/scripts/seed.ts runs them; the
// same runSeeds as test/spec/agent/rule-search-wiring/seeds.int.test.ts) app couli has both keys as
// JSON boolean true, written by 'seed'. db/seeds/0007_agent-master-switches.sql only inserts missing
// rows (INSERT … ON CONFLICT (app_id, key) DO NOTHING, app couli only): an environment that already has
// a false row keeps it (value, version, updated_by), the operator turns it on in the console.
// agent.whitelist_only is not seeded (missing reads as on; the internal test list stays empty), so
// the seed does not open the Agent to the public. Every test first requires the seed file, so all of
// them are red while it does not exist. Runs as couli_app.
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

/** Not seeded by 0007: missing reads as on (BR-AI-12), the list has no seed. */
const UNSEEDED: readonly string[] = ['agent.whitelist_only', 'agent.whitelist_user_ids'];

interface SwitchRow {
  readonly value: unknown;
  readonly type: string;
  readonly version: unknown;
  readonly updated_by: string;
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

/** The config_items rows of app couli for `keys`, by key (missing keys are absent). */
async function rowsOf(db: Kysely<DB>, keys: readonly string[]): Promise<Record<string, SwitchRow>> {
  const result = await sql<SwitchRow & { key: string }>`
    SELECT key, value, jsonb_typeof(value) AS type, version, updated_by FROM app.config_items
    WHERE app_id = 'couli' AND key IN (${sql.join([...keys])})`.execute(db);
  return Object.fromEntries(
    result.rows.map((row) => [
      row.key,
      { value: row.value, type: row.type, version: row.version, updated_by: row.updated_by },
    ]),
  );
}

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

it('[AC-B1-22za#1][BR-AI-12] 新建库跑完全部种子后 couli 的 agent.enabled、agent.page_guide.enabled 都在，值为 jsonb 布尔 true，updated_by = seed；agent.whitelist_only 与内测名单不种', async () => {
  requireSeedFile();
  await runSeeds(pg.db);
  const rows = await rowsOf(pg.db, SEEDED_KEYS);
  expect(Object.keys(rows).sort()).toEqual([...SEEDED_KEYS].sort());
  for (const key of SEEDED_KEYS) {
    expect(rows[key], key).toMatchObject({ value: true, type: 'boolean', updated_by: 'seed' });
  }
  expect(await rowsOf(pg.db, UNSEEDED)).toEqual({});
}, 120_000);

it('[AC-B1-22za#2][BR-AI-12] 两键先人工写成 false 再跑两遍全部种子 → 整行（值、version、updated_by）不变', async () => {
  requireSeedFile();
  for (const key of SEEDED_KEYS) {
    await pg.db
      .insertInto('config_items')
      .values({
        app_id: 'couli',
        key,
        value: sql`'false'::jsonb`,
        updated_by: 'b1-22za-rule-test',
      })
      .execute();
  }
  const before = await rowsOf(pg.db, SEEDED_KEYS);
  for (const key of SEEDED_KEYS) {
    expect(before[key], key).toMatchObject({
      value: false,
      type: 'boolean',
      updated_by: 'b1-22za-rule-test',
    });
  }
  await runSeeds(pg.db);
  await runSeeds(pg.db);
  const after = await rowsOf(pg.db, SEEDED_KEYS);
  expect(after[AGENT_ENABLED]?.value).toBe(false);
  expect(after[PAGE_GUIDE_ENABLED]?.value).toBe(false);
  expect(after).toEqual(before);
}, 120_000);

it('[AC-B1-22za#3][BR-AI-12] 静态检查 0007：只有 INSERT INTO app.config_items … ON CONFLICT (app_id, key) DO NOTHING，无 UPDATE / DELETE / TRUNCATE，只写 app_id = couli 的 agent.enabled 与 agent.page_guide.enabled', () => {
  requireSeedFile();
  const statements = seedStatements();
  expect(statements.length).toBeGreaterThan(0);
  for (const statement of statements) {
    expect(statement).toMatch(/^INSERT\s+INTO\s+app\.config_items\s*\(/i);
    expect(statement).toMatch(/ON\s+CONFLICT\s*\(\s*app_id\s*,\s*key\s*\)\s*DO\s+NOTHING$/i);
    expect(statement).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE)\b/i);
  }
  const rows = [...statements.join('\n').matchAll(/\(\s*'([^']*)'\s*,\s*'([^']*)'/g)].map(
    (match) => ({ app_id: match[1], key: match[2] }),
  );
  expect(rows.sort((a, b) => String(a.key).localeCompare(String(b.key)))).toEqual([
    { app_id: 'couli', key: AGENT_ENABLED },
    { app_id: 'couli', key: PAGE_GUIDE_ENABLED },
  ]);
});
