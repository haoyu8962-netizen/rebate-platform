// The owner's operations reset of the only super admin's authenticator (B1-34t; 08 BR-ID-43「重置
// 身份验证器」: 只有一位超管时由负责人在服务器上用运维命令重置，同样写 audit_logs; D10-2945, D10-2947).
// Run by apps/api/scripts/admin-totp-reset.ts; there is no HTTP operation (contract
// adminResetAdminTotp describes the super admin's own reset of another account).
//
// reset, in one transaction:
//   1. the reason is 1–200 characters and not whitespace only (else invalid_reason, nothing read);
//   2. the target (app_id + login name) and every super admin row of the app are locked in one
//      statement in id order (SELECT … FOR UPDATE), then judged: no such account → unknown; not a
//      super admin → not_super; another super admin of the app that is usable (status active and an
//      authenticator bound, D10-2947 ①) → another_usable_super: that one resets it over HTTP;
//      the request carries the preview the owner confirmed (inspect's snapshot: row_version and
//      totp_bound_at) and the locked row differs from it → state_changed: nothing is written,
//      audited or voided, the owner reruns and confirms what is there now (B1-34t r3, money r2 S1:
//      the owner binding a new authenticator while the command waits for the reason or the yes
//      must not lose it; bindTotp leaves row_version alone, hence totp_bound_at as well);
//      the target's authenticator already unbound (totp_bound_at null) → already_unbound: nothing is
//      written, audited or voided (D10-2999 ②), so a rerun after a reset whose result the owner never
//      saw leaves the binding ticket issued since then working; once the owner has bound a new
//      authenticator, a rerun is a new reset and goes ahead;
//   3. the authenticator columns are cleared (totp_secret_cipher, totp_bound_at, totp_last_step),
//      conditional on the locked row_version (row_version + 1); status, password, permission points
//      and the verify phone are unchanged, so an account with SMS still signs in with it
//      (BR-ID-43「2026-11-23 同步」②);
//   4. one system audit row on the same transaction (system_actor system:ops_command, D10-2947 ②):
//      action admin_totp_reset, target admins:<admin_id>, before { totp_bound }, after { admin_id,
//      totp_bound: false, reason } — no secret, in any encoding;
//   5. the account's voiding instant (Redis, ../infra/admin-revocations.ts) at the Clock instant:
//      every admin_token, login ticket and step-up token issued before it stops working. A failing
//      write throws and rolls 3 and 4 back, as the HTTP reset does.
// A refusal, already_unbound and state_changed write nothing and void nothing (the transaction
// rolls back).
// The voiding stays inside the transaction, before the commit (as the HTTP reset): when the commit
// then fails, sessions are void while the authenticator is still bound — the stricter side; a rerun
// finds the row still bound and completes the reset (D10-2999 ①, FU-ADMIN-CREDENTIAL-VERSION-PG). A super admin row created after the lock (only the
// bootstrap creates one, and only when there is none) is not seen; promoting an account to super
// admin is not an operation of this code base.
//
// inspect reads the target's binding state and its snapshot (no lock) for the command's echo before
// the owner confirms; reset judges again on the locked rows and, given the snapshot, refuses when
// the row changed meanwhile. Without a snapshot (callers other than the command) the locked state
// alone is judged.
//
// Pure module (no decorators, erasable syntax, type-only imports from the platform barrel).
import type { AuditSystemActor } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { AdminRevocations } from '../infra/admin-revocations.ts';
import type { SystemAuditWriter } from '../infra/system-audit.ts';

export interface OperatorTotpResetTarget {
  readonly appId: string;
  readonly loginName: string;
}

/** What the owner saw before confirming: compared with the locked row (money r2 S1). */
export interface OperatorTotpResetSnapshot {
  readonly rowVersion: number;
  /** totp_bound_at in epoch milliseconds; null when unbound. */
  readonly totpBoundAtMs: number | null;
}

export interface OperatorTotpResetPreview {
  readonly totpBound: boolean;
  /** Always set by createOperatorTotpReset; optional so that injected fakes may leave it out. */
  readonly snapshot?: OperatorTotpResetSnapshot;
}

export interface OperatorTotpResetRequest extends OperatorTotpResetTarget {
  readonly reason: string;
  /** The snapshot from inspect; when set, a locked row that differs is state_changed. */
  readonly expected?: OperatorTotpResetSnapshot;
}

export type OperatorTotpResetResult =
  | { readonly kind: 'reset' }
  /** The target's authenticator was already unbound: nothing written (D10-2999 ②). */
  | { readonly kind: 'already_unbound' }
  /** The locked row differs from the confirmed preview: nothing written (money r2 S1). */
  | { readonly kind: 'state_changed' }
  | {
      readonly kind: 'refused';
      readonly reason: 'unknown' | 'not_super' | 'another_usable_super' | 'invalid_reason';
    };

type Refusal = Extract<OperatorTotpResetResult, { kind: 'refused' }>['reason'];

export interface OperatorTotpReset {
  inspect(target: OperatorTotpResetTarget): Promise<OperatorTotpResetPreview | null>;
  reset(request: OperatorTotpResetRequest): Promise<OperatorTotpResetResult>;
}

export interface OperatorTotpResetDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly audit: Pick<SystemAuditWriter, 'appendAction'>;
  readonly revocations: Pick<AdminRevocations, 'voidBefore'>;
}

/** The audit identity of the operations command (contracts/enums/admin.yaml audit_system_actor). */
export const OPERATOR_TOTP_RESET_ACTOR: AuditSystemActor = 'system:ops_command';
/** Same action as the super admin's HTTP reset (contract CT-24o). */
export const OPERATOR_TOTP_RESET_ACTION = 'admin_totp_reset';
/** Reason bounds, as AdminReasonRequest of the HTTP reset: 1–200 characters. */
export const OPERATOR_TOTP_RESET_REASON_MAX = 200;
const ACTIVE = 'active';

/** 1–200 characters (code points) and not whitespace only. */
export function operatorResetReasonOk(value: string): boolean {
  return value.trim().length > 0 && [...value].length <= OPERATOR_TOTP_RESET_REASON_MAX;
}

/** Ends the transaction with a rollback and carries the result that wrote nothing. */
class NothingWritten extends Error {
  readonly result: Exclude<OperatorTotpResetResult, { kind: 'reset' }>;
  constructor(result: Exclude<OperatorTotpResetResult, { kind: 'reset' }>) {
    super(result.kind);
    this.result = result;
  }
}
const refused = (reason: Refusal) => new NothingWritten({ kind: 'refused', reason });
const boundAtMs = (value: Date | null): number | null => (value === null ? null : value.getTime());

export function createOperatorTotpReset(deps: OperatorTotpResetDeps): OperatorTotpReset {
  const { db, clock, audit, revocations } = deps;
  return {
    async inspect(target) {
      const row = await db
        .selectFrom('admin_users')
        .select(['totp_bound_at', 'row_version'])
        .where('app_id', '=', target.appId)
        .where('login_name', '=', target.loginName)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        totpBound: row.totp_bound_at !== null,
        snapshot: { rowVersion: row.row_version, totpBoundAtMs: boundAtMs(row.totp_bound_at) },
      };
    },

    async reset(request) {
      if (!operatorResetReasonOk(request.reason)) {
        return { kind: 'refused', reason: 'invalid_reason' };
      }
      try {
        await db.transaction().execute(async (trx) => {
          // One statement in id order: the target and every super admin of the app.
          const rows = await trx
            .selectFrom('admin_users')
            .select(['id', 'login_name', 'is_super', 'status', 'totp_bound_at', 'row_version'])
            .where('app_id', '=', request.appId)
            .where((eb) =>
              eb.or([eb('login_name', '=', request.loginName), eb('is_super', '=', true)]),
            )
            .orderBy('id')
            .forUpdate()
            .execute();
          const target = rows.find((row) => row.login_name === request.loginName);
          if (target === undefined) throw refused('unknown');
          if (!target.is_super) throw refused('not_super');
          const usable = rows.some(
            (row) =>
              row.id !== target.id &&
              row.is_super &&
              row.status === ACTIVE &&
              row.totp_bound_at !== null,
          );
          if (usable) throw refused('another_usable_super');
          const expected = request.expected;
          if (
            expected !== undefined &&
            (expected.rowVersion !== target.row_version ||
              expected.totpBoundAtMs !== boundAtMs(target.totp_bound_at))
          ) {
            throw new NothingWritten({ kind: 'state_changed' });
          }
          if (target.totp_bound_at === null) throw new NothingWritten({ kind: 'already_unbound' });

          const now = clock.now();
          const updated = await trx
            .updateTable('admin_users')
            .set({
              totp_secret_cipher: null,
              totp_bound_at: null,
              totp_last_step: null,
              row_version: target.row_version + 1,
              updated_at: now,
            })
            .where('app_id', '=', request.appId)
            .where('id', '=', target.id)
            .where('row_version', '=', target.row_version)
            .executeTakeFirst();
          if (updated.numUpdatedRows !== 1n) {
            throw new Error('admin: locked account row not updated');
          }
          await audit.appendAction(trx, {
            appId: request.appId,
            actor: OPERATOR_TOTP_RESET_ACTOR,
            action: OPERATOR_TOTP_RESET_ACTION,
            target: `admins:${target.id}`,
            before: { totp_bound: target.totp_bound_at !== null },
            after: { admin_id: target.id, totp_bound: false, reason: request.reason },
          });
          await revocations.voidBefore({ appId: request.appId, adminId: target.id }, now.getTime());
        });
      } catch (error) {
        if (error instanceof NothingWritten) return error.result;
        throw error;
      }
      return { kind: 'reset' };
    },
  };
}

/** What one chunk of raw terminal bytes did to the line being typed. */
export interface TerminalLineStep {
  /** Text to echo back (typed characters, `\b \b` per erased one). */
  readonly echo: string;
  /** Undefined while the line is open; the line on Enter; null on Ctrl-C or Ctrl-D. */
  readonly done?: string | null;
}

/**
 * The command's line editor over raw TTY bytes (D10-2999 S2). The UTF-8 decoder is streaming, so a
 * character whose bytes the terminal splits over two chunks (an SSH paste of a Chinese reason)
 * comes out whole once its last byte arrives, never as replacement characters. Backspace erases one
 * character (code point); other control characters are ignored; what follows Enter is dropped.
 * A byte order mark is kept as a character of the line, not swallowed.
 */
export function createTerminalLineEditor(): { feed(chunk: Uint8Array): TerminalLineStep } {
  // ignoreBOM: a leading U+FEFF stays in the line, so「\uFEFFyes」is not the confirmation (money r2 S2).
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let value = '';
  let closed = false;
  return {
    feed(chunk) {
      if (closed) return { echo: '' };
      let echo = '';
      for (const char of decoder.decode(chunk, { stream: true })) {
        if (char === '\r' || char === '\n') {
          closed = true;
          return { echo, done: value };
        }
        if (char === '\u0003' || char === '\u0004') {
          closed = true;
          return { echo, done: null };
        }
        if (char === '\u007f' || char === '\b') {
          if (value !== '') echo += '\b \b';
          value = [...value].slice(0, -1).join('');
        } else if (char >= ' ') {
          echo += char;
          value += char;
        }
      }
      return { echo };
    },
  };
}
