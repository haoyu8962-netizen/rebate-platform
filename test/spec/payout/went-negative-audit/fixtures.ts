import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { PostgresQueryCompiler, type Kysely, type KyselyPlugin, type QueryId } from 'kysely';
import { expect, vi } from 'vitest';
import type { ReceivedJob } from '../../../../apps/api/src/modules/platform/queue/types.ts';
import * as negative from '../../../../apps/api/src/modules/payout/application/went-negative.ts';
import { assembled } from '../../notification/risk-state-message/worker-kit.ts';
import { stored } from '../../admin/system-audit/kit.ts';
import { fixture, success, type Harness } from '../apply/kit.ts';
import { snapshot } from '../state/kit.ts';

export const QUEUE = 'evt.payout-went-negative';

export async function member(h: Harness, balance = 101n, appId?: string) {
  const f = await fixture(h, { balance, ...(appId === undefined ? {} : { appId }) });
  // Configurable application step; use odd cent amounts to expose accidental rounding.
  await f.set('withdraw.amount_step_fen', 1);
  return {
    ...f,
    async startWithdrawal(amount = 101n) {
      return success(await h.db.transaction().execute((trx) => f.apply(trx, amount))).withdrawal_id;
    },
  };
}
export type Member = Awaited<ReturnType<typeof member>>;

export function event(f: Member): ReceivedJob {
  return {
    id: randomUUID(),
    queue: QUEUE,
    name: 'account.went_negative',
    attempt: 1,
    payload: {
      app_id: f.actor.appId,
      v: 1,
      occurred_at: f.clock.now().toISOString(),
      data: { user_id: f.actor.userId },
    },
  };
}

/** Capture only the instance the real AppModule constructs; do not supply any business ports. */
export async function worker(f: Member, db: Kysely<DB> = f.h.db) {
  const instances: negative.WentNegativeConsumer[] = [];
  const original = negative.createWentNegativeConsumer;
  const spy = vi.spyOn(negative, 'createWentNegativeConsumer').mockImplementation((options) => {
    const instance = original(options);
    instances.push(instance);
    return instance;
  });
  let app: Awaited<ReturnType<typeof assembled>>;
  try {
    app = await assembled('worker', db, f.clock);
  } finally {
    spy.mockRestore();
  }
  try {
    const registrations = app.registrations.filter((item) => item.name === QUEUE);
    expect(registrations).toHaveLength(1);
    expect(instances).toHaveLength(1);
    return {
      ...app,
      handle: registrations[0]!.handler,
      run: (input: { appId: string; userId: string }) => instances[0]!.run(input),
    };
  } catch (error) {
    await app.close();
    throw error;
  }
}

export async function audits(f: Member, db: Kysely<DB> = f.h.db) {
  return stored(db, f.actor.appId);
}

/** All persisted business effects, plus this delivery's deduplication claim. */
export async function effects(f: Member, job: ReceivedJob, db: Kysely<DB> = f.h.db) {
  return {
    ...(await snapshot(f, db)),
    audits: await audits(f, db),
    claims: await db
      .withSchema('app')
      .selectFrom('processed_events')
      .selectAll()
      .where('consumer', '=', 'payout-went-negative')
      .where('event_id', '=', job.id)
      .execute(),
  };
}

export async function expectAudit(f: Member, id: string, status: 'PENDING_REVIEW' | 'APPROVED') {
  // Filter by target only: duplicates or an incorrect action on this withdrawal must fail too.
  const rows = (await audits(f)).filter((row) => row.target === id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    app_id: f.actor.appId,
    admin_id: null,
    system_actor: 'system:payout',
    action: 'withdrawal_reject',
    target: id,
    ip: null,
    at: f.clock.now(),
  });
  expect(rows[0]!.before).toStrictEqual({ withdrawal_id: id, status });
  expect(rows[0]!.after).toStrictEqual({
    withdrawal_id: id,
    status: 'REJECTED',
    reason_code: 'NEGATIVE_BALANCE',
    note: null,
  });
}

/** Observe/fail after the real INSERT, before its transaction can commit. No writer is mocked. */
export function afterInsert(table: 'audit_logs' | 'ledger_entries', inspect: () => Promise<void>) {
  const queries = new Set<QueryId>();
  const compiler = new PostgresQueryCompiler();
  let hits = 0;
  const pattern = new RegExp(`insert into (?:"?app"?\\.)?"?${table}"?\\b`, 'i');
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      if (pattern.test(compiler.compileQuery(args.node, args.queryId).sql))
        queries.add(args.queryId);
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
