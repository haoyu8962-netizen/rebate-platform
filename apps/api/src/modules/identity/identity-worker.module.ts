// identity on the worker entry (B1-13g): the scheduled takeover / recheck of the paid bank-card
// verification records. app.module imports this module on `worker` only (the HTTP IdentityModule
// is never built there); entry.ts starts the timer after the worker services
// (startPayoutVerifyRecheck with payoutVerifyRecheckToken()). No controllers, no field cipher.
// Without a database payoutVerifyRecheckToken() provides null and one info line
// `payout_verify_recheck_disabled` is logged. The supplier is createBankCardVerifier(appEnv): the
// demo fake on local / test, null on staging / prod (one warn line `bank_card_verifier_unconfigured`;
// unknown rows then expire at their deadline, see ./application/payout-verify-recheck.ts).
//
// B1-27h: the data-copy queue's handler (personal information copies, BR-ID-40): with the
// database, JOB_QUEUE, EXPORT_STORE and FIELD_CRYPTO, createDataCopyWorker is built over the ports
// app.module hands in as `dataCopy` (the copy sources, the extraction code SMS sender, the inbox,
// admin's audit writer) and registered on JOB_QUEUE for queue `data-copy` (worker ENTRY_PLAN only);
// otherwise nothing is registered and one info line `identity_data_copy_worker_disabled` is logged.
// Nothing is seeded: generate jobs come from the registration transaction, expire jobs from the
// generation transaction.
//
// B1-02zw: the same registration also works the Apple revocation jobs of a console phone change
// (./application/apple-unbind-revocation.ts): one handler per queue, so it routes by job name.
//
// Also compiled by the `test` project: a class decorator only (dependencies through factories).
import { type DynamicModule, type FactoryProvider, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  EXPORT_STORE,
  FIELD_CRYPTO,
  JOB_QUEUE,
  ROOT_LOGGER,
  type AppConfig,
  type AuditPort,
  type Clock,
  type ExportStore,
  type FieldCrypto,
  type QueueRuntime,
  type RootLogger,
} from '../platform/index.ts';
import {
  DATA_COPY_QUEUE,
  createDataCopyWorker,
  type DataCopyCodeSender,
  type DataCopyInbox,
  type DataCopyWorker,
} from './application/data-copy-worker.ts';
import {
  APPLE_UNBIND_REVOKE_JOB,
  createAppleUnbindRevocation,
} from './application/apple-unbind-revocation.ts';
import type { PayoutAccountConfigPort } from './application/payout-account.ts';
import { createPayoutAccountVerifyAttempts } from './application/payout-account-verify-attempts.ts';
import {
  createPayoutVerifyRecheck,
  payoutVerifyRecheckToken,
  type PayoutVerifyRecheck,
} from './application/payout-verify-recheck.ts';
import { createBankCardVerifier } from './infra/fake-bank-card-verifier.ts';
import { unconfiguredAppleTokenRevoker } from './infra/unconfigured-apple-token-revoker.ts';
import type { AppleTokenRevoker } from './ports/apple-token-revoker.ts';
import type { PersonalDataCopySources } from './ports/personal-data-copy-sources.ts';

/** The other modules' ports of the copy worker, assembled by app.module. */
export interface IdentityDataCopyPorts {
  /** The sections of a copy (app.module's personalDataCopySources over the field cipher). */
  readonly sources: (clock: Clock, crypto: FieldCrypto) => PersonalDataCopySources;
  /** The extraction code SMS (notification's template SMS sender; the fake on local / test). */
  readonly sms: (deps: {
    readonly db: Kysely<Database>;
    readonly clock: Clock;
    readonly logger: RootLogger;
    readonly appEnv: AppConfig['appEnv'];
  }) => DataCopyCodeSender;
  /** The inbox message and its push (notification's push sending core). */
  readonly inbox: (clock: Clock, appEnv: AppConfig['appEnv']) => DataCopyInbox;
  /** admin's audit writer bound to a handle. */
  readonly auditWriter: (db: Kysely<Database>, clock: Clock) => AuditPort;
}

export interface IdentityWorkerModuleOptions {
  /** content's configuration reader on the caller's handle (app.module, as for IdentityModule). */
  readonly payoutAccountConfig: Omit<FactoryProvider<PayoutAccountConfigPort>, 'provide'>;
  /** B1-27h: the copy worker's ports; without them the data-copy handler is not registered. */
  readonly dataCopy?: IdentityDataCopyPorts;
  /** B1-02zw: the Apple revocation (app.module's, as for the deletion flow); default unconfigured. */
  readonly apple?: Omit<FactoryProvider<AppleTokenRevoker>, 'provide'>;
}

const WORKER_PAYOUT_ACCOUNT_CONFIG = Symbol('IDENTITY_WORKER_PAYOUT_ACCOUNT_CONFIG');
const WORKER_APPLE_REVOKER = Symbol('IDENTITY_WORKER_APPLE_REVOKER');

/** Nest token of the worker entry's DataCopyWorker (null when unassembled). */
export const DATA_COPY_WORKER = Symbol('IDENTITY_DATA_COPY_WORKER');

@Module({})
export class IdentityWorkerModule {
  static forWorker(options: IdentityWorkerModuleOptions): DynamicModule {
    return {
      module: IdentityWorkerModule,
      providers: [
        { ...options.payoutAccountConfig, provide: WORKER_PAYOUT_ACCOUNT_CONFIG },
        {
          ...(options.apple ?? { useFactory: () => unconfiguredAppleTokenRevoker() }),
          provide: WORKER_APPLE_REVOKER,
        },
        {
          provide: payoutVerifyRecheckToken(),
          inject: [
            CLOCK,
            ROOT_LOGGER,
            APP_CONFIG,
            WORKER_PAYOUT_ACCOUNT_CONFIG,
            { token: DB, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            appConfig: AppConfig,
            config: PayoutAccountConfigPort,
            db?: Kysely<Database>,
          ): PayoutVerifyRecheck | null => {
            if (db === undefined) {
              logger.info({}, 'payout_verify_recheck_disabled');
              return null;
            }
            const verifier = createBankCardVerifier(appConfig.appEnv);
            if (verifier === null) logger.warn({}, 'bank_card_verifier_unconfigured');
            const attempts = createPayoutAccountVerifyAttempts({
              db,
              clock,
              logger,
              verifier,
              config,
            });
            return createPayoutVerifyRecheck({ db, clock, logger, attempts });
          },
        },
        {
          provide: DATA_COPY_WORKER,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            APP_CONFIG,
            WORKER_APPLE_REVOKER,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
            { token: EXPORT_STORE, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            appConfig: AppConfig,
            apple: AppleTokenRevoker,
            db?: Kysely<Database>,
            queue?: QueueRuntime,
            store?: ExportStore,
            crypto?: FieldCrypto | null,
          ): DataCopyWorker | null => {
            const ports = options.dataCopy;
            if (
              ports === undefined ||
              db === undefined ||
              queue === undefined ||
              store === undefined ||
              crypto === undefined ||
              crypto === null
            ) {
              logger.info(
                {
                  queue: DATA_COPY_QUEUE,
                  ports: ports !== undefined,
                  db: db !== undefined,
                  job_queue: queue !== undefined,
                  export_store: store !== undefined,
                  field_crypto: crypto !== undefined && crypto !== null,
                },
                'identity_data_copy_worker_disabled',
              );
              return null;
            }
            const worker = createDataCopyWorker({
              db,
              clock,
              queue,
              store,
              sources: ports.sources(clock, crypto),
              crypto,
              sms: ports.sms({ db, clock, logger, appEnv: appConfig.appEnv }),
              inbox: ports.inbox(clock, appConfig.appEnv),
              auditWriter: ports.auditWriter,
              logger,
            });
            const revocation = createAppleUnbindRevocation({ crypto, apple, logger });
            queue.register(DATA_COPY_QUEUE, (job) =>
              job.name === APPLE_UNBIND_REVOKE_JOB ? revocation.handle(job) : worker.handle(job),
            );
            return worker;
          },
        },
      ],
      exports: [payoutVerifyRecheckToken(), DATA_COPY_WORKER],
    };
  }
}
