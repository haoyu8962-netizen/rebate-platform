// Shared harness of the B2-04zx rule tests (FU-B104ZZA-AUDIT-PORT, D10-723): settlement's rights
// command without its fallback writer of admin's audit table. Built on the B2-04l rights harness
// (test/spec/settlement/rights/kit.ts, frozen, only read here): its own port (`bare`, built without
// `audit`, exactly as the settlement/rights and rights-estimate fixtures build it) and ports built
// here with an audit port injected (a recording fake, or admin's createSystemAuditWriter through
// admin's public entry). Every call runs the way orders runs it: one transaction, lockOrderKey
// first, the order re-read FOR UPDATE, then the port.
//
// `attempt` keeps the record's transaction open after the port answered and reads, on that same
// transaction, everything the record may write, before and after the call: a refusal must come
// before any write (fail-closed, nothing half-written), not merely be undone by the rollback. A
// refused attempt is then rolled back as the caller would.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import {
  lockOrderKey,
  type RightsCommandPort,
  type RightsRecordInput,
  type RightsRecordResult,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { createRootLogger, type Clock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createRightsCommandPort,
  type RightsCommandDependencies,
} from '../../../../apps/api/src/modules/settlement/rights/index.ts';
import {
  OCCURRED_AT,
  clawbackKey,
  harness as rightsHarness,
  platformClawbackKey,
  type Harness as RightsHarness,
  type RecordSpec,
  type SeededOrder,
} from '../rights/kit.ts';

export {
  OCCURRED_AT,
  TIMEOUT,
  clawbackKey,
  databaseFixture,
  platformClawbackKey,
} from '../rights/kit.ts';
export type { RecordSpec, SeededOrder } from '../rights/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);

/** D10-699 reason of the reopen (audit `after.reason` and the alert), from the task notes. */
export const REASON = 'union_reported_success_after_closed';
/** D10-699 audit action of the reopen (target order_rights:<id>), from B1-04zza. */
export const REOPEN_ACTION = 'order_rights_success_after_closed';
/** contracts/enums/admin.yaml audit_system_actor: the value form ^system:[a-z_]+$. */
export const SYSTEM_ACTOR = /^system:[a-z_]+$/;

/** The audit port of settlement's rights command (optional dependency `audit`). */
export type RightsAudit = NonNullable<RightsCommandDependencies['audit']>;
export type RightsAuditInput = Parameters<RightsAudit['appendAction']>[1];

export interface AuditCall {
  readonly trx: Transaction<DB>;
  readonly input: RightsAuditInput;
}

interface AdminSystemAudit {
  createSystemAuditWriter(deps: { readonly clock: Clock }): RightsAudit;
}

/** admin's real system audit writer, through admin's public entry (as app.module injects it). */
export async function adminAuditWriter(clock: Clock): Promise<RightsAudit> {
  // Loaded at run time: admin's entry carries Nest decorators the rule-test project does not check.
  const admin = (await import(
    new URL('apps/api/src/modules/admin/index.ts', ROOT).href
  )) as AdminSystemAudit;
  return admin.createSystemAuditWriter({ clock });
}

/** A fake audit port that records each call (and writes nothing). */
export function recordingAudit(): { readonly audit: RightsAudit; readonly calls: AuditCall[] } {
  const calls: AuditCall[] = [];
  return {
    calls,
    audit: {
      appendAction(trx, input) {
        calls.push({ trx, input });
        return Promise.resolve();
      },
    },
  };
}

/** The four CLAWBACK keys of one rights event on the default credited order. */
export function keysOf(o: SeededOrder, eventId: string): string[] {
  return [
    clawbackKey(o, 'self', eventId),
    clawbackKey(o, 'direct', eventId),
    clawbackKey(o, 'indirect', eventId),
    platformClawbackKey(o, eventId),
  ].sort();
}

/** Whole value as text (bigint as its digits), to look for the reason anywhere in a row. */
export function text(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown) =>
    typeof member === 'bigint' ? member.toString() : member,
  );
}

/** Everything a rights record may write for the app, read on the given executor. */
async function readState(executor: Kysely<DB>, appId: string) {
  return {
    orders: await executor
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('order_id')
      .execute(),
    rights: await executor
      .selectFrom('order_rights')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    vouchers: await executor
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('uniq_key')
      .execute(),
    entries: await executor
      .selectFrom('ledger_entries')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    balances: await executor
      .selectFrom('account_balances')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('account_id')
      .execute(),
    history: await executor
      .selectFrom('order_status_history')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    events: await executor
      .selectFrom('event_log')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    pending: await executor
      .selectFrom('order_sync_pending')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    audits: await executor
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  };
}

export type RecordState = Awaited<ReturnType<typeof readState>>;

export interface Attempt {
  /** The port's answer; undefined when it threw. */
  readonly result: RightsRecordResult | undefined;
  /** What the port threw; undefined when it answered. */
  readonly error: unknown;
  /** Read on the record's transaction right before the call. */
  readonly before: RecordState;
  /** Read on the record's transaction right after the call (before commit or rollback). */
  readonly after: RecordState;
  readonly trx: Transaction<DB>;
}

export interface AttemptOptions {
  /** Runs on the same transaction after the port answered (e.g. throws to roll it back). */
  readonly after?: (trx: Transaction<DB>) => Promise<void>;
}

/**
 * The ports and calls of this harness on an existing B2-04l rights harness (its app, clock,
 * clawback service, rebate port, spies and logs); also used by the frozen B1-04zza
 * success-after-closed test to inject its audit port.
 */
export function auditedRights(h: RightsHarness) {
  const db = h.db;
  const appId = h.appId;

  // The lines of the ports built here land with the rights harness' own (h.rightsLogs).
  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    {
      write(line: string) {
        h.rightsLogs.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );

  /** The rights harness' own port: built without `audit` (the big fixtures' configuration). */
  function bare(): RightsCommandPort {
    return h.recordPort();
  }

  /** A rights command with `audit` injected, on the harness' clawback service and rebate port. */
  function withAudit(audit: RightsAudit): RightsCommandPort {
    return createRightsCommandPort({
      clock: h.clock,
      logger,
      events: { publish: h.publish },
      clawback: h.boot(),
      rebate: h.rebate,
      audit,
    });
  }

  async function readLocked(trx: Transaction<DB>, o: SeededOrder) {
    await lockOrderKey(trx, o.platform, o.subOrderId);
    return trx
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .where('attr_at', '=', o.attrAt)
      .forUpdate()
      .executeTakeFirstOrThrow();
  }

  function input(
    o: SeededOrder,
    before: RightsRecordInput['before'],
    spec: RecordSpec,
  ): RightsRecordInput {
    return {
      before,
      order_id: o.orderId,
      source: spec.source ?? 'API',
      type: spec.type ?? 'RIGHTS',
      status: spec.status ?? 'SUCCEEDED',
      amount_fen: spec.amountFen ?? null,
      deduction_commission_fen: spec.deductionFen ?? null,
      occurred_at: spec.occurredAt ?? new Date(OCCURRED_AT),
      platform_rights_no: spec.rightsNo === undefined ? 'rights-n1' : spec.rightsNo,
      now: h.clock.now(),
    };
  }

  /**
   * One rights.record through `port` in its own transaction, reading the state on that transaction
   * before and after the call. When the port throws, the transaction is rolled back (the caller's
   * reaction) and the attempt is returned with the error; otherwise it commits, unless
   * `options.after` throws (that error is rethrown).
   */
  async function attempt(
    port: RightsCommandPort,
    o: SeededOrder,
    spec: RecordSpec,
    options: AttemptOptions = {},
  ): Promise<Attempt> {
    const box: { attempt?: Attempt } = {};
    const rollback = new Error('rights-audit-port kit: the refused record is rolled back');
    try {
      await db.transaction().execute(async (trx) => {
        const row = await readLocked(trx, o);
        const before = await readState(trx, appId);
        let result: RightsRecordResult | undefined;
        let error: unknown;
        try {
          result = await port.record(trx, input(o, row, spec));
        } catch (thrown) {
          error = thrown;
        }
        const after = await readState(trx, appId);
        box.attempt = { result, error, before, after, trx };
        if (error !== undefined) throw rollback;
        if (options.after !== undefined) await options.after(trx);
      });
    } catch (thrown) {
      if (thrown !== rollback) throw thrown;
    }
    if (box.attempt === undefined) throw new Error('rights-audit-port kit: no attempt was made');
    return box.attempt;
  }

  /** One rights.record through `port`, committed when the port answers; its answer. */
  async function commit(
    port: RightsCommandPort,
    o: SeededOrder,
    spec: RecordSpec,
  ): Promise<RightsRecordResult | undefined> {
    return (await attempt(port, o, spec)).result;
  }

  /** The order_rights row of one platform_rights_no on the order. */
  async function rightsOf(o: SeededOrder, rightsNo: string) {
    const rows = await h.rightsRows(o);
    const found = rows.filter((row) => row.platform_rights_no === rightsNo);
    if (found.length !== 1) {
      throw new Error(`rights-audit-port kit: ${String(found.length)} rows for ${rightsNo}`);
    }
    return found[0]!;
  }

  /** Warn-or-above log lines with an alert field that mention the D10-699 reason. */
  function reasonAlerts(): Record<string, unknown>[] {
    return [...h.logs, ...h.rightsLogs].filter(
      (line) =>
        Number(line['level']) >= 40 &&
        typeof line['alert'] === 'string' &&
        text(line).includes(REASON),
    );
  }

  /** Audit rows of the app that mention the D10-699 reason. */
  async function reasonAudits() {
    return (await h.audits()).filter((row) => text(row).includes(REASON));
  }

  /** How often the money, event and valuation boundaries were called so far. */
  function calls() {
    return {
      post: h.post.mock.calls.length,
      lockBalances: h.lockBalances.mock.calls.length,
      publish: h.publish.mock.calls.length,
      openPending: h.openPending.mock.calls.length,
      estimateBases: h.estimateBases.mock.calls.length,
      estimateRefresh: h.estimateRefresh.mock.calls.length,
    };
  }

  return {
    bare,
    withAudit,
    attempt,
    commit,
    rightsOf,
    reasonAlerts,
    reasonAudits,
    calls,
    /** The same reads as an attempt's before / after, on the shared pool (committed state). */
    appState: () => readState(db, appId),
  };
}

/** A fresh B2-04l rights harness with this harness' ports and calls on it. */
export async function auditHarness(db: Kysely<DB>) {
  const h = await rightsHarness(db);
  return { ...h, ...auditedRights(h) };
}

export type AuditHarness = Awaited<ReturnType<typeof auditHarness>>;
