// B1-18gk rule test (claude-independent, D10-1263; 06_FUND BR-FUND-09 ②, BR-FUND-16; D10-770): the
// approval books each order on its own transaction under its locks (order key → the beneficiaries'
// users rows → their balance rows through ledger.lockBalances, approve.ts), so two approvals of
// different orders that credit one beneficiary run one after the other on that beneficiary's
// balance: both vouchers are written and the balance is the starting balance plus both differences
// (no lost update).
// A real overlap, not two calls that merely happen to run one after the other: the admin entry's
// executor holds the first approval right after its balance-row lock returned rows (the locks of
// the order, the users rows and the balance rows are held then) until pg_stat_activity shows the
// other approval's backend waiting on a lock behind it, then lets it go on. The admin entry runs on
// the production pool of 3 connections (../settle-adjust-approve/kit.ts).
// Example orders: 1234 (617 / 123 / 494, reserve 0) → 1300: +33 / +7 / +26; both orders' self is one
// user, each order has its own direct user, each order's candidates are in a batch of their own.
import type { DB } from '@couli/db';
import { addFen, subFen } from '@couli/money';
import { PostgresQueryCompiler, sql, type Kysely, type QueryId } from 'kysely';
import { expect, it } from 'vitest';
import {
  EXAMPLE,
  TIMEOUT,
  approveHarness,
  approveSuite,
  expectApproved,
  platformIncrease,
  result,
  userIncrease,
  within,
  withAdmin,
  type ApproveHarness,
  type OrderSpec,
  type SeededOrder,
  type Sent,
} from '../settle-adjust-approve/kit.ts';

const s = approveSuite();

const BALANCE_LOCK = /\baccount_balances\b[\s\S]*\bfor\s+update\b/i;
/** How long the held approval waits for the other one to queue behind its locks. */
const WAIT_MS = 30_000;

interface Waiter {
  readonly pid: number;
  readonly query: string;
  readonly blockers: number[];
}

interface LockHold {
  /** The admin entry's executor with the hold (AdminOptions.wrap). */
  wrap(db: Kysely<DB>): Kysely<DB>;
  /** Balance-row locks held at the hold (1 once the first approval locked its balances). */
  holds(): number;
  /** The backends seen waiting on a lock while the first approval was held. */
  waiters(): readonly Waiter[];
}

/** Backends of this database waiting on a heavyweight lock, with the pids that block them. */
async function lockWaiters(observer: Kysely<DB>): Promise<Waiter[]> {
  const { rows } = await sql<{ pid: number; query: string; blockers: number[] }>`
    select pid, query, pg_blocking_pids(pid) as blockers
      from pg_stat_activity
     where datname = current_database()
       and wait_event_type = 'Lock'
       and pid <> pg_backend_pid()
  `.execute(observer);
  return rows.filter((r) => r.blockers.length > 0);
}

/**
 * Holds the first select … for update on account_balances that returns rows (PostgreSQL has
 * granted the locks) until another backend of the database waits on a lock (polled through
 * `observer`, a pool other than the admin entry's), or `WAIT_MS` passed. Later locks pass through.
 */
function holdAtBalanceLock(observer: Kysely<DB>): LockHold {
  const watched = new Set<QueryId>();
  let held = 0;
  let seen: Waiter[] = [];
  return {
    wrap(db) {
      return db.withPlugin({
        transformQuery(args) {
          if (held === 0 && args.node.kind === 'SelectQueryNode') {
            const compiled = new PostgresQueryCompiler().compileQuery(args.node, args.queryId);
            if (BALANCE_LOCK.test(compiled.sql)) watched.add(args.queryId);
          }
          return args.node;
        },
        async transformResult(args) {
          if (!watched.delete(args.queryId)) return args.result;
          if (held > 0 || args.result.rows.length === 0) return args.result;
          held += 1;
          const until = Date.now() + WAIT_MS;
          while (Date.now() < until) {
            seen = await lockWaiters(observer);
            if (seen.length > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return args.result;
        },
      });
    },
    holds: () => held,
    waiters: () => seen,
  };
}

/** The order's +33 / +7 / +26 vouchers of `seq`. */
async function expectExampleVouchers(h: ApproveHarness, o: SeededOrder, seq: number) {
  await h.expectAdjust(o, seq, [
    ...userIncrease(o, 'self', 33n, seq),
    ...userIncrease(o, 'direct', 7n, seq),
    ...platformIncrease(o, 26n, seq),
  ]);
}

/** The net of every ledger line on the user's balance account (credit negative). */
async function userLineNet(h: ApproveHarness, userId: string): Promise<bigint> {
  const rows = await s.db
    .selectFrom('ledger_entries as e')
    .innerJoin('ledger_accounts as a', (join) =>
      join.onRef('a.id', '=', 'e.account_id').onRef('a.app_id', '=', 'e.app_id'),
    )
    .select(['e.amount_fen', 'e.sub_account'])
    .where('e.app_id', '=', h.appId)
    .where('a.owner_id', '=', userId)
    .where('a.subject', '=', 'USER_BALANCE')
    .execute();
  let net = 0n;
  for (const r of rows) if (r.sub_account === 'available') net = addFen(net, r.amount_fen);
  return net;
}

it(
  '[AC-B1-18gk#2] 两单（各在自己的批次）给同一受益人正差，两个连接并发批准、在锁处真正交错（一单持锁时另一单在锁上等待）：两单都 approved，两笔分录都在，该受益人余额 = 原余额 + 两单正差之和（无丢失更新）',
  async () => {
    const h = await approveHarness(s);
    const first = await h.raised(EXAMPLE, 1300n);
    const firstBatch = await h.generate();
    const shared = first.o.user('self');
    const sharedSelf: OrderSpec = {
      ...EXAMPLE,
      people: [
        { role: 'self', ratioBp: 5000, userId: shared },
        { role: 'direct', ratioBp: 1000 },
      ],
    };
    const second = await h.raised(sharedSelf, 1300n);
    const secondBatch = await h.generate();
    expect(secondBatch).not.toBe(firstBatch);
    expect(second.o.user('self')).toBe(shared);
    expect(second.o.user('direct')).not.toBe(first.o.user('direct'));
    h.clock.advanceMs(60_000);
    // Both orders credited 617 to the shared self.
    const start = await h.balance(shared);
    expect(start).toBe(1234n);
    const hold = holdAtBalanceLock(s.db);

    await withAdmin(
      s,
      h,
      async (a) => {
        const sent: Sent[] = await within(
          120_000,
          Promise.all([a.approve(firstBatch), a.approve(secondBatch)]),
          'two concurrent approvals crediting one beneficiary',
        );
        await expectApproved(sent[0]!, firstBatch, [result(first.o, 'approved', 40)]);
        await expectApproved(sent[1]!, secondBatch, [result(second.o, 'approved', 40)]);
      },
      { wrap: (db) => hold.wrap(db) },
    );

    // The overlap really happened: one approval held its balance lock while the other waited.
    expect(hold.holds()).toBe(1);
    expect(hold.waiters().length, 'a backend waiting behind the held approval').toBeGreaterThan(0);
    // It waits on the shared beneficiary's rows (users row, then balance row: approve.ts' order).
    expect(
      hold
        .waiters()
        .map((w) => w.query)
        .join('\n'),
    ).toMatch(/\b(?:users|account_balances)\b[\s\S]*\bfor\s+(?:no\s+key\s+)?update\b/i);

    await expectExampleVouchers(h, first.o, first.seq);
    await expectExampleVouchers(h, second.o, second.seq);
    const expected = addFen(addFen(start, 33n), 33n);
    expect(await h.balance(shared)).toBe(expected);
    // The cached balance agrees with the shared user's lines (credit negative): nothing lost.
    expect(subFen(0n, await userLineNet(h, shared))).toBe(expected);
    expect(await h.balance(first.o.user('direct'))).toBe(130n);
    expect(await h.balance(second.o.user('direct'))).toBe(130n);
    for (const { o } of [first, second]) {
      expect((await h.rowsOf(o)).map((r) => r.status)).toEqual([
        'approved',
        'approved',
        'approved',
      ]);
      expect(await h.read(o)).toMatchObject({ booked_base_fen: 1300n, booked_n_fen: 1300n });
    }
  },
  TIMEOUT,
);
