// B2-04ze (D10-443): the settle queue's pieces on the worker entry, built from the ports app.module
// hands in (worker/ports.ts) and the runtime handles the worker module resolves. Free of Nest.
// - the handler of queue settle over the real bill job (production readSource and
//   saveBillValidations), the batch executor, the single-order credit and the beneficiary credit;
//   both credits read the attribution through ports.readAttribution (never readSnapshot);
// - the timer of the daily bill seed, the bill catch-up (B2-04zg: the latest bill day whose bill
//   month is not generated; the first tick is the worker's self-heal) and the due batch scan (first
//   tick within 60 s, then every 60 s, unref); stop() clears it and waits for a tick in flight, so
//   nothing is sent afterwards.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, EventBus, FieldCrypto, JobHandler, JobQueue } from '../../platform/index.ts';
import {
  createBatchExecutor,
  type BeneficiaryItemCredit,
  type BeneficiaryItemInput,
  type BeneficiaryItemResult,
} from '../batch/executor/executor.ts';
import { createBillSourceReader } from '../bill/infra/bill-source.ts';
import { saveBillValidations } from '../bill/infra/bill-validations.ts';
import { createBillJob } from '../bill/job.ts';
import { createBeneficiaryGate } from '../credit/beneficiary-gate.ts';
import {
  createBeneficiaryCredit,
  type BeneficiaryCredit,
} from '../credit/beneficiary/beneficiary-credit.ts';
import { createCreditOrder, type BeneficiaryEventInput } from '../credit/credit-order.ts';
import { createSettleCatchUpStore, seedSettleBillCatchUp } from './catch-up.ts';
import type { SettlementWorkerPorts } from './ports.ts';
import { createSettleRunStore } from './run-store.ts';
import {
  createSettleJobHandler,
  scanDueBatches,
  seedSettleBills,
  type SettleScheduleLogger,
} from './schedule.ts';

/** The first tick after start (the queue runtime starts meanwhile). */
export const SETTLE_WORKER_FIRST_TICK_MS = 5_000;
/** Between two ticks. */
export const SETTLE_WORKER_TICK_INTERVAL_MS = 60_000;

/** The logger the worker pieces share (pino's shape). */
export type SettleWorkerLogger = SettleScheduleLogger;

export interface SettleWorkerRuntime {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly crypto: FieldCrypto;
  readonly events: Pick<EventBus, 'publish'>;
  readonly logger: SettleWorkerLogger;
}

/** B2-04q's result as the executor's item result; the obligation must be the item's own. */
function itemCredit(credit: BeneficiaryCredit): BeneficiaryItemCredit {
  return {
    async execute(
      trx: Transaction<DB>,
      item: BeneficiaryItemInput,
    ): Promise<BeneficiaryItemResult> {
      const answer = await credit.execute(trx, {
        appId: item.appId,
        orderId: item.orderId,
        beneficiaryCreditId: item.beneficiaryCreditId,
        expectedSettleSeq: item.expectedSettleSeq,
        closedRef: item.itemId,
      });
      if (answer.outcome === 'skipped') return { result: 'skipped', reason: answer.reason };
      if (
        answer.beneficiaryCreditId !== item.beneficiaryCreditId ||
        answer.userId !== item.userId ||
        answer.role !== item.role
      ) {
        // Rolls the item transaction back: the obligation answered is not the item's.
        throw new Error(`settle batch item ${item.itemId}: obligation does not match the item`);
      }
      switch (answer.outcome) {
        case 'credited':
          return { result: 'credited', amountFen: answer.amountFen };
        case 'deferred':
          return { result: 'deferred' };
        case 'forfeited':
          // The obligation is closed (forfeited, voucher to the platform): nothing credited to the
          // beneficiary, so the item is a skip that names the forfeiture and its reason.
          return { result: 'skipped', reason: `forfeited:${answer.forfeitReason}` };
      }
    },
  };
}

/** The handler of queue settle over the real bill job, executor and credits. */
export function createSettleWorkerHandler(
  ports: SettlementWorkerPorts,
  runtime: SettleWorkerRuntime,
): JobHandler {
  const { db, clock, crypto, events, logger } = runtime;
  const config = ports.config(db, clock);
  const ledger = ports.ledger(clock, events);
  const gate = createBeneficiaryGate({
    clock,
    lockUsers: ports.lockUsers,
    deletionStatus: ports.deletionStatus(db),
    realnameStatus: ports.realnameStatus(db),
    riskState: ports.riskState(db),
    minors: ports.minors(crypto),
  });
  // commission's writer takes the clock as its third argument; the credits pass (trx, input).
  const appendBeneficiaryEvent = (trx: Transaction<DB>, input: BeneficiaryEventInput) =>
    ports.appendBeneficiaryEvent(trx, input, { clock });
  const creditOrder = createCreditOrder({
    clock,
    logger,
    ledger,
    gate,
    readAttribution: ports.readAttribution,
    readSnapshot: ports.readSnapshot,
    readTljDeductFen: ports.readTljDeductFen,
    appendBeneficiaryEvent,
    events,
  });
  const beneficiaryCredit = createBeneficiaryCredit({
    clock,
    logger,
    ledger,
    gate,
    readAttribution: ports.readAttribution,
    readSnapshot: ports.readSnapshot,
    readOrderNets: ports.readOrderNets,
    appendBeneficiaryEvent,
  });
  const executor = createBatchExecutor({
    db,
    clock,
    logger,
    config,
    snapshotStatus: ports.snapshotStatus,
    creditOrder,
    creditBeneficiary: itemCredit(beneficiaryCredit),
    events,
  });
  const bill = createBillJob({
    clock,
    config,
    readSource: createBillSourceReader({ readUnionAuthoritative: ports.readUnionAuthoritative }),
    readSnapshot: ports.readSnapshot,
    readTljDeductFen: ports.readTljDeductFen,
    snapshotStatus: ports.snapshotStatus,
    registerDiff: ports.registerDiff,
    saveValidations: saveBillValidations,
  });
  return createSettleJobHandler({ db, logger, bill, executor });
}

export interface SettleWorkerTimer {
  start(): void;
  /** Clears the timer and resolves once a tick in flight has finished. */
  stop(): Promise<void>;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** The daily bill seed, the bill catch-up and the due batch scan on the module's own timer. */
export function createSettleWorkerTimer(
  ports: Pick<SettlementWorkerPorts, 'platforms' | 'config'>,
  runtime: Pick<SettleWorkerRuntime, 'db' | 'clock' | 'queue' | 'logger'>,
): SettleWorkerTimer {
  const { db, clock, queue, logger } = runtime;
  const runs = createSettleRunStore(db);
  const catchUpRuns = createSettleCatchUpStore(db);
  const config = ports.config(db, clock);
  let stopped = false;
  let started = false;
  let inFlight: Promise<void> | null = null;
  let first: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;

  async function runTick(): Promise<void> {
    try {
      await seedSettleBills({ db, clock, queue, logger, runs, platforms: ports.platforms });
    } catch (error: unknown) {
      logger.warn({ queue: 'settle', error_name: errorName(error) }, 'settle_bill_seed_failed');
    }
    if (stopped) return;
    try {
      await seedSettleBillCatchUp({
        db,
        clock,
        queue,
        logger,
        runs: catchUpRuns,
        platforms: ports.platforms,
        config,
      });
    } catch (error: unknown) {
      logger.warn({ queue: 'settle', error_name: errorName(error) }, 'settle_bill_catch_up_failed');
    }
    if (stopped) return;
    try {
      await scanDueBatches({ db, clock, queue, logger });
    } catch (error: unknown) {
      logger.warn({ queue: 'settle', error_name: errorName(error) }, 'settle_batch_scan_failed');
    }
  }

  function tick(): void {
    if (stopped || inFlight !== null) return;
    inFlight = runTick().finally(() => {
      inFlight = null;
    });
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      first = setTimeout(() => {
        first = undefined;
        if (stopped) return;
        tick();
        interval = setInterval(tick, SETTLE_WORKER_TICK_INTERVAL_MS);
        interval.unref();
      }, SETTLE_WORKER_FIRST_TICK_MS);
      first.unref();
    },
    async stop() {
      stopped = true;
      if (first !== undefined) clearTimeout(first);
      if (interval !== undefined) clearInterval(interval);
      first = undefined;
      interval = undefined;
      if (inFlight !== null) await inFlight;
    },
  };
}
