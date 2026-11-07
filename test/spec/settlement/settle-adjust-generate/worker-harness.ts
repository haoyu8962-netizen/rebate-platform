// B2-09zb worker harness (claude-independent, SPEC_REF 18f0015): the scheduled trigger of the
// positive-difference run on queue `settle` (task §9 触发: job `settle_adjust`, payload { app_id,
// platform, accounting_date }, singletonKey `settle_adjust:<app_id>:<platform>:<accounting_date>`,
// sent once the same (app, platform, D) `bill` run is done; settle_jobs records a `settle_adjust`
// row running → done / failed). Real pieces: SettlementModule.forWorker over the B2-04ze worker ports
// of ../worker/credit-kit.ts (commission, ledger, identity and risk exports; the asset snapshot
// complete; the configuration a map), the B2-04m credit harness's orders, users and ledger, the real
// bill job behind the handler. Synthetic: the job queue recorder (../worker/kit.ts), every row.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { JobHandler } from '../../../../apps/api/src/modules/platform/index.ts';
import type { Harness, SeededOrder } from '../credit/kit.ts';
import { workerPorts } from '../worker/credit-kit.ts';
import {
  FAKE_CRYPTO,
  fakeQueue,
  receivedJob,
  sendView,
  settleHandler,
  settlementModule,
  silentRootLogger,
  workerContext,
  type FakeQueue,
} from '../worker/kit.ts';

export const ADJUST_JOB = 'settle_adjust';

export function adjustKey(appId: string, platform: string, day: string): string {
  return `${ADJUST_JOB}:${appId}:${platform}:${day}`;
}

export function adjustSend(appId: string, platform: string, day: string) {
  return {
    queue: 'settle',
    name: ADJUST_JOB,
    payload: { app_id: appId, platform, accounting_date: day },
    singletonKey: adjustKey(appId, platform, day),
    delaySeconds: 0,
  };
}

/** The `settle_adjust` sends recorded so far, as send views. */
export function adjustSends(queue: FakeQueue) {
  return queue.sent.filter((job) => job.name === ADJUST_JOB).map(sendView);
}

export function billJob(appId: string, platform: string, day: string) {
  return receivedJob('bill', { app_id: appId, platform, accounting_date: day });
}

export function adjustJob(appId: string, platform: string, day: string) {
  return receivedJob(ADJUST_JOB, { app_id: appId, platform, accounting_date: day });
}

/** A new STATEMENT settlement record of `fen` (seq + 1) and orders.settle_commission_fen = fen. */
export async function raiseSettlement(h: Harness, o: SeededOrder, fen: bigint): Promise<number> {
  const top = await h.db
    .selectFrom('order_settlements')
    .select((eb) => eb.fn.max('seq').as('seq'))
    .where('app_id', '=', h.appId)
    .where('order_id', '=', o.orderId)
    .executeTakeFirst();
  const seq = (top?.seq ?? 0) + 1;
  const at = h.clock.now();
  await h.db.transaction().execute(async (trx) => {
    await trx
      .insertInto('order_settlements')
      .values({
        app_id: h.appId,
        order_id: o.orderId,
        seq,
        source: 'STATEMENT',
        settle_commission_fen: fen,
        settled_at: at,
        content_hash: randomUUID(),
        created_at: at,
      })
      .execute();
    await trx
      .updateTable('orders')
      .set({ settle_commission_fen: fen })
      .where('app_id', '=', h.appId)
      .where('order_id', '=', o.orderId)
      .execute();
  });
  return seq;
}

export interface AdjustWorker {
  readonly handler: JobHandler;
  readonly queue: FakeQueue;
}

/**
 * SettlementModule.forWorker(ports) in a Nest context on `db` at the harness clock, with a recording
 * queue and the harness's transactional event writer; runs `body` with the settle handler.
 */
export async function withAdjustWorker(
  h: Harness,
  db: Kysely<DB>,
  switches: ReadonlyMap<string, unknown>,
  body: (worker: AdjustWorker) => Promise<void>,
): Promise<void> {
  const { ports } = workerPorts(h, switches);
  const SettlementModule = await settlementModule();
  const queue = fakeQueue();
  const context = await workerContext(SettlementModule.forWorker(ports), {
    clock: h.clock,
    logger: silentRootLogger(),
    db,
    queue,
    crypto: FAKE_CRYPTO,
    events: { publish: h.publish },
  });
  try {
    await body({ handler: settleHandler(queue), queue });
  } finally {
    await context.close();
  }
}

/** The app's settle_jobs rows of one job. */
export function jobRows(h: Harness, job: string) {
  return h.db
    .selectFrom('settle_jobs')
    .selectAll()
    .where('app_id', '=', h.appId)
    .where('job', '=', job)
    .orderBy('created_at')
    .execute();
}

/** The app's settle_adjustments rows. */
export function candidateRows(h: Harness) {
  return h.db
    .selectFrom('settle_adjustments')
    .selectAll()
    .where('app_id', '=', h.appId)
    .orderBy('id')
    .execute();
}

export function adjustBatches(h: Harness) {
  return h.db
    .selectFrom('settle_adjust_batches')
    .selectAll()
    .where('app_id', '=', h.appId)
    .execute();
}
