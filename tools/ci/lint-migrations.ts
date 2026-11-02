// Migration SQL gate: runs squawk over the migrations added after the gate (CT-06a, 2026-10-07),
// after three checks of its own that squawk cannot express.
// Rules: ADR-0001 §2 "边界与规范" row (squawk); 规划/02 §16.3 "迁移" row (funds tables: no DROP, no
// type change, no RENAME); ADR-0001 §4 (money columns `*_fen` are bigint); db/AGENTS.md rule 11.
// Rule selection lives in /.squawk.toml.
//
// Usage: node tools/ci/lint-migrations.ts [--root <repo dir>] [--squawk <binary>] [--list]
// Exit codes: 0 ok (nothing to lint counts as ok), 1 a check or squawk reported a problem, or a
// migration file name is not NNNN_kebab-name.sql, 2 usage or internal error (squawk missing).
//
// Why a wrapper and not `squawk db/migrations/*.sql`: merged migrations never change (db/AGENTS.md
// rule 2), so the files that predate the gate (0001–0018 and FROZEN_AFTER_BASELINE) are not linted, and squawk exits 1 with
// "Failed to find files" when every path it is given is excluded. The selection is therefore made
// here, and an empty selection passes with a message. The own checks (Codex ledger review of
// rebate-platform#248): a money column typed anything but bigint; a file-level `squawk-ignore-file`;
// a `squawk-ignore` comment on a statement of a funds or attribution table; and both `SET LOCAL`
// timeouts at the top of the file. When an own check fails, squawk is not run (the report would only
// repeat what the gate already refused) and the exit code is 1.
// CT-06b (gaps left by the CT-06a reviews): squawk's report columns are UTF-8 bytes; a timeout of 0,
// DEFAULT or a later RESET does not count; the frozen migrations are checked by exact name and content
// hash (and none may go missing), a new file at or below the baseline and a JS / TS migration are
// refused; destructive DDL inside a DO block, SET SCHEMA on a funds table, a column renamed into a
// money column and money columns made by CREATE TABLE … AS / SELECT … INTO are refused; quoted
// identifiers may touch the next token.
// CT-06c: processed_events and idempotency_keys join the funds tables; triggers, constraints and
// indexes of a funds table may not be dropped or disabled unless the same migration recreates the same
// name; DROP … CASCADE is refused; the functions that funds-table triggers execute may not be dropped,
// replaced, renamed, re-owned or moved.
// CT-06d: a change to the definition of a funds-table guard (a replaced guard function, a trigger,
// constraint or index recreated differently) needs the migration listed in APPROVED_GUARD_CHANGES;
// funds-table objects are not renamed and triggers not set to REPLICA; the remaining ways to switch a
// timeout off, DO blocks with a string body, the narrower ALTER … TYPE inside DO, SELECT … INTO by the
// statement head, CTAS clauses before AS, more script extensions.
// CT-06f: funds-table constraints and indexes must be named; NOT VALID followed by VALIDATE on the
// same table compares as validated; literals are decoded as PostgreSQL reads them (E'…', U&'…',
// dollar quotes; unknown escapes count as switching a timeout off); guard changes inside DO blocks are
// refused; set_config anywhere in a statement.
// CT-06g / CT-06h: set_config values must be plain string literals (a $1 parameter or a cast with a
// length counts as off); NOT VALID is stripped only at the top level; the UTF-8 BOM is kept; dollar-
// quoted literals compare by their text; column and table constraint forms compare equal. No squawk
// exception on funds tables: any direct constraint rebuild holds ACCESS EXCLUSIVE and needs approval.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const MIGRATIONS_DIR = 'db/migrations';
export const CONFIG_FILE = '.squawk.toml';
/** Highest migration number merged before the gate. Everything above it is linted. Never raise it. */
export const GATE_BASELINE = 18;
/**
 * Migrations above the baseline that were merged before the gate itself (db/AGENTS.md rule 2: merged
 * migrations never change), by exact file name. Only ever extended by the PR that lands the gate.
 */
export const FROZEN_AFTER_BASELINE: readonly string[] = [
  '0019_device-registrations-created-at-insert.sql', // B1-02n (#233), merged while CT-06a was in review
];
/**
 * Every migration merged before the gate, by exact file name, with the sha256 of its content
 * (db/AGENTS.md rule 2: merged migrations never change). A change, a missing file or a new file at or
 * below GATE_BASELINE is refused (CT-06b).
 */
export const FROZEN_MIGRATIONS: Readonly<Record<string, string>> = {
  '0001_app-schema.sql': '5b94c1466b3dd8ddfdf1005435e7f154f6a4641598069cf47080a4bea3dfb968',
  '0002_pgboss-schema-v42.sql': '4ff98aa1378add7f31e8bd85d212a76462c6bb7b141e5c396ef24f59b1650bf6',
  '0003_platform-baseline.sql': '2d6c36579af887428524baf1ac08d42483d42626f80a5b8aafc0207370181933',
  '0004_idempotency-keys-abandoned.sql':
    'b26c83f90724836fcd9a8b8c4bd73859550a023d0166af2ccf74a6ebbcd26b0b',
  '0005_identity-baseline.sql': 'cc428179b775278d9a1cb7aca3263fe1397c229fe274fb02e282f08bdd5c7b78',
  '0006_linking-baseline.sql': 'a4fb56c80fa2f89f5810618d4e90fa9c5bbe62d4775a6d8d4fcbd927f7a97429',
  '0007_orders-baseline.sql': '49b37465da78d20df6880a71a8433e98cea18a8f1b57fa6f460be31a6b036db9',
  '0008_notification-baseline.sql':
    '3c63b9ad94f58b458b4a065c4da1ac19633d86950196fc7ae75c978620ad0e35',
  '0009_payout-account-baseline.sql':
    '91952c0d5d20037b47c06d64ff834dfd348752093d626207e5a61f784e53efaf',
  '0010_content-config-baseline.sql':
    '309a9507b21c94c45df2820dc816354024c2cb5151e5a725b2223c8c160874a6',
  '0011_partition-maintenance.sql':
    'f723cfdfb070802a5e46a45499808fbbbfad589cb225f952b2a0e104d0491a70',
  '0012_link-logs-day-partitions.sql':
    '851f96266e8d6536954df0a863c34690d82667017635dfebdb9be3c67e363d73',
  '0013_identity-sessions.sql': '47b52083c585905b046aa234912bec0b0f9d2b60e7c959cc7752c7e576becf37',
  '0014_risk-baseline.sql': '64edb5e276763b034509898b3f793be965e000b94f4f9f0348d33afb97f2529f',
  '0015_union-accounts-pids.sql':
    'cf80deafa59a2da24f75d85791e74f77524982ac994add30ba2d6d681a6c8333',
  '0016_admin-baseline.sql': 'c3e5ace3d71914d83a65d0428a665a137c7055be9fd1f891279b10e953794db0',
  '0017_catalog-baseline.sql': '88a6afda2b64ef7f3b30a8dd9149da31de8d1d0c4454fa9dfb6e7a3090b85f8c',
  '0018_linking-bindings.sql': '8f4cf8b044cbb2e3f3b0de45a9cf75783d99692f82df3a0207f6339a6ae9a675',
  '0019_device-registrations-created-at-insert.sql':
    '93bac397c2fe2d47b23b414bfaa1b5c8bb5aaa1764090f0e2d3a867e73ebd0d0',
};
/**
 * Migrations allowed to change the definition of a funds-table guard (CT-06d): file name → sha256 of
 * the content. A guard function replaced with CREATE OR REPLACE, or a funds-table trigger, constraint
 * or index recreated with a different definition, is refused unless its migration is listed here.
 * This file is a class-3 protected path: adding an entry takes the two reviews and the approval label.
 */
export const APPROVED_GUARD_CHANGES: Readonly<Record<string, string>> = {
  // B1-06r (#260 era): extends the union_auth_sessions guard to the new issuance columns.
  '0020_union-auth-sessions-issuance.sql':
    'f976192657be50f146f3dfdc6d4c50d58e9646e9c18319c43a185d14c675ca15',
  // CT-25d (#161, BR-INV-24 eligibility period; orchestrator ruling D10-98 1): rebuilds the
  // invite_rewards status constraint NOT VALID with expired in place of budget_exhausted (validated
  // in 0058); Codex money review and Claude review passed. F1-02zy.
  '0057_invite-rewards-eligibility.sql':
    '261a84f2a55dc9e8a65866c6767573d5de027c6bbe4cea3aee6ca3045e41ec89',
  // B1-22a (BR-ID-24; 12 §9 T-05): rebuilds union_accounts_alert_stage_check NOT VALID with
  // none / expired / d<N> (N 1–999) in place of the five fixed stages (validated in 0072); Codex money
  // review passed. B1-22e.
  '0071_union-alert-stages.sql': 'b1aafb940438ea1d5a49722e1e759e14beffa9b46a889ca9fda978e790045a22',
  // B1-15r (D10-186 deletion anonymization): rebuilds payout_accounts_details_check on the funds table
  // payout_accounts NOT VALID under the same name with two branches (not anonymized: the original
  // condition; anonymized: identifying columns all null and is_current = false), validated in 0078;
  // money review (independent Claude / Codex r1) passed. B1-15t.
  '0077_deletion-anonymize.sql': 'd933bc024716bc1fcaa2ac7c7c1bfe9537f76d64225e0effff95d37e6a238113',
  // B2-15h (pay lane, orchestrator ruling D10-168 ①): B2-15i's 0081 rebuilds ledger_entries_ledger_type_check
  // (+ PAY_RECEIPT / PAY_REFUND / PAY_ANOMALY / PAY_FEE, BR-PAY-07 pay_ledger_type) and recon_diffs_type_check
  // (+ pay_mismatch / pay_anomaly, R4) under the same names, NOT VALID; 0082 validates them (two-stage,
  // precedent 0079 / 0080). Both only widen.
  '0081_ledger-type-pay.sql': 'e0a4df6555607577c01ec7624a30c3d7bef544098783204329ffe8a01705cf2e',
  // B2-15e (pay lane, orchestrator rulings D10-350 / D10-351 ②, registered by D10-352): rebuilds
  // pay_refunds_idempotency_key_key on the funds table pay_refunds under the same name as
  // UNIQUE (app_id, operator, idempotency_key) (unique index first, then UNIQUE USING INDEX); it only
  // widens: a row unique on (app_id, idempotency_key) stays unique on the three columns. The same
  // migration adds the nullable note column. Money review (independent Claude) passed.
  '0088_pay-refunds-note-idempotency-operator.sql':
    '8d75300755329c8ebbb06fbf10988279df06958406e0c159ca877cdf54638a82',
  // B2-04rb (funds lane, orchestrator ruling D10-280 ①, registered by B2-04rc): rebuilds
  // settle_jobs_job_check on the funds table settle_jobs NOT VALID under the same name with the 0066
  // values plus 'supplement'; it only widens. Validated in 0097. Money review (independent Claude)
  // passed.
  '0096_settle-jobs-supplement.sql':
    'c4451a18cdbac3cd286d2d55fa0322df92c05b8252e53497bb276145e90d189d',
  // B1-04zv (D10-570, FU-ORDER-ROW-QUARANTINE): rebuilds order_sync_pending_reason_check on the
  // attribution table order_sync_pending NOT VALID under the same name with the 0035 values plus
  // ORDER_ROW_INVALID; it only widens. Validated in 0120.
  '0119_order-sync-pending-row-invalid.sql':
    'f7a549c012b28c7aad6e682194ef8a9b4b978d7ee2088aa70cb6eab6c40abf98',
};
/** Extensions node-pg-migrate would run from db/migrations besides SQL. */
const SCRIPT_MIGRATION = /\.(?:js|cjs|mjs|ts|cts|mts|jsx|tsx)$/;
/** db/AGENTS.md rule 1: four-digit sequence, a dash-separated lowercase name, `.sql`. */
const MIGRATION_FILE = /^(\d{4})_[a-z0-9][a-z0-9-]*\.sql$/;

/**
 * Funds and attribution tables (规划/02 §16.3; the modules of MONEY_PATHS in tools/ci/evidence-check.ts):
 * orders, ledger, accounts, withdrawals, payouts, settlement, commission, reconciliation, adjustments,
 * vouchers and entries, balances, union accounts / credentials / pids / bindings, links and link logs.
 * Matched by prefix on the bare table name (schema and quotes removed). Extend only through a
 * guard-change task.
 */
export const FUNDS_TABLE_PREFIXES: readonly string[] = [
  'order',
  'ledger',
  'account',
  'withdraw',
  'payout',
  'settle',
  'commission',
  'reconcil',
  'adjust',
  'voucher',
  'entries',
  'balance',
  'union_',
  'link_',
  // pay_: the payment module's tables (pay_orders, pay_refunds, pay_anomalies, pay_notifications,
  // pay_query_attempts; 规划/04 §3.2, BR-PAY-02 / 04 / 05 / 06). `payout` above does not match them;
  // the underscore keeps payout_* on its own prefix (B2-15g).
  'pay_',
];
// processed_events (consumer dedupe) and idempotency_keys (write idempotency, withdrawals included):
// 规划/04 §3.2; CT-06c.
export const FUNDS_TABLE_NAMES: readonly string[] = [
  'links',
  'processed_events',
  'idempotency_keys',
  // appeals: an appeal closed as revoked raises the BR-FUND-22 appeal-restore error ticket (CT-06j).
  'appeals',
  // Ledger and settlement tables whose names no prefix above matches (B2-02b, couli-runs ledger plan D17):
  // daily balances and asset snapshots (BR-FUND-19), bad-debt write-offs, manual adjustments
  // (BR-FUND-24), reconciliation diff tickets (BR-FUND-20 / BR-WDR-23) and the fund ledger view.
  'daily_balances',
  'asset_snapshots',
  'bad_debt_writeoffs',
  'admin_adjustments',
  'recon_diffs',
  'fund_ledger',
  // Invite reward grants and their budget counters (CT-25b migration 0055, BR-INV-24; orchestrator
  // ruling D10-94 5): amounts in fen, no prefix above matches.
  'invite_rewards',
  'invite_reward_budgets',
  // Yearly withholding ledger of withdrawals (B2-08a migration, 08 BR-WDR-20; 规划/04 §3.2 tax_ytd):
  // amounts in fen, no prefix above matches tax_.
  'tax_ytd',
  // Settlement tables whose names no prefix above matches (B2-04c, couli-runs settlement plan D10-93;
  // `reconcil` does not match recon_union): beneficiary credit obligations and union reconciliation.
  'beneficiary_credits',
  'recon_union',
  // R2 channel reconciliation detail rows (B2-07a, BR-WDR-23; D10-411): both sides' amounts in fen,
  // and `reconcil` does not match recon_channel.
  'recon_channel',
  // Per-platform union receivable of an asset snapshot (B2-04b child table, decision 40).
  'asset_snapshot_receivables',
];

/** Column types a money column (`*_fen`) may have (ADR-0001 §4: integer fen in bigint); anything else is refused. */
const MONEY_TYPES_OK = new Set(['bigint', 'int8']);
/** A `*_fen` column name at the start of a column definition or ALTER TABLE subcommand, and the text after it. */
// A quoted name may touch the next token (`"amount_fen"integer`); a bare one needs whitespace.
const FEN_NAME = String.raw`(?:\s*"([a-z0-9_]+_fen)"\s*|\s+([a-z0-9_]+_fen)\s+)`;
const MONEY_COLUMN_DEF = new RegExp(
  String.raw`^(?:\s*"([a-z0-9_]+_fen)"\s*|\s*([a-z0-9_]+_fen)\s+)([\s\S]*)$`,
  'i',
);
const MONEY_COLUMN_ADD = new RegExp(
  String.raw`^\s*ADD(?:\s+COLUMN\b)?(?:\s+IF\s+NOT\s+EXISTS\b)?${FEN_NAME}([\s\S]*)$`,
  'i',
);
const MONEY_COLUMN_ALTER = new RegExp(
  String.raw`^\s*ALTER(?:\s+COLUMN\b)?${FEN_NAME}(?:SET\s+DATA\s+)?TYPE(?:\s+|(?="))([\s\S]*)$`,
  'i',
);
/** The type name at the start of a column type: optional pg_catalog qualifier, quoted or bare first word, and what follows. */
const TYPE_HEAD = /^(?:"?pg_catalog"?\s*\.\s*)?(?:"([^"]+)"|([a-z_][a-z0-9_]*))([\s\S]*)$/i;
/** `SET [LOCAL | SESSION] lock_timeout | statement_timeout = | TO <value>`. */
const TIMEOUT_SET =
  /^SET\s+(?:LOCAL\s+|SESSION\s+)?"?(lock_timeout|statement_timeout)"?\s*(?:=|\bTO\b)\s*([\s\S]*)$/i;
const TIMEOUT_RESET = /^RESET\s+"?(lock_timeout|statement_timeout|ALL)"?\s*$/i;
/** The same inside a DO body, where the statement follows BEGIN, THEN and the like. */
const TIMEOUT_SET_IN =
  /\bSET\s+(?:LOCAL\s+|SESSION\s+)?"?(lock_timeout|statement_timeout)"?\s*(?:=|\bTO\b)\s*([^;]*?)\s*$/i;
const TIMEOUT_RESET_IN = /\bRESET\s+"?(lock_timeout|statement_timeout|ALL)"?(?![\w"])/i;
/** `set_config('lock_timeout' | 'statement_timeout', <value>, …)` anywhere in a statement. */
const TIMEOUT_SET_CONFIG =
  /(?<![\w"])(?:"?pg_catalog"?\s*\.\s*)?"?set_config"?\s*\(\s*(?:E|U&)?'"?(lock_timeout|statement_timeout)"?'\s*,\s*([Ee]'(?:[^'\\]|''|\\[\s\S])*'|[Uu]&'(?:[^']|'')*'(?:\s*UESCAPE\s*'[^']')?|'(?:[^']|'')*'|(?<dq>\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)[\s\S]*?\k<dq>|[^,)]*)/gi;
/** Milliseconds per unit of a timeout value (no unit means milliseconds). */
const TIMEOUT_UNITS: Readonly<Record<string, number>> = {
  us: 0.001,
  ms: 1,
  s: 1000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
// Matched anywhere in the file, not only right after `--` or the comment opener: squawk strips the
// whitespace (newlines included) inside a block comment before it reads the directive, so a
// directive on its own line inside a block comment counts. Erring towards refusal is fine here.
const IGNORE_FILE = /squawk-ignore-file\b/;
// `squawk-ignore …` as a line comment or inside a block comment: squawk honours both forms.
const IGNORE_ANY = /squawk-ignore\b(?!-file)/g;
/** Identifiers that name a table in a DDL statement: after TABLE, ON (indexes, triggers) and TRUNCATE. */
const IDENT = String.raw`"?[\w]+"?(?:\s*\.\s*"?[\w]+"?)?`;
/** Whitespace, or nothing before a quoted identifier (`DROP TABLE"app"."orders"`). */
const GAP = String.raw`(?:\s+|(?="))`;
/** Table names in a DDL statement: after TABLE / ON / TRUNCATE, past IF [NOT] EXISTS and ONLY, including a comma list (`DROP TABLE a, b`). */
/** `ALTER TABLE [IF EXISTS] [ONLY] <table>` at the start of a statement; group 1 is the table. */
const ALTER_TABLE = new RegExp(
  String.raw`^\s*ALTER\s+TABLE${GAP}(?:IF\s+EXISTS${GAP})?(?:ONLY${GAP})?(${IDENT})\s*\*?`,
  'i',
);
/** `CREATE [GLOBAL|LOCAL] [TEMP|UNLOGGED] TABLE [IF NOT EXISTS] <t> [(cols)] [WITH (…)] [TABLESPACE x] AS …`. */
const CREATE_TABLE_AS = new RegExp(
  String.raw`^\s*CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE${GAP}(?:IF\s+NOT\s+EXISTS${GAP})?${IDENT}\s*(?:\([^()]*\)\s*)?(?:USING\s+\w+\s*)?(?:WITH\s*\([^()]*\)\s*|WITHOUT\s+OIDS\s*)?(?:ON\s+COMMIT\s+(?:DROP|DELETE\s+ROWS|PRESERVE\s+ROWS)\s*)?(?:TABLESPACE${GAP}${IDENT}\s*)?AS\b`,
  'i',
);
const TABLE_REF = new RegExp(
  String.raw`\b(?:TABLE|ON|TRUNCATE(?:\s+TABLE)?)${GAP}(?:IF\s+(?:NOT\s+)?EXISTS${GAP})?(?:ONLY${GAP})?(${IDENT}(?:\s*,\s*${IDENT})*)`,
  'gi',
);

export type Selection = { lint: string[]; badNames: string[] };
export type Problem = { file: string; line: number; message: string };
/** What a migration is checked against: db/schema.sql and the SQL of the migrations before it. */
export type MigrationContext = {
  schemaSql: string;
  migrationsSql: readonly string[];
  /**
   * Whether the migration is listed in APPROVED_GUARD_CHANGES. The CLI always sets it; false applies
   * the strict rules, true lets guard changes through, left out keeps the CT-06c rules.
   */
  approved?: boolean;
};
const NO_CONTEXT: MigrationContext = { schemaSql: '', migrationsSql: [] };

/** Splits the `.sql` entries of db/migrations into the files to lint and the misnamed ones. */
export function selectMigrations(names: readonly string[], baseline = GATE_BASELINE): Selection {
  const lint: string[] = [];
  const badNames: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.sql')) continue;
    const match = MIGRATION_FILE.exec(name);
    if (match === null) {
      badNames.push(name);
      continue;
    }
    if (Number(match[1]) > baseline && !FROZEN_AFTER_BASELINE.includes(name)) lint.push(name);
  }
  lint.sort();
  badNames.sort();
  return { lint, badNames };
}

/** The table name without schema and quotes, lower-cased. */
export function bareTableName(reference: string): string {
  return reference.replace(/"/g, '').split('.').pop()?.trim().toLowerCase() ?? '';
}

/**
 * The funds table an index name points to when its owner is unknown (CT-06d): a funds table name it
 * starts with followed by `_` (idempotency_keys_wrap_idx → idempotency_keys), or a funds prefix.
 */
function fundsTableOfIndexName(name: string): string | undefined {
  const exact = FUNDS_TABLE_NAMES.find((t) => name.startsWith(`${t}_`));
  if (exact !== undefined) return exact;
  return isFundsTable(name) ? name : undefined;
}

export function isFundsTable(reference: string): boolean {
  const bare = bareTableName(reference);
  return FUNDS_TABLE_NAMES.includes(bare) || FUNDS_TABLE_PREFIXES.some((p) => bare.startsWith(p));
}

/**
 * db/AGENTS.md rule 11: every new migration sets both timeouts (`SET LOCAL lock_timeout`,
 * `SET LOCAL statement_timeout`). squawk's require-*-timeout rules only fire before statements it
 * considers slow, so a migration that only creates tables would pass them without any timeout; the
 * gate requires the two statements regardless. Reported in squawk's gcc format under the rule names.
 */
/**
 * Whether a set_config call keeps its timeout on (CT-06g): the value must be one string literal,
 * optionally cast to a text type, and nothing else up to the next argument or the closing
 * parenthesis; NULL, a function call, a column, an operator or a subquery could be 0 and counts as off.
 */
function setConfigKeeps(text: string, m: RegExpMatchArray): boolean {
  const value = (m[2] ?? '').trim();
  if (!/^(?:[EeUu]&?'|'|\$)/.test(value)) return false;
  // A value starting with $ must be a whole dollar-quoted literal: $1 is a parameter (CT-06h).
  if (value.startsWith('$') && !/^(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)[\s\S]*\1$/.test(value))
    return false;
  const after = text.slice((m.index ?? 0) + m[0].length);
  if (
    !/^\s*(?:::\s*(?:"?pg_catalog"?\s*\.\s*)?"?(?:text|varchar|character\s+varying|name)"?\s*)?[,)]/i.test(
      after,
    )
  )
    return false;
  return timeoutMilliseconds(value) > 0;
}

export function checkTimeouts(file: string, sql: string): string[] {
  // Both settings must be set to more than 0 before the first statement that is not a SET (a timeout
  // set after the DDL does not protect it), and nothing later in the file may RESET them or set them
  // back to 0 / DEFAULT. Comments are ignored; the value is read with its string quotes.
  const code = withoutComments(sql);
  const valued = withoutComments(sql, true);
  let lock = false;
  let statement = false;
  let lockLost = false;
  let statementLost = false;
  let header = true;
  let start = 0;
  for (const part of code.split(';')) {
    const text = part.trim();
    const value = valued.slice(start, start + part.length).trim();
    start += part.length + 1;
    if (text === '') continue;
    const set = TIMEOUT_SET.exec(value);
    const reset = TIMEOUT_RESET.exec(text);
    if (set !== null) {
      // A timeout set to 0 / DEFAULT anywhere in the file (before or after the real one) disables it.
      const on = timeoutMilliseconds(set[2] ?? '') > 0;
      const isLock = (set[1] ?? '').toLowerCase() === 'lock_timeout';
      if (!on) {
        if (isLock) lockLost = true;
        else statementLost = true;
      } else if (header) {
        if (isLock) lock = true;
        else statement = true;
      }
    } else if (reset !== null) {
      // RESET anywhere in the file, before or after the SET, disables the setting.
      const what = (reset[1] ?? '').toLowerCase();
      if (what !== 'statement_timeout') lockLost = true;
      if (what !== 'lock_timeout') statementLost = true;
    } else if (!/^SET\b/i.test(text)) {
      header = false;
    }
    // set_config(…) in a top-level statement switches a timeout off just as well. DO blocks are
    // scanned below with their own comments removed; function bodies do not run at migration time.
    if (
      /^\s*DO\b/i.test(text) ||
      /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE|(?:CONSTRAINT\s+)?TRIGGER)\b/i.test(
        text,
      )
    )
      continue;
    for (const m of value.matchAll(TIMEOUT_SET_CONFIG)) {
      if (setConfigKeeps(value, m)) continue;
      if ((m[1] ?? '').toLowerCase() === 'lock_timeout') lockLost = true;
      else statementLost = true;
    }
  }
  // Inside DO blocks: SET / RESET of a timeout to 0, DEFAULT or its default count too.
  for (const { body: raw } of doBodies(code, valued)) {
    // EXECUTE 'SET LOCAL lock_timeout = ''0ms'';' runs the decoded string: check that instead.
    const body = decodeExecutes(raw);
    const blanked = withoutComments(body);
    const kept = withoutComments(body, true);
    let offset = 0;
    for (const part of blanked.split(';')) {
      const raw = kept.slice(offset, offset + part.length).trim();
      offset += part.length + 1;
      // Statements inside a body follow BEGIN, IF … THEN and the like: search, do not anchor.
      const set = TIMEOUT_SET_IN.exec(raw);
      const reset = TIMEOUT_RESET_IN.exec(raw);
      // EXECUTE 'SET LOCAL lock_timeout = 0' leaves the closing quote of the EXECUTE string behind.
      const setValue = (set?.[2] ?? '').replace(/^([^']*)'\s*$/, '$1');
      if (set !== null && timeoutMilliseconds(setValue) <= 0) {
        if ((set[1] ?? '').toLowerCase() === 'lock_timeout') lockLost = true;
        else statementLost = true;
      } else if (reset !== null) {
        const what = (reset[1] ?? '').toLowerCase();
        if (what !== 'statement_timeout') lockLost = true;
        if (what !== 'lock_timeout') statementLost = true;
      }
    }
    const keptBody = withoutComments(body, true);
    for (const m of keptBody.matchAll(TIMEOUT_SET_CONFIG)) {
      if (setConfigKeeps(keptBody, m)) continue;
      if ((m[1] ?? '').toLowerCase() === 'lock_timeout') lockLost = true;
      else statementLost = true;
    }
  }
  if (lockLost) lock = false;
  if (statementLost) statement = false;
  const lines: string[] = [];
  if (!lock) {
    lines.push(
      `${file}:1:0: warning: require-lock-timeout Missing \`SET LOCAL lock_timeout\` at the top of the migration (db/AGENTS.md rule 11)`,
    );
  }
  if (!statement) {
    lines.push(
      `${file}:1:0: warning: require-statement-timeout Missing \`SET LOCAL statement_timeout\` at the top of the migration (db/AGENTS.md rule 11)`,
    );
  }
  return lines;
}

/**
 * A timeout value in milliseconds as PostgreSQL reads it (rounded to whole milliseconds); 0 for 0,
 * DEFAULT or anything below half a millisecond. A value it cannot read counts as set (squawk and the
 * database will judge it).
 */
function timeoutMilliseconds(raw: string): number {
  const literal = raw.trim();
  // A literal is read as PostgreSQL reads it; an escape this gate does not know counts as off (CT-06f).
  const decoded = /^(?:[EeUu]&?'|'|\$)/.test(literal) ? decodeLiteral(literal) : literal;
  if (decoded === null) return 0;
  const text = decoded.trim();
  if (/^DEFAULT$/i.test(text) || text === '') return 0;
  const m = /^(\d*\.?\d+)\s*(us|ms|s|min|h|d)?$/i.exec(text);
  if (m === null) return Number.POSITIVE_INFINITY;
  return roundHalfEven(Number(m[1]) * (TIMEOUT_UNITS[(m[2] ?? 'ms').toLowerCase()] ?? 1));
}

/** PostgreSQL rounds a fractional integer setting with rint(): halves go to the even neighbour (0.5 → 0). */
function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (Math.abs(diff - 0.5) < 1e-9) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(x);
}

/**
 * The bodies of the DO blocks of a file, with their offsets: dollar-quoted (`DO $tag$ … $tag$`) and
 * plain string bodies (`DO '…'`, `DO E'…'`, doubled quotes undone), each optionally with LANGUAGE.
 * `code` has comments and string contents blanked, `valued` only the comments, at the same offsets.
 */
function doBodies(
  code: string,
  valued: string,
): { at: number; body: string; unreadable?: boolean }[] {
  const out: { at: number; body: string; unreadable?: boolean }[] = [];
  const dollar = /\bDO\s+(?:LANGUAGE\s+\w+\s+)?(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/gi;
  for (const m of code.matchAll(dollar)) {
    const tag = m[1] ?? '$$';
    const open = (m.index ?? 0) + m[0].length;
    const close = code.indexOf(tag, open);
    out.push({
      at: m.index ?? 0,
      body: valued.slice(open, close === -1 ? code.length : close),
    });
  }
  const quoted = /\bDO\s+(?:LANGUAGE\s+\w+\s+)?(E|U&)?'/gi;
  for (const m of code.matchAll(quoted)) {
    const open = (m.index ?? 0) + m[0].length;
    const close = code.indexOf("'", open);
    const raw = valued.slice(open, close === -1 ? code.length : close);
    // The body is read as PostgreSQL reads the literal (E'…' and U&'…' escapes, CT-06f); a body with
    // an escape this gate does not know is kept undecoded.
    const uescape =
      close === -1 ? '' : (/^\s*UESCAPE\s*'[^']'/i.exec(valued.slice(close + 1))?.[0] ?? '');
    const decoded = decodeLiteral(`${m[1] ?? ''}'${raw}'${uescape}`);
    out.push({
      at: m.index ?? 0,
      body: decoded ?? raw.replace(/''/g, "'"),
      ...(decoded === null ? { unreadable: true } : {}),
    });
  }
  return out;
}

/**
 * SQL with comments and the contents of string literals ('…', E'…', $tag$…$tag$) blanked to spaces:
 * same length, same line breaks, quotes and quoted identifiers kept. So a `;`, `--` or `(` inside a
 * string neither ends a statement nor starts a comment, and comment text is never read as SQL. With
 * keepStrings the string contents stay (comments are still blanked): values and DO block bodies.
 */
function withoutComments(sql: string, keepStrings = false): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (sql.startsWith('--', i)) {
      const j = sql.indexOf('\n', i);
      const end = j === -1 ? sql.length : j;
      out += blank(sql.slice(i, end));
      i = end;
    } else if (sql.startsWith('/*', i)) {
      // Block comments nest in PostgreSQL.
      let depth = 0;
      let j = i;
      while (j < sql.length) {
        if (sql.startsWith('/*', j)) {
          depth++;
          j += 2;
        } else if (sql.startsWith('*/', j)) {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else j++;
      }
      out += blank(sql.slice(i, j));
      i = j;
    } else if (c === "'") {
      const escapes = /e/i.test(sql[i - 1] ?? '') && !/\w/.test(sql[i - 2] ?? '');
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      const closed = j < sql.length;
      const body = sql.slice(i + 1, Math.min(j, sql.length));
      out += `'${keepStrings ? body : blank(body)}${closed ? "'" : ''}`;
      i = closed ? j + 1 : sql.length;
    } else if (c === '"') {
      // Quoted identifiers are kept (table names are read from them); a `;` inside one is blanked.
      const j = sql.indexOf('"', i + 1);
      const end = j === -1 ? sql.length : j + 1;
      out += sql.slice(i, end).replace(/;/g, ' ');
      i = end;
    } else if (c === '$' && !/[\w$]/.test(sql[i - 1] ?? '')) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag === undefined) {
        out += c;
        i++;
        continue;
      }
      const j = sql.indexOf(tag, i + tag.length);
      const end = j === -1 ? sql.length : j + tag.length;
      const body = sql.slice(i + tag.length, j === -1 ? sql.length : j);
      out += tag + (keepStrings ? body : blank(body)) + (j === -1 ? '' : tag);
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Splits `text` at the commas outside parentheses, from `from` up to `to` (stops early when the depth goes below 0). */
function topLevelParts(text: string, from: number, to: number): { start: number; text: string }[] {
  const parts: { start: number; text: string }[] = [];
  let depth = 0;
  let start = from;
  let i = from;
  for (; i < to; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) break;
      depth--;
    } else if (c === ',' && depth === 0) {
      parts.push({ start, text: text.slice(start, i) });
      start = i + 1;
    }
  }
  parts.push({ start, text: text.slice(start, i) });
  return parts;
}

/** The money-column definitions of one statement: name, the text after it, and their offset in the statement. */
function moneyColumns(statement: string): { name: string; rest: string; at: number }[] {
  const found: { name: string; rest: string; at: number }[] = [];
  const at = (part: { start: number; text: string }): number =>
    part.start + part.text.length - part.text.trimStart().length;
  if (
    /^\s*CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\b/i.test(
      statement,
    )
  ) {
    const open = statement.indexOf('(');
    if (open === -1) return found;
    for (const part of topLevelParts(statement, open + 1, statement.length)) {
      const m = MONEY_COLUMN_DEF.exec(part.text);
      if (m !== null)
        found.push({
          name: m[1] ?? m[2] ?? '',
          rest: m[3] ?? '',
          at: at(part),
        });
    }
    return found;
  }
  const alter = ALTER_TABLE.exec(statement);
  if (alter === null) return found;
  for (const part of topLevelParts(statement, alter[0].length, statement.length)) {
    const m = MONEY_COLUMN_ADD.exec(part.text) ?? MONEY_COLUMN_ALTER.exec(part.text);
    if (m !== null) found.push({ name: m[1] ?? m[2] ?? '', rest: m[3] ?? '', at: at(part) });
  }
  return found;
}

/** The declared type of a money column when it is not bigint / int8 (arrays included), else null. */
function badMoneyType(rest: string): string | null {
  const m = TYPE_HEAD.exec(rest.trimStart());
  if (m === null) return rest.trim().split(/\s+/)[0] ?? '?';
  const name = (m[1] ?? m[2] ?? '').toLowerCase();
  const array = /^\s*(?:\[|ARRAY\b)/i.test(m[3] ?? '');
  // `int8.fen` is a type `fen` in a schema named int8, not int8.
  if (/^\s*\./.test(m[3] ?? '')) return `${name}${(m[3] ?? '').trim().split(/[\s(]/)[0] ?? ''}`;
  return MONEY_TYPES_OK.has(name) && !array ? null : `${name}${array ? '[]' : ''}`;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** One SQL string literal token: E'…' (backslash escapes), U&'…' [UESCAPE 'c'], '…' or $tag$…$tag$. */
const LITERAL_SRC = String.raw`[Ee]'(?:[^'\\]|''|\\[\s\S])*'|[Uu]&'(?:[^']|'')*'(?:\s*UESCAPE\s*'[^']')?|'(?:[^']|'')*'|(?<dq>\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)[\s\S]*?\k<dq>`;

/**
 * A constraint definition without its NOT VALID modifier (CT-06g): only the top level is touched, so
 * CHECK (label <> 'not valid') keeps its literal and CHECK (NOT valid) its expression.
 */
function withoutNotValid(definition: string): string {
  // Only the modifier at the top level counts: string literals, quoted identifiers and parenthesised
  // expressions (CHECK (NOT valid)) are masked before searching (same offsets).
  let mask = definition.replace(new RegExp(LITERAL_SRC, 'g'), (m) => ' '.repeat(m.length));
  mask = mask.replace(/"(?:[^"]|"")*"/g, (m) => ' '.repeat(m.length));
  mask = flattenParens(mask);
  let out = '';
  let last = 0;
  for (const m of mask.matchAll(/\bnot\s+valid\b/gi)) {
    out += definition.slice(last, m.index).replace(/\s+$/, '');
    last = (m.index ?? 0) + m[0].length;
  }
  return out + definition.slice(last);
}

/** The character of a code point, or null outside Unicode (PostgreSQL rejects it). */
function codePoint(n: number): string | null {
  return n > 0x10ffff ? null : String.fromCodePoint(n);
}

/**
 * The value of a SQL string literal as PostgreSQL reads it (CT-06f): plain '…', E'…' with every
 * backslash escape PostgreSQL knows (\' \\ \b \f \n \r \t, \ooo, \xhh, \uXXXX, \UXXXXXXXX), U&'…' with
 * \XXXX and \+XXXXXX (or the UESCAPE character), and $tag$…$tag$. null when the literal holds an escape
 * this gate does not know — callers treat that conservatively. Text that is not a literal is returned as is.
 */
export function decodeLiteral(token: string): string | null {
  const t = token.trim();
  const dollar = /^(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)([\s\S]*)\1$/.exec(t);
  if (dollar !== null) return dollar[2] ?? '';
  const uni = /^[Uu]&'((?:[^']|'')*)'(?:\s*UESCAPE\s*'([^'])')?$/i.exec(t);
  if (uni !== null) {
    const esc = uni[2] ?? '\\';
    const body = (uni[1] ?? '').replace(/''/g, "'");
    let out = '';
    for (let i = 0; i < body.length; i++) {
      if (body[i] !== esc) {
        out += body[i];
        continue;
      }
      if (body[i + 1] === esc) {
        out += esc;
        i++;
      } else if (body[i + 1] === '+' && /^[0-9a-fA-F]{6}$/.test(body.slice(i + 2, i + 8))) {
        {
          const c = codePoint(parseInt(body.slice(i + 2, i + 8), 16));
          if (c === null) return null;
          out += c;
        }
        i += 7;
      } else if (/^[0-9a-fA-F]{4}$/.test(body.slice(i + 1, i + 5))) {
        {
          const c = codePoint(parseInt(body.slice(i + 1, i + 5), 16));
          if (c === null) return null;
          out += c;
        }
        i += 4;
      } else return null;
    }
    return out;
  }
  const e = /^[Ee]'((?:[^'\\]|''|\\[\s\S])*)'$/.exec(t);
  if (e !== null) {
    const body = e[1] ?? '';
    let out = '';
    // Octal and hex escapes are bytes, read together as UTF-8 the way the database does (CT-06f).
    let bytes: number[] = [];
    const flush = (): boolean => {
      if (bytes.length === 0) return true;
      try {
        out += new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          new Uint8Array(bytes),
        );
      } catch {
        return false;
      }
      bytes = [];
      return true;
    };
    for (let i = 0; i < body.length; i++) {
      const c = body[i] ?? '';
      const next = body[i + 1] ?? '';
      const isByte =
        c === '\\' &&
        (/[0-7]/.test(next) || (next === 'x' && /[0-9a-fA-F]/.test(body[i + 2] ?? '')));
      if (!isByte && !flush()) return null;
      if (c === "'" && body[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      if (c !== '\\') {
        out += c;
        continue;
      }
      const n = body[i + 1] ?? '';
      const simple: Record<string, string> = {
        "'": "'",
        '\\': '\\',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
      };
      if (simple[n] !== undefined) {
        out += simple[n];
        i++;
      } else if (/[0-7]/.test(n)) {
        const m = /^[0-7]{1,3}/.exec(body.slice(i + 1))?.[0] ?? n;
        const b = parseInt(m, 8);
        if (b === 0 || b > 0xff) return null;
        bytes.push(b);
        i += m.length;
        continue;
      } else if (n === 'x' && /[0-9a-fA-F]/.test(body[i + 2] ?? '')) {
        const m = /^[0-9a-fA-F]{1,2}/.exec(body.slice(i + 2))?.[0] ?? '';
        const b = parseInt(m, 16);
        if (b === 0) return null;
        bytes.push(b);
        i += 1 + m.length;
        continue;
      } else if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(body.slice(i + 2, i + 6))) {
        {
          const c = codePoint(parseInt(body.slice(i + 2, i + 6), 16));
          if (c === null) return null;
          out += c;
        }
        i += 5;
      } else if (n === 'U' && /^[0-9a-fA-F]{8}$/.test(body.slice(i + 2, i + 10))) {
        {
          const c = codePoint(parseInt(body.slice(i + 2, i + 10), 16));
          if (c === null) return null;
          out += c;
        }
        i += 9;
      } else return null;
    }
    return flush() ? out : null;
  }
  const plain = /^'((?:[^']|'')*)'$/.exec(t);
  if (plain !== null) return (plain[1] ?? '').replace(/''/g, "'");
  return t;
}

/** EXECUTE <literal> inside a DO body replaced by the SQL it runs (undecodable literals left as is). */
function decodeExecutes(body: string): string {
  return body.replace(
    new RegExp(String.raw`\bEXECUTE\s+(${LITERAL_SRC})`, 'gi'),
    (m, lit: string) => {
      const v = decodeLiteral(lit);
      // A newline ends a line comment inside the string before the DO body goes on (CT-06f).
      return v === null ? m : `EXECUTE ${v}\n;`;
    },
  );
}

/** Text with every parenthesised group blanked (same length): what is left is the top level. */
function flattenParens(text: string): string {
  let t = text;
  while (/\([^()]*\)/.test(t)) t = t.replace(/\([^()]*\)/g, (m) => ' '.repeat(m.length));
  return t;
}

/**
 * Constraints of one column definition (after the column name and type) that carry no
 * `CONSTRAINT <name>` (CT-06f): PostgreSQL names them itself, so no migration holds their definition.
 */
function hasUnnamedColumnConstraint(text: string): boolean {
  const flat = flattenParens(text);
  let named = false;
  for (const m of flat.matchAll(
    /\bCONSTRAINT\s+(?:"[^"]+"|\w+)|\b(?:PRIMARY\s+KEY|UNIQUE|CHECK|REFERENCES|EXCLUDE)\b|\b(?:NOT\s+NULL|NULL|DEFAULT|GENERATED)\b/gi,
  )) {
    if (/^CONSTRAINT\b/i.test(m[0])) {
      named = true;
      continue;
    }
    // A name before NOT NULL, NULL, DEFAULT or GENERATED is used by it, not by the next constraint.
    if (/^(?:NOT\s+NULL|NULL|DEFAULT|GENERATED)$/i.test(m[0])) {
      named = false;
      continue;
    }
    if (!named) return true;
    named = false;
  }
  return false;
}

/**
 * CT-06f ①: constraints and indexes of a funds or attribution table must be named. An unnamed one gets
 * a PostgreSQL-chosen name no migration records, so later definition comparisons would only see the
 * regenerated snapshot.
 */
function unnamedProblems(file: string, code: string): Problem[] {
  const problems: Problem[] = [];
  const refuse = (at: number, kind: string, table: string): void => {
    problems.push({
      file,
      line: lineOf(code, at),
      message: `unnamed ${kind} on funds or attribution table ${bareTableName(table)}: name it (CONSTRAINT <name> / CREATE INDEX <name>) so later migrations can be compared with it`,
    });
  };
  let start = 0;
  for (const text of code.split(';')) {
    const at = start + text.length - text.trimStart().length;
    start += text.length + 1;
    const index = new RegExp(
      String.raw`^\s*CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+CONCURRENTLY)?(?:\s+IF\s+NOT\s+EXISTS)?\s+ON${GAP}(?:ONLY${GAP})?(${IDENT})`,
      'i',
    ).exec(text);
    if (index !== null && isFundsTable(index[1] ?? '')) refuse(at, 'index', index[1] ?? '');
    const create = new RegExp(
      String.raw`^\s*CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE${GAP}(?:IF\s+NOT\s+EXISTS${GAP})?(${IDENT})\s*\(`,
      'i',
    ).exec(text);
    if (create !== null && isFundsTable(create[1] ?? '')) {
      const table = create[1] ?? '';
      const unnamed = topLevelParts(text, create[0].length, text.length).some((part) => {
        const p = flattenParens(part.text);
        if (/^\s*(?:PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE)\b/i.test(p)) return true;
        if (/^\s*(?:CONSTRAINT|LIKE)\b/i.test(p)) return false;
        return hasUnnamedColumnConstraint(part.text.replace(/^\s*(?:"[^"]+"|\w+)/, ''));
      });
      if (unnamed) refuse(at, 'constraint', table);
    }
    const alter = ALTER_TABLE.exec(text);
    if (alter !== null && isFundsTable(alter[1] ?? '')) {
      const table = alter[1] ?? '';
      const unnamed = topLevelParts(text, alter[0].length, text.length).some((part) => {
        const p = flattenParens(part.text);
        if (!/^\s*ADD\b/i.test(p) || /^\s*ADD\s+CONSTRAINT\b/i.test(p)) return false;
        if (/^\s*ADD\s+(?:PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE)\b/i.test(p))
          return true;
        const column = part.text.replace(
          /^\s*ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|\w+)/i,
          '',
        );
        return hasUnnamedColumnConstraint(column);
      });
      if (unnamed) refuse(at, 'constraint', table);
    }
  }
  return problems;
}

/**
 * CT-06b: destructive DDL inside a DO block (squawk does not look into it), SET SCHEMA on a funds
 * table, a column renamed into a money column, and money columns made by CREATE TABLE … AS or
 * SELECT … INTO (their type is whatever the query yields).
 */
function structureProblems(file: string, sql: string, code: string): Problem[] {
  const problems: Problem[] = [];
  const valued = withoutComments(sql, true);
  // DO blocks: the body is a dollar-quoted string, blanked in `code`; read it from `valued` and drop
  // its own comments (the strings stay: EXECUTE 'DROP …' is exactly what is looked for).
  // RAISE statements are messages, not SQL: their text does not count (CT-06d). ALTER … TYPE means a
  // column type change (ALTER TABLE … ALTER [COLUMN] x [SET DATA] TYPE), not a column named type or
  // ALTER TYPE … ADD VALUE.
  for (const { at, body: original, unreadable } of doBodies(code, valued)) {
    // A body or EXECUTE string with an escape this gate cannot read could hide anything (CT-06f).
    const undecodable = [
      ...original.matchAll(new RegExp(String.raw`\bEXECUTE\s+(${LITERAL_SRC})`, 'gi')),
    ].some((m) => decodeLiteral(m[1] ?? '') === null);
    if (unreadable === true || undecodable) {
      problems.push({
        file,
        line: lineOf(code, at),
        message:
          'DO block with an escape the gate cannot read (E or U& string): write the SQL as plain SQL',
      });
      continue;
    }
    // EXECUTE strings are read as the SQL they run (CT-06f).
    const raw = decodeExecutes(original);
    const blankedBody = withoutComments(raw);
    let body = withoutComments(raw, true);
    for (const m of blankedBody.matchAll(/\bRAISE\b[^;]*/gi)) {
      const from = m.index ?? 0;
      body = body.slice(0, from) + ' '.repeat(m[0].length) + body.slice(from + m[0].length);
    }
    const destructive =
      /\b(?:DROP|RENAME|TRUNCATE)\b/i.test(body) ||
      body
        .split(';')
        .some((part) =>
          /\bALTER\s+TABLE\b[\s\S]*\bALTER\s+(?:COLUMN(?:\s+|(?=")))?(?!COLUMN\b)(?:"[^"]+"\s*|(?:%[IsL]|\w+)\s+)(?:SET\s+DATA\s+)?TYPE(?:\s+|(?="))(?!SET\b|DROP\b)["\w%]/i.test(
            part,
          ),
        );
    // Guard changes the definition comparison cannot see inside a DO block (CT-06f).
    const guardChange =
      /\bCREATE\s+OR\s+REPLACE\s+(?:CONSTRAINT\s+)?TRIGGER\b|\bCREATE\s+OR\s+REPLACE\s+(?:FUNCTION|PROCEDURE)\b|\bDROP\s+(?:TRIGGER|FUNCTION|PROCEDURE|INDEX)\b/i.test(
        body,
      ) ||
      body
        .split(';')
        .some((part) =>
          /\bALTER\s+TABLE\b[\s\S]*\b(?:DROP\s+CONSTRAINT|DISABLE\s+TRIGGER|ENABLE\s+REPLICA\s+TRIGGER)\b/i.test(
            part,
          ),
        );
    if (destructive || guardChange) {
      const parts: string[] = [];
      if (destructive) {
        parts.push(
          'destructive DDL inside a DO block (DROP, RENAME, TRUNCATE or ALTER … TYPE): squawk does not check it',
        );
      }
      if (guardChange) parts.push('guard change inside a DO block');
      problems.push({
        file,
        line: lineOf(code, at),
        message: `${parts.join('; ')}: write it as plain SQL`,
      });
    }
    // Unnamed funds-table indexes and constraints inside a DO block count too (CT-06f).
    // PL/pgSQL keywords before a statement are cut like statement ends, so the statement head is read.
    const statementsOnly = withoutComments(body).replace(
      /\b(?:BEGIN|THEN|ELSE|LOOP|EXECUTE)\b/gi,
      (m) => `;${' '.repeat(m.length - 1)}`,
    );
    for (const problem of unnamedProblems(file, statementsOnly))
      problems.push({ ...problem, line: lineOf(code, at) });
  }
  let start = 0;
  for (const statement of code.split(';')) {
    const at = start + statement.length - statement.trimStart().length;
    start += statement.length + 1;
    const alter = ALTER_TABLE.exec(statement);
    if (alter !== null) {
      const table = alter[1] ?? '';
      if (/\bSET\s+SCHEMA\b/i.test(statement) && isFundsTable(table)) {
        problems.push({
          file,
          line: lineOf(code, at),
          message: `SET SCHEMA on funds or attribution table ${bareTableName(table)} (${table}): no exceptions there (规划/02 §16.3)`,
        });
      }
      for (const m of statement.matchAll(
        /\bRENAME(?:\s+COLUMN\b)?(?:\s*"[^"]*"\s*|\s+\w+\s+)TO(?:\s*"([a-z0-9_]+_fen)"|\s+([a-z0-9_]+_fen)\b)/gi,
      )) {
        const name = m[1] ?? m[2] ?? '';
        problems.push({
          file,
          line: lineOf(code, at),
          message: `money column ${name} must be declared as bigint, not renamed into (ADR-0001 §4)`,
        });
      }
    }
    // SELECT … INTO creates a table; decided by the head of the statement once parenthesised parts
    // (CTE bodies, subqueries) and quoted identifiers are set aside, so `"update"` or FOR UPDATE do
    // not matter and WITH … INSERT INTO … SELECT is not one.
    let flat = statement.replace(/"[^"]*"/g, ' ');
    while (/\([^()]*\)/.test(flat)) flat = flat.replace(/\([^()]*\)/g, ' ');
    const head = /\b(SELECT|INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|VALUES|TABLE)\b/i.exec(
      flat,
    )?.[1];
    const selectInto =
      /^\s*(?:WITH\b|SELECT\b)/i.test(flat) &&
      head?.toUpperCase() === 'SELECT' &&
      /\bINTO\b/i.test(flat);
    if (CREATE_TABLE_AS.test(statement) || selectInto) {
      const money = /"?\b([a-z0-9_]+_fen)\b"?/i.exec(statement);
      if (money !== null) {
        problems.push({
          file,
          line: lineOf(code, at),
          message: `money column ${money[1]} must be declared as bigint, not made by CREATE TABLE … AS or SELECT … INTO (ADR-0001 §4)`,
        });
      }
    }
  }
  return problems;
}

/** The bare name of a table, index, trigger or function reference (schema, quotes and arguments removed). */
function bareName(reference: string): string {
  return bareTableName(reference.replace(/\([\s\S]*$/, ''));
}

const CREATE_INDEX = new RegExp(
  String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX${GAP}(?:CONCURRENTLY${GAP})?(?:IF\s+NOT\s+EXISTS${GAP})?(${IDENT})(?:\s+|(?<=")\s*)ON${GAP}(?:ONLY${GAP})?(${IDENT})`,
  'gi',
);
const ADD_INDEX_CONSTRAINT = new RegExp(
  String.raw`\bADD\s+CONSTRAINT${GAP}(${IDENT})\s*(?:PRIMARY\s+KEY|UNIQUE|EXCLUDE)\b`,
  'gi',
);
const CREATE_TRIGGER = new RegExp(
  String.raw`^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER${GAP}(${IDENT})[\s\S]*?\bON${GAP}(?:ONLY${GAP})?(${IDENT})(?:[\s\S]*?\bEXECUTE\s+(?:FUNCTION|PROCEDURE)${GAP}(${IDENT})\s*\()?`,
  'i',
);

/** Statements of a SQL text (comments and string contents blanked), with their offsets. */
function statementsOf(code: string): { text: string; at: number; start: number; end: number }[] {
  const out: { text: string; at: number; start: number; end: number }[] = [];
  let start = 0;
  for (const text of code.split(';')) {
    out.push({
      text,
      at: start + text.length - text.trimStart().length,
      start,
      end: start + text.length,
    });
    start += text.length + 1;
  }
  return out;
}

/**
 * Index name → table, both bare and lower-cased, from CREATE [UNIQUE] INDEX and from the primary key,
 * unique and exclusion constraints added with ALTER TABLE (their index has the constraint's name), in
 * db/schema.sql and the given migrations.
 */
export function indexOwners(
  schemaSql: string,
  migrationsSql: readonly string[],
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const sql of [schemaSql, ...migrationsSql]) {
    const code = withoutComments(sql);
    for (const m of code.matchAll(CREATE_INDEX))
      owners.set(bareName(m[1] ?? ''), bareName(m[2] ?? ''));
    for (const { text } of statementsOf(code)) {
      const alter = ALTER_TABLE.exec(text);
      if (alter === null) continue;
      for (const m of text.matchAll(ADD_INDEX_CONSTRAINT)) {
        owners.set(bareName(m[1] ?? ''), bareName(alter[1] ?? ''));
      }
    }
  }
  return owners;
}

/**
 * Function → one funds or attribution table it guards, both bare and lower-cased: the functions that
 * triggers on funds tables execute, from db/schema.sql and the given migrations.
 */
export function fundsTriggerFunctions(
  schemaSql: string,
  migrationsSql: readonly string[],
): Map<string, string> {
  const guards = new Map<string, string>();
  for (const sql of [schemaSql, ...migrationsSql]) {
    for (const { text } of statementsOf(withoutComments(sql))) {
      const m = CREATE_TRIGGER.exec(text);
      if (m === null || m[3] === undefined || !isFundsTable(m[2] ?? '')) continue;
      const fn = bareName(m[3]);
      if (!guards.has(fn)) guards.set(fn, bareName(m[2] ?? ''));
    }
  }
  return guards;
}

/**
 * A DDL definition normalised for comparison (CT-06d): lower-case, single spaces, no quotes or schema
 * qualifiers, without OR REPLACE / IF [NOT] EXISTS / CONCURRENTLY / ONLY / USING btree, trigger events
 * in a fixed order (pg_dump writes `DELETE OR UPDATE` for a hand-written `UPDATE OR DELETE`).
 */
export function normaliseDefinition(text: string): string {
  // Only the SQL outside string literals is normalised; literals stay exactly as written ('BLOCKED'
  // and 'blocked', 'payout.unknown' and 'unknown' differ). NEW. and OLD. in trigger WHEN conditions
  // are row references, not schema qualifiers.
  const sqlPart = (p: string): string =>
    p
      .toLowerCase()
      .replace(/"/g, ' ')
      .replace(/\b(?!(?:new|old)\s*\.)[a-z_][a-z0-9_]*\s*\.\s*(?=[a-z_])/g, '')
      .replace(/\bor\s+replace\b/g, ' ')
      .replace(/\bif\s+(?:not\s+)?exists\b/g, ' ')
      .replace(/\bconcurrently\b/g, ' ')
      .replace(/\bonly\b/g, ' ')
      .replace(/\busing\s+btree\b/g, ' ')
      .replace(/\bexecute\s+procedure\b/g, 'execute function')
      .replace(/\s+/g, ' ')
      .replace(/\s*([(),=])\s*/g, '$1');
  // Literals (E'…', U&'…', '…') are decoded and rewritten in one canonical form, so E'a\'b' equals
  // 'a''b' and a backslash escape cannot shift where literals start and end (CT-06f).
  // Dollar-quoted literals ($$…$$, $tag$…$tag$) become plain ones first, so their text is kept as
  // written and $$a$$ equals 'a' (CT-06h).
  // Read token by token, so a $$ inside a quoted literal is left alone.
  const plain = text.replace(new RegExp(LITERAL_SRC, 'g'), (m: string) =>
    m.startsWith('$') ? `'${(decodeLiteral(m) ?? '').replace(/'/g, "''")}'` : m,
  );
  let t = plain
    .split(
      /([Ee]'(?:[^'\\]|''|\\[\s\S])*'|[Uu]&'(?:[^']|'')*'(?:\s*UESCAPE\s*'[^']')?|'(?:[^']|'')*')/,
    )
    .map((p, i) => {
      if (i % 2 === 0) return sqlPart(p);
      const v = decodeLiteral(p);
      return v === null ? p : `'${v.replace(/'/g, "''")}'`;
    })
    .join('')
    .replace(/;\s*$/, '')
    .trim();
  t = t.replace(
    /\b(before|after|instead of) ((?:insert|update(?: of [a-z0-9_, ]+?)?|delete|truncate)(?: or (?:insert|update(?: of [a-z0-9_, ]+?)?|delete|truncate))*) on\b/,
    (_m, when: string, events: string) => `${when} ${events.split(' or ').sort().join(' or ')} on`,
  );
  return t;
}

/**
 * The SQL without the statements that mention an object it also DROPs, so that the definitions left
 * are of objects first created here. Conservative: a DROP TRIGGER / INDEX / CONSTRAINT name removes
 * every statement naming it.
 */
function dropFree(sql: string): string {
  const code = withoutComments(sql);
  const dropped = new Set<string>();
  for (const m of code.matchAll(
    new RegExp(
      String.raw`\bDROP\s+(?:TRIGGER|INDEX|CONSTRAINT)${GAP}(?:CONCURRENTLY${GAP})?(?:IF\s+EXISTS${GAP})?(${IDENT})`,
      'gi',
    ),
  )) {
    dropped.add(bareName(m[1] ?? ''));
  }
  if (dropped.size === 0) return sql;
  const names = (text: string): boolean =>
    [...dropped].some((n) => new RegExp(String.raw`(?:^|[^\w])${n}(?:[^\w]|$)`, 'i').test(text));
  return statementsOf(code)
    .filter(({ text }) => !names(text))
    .map(({ start, end }) => sql.slice(start, end))
    .join(';');
}

/**
 * Every named constraint in one column definition or table element (`col type CONSTRAINT a CHECK (…)
 * CONSTRAINT b CHECK (…)`), each cut off where the next one starts. `blanked` locates the keywords,
 * `kept` (same offsets, literals kept) supplies the definitions.
 */
function namedConstraints(blanked: string, kept: string): { name: string; definition: string }[] {
  const found = [
    ...blanked.matchAll(new RegExp(String.raw`(?:^|\s)CONSTRAINT${GAP}(${IDENT})`, 'gi')),
  ].map((m) => ({
    name: bareName(m[1] ?? ''),
    at: (m.index ?? 0) + (m[0].length - m[0].trimStart().length),
  }));
  // A column constraint names its column implicitly: written as the table constraint it equals
  // (`id bigint CONSTRAINT x PRIMARY KEY` is `CONSTRAINT x PRIMARY KEY (id)`, REFERENCES is
  // FOREIGN KEY (col) REFERENCES), so both forms compare equal (CT-06h).
  const head = blanked.replace(/^\s*ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?/i, '');
  const column = /^\s*(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE|LIKE)\b/i.test(head)
    ? null
    : (/^\s*("[^"]+"|\w+)/.exec(head)?.[1] ?? null);
  return found.map((c, i) => {
    let raw = kept.slice(c.at, found[i + 1]?.at ?? kept.length).trim();
    if (column !== null) {
      raw = raw
        .replace(
          /^(CONSTRAINT\s+\S+\s+)(PRIMARY\s+KEY|UNIQUE)(?!\s*(?:\(|NULLS\b))/i,
          `$1$2 (${column})`,
        )
        .replace(/^(CONSTRAINT\s+\S+\s+)REFERENCES\b/i, `$1FOREIGN KEY (${column}) REFERENCES`);
    }
    return { name: c.name, definition: normaliseDefinition(raw) };
  });
}

/** Definitions of triggers (table/name), constraints (table/name) and indexes (name), last one wins. */
function guardDefinitions(sources: readonly string[]): {
  triggers: Map<string, string>;
  constraints: Map<string, string>;
  indexes: Map<string, string>;
} {
  const triggers = new Map<string, string>();
  const constraints = new Map<string, string>();
  const indexes = new Map<string, string>();
  for (const sql of sources) {
    // Matched on the copy with strings blanked, compared on the copy that keeps them (a changed
    // literal in WHERE status IN (…) is a changed definition).
    const kept = withoutComments(sql, true);
    for (const { text, start, end } of statementsOf(withoutComments(sql))) {
      const vt = kept.slice(start, end);
      const partOf = (part: { start: number; text: string }): string =>
        vt.slice(part.start, part.start + part.text.length);
      const trigger = CREATE_TRIGGER.exec(text);
      if (trigger !== null) {
        triggers.set(
          `${bareName(trigger[2] ?? '')}/${bareName(trigger[1] ?? '')}`,
          normaliseDefinition(vt),
        );
      }
      for (const m of text.matchAll(CREATE_INDEX)) {
        if (/^\s*CREATE\b/i.test(text)) indexes.set(bareName(m[1] ?? ''), normaliseDefinition(vt));
      }
      const alter = ALTER_TABLE.exec(text);
      if (alter !== null) {
        for (const part of topLevelParts(text, alter[0].length, text.length)) {
          const c = new RegExp(String.raw`^\s*ADD\s+CONSTRAINT${GAP}(${IDENT})`, 'i').exec(
            part.text,
          );
          if (c !== null) {
            constraints.set(
              `${bareName(alter[1] ?? '')}/${bareName(c[1] ?? '')}`,
              normaliseDefinition(
                partOf(part)
                  .trim()
                  .replace(/^add\s+/i, ''),
              ),
            );
          }
          // VALIDATE CONSTRAINT: the constraint is validated from here on (CT-06f).
          const v = new RegExp(String.raw`^\s*VALIDATE\s+CONSTRAINT${GAP}(${IDENT})`, 'i').exec(
            part.text,
          );
          if (v !== null) {
            const key = `${bareName(alter[1] ?? '')}/${bareName(v[1] ?? '')}`;
            const d = constraints.get(key);
            if (d !== undefined) constraints.set(key, withoutNotValid(d));
          }
          // ADD COLUMN … CONSTRAINT x CHECK (…) [CONSTRAINT y …]: column constraints added with
          // their column (0020 has two on one column).
          if (c === null && /^\s*ADD\b/i.test(part.text)) {
            for (const { name, definition } of namedConstraints(part.text, partOf(part))) {
              constraints.set(`${bareName(alter[1] ?? '')}/${name}`, definition);
            }
          }
        }
      }
      const create = new RegExp(
        String.raw`^\s*CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE${GAP}(?:IF\s+NOT\s+EXISTS${GAP})?(${IDENT})\s*\(`,
        'i',
      ).exec(text);
      if (create !== null) {
        for (const part of topLevelParts(text, create[0].length, text.length)) {
          // Table constraints and column constraints (`col type … CONSTRAINT x CHECK (…)`) alike.
          for (const { name, definition } of namedConstraints(part.text, partOf(part))) {
            constraints.set(`${bareName(create[1] ?? '')}/${name}`, definition);
          }
        }
      }
    }
  }
  return { triggers, constraints, indexes };
}

/**
 * CT-06c (规划/02 §16.3): the triggers, constraints and indexes of a funds or attribution table are
 * part of it. Dropping one is refused unless a later statement of the same migration recreates the
 * same name on the same table; disabling a trigger is refused; DROP … CASCADE is refused (it silently
 * takes dependent triggers, foreign keys and constraints with it); the functions funds-table triggers
 * execute may not be dropped, replaced, renamed, re-owned or moved.
 */
function fundsObjectProblems(
  file: string,
  sql: string,
  code: string,
  context: MigrationContext,
): Problem[] {
  const valued = withoutComments(sql, true);
  const problems: Problem[] = [];
  const statements = statementsOf(code);
  const refuse = (at: number, message: string): void => {
    problems.push({
      file,
      line: lineOf(code, at),
      message: `${message} (规划/02 §16.3)`,
    });
  };
  // The statement with its string literals kept, for definition comparisons (CT-06d).
  const keptOf = (j: number): string =>
    valued.slice(statements[j]?.start ?? 0, statements[j]?.end ?? 0);
  const laterIndex = (k: number, pick: (t: string) => boolean): number => {
    const i = statements.slice(k + 1).findIndex((st) => pick(st.text));
    return i === -1 ? -1 : k + 1 + i;
  };
  const funds = (ref: string): boolean => isFundsTable(ref);
  // CT-06d: the CLI says whether the migration is approved; a pure call without it keeps CT-06c.
  // approved: false (the CLI for a migration not in APPROVED_GUARD_CHANGES) is strict; true lets
  // guard changes through; left out (a pure call) the CT-06c rules apply.
  const strict = context.approved === false;
  // Original definitions: earlier migrations first (db/schema.sql already shows the migration under
  // review once its PR updates it), the schema only for objects no migration defines.
  const fromSchema = guardDefinitions([context.schemaSql]);
  // Objects created in this file are not compared (CT-06c rules for them).
  const original = (): ReturnType<typeof guardDefinitions> => {
    const fromMigrations = guardDefinitions(context.migrationsSql);
    for (const key of ['triggers', 'constraints', 'indexes'] as const) {
      for (const [k, v] of fromSchema[key])
        if (!fromMigrations[key].has(k)) fromMigrations[key].set(k, v);
    }
    // With the migration history at hand (the CLI), an object no earlier migration defines is new in
    // this file: the regenerated schema already shows it, so it is not compared.
    if (context.migrationsSql.length > 0) {
      // Only an object this file never drops counts as new: a DROP proves it existed before.
      const here = guardDefinitions([dropFree(sql)]);
      const earlier = guardDefinitions(context.migrationsSql);
      for (const key of ['triggers', 'constraints', 'indexes'] as const) {
        for (const k of here[key].keys()) if (!earlier[key].has(k)) fromMigrations[key].delete(k);
      }
    }
    return fromMigrations;
  };
  const different = (kind: string, name: string, table: string): string =>
    `${kind} ${name} on funds or attribution table ${table} recreated with a different definition: list the migration in APPROVED_GUARD_CHANGES (two reviews and the approval label)`;
  statements.forEach(({ text, at, start, end }, k) => {
    // DROP TRIGGER <name> ON <funds table>, unless recreated later in the file.
    const dropTrigger = new RegExp(
      String.raw`^\s*DROP\s+TRIGGER${GAP}(?:IF\s+EXISTS${GAP})?(${IDENT})(?:\s+|(?<=")\s*)ON${GAP}(?:ONLY${GAP})?(${IDENT})`,
      'i',
    ).exec(text);
    if (dropTrigger !== null && funds(dropTrigger[2] ?? '')) {
      const name = bareName(dropTrigger[1] ?? '');
      const table = bareName(dropTrigger[2] ?? '');
      const recreation = laterIndex(k, (t) => {
        const m = CREATE_TRIGGER.exec(t);
        return m !== null && bareName(m[1] ?? '') === name && bareName(m[2] ?? '') === table;
      });
      if (recreation === -1)
        refuse(at, `trigger ${name} on funds or attribution table ${table} may not be dropped`);
      else if (strict) {
        const before = original().triggers.get(`${table}/${name}`);
        if (before !== undefined && before !== normaliseDefinition(keptOf(recreation))) {
          refuse(at, different('trigger', name, table));
        }
      }
    }
    const alter = ALTER_TABLE.exec(text);
    if (alter !== null) {
      const tableRef = alter[1] ?? '';
      const table = bareName(tableRef);
      const parts = topLevelParts(text, alter[0].length, text.length);
      parts.forEach((part, i) => {
        // ALTER TABLE … DROP COLUMN | CONSTRAINT … CASCADE (any table).
        if (/^\s*DROP\b[\s\S]*\bCASCADE\s*$/i.test(part.text)) {
          refuse(at, `DROP … CASCADE is not accepted: drop dependent objects explicitly`);
        }
        if (!funds(tableRef)) return;
        // ENABLE REPLICA TRIGGER switches the trigger off for ordinary sessions, like DISABLE.
        const disable =
          /^\s*(?:DISABLE|ENABLE\s+REPLICA)\s+TRIGGER(?:\s+|(?="))("[^"]+"|\w+)/i.exec(part.text);
        if (disable !== null) {
          refuse(
            at,
            `trigger ${bareName(disable[1] ?? '')} on funds or attribution table ${table} may not be disabled`,
          );
        }
        const renameConstraint = new RegExp(
          String.raw`^\s*RENAME\s+CONSTRAINT${GAP}(${IDENT})`,
          'i',
        ).exec(part.text);
        if (renameConstraint !== null) {
          refuse(
            at,
            `constraint ${bareName(renameConstraint[1] ?? '')} on funds or attribution table ${table} may not be renamed`,
          );
        }
        const dropConstraint = new RegExp(
          String.raw`^\s*DROP\s+CONSTRAINT${GAP}(?:IF\s+EXISTS${GAP})?(${IDENT})`,
          'i',
        ).exec(part.text);
        if (dropConstraint !== null) {
          const name = bareName(dropConstraint[1] ?? '');
          // The ADD CONSTRAINT <same name> clause that recreates it, in this statement or a later one.
          // The ADD CONSTRAINT clause recreating it, returned with its string literals kept.
          const sameClause = (j: number, from: number): string | undefined => {
            const t = statements[j]?.text ?? '';
            const a = ALTER_TABLE.exec(t);
            if (a === null || bareName(a[1] ?? '') !== table) return undefined;
            const p = topLevelParts(t, a[0].length, t.length)
              .slice(from)
              .find((q) => {
                const c = new RegExp(String.raw`^\s*ADD\s+CONSTRAINT${GAP}(${IDENT})`, 'i').exec(
                  q.text,
                );
                return c !== null && bareName(c[1] ?? '') === name;
              });
            return p === undefined ? undefined : keptOf(j).slice(p.start, p.start + p.text.length);
          };
          const clause =
            sameClause(k, i + 1) ??
            statements
              .slice(k + 1)
              .map((_st, d) => sameClause(k + 1 + d, 0))
              .find((c) => c !== undefined);
          if (clause === undefined)
            refuse(
              at,
              `constraint ${name} on funds or attribution table ${table} may not be dropped`,
            );
          else if (strict) {
            const before = original().constraints.get(`${table}/${name}`);
            // NOT VALID followed in this file by VALIDATE CONSTRAINT on the same table and name ends
            // validated: compare it as such (CT-06f).
            // Only a VALIDATE after the ADD counts: parts after it in its statement, then later ones.
            const partsOf = (j: number) => {
              const t = statements[j]?.text ?? '';
              const a = ALTER_TABLE.exec(t);
              if (a === null || bareName(a[1] ?? '') !== table) return [];
              return topLevelParts(t, a[0].length, t.length).map((q) => q.text);
            };
            const isAdd = (q: string) =>
              bareName(
                new RegExp(String.raw`^\s*ADD\s+CONSTRAINT${GAP}(${IDENT})`, 'i').exec(q)?.[1] ??
                  '',
              ) === name;
            const isValidate = (q: string) =>
              bareName(
                new RegExp(String.raw`^\s*VALIDATE\s+CONSTRAINT${GAP}(${IDENT})`, 'i').exec(
                  q,
                )?.[1] ?? '',
              ) === name;
            const addAt = [k, ...statements.slice(k + 1).map((_st, d) => k + 1 + d)].find((j) =>
              partsOf(j)
                .slice(j === k ? i + 1 : 0)
                .some(isAdd),
            );
            const validated =
              addAt !== undefined &&
              statements.slice(addAt).some((_st, d) => {
                const parts = partsOf(addAt + d);
                const from = d === 0 ? parts.findLastIndex(isAdd) + 1 : 0;
                return parts.slice(from).some(isValidate);
              });
            let now = clause.trim().replace(/^add\s+/i, '');
            if (validated) now = withoutNotValid(now);
            const was = validated && before !== undefined ? withoutNotValid(before) : before;
            if (was !== undefined && was !== normaliseDefinition(now)) {
              refuse(at, different('constraint', name, table));
            }
          }
        }
      });
    }
    // CREATE OR REPLACE TRIGGER over an existing funds-table trigger changes it in place, no DROP needed
    // (CT-06d): the new definition must equal the original unless the migration is approved.
    if (strict && /^\s*CREATE\s+OR\s+REPLACE\s+(?:CONSTRAINT\s+)?TRIGGER\b/i.test(text)) {
      const m = CREATE_TRIGGER.exec(text);
      if (m !== null && funds(m[2] ?? '')) {
        const name = bareName(m[1] ?? '');
        const table = bareName(m[2] ?? '');
        const before = original().triggers.get(`${table}/${name}`);
        // Compared even after a DROP of the same name: the last word on the trigger is what stays.
        if (before !== undefined && before !== normaliseDefinition(keptOf(k))) {
          refuse(at, different('trigger', name, table));
        }
      }
    }
    // Renaming a funds-table index or trigger (CT-06d): the protection would no longer carry its name.
    const renameIndex = new RegExp(
      String.raw`^\s*ALTER\s+INDEX${GAP}(?:IF\s+EXISTS${GAP})?(${IDENT})(?:\s+|(?<=")\s*)RENAME\b`,
      'i',
    ).exec(text);
    if (renameIndex !== null) {
      const name = bareName(renameIndex[1] ?? '');
      const owner =
        indexOwners(context.schemaSql, [...context.migrationsSql, code.slice(0, at)]).get(name) ??
        fundsTableOfIndexName(name);
      if (owner !== undefined && funds(owner)) {
        refuse(at, `index ${name} on funds or attribution table ${owner} may not be renamed`);
      }
    }
    const renameTrigger = new RegExp(
      String.raw`^\s*ALTER\s+TRIGGER${GAP}(${IDENT})(?:\s+|(?<=")\s*)ON${GAP}(?:ONLY${GAP})?(${IDENT})(?:\s+|(?<=")\s*)RENAME\b`,
      'i',
    ).exec(text);
    if (renameTrigger !== null && funds(renameTrigger[2] ?? '')) {
      refuse(
        at,
        `trigger ${bareName(renameTrigger[1] ?? '')} on funds or attribution table ${bareName(renameTrigger[2] ?? '')} may not be renamed`,
      );
    }
    // DROP <anything> … CASCADE.
    if (/^\s*DROP\b[\s\S]*\bCASCADE\s*$/i.test(text)) {
      refuse(at, 'DROP … CASCADE is not accepted: drop dependent objects explicitly');
    }
    // DROP INDEX <name>[, …] of a funds table, unless recreated later in the file.
    const dropIndex = new RegExp(
      String.raw`^\s*DROP\s+INDEX${GAP}(?:CONCURRENTLY${GAP})?(?:IF\s+EXISTS${GAP})?(${IDENT}(?:\s*,\s*${IDENT})*)`,
      'i',
    ).exec(text);
    if (dropIndex !== null) {
      const owners = indexOwners(context.schemaSql, [...context.migrationsSql, code.slice(0, at)]);
      for (const raw of (dropIndex[1] ?? '').split(',')) {
        const name = bareName(raw.trim());
        const owner = owners.get(name);
        const table = owner ?? fundsTableOfIndexName(name);
        if (table === undefined || !funds(table)) continue;
        // Recreated on the same table; with the owner unknown, on a funds table whose name the index
        // name starts with (orders_created_at_idx on orders), never on another table (CT-06d).
        const recreation = laterIndex(k, (t) =>
          [...t.matchAll(CREATE_INDEX)].some((m) => {
            const on = bareName(m[2] ?? '');
            return (
              bareName(m[1] ?? '') === name &&
              (owner !== undefined ? on === owner : funds(on) && name.startsWith(`${on}_`))
            );
          }),
        );
        if (recreation === -1)
          refuse(at, `index ${name} on funds or attribution table ${table} may not be dropped`);
        else if (strict) {
          const before = original().indexes.get(name);
          if (before !== undefined && before !== normaliseDefinition(keptOf(recreation))) {
            refuse(at, different('index', name, table));
          }
        }
      }
    }
    // The functions funds-table triggers execute: from the schema, earlier migrations and the triggers
    // created earlier in this file (a new function created before its trigger is fine).
    // CREATE OR REPLACE is how a guard is extended (0020 does it for union_auth_sessions); only a
    // replacement whose body no longer raises is a bypass.
    const replace = new RegExp(
      String.raw`^\s*CREATE\s+OR\s+REPLACE\s+(?:FUNCTION|PROCEDURE)${GAP}(${IDENT})\s*\(`,
      'i',
    ).exec(text);
    // Strict (CLI, migration not in APPROVED_GUARD_CHANGES): any replacement of a guard is refused —
    // whether a new body still protects cannot be read off its text (CT-06d). Without the approval
    // flag (pure call) the CT-06c rule stays: a body that still raises passes.
    const replaceRaises =
      context.approved === undefined &&
      replace !== null &&
      /\bRAISE\s+EXCEPTION\b/i.test(valued.slice(start, end));
    const fn =
      new RegExp(
        String.raw`^\s*DROP\s+(?:FUNCTION|PROCEDURE)\s+(?:IF\s+EXISTS${GAP})?(${IDENT}(?:\s*\([^)]*\))?(?:\s*,\s*${IDENT}(?:\s*\([^)]*\))?)*)`,
        'i',
      ).exec(text)?.[1] ??
      (context.approved === true || replaceRaises ? undefined : replace?.[1]) ??
      new RegExp(
        String.raw`^\s*ALTER\s+(?:FUNCTION|PROCEDURE)${GAP}(${IDENT})(?:\s*\([^)]*\))?\s+(?:RENAME\s+TO|OWNER\s+TO|SET\s+SCHEMA)\b`,
        'i',
      ).exec(text)?.[1];
    if (fn !== undefined) {
      const guards = fundsTriggerFunctions(context.schemaSql, [
        ...context.migrationsSql,
        code.slice(0, at),
      ]);
      // A guard this migration introduces (no earlier migration defines the function, and a trigger in
      // this file executes it) is new, even when the regenerated db/schema.sql already lists it.
      const definedBefore = (name: string): boolean =>
        context.migrationsSql.some((m) =>
          new RegExp(
            String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)${GAP}(?:"?\w+"?\s*\.\s*)?"?${name}"?\s*\(`,
            'i',
          ).test(withoutComments(m)),
        );
      const triggeredHere = (name: string): boolean =>
        statements.some(({ text: t }) => {
          const m = CREATE_TRIGGER.exec(t);
          return m?.[3] !== undefined && bareName(m[3]) === name;
        });
      const isReplace = replace?.[1] !== undefined && fn === replace[1];
      for (const raw of fn.replace(/\([^)]*\)/g, '').split(',')) {
        const name = bareName(raw.trim());
        const table = guards.get(name);
        // Only for the CLI (approval known, regenerated schema in play); pure calls keep CT-06c.
        if (
          context.approved !== undefined &&
          context.migrationsSql.length > 0 &&
          isReplace &&
          !definedBefore(name) &&
          triggeredHere(name)
        )
          continue;
        if (table !== undefined) {
          refuse(
            at,
            `function ${name} guards funds or attribution table ${table}: it may not be dropped, replaced, renamed, re-owned or moved`,
          );
        }
      }
    }
  });
  return problems;
}

/** The checks squawk cannot express, over one migration file. */
export function checkMigration(
  file: string,
  sql: string,
  context: MigrationContext = NO_CONTEXT,
): Problem[] {
  const problems: Problem[] = [];
  const code = withoutComments(sql);
  // Money columns: every `*_fen` column defined in CREATE TABLE or added / retyped in ALTER TABLE
  // must be bigint / int8; any other type (numeric, DEC, a domain, an array…) is refused.
  let start = 0;
  for (const statement of code.split(';')) {
    for (const column of moneyColumns(statement)) {
      const type = badMoneyType(column.rest);
      if (type !== null) {
        problems.push({
          file,
          line: lineOf(code, start + column.at),
          message: `money column ${column.name} must be bigint (ADR-0001 §4), found ${type}`,
        });
      }
    }
    start += statement.length + 1;
  }
  problems.push(...structureProblems(file, sql, code));
  problems.push(...unnamedProblems(file, code));
  problems.push(...fundsObjectProblems(file, sql, code, context));
  const ignoreFile = IGNORE_FILE.exec(sql);
  if (ignoreFile !== null) {
    problems.push({
      file,
      line: lineOf(sql, ignoreFile.index),
      message: 'squawk-ignore-file is not accepted; ignore single statements with a reason instead',
    });
  }
  for (const ignore of sql.matchAll(IGNORE_ANY)) {
    // The statement the ignore belongs to: the one the comment precedes or sits inside (from the `;`
    // before the comment to the `;` after it; comments blanked, positions kept), or, for a comment
    // that follows a `;` on the same line with nothing in between, the statement that just ended
    // (squawk honours `… DROP COLUMN c; -- squawk-ignore ban-drop-column`). What else squawk's line
    // rule lets the comment cover is checked by running squawk without the ignores (see main).
    const at = ignore.index ?? 0;
    const prev = code.lastIndexOf(';', at);
    const stop = code.indexOf(';', at);
    const trailing = prev !== -1 && /^[ \t]*$/.test(code.slice(prev + 1, at));
    const statement = trailing
      ? code.slice(code.lastIndexOf(';', prev - 1) + 1, prev)
      : code.slice(prev + 1, stop === -1 ? code.length : stop);
    const names = [...statement.matchAll(TABLE_REF)].flatMap((ref) => (ref[1] ?? '').split(','));
    for (const raw of names) {
      const name = raw.trim();
      if (name !== '' && isFundsTable(name)) {
        problems.push({
          file,
          line: lineOf(sql, at),
          message: `squawk-ignore on a statement of funds or attribution table ${bareTableName(name)} (${name}): no exceptions there (规划/02 §16.3)`,
        });
        break;
      }
    }
  }
  return problems;
}

/** The SQL with every squawk-ignore directive blanked (same offsets): what squawk reports without the exceptions. */
export function withoutIgnores(sql: string): string {
  return sql.replace(/squawk-ignore(?:-file)?/g, (m) => ' '.repeat(m.length));
}

/** The string index in `lineText` of squawk's report column, which counts UTF-8 bytes. */
export function byteColumnToIndex(lineText: string, byteColumn: number): number {
  let bytes = 0;
  let index = 0;
  for (const ch of lineText) {
    if (bytes >= byteColumn) break;
    bytes += Buffer.byteLength(ch, 'utf8');
    index += ch.length;
  }
  return index;
}

/**
 * The funds or attribution table named by the statement that holds a squawk finding, or null.
 * `line` and `column` are squawk's gcc report positions, both counted from 0; the column counts
 * UTF-8 bytes.
 */
/** The string offset in `sql` of squawk's report position (line from 0, column in UTF-8 bytes). */
function findingOffset(sql: string, line: number, column: number): number | null {
  let offset = 0;
  for (let l = 0; l < line; l++) {
    const n = sql.indexOf('\n', offset);
    if (n === -1) return null;
    offset = n + 1;
  }
  const end = sql.indexOf('\n', offset);
  return offset + byteColumnToIndex(sql.slice(offset, end === -1 ? sql.length : end), column);
}

export function fundsTableAt(sql: string, line: number, column: number): string | null {
  const code = withoutComments(sql);
  const at = findingOffset(sql, line, column);
  if (at === null) return null;
  const stop = code.indexOf(';', at);
  const statement = code.slice(code.lastIndexOf(';', at - 1) + 1, stop === -1 ? code.length : stop);
  for (const ref of statement.matchAll(TABLE_REF)) {
    for (const raw of (ref[1] ?? '').split(',')) {
      const name = raw.trim();
      if (name !== '' && isFundsTable(name)) return name;
    }
  }
  return null;
}

/**
 * squawk's line rule lets an ignore comment cover more than the statement it belongs to (every
 * statement on the comment's line and the line after it). So for the files that carry an ignore,
 * squawk runs once more over copies with the ignores blanked: any finding on a funds or attribution
 * table statement is refused, whichever comment would have hidden it. Returns the refusals, or null
 * when squawk could not run.
 */
function ignoredFundsFindings(
  binary: string,
  config: string,
  files: readonly { file: string; sql: string }[],
): string[] | null {
  const scratch = mkdtempSync(join(tmpdir(), 'lint-migrations-'));
  try {
    const bare = new Map<string, { file: string; sql: string }>();
    for (const entry of files) {
      const name = basename(entry.file);
      const copy = withoutIgnores(entry.sql);
      writeFileSync(join(scratch, name), copy);
      bare.set(name, { file: entry.file, sql: copy });
    }
    const res = spawnSync(binary, ['-c', config, '--reporter', 'gcc', ...bare.keys()], {
      cwd: scratch,
      encoding: 'utf8',
    });
    if (res.error !== undefined || res.status === null) return null;
    const refusals: string[] = [];
    for (const line of res.stdout.split('\n')) {
      const m = /^(.+?):(\d+):(\d+): warning: (\S+)/.exec(line);
      const entry = m === null ? undefined : bare.get(basename(m[1] ?? ''));
      if (m === null || entry === undefined) continue;
      const table = fundsTableAt(entry.sql, Number(m[2]), Number(m[3]));
      if (table !== null) {
        refusals.push(
          `${entry.file}:${Number(m[2]) + 1}: ${m[4]} on a statement of funds or attribution table ${bareTableName(table)} (${table}) while the file carries squawk-ignore: no exceptions there (规划/02 §16.3)`,
        );
      }
    }
    return refusals;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * db/AGENTS.md rule 2 on the directory: frozen migrations unchanged (sha256) and all present once any
 * of them is (a scratch root with only new migrations does not trip that), no new SQL file at or below
 * the baseline, and no JS / TS migration (node-pg-migrate would run it unchecked).
 */
function checkFrozen(dir: string, names: readonly string[]): string[] {
  const problems: string[] = [];
  const present = new Set(names);
  // The real repository carries the frozen files; a scratch root with made-up old names (rule tests)
  // does not, and the frozen-set rules (missing files, strangers at or below the baseline) skip it.
  const anyFrozen = names.some((name) => FROZEN_MIGRATIONS[name] !== undefined);
  for (const name of [...names].sort()) {
    const path = `${MIGRATIONS_DIR}/${name}`;
    if (SCRIPT_MIGRATION.test(name)) {
      problems.push(`${path} is not a SQL migration: only NNNN_kebab-name.sql files are accepted`);
      continue;
    }
    if (!name.endsWith('.sql')) continue;
    const expected = FROZEN_MIGRATIONS[name];
    if (expected !== undefined) {
      const actual = createHash('sha256')
        .update(readFileSync(join(dir, name)))
        .digest('hex');
      if (actual !== expected) {
        problems.push(
          `${path} changed after merge: merged migrations never change (db/AGENTS.md rule 2)`,
        );
      }
      continue;
    }
    const match = MIGRATION_FILE.exec(name);
    if (anyFrozen && match !== null && Number(match[1]) <= GATE_BASELINE) {
      problems.push(
        `${path} is numbered at or below the gate baseline ${String(GATE_BASELINE).padStart(4, '0')}: a new migration takes the next free number`,
      );
    }
  }
  if (anyFrozen) {
    for (const name of Object.keys(FROZEN_MIGRATIONS)) {
      if (!present.has(name)) {
        problems.push(
          `${MIGRATIONS_DIR}/${name} is missing: merged migrations stay (db/AGENTS.md rule 2)`,
        );
      }
    }
  }
  return problems;
}

function usage(): never {
  console.error(
    'usage: node tools/ci/lint-migrations.ts [--root <repo dir>] [--squawk <binary>] [--list]',
  );
  process.exit(2);
}

function main(argv: readonly string[]): number {
  let root = resolve(import.meta.dirname, '../..');
  let squawk: string | undefined;
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root' && argv[i + 1] !== undefined) root = resolve(argv[++i] as string);
    else if (arg === '--squawk' && argv[i + 1] !== undefined) squawk = resolve(argv[++i] as string);
    else if (arg === '--list') list = true;
    else usage();
  }
  const dir = join(root, MIGRATIONS_DIR);
  if (!existsSync(dir)) {
    console.error(`lint-migrations: ${dir} does not exist`);
    return 2;
  }
  const names = readdirSync(dir);
  const { lint, badNames } = selectMigrations(names);
  for (const name of badNames) {
    console.error(
      `lint-migrations: ${MIGRATIONS_DIR}/${name} is not named NNNN_kebab-name.sql (db/AGENTS.md rule 1)`,
    );
  }
  const frozenProblems = checkFrozen(dir, names);
  for (const problem of frozenProblems) console.error(`lint-migrations: ${problem}`);
  const refused = badNames.length > 0 || frozenProblems.length > 0;
  if (list) {
    for (const name of lint) console.log(`${MIGRATIONS_DIR}/${name}`);
    return refused ? 1 : 0;
  }
  if (lint.length === 0) {
    if (refused) return 1;
    console.log(
      `lint-migrations: no migration after ${String(GATE_BASELINE).padStart(4, '0')} outside the frozen list, nothing to lint`,
    );
    return 0;
  }
  const files = lint.map((name) => `${MIGRATIONS_DIR}/${name}`);
  let failed = refused;
  // CT-06c context: db/schema.sql (absent in scratch roots) and the SQL of every migration before
  // the one being checked.
  const schemaPath = join(root, 'db/schema.sql');
  const schemaSql = existsSync(schemaPath) ? readFileSync(schemaPath, 'utf8') : '';
  const allSql = names
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
  const withIgnores: { file: string; sql: string }[] = [];
  for (const file of files) {
    const sql = readFileSync(join(root, file), 'utf8');
    if (/squawk-ignore/.test(sql)) withIgnores.push({ file, sql });
    const context: MigrationContext = {
      approved:
        APPROVED_GUARD_CHANGES[basename(file)] === createHash('sha256').update(sql).digest('hex'),
      schemaSql,
      migrationsSql: allSql.filter((m) => m.name < basename(file)).map((m) => m.sql),
    };
    for (const problem of checkMigration(file, sql, context)) {
      console.error(`lint-migrations: ${problem.file}:${problem.line}: ${problem.message}`);
      failed = true;
    }
    for (const line of checkTimeouts(file, sql)) {
      console.log(line);
      failed = true;
    }
  }
  if (failed) {
    console.error('lint-migrations: the gate refused the migrations above; squawk was not run');
    return 1;
  }
  // The squawk-cli package of the root devDependencies: pnpm links its launcher into .bin.
  const binary = squawk ?? join(resolve(import.meta.dirname, '../..'), 'node_modules/.bin/squawk');
  if (!existsSync(binary)) {
    console.error(
      `lint-migrations: ${binary} not found; run pnpm install (squawk-cli is a root devDependency)`,
    );
    return 2;
  }
  const config = join(root, CONFIG_FILE);
  if (!existsSync(config)) {
    console.error(`lint-migrations: ${config} not found`);
    return 2;
  }
  if (withIgnores.length > 0) {
    const refusals = ignoredFundsFindings(binary, config, withIgnores);
    if (refusals === null) {
      console.error('lint-migrations: cannot run squawk over the migrations without their ignores');
      return 2;
    }
    for (const refusal of refusals) console.error(`lint-migrations: ${refusal}`);
    if (refusals.length > 0) {
      console.error('lint-migrations: the gate refused the migrations above; squawk was not run');
      return 1;
    }
  }
  console.log(`lint-migrations: squawk over ${files.join(' ')}`);
  const res = spawnSync(binary, ['-c', config, '--reporter', 'gcc', ...files], {
    cwd: root,
    stdio: 'inherit',
  });
  if (res.error !== undefined) {
    console.error(`lint-migrations: cannot run squawk: ${res.error.message}`);
    return 2;
  }
  if (res.status === null) {
    console.error(`lint-migrations: squawk was killed by signal ${res.signal ?? 'unknown'}`);
    return 2;
  }
  return res.status !== 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`lint-migrations: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
