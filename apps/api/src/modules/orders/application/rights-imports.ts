// B1-09g: the admin Excel import tasks (contract adminCreateRightsImport / adminListRightsImports /
// adminGetRightsImport; 04 §3.2 rights_imports / rights_import_failures; 08 BR-FUND-06 细则
// 「维权导入任务」, BR-ATTR-26 细则「渠道单导入」). The routes stay planned and unmounted (J-1 / J-22):
// mounting is B1-09n. Permissions and the channel step-up are the HTTP layer's
// (http/admin/rights-imports.http.ts); these use cases get an authorised actor.
//
// createRightsImport, in this order:
//   ① the form (domain/rights-import.ts checkRightsImportForm) → 20001 data.fields; a channel
//      import's union_account_id must name a union account of the actor's app → else
//      20001 [union_account_id];
//   ② the file: absent, not an xlsx, unreadable, or more than 10,000 data rows under the header row
//      → 20001 [file]. Nothing is stored or written for a refused request;
//   ③ every accepted upload is a new task (no deduplication by file or content, BR-FUND-06): a new
//      import_id (UUIDv7), the bytes put into the private import store under
//      `<app_id>/<import_id>.xlsx` (rights_imports.file_path), then one transaction: the
//      rights_imports row (status queued, created_by the actor, created_at the injected Clock), one
//      audit record for the whole file (action rights_import_create, target
//      `rights_imports:<import_id>`, after: kind, platform, filename, total_rows, reason_sub —
//      B1-09v: the punish import's manual sub-reason as sent, `none` as is, null when not sent or
//      for rights / channel; rights_imports.reason_sub keeps the same value) and the job, sent
//      on that transaction: queue `order-sync` (orders' own queue, exclusive: singletonKey
//      `rights_import:<import_id>`), job name `rights_import`, payload { app_id, import_id } (never
//      the file, its name or its cells);
//   ④ answer { import_id, status: queued }.
// Logs carry ids and counts only, never the filename or any cell.
//
// listRightsImports / getRightsImport: rows of the app only, created_at descending (then id), the
// five tallies, created_by and created_by_name (display_name, else login_name), reason_sub as stored
// (B1-09v: `none` as sent; the key is left out when nothing was sent — the contract's「absent is
// the same as null」— and the HTTP layer writes it as null); the detail adds every
// row failure ordered by row_no. An import_id that is not a UUID, unknown, or of another app is
// 20001 [import_id]. Reading writes no audit.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import {
  newUuidV7,
  type AuditPort,
  type Clock,
  type ImportStore,
  type JobQueue,
  type RootLogger,
} from '../../platform/index.ts';
import {
  checkRightsImportForm,
  isPunishImportReasonSub,
  type RightsImportFormFields,
  type RightsImportStatus,
} from '../domain/rights-import.ts';
import { readRightsImportSheet } from '../infra/rights-import-sheet.ts';
import {
  findRightsImportWithName,
  insertRightsImport,
  listRightsImportFailures,
  listRightsImportRows,
  type RightsImportListRow,
} from '../infra/rights-import-store.ts';

export type RightsImportAuditAction = 'rights_import_create';

export interface RightsImportActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

/** The file part as read from the multipart body. */
export interface RightsImportUpload {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimetype: string;
}

export interface RightsImportCommand extends RightsImportFormFields {
  /** Absent → 20001 [file]. */
  readonly file?: RightsImportUpload | undefined;
}

export interface RightsImportDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly store: ImportStore;
  readonly queue: JobQueue;
  /** admin's audit writer bound to the task's transaction. */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  readonly logger: RootLogger;
}

export type RightsImportFieldsError = {
  readonly code: 20001;
  readonly data: { readonly fields: readonly string[] };
};

export type RightsImportCreateOutcome =
  { readonly code: 0; readonly data: Schema<'AdminRightsImportCreated'> } | RightsImportFieldsError;

export interface RightsImportPageQuery {
  /** From 1; a page past the last one has no items. */
  readonly page: number;
  /** 1..200 (the route schema refuses more). */
  readonly page_size: number;
}

export type RightsImportDetailOutcome =
  { readonly code: 0; readonly data: Schema<'AdminRightsImportDetail'> } | RightsImportFieldsError;

/** At most this many data rows under the header row (contract adminCreateRightsImport). */
export const RIGHTS_IMPORT_MAX_ROWS = 10_000;
/** orders' own queue and this job's name in it (B1-09g: no queue of its own). */
export const RIGHTS_IMPORT_QUEUE = 'order-sync';
export const RIGHTS_IMPORT_JOB = 'rights_import';
const AUDIT_ACTION: RightsImportAuditAction = 'rights_import_create';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_FKEY = 'rights_imports_union_account_fkey';

const fieldsError = (field: string): RightsImportFieldsError => ({
  code: 20001,
  data: { fields: [field] },
});

/** The (app_id, union_account_id) foreign key refused the row: no such account in this app. */
function isUnknownAccount(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === '23503' && constraint === ACCOUNT_FKEY;
}

/** Signals the foreign-key refusal out of the transaction (rolled back, nothing stored). */
class UnknownAccount extends Error {
  override readonly name = 'UnknownAccount';
}

/**
 * Operational failures (store, database, queue) propagate; nothing is answered for them.
 * The union account of a channel import is checked by the (app_id, union_account_id) foreign key
 * of rights_imports (an account of another app or none at all), inside the task's transaction and
 * before the file is stored: orders reads no union table. The file is put into the import store on
 * that transaction, after the row and before the audit and the job, so a refused or rolled-back
 * request stores nothing (a store write that outlives a failed commit is an unreferenced key).
 */
export async function createRightsImport(
  deps: RightsImportDeps,
  actor: RightsImportActor,
  command: RightsImportCommand,
): Promise<RightsImportCreateOutcome> {
  const checked = checkRightsImportForm(command);
  if (!checked.ok) return { code: 20001, data: { fields: [...checked.fields] } };
  const form = checked.form;
  const file = command.file;
  if (file === undefined) return fieldsError('file');
  const sheet = await readRightsImportSheet(file.bytes);
  if (sheet === null || sheet.rows.length > RIGHTS_IMPORT_MAX_ROWS) {
    deps.logger.info(
      { event: 'rights_import_refused', app_id: actor.appId, reason: 'file' },
      'rights import refused',
    );
    return fieldsError('file');
  }

  const reasonSub = form.kind === 'punish' ? (form.reason_sub ?? null) : null;
  const now = deps.clock.now();
  const importId = newUuidV7(now);
  const key = `${actor.appId}/${importId}.xlsx`;
  const totalRows = sheet.rows.length;
  try {
    await deps.db.transaction().execute(async (trx) => {
      try {
        await insertRightsImport(trx, {
          id: importId,
          app_id: actor.appId,
          kind: form.kind,
          platform: form.platform,
          union_account_id: form.kind === 'channel' ? form.union_account_id : null,
          time_basis: form.kind === 'channel' ? null : (form.window?.time_basis ?? null),
          from: form.kind === 'channel' ? null : (form.window?.from ?? null),
          to: form.kind === 'channel' ? null : (form.window?.to ?? null),
          reason_sub: reasonSub,
          file_path: key,
          created_by: actor.adminId,
          created_at: now,
        });
      } catch (error) {
        if (isUnknownAccount(error)) throw new UnknownAccount();
        throw error;
      }
      await deps.store.put({ key, bytes: file.bytes, contentType: XLSX });
      await deps.auditOn(trx).append({
        appId: actor.appId,
        actor: actor.adminId,
        action: AUDIT_ACTION,
        target: `rights_imports:${importId}`,
        before: null,
        after: {
          kind: form.kind,
          platform: form.platform,
          filename: file.filename,
          total_rows: totalRows,
          reason_sub: reasonSub,
        },
        ip: actor.ip,
      });
      await deps.queue.send(
        RIGHTS_IMPORT_QUEUE,
        RIGHTS_IMPORT_JOB,
        { app_id: actor.appId, import_id: importId },
        { trx, singletonKey: `${RIGHTS_IMPORT_JOB}:${importId}` },
      );
    });
  } catch (error) {
    if (error instanceof UnknownAccount) return fieldsError('union_account_id');
    throw error;
  }
  deps.logger.info(
    {
      event: 'rights_import_created',
      app_id: actor.appId,
      import_id: importId,
      kind: form.kind,
      total_rows: totalRows,
    },
    'rights import queued',
  );
  return { code: 0, data: { import_id: importId, status: 'queued' } };
}

type Summary = Schema<'AdminRightsImportSummary'>;

/** B1-09v: the stored manual sub-reason; no key when none was sent (absent = null, CT-24zw). */
function reasonSubOf(row: RightsImportListRow): Pick<Summary, 'reason_sub'> {
  const value = row.reason_sub ?? undefined;
  return isPunishImportReasonSub(value) ? { reason_sub: value } : {};
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : typeof value === 'string' ? value : value.toISOString();

function summaryOf(row: RightsImportListRow): Summary {
  return {
    import_id: row.id,
    kind: row.kind as Summary['kind'],
    platform: row.platform as Summary['platform'],
    status: row.status as RightsImportStatus,
    total_rows: row.total_rows,
    succeeded_rows: row.succeeded_rows,
    failed_rows: row.failed_rows,
    skipped_rows: row.skipped_rows,
    duplicate_rows: row.duplicate_rows,
    created_by: row.created_by,
    ...reasonSubOf(row),
    created_by_name: row.created_by_name,
    created_at: iso(row.created_at)!,
    finished_at: iso(row.finished_at),
  };
}

export async function listRightsImports(
  deps: Pick<RightsImportDeps, 'db'>,
  appId: string,
  query: RightsImportPageQuery,
): Promise<Schema<'AdminRightsImportPage'>> {
  const { page, page_size: size } = query;
  const { rows, total } = await listRightsImportRows(deps.db, appId, size, (page - 1) * size);
  return { items: rows.map(summaryOf), page, page_size: size, total };
}

export async function getRightsImport(
  deps: Pick<RightsImportDeps, 'db'>,
  appId: string,
  importId: string,
): Promise<RightsImportDetailOutcome> {
  if (!UUID.test(importId)) return fieldsError('import_id');
  const id = importId.toLowerCase();
  const row = await findRightsImportWithName(deps.db, appId, id);
  if (row === undefined) return fieldsError('import_id');
  const failures = await listRightsImportFailures(deps.db, appId, id);
  return {
    code: 0,
    data: {
      ...summaryOf(row),
      failures: failures.map((f) => ({
        row_no: f.row_no,
        reason: f.reason as Schema<'AdminRightsImportFailure'>['reason'],
      })),
    },
  };
}
