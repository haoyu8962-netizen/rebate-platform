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
// A refusal writes nothing and voids nothing. A super admin row created after the lock (only the
// bootstrap creates one, and only when there is none) is not seen; promoting an account to super
// admin is not an operation of this code base.
//
// inspect reads the target's binding state (no lock) for the command's echo before the owner
// confirms; reset judges again on the locked rows, so what changed meanwhile counts.
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

export interface OperatorTotpResetRequest extends OperatorTotpResetTarget {
  readonly reason: string;
}

export type OperatorTotpResetResult =
  | { readonly kind: 'reset' }
  | {
      readonly kind: 'refused';
      readonly reason: 'unknown' | 'not_super' | 'another_usable_super' | 'invalid_reason';
    };

type Refusal = Extract<OperatorTotpResetResult, { kind: 'refused' }>['reason'];

export interface OperatorTotpReset {
  inspect(target: OperatorTotpResetTarget): Promise<{ readonly totpBound: boolean } | null>;
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

class Refused extends Error {
  readonly reason: Refusal;
  constructor(reason: Refusal) {
    super(reason);
    this.reason = reason;
  }
}

export function createOperatorTotpReset(deps: OperatorTotpResetDeps): OperatorTotpReset {
  const { db, clock, audit, revocations } = deps;
  return {
    async inspect(target) {
      const row = await db
        .selectFrom('admin_users')
        .select(['totp_bound_at'])
        .where('app_id', '=', target.appId)
        .where('login_name', '=', target.loginName)
        .executeTakeFirst();
      return row === undefined ? null : { totpBound: row.totp_bound_at !== null };
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
          if (target === undefined) throw new Refused('unknown');
          if (!target.is_super) throw new Refused('not_super');
          const usable = rows.some(
            (row) =>
              row.id !== target.id &&
              row.is_super &&
              row.status === ACTIVE &&
              row.totp_bound_at !== null,
          );
          if (usable) throw new Refused('another_usable_super');

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
        if (error instanceof Refused) return { kind: 'refused', reason: error.reason };
        throw error;
      }
      return { kind: 'reset' };
    },
  };
}
