// B2-02t: the worker entry's handler of queue `ledger-credit-postcheck`
// (application/credit-postcheck.ts). The ports come from app.module (ledger imports neither payout
// nor commission): payout's createWithdrawHolds and commission's readCommissionAttribution. Without
// a database or queue nothing is registered.
import type { DynamicModule } from '@nestjs/common';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  CLOCK,
  DB as DB_TOKEN,
  JOB_QUEUE,
  ROOT_LOGGER,
  type Clock,
  type QueueRuntime,
  type RootLogger,
} from '../platform/index.ts';
import {
  CREDIT_POSTCHECK_QUEUE,
  createCreditPostcheck,
  type CreditPostcheckAttributionReader,
  type CreditPostcheckPayload,
} from './application/credit-postcheck.ts';
import type { LedgerMismatchHolds } from './application/daily-check-execute.ts';

export interface LedgerCreditPostcheckWorkerOptions {
  readonly holds: (clock: Clock, logger: RootLogger) => LedgerMismatchHolds;
  readonly readAttribution: CreditPostcheckAttributionReader;
}

/** The registration of the handler (false: no database or queue, nothing registered). */
const CREDIT_POSTCHECK_WORKER = Symbol('LEDGER_CREDIT_POSTCHECK_WORKER');

export class LedgerCreditPostcheckModule {
  static forWorker(options: LedgerCreditPostcheckWorkerOptions): DynamicModule {
    return {
      module: LedgerCreditPostcheckModule,
      providers: [
        {
          provide: CREDIT_POSTCHECK_WORKER,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB_TOKEN, optional: true },
            { token: JOB_QUEUE, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<DB>,
            queue?: QueueRuntime,
          ): boolean => {
            if (db === undefined || queue === undefined) {
              logger.info({ queue: CREDIT_POSTCHECK_QUEUE }, 'ledger_credit_postcheck_disabled');
              return false;
            }
            const checkLogger = logger.child({
              module: 'ledger',
              queue: CREDIT_POSTCHECK_QUEUE,
            });
            const check = createCreditPostcheck({
              db,
              clock,
              logger: checkLogger,
              readAttribution: options.readAttribution,
              holds: options.holds(clock, checkLogger),
            });
            // handle() validates the payload: a malformed one fails the job, never passes it.
            queue.register(CREDIT_POSTCHECK_QUEUE, (job) =>
              check.handle(job.payload as unknown as CreditPostcheckPayload),
            );
            return true;
          },
        },
      ],
    };
  }
}
