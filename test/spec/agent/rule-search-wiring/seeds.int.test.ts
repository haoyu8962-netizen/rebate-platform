// B3-08l · BR-AI-02 细则「开关」(MVP 工具默认 on; 04 §10.2): search_rules joins the registry, so a fresh
// database needs its switch: after every seed file of db/seeds/** has run (file-name order, each in
// its own transaction, as packages/db/scripts/seed.ts runs them; the same runSeeds as
// test/spec/agent/seeds-core-switches/seeds.int.test.ts) app couli has
// agent.tools.search_rules.enabled as JSON boolean true, written by 'seed', and the six switches of
// 0003 / 0004 stay true. db/seeds/0005_agent-rules-tool-switch.sql only inserts missing rows
// (INSERT … ON CONFLICT (app_id, key) DO NOTHING, app couli only): re-running is harmless and an
// operator's false keeps its value and revision. agent.rag.min_score (code default 0.2, BR-AI-07
// 细则「T6 与其他」) and the P1 tool switches are not seeded. Every test first requires the seed file,
// so all of them are red while it does not exist. Runs as couli_app.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { setConfig, usePgEach } from '../stream-mount/kit.ts';
import { SEARCH_RULES_SWITCH } from './kit.ts';

const pg = usePgEach(createTestDatabase);

const SEEDS = fileURLToPath(new URL('../../../../db/seeds/', import.meta.url));
const SEED_FILE = `${SEEDS}0005_agent-rules-tool-switch.sql`;

/** The switches 0003 (B3-08g) and 0004 (B3-08j) seed. */
const EARLIER_KEYS = [
  'agent.tools.handoff_to_human.enabled',
  'agent.tools.prefill_claim.enabled',
  'agent.tools.list_my_orders.enabled',
  'agent.tools.explain_order.enabled',
  'agent.tools.search_products.enabled',
  'agent.tools.get_rebate_quote.enabled',
] as const;

const ALL_KEYS: readonly string[] = [SEARCH_RULES_SWITCH, ...EARLIER_KEYS];

/** Code defaults cover these; no seed writes them (P1 tools default off, D32 get_my_earnings). */
const UNSEEDED = [
  'agent.rag.min_score',
  'agent.tools.get_my_earnings.enabled',
  'agent.tools.create_watch.enabled',
  'agent.tools.list_watches.enabled',
  'agent.tools.cancel_watch.enabled',
] as const;

interface SwitchRow {
  readonly value: unknown;
  readonly type: string;
  readonly version: unknown;
  readonly updated_by: string;
}

function requireSeedFile(): void {
  expect(existsSync(SEED_FILE), 'db/seeds/0005_agent-rules-tool-switch.sql exists').toBe(true);
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

async function valuesOf(db: Kysely<DB>, keys: readonly string[]): Promise<Record<string, unknown>> {
  const rows = await rowsOf(db, keys);
  return Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, row.value]));
}

function allTrue(keys: readonly string[]): Record<string, boolean> {
  return Object.fromEntries(keys.map((key) => [key, true]));
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

it('[AC-B3-08l#7][BR-AI-02] 新建库跑完全部种子后 couli 的 agent.tools.search_rules.enabled 在，值为 jsonb 布尔 true，updated_by = seed；回归：0003 / 0004 的 6 个开关仍为 true', async () => {
  requireSeedFile();
  await runSeeds(pg.db);
  const rows = await rowsOf(pg.db, ALL_KEYS);
  expect(rows[SEARCH_RULES_SWITCH]).toMatchObject({
    value: true,
    type: 'boolean',
    updated_by: 'seed',
  });
  expect(await valuesOf(pg.db, ALL_KEYS)).toEqual(allTrue(ALL_KEYS));
  expect(Object.values(rows).map((row) => row.type)).toEqual(ALL_KEYS.map(() => 'boolean'));
}, 120_000);

it('[AC-B3-08l#7][BR-AI-02] 重复执行全部种子不报错；先把 search_rules 开关改成 false 再跑两遍仍 false，7 行的 version / updated_by 不变', async () => {
  requireSeedFile();
  await runSeeds(pg.db);
  expect(await valuesOf(pg.db, ALL_KEYS)).toEqual(allTrue(ALL_KEYS));
  await setConfig(pg.db, 'couli', SEARCH_RULES_SWITCH, false);
  const before = await rowsOf(pg.db, ALL_KEYS);
  expect(before[SEARCH_RULES_SWITCH]?.value).toBe(false);
  await runSeeds(pg.db);
  await runSeeds(pg.db);
  expect(await valuesOf(pg.db, ALL_KEYS)).toEqual({
    ...allTrue(ALL_KEYS),
    [SEARCH_RULES_SWITCH]: false,
  });
  expect(await rowsOf(pg.db, ALL_KEYS)).toEqual(before);
}, 120_000);

it('[AC-B3-08l#7] 跑种子前库里已有人工写的 search_rules 开关 false → 种子不改它，其余 6 个开关照常补上', async () => {
  requireSeedFile();
  await pg.db
    .insertInto('config_items')
    .values({
      app_id: 'couli',
      key: SEARCH_RULES_SWITCH,
      value: sql`'false'::jsonb`,
      updated_by: 'b3-08l-rule-test',
    })
    .execute();
  const before = await rowsOf(pg.db, [SEARCH_RULES_SWITCH]);
  expect(before[SEARCH_RULES_SWITCH]).toMatchObject({
    value: false,
    updated_by: 'b3-08l-rule-test',
  });
  await runSeeds(pg.db);
  const after = await rowsOf(pg.db, ALL_KEYS);
  expect(after[SEARCH_RULES_SWITCH]).toEqual(before[SEARCH_RULES_SWITCH]);
  expect(await valuesOf(pg.db, EARLIER_KEYS)).toEqual(allTrue(EARLIER_KEYS));
}, 120_000);

it('[AC-B3-08l#7][BR-AI-07] 不种 agent.rag.min_score（代码默认 0.2）与 P1 / 只读收益工具开关（get_my_earnings、create_watch、list_watches、cancel_watch）', async () => {
  requireSeedFile();
  await runSeeds(pg.db);
  expect(await rowsOf(pg.db, UNSEEDED)).toEqual({});
  const anyApp = await sql<{ key: string }>`SELECT key FROM app.config_items
    WHERE key IN (${sql.join([...UNSEEDED])})`.execute(pg.db);
  expect(anyApp.rows).toEqual([]);
}, 120_000);

it('[AC-B3-08l#7][BR-AI-02] 静态检查 0005：只有 INSERT INTO app.config_items … ON CONFLICT (app_id, key) DO NOTHING，无 UPDATE / DELETE / TRUNCATE，只写 app_id = couli 的 agent.tools.search_rules.enabled', () => {
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
  expect(rows).toEqual([{ app_id: 'couli', key: SEARCH_RULES_SWITCH }]);
});
