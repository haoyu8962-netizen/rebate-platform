// BR-WDR-05 (a): real SQL locks and real worker wiring; no business port is replaced.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import {
  PostgresQueryCompiler,
  sql,
  type Kysely,
  type KyselyPlugin,
  type QueryId,
  type Transaction,
} from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';
import { voucher } from '../../ledger/posting/kit.ts';
import { close, open, type Harness } from '../apply/kit.ts';
import { seedStatus } from '../state/kit.ts';
import { event, member, type Member } from '../went-negative-audit/fixtures.ts';

export function suite() {
  let h: Harness;
  let consumerDb: Kysely<DB>;
  const applicationName = `B2-09r-${randomUUID()}`;
  beforeAll(async () => {
    const testing = (await import(
      new URL('../../../../packages/db/src/testing/index.ts', import.meta.url).href
    )) as { createTestDatabase: Parameters<typeof open>[0] };
    h = await open(testing.createTestDatabase);
    const url = new URL(h.database.urlFor('couli_app'));
    // A broken lock order must fail within the test deadline, including cleanup.
    url.searchParams.set('options', '-c statement_timeout=12000 -c lock_timeout=10000');
    consumerDb = createDb({ connectionString: url.href, applicationName, max: 4 });
  }, 180_000);
  afterAll(async () => {
    try {
      if (consumerDb) await destroyDb(consumerDb);
    } finally {
      await close(h);
    }
  }, 60_000);
  return {
    get h() {
      return h;
    },
    get db() {
      return consumerDb;
    },
    applicationName,
  };
}

/** W9 itself is outside scope: seed its APPROVED/member_blocked result, with no transfer. */
export async function afterW9(h: Harness) {
  const f = await member(h);
  const id = await f.startWithdrawal(101n);
  await seedStatus(f, id, 'APPROVED');
  await h.db
    .withSchema('app')
    .updateTable('withdrawals')
    .set({
      hold_reason: 'member_blocked',
      hold_at: f.clock.now(),
      blocked_reason: 'NEGATIVE_BALANCE',
    })
    .where('app_id', '=', f.actor.appId)
    .where('id', '=', id)
    .execute();
  // This payload selects the real W9 follow-up branch of the registered worker handler.
  const job = { ...event(f), payload: { app_id: f.actor.appId, user_id: f.actor.userId } };
  return { f, id, job };
}

export async function balanceNowait(f: Member, db: Kysely<DB> = f.h.observer) {
  return sql`SELECT ab.account_id FROM app.account_balances ab
    JOIN app.ledger_accounts la ON la.app_id = ab.app_id AND la.id = ab.account_id
    WHERE ab.app_id = ${f.actor.appId} AND la.owner_id = ${f.actor.userId}
    FOR UPDATE OF ab NOWAIT`.execute(db);
}

export async function usersNowait(f: Member) {
  return sql`SELECT id FROM app.users
    WHERE app_id = ${f.actor.appId} AND id = ${f.actor.userId}
    FOR NO KEY UPDATE NOWAIT`.execute(f.h.observer);
}

type During = ((trx: Transaction<DB>) => Promise<void>) | undefined;

/** This connection holds exactly the requested row until the test explicitly releases it. */
export async function hold(f: Member, table: 'users' | 'account_balances') {
  const ready = Promise.withResolvers<number>();
  const gate = Promise.withResolvers<During>();
  const done = f.h.db.transaction().execute(async (trx) => {
    await sql`SET LOCAL statement_timeout = '12s'`.execute(trx);
    await sql`SET LOCAL lock_timeout = '10s'`.execute(trx);
    if (table === 'users') {
      const result = await sql`SELECT id FROM app.users
        WHERE app_id = ${f.actor.appId} AND id = ${f.actor.userId}
        FOR NO KEY UPDATE`.execute(trx);
      expect(result.rows).toHaveLength(1);
    } else {
      const rows = await f.ledger.lockBalances(trx, {
        appId: f.actor.appId,
        userIds: [f.actor.userId],
      });
      expect(rows).toHaveLength(1);
      expect((await usersNowait(f)).rows, '余额持锁方不能同时持有 users 行').toHaveLength(1);
    }
    const backend = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
    ready.resolve(backend.rows[0]!.pid);
    const during = await gate.promise;
    if (during) await during(trx);
  });
  // Propagate setup failures without leaving an unhandled rejection or a pending gate.
  void done.catch(ready.reject);
  const pid = await ready.promise;
  return {
    pid,
    async release(during?: During) {
      gate.resolve(during);
      await done;
    },
  };
}

/** Observe the actual waiting backend AND its blocker; elapsed time is never evidence. */
export async function waiting(
  db: Kysely<DB>,
  applicationName: string,
  holder: number,
  table: 'users' | 'account_balances',
) {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const result = await sql<{ pid: number; query: string; backend_xid: string | null }>`
      SELECT pid, query, backend_xid::text FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = ${applicationName}
        AND wait_event_type = 'Lock' AND ${holder}::int = ANY(pg_blocking_pids(pid))`.execute(db);
    if (result.rows.length > 0) {
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]!.query).toContain(table);
      return result.rows[0]!;
    }
  }
  expect.fail(`消费者未在 ${table} 上等待外部连接 ${holder}`);
}

/** Post on the already-held balance transaction; deliberately do NOT acquire users. */
export async function adjustHeld(f: Member, trx: Transaction<DB>, delta: bigint) {
  const [balance] = await f.ledger.lockBalances(trx, {
    appId: f.actor.appId,
    userIds: [f.actor.userId],
  });
  expect(balance).toBeDefined();
  const v = voucher(f.actor.appId, balance!.account_id, -delta);
  await f.ledger.post(trx, {
    ...v,
    entries: v.entries.map((entry) => ({ ...entry, ledger_type: 'ADMIN_ADJUST' })),
  });
}

/** Before W3 reacquires balances, inspect the real open-withdrawals SELECT result. */
export function beforeReject(inspect: () => Promise<void>) {
  const compiler = new PostgresQueryCompiler();
  const queries = new Set<QueryId>();
  let hits = 0;
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      const query = compiler.compileQuery(args.node, args.queryId);
      if (
        /^select\b/i.test(query.sql) &&
        /from "app"\."withdrawals"/i.test(query.sql) &&
        query.parameters.includes('PENDING_REVIEW') &&
        query.parameters.includes('APPROVED')
      ) {
        queries.add(args.queryId);
      }
      return args.node;
    },
    async transformResult(args) {
      if (queries.delete(args.queryId)) {
        hits += 1;
        await inspect();
      }
      return args.result;
    },
  };
  return { plugin, hits: () => hits };
}
