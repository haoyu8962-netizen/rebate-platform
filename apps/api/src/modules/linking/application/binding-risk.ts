// F1-07c: the ban / unban ports of the user's union bindings (BR-ID-20, BR-ID-31; ruling 2 of
// couli-runs/ADMIN-backend/f107-plan.md), called by F1-07d on its own transaction so the risk
// state change and the bindings commit or roll back together; linking stays the bindings' only
// writer.
// - blockForBan: every active / invalid / pending_auth binding of the user (all platforms) becomes
//   blocked with blocked_reason ban (row_version + 1; bound_at and the release instants kept). A
//   binding already blocked keeps its reason (admin_disable is never overwritten), released and
//   unbound rows are untouched; a second call changes nothing.
// - restoreAfterUnban: only bindings blocked for ban come back (blocked_reason cleared): Taobao's
//   become invalid (row_version + 1; the user authorizes again before rebates resume), another
//   union's become active at once (BR-ID-20, owner 2026-10-18: no re-authorization there), in two
//   steps blocked → invalid → active on the same transaction (restoreSteps; each step + 1), and
//   the user's unresolved 30151 rows of that platform are resolved as for any activation.
//   admin_disable comes back only through the console's enable, deletion only through the daily
//   release task.
// Both take the user lock (binding-lock.ts) first, on the caller's transaction; each change is
// judged by canTransitionBinding (the generated union-binding transition(), CT-10a: ban U8, unban
// U7 then on another union U4) and written by a compare-and-set on the row_version read with it
// (a writer without the lock, such as the inspection, winning the race → read again); a refused
// step throws, so the caller's transaction rolls the whole operation back.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { canTransitionBinding } from '../domain/binding-status-transitions.ts';
import { resolveBindingConflictsOnActive } from '../infra/binding-conflicts.ts';
import { lockBindingUser } from './binding-lock.ts';

export interface BindingRiskInput {
  readonly appId: string;
  readonly userId: string;
  readonly clock: Clock;
}

/** Bounded re-reads when a writer without the user lock changed a row under us. */
const ATTEMPTS = 4;

/**
 * BR-ID-20 (owner 2026-10-18): the statuses a binding blocked for ban or admin_disable is written
 * through when it comes back, in order. Taobao: invalid (the user authorizes again). Another union
 * has no re-authorization: active at once, through invalid (the existing edges only).
 */
export function restoreSteps(platform: string): readonly ('invalid' | 'active')[] {
  return platform === 'taobao' ? ['invalid'] : ['invalid', 'active'];
}

interface RiskRow {
  readonly platform: string;
  readonly status: string;
  readonly blocked_reason: string | null;
}

interface RiskChange {
  readonly name: string;
  /** Whether this row is one the change applies to. */
  readonly applies: (row: RiskRow) => boolean;
  /** The statuses written in order. */
  readonly steps: (row: RiskRow) => readonly ('blocked' | 'invalid' | 'active')[];
  readonly blockedReason: 'ban' | null;
}

const BAN: RiskChange = {
  name: 'blockForBan',
  applies: (row) => ['active', 'invalid', 'pending_auth'].includes(row.status),
  steps: () => ['blocked'],
  blockedReason: 'ban',
};

const UNBAN: RiskChange = {
  name: 'restoreAfterUnban',
  applies: (row) => row.status === 'blocked' && row.blocked_reason === 'ban',
  steps: (row) => restoreSteps(row.platform),
  blockedReason: null,
};

async function apply(
  trx: Transaction<DB>,
  input: BindingRiskInput,
  change: RiskChange,
): Promise<void> {
  const { appId, userId, clock } = input;
  if (!(await lockBindingUser(trx, appId, userId))) return;
  for (let attempt = 1; ; attempt += 1) {
    const rows = await trx
      .selectFrom('union_bindings')
      .select(['id', 'platform', 'status', 'blocked_reason', 'row_version'])
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .execute();
    const due = rows.filter(change.applies);
    if (due.length === 0) return;
    const now = clock.now();
    let lost = false;
    for (const row of due) {
      let status = row.status;
      let version = row.row_version;
      for (const [index, to] of change.steps(row).entries()) {
        if (!canTransitionBinding(status, to)) {
          throw new Error(`union_bindings: illegal status transition ${status} → ${to}`);
        }
        const updated = await trx
          .updateTable('union_bindings')
          .set((eb) => ({
            status: to,
            blocked_reason: change.blockedReason,
            updated_at: now,
            row_version: eb('row_version', '+', 1),
          }))
          .where('id', '=', row.id)
          .where('app_id', '=', appId)
          .where('user_id', '=', userId)
          .where('status', '=', status)
          .where('row_version', '=', version)
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) {
          // A later step: this transaction holds the row's lock since its first step.
          if (index > 0) throw new Error(`linking: ${change.name} lost a row between its steps`);
          lost = true;
          break;
        }
        status = to;
        version += 1;
        // A binding that has just become active resolves the user's 30151 rows (BR-ID-18).
        if (to === 'active') {
          await resolveBindingConflictsOnActive(trx, appId, userId, row.platform, now);
        }
      }
    }
    if (!lost) return;
    if (attempt >= ATTEMPTS) throw new Error(`linking: ${change.name} kept losing the row`);
  }
}

/** F1-07d supplies its transaction; linking remains the binding's only writer. */
export async function blockForBan(trx: Transaction<DB>, input: BindingRiskInput): Promise<void> {
  await apply(trx, input, BAN);
}

export async function restoreAfterUnban(
  trx: Transaction<DB>,
  input: BindingRiskInput,
): Promise<void> {
  await apply(trx, input, UNBAN);
}
