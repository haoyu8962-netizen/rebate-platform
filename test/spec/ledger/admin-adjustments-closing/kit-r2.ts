// B2-12d round-2 helpers (claude-independent; spec-test r1 S1 on concurrency.int.test.ts:45,
// approve.int.test.ts:50/55 and gate.int.test.ts:147). kit.ts is not changed; these sit beside it.
// - A balance-only writer on the suite's second pool: it takes the member's account_balances row
//   through ledger.lockBalances only (never identity's users lock), so the barrier proves the
//   approval reads the balance again under the balance lock, not merely under the users lock.
//   Waiting is recognised with pg_blocking_pids, never with a timed bet.
// - A barrier inside the approval transaction: right after the approval's first FOR UPDATE on the
//   member's account_balances row it waits until opened, holding that lock.
// - A one-shot fault of the approval's late writes: the form update after the voucher `ADJ:{id}` was
//   inserted, or the adjustment_approve audit insert.
// Fixtures throw plain Errors; a missing behaviour fails as an assertion. No real personal data.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { DB } from '@couli/db';
import { PostgresQueryCompiler, sql, type KyselyPlugin, type Transaction } from 'kysely';
import { expect } from 'vitest';
import type {
  AccountBalance,
  PostingEntry,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { APPROVE_ACTION, type AdjustFixture } from './kit.ts';

function compiled(
  compiler: PostgresQueryCompiler,
  node: Parameters<PostgresQueryCompiler['compileQuery']>[0],
  queryId: Parameters<PostgresQueryCompiler['compileQuery']>[1],
): { text: string; params: string } {
  const out = compiler.compileQuery(node, queryId);
  return {
    text: out.sql,
    params: JSON.stringify(out.parameters, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// pg_blocking_pids.

async function backendPid(trx: Transaction<DB>): Promise<number> {
  const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
  const pid = rows[0]?.pid;
  if (typeof pid !== 'number') throw new Error('kit-r2: no backend pid');
  return pid;
}

/** How many sessions wait on a lock that backend `pid` holds. */
export async function waitersOn(f: AdjustFixture, pid: number): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`.execute(f.db);
  return rows[0]?.n ?? 0;
}

/** How many sessions block backend `pid`. */
export async function blockersOf(f: AdjustFixture, pid: number): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT
    cardinality(pg_blocking_pids(${pid}::int))::int AS n`.execute(f.db);
  return rows[0]?.n ?? 0;
}

/**
 * Polls `probe` (bounded: 1500 × 10 ms) until it is true; stops early once `gaveUp()` is true (the
 * other side already finished without waiting). Asserts it became true.
 */
export async function until(
  probe: () => Promise<boolean>,
  gaveUp: () => boolean,
  label: string,
): Promise<void> {
  let ok = false;
  for (let attempt = 0; attempt < 1500 && !ok; attempt += 1) {
    if (attempt > 0) await delay(10);
    ok = await probe();
    if (!ok && gaveUp()) break;
  }
  expect(ok, label).toBe(true);
}

/** Tracks whether a promise has settled, without leaving a rejection unhandled. */
export function settledFlag(promise: Promise<unknown>): () => boolean {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

// ---------------------------------------------------------------------------------------------
// A balance-only writer on the second pool.

export interface BalanceWriter {
  /** The writer's backend pid. */
  readonly pid: number;
  /** The member's balance row as the writer's lockBalances returned it (after any wait). */
  readonly locked: Promise<AccountBalance>;
  /** Lets the writer post its credit and commit. */
  open(): void;
  /** Settles when the writer's transaction has committed (or failed). */
  readonly done: Promise<void>;
  /** The uniq_key of the writer's credit voucher. */
  readonly uniqKey: string;
}

/**
 * On the suite's second pool: lockBalances of the member (no users lock), then, once opened, a
 * plain REBATE_CREDIT of `credit` to the member's available (as B2-12c kit shift writes a credit),
 * then commit.
 */
export async function balanceWriter(
  f: AdjustFixture,
  userId: string,
  credit: bigint,
): Promise<BalanceWriter> {
  if (credit <= 0n) throw new Error('kit-r2: the writer credits a positive amount');
  const uniqKey = `SEED:${randomUUID()}`;
  let gotPid!: (pid: number) => void;
  const pidReady = new Promise<number>((resolve) => {
    gotPid = resolve;
  });
  let gotLock!: (balance: AccountBalance) => void;
  let lockFailed!: (error: unknown) => void;
  const locked = new Promise<AccountBalance>((resolve, reject) => {
    gotLock = resolve;
    lockFailed = reject;
  });
  locked.catch(() => undefined);
  let opened!: () => void;
  const gate = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const done = f.s
    .holder()
    .transaction()
    .execute(async (trx) => {
      gotPid(await backendPid(trx));
      let balance: AccountBalance | undefined;
      try {
        [balance] = await f.ledger.lockBalances(trx, { appId: f.appId, userIds: [userId] });
      } catch (error: unknown) {
        lockFailed(error);
        throw error;
      }
      if (balance === undefined) {
        const error = new Error(`kit-r2: ${userId} has no ledger account`);
        lockFailed(error);
        throw error;
      }
      gotLock(balance);
      await gate;
      const line = (
        account: PostingEntry['account'],
        amount: bigint,
        user: boolean,
      ): PostingEntry => ({
        account,
        sub_account: 'available',
        amount_fen: amount,
        ledger_type: 'REBATE_CREDIT',
        sub_type: null,
        income_type: user ? 'SERVICE_FEE' : null,
      });
      await f.ledger.post(trx, {
        appId: f.appId,
        uniqKey,
        bizType: 'TEST_SEED',
        bizId: randomUUID(),
        operator: 'system',
        memo: null,
        orderKey: null,
        beneficiaryUserId: null,
        role: null,
        voucherKind: null,
        entries: [
          line({ ownerType: 'user', accountId: balance.account_id }, -credit, true),
          line({ ownerType: 'platform', subject: 'UNION_RECEIVABLE:taobao' }, credit, false),
        ],
      });
    });
  done.catch(() => undefined);
  const pid = await Promise.race([
    pidReady,
    done.then(
      () => -1,
      () => -1,
    ),
  ]);
  if (pid < 0) throw new Error('kit-r2: the writer finished before it reported its pid');
  return {
    pid,
    locked,
    open: () => opened(),
    done,
    uniqKey,
  };
}

// ---------------------------------------------------------------------------------------------
// A barrier inside the approval transaction.

export interface BalanceBarrier {
  /** Arms the barrier for the next FOR UPDATE on the member's balance row. */
  arm(): void;
  /** Resolves when the approval's balance lock was taken and the approval now waits. */
  readonly reached: Promise<void>;
  /** Lets the held statement return. */
  open(): void;
  readonly plugin: KyselyPlugin;
}

/**
 * On the admin entry's database handle: once armed, the first statement that locks
 * account_balances FOR UPDATE naming `userId` returns only after open() (one-shot).
 */
export function balanceBarrier(userId: string): BalanceBarrier {
  const compiler = new PostgresQueryCompiler();
  let armed = false;
  const flagged = new Set<string>();
  let hit!: () => void;
  const reached = new Promise<void>((resolve) => {
    hit = resolve;
  });
  let opened!: () => void;
  const gate = new Promise<void>((resolve) => {
    opened = resolve;
  });
  return {
    arm() {
      armed = true;
    },
    reached,
    open: () => opened(),
    plugin: {
      transformQuery({ node, queryId }) {
        if (!armed) return node;
        const { text, params } = compiled(compiler, node, queryId);
        if (
          /account_balances/i.test(text) &&
          /\bfor\s+update\b/i.test(text) &&
          (params.includes(userId) || text.includes(userId))
        ) {
          armed = false;
          flagged.add(queryId.queryId);
        }
        return node;
      },
      async transformResult({ result, queryId }) {
        if (flagged.delete(queryId.queryId)) {
          hit();
          await gate;
        }
        return result;
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// A one-shot fault of the approval's late writes.

/**
 * `form`: the first UPDATE of admin_adjustments naming the form issued after the INSERT of its
 * voucher `ADJ:{adjust_id}` (the write that turns the form APPROVED with its voucher_id).
 * `audit`: the INSERT of the adjustment_approve audit record.
 */
export type ApprovalFaultPoint = 'form' | 'audit';

export interface ApprovalFault {
  armed: boolean;
  tripped: number;
  readonly plugin: KyselyPlugin;
}

export function approvalFault(adjustId: string, point: ApprovalFaultPoint): ApprovalFault {
  const compiler = new PostgresQueryCompiler();
  const uniq = `ADJ:${adjustId}`;
  let voucherSeen = false;
  const fault: ApprovalFault = {
    armed: true,
    tripped: 0,
    plugin: {
      transformQuery({ node, queryId }) {
        if (!fault.armed) return node;
        const { text, params } = compiled(compiler, node, queryId);
        const names = (value: string) => params.includes(value) || text.includes(value);
        if (/insert\s+into\s+(?:"?app"?\s*\.\s*)?"?ledger_vouchers\b/i.test(text) && names(uniq)) {
          voucherSeen = true;
        }
        const hit =
          point === 'form'
            ? voucherSeen &&
              /update\s+(?:"?app"?\s*\.\s*)?"?admin_adjustments\b/i.test(text) &&
              names(adjustId)
            : /insert\s+into\s+(?:"?app"?\s*\.\s*)?"?audit_logs\b/i.test(text) &&
              names(APPROVE_ACTION);
        if (hit) {
          fault.armed = false;
          fault.tripped += 1;
          throw new Error(`synthetic failure of the approval at ${point}`);
        }
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    },
  };
  return fault;
}

// ---------------------------------------------------------------------------------------------
// Ledger reads.

export interface UserLine {
  readonly uniq_key: string;
  readonly amount_fen: bigint;
}

/** Every available entry on the member's own account, with its voucher key, by uniq_key. */
export async function userLines(f: AdjustFixture, userId: string): Promise<UserLine[]> {
  const result = await sql<{ uniq_key: string; amount_fen: string }>`
    SELECT v.uniq_key, e.amount_fen::text AS amount_fen
    FROM app.ledger_entries e
    JOIN app.ledger_vouchers v ON v.app_id = e.app_id AND v.id = e.voucher_id
    JOIN app.ledger_accounts a ON a.app_id = e.app_id AND a.id = e.account_id
    WHERE e.app_id = ${f.appId} AND a.owner_type = 'user' AND a.owner_id = ${userId}
      AND e.sub_account = 'available'
    ORDER BY v.uniq_key, e.amount_fen`.execute(f.db);
  return result.rows.map((row) => ({ uniq_key: row.uniq_key, amount_fen: BigInt(row.amount_fen) }));
}

/** Moves the fixture's clock forward to `iso` (which must be later). */
export function advanceTo(f: AdjustFixture, iso: string): void {
  const step = Date.parse(iso) - f.clock.now().getTime();
  if (!(step > 0)) throw new Error(`kit-r2: ${iso} is not after ${f.clock.now().toISOString()}`);
  f.clock.advanceMs(step);
}
