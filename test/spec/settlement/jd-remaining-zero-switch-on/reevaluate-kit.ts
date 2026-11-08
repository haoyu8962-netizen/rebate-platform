// B2-04zzh round-2 helpers (spec-test r1: task brief §9.5 #12 / #13). A new file next to ./kit.ts, which
// is left as committed: everything here builds on its exports only.
// - candidates(): the three jd orders the re-evaluation must void (2 of 2 refunded while the switch was
//   off; UNATTRIBUTED / ESTIMATED / WAITING), synced through the production worker like ./kit.ts does;
// - reevaluationOn() / cliOn(): settlement's createJdRemainingZeroReevaluation (and the CLI's run over
//   it) on a database handle the test chooses, e.g. db.withPlugin(<plugin>); the switch is read by
//   content's configuration reader over the plain handle, as ./kit.ts cli() does;
// - refundOnCandidateRead(): once the first statement reading orders through the handle returns rows
//   (apply's candidate read, before any per-order transaction), another pool connection moves one
//   candidate's refunded_quantity to 1 (1 item left), as a later union report written by orders would;
// - auditFault(): the INSERT of the audit_logs row naming one target fails once.
// Integration tests pass the database in: this file never imports @couli/db/testing.
import type { DB } from '@couli/db';
import type { Kysely, KyselyPlugin, QueryId } from 'kysely';
import { expect } from 'vitest';
import {
  run as reevaluate,
  type JdRemainingZeroReevaluateDeps,
  type JdRemainingZeroReevaluateResult,
} from '../../../../apps/api/scripts/jd-remaining-zero-reevaluate.ts';
import { createAuditWriter } from '../../../../apps/api/src/modules/admin/infra/audit-writer.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createJdRemainingZeroReevaluation,
  type JdRemainingZeroReevaluation,
} from '../../../../apps/api/src/modules/settlement/rebate/application/rebate.ts';
import { capturedPorts } from '../worker/kit.ts';
import { counts, zeroed, type App, type SyncedOrder, type Worker } from './kit.ts';

/** union-pids' exit code of any failure other than invalid arguments (task brief §9.2 第 3 条). */
export const EXIT_FAILURE = 1;
/** Longer than any content or switch cache (60 s / 5 s), well inside the same accounting day. */
const CACHE_PASS_MS = 10 * 60_000;
const AUDIT_FAULT_MESSAGE = 'synthetic failure while appending the re-evaluation audit row';
/** A statement that reads the orders table (its own FROM, not a table whose name starts so). */
const ORDERS_READ = /^\s*(?:select|with)\b[\s\S]*\bfrom\s+(?:"?\w+"?\.)?"?orders"?(?=[\s,)]|$)/i;

export type OrderRow = Awaited<ReturnType<SyncedOrder['row']>>;

export interface Candidate {
  readonly order: SyncedOrder;
  readonly from: 'UNATTRIBUTED' | 'ESTIMATED' | 'WAITING';
}

export interface Candidates {
  readonly unattributed: SyncedOrder;
  readonly estimated: SyncedOrder;
  readonly waiting: SyncedOrder;
  readonly all: readonly Candidate[];
}

function text(value: unknown): string {
  return JSON.stringify(value, (_name, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}

/**
 * Three jd orders of the app, 2 items both refunded while the switch was off (B2-04zzg only alerts):
 * UNATTRIBUTED, ESTIMATED and WAITING. The caller must not have turned the switch on yet.
 */
export async function candidates(w: Worker, app: App): Promise<Candidates> {
  const unattributed = w.order(app, 'jd', counts(2, 2), { unattributed: true });
  await unattributed.sync();
  expect(await unattributed.row()).toMatchObject({
    rebate_status: 'UNATTRIBUTED',
    reason: null,
    quantity: 2,
    refunded_quantity: 2,
  });
  const estimated = await zeroed(w, app, 'ESTIMATED');
  const waiting = await zeroed(w, app, 'WAITING');
  return {
    unattributed,
    estimated,
    waiting,
    all: [
      { order: unattributed, from: 'UNATTRIBUTED' },
      { order: estimated, from: 'ESTIMATED' },
      { order: waiting, from: 'WAITING' },
    ],
  };
}

/**
 * settlement's re-evaluation with `db` as its database handle: the worker's clock and event bus,
 * content's configuration reader over `plain` (as app.module hands it to the worker), admin's audit
 * writer on the order's transaction.
 */
export async function reevaluationOn(
  w: Worker,
  plain: Kysely<DB>,
  db: Kysely<DB>,
): Promise<JdRemainingZeroReevaluation> {
  const ports = await capturedPorts('worker');
  expect(ports, 'app.module assembles SettlementModule.forWorker').not.toBeNull();
  if (ports === null) throw new Error('unreachable: the expect above failed');
  const logger = createRootLogger(
    { level: 'info', entry: 'worker', appEnv: 'test' },
    {
      write() {
        // Lines are not asserted here.
      },
    },
  );
  return createJdRemainingZeroReevaluation({
    db,
    clock: w.clock,
    logger,
    events: w.events,
    config: ports.config(plain, w.clock),
    audit: (trx) => createAuditWriter({ db: trx, clock: w.clock }),
  });
}

/** Moves the worker's clock past every content or switch cache. */
export function passCaches(w: Worker): void {
  w.clock.advanceMs(CACHE_PASS_MS);
}

/** The CLI's run over reevaluationOn(w, plain, db); `output` collects stdout and stderr lines. */
export async function cliOn(w: Worker, plain: Kysely<DB>, db: Kysely<DB>) {
  const reevaluation = await reevaluationOn(w, plain, db);
  const output: string[] = [];
  const deps: JdRemainingZeroReevaluateDeps = {
    reevaluation,
    terminal: {
      write: (message: string) => {
        output.push(message);
      },
      error: (message: string) => {
        output.push(message);
      },
    },
  };
  return {
    output,
    async run(argv: readonly string[]): Promise<JdRemainingZeroReevaluateResult> {
      passCaches(w);
      return reevaluate(argv, deps);
    },
  };
}

/** The one-shot concurrent change of refundOnCandidateRead (what it wrote, how often it fired). */
export interface RefundOnRead {
  readonly plugin: KyselyPlugin;
  hits: number;
  /** The order row right after the change, as the other connection committed it. */
  changed: OrderRow | undefined;
}

/**
 * Once the first statement reading orders through the handle returns rows, `plain` (another pool
 * connection, committed at once) sets the target order's refunded_quantity to 1 (one item left) and
 * bumps its row_version. Fires once.
 */
export function refundOnCandidateRead(
  plain: Kysely<DB>,
  target: { readonly appId: string; readonly orderId: string },
): RefundOnRead {
  const reads = new Set<QueryId>();
  const state: RefundOnRead = {
    hits: 0,
    changed: undefined,
    plugin: {
      transformQuery({ node, queryId }) {
        if (state.hits > 0) return node;
        const { sql } = plain.getExecutor().compileQuery(node, queryId);
        if (ORDERS_READ.test(sql)) reads.add(queryId);
        return node;
      },
      async transformResult({ queryId, result }) {
        if (reads.delete(queryId) && state.hits === 0 && result.rows.length > 0) {
          state.hits += 1;
          state.changed = await plain
            .updateTable('orders')
            .set((eb) => ({ refunded_quantity: 1, row_version: eb('row_version', '+', 1) }))
            .where('app_id', '=', target.appId)
            .where('order_id', '=', target.orderId)
            .returningAll()
            .executeTakeFirstOrThrow();
        }
        return result;
      },
    },
  };
  return state;
}

/** The one-shot audit fault of auditFault. */
export interface AuditFault {
  readonly plugin: KyselyPlugin;
  hits: number;
}

/**
 * The first INSERT into audit_logs whose values carry `target` (e.g. `orders:<order_id>`) fails;
 * the transaction around it is then in error and rolls back. Fires once.
 */
export function auditFault(target: string): AuditFault {
  const needle = text(target);
  const state: AuditFault = {
    hits: 0,
    plugin: {
      transformQuery({ node }) {
        if (state.hits === 0 && node.kind === 'InsertQueryNode') {
          const statement = text(node);
          if (statement.includes('"audit_logs"') && statement.includes(needle)) {
            state.hits += 1;
            throw new Error(AUDIT_FAULT_MESSAGE);
          }
        }
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    },
  };
  return state;
}
