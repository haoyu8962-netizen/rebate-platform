// Transactional audit of the system's own actions (B1-34p; D10-551 ②, D10-552; BR-FUND-06):
// `append` inserts one app.audit_logs row on the caller's transaction, so the row commits or
// rolls back with the caller's work; it never opens a transaction of its own. Stored as
// system_actor = input.actor, admin_id null, action order_auto_hold, target orders:<order_id>,
// before / after the hold flag and the reason code (through the audit redaction, keys as the manual
// order_hold record has them), at from the injected Clock read at each call (input.at is not used,
// as createAuditWriter ignores any `at`), ip null.
// B2-09p: `appendAction` stores any other action of the system the same way (D10-619: payout's
// system rejection, BR-WDR-10), with its own target and before / after.
//
// The input is a structural type, so admin takes no type from settlement; settlement's
// RebateDependencies['audit'] is satisfied by shape. Production assembly belongs to B1-09n.
//
// Plain SQL with the table written in full: it reads the same with the generated types from before
// and after the migration, and on any handle whether or not it is bound to the schema.
//
// Pure module (no decorators, erasable syntax, type-only imports from the platform barrel).
import type { AuditSystemActor } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { ORDER_AUTO_HOLD_ACTION } from '../domain/audit-log-view.ts';
import { redactSnapshot, type Snapshot } from './audit-redaction.ts';

/** One side of the hold change. */
export interface SystemHoldState {
  readonly hold: boolean;
  readonly holdReason: string | null;
}

/** What the adapter reads of settlement's RebateHoldAudit. */
export interface SystemHoldAudit {
  readonly appId: string;
  readonly orderId: string;
  /** system:<name>; the table's CHECK refuses any other form. */
  readonly actor: AuditSystemActor;
  readonly before: SystemHoldState;
  readonly after: SystemHoldState;
}

export interface SystemAuditWriterDeps {
  readonly clock: Clock;
  /** Extra exact key names to redact, on top of the built-in fragments (createAuditWriter's). */
  readonly sensitiveKeys?: readonly string[];
}

/** Any other action of the system: `before` / `after` go through the same redaction. */
export interface SystemActionAudit {
  readonly appId: string;
  /** system:<name>; the table's CHECK refuses any other form. */
  readonly actor: AuditSystemActor;
  readonly action: string;
  readonly target: string;
  readonly before: Snapshot;
  readonly after: Snapshot;
}

export interface SystemAuditWriter {
  append(trx: Transaction<DB>, input: SystemHoldAudit): Promise<void>;
  appendAction(trx: Transaction<DB>, input: SystemActionAudit): Promise<void>;
}

export function createSystemAuditWriter(deps: SystemAuditWriterDeps): SystemAuditWriter {
  const { clock } = deps;
  const sensitive = deps.sensitiveKeys ?? [];
  // Serialised explicitly, as createAuditWriter does.
  const serialised = (value: Snapshot) => JSON.stringify(redactSnapshot(value, sensitive));
  const holdState = (state: SystemHoldState): Snapshot => ({
    hold: state.hold,
    hold_reason: state.holdReason,
  });
  const insert = (trx: Transaction<DB>, input: SystemActionAudit) =>
    sql`insert into app.audit_logs
        (app_id, admin_id, system_actor, action, target, before, after, ip, at)
        values (${input.appId}, null, ${input.actor}, ${input.action},
          ${input.target}, ${serialised(input.before)}::jsonb,
          ${serialised(input.after)}::jsonb, null, ${clock.now()})`.execute(trx);
  return {
    async append(trx, input) {
      await insert(trx, {
        appId: input.appId,
        actor: input.actor,
        action: ORDER_AUTO_HOLD_ACTION,
        target: `orders:${input.orderId}`,
        before: holdState(input.before),
        after: holdState(input.after),
      });
    },
    async appendAction(trx, input) {
      await insert(trx, input);
    },
  };
}
