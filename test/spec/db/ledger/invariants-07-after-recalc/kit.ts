// B2-02zb / BR-FUND-19 ⑦ (D10-2219 new ticket C, D10-2224): execute the registered SQL, never
// emulate it. db/invariants is append-only: 11_negative-balance-drops-by-amount.sql and its
// superseded.json entry for 07_negative-balance-drops.sql belong to the implementation phase
// (B2-02l precedent, ../invariants-reverse/kit.ts), so nothing is written here and a missing
// registration or file fails as an assertion before anything reads it (never ENOENT).
//
// Mechanism the fixtures reproduce (apps/api/src/modules/ledger/application/ledger.ts, post):
// every user entry's balance_after_fen is the sub-account value of the balance cache
// (app.account_balances) after the whole voucher, so all entries of one voucher in one
// sub-account carry the same value, and account_version = cache version + 1 per voucher.
// A recalculation from the entries (BR-FUND-19「差异以分录为准修正」) only rewrites the cache; no
// voucher, no entry. Fixtures simulate both steps with plain UPDATEs of the cache (the B2-02x
// endpoint is not merged); the business role holds UPDATE on those columns.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createDb, destroyDb, type DB } from '@couli/db';
import { subFen } from '@couli/money';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { DAY, type Result } from '../invariants/kit.ts';

export { DAY, type Result } from '../invariants/kit.ts';

export const TIMEOUT = 120_000;
export const LEGACY = '07_negative-balance-drops.sql';
export const REPLACEMENT = '11_negative-balance-drops-by-amount.sql';
const DIRECTORY = new URL('../../../../../db/invariants/ledger/', import.meta.url);

/** Accounting dates around the check date (couli.check_date = DAY = 2032-06-15). */
export const DAYS = ['2032-06-13', '2032-06-14', DAY, '2032-06-16'] as const;

/** booked_at of an entry posted on an accounting date (16:00 +08:00 that day). */
export function bookedAt(date: string): string {
  return `${date}T08:00:00Z`;
}

/**
 * superseded.json on main before this ticket, verbatim. The implementation keeps every entry as
 * it is and adds exactly one: 07 → 11.
 */
export const BASELINE: readonly Replacement[] = [
  {
    file: '03_credit-unique.sql',
    replaced_by: '09_credit-unique-net.sql',
    reason:
      "BR-FUND-16 的更正写红冲凭证（沿用原 voucher_kind，uniq_key = 原键 + ':REVERSE'），旧 03 按 CREDIT 张数计会把原单与其红冲数成两张而报假差异；09 只在原凭证与其红冲的分录按（账户、子户、ledger_type、sub_type）逐项相加为 0 且红冲无多出分录项时视为抵消，再判同键有效入账至多一张；配对未完全抵消与孤立红冲都报差异，输出编号仍为 03。",
  },
  {
    file: '08_invalid-still-credited.sql',
    replaced_by: '10_invalid-still-credited-since-restore.sql',
    reason:
      'BR-FUND-19 ⑧ 与 BR-FUND-22：P7 后经平台恢复 R12 / R13 合法回到 CREDITED 的子订单，旧 08 因仍有成功的 INVALID_AFTER_SETTLE 记录而报假差异；10 只计 updated_at 不早于该单最后一次 R12 / R13（order_status_history 中 field = rebate、event = ADMIN_RESTORE、from_status 为 VOID / CLAWED_BACK 的 max(at)）的成功记录，从未恢复的单全部计入，platform_status = INVALID 一支不受恢复截断；其余口径、account / global 两种行与 detail 形状照旧，输出编号仍为 08。',
  },
];

export const LEDGER_TYPES = [
  'REBATE_CREDIT',
  'SHARE_CREDIT',
  'REFERRAL_CREDIT',
  'CLAWBACK',
  'SETTLE_ADJUST',
  'WITHDRAW_FREEZE',
  'WITHDRAW_PAID',
  'WITHDRAW_RETURN',
  'WITHDRAW_FEE',
  'TAX_WITHHOLD',
  'REWARD',
  'ADMIN_ADJUST',
  'BAD_DEBT_WRITEOFF',
] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];
export type SubAccount = 'available' | 'frozen';

interface Replacement {
  file: string;
  replaced_by: string;
  reason: string;
}
interface Database {
  urlFor(role: 'couli_app' | 'couli_readonly'): string;
  drop(): Promise<void>;
}
export interface UserAccount {
  id: string;
  app_id: string;
  owner_id: string;
}
export interface PlatformAccount {
  id: string;
  app_id: string;
}
export interface Line {
  account: UserAccount;
  sub: SubAccount;
  /** Signed storage amount: a user's balance moves by −amount_fen (user liability account). */
  amount: bigint;
  type: LedgerType;
  /** ledger_entries.sub_type; null when omitted. Metadata only: ⑦ exempts by uniq_key alone. */
  subType?: string;
}
export interface BookedEntry {
  id: string;
  account_id: string;
  sub_account: SubAccount;
}
export interface Booked {
  voucherId: string;
  uniqKey: string;
  entries: BookedEntry[];
}
export interface Cache {
  available: bigint;
  frozen: bigint;
  version: bigint;
}
export interface Fixture {
  db: Kysely<DB>;
  /** Runs each file in one read-only repeatable-read snapshot as couli_readonly. */
  check(files: readonly string[]): Promise<Result[][]>;
}

/**
 * Text of 07_negative-balance-drops.sql as merged by B2-02e. The directory is append-only: the
 * replacement must leave this file in place, byte for byte (line endings and trailing blanks
 * aside).
 */
export const LEGACY_TEXT = `-- BR-FUND-19 ⑦ 账户级：用户账户中每条使 balance_after_fen < 0 且较前一条下降的分录，其 ledger_type
-- 属于 {CLAWBACK, SETTLE_ADJUST, ADMIN_ADJUST}，或属于改派红冲凭证（uniq_key 含 :REASSIGN_REV:，
-- 迁移 R14：红冲沿用原流水类型，按凭证键识别）。
-- 任务 B2-02e。只读，一条 SELECT，检查全量历史（不按会计日过滤：先按会计日过滤再取前一条会错比）。
--
-- 口径
-- - 只看用户账户（owner_type = user）上写了 balance_after_fen 的分录，平台账户不参与。
-- - 前一条 = 同一 (app_id, 账户, 子户) 内按 account_version 排在前面的那条（同版本再按分录 id），
--   不跨账户、app 或子户比较；没有前一条时按 0 比较，首笔就为负也要查。
-- - 下降 = balance_after_fen 小于前一条的 balance_after_fen；持平、回升、降到 0 都不算。
-- - 改派红冲只认 uniq_key 里的 :REASSIGN_REV: 片段（strpos 精确匹配，不用 LIKE，避免下划线通配），
--   sub_type 或 voucher_kind 写成 REASSIGN_REV 都不算。
-- - detail 里的金额写成文本，避免 JSON 数字丢精度。
-- - checked_rows = 参与核对的用户分录条数。
WITH user_entries AS (
  SELECT
    e.app_id,
    e.account_id,
    e.id AS entry_id,
    e.voucher_id,
    e.sub_account,
    e.ledger_type,
    e.sub_type,
    e.account_version,
    e.balance_after_fen,
    LAG(e.balance_after_fen) OVER (
      PARTITION BY e.app_id, e.account_id, e.sub_account
      ORDER BY e.account_version, e.id
    ) AS previous_balance_after_fen
  FROM app.ledger_entries e
  JOIN app.ledger_accounts a ON a.app_id = e.app_id AND a.id = e.account_id
  WHERE a.owner_type = 'user'
    AND e.balance_after_fen IS NOT NULL
),
differences AS (
  SELECT
    ue.app_id,
    ue.account_id,
    jsonb_build_object(
      'entry_id', ue.entry_id::text,
      'voucher_id', ue.voucher_id::text,
      'uniq_key', v.uniq_key,
      'ledger_type', ue.ledger_type,
      'sub_type', ue.sub_type,
      'sub_account', ue.sub_account,
      'account_version', ue.account_version::text,
      'has_previous', ue.previous_balance_after_fen IS NOT NULL,
      'previous_balance_after_fen', COALESCE(ue.previous_balance_after_fen, 0)::text,
      'balance_after_fen', ue.balance_after_fen::text,
      'allowed_ledger_types', jsonb_build_array('CLAWBACK', 'SETTLE_ADJUST', 'ADMIN_ADJUST')
    ) AS detail
  FROM user_entries ue
  JOIN app.ledger_vouchers v ON v.app_id = ue.app_id AND v.id = ue.voucher_id
  WHERE ue.balance_after_fen < 0
    AND ue.balance_after_fen < COALESCE(ue.previous_balance_after_fen, 0)
    AND ue.ledger_type NOT IN ('CLAWBACK', 'SETTLE_ADJUST', 'ADMIN_ADJUST')
    AND strpos(v.uniq_key, ':REASSIGN_REV:') = 0
),
stats AS (
  SELECT count(*) AS checked_rows FROM user_entries
)
SELECT
  '07'::text AS invariant,
  st.checked_rows,
  'account'::text AS scope,
  df.app_id,
  df.account_id,
  df.detail
FROM differences df
CROSS JOIN stats st
UNION ALL
SELECT
  '07'::text AS invariant,
  st.checked_rows,
  'none'::text AS scope,
  NULL::text AS app_id,
  NULL::uuid AS account_id,
  NULL::jsonb AS detail
FROM stats st
WHERE NOT EXISTS (SELECT 1 FROM differences)
ORDER BY app_id, account_id, detail
`;

function normalized(text: string): string {
  return text.replace(/\r\n/g, '\n').trimEnd();
}

/** superseded.json, validated entry by entry ({ file, replaced_by, reason }, both files exist). */
export function registry(): Replacement[] {
  const path = new URL('superseded.json', DIRECTORY);
  expect(existsSync(path), 'superseded.json exists').toBe(true);
  const raw = readFileSync(path, 'utf8');
  expect(() => JSON.parse(raw) as unknown, 'superseded.json is valid JSON').not.toThrow();
  const parsed: unknown = JSON.parse(raw);
  expect(Array.isArray(parsed), 'superseded.json is an array').toBe(true);
  const rows = parsed as Replacement[];
  for (const row of rows) {
    expect(row).toEqual({
      file: expect.any(String),
      replaced_by: expect.any(String),
      reason: expect.any(String),
    });
    expect(row.reason.trim().length).toBeGreaterThan(0);
    expect(row.file).toMatch(/^\d+_[\w-]+\.sql$/);
    expect(row.replaced_by).toMatch(/^\d+_[\w-]+\.sql$/);
    expect(row.replaced_by).not.toBe(row.file);
    expect(existsSync(new URL(row.file, DIRECTORY)), `${row.file} exists`).toBe(true);
    expect(existsSync(new URL(row.replaced_by, DIRECTORY)), `${row.replaced_by} exists`).toBe(true);
  }
  expect(new Set(rows.map((row) => row.file)).size, 'one entry per replaced file').toBe(
    rows.length,
  );
  return rows;
}

/**
 * The negative-balance source check the directory loader runs today: 07 itself while nothing
 * replaces it, else the end of its replacement chain in superseded.json.
 */
export function active(): string {
  const rows = registry();
  const seen = new Set<string>();
  let current = LEGACY;
  for (;;) {
    expect(seen.has(current), `replacement chain of ${LEGACY} has no cycle`).toBe(false);
    seen.add(current);
    const next = rows.find((row) => row.file === current);
    if (next === undefined) break;
    current = next.replaced_by;
  }
  const superseded = new Set(rows.map((row) => row.file));
  expect(superseded.has(current), `${current} is loaded by the daily check`).toBe(false);
  expect(readdirSync(DIRECTORY), `${current} is in the directory`).toContain(current);
  return current;
}

/**
 * superseded.json registers 07 → 11 and nothing else new: every main entry (BASELINE) is kept
 * verbatim and in order; 07 is still there unchanged and the only 07_ file.
 */
export function registration(): Replacement {
  const rows = registry();
  const found = rows.filter((row) => row.file === LEGACY);
  expect(found, `superseded.json registers ${LEGACY}`).toHaveLength(1);
  const entry = found[0]!;
  expect(entry.replaced_by).toBe(REPLACEMENT);
  expect(entry.reason.trim().length).toBeGreaterThan(0);
  expect(
    rows.filter((row) => row.file !== LEGACY),
    'the main registrations stay as they are',
  ).toEqual(BASELINE);
  expect(rows, `the only new registration is ${LEGACY} → ${REPLACEMENT}`).toHaveLength(
    BASELINE.length + 1,
  );
  const names = readdirSync(DIRECTORY);
  expect(names.filter((name) => name.startsWith('07_'))).toEqual([LEGACY]);
  expect(names.filter((name) => name.startsWith('11_'))).toEqual([REPLACEMENT]);
  const legacy = readFileSync(new URL(LEGACY, DIRECTORY), 'utf8');
  expect(normalized(legacy), `${LEGACY} is unchanged (append-only directory)`).toBe(
    normalized(LEGACY_TEXT),
  );
  return entry;
}

/** The file as one read-only SELECT without comments. */
export function query(file: string): string {
  expect(existsSync(new URL(file, DIRECTORY)), `invariant SQL exists: ${file}`).toBe(true);
  const raw = readFileSync(new URL(file, DIRECTORY), 'utf8');
  const text = raw.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (token) =>
    token.startsWith("'") ? token : ' ',
  );
  const tokens = text.replace(/'(?:''|[^'])*'/g, ' ');
  expect(tokens.trim()).toMatch(/^(?:SELECT|WITH)\b/i);
  expect(tokens.trim().replace(/;\s*$/, '')).not.toContain(';');
  expect(tokens).not.toMatch(
    /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|CALL|DO|COPY|INTO)\b/i,
  );
  expect(tokens).not.toMatch(
    /\b(?:now|clock_timestamp|statement_timestamp|transaction_timestamp)\s*\(|\b(?:CURRENT_DATE|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP)\b/i,
  );
  return text.trim().replace(/;\s*$/, '');
}

/**
 * Row shape only. checked_rows may be 0 here (the empty ledger); every caller pins the exact
 * count instead: empty() for the empty ledger, the number of user entries written otherwise.
 */
export function validate(rows: readonly Result[], file: string): void {
  expect(rows.length, `${file}: differences or exactly one none row`).toBeGreaterThan(0);
  for (const row of rows) {
    expect(Object.keys(row).sort()).toEqual([
      'account_id',
      'app_id',
      'checked_rows',
      'detail',
      'invariant',
      'scope',
    ]);
    // A replacement keeps the output number of ⑦ (B2-02l / B2-04zzr precedent).
    expect(row.invariant, `${file}: output number stays 07`).toBe('07');
    expect(typeof row.checked_rows).toBe('bigint');
    expect(row.checked_rows).toBeGreaterThanOrEqual(0n);
    expect(row.checked_rows).toBe(rows[0]!.checked_rows);
    expect(['account', 'none']).toContain(row.scope);
    if (row.scope === 'none') {
      expect(rows).toHaveLength(1);
      expect(row).toMatchObject({ app_id: null, account_id: null, detail: null });
    } else {
      expect(typeof row.app_id).toBe('string');
      expect(row.account_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.detail).toBeTypeOf('object');
      expect(row.detail).not.toBeNull();
    }
  }
}

// A fresh clone per scenario; only the *.int.test.ts caller supplies the database factory.
export async function scenario(
  create: () => Promise<Database>,
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const database = await create();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  const reader = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
  try {
    await run({
      db,
      async check(files) {
        const selects = files.map((file) => [file, query(file)] as const);
        return reader
          .transaction()
          .setIsolationLevel('repeatable read')
          .execute(async (trx) => {
            await sql`SET TRANSACTION READ ONLY`.execute(trx);
            await sql`SELECT set_config('couli.check_date', ${DAY}, true)`.execute(trx);
            const results: Result[][] = [];
            for (const [file, select] of selects) {
              const { rows } = await sql.raw<Result>(select).execute(trx);
              validate(rows, file);
              const types = await sql
                .raw<Record<string, string>>(
                  `SELECT pg_typeof(invariant)::text AS invariant,
              pg_typeof(checked_rows)::text AS checked_rows, pg_typeof(scope)::text AS scope,
              pg_typeof(app_id)::text AS app_id, pg_typeof(account_id)::text AS account_id,
              pg_typeof(detail)::text AS detail FROM (${select}\n) AS result LIMIT 1`,
                )
                .execute(trx);
              expect(types.rows).toEqual([
                {
                  invariant: 'text',
                  checked_rows: 'bigint',
                  scope: 'text',
                  app_id: 'text',
                  account_id: 'uuid',
                  detail: 'jsonb',
                },
              ]);
              results.push(rows);
            }
            return results;
          });
      },
    });
  } finally {
    await Promise.all([destroyDb(db), destroyDb(reader)]);
    await database.drop();
  }
}

/** A user account with its balance cache row (0 / 0, version 0), as openUserAccount leaves it. */
export async function openUser(
  db: Kysely<DB>,
  appId: string,
  ownerId: string = randomUUID(),
): Promise<UserAccount> {
  const id = randomUUID();
  await sql`INSERT INTO app.ledger_accounts (id, app_id, owner_type, owner_id, subject)
    VALUES (${id}, ${appId}, 'user', ${ownerId}, 'USER_BALANCE')`.execute(db);
  await sql`INSERT INTO app.account_balances (app_id, account_id, available_fen, frozen_fen, version)
    VALUES (${appId}, ${id}, ${0n}, ${0n}, ${0n})`.execute(db);
  return { id, app_id: appId, owner_id: ownerId };
}

export async function openPlatform(db: Kysely<DB>, appId: string): Promise<PlatformAccount> {
  const id = randomUUID();
  await sql`INSERT INTO app.ledger_accounts (id, app_id, owner_type, owner_id, subject)
    VALUES (${id}, ${appId}, 'platform', 'platform', 'UNION_RECEIVABLE:taobao')`.execute(db);
  return { id, app_id: appId };
}

export async function cache(db: Kysely<DB>, a: UserAccount): Promise<Cache> {
  const { rows } = await sql<{ available_fen: bigint; frozen_fen: bigint; version: bigint }>`
    SELECT available_fen, frozen_fen, version FROM app.account_balances
    WHERE app_id = ${a.app_id} AND account_id = ${a.id}`.execute(db);
  expect(rows, `balance cache row of ${a.id}`).toHaveLength(1);
  const row = rows[0]!;
  return {
    available: BigInt(row.available_fen),
    frozen: BigInt(row.frozen_fen),
    version: BigInt(row.version),
  };
}

/**
 * Posts one voucher the way the ledger does: user lines in the given order (entry ids ascend in
 * that order), each carrying its sub-account's cache value after the whole voucher and the
 * account's next version; then a platform counter line for the remainder; then the cache.
 * `date` is the voucher's accounting date and the entries' booked_at day (default: DAY).
 * `voucherKind` fills ledger_vouchers.voucher_kind (null when omitted).
 */
export async function book(
  db: Kysely<DB>,
  voucher: {
    appId: string;
    counter: PlatformAccount;
    lines: readonly Line[];
    uniqKey?: string;
    date?: string;
    voucherKind?: string;
  },
): Promise<Booked> {
  const date = voucher.date ?? DAY;
  expect(voucher.lines.length).toBeGreaterThan(0);
  const after = new Map<string, { before: Cache; next: Cache }>();
  for (const line of voucher.lines) {
    expect(line.account.app_id).toBe(voucher.appId);
    expect(line.amount).not.toBe(0n);
    if (!after.has(line.account.id)) {
      const before = await cache(db, line.account);
      after.set(line.account.id, { before, next: { ...before, version: before.version + 1n } });
    }
    const target = after.get(line.account.id)!.next;
    if (line.sub === 'available') target.available = subFen(target.available, line.amount);
    else target.frozen = subFen(target.frozen, line.amount);
  }
  const voucherId = randomUUID();
  const uniqKey = voucher.uniqKey ?? `fixture:${randomUUID()}`;
  await sql`INSERT INTO app.ledger_vouchers
    (id, app_id, biz_type, biz_id, uniq_key, accounting_date, operator, voucher_kind)
    VALUES (${voucherId}, ${voucher.appId}, 'order', ${randomUUID()}, ${uniqKey}, ${date},
      'system', ${voucher.voucherKind ?? null})`.execute(db);
  const entries: BookedEntry[] = [];
  let net = 0n;
  for (const line of voucher.lines) {
    const next = after.get(line.account.id)!.next;
    const balanceAfter = line.sub === 'available' ? next.available : next.frozen;
    const { rows } = await sql<{ id: bigint | string }>`INSERT INTO app.ledger_entries
      (app_id, voucher_id, account_id, sub_account, amount_fen, ledger_type, sub_type,
       balance_after_fen, account_version, booked_at)
      VALUES (${voucher.appId}, ${voucherId}, ${line.account.id}, ${line.sub}, ${line.amount},
       ${line.type}, ${line.subType ?? null}, ${balanceAfter}, ${next.version}, ${bookedAt(date)})
      RETURNING id`.execute(db);
    entries.push({ id: String(rows[0]!.id), account_id: line.account.id, sub_account: line.sub });
    net = net + line.amount;
  }
  if (net !== 0n) {
    await sql`INSERT INTO app.ledger_entries
      (app_id, voucher_id, account_id, sub_account, amount_fen, ledger_type, booked_at)
      VALUES (${voucher.appId}, ${voucherId}, ${voucher.counter.id}, 'available',
       ${subFen(0n, net)}, ${voucher.lines[0]!.type}, ${bookedAt(date)})`.execute(db);
  }
  for (const [accountId, { before, next }] of after) {
    expect(next.frozen, 'the ledger never posts a negative frozen balance').toBeGreaterThanOrEqual(
      0n,
    );
    const result = await sql`UPDATE app.account_balances
      SET available_fen = ${next.available}, frozen_fen = ${next.frozen}, version = ${next.version}
      WHERE app_id = ${voucher.appId} AND account_id = ${accountId}
        AND version = ${before.version}`.execute(db);
    expect(result.numAffectedRows).toBe(1n);
  }
  return { voucherId, uniqKey, entries };
}

/** Step 1 of the recalculation case: the cache is changed so it no longer matches the entries. */
export async function drift(db: Kysely<DB>, a: UserAccount, available: bigint): Promise<void> {
  const result = await sql`UPDATE app.account_balances SET available_fen = ${available}
    WHERE app_id = ${a.app_id} AND account_id = ${a.id}`.execute(db);
  expect(result.numAffectedRows).toBe(1n);
}

/** Step 2: the cache is rewritten to the entry totals; no voucher and no entry is written. */
export async function recalc(db: Kysely<DB>, a: UserAccount): Promise<Cache> {
  const result = await sql`UPDATE app.account_balances b SET
      available_fen = COALESCE((SELECT -sum(e.amount_fen) FROM app.ledger_entries e
        WHERE e.app_id = b.app_id AND e.account_id = b.account_id
          AND e.sub_account = 'available'), 0)::bigint,
      frozen_fen = COALESCE((SELECT -sum(e.amount_fen) FROM app.ledger_entries e
        WHERE e.app_id = b.app_id AND e.account_id = b.account_id
          AND e.sub_account = 'frozen'), 0)::bigint
    WHERE b.app_id = ${a.app_id} AND b.account_id = ${a.id}`.execute(db);
  expect(result.numAffectedRows).toBe(1n);
  return cache(db, a);
}

/** Difference rows reduced to what identifies them: account and reported entry / voucher. */
export function reported(rows: readonly Result[]): string[] {
  return rows
    .filter((row) => row.scope !== 'none')
    .map((row) => {
      const detail = row.detail as Record<string, unknown>;
      return [row.app_id, row.account_id, detail['voucher_id'], detail['entry_id']]
        .map(String)
        .join('|');
    })
    .sort();
}

/** Empty ledger: each file returns exactly one none row with checked_rows = 0. */
export function empty(results: readonly (readonly Result[])[]): void {
  for (const rows of results) {
    expect(rows).toEqual([
      {
        invariant: '07',
        checked_rows: 0n,
        scope: 'none',
        app_id: null,
        account_id: null,
        detail: null,
      },
    ]);
  }
}

/** Number of user entries the vouchers wrote (each carries balance_after_fen). */
export function userEntries(booked: readonly Booked[]): bigint {
  return BigInt(booked.reduce((total, voucher) => total + voucher.entries.length, 0));
}

function stable(value: unknown): string {
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Every output field, one canonical string per row, sorted (row order is not compared). */
export function lines(rows: readonly Result[]): string[] {
  return rows
    .map((row) =>
      stable({
        invariant: row.invariant,
        checked_rows: row.checked_rows,
        scope: row.scope,
        app_id: row.app_id,
        account_id: row.account_id,
        detail: row.detail,
      }),
    )
    .sort();
}

/**
 * Runs the files on `conn` inside the caller's open transaction (so uncommitted rows of that
 * transaction are what they read), with the same check date as scenario().check.
 */
export async function checkIn(conn: Kysely<DB>, files: readonly string[]): Promise<Result[][]> {
  await sql`SELECT set_config('couli.check_date', ${DAY}, true)`.execute(conn);
  const results: Result[][] = [];
  for (const file of files) {
    const { rows } = await sql.raw<Result>(query(file)).execute(conn);
    validate(rows, file);
    results.push(rows);
  }
  return results;
}

export interface HistoryRows {
  accounts: {
    id: string;
    app_id: string;
    owner_type: string;
    owner_id: string;
    subject: string;
  }[];
  balances: {
    app_id: string;
    account_id: string;
    available_fen: bigint;
    frozen_fen: bigint;
    version: bigint;
  }[];
  vouchers: {
    id: string;
    app_id: string;
    uniq_key: string;
    accounting_date: string;
    voucher_kind: string | null;
  }[];
  entries: {
    app_id: string;
    voucher_id: string;
    account_id: string;
    sub_account: SubAccount;
    amount_fen: bigint;
    ledger_type: LedgerType;
    sub_type: string | null;
    balance_after_fen: bigint | null;
    account_version: bigint | null;
    booked_at: string;
  }[];
}

/** One INSERT per table, in list order (entry ids ascend in that order). */
export async function insertHistory(db: Kysely<DB>, rows: HistoryRows): Promise<void> {
  expect(rows.accounts.length).toBeGreaterThan(0);
  expect(rows.balances.length).toBeGreaterThan(0);
  expect(rows.vouchers.length).toBeGreaterThan(0);
  expect(rows.entries.length).toBeGreaterThan(0);
  await db.insertInto('ledger_accounts').values(rows.accounts).execute();
  await db.insertInto('account_balances').values(rows.balances).execute();
  await db
    .insertInto('ledger_vouchers')
    .values(
      rows.vouchers.map((v) => ({
        ...v,
        biz_type: 'order',
        biz_id: randomUUID(),
        operator: 'system',
      })),
    )
    .execute();
  await db.insertInto('ledger_entries').values(rows.entries).execute();
}

/** The row expected for a voucher: its first entry of the account in that sub-account. */
export function expectedRow(a: UserAccount, booked: Booked, sub: SubAccount = 'available'): string {
  const first = booked.entries.find(
    (entry) => entry.account_id === a.id && entry.sub_account === sub,
  );
  expect(first, `voucher ${booked.voucherId} has a ${sub} entry of ${a.id}`).toBeDefined();
  return [a.app_id, a.id, booked.voucherId, first!.id].join('|');
}
