// B1-06zc: linking's share of identity's deletion cleanup (08 BR-ID-28 细则「注销删除与保留范围」:
// 联盟绑定 blocked（deletion）; BR-ID-20; identity/ports/deletion-cleanup.ts DeletionCleanupStep),
// assembled by app.module in place of linking's unavailable marker.
// - Every union_bindings row of the user (this app only) that can still become blocked (active,
//   invalid, pending_auth) becomes blocked with blocked_reason deletion (row_version + 1,
//   updated_at = at; bound_at, relation_id and the release instants kept).
// - Rows already blocked keep their reason (a banned user's bindings stay ban, admin_disable
//   stays); released and unbound rows are untouched; no row is deleted or inserted; link_logs are
//   kept (BR-ID-30 ②).
// - Runs on identity's cleanup transaction (users row already locked) and is re-entrant: a second
//   call changes nothing. Rule tests: test/spec/linking/deletion-cleanup/**.
// - Takes the bindings' user lock (binding-lock.ts) like every other writer, then one set-based
//   UPDATE whose source statuses come from canTransitionBinding (no per-row compare-and-set: a
//   writer without the user lock, such as the inspection turning active into invalid, is waited
//   for by the row lock and the row is re-evaluated against the status set, so it is never
//   silently skipped).
// - B1-06zi: app.union_pdd_pid_filings rows are kept (insert-only facts under the tombstoned
//   user_id; migration 0135 header): usability is gated by the binding, blocked here.
// TODO(规划/11 §4.5): 换用生成的 transition() — blocked on CT-10 状态机生成器（approvals #26）
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { canTransitionBinding, type BindingStatus } from '../domain/binding-status-transitions.ts';
import { lockBindingUser } from './binding-lock.ts';

export interface BlockForDeletionInput {
  readonly appId: string;
  readonly userId: string;
  /** The cleanup step's Clock reading. */
  readonly at: Date;
}

const STATUSES: readonly BindingStatus[] = [
  'unbound',
  'pending_auth',
  'active',
  'invalid',
  'blocked',
  'released',
];

/** The statuses a binding may leave for blocked (the transition table decides). */
const BLOCKABLE: readonly BindingStatus[] = Object.freeze(
  STATUSES.filter((from) => canTransitionBinding(from, 'blocked')),
);

/** identity's DeletionCleanupStep for linking, on the caller's transaction. */
export async function blockForDeletion(
  trx: Transaction<DB>,
  input: BlockForDeletionInput,
): Promise<void> {
  const { appId, userId, at } = input;
  if (!(await lockBindingUser(trx, appId, userId))) return;
  await trx
    .updateTable('union_bindings')
    .set((eb) => ({
      status: 'blocked',
      blocked_reason: 'deletion',
      updated_at: at,
      row_version: eb('row_version', '+', 1),
    }))
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .where('status', 'in', [...BLOCKABLE])
    .execute();
}
