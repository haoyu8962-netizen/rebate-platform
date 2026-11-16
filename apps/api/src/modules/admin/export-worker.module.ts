// Export generation on the worker entry (B1-34e; BR-ID-42): app.module imports this module on
// `worker` only. It builds the export worker (./application/export-worker.ts) over DB, CLOCK,
// JOB_QUEUE, EXPORT_STORE and FIELD_CRYPTO (identity's users projection decrypts with it; the
// audit search's opaque ids derive from it), with identity's users reader and content's
// configuration reader handed in by app.module (admin does not assemble other modules), and
// registers its handler on JOB_QUEUE for queue `export` (in the worker's ENTRY_PLAN only).
// Nothing is seeded at startup: generate jobs are sent by the creating transaction, expire jobs by
// the done transaction. Without the database, the queue or the field cipher nothing is registered,
// EXPORT_WORKER provides null and one info line `export_worker_disabled` is logged.
// EXPORT_WORKER also carries cancelByCreator for the later account-disable wiring.
// B2-08e: the quarterly tax export's two ports (payout's B2-08d reader, identity's batch real names)
// come from app.module the same way; the option is required, so the entry cannot leave them out.
// CT-24zzm: the ledger export reads ledger's readAdminLedgerExportPage (the GET /admin/v1/ledger
// query) with identity's users-of-the-app check, the same port app.module gives that list; the
// option overrides it, and without it this default is built here from the two modules' index.ts.
//
// Also compiled by the `test` project: a class decorator only (dependencies through factories).
import { type DynamicModule, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ContentReader } from '../content/index.ts';
import { createUserDeletionStatusReader, type ExportUsersReader } from '../identity/index.ts';
import { readAdminLedgerExportPage } from '../ledger/index.ts';
import {
  CLOCK,
  DB,
  EXPORT_STORE,
  FIELD_CRYPTO,
  JOB_QUEUE,
  ROOT_LOGGER,
  SENSITIVE_KEYS,
  type Clock,
  type ExportStore,
  type FieldCrypto,
  type QueueRuntime,
  type RootLogger,
} from '../platform/index.ts';
import { createAuditLogsReader } from './application/audit-logs-read.ts';
import type { TaxExportPorts } from './application/tax-export-source.ts';
import {
  EXPORT_QUEUE,
  createExportWorker,
  type ExportWorker,
  type LedgerExportReader,
} from './application/export-worker.ts';
import type { ConfigPermissions } from './domain/audit-log-view.ts';
import { createAdminProfiles } from './infra/admin-profiles.ts';
import {
  createAuditLogIdCodec,
  keyringAuditLogIdKey,
  type AuditLogIdCodec,
} from './infra/audit-log-id.ts';
import { createAuditLogStore } from './infra/audit-log-store.ts';

/** Nest token of the worker entry's ExportWorker (null when unassembled). */
export const EXPORT_WORKER = Symbol('EXPORT_WORKER');

export interface ExportWorkerModuleOptions {
  /** identity's batch users projection (createExportUsersReader). */
  readonly users: (db: Kysely<Database>, crypto: FieldCrypto) => ExportUsersReader;
  /** payout's tax reader and identity's batch real names (decrypting with the field cipher). */
  readonly tax: (crypto: FieldCrypto) => TaxExportPorts;
  /** content's configuration reader (admin.export.* overrides; code defaults otherwise). */
  readonly config: (db: Kysely<Database>, clock: Clock) => Pick<ContentReader, 'configValue'>;
  /** One user's ledger for the ledger export (CT-24zzm); the default below when absent. */
  readonly ledger?: (db: Kysely<Database>) => LedgerExportReader;
  /** Configuration key → its permission point, for the audit search's derived permission. */
  readonly configPermissions?: ConfigPermissions;
}

/**
 * ledger's export page over identity's users of the app (a users row of this app, whatever its
 * deletion status: the list's own userExists port), every check on the page's transaction.
 */
export function defaultLedgerExportReader(db: Kysely<Database>): LedgerExportReader {
  return (input) =>
    readAdminLedgerExportPage(
      {
        db,
        ports: {
          userExists: async (handle, who) =>
            (
              await createUserDeletionStatusReader({ db: handle }).read(handle, {
                app_id: who.appId,
                user_ids: [who.userId],
              })
            ).has(who.userId),
        },
      },
      input,
    );
}

@Module({})
export class ExportWorkerModule {
  static forWorker(options: ExportWorkerModuleOptions): DynamicModule {
    return {
      module: ExportWorkerModule,
      providers: [
        {
          provide: EXPORT_WORKER,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            EXPORT_STORE,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            store: ExportStore,
            db?: Kysely<Database>,
            queue?: QueueRuntime,
            crypto?: FieldCrypto,
          ): ExportWorker | null => {
            if (db === undefined || queue === undefined || crypto === undefined) {
              logger.info(
                {
                  queue: EXPORT_QUEUE,
                  db: db !== undefined,
                  job_queue: queue !== undefined,
                  field_crypto: crypto !== undefined,
                },
                'export_worker_disabled',
              );
              return null;
            }
            const profiles = createAdminProfiles({ db });
            // Derived on first use, not at startup: only audit exports touch the keyring.
            let codec: AuditLogIdCodec | undefined;
            const worker = createExportWorker({
              db,
              clock,
              queue,
              store,
              users: options.users(db, crypto),
              tax: options.tax(crypto),
              ledger: (options.ledger ?? defaultLedgerExportReader)(db),
              auditLogs: createAuditLogsReader({
                store: createAuditLogStore({ db }),
                profiles,
                ids: () => (codec ??= createAuditLogIdCodec(keyringAuditLogIdKey(crypto))),
                configPermissions: options.configPermissions ?? new Map(),
              }),
              profiles,
              config: options.config(db, clock),
              logger,
              sensitiveKeys: SENSITIVE_KEYS,
            });
            queue.register(EXPORT_QUEUE, (job) => worker.handle(job));
            return worker;
          },
        },
      ],
      exports: [EXPORT_WORKER],
    };
  }
}
