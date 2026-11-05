// The migration gate (tools/ci/lint-migrations.ts): selection by the gate baseline, the wrapper's own
// checks, and squawk itself against fixture migrations (a scratch root with the real .squawk.toml).
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import {
  GATE_BASELINE,
  checkMigration,
  checkTimeouts,
  isFundsTable,
  selectMigrations,
} from './lint-migrations.ts';

const REPO = resolve(import.meta.dirname, '../..');
const SCRIPT = join(REPO, 'tools/ci/lint-migrations.ts');
const SCRATCH = join(REPO, '.tmp', `ci-lint-migrations-${process.pid}`);
/** What every new migration starts with (db/AGENTS.md rule 11). */
const TIMEOUTS =
  "-- Up Migration\nSET LOCAL lock_timeout = '10s';\nSET LOCAL statement_timeout = '10min';\n";

let fixtureCount = 0;

/** A scratch repository root with the real .squawk.toml and the given migration files. */
function fixture(files: Record<string, string>): string {
  const root = join(SCRATCH, String(++fixtureCount));
  mkdirSync(join(root, 'db/migrations'), { recursive: true });
  cpSync(join(REPO, '.squawk.toml'), join(root, '.squawk.toml'));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(root, 'db/migrations', name), text);
  }
  return root;
}

function run(root: string, ...extra: string[]) {
  const res = spawnSync(process.execPath, [SCRIPT, '--root', root, ...extra], {
    encoding: 'utf8',
    cwd: REPO,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

it('selects the .sql files numbered above the gate baseline, sorted, and reports misnamed ones', () => {
  const names = [
    '0020_z-last.sql',
    '0018_frozen.sql',
    'README.md',
    '0019_a-b.sql',
    '0001_app-schema.sql',
  ];
  expect(selectMigrations(names)).toEqual({
    lint: ['0019_a-b.sql', '0020_z-last.sql'],
    badNames: [],
  });
  expect(selectMigrations(names, 19)).toEqual({ lint: ['0020_z-last.sql'], badNames: [] });
  expect(selectMigrations(['0021-no-underscore.sql', '21_short.sql', '0022_Upper.sql'])).toEqual({
    lint: [],
    badNames: ['0021-no-underscore.sql', '0022_Upper.sql', '21_short.sql'],
  });
});

it('the baseline is the last migration merged before the gate', () => {
  expect(GATE_BASELINE).toBe(18);
});

it('knows the funds and attribution tables by name, with or without schema and quotes', () => {
  for (const t of [
    'app.orders',
    'order_keys',
    '"app"."order_settlements"',
    'ledger_entries',
    'accounts',
    'withdrawals',
    'payout_accounts',
    'settlement_batches',
    'commission_rates',
    'reconciliation_runs',
    'adjustments',
    'union_bindings',
    'union_pids',
    'links',
    'link_logs',
    // B2-02b: ledger / settlement tables no prefix matches.
    'daily_balances',
    'asset_snapshots',
    'bad_debt_writeoffs',
    'admin_adjustments',
    'recon_diffs',
    'fund_ledger',
    // F1-02zu: invite reward grants and budget counters (CT-25b).
    'invite_rewards',
    'invite_reward_budgets',
    // B2-08a: the yearly withholding ledger of withdrawals (BR-WDR-20), registered by name.
    'tax_ytd',
    // B2-04c: settlement tables no prefix matches.
    'beneficiary_credits',
    'recon_union',
    'asset_snapshot_receivables',
    // B2-15g: payment tables by the pay_ prefix (payout_* stays on its own prefix).
    'pay_orders',
    'pay_refunds',
    'pay_anomalies',
    'pay_notifications',
    'pay_query_attempts',
    'app.pay_orders',
  ]) {
    expect(isFundsTable(t), t).toBe(true);
  }
  for (const t of [
    'app.articles',
    'users',
    'devices',
    'config_items',
    'product_refs',
    'inbox_messages',
    'linkage',
  ]) {
    expect(isFundsTable(t), t).toBe(false);
  }
});

it('checkMigration: a money column typed anything but bigint is a problem, bigint is not', () => {
  const sql =
    'CREATE TABLE app.t (\n  amount_fen integer NOT NULL,\n  fee_fen bigint NOT NULL,\n  rate_bp integer NOT NULL\n);\nALTER TABLE app.t ALTER COLUMN fee_fen TYPE numeric(12,2);\n';
  const problems = checkMigration('x.sql', sql);
  expect(problems.map((p) => [p.line, p.message])).toEqual([
    [2, 'money column amount_fen must be bigint (ADR-0001 §4), found integer'],
    [6, 'money column fee_fen must be bigint (ADR-0001 §4), found numeric'],
  ]);
  expect(
    checkMigration(
      'y.sql',
      'ALTER TABLE app.t ADD COLUMN total_fen bigint; -- amount_fen int in a comment is fine\n',
    ),
  ).toEqual([]);
});

it('checkMigration: squawk-ignore-file is refused anywhere in the file', () => {
  const problems = checkMigration('x.sql', '-- Up Migration\n-- squawk-ignore-file\nSELECT 1;\n');
  expect(problems).toHaveLength(1);
  expect(problems[0]?.line).toBe(2);
});

it('checkMigration: squawk-ignore on a funds-table statement is refused, before or inside the statement; another table is allowed', () => {
  const before =
    '-- Up Migration\n-- the column is unused\n-- squawk-ignore ban-drop-column\nALTER TABLE app.orders DROP COLUMN note;\n';
  expect(checkMigration('x.sql', before).map((p) => p.line)).toEqual([3]);
  const inside = 'ALTER TABLE app.orders -- squawk-ignore ban-drop-column\n  DROP COLUMN note;\n';
  expect(checkMigration('x.sql', inside).map((p) => p.line)).toEqual([1]);
  const beforeName =
    'ALTER TABLE\n  -- squawk-ignore ban-drop-column\n  app.order_keys DROP COLUMN note;\n';
  expect(checkMigration('x.sql', beforeName).map((p) => p.line)).toEqual([2]);
  const index =
    '-- squawk-ignore require-concurrent-index-creation\nCREATE INDEX x ON app.union_credentials (user_id);\n';
  expect(checkMigration('x.sql', index)).toHaveLength(1);
  const other =
    '-- Up Migration\n-- squawk-ignore ban-drop-column\nALTER TABLE app.articles DROP COLUMN note;\n-- squawk-ignore ban-drop-column\nALTER TABLE ONLY "app"."users" DROP COLUMN IF EXISTS nick;\nALTER TABLE app.devices -- squawk-ignore ban-drop-column\n  DROP COLUMN note;\n';
  expect(checkMigration('x.sql', other)).toEqual([]);
});

it('classifies every table of db/schema.sql: the funds and attribution tables and nothing else', () => {
  const schema = readFileSync(join(REPO, 'db/schema.sql'), 'utf8');
  const tables = [...schema.matchAll(/^CREATE TABLE app\.([a-z0-9_]+)/gm)].map(
    (m) => m[1] as string,
  );
  expect(tables.length).toBeGreaterThan(40);
  const funds = new Set([
    'orders',
    'orders_default',
    'order_keys',
    'order_rights',
    'order_settlements',
    'order_sync_pending',
    'order_sync_counters',
    'order_sync_drops',
    'order_sync_drop_keys',
    'order_status_history',
    'payout_accounts',
    'payout_account_changes',
    'payout_account_verify_attempts',
    'union_accounts',
    'union_credentials',
    'union_pids',
    'union_bindings',
    'union_auth_sessions',
    'union_binding_conflicts',
    'union_raw_payloads',
    'union_raw_payloads_default',
    'links',
    'link_logs',
    'link_logs_default',
    'link_open_attempts',
    'processed_events',
    'idempotency_keys',
    'appeals',
    'commission_rule_versions',
    'commission_rules',
    'commission_rule_reserves',
    'commission_rule_trials',
    'commission_splits',
    'commission_split_amounts',
    'commission_split_beneficiary_events',
    'commission_split_totals',
    'ledger_accounts',
    'ledger_vouchers',
    'ledger_entries',
    'ledger_entries_default',
    'account_balances',
    'daily_balances',
    'invite_rewards',
    'invite_reward_budgets',
    // B2-08a: the yearly withholding ledger of withdrawals (BR-WDR-20), registered by name.
    'tax_ytd',
    // B2-04b: settlement-side ledger tables.
    'recon_diffs',
    'asset_snapshots',
    'asset_snapshot_receivables',
    // B2-04a: settlement core tables.
    'settle_jobs',
    'settle_bills',
    'settle_batches',
    'settle_batch_items',
    // B2-04zfa: settlement's run-level state (settle_ prefix).
    'settle_runs',
    // B2-04zh: union collection records (union_ prefix, D10-538).
    'union_receipts',
    'admin_adjustments',
    'bad_debt_writeoffs',
    'beneficiary_credits',
    'settle_adjust_batches',
    'settle_adjustments',
    'recon_union',
    // Withdrawal tables (B2-05b): the withdraw* prefix covers both.
    'withdrawals',
    'withdraw_holds',
    // B2-15a: payment core tables (pay_ prefix, B2-15g).
    'pay_orders',
    'pay_notifications',
    'pay_query_attempts',
    'pay_refunds',
    'pay_anomalies',
    'pay_fulfillments',
    // B2-15n: reconciled bill days (pay_ prefix).
    'pay_recon_days',
    // Payout core tables (B2-06a): batches, batch member outcomes, channel attempts, watermarks.
    'payout_batches',
    'payout_batch_items',
    'payout_attempts',
    'payout_watermarks',
    // B1-09e: order part two tables under the order prefix (attribution side).
    'order_sync_requests',
    'order_assignments',
    // B1-09i: per-window progress of manual order sync (order prefix, attribution side).
    'order_sync_request_windows',
    // B2-07a: R2 channel reconciliation (BR-WDR-23) — the daily run record (payout prefix) and the
    // detail rows (listed by name, CT-06zxj).
    'payout_recon_runs',
    'recon_channel',
  ]);
  // Funds tables whose migration has not landed yet (B2-07a, D10-413): they may be missing from
  // db/schema.sql; every other expected name must exist.
  const PENDING_FUNDS_TABLES: readonly string[] = ['payout_recon_runs', 'recon_channel'];
  for (const name of funds) {
    if (PENDING_FUNDS_TABLES.includes(name) && !tables.includes(name)) continue;
    expect(tables, name).toContain(name);
  }
  for (const name of tables) expect(isFundsTable(`app.${name}`), name).toBe(funds.has(name));
});

it('checkMigration: a trailing same-line ignore after the semicolon, a block-comment ignore, IF EXISTS / ONLY and comma lists all name the funds table', () => {
  const trailing = 'ALTER TABLE app.orders DROP COLUMN c; -- squawk-ignore ban-drop-column\n';
  expect(checkMigration('x.sql', trailing).map((p) => p.message)).toEqual([
    expect.stringContaining('funds or attribution table orders'),
  ]);
  const trailingNext =
    'ALTER TABLE app.articles DROP COLUMN c; -- squawk-ignore ban-drop-column\nALTER TABLE app.orders ADD COLUMN n bigint;\n';
  // The trailing comment belongs to the articles statement; a plain ADD COLUMN on the next line is legal.
  expect(checkMigration('x.sql', trailingNext)).toEqual([]);
  const block = '/* squawk-ignore ban-drop-table */\nDROP TABLE IF EXISTS app.orders;\n';
  expect(checkMigration('x.sql', block).map((p) => p.message)).toEqual([
    expect.stringContaining('funds or attribution table orders'),
  ]);
  for (const sql of [
    '-- squawk-ignore ban-drop-table\nDROP TABLE IF EXISTS app.orders;\n',
    '-- squawk-ignore ban-drop-column\nALTER TABLE ONLY app.orders DROP COLUMN c;\n',
    '-- squawk-ignore renaming-column\nALTER TABLE IF EXISTS app.ledger_entries RENAME COLUMN a TO b;\n',
    '-- squawk-ignore ban-drop-table\nDROP TABLE app.articles, app.orders;\n',
  ]) {
    expect(checkMigration('x.sql', sql), sql).toHaveLength(1);
  }
  expect(checkMigration('x.sql', '/* squawk-ignore-file */\nSELECT 1;\n')).toHaveLength(1);
});

it('checkMigration: money columns in CHECK, trigger expressions and COMMENT are not column definitions; SET DATA TYPE is', () => {
  const ok =
    "CREATE TABLE app.t (amount_fen bigint NOT NULL CHECK (amount_fen > 0), CHECK (x_fen IS NOT NULL));\nCOMMENT ON COLUMN app.t.amount_fen IS 'fen';\nCREATE FUNCTION app.f() RETURNS trigger AS $$ BEGIN IF NEW.x_fen IS DISTINCT FROM OLD.x_fen THEN RAISE EXCEPTION 'no'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;\n";
  expect(checkMigration('x.sql', ok)).toEqual([]);
  for (const sql of [
    'CREATE TABLE app.t (amount_fen text);\n',
    'ALTER TABLE app.t ADD COLUMN amount_fen pg_catalog.int4;\n',
    'ALTER TABLE app.t ADD COLUMN amount_fen character varying(20);\n',
  ]) {
    expect(
      checkMigration('x.sql', sql).map((p) => p.message),
      sql,
    ).toEqual([expect.stringContaining('amount_fen must be bigint')]);
  }
  expect(
    checkMigration('x.sql', 'ALTER TABLE app.t ADD COLUMN amount_fen pg_catalog.int8;\n'),
  ).toEqual([]);
  expect(
    checkMigration(
      'x.sql',
      'ALTER TABLE app.t ALTER COLUMN amount_fen SET DATA TYPE integer;\n',
    ).map((p) => p.message),
  ).toEqual([expect.stringContaining('amount_fen must be bigint')]);
});

// CT-06zz: this case lints every migration of the real repository in a child process, so it grows
// with db/migrations. Green on main in CI it took 5.3–12.4 s (2026-10-22) and on the loaded test
// machine it hit the 30 s tools timeout (withdraw verify/6, W1 2026-10-24; the whole file ~39 s there).
// The limit is about three times that whole-file time; the assertions are unchanged. It does not
// bound a hang: run() waits on spawnSync with no timeout, so a stuck child is left to the job limit.
it('passes the real repository: every migration is either frozen or accepted', () => {
  const res = run(REPO);
  expect(res.stderr).toBe('');
  expect(res.status).toBe(0);
}, 120_000);

it('passes with a message when no migration is newer than the baseline', () => {
  const res = run(fixture({ '0018_frozen.sql': 'ALTER TABLE app.t DROP COLUMN c;\n' }));
  expect(res.status).toBe(0);
  expect(res.stdout).toContain('nothing to lint');
});

it('--list prints the files that would be linted, one per line', () => {
  const res = run(
    fixture({ '0019_a.sql': '-- Up Migration\n', '0020_b.sql': '-- Up Migration\n' }),
    '--list',
  );
  expect(res.status).toBe(0);
  expect(res.stdout).toBe('db/migrations/0019_a.sql\ndb/migrations/0020_b.sql\n');
});

it('fails on a DROP COLUMN in a new migration and names the squawk rule', () => {
  const res = run(fixture({ '0019_drop.sql': `${TIMEOUTS}ALTER TABLE app.t DROP COLUMN c;\n` }));
  expect(res.status).toBe(1);
  expect(res.stdout).toContain('ban-drop-column');
});

it('fails on a column type change and a rename in a new migration', () => {
  const res = run(
    fixture({
      '0019_type.sql': `${TIMEOUTS}ALTER TABLE app.t ALTER COLUMN c TYPE bigint;\n`,
      '0020_rename.sql': `${TIMEOUTS}ALTER TABLE app.t RENAME COLUMN a TO b;\n`,
    }),
  );
  expect(res.status).toBe(1);
  expect(res.stdout).toContain('changing-column-type');
  expect(res.stdout).toContain('renaming-column');
});

it('fails when a new migration does not set the lock and statement timeouts first', () => {
  const res = run(
    fixture({
      '0019_no-timeouts.sql': '-- Up Migration\nALTER TABLE app.t ADD COLUMN n bigint;\n',
    }),
  );
  expect(res.status).toBe(1);
  expect(res.stdout).toContain('require-lock-timeout');
  expect(res.stdout).toContain('require-statement-timeout');
});

it('fails on a money column that is not bigint, before squawk runs', () => {
  const res = run(
    fixture({
      '0019_money.sql': `${TIMEOUTS}CREATE TABLE app.t (id uuid PRIMARY KEY, amount_fen integer NOT NULL);\n`,
    }),
  );
  expect(res.status).toBe(1);
  expect(res.stderr).toContain('amount_fen must be bigint');
});

it('fails on squawk-ignore-file and on a squawk-ignore before a funds-table statement (the bypass samples)', () => {
  const res = run(
    fixture({
      '0019_file.sql': `${TIMEOUTS}-- squawk-ignore-file\nALTER TABLE app.articles DROP COLUMN c;\n`,
      '0020_funds.sql': `${TIMEOUTS}-- squawk-ignore ban-drop-column\nALTER TABLE app.orders DROP COLUMN c;\n`,
      '0021_inside.sql': `${TIMEOUTS}ALTER TABLE app.union_accounts -- squawk-ignore ban-drop-column\n  DROP COLUMN c;\n`,
    }),
  );
  expect(res.status).toBe(1);
  expect(res.stderr).toContain('squawk-ignore-file is not accepted');
  expect(res.stderr).toContain('funds or attribution table orders');
  expect(res.stderr).toContain('funds or attribution table union_accounts');
  expect(res.stdout).not.toMatch(/warning: ban-drop-column/);
});

it('accepts a squawk-ignore comment with its reason on the line before a statement on another table', () => {
  const res = run(
    fixture({
      '0019_drop.sql': `${TIMEOUTS}-- app.articles is not a funds table (规划/02 §4.1); the column was never read.\n-- squawk-ignore ban-drop-column\nALTER TABLE app.articles DROP COLUMN c;\n`,
    }),
  );
  expect(res.stderr).toBe('');
  expect(res.stdout).not.toContain('ban-drop-column');
  expect(res.status).toBe(0);
});

it('accepts the DDL patterns the repository uses: timeouts, a new table with its index, a GRANT, a trigger', () => {
  const res = run(
    fixture({
      '0019_new.sql':
        `${TIMEOUTS}` +
        'CREATE TABLE app.t (id uuid PRIMARY KEY, app_id text NOT NULL, amount_fen bigint NOT NULL, rate_bp integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now());\n' +
        'CREATE INDEX t_app_id_idx ON app.t (app_id);\n' +
        'GRANT SELECT, INSERT ON app.t TO couli_app;\n' +
        'CREATE TRIGGER t_no_update BEFORE UPDATE ON app.t FOR EACH ROW EXECUTE FUNCTION app.forbid_update();\n',
    }),
  );
  expect(res.stderr).toBe('');
  expect(res.stdout).not.toContain('warning');
  expect(res.status).toBe(0);
});

it('fails on a misnamed migration file even when there is nothing else to lint', () => {
  const res = run(fixture({ '0019-dash.sql': '-- Up Migration\n' }));
  expect(res.status).toBe(1);
  expect(res.stderr).toContain('0019-dash.sql');
  expect(res.stdout).not.toContain('nothing to lint');
});

it('checkTimeouts: both SET LOCAL timeouts are required, reported under the squawk rule names', () => {
  expect(checkTimeouts('x.sql', TIMEOUTS)).toEqual([]);
  expect(
    checkTimeouts('x.sql', "SET lock_timeout = '5s';\nSET statement_timeout = '1min';\n"),
  ).toEqual([]);
  const missing = checkTimeouts(
    'x.sql',
    "-- SET LOCAL lock_timeout = '5s' (only in a comment)\nCREATE TABLE app.t (id uuid);\n",
  );
  expect(missing).toHaveLength(2);
  expect(missing[0]).toMatch(/^x\.sql:1:0: warning: require-lock-timeout /);
  expect(missing[1]).toMatch(/^x\.sql:1:0: warning: require-statement-timeout /);
});

it('checkMigration: a directive on its own line inside a block comment still counts (squawk strips the newlines)', () => {
  const drop = 'ALTER TABLE app.orders DROP COLUMN c;\n';
  for (const comment of ['/*\nsquawk-ignore-file\n*/\n', '/*\r\n  squawk-ignore-file\r\n*/\r\n']) {
    expect(checkMigration('x.sql', comment + drop).map((p) => p.message)).toEqual([
      expect.stringContaining('squawk-ignore-file is not accepted'),
    ]);
  }
  for (const comment of [
    '/*\n  squawk-ignore ban-drop-column\n*/\n',
    '/*\r\n  squawk-ignore ban-drop-column\r\n*/\r\n',
  ]) {
    expect(checkMigration('x.sql', comment + drop)).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('funds or attribution table orders'),
      }),
    ]);
  }
});

it('checkMigration: spaces around the schema dot and quoted type names do not hide a funds table or a money column', () => {
  expect(
    checkMigration(
      'x.sql',
      '-- squawk-ignore ban-drop-column\nALTER TABLE app . orders DROP COLUMN c;\n',
    ),
  ).toEqual([
    expect.objectContaining({
      message: expect.stringContaining('funds or attribution table orders'),
    }),
  ]);
  expect(
    checkMigration('x.sql', 'CREATE TABLE app.t (amount_fen "int4");').map((p) => p.message),
  ).toEqual([expect.stringContaining('amount_fen must be bigint')]);
  expect(checkMigration('x.sql', 'CREATE TABLE app.t (amount_fen "pg_catalog"."int8");')).toEqual(
    [],
  );
});

it('checkMigration: a money column declared as an array of bigint is refused', () => {
  for (const sql of [
    'CREATE TABLE app.t (amount_fen bigint[]);',
    'CREATE TABLE app.t (amount_fen int8 ARRAY);',
  ]) {
    expect(checkMigration('x.sql', sql).map((p) => p.message)).toEqual([
      expect.stringContaining('amount_fen must be bigint'),
    ]);
  }
});

it('checkTimeouts: the two settings must come before the first statement that is not a SET', () => {
  expect(
    checkTimeouts(
      'x.sql',
      "CREATE TABLE app.t (id uuid PRIMARY KEY);\nSET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '1min';\n",
    ),
  ).toHaveLength(2);
  expect(
    checkTimeouts(
      'x.sql',
      "SET LOCAL lock_timeout = '5s';\nCREATE TABLE app.t (id uuid PRIMARY KEY);\nSET LOCAL statement_timeout = '1min';\n",
    ),
  ).toEqual([expect.stringMatching(/warning: require-statement-timeout /)]);
  expect(
    checkTimeouts(
      'x.sql',
      "-- Up Migration\nSET LOCAL search_path = app;\nSET LOCAL statement_timeout = '1min';\nSET LOCAL lock_timeout = '5s';\nCREATE TABLE t (id uuid);\n",
    ),
  ).toEqual([]);
});

it('checkMigration: TRUNCATE TABLE with an ignore is refused on a funds table (TABLE is a keyword there, not the name)', () => {
  for (const sql of [
    '-- squawk-ignore ban-truncate-cascade\nTRUNCATE TABLE app.ledger_entries, app.accounts CASCADE;\n',
    '-- squawk-ignore ban-truncate-cascade\nTRUNCATE app.articles, app.orders CASCADE;\n',
  ]) {
    expect(checkMigration('x.sql', sql)).toEqual([
      expect.objectContaining({ message: expect.stringContaining('funds or attribution table') }),
    ]);
  }
});

it('checkMigration: money columns are an allowlist — only bigint / int8 pass, whatever else is declared', () => {
  for (const [sql, type] of [
    ['CREATE TABLE app.order_totals (app_id text NOT NULL, amount_fen DEC(12,2));', 'dec'],
    ['CREATE TABLE app.t (amount_fen app.money_domain NOT NULL);', 'app'],
    ['CREATE TABLE app.t (amount_fen citext);', 'citext'],
    ['CREATE TABLE app.t (amount_fen int8range);', 'int8range'],
    [
      'ALTER TABLE app.t ADD COLUMN note text, ADD COLUMN IF NOT EXISTS fee_fen numeric(12, 2);',
      'numeric',
    ],
    ['ALTER TABLE ONLY app.t ALTER fee_fen TYPE double precision;', 'double'],
  ] as const) {
    expect(checkMigration('x.sql', sql).map((p) => p.message)).toEqual([
      expect.stringContaining(`found ${type}`),
    ]);
  }
  for (const sql of [
    'CREATE TABLE IF NOT EXISTS app.t (id uuid PRIMARY KEY, "amount_fen" BIGINT NOT NULL DEFAULT 0 CHECK (amount_fen >= 0), note text DEFAULT \'a, b (c\');',
    'ALTER TABLE app.t ALTER COLUMN amount_fen SET NOT NULL, ALTER COLUMN amount_fen SET DEFAULT 0;',
    'CREATE INDEX t_amount_idx ON app.t (amount_fen DESC);',
    'ALTER TABLE app.t ADD CONSTRAINT t_amount_fen_ck CHECK (amount_fen > 0);',
    'INSERT INTO app.t (amount_fen) VALUES (1);',
  ]) {
    expect(checkMigration('x.sql', sql)).toEqual([]);
  }
});

it('checkMigration: semicolons and comment markers inside string literals do not split statements or start comments', () => {
  expect(
    checkMigration(
      'x.sql',
      "ALTER TABLE app.orders ADD COLUMN note text DEFAULT ';', DROP COLUMN c; -- squawk-ignore ban-drop-column\n",
    ),
  ).toEqual([
    expect.objectContaining({
      message: expect.stringContaining('funds or attribution table orders'),
    }),
  ]);
  expect(
    checkMigration(
      'x.sql',
      "-- squawk-ignore ban-drop-column\nALTER TABLE app.orders ADD COLUMN note text DEFAULT '--', DROP COLUMN c;\n",
    ),
  ).toEqual([
    expect.objectContaining({
      message: expect.stringContaining('funds or attribution table orders'),
    }),
  ]);
  expect(
    checkMigration('x.sql', "CREATE TABLE app.t (note text DEFAULT '--', amount_fen integer);").map(
      (p) => p.message,
    ),
  ).toEqual([expect.stringContaining('amount_fen must be bigint')]);
});

it('checkTimeouts: a timeout of 0 (no timeout at all) does not count', () => {
  expect(
    checkTimeouts(
      'x.sql',
      "SET LOCAL lock_timeout = 0;\nSET LOCAL statement_timeout = '0';\nCREATE TABLE app.t (id uuid);\n",
    ),
  ).toHaveLength(2);
  expect(
    checkTimeouts(
      'x.sql',
      "SET LOCAL lock_timeout TO '10s';\nSET LOCAL statement_timeout = 600000;\n",
    ),
  ).toEqual([]);
});

it("checkMigration: a statement after a blank line is out of a trailing ignore's reach", () => {
  expect(
    checkMigration(
      'x.sql',
      "ALTER TABLE app.articles ADD CONSTRAINT articles_title_nonempty CHECK (title <> ''); -- squawk-ignore constraint-missing-not-valid\n\nALTER TABLE app.orders ADD COLUMN note text;\n",
    ),
  ).toEqual([]);
  expect(
    checkMigration(
      'x.sql',
      '-- squawk-ignore ban-drop-column\nALTER TABLE app.articles DROP COLUMN a;\n\nALTER TABLE app.orders DROP COLUMN c;\n',
    ),
  ).toEqual([]);
});

it('checkTimeouts: 0 with a unit and DEFAULT (both mean no timeout) do not count', () => {
  expect(
    checkTimeouts(
      'x.sql',
      "SET LOCAL lock_timeout = '0h';\nSET LOCAL statement_timeout TO DEFAULT;\n",
    ),
  ).toHaveLength(2);
});

it('checkMigration: a semicolon inside a quoted identifier does not split the statement', () => {
  expect(
    checkMigration(
      'x.sql',
      'CREATE TABLE app.t (id uuid PRIMARY KEY, "note;tag" text, amount_fen integer);',
    ).map((p) => p.message),
  ).toEqual([expect.stringContaining('amount_fen must be bigint')]);
});

it('squawk without the ignores: what an ignore would hide on a funds-table statement is refused, whichever comment it is', () => {
  const refused = run(
    fixture({
      // the next line after a trailing ignore (squawk's line rule)
      '0019_next.sql': `${TIMEOUTS}ALTER TABLE app.articles DROP COLUMN a; -- squawk-ignore ban-drop-column\nALTER TABLE app.orders DROP COLUMN c;\n`,
      // earlier on the ignored line
      '0020_same.sql': `${TIMEOUTS}ALTER TABLE app.orders DROP COLUMN a; ALTER TABLE app.articles DROP COLUMN b; -- squawk-ignore ban-drop-column\n`,
      // a non-destructive rule on a funds table next to an ignored line
      '0021_required.sql': `${TIMEOUTS}ALTER TABLE app.articles ADD COLUMN r int NOT NULL; -- squawk-ignore adding-required-field\nALTER TABLE app.orders ADD COLUMN r int NOT NULL;\n`,
    }),
  );
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain(
    '0019_next.sql:5: ban-drop-column on a statement of funds or attribution table orders',
  );
  expect(refused.stderr).toContain(
    '0020_same.sql:4: ban-drop-column on a statement of funds or attribution table orders',
  );
  expect(refused.stderr).toContain(
    '0021_required.sql:5: adding-required-field on a statement of funds or attribution table orders',
  );
  expect(refused.stdout).not.toMatch(/warning:/);
});

it('squawk without the ignores: legal statements on a funds table next to an ignored line pass', () => {
  const res = run(
    fixture({
      '0019_legal.sql':
        `${TIMEOUTS}ALTER TABLE app.articles DROP COLUMN old_title; -- squawk-ignore ban-drop-column\n` +
        'ALTER TABLE app.orders ADD COLUMN extra_fen bigint;\n' +
        'GRANT SELECT ON app.orders TO couli_readonly;\n' +
        'ALTER TABLE app.order_rights ALTER COLUMN type SET STATISTICS 100;\n',
    }),
  );
  expect(res.stderr).toBe('');
  expect(res.status).toBe(0);
});

it("checkMigration: a comment inside a funds-table statement on a line with an earlier statement is that statement's", () => {
  expect(
    checkMigration(
      'x.sql',
      'ALTER TABLE app.articles DROP COLUMN a; ALTER TABLE app.orders -- squawk-ignore ban-drop-column\n  DROP COLUMN c;\n',
    ),
  ).toEqual([
    expect.objectContaining({
      message: expect.stringContaining('funds or attribution table orders'),
    }),
  ]);
  expect(
    checkMigration('x.sql', 'CREATE TABLE app.t (amount_fen int8.fen);').map((p) => p.message),
  ).toEqual([expect.stringContaining('amount_fen must be bigint')]);
});

it('selectMigrations: a migration merged before the gate is frozen by its exact name, not by its number', () => {
  expect(
    selectMigrations([
      '0018_linking-bindings.sql',
      '0019_device-registrations-created-at-insert.sql',
      '0019_other.sql',
      '0020_next.sql',
    ]).lint,
  ).toEqual(['0019_other.sql', '0020_next.sql']);
});

it('CT-06b: a function body (not a DO block) may build DROP with EXECUTE, as the partition maintenance does', () => {
  const sql =
    "CREATE OR REPLACE FUNCTION app.drop_expired() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  EXECUTE format('DROP TABLE IF EXISTS %I', 'x');\nEND\n$$;\n";
  expect(checkMigration('x.sql', sql)).toEqual([]);
  expect(
    checkMigration('x.sql', "DO $$ BEGIN EXECUTE 'DROP TABLE app.articles'; END $$;").map(
      (p) => p.message,
    ),
  ).toEqual([expect.stringContaining('destructive DDL inside a DO block')]);
});

it('CT-06b: raising a timeout after the DDL is fine; lowering one to 0 or RESET anywhere is not', () => {
  const ddl = 'CREATE TABLE app.t (id uuid);\n';
  expect(
    checkTimeouts('x.sql', `${TIMEOUTS}${ddl}SET LOCAL statement_timeout = '30min';\n`),
  ).toEqual([]);
  expect(checkTimeouts('x.sql', `${TIMEOUTS}${ddl}SET statement_timeout TO 0;\n`)).toEqual([
    expect.stringContaining('require-statement-timeout'),
  ]);
  expect(checkTimeouts('x.sql', `RESET ALL;\n${TIMEOUTS}${ddl}`)).toHaveLength(2);
  expect(checkTimeouts('x.sql', `${TIMEOUTS.replace("'10s'", "'0.4ms'")}${ddl}`)).toEqual([
    expect.stringContaining('require-lock-timeout'),
  ]);
});

it('CT-06b: the real repository passes the frozen-set check, and a script file without a number is refused', () => {
  expect(
    run(fixture({ '0019_new.sql': `${TIMEOUTS}CREATE TABLE app.t (id uuid);\n`, 'helper.ts': '' }))
      .stderr,
  ).toContain('helper.ts is not a SQL migration');
});

it('CT-06c: a guard function may be extended with CREATE OR REPLACE while it still raises, not emptied', () => {
  const trigger =
    'CREATE TRIGGER orders_guard BEFORE UPDATE ON app.orders FOR EACH ROW EXECUTE FUNCTION app.guard_fn();\n';
  const raising =
    "CREATE OR REPLACE FUNCTION app.guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.a IS DISTINCT FROM OLD.a THEN RAISE EXCEPTION 'immutable'; END IF; RETURN NEW; END $$;";
  expect(checkMigration('x.sql', trigger + raising)).toEqual([]);
  expect(
    checkMigration('x.sql', trigger + raising.replace("RAISE EXCEPTION 'immutable';", 'NULL;')).map(
      (p) => p.message,
    ),
  ).toEqual([
    expect.stringContaining('function guard_fn guards funds or attribution table orders'),
  ]);
});

it('CT-06c: dropping a funds-table constraint or index is fine only when the migration recreates it', () => {
  expect(
    checkMigration(
      'x.sql',
      'ALTER TABLE app.orders DROP CONSTRAINT orders_x_key, ADD CONSTRAINT orders_x_key UNIQUE (app_id, x);',
    ),
  ).toEqual([]);
  expect(
    checkMigration('x.sql', 'ALTER TABLE app.orders DROP CONSTRAINT orders_x_key;').map(
      (p) => p.message,
    ),
  ).toEqual([
    expect.stringContaining('constraint orders_x_key on funds or attribution table orders'),
  ]);
  expect(checkMigration('x.sql', 'DROP TABLE app.articles CASCADE;').map((p) => p.message)).toEqual(
    [expect.stringContaining('DROP … CASCADE is not accepted')],
  );
  expect(
    checkMigration(
      'x.sql',
      'ALTER TABLE app.t ADD CONSTRAINT t_fk FOREIGN KEY (a) REFERENCES app.u (id) ON DELETE CASCADE;',
    ),
  ).toEqual([]);
});

it('CT-06d: a funds-table guard recreated with only a string literal changed is a different definition', () => {
  const ctx = {
    schemaSql: '',
    migrationsSql: [
      "CREATE UNIQUE INDEX payout_attempts_inflight_key ON app.payout_attempts (app_id, user_id) WHERE status IN ('reserved', 'unknown');",
    ],
    approved: false,
  };
  const drop = 'DROP INDEX app.payout_attempts_inflight_key;\n';
  const same =
    "CREATE UNIQUE INDEX payout_attempts_inflight_key ON app.payout_attempts (app_id, user_id) WHERE status IN ('reserved', 'unknown');";
  expect(checkMigration('x.sql', drop + same, ctx)).toEqual([]);
  expect(
    checkMigration('x.sql', drop + same.replace("'reserved'", "'matched'"), ctx).map(
      (p) => p.message,
    ),
  ).toEqual([expect.stringContaining('recreated with a different definition')]);
});

it('CT-06d: tight quotes and EXECUTE PROCEDURE do not make an identical trigger look different', () => {
  const ctx = {
    schemaSql: '',
    migrationsSql: [
      'CREATE TRIGGER order_keys_append_only BEFORE UPDATE OR DELETE ON app.order_keys FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();',
    ],
    approved: false,
  };
  const drop = 'DROP TRIGGER order_keys_append_only ON app.order_keys;\n';
  for (const create of [
    'CREATE TRIGGER"order_keys_append_only" BEFORE DELETE OR UPDATE ON"app"."order_keys" FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();',
    'CREATE TRIGGER order_keys_append_only BEFORE DELETE OR UPDATE ON app.order_keys FOR EACH ROW EXECUTE PROCEDURE app.reject_update_delete();',
  ]) {
    expect(checkMigration('x.sql', drop + create, ctx), create).toEqual([]);
  }
  // A later CREATE OR REPLACE weakening it is still caught after the identical recreation.
  expect(
    checkMigration(
      'x.sql',
      `${drop}CREATE TRIGGER order_keys_append_only BEFORE UPDATE OR DELETE ON app.order_keys FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();\nCREATE OR REPLACE TRIGGER order_keys_append_only BEFORE UPDATE ON app.order_keys FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();`,
      ctx,
    ).map((p) => p.message),
  ).toEqual([expect.stringContaining('recreated with a different definition')]);
});

it('CT-06d: a set_config commented out inside a DO block does not count as switching a timeout off', () => {
  expect(
    checkTimeouts(
      'x.sql',
      `${TIMEOUTS}DO $$ BEGIN\n-- PERFORM set_config('lock_timeout', '0', true);\nNULL; END $$;\n`,
    ),
  ).toEqual([]);
});

it('CT-06d: a constraint recreated as NOT VALID, or with a literal of different case, is a different definition', () => {
  const ctx = {
    schemaSql: '',
    migrationsSql: [
      "ALTER TABLE app.payout_accounts ADD CONSTRAINT payout_accounts_method_check CHECK (payout_method IN ('alipay', 'bank_card'));",
    ],
    approved: false,
  };
  const drop = 'ALTER TABLE app.payout_accounts DROP CONSTRAINT payout_accounts_method_check;\n';
  const add =
    "ALTER TABLE app.payout_accounts ADD CONSTRAINT payout_accounts_method_check CHECK (payout_method IN ('alipay', 'bank_card'))";
  expect(checkMigration('x.sql', `${drop}${add};`, ctx)).toEqual([]);
  for (const changed of [`${add} NOT VALID;`, `${add.replace("'alipay'", "'ALIPAY'")};`]) {
    expect(
      checkMigration('x.sql', drop + changed, ctx).map((p) => p.message),
      changed,
    ).toEqual([expect.stringContaining('recreated with a different definition')]);
  }
});

it('CT-06d: CTAS running set_config still switches a timeout off; a DO body with ALTER COLUMN"x" TYPE is destructive', () => {
  expect(
    checkTimeouts(
      'x.sql',
      `${TIMEOUTS}CREATE TEMP TABLE s AS SELECT set_config('lock_timeout', '0', true) AS v;\n`,
    ),
  ).toEqual([expect.stringContaining('require-lock-timeout')]);
  expect(
    checkMigration(
      'x.sql',
      'DO $$ BEGIN ALTER TABLE app.t ALTER COLUMN"pay_amount_fen" TYPE numeric; END $$;',
    ).map((p) => p.message),
  ).toEqual([expect.stringContaining('destructive DDL inside a DO block')]);
});

it('CT-06d: a column constraint added by an earlier migration (0020) is compared when recreated, not taken for new', () => {
  const dir = join(REPO, 'db/migrations');
  const migrationsSql = readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((n) => readFileSync(join(dir, n), 'utf8'));
  const ctx = {
    schemaSql: readFileSync(join(REPO, 'db/schema.sql'), 'utf8'),
    migrationsSql,
    approved: false,
  };
  const sql =
    "ALTER TABLE app.union_auth_sessions DROP CONSTRAINT union_auth_sessions_client_check;\nALTER TABLE app.union_auth_sessions ADD CONSTRAINT union_auth_sessions_client_check CHECK (client IN ('ios', 'android', 'harmony', 'web')) NOT VALID;";
  expect(checkMigration('0099_x.sql', sql, ctx).map((p) => p.message)).toEqual([
    expect.stringContaining(
      'constraint union_auth_sessions_client_check on funds or attribution table union_auth_sessions recreated with a different definition',
    ),
  ]);
});

it('CT-06d: string literals are compared as written, and EXECUTE of a zero timeout inside DO counts', () => {
  const ctx = {
    schemaSql: '',
    migrationsSql: [
      "CREATE UNIQUE INDEX payout_attempts_inflight_key ON app.payout_attempts (app_id) WHERE status IN ('reserved', 'unknown');",
    ],
    approved: false,
  };
  expect(
    checkMigration(
      'x.sql',
      "DROP INDEX app.payout_attempts_inflight_key;\nCREATE UNIQUE INDEX payout_attempts_inflight_key ON app.payout_attempts (app_id) WHERE status IN ('reserved', 'payout.unknown');",
      ctx,
    ).map((p) => p.message),
  ).toEqual([expect.stringContaining('recreated with a different definition')]);
  expect(
    checkTimeouts(
      'x.sql',
      `${TIMEOUTS}DO $$ BEGIN EXECUTE 'SET LOCAL lock_timeout = 0'; END $$;\n`,
    ),
  ).toEqual([expect.stringContaining('require-lock-timeout')]);
});

it('CT-06d: every constraint on a column is registered from history, each with its own definition', () => {
  const dir = join(REPO, 'db/migrations');
  const migrationsSql = readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((n) => readFileSync(join(dir, n), 'utf8'));
  const migration0020 = readFileSync(join(dir, '0020_union-auth-sessions-issuance.sql'), 'utf8');
  const second =
    /CONSTRAINT (union_auth_sessions_auth_methods_check)\s+(CHECK \([\s\S]*?\)\)?)\s*(?:,|CONSTRAINT|\n\s*ADD)/.exec(
      migration0020,
    );
  expect(second?.[1]).toBe('union_auth_sessions_auth_methods_check');
  // Whatever the regenerated snapshot says, history decides: a weakened recreation is refused.
  const ctx = { schemaSql: '', migrationsSql, approved: false };
  const sql =
    'ALTER TABLE app.union_auth_sessions DROP CONSTRAINT union_auth_sessions_auth_methods_check;\nALTER TABLE app.union_auth_sessions ADD CONSTRAINT union_auth_sessions_auth_methods_check CHECK (true) NOT VALID;';
  expect(checkMigration('0099_x.sql', sql, ctx).map((p) => p.message)).toEqual([
    expect.stringContaining(
      'union_auth_sessions_auth_methods_check on funds or attribution table union_auth_sessions recreated with a different definition',
    ),
  ]);
});

it("CT-06d: EXECUTE '…''0ms''…' inside DO and a quoted TABLESPACE in CTAS are caught", () => {
  expect(
    checkTimeouts(
      'x.sql',
      `${TIMEOUTS}DO $$ BEGIN EXECUTE 'SET LOCAL lock_timeout = ''0ms'';'; END $$;\n`,
    ),
  ).toEqual([expect.stringContaining('require-lock-timeout')]);
  expect(
    checkMigration(
      'x.sql',
      'CREATE TEMP TABLE t ON COMMIT DROP TABLESPACE "pg_default" AS SELECT 1.5 AS amount_fen;',
    ).map((p) => p.message),
  ).toEqual([expect.stringContaining('must be declared as bigint')]);
});

it('CT-06f review round 1: lower-case and nested dollar-quoted EXECUTE, out-of-range code points', () => {
  for (const body of [
    "execute 'SET LOCAL lock_timeout = ''0ms'';'",
    'Execute $sql$SET LOCAL lock_timeout = $$0ms$$$sql$',
  ]) {
    expect(checkTimeouts('x.sql', `${TIMEOUTS}DO $body$ BEGIN ${body}; END $body$;\n`)).toEqual([
      expect.stringContaining('require-lock-timeout'),
    ]);
  }
  for (const value of [String.raw`E'\U00110000'`, String.raw`U&'\+110000'`]) {
    expect(
      checkTimeouts('x.sql', `${TIMEOUTS}SELECT set_config('lock_timeout', ${value}, true);\n`),
    ).toEqual([expect.stringContaining('require-lock-timeout')]);
  }
});

it('CT-06f review round 1: a constraint name binds to the next constraint only, NOT NULL included', () => {
  const messages = (sql: string) =>
    checkMigration('x.sql', TIMEOUTS + sql, {
      schemaSql: '',
      migrationsSql: [],
      approved: false,
    }).map((p) => p.message);
  expect(
    messages(
      'CREATE TABLE app.order_flags (id bigint CONSTRAINT order_flags_id_nn NOT NULL UNIQUE);',
    ),
  ).toEqual([
    expect.stringContaining('unnamed constraint on funds or attribution table order_flags'),
  ]);
  expect(
    messages(
      'CREATE TABLE app.order_flags (id bigint CONSTRAINT order_flags_id_nn NOT NULL CONSTRAINT order_flags_id_key UNIQUE);',
    ),
  ).toEqual([]);
});

it('CT-06f review round 1: unnamed funds-table indexes inside DO, and undecodable DO strings, are refused', () => {
  const messages = (sql: string) =>
    checkMigration('x.sql', TIMEOUTS + sql, {
      schemaSql: '',
      migrationsSql: [],
      approved: false,
    }).map((p) => p.message);
  for (const body of [
    'CREATE INDEX ON app.orders (app_id);',
    "EXECUTE 'CREATE INDEX ON app.orders (app_id)';",
  ]) {
    expect(messages(`DO $$ BEGIN ${body} END $$;`)).toEqual([
      expect.stringContaining('unnamed index on funds or attribution table orders'),
    ]);
  }
  expect(
    messages('DO $$ BEGIN CREATE INDEX orders_app_idx ON app.orders (app_id); END $$;'),
  ).toEqual([]);
  for (const sql of [
    String.raw`DO E'BEGIN \q PERFORM 1; END';`,
    String.raw`DO $$ BEGIN EXECUTE E'\x44ROP TRIGGER guard ON app.orders \q'; END $$;`,
  ]) {
    expect(messages(sql)).toEqual([expect.stringContaining('escape the gate cannot read')]);
  }
});

it('CT-06f review round 1: NOT VALID then VALIDATE recreated twice compares equal both times', () => {
  const rebuild =
    "ALTER TABLE app.orders DROP CONSTRAINT orders_state_check, ADD CONSTRAINT orders_state_check CHECK (state IN ('a', 'b')) NOT VALID;\nALTER TABLE app.orders VALIDATE CONSTRAINT orders_state_check;\n";
  const ctx = {
    schemaSql: '',
    migrationsSql: [
      "CREATE TABLE app.orders (id bigint CONSTRAINT orders_pkey PRIMARY KEY, state text NOT NULL, CONSTRAINT orders_state_check CHECK (state IN ('a', 'b')));",
      TIMEOUTS + rebuild,
    ],
    approved: false,
  };
  expect(checkMigration('x.sql', TIMEOUTS + rebuild, ctx)).toEqual([]);
});

it('CT-06f review round 2: a validated history stays validated, so a rebuild without VALIDATE is a change', () => {
  const add =
    "ALTER TABLE app.order_rights DROP CONSTRAINT order_rights_status_check, ADD CONSTRAINT order_rights_status_check CHECK (status IN ('a', 'b')) NOT VALID;\n";
  const validate = 'ALTER TABLE app.order_rights VALIDATE CONSTRAINT order_rights_status_check;\n';
  const ctx = {
    schemaSql: '',
    migrationsSql: [
      "CREATE TABLE app.order_rights (id bigint CONSTRAINT order_rights_pkey PRIMARY KEY, status text NOT NULL, CONSTRAINT order_rights_status_check CHECK (status IN ('a', 'b')));",
      TIMEOUTS + add + validate,
    ],
    approved: false,
  };
  expect(checkMigration('x.sql', TIMEOUTS + add, ctx).map((p) => p.message)).toEqual([
    expect.stringContaining('recreated with a different definition'),
  ]);
  // VALIDATE before the ADD does not validate the new constraint.
  expect(checkMigration('x.sql', TIMEOUTS + validate + add, ctx).map((p) => p.message)).toEqual([
    expect.stringContaining('recreated with a different definition'),
  ]);
  expect(checkMigration('x.sql', TIMEOUTS + add + validate, ctx)).toEqual([]);
});

it('CT-06f review round 2: a line comment inside an EXECUTE string does not hide what follows it', () => {
  expect(
    checkMigration(
      'x.sql',
      `${TIMEOUTS}DO $$ BEGIN EXECUTE 'SELECT 1 -- ping'; ALTER TABLE app.order_keys DISABLE TRIGGER order_keys_append_only; END $$;\n`,
      { schemaSql: '', migrationsSql: [], approved: false },
    ).map((p) => p.message),
  ).toEqual([expect.stringContaining('guard change inside a DO block')]);
});

it('CT-06f review round 2: octal and hex escapes are UTF-8 bytes when definitions are compared', () => {
  const index = (value: string) =>
    `CREATE INDEX order_rights_src_idx ON app.order_rights (app_id) WHERE source = ${value};`;
  const ctx = {
    schemaSql: '',
    migrationsSql: [index(String.raw`E'\303\251'`)],
    approved: false,
  };
  const rebuild = (value: string) =>
    checkMigration(
      'x.sql',
      `${TIMEOUTS}DROP INDEX app.order_rights_src_idx;\n${index(value)}\n`,
      ctx,
    );
  expect(rebuild("'é'")).toEqual([]);
  expect(rebuild(String.raw`E'\xc3\xa9'`)).toEqual([]);
  expect(rebuild("'Ã©'").map((p) => p.message)).toEqual([
    expect.stringContaining('recreated with a different definition'),
  ]);
});

it('CT-06h: no squawk exception on funds tables, not even for an identical rebuild (CT-06g withdrawn)', () => {
  const history = `${TIMEOUTS}CREATE TABLE app.ledger_x (id bigint CONSTRAINT ledger_x_pkey PRIMARY KEY, amount_fen bigint NOT NULL, CONSTRAINT ledger_x_amount_check CHECK (amount_fen >= 0));\n`;
  const rebuild =
    'ALTER TABLE app.ledger_x DROP CONSTRAINT ledger_x_amount_check, ADD CONSTRAINT ledger_x_amount_check CHECK (amount_fen >= 0);';
  const ok = run(
    fixture({
      '0030_a.sql': history,
      '0031_b.sql': `${TIMEOUTS}-- squawk-ignore constraint-missing-not-valid\n${rebuild}\n`,
    }),
  );
  expect(ok.status).toBe(1);
  expect(ok.stderr).toContain(
    'squawk-ignore on a statement of funds or attribution table ledger_x',
  );
});

it('CT-06g review round 1: a new constraint the regenerated schema already shows gets no squawk exception', () => {
  const history = `${TIMEOUTS}CREATE TABLE app.ledger_x (id bigint CONSTRAINT ledger_x_pkey PRIMARY KEY, amount_fen bigint NOT NULL);\n`;
  const root = fixture({
    '0030_a.sql': history,
    '0031_b.sql': `${TIMEOUTS}-- squawk-ignore constraint-missing-not-valid\nALTER TABLE app.ledger_x DROP CONSTRAINT IF EXISTS ledger_x_cap_check, ADD CONSTRAINT ledger_x_cap_check CHECK ((amount_fen < 100));\n`,
  });
  mkdirSync(join(root, 'db'), { recursive: true });
  writeFileSync(
    join(root, 'db/schema.sql'),
    'CREATE TABLE app.ledger_x (id bigint CONSTRAINT ledger_x_pkey PRIMARY KEY, amount_fen bigint NOT NULL, CONSTRAINT ledger_x_cap_check CHECK ((amount_fen < 100)));\n',
  );
  const res = run(root);
  expect(res.status).toBe(1);
  expect(res.stderr).toContain(
    'squawk-ignore on a statement of funds or attribution table ledger_x',
  );
});

it('CT-06g review round 1: a cast with a length is not a plain literal; NOT inside a CHECK is not the modifier', () => {
  expect(
    checkTimeouts(
      'x.sql',
      `${TIMEOUTS}SELECT set_config('lock_timeout', '0.1s'::varchar(1), true);\n`,
    ),
  ).toEqual([expect.stringContaining('require-lock-timeout')]);
  const ctx = {
    schemaSql: '',
    migrationsSql: [
      'CREATE TABLE app.orders (id bigint CONSTRAINT orders_pkey PRIMARY KEY, valid boolean NOT NULL, CONSTRAINT orders_valid_guard CHECK (NOT valid));',
    ],
    approved: false,
  };
  expect(
    checkMigration(
      'x.sql',
      `${TIMEOUTS}ALTER TABLE app.orders DROP CONSTRAINT orders_valid_guard, ADD CONSTRAINT orders_valid_guard CHECK (NOT valid);\n`,
      ctx,
    ),
  ).toEqual([]);
});

it('CT-06h: identical rebuilds over several lines or as two ALTER TABLE statements get no squawk exception either', () => {
  const history = `${TIMEOUTS}CREATE TABLE app.ledger_x (id bigint CONSTRAINT ledger_x_pkey PRIMARY KEY, amount_fen bigint NOT NULL, CONSTRAINT ledger_x_amount_check CHECK (amount_fen >= 0));\n`;
  for (const body of [
    '-- squawk-ignore constraint-missing-not-valid\nALTER TABLE app.ledger_x\n  DROP CONSTRAINT ledger_x_amount_check,\n  ADD CONSTRAINT ledger_x_amount_check CHECK (amount_fen >= 0);\n',
    'ALTER TABLE app.ledger_x DROP CONSTRAINT ledger_x_amount_check;\n-- squawk-ignore constraint-missing-not-valid\nALTER TABLE app.ledger_x ADD CONSTRAINT ledger_x_amount_check CHECK (amount_fen >= 0);\n',
  ]) {
    const res = run(fixture({ '0030_a.sql': history, '0031_b.sql': TIMEOUTS + body }));
    expect(res.status, res.stdout + res.stderr).toBe(1);
    expect(res.stderr).toContain(
      'squawk-ignore on a statement of funds or attribution table ledger_x',
    );
  }
  // A new constraint over several lines still gets squawk's finding.
  const fresh = run(
    fixture({
      '0030_a.sql': history,
      '0031_b.sql': `${TIMEOUTS}-- squawk-ignore constraint-missing-not-valid\nALTER TABLE app.ledger_x\n  DROP CONSTRAINT IF EXISTS ledger_x_cap_check,\n  ADD CONSTRAINT ledger_x_cap_check CHECK (amount_fen < 100);\n`,
    }),
  );
  expect(fresh.status).toBe(1);
  expect(
    checkMigration(
      'x.sql',
      `${TIMEOUTS}-- squawk-ignore constraint-missing-not-valid\nALTER TABLE app.orders DROP CONSTRAINT IF EXISTS orders_label_guard, ADD CONSTRAINT orders_label_guard CHECK (label <> 'x');\n`,
      {
        schemaSql:
          "CREATE TABLE app.orders (label text, CONSTRAINT orders_label_guard CHECK (label <> 'x'));",
        migrationsSql: [],
        approved: false,
      },
    ).map((p) => p.message),
  ).toEqual([
    expect.stringContaining('squawk-ignore on a statement of funds or attribution table orders'),
  ]);
});

it('CT-06h: column and table constraint forms compare equal, but a changed kind or referenced table is a change', () => {
  const ctx = {
    schemaSql: '',
    migrationsSql: [
      'CREATE TABLE app.accounts (id bigint CONSTRAINT accounts_pkey PRIMARY KEY);\nCREATE TABLE app.payouts_x (id bigint CONSTRAINT payouts_x_pkey PRIMARY KEY);\nCREATE TABLE app.ledger_x (id bigint CONSTRAINT ledger_x_pkey PRIMARY KEY, ref text CONSTRAINT ledger_x_ref_key UNIQUE, account_id bigint CONSTRAINT ledger_x_acct_fkey REFERENCES app.accounts (id));',
    ],
    approved: false,
  };
  const rebuild = (name: string, clause: string) =>
    checkMigration(
      'x.sql',
      `${TIMEOUTS}ALTER TABLE app.ledger_x DROP CONSTRAINT ${name}, ADD CONSTRAINT ${name} ${clause};\n`,
      ctx,
    ).map((p) => p.message);
  expect(rebuild('ledger_x_pkey', 'PRIMARY KEY (id)')).toEqual([]);
  expect(rebuild('ledger_x_ref_key', 'UNIQUE (ref)')).toEqual([]);
  expect(
    rebuild('ledger_x_acct_fkey', 'FOREIGN KEY (account_id) REFERENCES app.accounts (id)'),
  ).toEqual([]);
  const changed = [expect.stringContaining('recreated with a different definition')];
  expect(rebuild('ledger_x_ref_key', 'PRIMARY KEY (ref)')).toEqual(changed);
  expect(
    rebuild('ledger_x_acct_fkey', 'FOREIGN KEY (account_id) REFERENCES app.payouts_x (id)'),
  ).toEqual(changed);
  expect(rebuild('ledger_x_acct_fkey', 'FOREIGN KEY (id) REFERENCES app.accounts (id)')).toEqual(
    changed,
  );
});

it('CT-06j: appeals is a funds table, similar names are not', () => {
  for (const ref of ['appeals', 'app.appeals', '"appeals"', '"app"."appeals"']) {
    expect(isFundsTable(ref), ref).toBe(true);
  }
  for (const ref of ['appeals_archive', 'app.appeals_x', 'user_appeals']) {
    expect(isFundsTable(ref), ref).toBe(false);
  }
});
