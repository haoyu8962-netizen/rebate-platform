// Export generation worker (B1-34e; BR-ID-42 后台导出任务, BR-ID-33; contract CT-24k
// adminCreateExport). Handler of queue `export` (worker entry only), payload { appId, taskId } with
// taskId the internal UUID; job names:
//   - generate: claim pending → running under a per-creator advisory lock (count the creator's
//     running tasks, then CAS; at capacity the task stays pending and a delayed generate job is
//     sent in the same transaction), read the source list page by page (users through identity's
//     batch projection, masked unless the persisted task says otherwise; audit_logs through
//     B1-34a's reader with its own-records rule; both are keyset walks over the set fixed at the
//     claim's Clock instant, count and rows under the same bound; tax_withdrawals, B2-08e, through
//     ./tax-export-source.ts, cursor pages of payout's port with identity's batch real names, a
//     note line above the header, an unreadable real name failing the whole task; ledger,
//     CT-24zzm, through ledger's readAdminLedgerExportPage: GET /admin/v1/ledger's own filters,
//     checks, order and item values, keyset pages, one row per entry, always masked — no column
//     is pii under 04 §11.1), write progress,
//     enforce
//     admin.export.max_rows on the rows actually read, build one CSV (UTF-8 BOM, RFC 4180,
//     formula guard), put it into the private export store, then running → done in one
//     transaction with expires_at = generated + 24 h, the export_unmasked row-count audit of an
//     unmasked task (export_generated for a masked tax_withdrawals task, BR-WDR-21) and the delayed
//     expire job (no singletonKey: export is a standard queue).
//     A source / storage failure or the row limit is running → failed with a short safe reason;
//     an object whose task did not reach done (cancelled meanwhile, or the done transaction
//     rolled back) is deleted again — only under the task's row lock (below).
//     Running lease (no extra column): updated_at is the heartbeat, row_version the fencing token.
//     The claim and every progress write refresh updated_at and bump row_version; every later write
//     of that execution (progress, done, failed) is a CAS on the token it holds. Under the creator
//     lock, before counting capacity (and on any generate delivery), the creator's running tasks
//     whose updated_at is older than now − admin.export.running_lease_seconds become failed
//     (interrupted), their object deleted under the row lock before that commits; the stale
//     execution's writes then all miss. A running task with a live lease is a duplicate delivery; a
//     delayed generate re-checks it after the lease could have run out, so a crash is recovered even
//     if the creator never exports again.
//     Same object key for every run of a task (B1-34f, without changing the key): the object is
//     deleted only inside a transaction holding the task row FOR UPDATE that has just confirmed the
//     delete is allowed, and that transaction commits only after the delete — while the row is
//     running under this execution's token (its own rollback / failure), or cancelled (terminal: no
//     later run can ever write the key). An execution that lost its lease (token CAS missed: the
//     task failed by a takeover, retried, running or done under a later run) deletes and writes
//     nothing; its orphan is overwritten by the next run of the key and is unreachable meanwhile
//     (only done is downloadable). The put has a hard timeout of a third of the lease, started
//     right after a heartbeat; a timed-out put fails the run on the still-held token. The store
//     cannot abort an upload or write conditionally, so a timed-out put may still land later and
//     overwrite the key: once it has landed, a late check locks the row and, if the task is done
//     under another run (whose file the late write may have replaced), turns it done → expired and
//     deletes the object before that commits (lateUploadAction). Remaining window: a crash before
//     the late check, or a failing late check, leaves such a done task with a stale file until it
//     expires; per-run keys with conditional writes are the follow-up (with the OSS adapter).
//   - expire: at expires_at (injected Clock) done → expired once (CAS under the row lock) and the
//     object is deleted in that transaction; early delivery re-sends a delayed expire job; any
//     other status is ignored.
// cancelByCreator: the account-disable port, pending / running → cancelled with one audit row per
// task (export_cancel), under the same per-creator lock.
// Every status change goes through the generated transitionExportTask() (hard rule 2); time only
// from the injected Clock; logs carry ids and error class names only, never a value or message.
//
// Pure module (no decorators, erasable syntax).
import type { DB } from '@couli/db';
import { transitionExportTask, type ExportTaskState } from '@couli/domain';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import type { ExportUsersReader } from '../../identity/index.ts';
import {
  AdminLedgerReadFieldsError,
  type AdminLedgerExportPage,
  type AdminLedgerExportPageInput,
} from '../../ledger/index.ts';
import { taxExportQuarterRange } from '../../payout/index.ts';
import type {
  Clock,
  ExportStore,
  JobHandler,
  JobQueue,
  ReceivedJob,
  RootLogger,
} from '../../platform/index.ts';
import type { AdminProfiles } from '../infra/admin-profiles.ts';
import { createAuditWriter } from '../infra/audit-writer.ts';
import { taxExportNote, TAX_EXPORT_HEADER } from '../domain/tax-export.ts';
import type { AuditLogsReader, AuditQuery } from './audit-logs-read.ts';
import {
  readTaxExportPage,
  TaxRealnameUnreadableError,
  type TaxExportPorts,
} from './tax-export-source.ts';

export interface ExportWorkerOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly store: ExportStore;
  readonly users: ExportUsersReader;
  readonly auditLogs: AuditLogsReader;
  /** Quarterly tax export (B2-08e); without it a tax_withdrawals task fails, nothing is guessed. */
  readonly tax?: TaxExportPorts;
  /** One user's ledger (CT-24zzm), ledger's read-only export page; without it a ledger task fails. */
  readonly ledger?: LedgerExportReader;
  readonly profiles: AdminProfiles;
  readonly config: Pick<ContentReader, 'configValue'>;
  readonly logger: RootLogger;
  /** Extra audit snapshot keys to redact (the Nest assembly passes platform's SENSITIVE_KEYS). */
  readonly sensitiveKeys?: readonly string[];
}

/** ledger's readAdminLedgerExportPage with its ports bound (the module assembles it). */
export type LedgerExportReader = (
  input: AdminLedgerExportPageInput,
) => Promise<AdminLedgerExportPage>;

/**
 * Columns of a ledger file (D10-1742): the item fields of adminListLedgerEntries one by one, the
 * voucher's and the link's fields flattened in their order.
 */
export const LEDGER_EXPORT_HEADER: readonly string[] = [
  'entry_id',
  'booked_at',
  'accounting_date',
  'ledger_type',
  'sub_type',
  'sub_account',
  'amount_fen',
  'balance_after_fen',
  'voucher_id',
  'uniq_key',
  'biz_type',
  'biz_id',
  'link_type',
  'link_id',
];

/** One list item as a file row: values as the list answers them, null as an empty cell. */
export function ledgerExportCells(item: AdminLedgerExportPage['items'][number]): (string | null)[] {
  return [
    item.entry_id,
    item.booked_at,
    item.accounting_date,
    item.ledger_type,
    item.sub_type,
    item.sub_account,
    // Integer fen exactly as the list's JSON number (signed from the user's view), never scaled.
    String(item.amount_fen),
    item.balance_after_fen === null ? null : String(item.balance_after_fen),
    item.voucher.voucher_id,
    item.voucher.uniq_key,
    item.voucher.biz_type,
    item.voucher.biz_id,
    item.link?.type ?? null,
    item.link?.id ?? null,
  ];
}

export interface ExportWorker {
  /** export queue: generate / expire; payload { appId, taskId } (internal UUID). */
  readonly handle: JobHandler;
  /** Internal account-disable port; app-scoped, audited, pending/running only. */
  cancelByCreator(input: { readonly appId: string; readonly adminId: string }): Promise<void>;
}

export const EXPORT_QUEUE = 'export';
export const EXPORT_GENERATE_JOB = 'generate';
export const EXPORT_EXPIRE_JOB = 'expire';
export const EXPORT_MAX_ROWS_KEY = 'admin.export.max_rows';
export const EXPORT_MAX_RUNNING_KEY = 'admin.export.max_running_per_admin';
/** Running lease: a running task without a heartbeat for this long counts as interrupted. */
export const EXPORT_LEASE_SECONDS_KEY = 'admin.export.running_lease_seconds';
/** Code defaults (the keys are not in the configuration registry; config_items may override). */
export const EXPORT_DEFAULT_MAX_ROWS = 50_000;
export const EXPORT_DEFAULT_MAX_RUNNING = 2;
export const EXPORT_DEFAULT_LEASE_SECONDS = 600;
/** The masked tax file's own audit record (contract adminCreateExport, Audit; BR-WDR-21). */
export const EXPORT_GENERATED_ACTION = 'export_generated';
/** BR-ID-42 / BR-ID-30 ⑨: downloadable for 24 hours after generation. */
export const EXPORT_DOWNLOAD_WINDOW_MS = 86_400_000;
/** A task left pending at the creator's capacity is offered again after this delay. */
export const EXPORT_CAPACITY_RETRY_SECONDS = 15;

const USERS_PAGE_SIZE = 500;
const TAX_PAGE_SIZE = 500;
/** The ledger list's page_size maximum. */
const LEDGER_PAGE_SIZE = 200;
/** The audit search's contract page_size maximum. */
const AUDIT_PAGE_SIZE = 200;
const FAILURE_REASON_MAX = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_ID = /^[a-z0-9_]{1,32}$/;
const RISK_STATES: ReadonlySet<string> = new Set(['normal', 'frozen', 'appealing', 'banned']);
const BOM = Uint8Array.of(0xef, 0xbb, 0xbf);

const REASON_ROW_LIMIT = (max: number) => `导出行数超过上限 ${max} 行，请缩小筛选范围后重试`;
const REASON_TAX_ROW_LIMIT = (max: number) =>
  `导出行数超过上限 ${max} 行，涉税明细不能截断，请调大配置项 ${EXPORT_MAX_ROWS_KEY} 后重试`;
const REASON_REALNAME = '有到账记录读不到实名，未生成文件，请核实后重试';
const REASON_FILTERS = '导出筛选条件无效';
const REASON_SOURCE = '读取导出数据失败，请稍后重试';
const REASON_STORAGE = '导出文件写入失败，请稍后重试';
const REASON_COMPLETE = '导出文件生成失败，请稍后重试';
const REASON_INTERRUPTED = '导出执行中断，请重新发起';

type TaskRow = Selectable<DB['export_tasks']>;

/**
 * One execution's hold on a running task: `token` is the row_version it last wrote (claim, then
 * every heartbeat); every later write is a CAS on it, so a taken-over execution writes nothing.
 */
interface Lease {
  readonly task: TaskRow;
  token: number;
  readonly startedAt: Date;
}

interface SourcePage {
  readonly rows: readonly (readonly (string | null)[])[];
  readonly total: number;
}

interface Source {
  /** Line one above the header, written at generation (tax_withdrawals only). */
  note?(at: Date): string;
  /** The failure reason past admin.export.max_rows; the general one when absent. */
  rowLimitReason?(max: number): string;
  readonly header: readonly string[];
  readonly pageSize: number;
  page(page: number, pageSize: number): Promise<SourcePage>;
}

class ExportPutTimeoutError extends Error {
  constructor() {
    super('export: the object upload timed out');
    this.name = 'ExportPutTimeoutError';
  }
}

class SourceFiltersError extends Error {
  constructor() {
    super('export: task filters are invalid');
    this.name = 'SourceFiltersError';
  }
}

/** `instant` moved by `ms` as a new Date (no wall clock read). */
function shiftMs(instant: Date, ms: number): Date {
  const result = structuredClone(instant);
  result.setTime(instant.getTime() + ms);
  return result;
}

/** Year 2026..2100 and the shape, by payout's own function. */
function taxQuarterAllowed(quarter: string): boolean {
  try {
    taxExportQuarterRange(quarter);
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What the late check does once a timed-out put of the execution holding `token` has landed:
 * only a done task is downloadable, and a done row is necessarily another run's (this execution
 * failed its own run on the timeout), whose file the late write may have replaced, so it expires.
 * Failed / pending / running / cancelled / expired rows are left (not downloadable, or a later
 * put of the running run overwrites the key).
 */
export function lateUploadAction(
  row: { readonly status: string; readonly row_version: number } | undefined,
  token: number,
): 'expire' | 'none' {
  if (row === undefined || row.status !== 'done' || row.row_version === token) return 'none';
  return 'expire';
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * One CSV cell: formula guard (OWASP CSV injection), then RFC 4180 quoting. A bare integer
 * (optional minus, digits only — the ledger's signed fen) is a plain number in any spreadsheet and
 * stays as it is; every other cell starting with a formula character gets the prefix.
 */
export function csvCell(value: string | null): string {
  let text = value ?? '';
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvRecord(cells: readonly (string | null)[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

/** Positive safe integer from config_items, else the code default. */
async function limit(
  config: Pick<ContentReader, 'configValue'>,
  appId: string,
  key: string,
  fallback: number,
): Promise<number> {
  const item = await config.configValue(appId, key);
  const value = item?.value;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * The account-disable port without the rest of the worker (B1-34h: the admin entry's disable runs
 * it inside its own transaction): the creator's pending / running tasks → cancelled through
 * transitionExportTask, one export_cancel audit row each, under the per-creator lock of `trx`.
 */
export interface ExportCanceller {
  /** Number of tasks cancelled; nothing for an app id or admin id of the wrong shape. */
  cancelByCreator(
    trx: Kysely<DB>,
    input: {
      readonly appId: string;
      readonly adminId: string;
      /** Who the audit rows name (the disabling super admin); the creator when absent. */
      readonly actor?: string;
      readonly ip?: string | null;
    },
  ): Promise<number>;
}

export function createExportCanceller(options: {
  readonly clock: Clock;
  readonly sensitiveKeys?: readonly string[];
}): ExportCanceller {
  const { clock } = options;
  return {
    async cancelByCreator(handle, input) {
      const { appId, adminId } = input;
      if (!APP_ID.test(appId) || !UUID.test(adminId)) return 0;
      const trx = handle.withSchema('app');
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`admin.export_tasks.creator:${appId}:${adminId}`}, 0))`.execute(
        trx,
      );
      const rows = await trx
        .selectFrom('export_tasks')
        .selectAll()
        .where('app_id', '=', appId)
        .where('created_by', '=', adminId)
        .where('status', 'in', ['pending', 'running'])
        .orderBy('created_at')
        .orderBy('id')
        .forUpdate()
        .execute();
      const audit = createAuditWriter({
        db: trx,
        clock,
        ...(options.sensitiveKeys === undefined ? {} : { sensitiveKeys: options.sensitiveKeys }),
      });
      let count = 0;
      for (const row of rows) {
        const step = transitionExportTask(row.status as ExportTaskState, 'CANCEL');
        if (!step.ok) continue;
        const now = clock.now();
        await trx
          .updateTable('export_tasks')
          .set((eb) => ({
            status: step.to,
            updated_at: now,
            row_version: eb('row_version', '+', 1),
          }))
          .where('id', '=', row.id)
          .where('status', '=', row.status)
          .execute();
        await audit.append({
          appId,
          actor: input.actor ?? adminId,
          action: 'export_cancel',
          target: `export_tasks:${row.public_id}`,
          before: { status: row.status },
          after: {
            task_id: row.public_id,
            resource: row.resource,
            status: step.to,
            cause: 'admin_disabled',
          },
          ip: input.ip ?? null,
        });
        count++;
      }
      return count;
    },
  };
}

export function createExportWorker(options: ExportWorkerOptions): ExportWorker {
  const { clock, queue, store, users, auditLogs, tax, ledger, profiles, config, logger } = options;
  const db = options.db.withSchema('app');
  const canceller = createExportCanceller({
    clock,
    ...(options.sensitiveKeys === undefined ? {} : { sensitiveKeys: options.sensitiveKeys }),
  });
  const auditOn = (trx: Kysely<DB>) =>
    createAuditWriter({
      db: trx,
      clock,
      ...(options.sensitiveKeys === undefined ? {} : { sensitiveKeys: options.sensitiveKeys }),
    });

  const lockCreator = async (trx: Transaction<DB>, appId: string, adminId: string) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`admin.export_tasks.creator:${appId}:${adminId}`}, 0))`.execute(
      trx,
    );
  };

  const lockTask = (trx: Transaction<DB>, appId: string, taskId: string) =>
    trx
      .selectFrom('export_tasks')
      .selectAll()
      .where('app_id', '=', appId)
      .where('id', '=', taskId)
      .forUpdate()
      .executeTakeFirst();

  const objectKey = (task: TaskRow) => `${task.app_id}/${task.public_id}.csv`;

  async function removeObject(key: string, taskId: string): Promise<void> {
    try {
      await store.delete(key);
    } catch (error) {
      logger.warn(
        { event: 'export_object_delete_failed', task_id: taskId, key, error: errorName(error) },
        'export object could not be deleted',
      );
    }
  }

  /** Fails the creator's running tasks whose lease ran out (no heartbeat within leaseMs). */
  async function reclaimStale(
    trx: Transaction<DB>,
    appId: string,
    createdBy: string,
    now: Date,
    leaseMs: number,
  ): Promise<TaskRow[]> {
    // FOR UPDATE re-checks updated_at after a wait: a heartbeat that won the row drops it.
    const stale = await trx
      .selectFrom('export_tasks')
      .selectAll()
      .where('app_id', '=', appId)
      .where('created_by', '=', createdBy)
      .where('status', '=', 'running')
      .where('updated_at', '<', shiftMs(now, -leaseMs))
      .orderBy('id')
      .forUpdate()
      .execute();
    const failed: TaskRow[] = [];
    for (const row of stale) {
      const step = transitionExportTask(row.status as ExportTaskState, 'FAIL');
      if (!step.ok) continue;
      const result = await trx
        .updateTable('export_tasks')
        .set({
          status: step.to,
          failure_reason: REASON_INTERRUPTED,
          updated_at: now,
          row_version: row.row_version + 1,
        })
        .where('id', '=', row.id)
        .where('status', '=', 'running')
        .where('row_version', '=', row.row_version)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) continue;
      // Still under the row lock (no retry or later run can start before this commits); the
      // stale put is over, its hard timeout being a third of the lease that has now run out.
      await removeObject(objectKey(row), row.id);
      failed.push(row);
    }
    return failed;
  }

  /**
   * Under the creator lock: first the creator's expired running leases become failed; then a
   * pending task is claimed (pending → running) when the creator has a free slot ('deferred' at
   * capacity), and a running task with a live lease is a duplicate delivery (null; a delayed
   * generate re-checks it once the lease could have run out, so a crash is still recovered).
   */
  async function claim(
    appId: string,
    taskId: string,
    maxRunning: number,
    leaseMs: number,
  ): Promise<{ readonly outcome: Lease | 'deferred' | null; readonly stale: readonly TaskRow[] }> {
    const head = await db
      .selectFrom('export_tasks')
      .select(['created_by', 'status'])
      .where('app_id', '=', appId)
      .where('id', '=', taskId)
      .executeTakeFirst();
    if (head === undefined || (head.status !== 'pending' && head.status !== 'running')) {
      return { outcome: null, stale: [] };
    }
    return db.transaction().execute(async (trx) => {
      await lockCreator(trx, appId, head.created_by);
      const now = clock.now();
      const stale = await reclaimStale(trx, appId, head.created_by, now, leaseMs);
      const row = await lockTask(trx, appId, taskId);
      if (row?.status === 'running') {
        const leaseEnds = row.updated_at.getTime() + leaseMs;
        await queue.send(
          EXPORT_QUEUE,
          EXPORT_GENERATE_JOB,
          { appId, taskId },
          {
            trx,
            delaySeconds:
              Math.max(1, Math.ceil((leaseEnds - now.getTime()) / 1000)) +
              EXPORT_CAPACITY_RETRY_SECONDS,
          },
        );
        return { outcome: null, stale };
      }
      if (row === undefined || row.status !== 'pending') return { outcome: null, stale };
      const step = transitionExportTask(row.status as ExportTaskState, 'START');
      if (!step.ok) return { outcome: null, stale };
      const running = await trx
        .selectFrom('export_tasks')
        .select((eb) => eb.fn.countAll<bigint>().as('n'))
        .where('app_id', '=', appId)
        .where('created_by', '=', row.created_by)
        .where('status', '=', 'running')
        .executeTakeFirstOrThrow();
      if (Number(running.n) >= maxRunning) {
        await queue.send(
          EXPORT_QUEUE,
          EXPORT_GENERATE_JOB,
          { appId, taskId },
          { trx, delaySeconds: EXPORT_CAPACITY_RETRY_SECONDS },
        );
        return { outcome: 'deferred', stale };
      }
      const claimed = await trx
        .updateTable('export_tasks')
        .set({
          status: step.to,
          progress: 0,
          updated_at: now,
          row_version: row.row_version + 1,
        })
        .where('id', '=', row.id)
        .where('status', '=', 'pending')
        .where('row_version', '=', row.row_version)
        .returningAll()
        .executeTakeFirst();
      if (claimed === undefined) return { outcome: null, stale };
      return { outcome: { task: claimed, token: claimed.row_version, startedAt: now }, stale };
    });
  }

  /** running → failed (CAS on the lease token); a task taken over or no longer running is left. */
  async function fail(lease: Lease, reason: string): Promise<void> {
    const { task } = lease;
    const applied = await db.transaction().execute(async (trx) => {
      const row = await lockTask(trx, task.app_id, task.id);
      if (row === undefined || row.status !== 'running' || row.row_version !== lease.token) {
        return false;
      }
      const step = transitionExportTask(row.status as ExportTaskState, 'FAIL');
      if (!step.ok) return false;
      const result = await trx
        .updateTable('export_tasks')
        .set({
          status: step.to,
          failure_reason: Array.from(reason).slice(0, FAILURE_REASON_MAX).join(''),
          updated_at: clock.now(),
          row_version: lease.token + 1,
        })
        .where('id', '=', row.id)
        .where('status', '=', 'running')
        .where('row_version', '=', lease.token)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    });
    if (applied) {
      lease.token += 1;
      logger.info({ event: 'export_failed', task_id: task.id }, 'export task failed');
    }
  }

  /**
   * Progress and lease heartbeat (updated_at) under the lease token; false when the task is no
   * longer this execution's (cancelled, or failed by a takeover after the lease ran out).
   */
  async function heartbeat(lease: Lease, value: number): Promise<boolean> {
    const result = await db
      .updateTable('export_tasks')
      .set({ progress: value, updated_at: clock.now(), row_version: lease.token + 1 })
      .where('app_id', '=', lease.task.app_id)
      .where('id', '=', lease.task.id)
      .where('status', '=', 'running')
      .where('row_version', '=', lease.token)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) return false;
    lease.token += 1;
    return true;
  }

  /**
   * After this execution's put did not end in its own done row (the put failed or timed out, the
   * done transaction rolled back, or complete missed): under the task row lock, the object is
   * deleted only while the row is still running under this execution's token (then, with a
   * reason, running → failed in the same transaction) or cancelled (terminal, no later run). Any
   * other state means the lease was lost: a later run may own the key, so nothing is deleted or
   * written. The transaction commits only after the delete.
   */
  async function settle(lease: Lease, key: string, reason: string | null): Promise<void> {
    const { task } = lease;
    const failed = await db.transaction().execute(async (trx) => {
      const row = await lockTask(trx, task.app_id, task.id);
      if (row === undefined) return false;
      if (row.status === 'cancelled') {
        await removeObject(key, task.id);
        return false;
      }
      if (row.status !== 'running' || row.row_version !== lease.token) return false;
      await removeObject(key, task.id);
      if (reason === null) return false;
      const step = transitionExportTask(row.status as ExportTaskState, 'FAIL');
      if (!step.ok) return false;
      const result = await trx
        .updateTable('export_tasks')
        .set({
          status: step.to,
          failure_reason: Array.from(reason).slice(0, FAILURE_REASON_MAX).join(''),
          updated_at: clock.now(),
          row_version: lease.token + 1,
        })
        .where('id', '=', row.id)
        .where('status', '=', 'running')
        .where('row_version', '=', lease.token)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    });
    if (failed) {
      lease.token += 1;
      logger.info({ event: 'export_failed', task_id: task.id }, 'export task failed');
    }
  }

  /**
   * After a timed-out put of `lease` has landed anyway: under the task row lock, a task done
   * under another run becomes expired and its object (possibly overwritten by the late write) is
   * deleted before that commits (lateUploadAction). Never throws: the handler returned long ago.
   */
  async function lateUploadCheck(lease: Lease, key: string): Promise<void> {
    const { task } = lease;
    try {
      const expired = await db.transaction().execute(async (trx) => {
        const row = await lockTask(trx, task.app_id, task.id);
        if (row === undefined || lateUploadAction(row, lease.token) !== 'expire') return false;
        const step = transitionExportTask(row.status as ExportTaskState, 'EXPIRE');
        if (!step.ok) return false;
        // Still under the row lock: no download can be signed for this task after the commit.
        await removeObject(key, task.id);
        const result = await trx
          .updateTable('export_tasks')
          .set({ status: step.to, updated_at: clock.now(), row_version: row.row_version + 1 })
          .where('id', '=', row.id)
          .where('status', '=', 'done')
          .where('row_version', '=', row.row_version)
          .executeTakeFirst();
        return result.numUpdatedRows > 0n;
      });
      if (expired) {
        logger.warn(
          { event: 'export_late_upload_expired', task_id: task.id },
          'late export upload: the done task was expired',
        );
      }
    } catch (error) {
      logger.error(
        { event: 'export_late_upload_check_failed', task_id: task.id, error: errorName(error) },
        'late export upload could not be checked',
      );
    }
  }

  /**
   * store.put with a hard timeout of a third of the lease (the caller heartbeats right before).
   * A put given up on is not dropped: once it settles, a landed one gets the late check.
   */
  async function putWithin(
    lease: Lease,
    leaseMs: number,
    input: Parameters<ExportStore['put']>[0],
  ) {
    const put = store.put(input);
    let timedOut = false;
    void put.then(
      () => (timedOut ? lateUploadCheck(lease, input.key) : undefined),
      () => undefined,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          timedOut = true;
          reject(new ExportPutTimeoutError());
        },
        Math.max(1, Math.floor(leaseMs / 3)),
      );
    });
    try {
      await Promise.race([put, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function sourceOf(task: TaskRow, startedAt: Date): Promise<Source> {
    const filters: unknown = task.filters;
    if (!isPlainObject(filters)) throw new SourceFiltersError();
    if (task.resource === 'users') {
      const risk = filters['risk_state'];
      if (risk !== undefined && (typeof risk !== 'string' || !RISK_STATES.has(risk))) {
        throw new SourceFiltersError();
      }
      const masked = task.masked;
      // Keyset walk over a set fixed at the task's start (users registered later are excluded).
      let after: string | undefined;
      return {
        header: [
          'user_id',
          'nickname',
          masked ? 'phone_masked' : 'phone',
          'level',
          'risk_state',
          'created_at',
        ],
        pageSize: USERS_PAGE_SIZE,
        async page(page, pageSize) {
          const result = await users.page({
            appId: task.app_id,
            page,
            pageSize,
            masked,
            createdUpTo: startedAt,
            ...(after === undefined ? {} : { after }),
            ...(risk === undefined
              ? {}
              : { riskState: risk as 'normal' | 'frozen' | 'appealing' | 'banned' }),
          });
          if (typeof result.next === 'string') after = result.next;
          return {
            total: result.total,
            rows: result.items.map((row) => [
              row.user_id,
              row.nickname,
              row.phone,
              row.level,
              row.risk_state,
              row.created_at,
            ]),
          };
        },
      };
    }
    if (task.resource === 'audit_logs') {
      // Audit values are stored masked; the table's check keeps audit_logs tasks masked.
      if (!task.masked) throw new SourceFiltersError();
      const text = (key: string): string | undefined => {
        const value = filters[key];
        if (value === undefined) return undefined;
        if (typeof value !== 'string') throw new SourceFiltersError();
        return value;
      };
      const query: Omit<AuditQuery, 'page' | 'pageSize'> = {
        ...(text('actor_id') === undefined ? {} : { actorId: text('actor_id')! }),
        ...(text('target_type') === undefined ? {} : { targetType: text('target_type')! }),
        ...(text('target_id') === undefined ? {} : { targetId: text('target_id')! }),
        ...(text('permission') === undefined ? {} : { permission: text('permission')! }),
        ...(text('from') === undefined ? {} : { from: text('from')! }),
        ...(text('to') === undefined ? {} : { to: text('to')! }),
      };
      const profile = await profiles.byId(task.app_id, task.created_by);
      if (profile === undefined) throw new Error('export: the creator account is unknown');
      const caller = { appId: task.app_id, adminId: task.created_by, isSuper: profile.isSuper };
      // Keyset walk (at, id) over the records at or before the task's start (later ones excluded).
      let after: string | undefined;
      return {
        header: [
          'id',
          'actor_id',
          'actor_name',
          'action',
          'target_type',
          'target_id',
          'permission',
          'ip',
          'at',
        ],
        pageSize: AUDIT_PAGE_SIZE,
        async page(page, pageSize) {
          // Same bound for the count and the rows of every page; keyset after the first page.
          const result = await auditLogs.list(caller, {
            ...query,
            page,
            pageSize,
            upTo: startedAt,
            ...(after === undefined ? {} : { after }),
          });
          const last = result.items.at(-1);
          if (last !== undefined) after = last.id;
          return {
            total: result.total,
            rows: result.items.map((item) => [
              item.id,
              item.actorId,
              item.actorName,
              item.action,
              item.targetType,
              item.targetId,
              item.permission,
              item.ip,
              item.at.toISOString(),
            ]),
          };
        },
      };
    }
    if (task.resource === 'tax_withdrawals') {
      const quarter = filters['quarter'];
      if (typeof quarter !== 'string' || !taxQuarterAllowed(quarter)) {
        throw new SourceFiltersError();
      }
      if (tax === undefined) throw new Error('export: the tax ports are not assembled');
      const profile = await profiles.byId(task.app_id, task.created_by);
      if (profile === undefined) throw new Error('export: the creator account is unknown');
      const { loginName } = profile;
      // Cursor walk of payout's port; the quarter is the only bound (paid_at decides, BR-WDR-21).
      let cursor: string | undefined;
      return {
        note: (at) => taxExportNote(loginName, at),
        rowLimitReason: REASON_TAX_ROW_LIMIT,
        header: TAX_EXPORT_HEADER,
        pageSize: TAX_PAGE_SIZE,
        async page(_page, pageSize) {
          const result = await readTaxExportPage(tax, options.db, {
            appId: task.app_id,
            quarter,
            masked: task.masked,
            cursor,
            limit: pageSize,
          });
          if (result.nextCursor !== null) cursor = result.nextCursor;
          // No count from the port: the rows actually read decide the limit.
          return { rows: result.rows, total: 0 };
        },
      };
    }
    if (task.resource === 'ledger') {
      // No column is pii (04 §11.1, D10-1742): a ledger task is always masked, by the request schema.
      if (!task.masked) throw new SourceFiltersError();
      if (ledger === undefined) throw new Error('export: the ledger reader is not assembled');
      const ledgerFilters: Readonly<Record<string, unknown>> = filters;
      // Keyset walk in the list's order (booked_at, entry id descending); the rows read decide.
      let after: string | null = null;
      let finished = false;
      return {
        header: LEDGER_EXPORT_HEADER,
        pageSize: LEDGER_PAGE_SIZE,
        async page(_page, pageSize) {
          if (finished) return { rows: [], total: 0 };
          let result: AdminLedgerExportPage;
          try {
            result = await ledger({
              appId: task.app_id,
              filters: ledgerFilters,
              after,
              limit: pageSize,
            });
          } catch (error) {
            // The list's own refusals (unknown user, bad filter): the task's filters are invalid.
            if (error instanceof AdminLedgerReadFieldsError) throw new SourceFiltersError();
            throw error;
          }
          if (result.next === null) finished = true;
          else after = result.next;
          return { rows: result.items.map(ledgerExportCells), total: 0 };
        },
      };
    }
    throw new SourceFiltersError();
  }

  /** The unmasked task's creation reason (latest export_unmasked record of the task). */
  async function unmaskedReason(trx: Transaction<DB>, task: TaskRow): Promise<string | null> {
    const row = await trx
      .selectFrom('audit_logs')
      .select('after')
      .where('app_id', '=', task.app_id)
      .where('admin_id', '=', task.created_by)
      .where('action', '=', 'export_unmasked')
      .where('target', '=', `export_tasks:${task.public_id}`)
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    const after: unknown = row?.after;
    return isPlainObject(after) && typeof after['reason'] === 'string' ? after['reason'] : null;
  }

  /**
   * running → done with the expiry job, in one transaction; false when the task is no longer this
   * execution's (cancelled, or taken over: the lease token no longer matches).
   */
  async function complete(lease: Lease, key: string, rowCount: number): Promise<boolean> {
    const { task } = lease;
    return db.transaction().execute(async (trx) => {
      const row = await lockTask(trx, task.app_id, task.id);
      if (row === undefined || row.status !== 'running' || row.row_version !== lease.token) {
        return false;
      }
      const step = transitionExportTask(row.status as ExportTaskState, 'COMPLETE');
      if (!step.ok) return false;
      const now = clock.now();
      const expiresAt = shiftMs(now, EXPORT_DOWNLOAD_WINDOW_MS);
      const result = await trx
        .updateTable('export_tasks')
        .set({
          status: step.to,
          progress: 100,
          failure_reason: null,
          file_name: `${row.public_id}.csv`,
          object_key: key,
          row_count: rowCount,
          generated_at: now,
          expires_at: expiresAt,
          updated_at: now,
          row_version: lease.token + 1,
        })
        .where('id', '=', row.id)
        .where('status', '=', 'running')
        .where('row_version', '=', lease.token)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) return false;
      if (!row.masked) {
        await auditOn(trx).append({
          appId: row.app_id,
          actor: row.created_by,
          action: 'export_unmasked',
          target: `export_tasks:${row.public_id}`,
          before: null,
          after: {
            task_id: row.public_id,
            resource: row.resource,
            reason: await unmaskedReason(trx, row),
            row_count: rowCount,
          },
          ip: null,
        });
      } else if (row.resource === 'tax_withdrawals') {
        await auditOn(trx).append({
          appId: row.app_id,
          actor: row.created_by,
          action: EXPORT_GENERATED_ACTION,
          target: `export_tasks:${row.public_id}`,
          before: null,
          after: { task_id: row.public_id, resource: row.resource, row_count: rowCount },
          ip: null,
        });
      }
      await queue.send(
        EXPORT_QUEUE,
        EXPORT_EXPIRE_JOB,
        { appId: row.app_id, taskId: row.id },
        {
          trx,
          delaySeconds: Math.ceil((expiresAt.getTime() - now.getTime()) / 1000),
        },
      );
      return true;
    });
  }

  async function generate(appId: string, taskId: string): Promise<void> {
    const maxRows = await limit(config, appId, EXPORT_MAX_ROWS_KEY, EXPORT_DEFAULT_MAX_ROWS);
    const maxRunning = await limit(
      config,
      appId,
      EXPORT_MAX_RUNNING_KEY,
      EXPORT_DEFAULT_MAX_RUNNING,
    );
    const leaseSeconds = await limit(
      config,
      appId,
      EXPORT_LEASE_SECONDS_KEY,
      EXPORT_DEFAULT_LEASE_SECONDS,
    );
    const { outcome, stale } = await claim(appId, taskId, maxRunning, leaseSeconds * 1000);
    for (const row of stale) {
      // Failed, its object removed, under the row lock in the claim transaction.
      logger.warn({ event: 'export_interrupted', task_id: row.id }, 'export lease ran out');
    }
    if (outcome === null) return;
    if (outcome === 'deferred') {
      logger.info({ event: 'export_deferred', task_id: taskId }, 'export task waits for a slot');
      return;
    }
    const lease = outcome;
    const { task } = lease;

    let source: Source;
    try {
      source = await sourceOf(task, lease.startedAt);
    } catch (error) {
      logger.warn(
        { event: 'export_source_failed', task_id: task.id, error: errorName(error) },
        'export source unavailable',
      );
      await fail(lease, error instanceof SourceFiltersError ? REASON_FILTERS : REASON_SOURCE);
      return;
    }

    // One extra row is enough to detect the limit; the rows actually read decide, not total.
    const pageSize = Math.min(source.pageSize, maxRows + 1);
    const chunks: string[] = [csvRecord(source.header)];
    let rowCount = 0;
    let percent = 0;
    for (let page = 1; ; page++) {
      let result: SourcePage;
      try {
        result = await source.page(page, pageSize);
      } catch (error) {
        logger.warn(
          { event: 'export_source_failed', task_id: task.id, error: errorName(error) },
          'export source read failed',
        );
        await fail(
          lease,
          error instanceof TaxRealnameUnreadableError
            ? REASON_REALNAME
            : error instanceof SourceFiltersError
              ? REASON_FILTERS
              : REASON_SOURCE,
        );
        return;
      }
      rowCount += result.rows.length;
      if (rowCount > maxRows || result.total > maxRows) {
        await fail(lease, (source.rowLimitReason ?? REASON_ROW_LIMIT)(maxRows));
        return;
      }
      for (const cells of result.rows) chunks.push(csvRecord(cells));
      if (result.rows.length < pageSize) break;
      if (result.total > 0) {
        percent = Math.max(percent, Math.min(99, Math.floor((rowCount * 100) / result.total)));
      }
      if (!(await heartbeat(lease, percent))) return;
    }
    // Still this execution's right before the upload (fresh lease for the put).
    if (!(await heartbeat(lease, percent))) return;

    if (source.note !== undefined) chunks.unshift(csvRecord([source.note(clock.now())]));
    const key = objectKey(task);
    try {
      await putWithin(lease, leaseSeconds * 1000, {
        key,
        bytes: Buffer.concat([BOM, Buffer.from(chunks.join(''), 'utf8')]),
        contentType: 'text/csv',
      });
    } catch (error) {
      logger.warn(
        { event: 'export_store_failed', task_id: task.id, error: errorName(error) },
        'export object could not be stored',
      );
      await settle(lease, key, REASON_STORAGE);
      return;
    }

    let done: boolean;
    try {
      done = await complete(lease, key, rowCount);
    } catch (error) {
      // Rolled back (e.g. the expiry job could not be sent): no done task, no file left behind.
      logger.warn(
        { event: 'export_complete_failed', task_id: task.id, error: errorName(error) },
        'export task could not be completed',
      );
      await settle(lease, key, REASON_COMPLETE);
      return;
    }
    if (!done) {
      // Cancelled meanwhile: the file goes (under the lock); taken over: left to the later run.
      await settle(lease, key, null);
      return;
    }
    logger.info({ event: 'export_done', task_id: task.id, row_count: rowCount }, 'export done');
  }

  async function expire(appId: string, taskId: string): Promise<void> {
    const outcome = await db.transaction().execute(async (trx) => {
      const row = await lockTask(trx, appId, taskId);
      if (row === undefined || row.status !== 'done' || row.expires_at === null) return 'ignored';
      const now = clock.now();
      if (now.getTime() < row.expires_at.getTime()) {
        const delaySeconds = Math.ceil((row.expires_at.getTime() - now.getTime()) / 1000);
        await queue.send(
          EXPORT_QUEUE,
          EXPORT_EXPIRE_JOB,
          { appId, taskId },
          { trx: null, delaySeconds },
        );
        return 'early';
      }
      const step = transitionExportTask(row.status as ExportTaskState, 'EXPIRE');
      if (!step.ok) return 'ignored';
      // Deleted under the row lock: a failure rolls back and the delivery is retried.
      if (row.object_key !== null) await store.delete(row.object_key);
      await trx
        .updateTable('export_tasks')
        .set((eb) => ({
          status: step.to,
          updated_at: now,
          row_version: eb('row_version', '+', 1),
        }))
        .where('id', '=', row.id)
        .where('status', '=', 'done')
        .execute();
      return 'expired';
    });
    if (outcome === 'expired') {
      logger.info({ event: 'export_expired', task_id: taskId }, 'export expired');
    }
  }

  return Object.freeze({
    async handle(job: ReceivedJob): Promise<void> {
      const appId = job.payload['appId'];
      const taskId = job.payload['taskId'];
      if (
        typeof appId !== 'string' ||
        !APP_ID.test(appId) ||
        typeof taskId !== 'string' ||
        !UUID.test(taskId)
      ) {
        logger.warn({ event: 'export_job_invalid', job_id: job.id }, 'export job payload invalid');
        return;
      }
      if (job.name === EXPORT_GENERATE_JOB) return generate(appId, taskId);
      if (job.name === EXPORT_EXPIRE_JOB) return expire(appId, taskId);
      logger.warn({ event: 'export_job_unknown', job_id: job.id }, 'export job name unknown');
    },

    async cancelByCreator(input: { readonly appId: string; readonly adminId: string }) {
      const cancelled = await db
        .transaction()
        .execute((trx) => canceller.cancelByCreator(trx, input));
      if (cancelled > 0) {
        logger.info({ event: 'export_cancelled', count: cancelled }, 'export tasks cancelled');
      }
    },
  });
}
