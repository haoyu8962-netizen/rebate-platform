// B2-02zb / BR-FUND-19 ⑦ (D10-2224): with no recalculation in the history the cache always
// matches the entries, so the replacement must give the same rows as 07, row for row. Both SQL
// texts are executed as they are; the test does not compute the expected differences itself.
// Runs and seed only through @couli/testing. Each sample writes its history inside its own
// transaction (one INSERT per table), runs both versions there and rolls back, so every sample
// (shrunk ones included) sees its own history and nothing else.
// Coverage: the edges the comparison is about are reached by a fixed list of histories run
// through the same per-sample procedure before the property; only those are required to hit
// (the random part is recorded, never held to a minimum, so a small PROP_RUNS cannot fail it).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { addFen, subFen } from '@couli/money';
import { createPropStats, propRuns, propSeed, type PropStats } from '@couli/testing';
import fc from 'fast-check';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { APP, OTHER_APP } from '../invariants/kit.ts';
import {
  DAYS,
  LEDGER_TYPES,
  LEGACY,
  active,
  book,
  bookedAt,
  cache,
  checkIn,
  empty,
  expectedRow,
  insertHistory,
  lines,
  openPlatform,
  openUser,
  registration,
  reported,
  scenario,
  userEntries,
  type Booked,
  type HistoryRows,
  type LedgerType,
  type Line,
  type Result,
  type SubAccount,
} from './kit.ts';

const ALLOWED: readonly LedgerType[] = ['CLAWBACK', 'SETTLE_ADJUST', 'ADMIN_ADJUST'];
/** 2^31 fen: amounts and balances beyond it must survive both versions unchanged. */
const INT_LIMIT = 2_147_483_648n;
const OVER_LIMIT = 2_147_483_649n;
/** Index of the check date (DAY) in DAYS. */
const CHECK_DAY = 2;

// Never 0 (amount_fen <> 0); zero edges are built from legal non-zero lines (see shape).
const amount = fc.oneof(
  { arbitrary: fc.constantFrom(-1n, 1n), weight: 2 },
  { arbitrary: fc.bigInt({ min: -300n, max: -1n }), weight: 4 },
  { arbitrary: fc.bigInt({ min: 1n, max: 300n }), weight: 4 },
  { arbitrary: fc.constantFrom(-OVER_LIMIT, OVER_LIMIT), weight: 1 },
  { arbitrary: fc.bigInt({ min: -(2n ** 40n), max: -OVER_LIMIT }), weight: 1 },
  { arbitrary: fc.bigInt({ min: OVER_LIMIT, max: 2n ** 40n }), weight: 1 },
);
const plannedLine = fc.record({
  account: fc.integer({ min: 0, max: 2 }),
  sub: fc.constantFrom('available' as const, 'available' as const, 'frozen' as const),
  amount,
  type: fc.constantFrom(...LEDGER_TYPES),
  // Entry metadata: REASSIGN_REV here never exempts (only the uniq_key segment does).
  subType: fc.constantFrom(null, null, 'REASSIGN_REV' as const),
});
const plannedVoucher = fc.record({
  app: fc.integer({ min: 0, max: 1 }),
  // Voucher metadata: REASSIGN_REV here never exempts either.
  kind: fc.constantFrom(
    null,
    null,
    'CREDIT' as const,
    'CLAWBACK' as const,
    'REASSIGN_REV' as const,
  ),
  // reassign: R14 reversal key; decoys: an underscore wildcard and a longer segment name.
  key: fc.constantFrom(
    'plain' as const,
    'plain' as const,
    'reverse' as const,
    'reassign' as const,
    'wildcard' as const,
    'prefixed' as const,
  ),
  // net-zero: a debit and a credit of the same size in one sub-account (balance unchanged);
  // to-zero: one line of exactly the current balance (balance becomes 0).
  shape: fc.constantFrom(
    'free' as const,
    'free' as const,
    'free' as const,
    'net-zero' as const,
    'to-zero' as const,
  ),
  // Accounting dates never go back: 2 days before the check date up to the day after it.
  advance: fc.constantFrom(false, false, true),
  lines: fc.array(plannedLine, { minLength: 1, maxLength: 4 }),
});
const history = fc.array(plannedVoucher, { minLength: 1, maxLength: 12 });
type PlannedVoucher = typeof plannedVoucher extends fc.Arbitrary<infer T> ? T : never;

interface Account {
  id: string;
  app_id: string;
  owner_id: string;
}
interface Planned {
  account: Account;
  sub: SubAccount;
  amount: bigint;
  type: LedgerType;
  subType: string | null;
}
interface State {
  available: bigint;
  frozen: bigint;
  version: bigint;
}
interface Built {
  rows: HistoryRows;
  /** Voucher id → index in DAYS of its accounting date. */
  days: Map<string, number>;
  /** Vouchers tagged REASSIGN_REV only in voucher_kind / sub_type, not in uniq_key. */
  metadataOnly: Set<string>;
  userLines: bigint;
}

function magnitude(value: bigint): bigint {
  return value < 0n ? subFen(0n, value) : value;
}

function uniqKey(kind: PlannedVoucher['key'], owner: string): string {
  const id = randomUUID();
  if (kind === 'reverse') return `taobao:${id}:${owner}:self:REVERSE`;
  if (kind === 'reassign') return `taobao:${id}:${owner}:self:REASSIGN_REV:${randomUUID()}`;
  if (kind === 'wildcard') return `taobao:${id}:${owner}:self:REASSIGNXREV:${randomUUID()}`;
  if (kind === 'prefixed') return `taobao:${id}:${owner}:self:NOT_REASSIGN_REV:${randomUUID()}`;
  return `fixture:${id}`;
}

/**
 * The rows the ledger would have written for the plan (ledger.ts post): per voucher, every user
 * entry carries its sub-account's value after the whole voucher and the account's next version;
 * the cache ends equal to the entries.
 */
function build(plans: readonly PlannedVoucher[], stats: PropStats): Built {
  const rows: HistoryRows = { accounts: [], balances: [], vouchers: [], entries: [] };
  const shared = randomUUID();
  const users: Account[][] = [];
  const counters: string[] = [];
  for (const app of [APP, OTHER_APP]) {
    // The first owner has an account in both apps: no comparison across apps.
    const list: Account[] = [];
    for (const owner of [shared, randomUUID(), randomUUID()]) {
      const account = { id: randomUUID(), app_id: app, owner_id: owner };
      rows.accounts.push({ ...account, owner_type: 'user', subject: 'USER_BALANCE' });
      list.push(account);
    }
    users.push(list);
    const platform = randomUUID();
    rows.accounts.push({
      id: platform,
      app_id: app,
      owner_type: 'platform',
      owner_id: 'platform',
      subject: 'UNION_RECEIVABLE:taobao',
    });
    counters.push(platform);
  }
  const model = new Map<string, State>();
  const state = (id: string): State => {
    const known = model.get(id) ?? { available: 0n, frozen: 0n, version: 0n };
    model.set(id, known);
    return known;
  };
  const days = new Map<string, number>();
  const metadataOnly = new Set<string>();
  let day = 0;
  let userLines = 0n;
  for (const plan of plans) {
    if (plan.advance && day < DAYS.length - 1) day += 1;
    const accounts = users[plan.app]!;
    let planned: Planned[] = plan.lines.map((l) => ({
      account: accounts[l.account]!,
      sub: l.sub,
      amount: l.amount,
      type: l.type,
      subType: l.subType,
    }));
    const head = planned[0]!;
    const before = state(head.account.id)[head.sub];
    const meaningful = plan.key !== 'reassign' && !ALLOWED.includes(head.type);
    if (plan.shape === 'net-zero') {
      const size = magnitude(head.amount);
      planned = [
        { ...head, amount: size },
        { ...head, amount: subFen(0n, size), type: planned[1]?.type ?? head.type },
      ];
      if (head.sub === 'available' && before < 0n && meaningful) {
        stats.hit('net-zero-while-negative');
      }
    } else if (plan.shape === 'to-zero' && before !== 0n) {
      planned = [{ ...head, amount: before }];
      if (before > 0n && meaningful) stats.hit('exact-zero-from-positive');
    }
    // The ledger never takes frozen below zero (applyEntries): such lines go to available.
    const frozen = new Map<string, bigint>();
    for (const line of planned) {
      if (line.sub !== 'frozen') continue;
      const base = frozen.get(line.account.id) ?? state(line.account.id).frozen;
      frozen.set(line.account.id, subFen(base, line.amount));
    }
    const voucherLines = planned.map((line): Planned =>
      line.sub === 'frozen' && (frozen.get(line.account.id) ?? 0n) < 0n
        ? { ...line, sub: 'available' }
        : line,
    );
    const next = new Map<string, State>();
    const groups = new Map<string, number>();
    for (const line of voucherLines) {
      const known = state(line.account.id);
      const target = next.get(line.account.id) ?? { ...known, version: known.version + 1n };
      next.set(line.account.id, target);
      if (line.sub === 'available') target.available = subFen(target.available, line.amount);
      else target.frozen = subFen(target.frozen, line.amount);
      const group = `${line.account.id}:${line.sub}`;
      groups.set(group, (groups.get(group) ?? 0) + 1);
      if (line.sub === 'frozen') stats.hit('frozen-line');
      if (magnitude(line.amount) > INT_LIMIT) stats.hit('amount-over-2^31');
    }
    if ([...groups.values()].some((count) => count > 1)) stats.hit('same-sub-multi-line');
    if (plan.key === 'reassign') stats.hit('reassign-key');

    const voucherId = randomUUID();
    const appId = accounts[0]!.app_id;
    days.set(voucherId, day);
    if (
      plan.key !== 'reassign' &&
      (plan.kind === 'REASSIGN_REV' || voucherLines.some((l) => l.subType === 'REASSIGN_REV'))
    ) {
      metadataOnly.add(voucherId);
      stats.hit('reassign-metadata-only');
    }
    rows.vouchers.push({
      id: voucherId,
      app_id: appId,
      uniq_key: uniqKey(plan.key, voucherLines[0]!.account.owner_id),
      accounting_date: DAYS[day]!,
      voucher_kind: plan.kind,
    });
    let net = 0n;
    for (const line of voucherLines) {
      const after = next.get(line.account.id)!;
      const balance = line.sub === 'available' ? after.available : after.frozen;
      rows.entries.push({
        app_id: appId,
        voucher_id: voucherId,
        account_id: line.account.id,
        sub_account: line.sub,
        amount_fen: line.amount,
        ledger_type: line.type,
        sub_type: line.subType,
        balance_after_fen: balance,
        account_version: after.version,
        booked_at: bookedAt(DAYS[day]!),
      });
      userLines += 1n;
      net = addFen(net, line.amount);
      if (ALLOWED.includes(line.type) && balance < 0n) stats.hit('allowed-type-below-zero');
    }
    if (net !== 0n) {
      rows.entries.push({
        app_id: appId,
        voucher_id: voucherId,
        account_id: counters[plan.app]!,
        sub_account: 'available',
        amount_fen: subFen(0n, net),
        ledger_type: voucherLines[0]!.type,
        sub_type: null,
        balance_after_fen: null,
        account_version: null,
        booked_at: bookedAt(DAYS[day]!),
      });
    }
    for (const [id, after] of next) {
      expect(after.frozen, 'frozen never goes below zero').toBeGreaterThanOrEqual(0n);
      if (after.available < 0n) stats.hit('negative-balance');
      if (after.available < 0n && state(id).version === 0n) stats.hit('first-voucher-negative');
      if (magnitude(after.available) > INT_LIMIT || after.frozen > INT_LIMIT) {
        stats.hit('balance-over-2^31');
      }
      model.set(id, after);
    }
  }
  for (const list of users) {
    for (const account of list) {
      const known = state(account.id);
      rows.balances.push({
        app_id: account.app_id,
        account_id: account.id,
        available_fen: known.available,
        frozen_fen: known.frozen,
        version: known.version,
      });
    }
  }
  return { rows, days, metadataOnly, userLines };
}

function voucherOf(row: Result): string {
  return String((row.detail as Record<string, unknown>)['voucher_id']);
}

/**
 * One sample: writes the history inside its own transaction, runs both versions there,
 * compares them row for row and rolls back.
 */
async function sample(
  db: Kysely<DB>,
  file: string,
  plans: readonly PlannedVoucher[],
  stats: PropStats,
): Promise<void> {
  const built = build(plans, stats);
  await db.connection().execute(async (conn) => {
    await sql`BEGIN`.execute(conn);
    try {
      await insertHistory(conn, built.rows);
      const [legacy, current] = await checkIn(conn, [LEGACY, file]);
      for (const row of legacy!) {
        expect(row.checked_rows, `${LEGACY}: checked user entries`).toBe(built.userLines);
      }
      expect(lines(current!), `${file} vs ${LEGACY}`).toEqual(lines(legacy!));
      const reportedVouchers = legacy!
        .filter((row) => row.scope === 'account')
        .map((row) => voucherOf(row));
      const reportedDays = reportedVouchers.map((voucher) => built.days.get(voucher));
      if (reportedDays.length > 0) stats.hit('legacy-reports');
      if (reportedDays.some((d) => d !== undefined && d < CHECK_DAY)) {
        stats.hit('legacy-reports-before-check-date');
      }
      if (reportedDays.some((d) => d !== undefined && d > CHECK_DAY)) {
        stats.hit('legacy-reports-after-check-date');
      }
      if (reportedVouchers.some((voucher) => built.metadataOnly.has(voucher))) {
        stats.hit('legacy-reports-reassign-metadata');
      }
    } finally {
      await sql`ROLLBACK`.execute(conn);
    }
  });
}

type PlannedLine = PlannedVoucher['lines'][number];

function fixedLine(
  account: number,
  sub: SubAccount,
  amount: bigint,
  type: LedgerType,
  subType: PlannedLine['subType'],
): PlannedLine {
  return { account, sub, amount, type, subType };
}

function fixedVoucher(
  lines: PlannedLine[],
  options: Partial<Omit<PlannedVoucher, 'lines'>>,
): PlannedVoucher {
  return { app: 0, kind: null, key: 'plain', shape: 'free', advance: false, ...options, lines };
}

/**
 * Fixed histories, run before the property through sample(); together they reach every edge
 * the comparison is about (asserted on their own stats). Comments give the intended balances.
 */
function fixedHistories(): PlannedVoucher[][] {
  return [
    [
      // App 0, day 0. Account 0: the first voucher 0 → −30 by a fee whose voucher_kind and
      // sub_type say REASSIGN_REV under an ordinary key (reported, before the check date).
      fixedVoucher([fixedLine(0, 'available', 30n, 'WITHDRAW_FEE', 'REASSIGN_REV')], {
        kind: 'REASSIGN_REV',
      }),
      // Net-zero voucher on −30: a debit of 20 and a credit of 20 in one sub-account.
      fixedVoucher(
        [
          fixedLine(0, 'available', 20n, 'WITHDRAW_FEE', null),
          fixedLine(0, 'available', -20n, 'REBATE_CREDIT', null),
        ],
        { shape: 'net-zero', kind: 'CREDIT' },
      ),
      // Reassignment reversal key: −30 → −40.
      fixedVoucher([fixedLine(0, 'available', 10n, 'REBATE_CREDIT', null)], { key: 'reassign' }),
      // Allowed type below zero: −40 → −45; voucher_kind CLAWBACK.
      fixedVoucher([fixedLine(0, 'available', 5n, 'CLAWBACK', null)], { kind: 'CLAWBACK' }),
      // Account 1: credit 10, then exactly to zero by a fee (to-zero replaces the amount by 10).
      fixedVoucher([fixedLine(1, 'available', -10n, 'REBATE_CREDIT', null)], {}),
      fixedVoucher([fixedLine(1, 'available', 3n, 'WITHDRAW_FEE', null)], { shape: 'to-zero' }),
      // Account 2: a frozen line (0 → 50 frozen), then a credit beyond 2^31.
      fixedVoucher([fixedLine(2, 'frozen', -50n, 'WITHDRAW_FREEZE', null)], {}),
      fixedVoucher([fixedLine(2, 'available', -OVER_LIMIT, 'REBATE_CREDIT', null)], {}),
      // Day 1: a deduction beyond 2^31 → −2,147,483,651 (reported).
      fixedVoucher([fixedLine(2, 'available', 4_294_967_300n, 'TAX_WITHHOLD', null)], {
        advance: true,
      }),
      // Day 2 (the check date): decoy keys in app 1, credits only.
      fixedVoucher([fixedLine(0, 'available', -7n, 'REWARD', 'REASSIGN_REV')], {
        app: 1,
        key: 'wildcard',
        advance: true,
      }),
      fixedVoucher([fixedLine(0, 'available', -3n, 'REWARD', null)], { app: 1, key: 'prefixed' }),
      // Day 3: account 1 of app 0 goes 0 → −7 by a fee (reported, after the check date).
      fixedVoucher([fixedLine(1, 'available', 7n, 'WITHDRAW_FEE', null)], { advance: true }),
    ],
    [
      // The shared owner in both apps: the same deduction in each app, compared per app only.
      fixedVoucher([fixedLine(0, 'available', -5n, 'REBATE_CREDIT', null)], {}),
      fixedVoucher([fixedLine(0, 'available', 9n, 'WITHDRAW_FEE', null)], { app: 1 }),
      fixedVoucher([fixedLine(0, 'available', 9n, 'WITHDRAW_FEE', null)], {}),
    ],
  ];
}

it('[AC-B2-02zb#5] 属性：不含重算的随机过账历史（多分录凭证、同凭证同子户多条、available / frozen、首笔为负、白名单类型、改派红冲与相似键、voucher_kind / sub_type 写成 REASSIGN_REV 的普通键凭证、多账户多 app、校验日前后多日、超过 2^31 分的金额与余额、负余额下净零凭证、正余额恰扣到 0），缓存始终与分录一致时，当前生效的替换版与旧 07 输出的行逐行相同（含 checked_rows = 用户分录数）；空账本两版都只出一条 checked_rows = 0 的 none 行', async () => {
  // The replacement must be registered; a missing one is an assertion failure, never skipped.
  registration();
  const file = active();
  expect(file, 'the daily run must load a replacement of 07').not.toBe(LEGACY);

  // Fixed cases first, in their own database: zero edges and amounts beyond 2^31.
  await scenario(createTestDatabase, async ({ db, check }) => {
    empty(await check([LEGACY, file]));
    const counter = await openPlatform(db, APP);
    const all: Booked[] = [];
    async function post(voucherLines: readonly Line[]): Promise<Booked> {
      const booked = await book(db, { appId: APP, counter, lines: voucherLines });
      all.push(booked);
      return booked;
    }

    // Negative balance: the first voucher takes 0 → −30 (reported by both); then a debit of 20
    // and a credit of 20 in the same sub-account net to zero (−30 → −30): not reported.
    const negative = await openUser(db, APP);
    const opening = await post([
      { account: negative, sub: 'available', amount: 30n, type: 'WITHDRAW_FEE' },
    ]);
    const netZero = await post([
      { account: negative, sub: 'available', amount: 20n, type: 'WITHDRAW_FEE' },
      { account: negative, sub: 'available', amount: -20n, type: 'REBATE_CREDIT' },
    ]);
    expect(await cache(db, negative)).toMatchObject({ available: -30n });

    // Positive balance taken exactly to zero by a fee (10 → 0): not below zero, not reported.
    const positive = await openUser(db, APP);
    await post([{ account: positive, sub: 'available', amount: -10n, type: 'REBATE_CREDIT' }]);
    const toZero = await post([
      { account: positive, sub: 'available', amount: 10n, type: 'WITHDRAW_FEE' },
    ]);
    expect(await cache(db, positive)).toMatchObject({ available: 0n });

    // Beyond 2^31 fen: a credit of 2,147,483,649, a deduction of 4,294,967,300
    // (→ −2,147,483,651, reported), then a credit of 1 (→ −2,147,483,650, not reported).
    const large = await openUser(db, APP);
    await post([{ account: large, sub: 'available', amount: -OVER_LIMIT, type: 'REBATE_CREDIT' }]);
    const payout = await post([
      { account: large, sub: 'available', amount: 4_294_967_300n, type: 'TAX_WITHHOLD' },
    ]);
    const recovery = await post([
      { account: large, sub: 'available', amount: -1n, type: 'REWARD' },
    ]);
    expect(await cache(db, large)).toMatchObject({ available: -2_147_483_650n });

    const [legacy, current] = await check([LEGACY, file]);
    expect(reported(legacy!)).toEqual(
      [expectedRow(negative, opening), expectedRow(large, payout)].sort(),
    );
    const big = legacy!.find((row) => row.account_id === large.id);
    expect(big?.detail).toMatchObject({
      previous_balance_after_fen: '2147483649',
      balance_after_fen: '-2147483651',
    });
    for (const [name, rows] of [
      [LEGACY, legacy!],
      [file, current!],
    ] as const) {
      for (const quiet of [netZero, toZero, recovery]) {
        expect(
          reported(rows).filter((row) => row.includes(quiet.voucherId)),
          `${name}: voucher ${quiet.voucherId} is not reported`,
        ).toEqual([]);
      }
      for (const row of rows) {
        expect(row.checked_rows, `${name}: checked user entries`).toBe(userEntries(all));
      }
    }
    expect(lines(current!), `${file} vs ${LEGACY}`).toEqual(lines(legacy!));
  });

  const runs = propRuns();
  const fixedStats = createPropStats('B2-02zb#5 07 vs replacement (fixed histories)');
  const stats = createPropStats('B2-02zb#5 07 vs replacement');
  let samples = 0;
  await scenario(createTestDatabase, async ({ db, check }) => {
    empty(await check([LEGACY, file]));
    // Deterministic part: the fixed histories through the same per-sample procedure.
    for (const plans of fixedHistories()) await sample(db, file, plans, fixedStats);
    empty(await check([LEGACY, file]));
    // Random part.
    await fc.assert(
      fc.asyncProperty(history, async (plans) => {
        samples += 1;
        await sample(db, file, plans, stats);
        return true;
      }),
      { numRuns: runs, seed: propSeed() },
    );
    // Every sample was rolled back: the ledger is empty again.
    empty(await check([LEGACY, file]));
  });
  const fixedRecord = fixedStats.flush();
  // Recorded for the run report only; the random part has no minimum hit count.
  stats.flush();
  expect(samples).toBeGreaterThanOrEqual(runs);
  // The deterministic part must reach the cases the comparison is about.
  for (const bucket of [
    'legacy-reports',
    'legacy-reports-before-check-date',
    'legacy-reports-after-check-date',
    'legacy-reports-reassign-metadata',
    'negative-balance',
    'first-voucher-negative',
    'frozen-line',
    'same-sub-multi-line',
    'reassign-key',
    'reassign-metadata-only',
    'allowed-type-below-zero',
    'net-zero-while-negative',
    'exact-zero-from-positive',
    'amount-over-2^31',
    'balance-over-2^31',
  ]) {
    expect(fixedRecord.hits[bucket] ?? 0, `fixed-history coverage: ${bucket}`).toBeGreaterThan(0);
  }
}, 900_000);
