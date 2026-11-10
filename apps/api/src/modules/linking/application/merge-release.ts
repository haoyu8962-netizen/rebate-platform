// B1-20c: linking's share of the account merge (规划/08 BR-ID-06「当前账号联盟绑定直接置 released（不冷却）」;
// BR-ID-19 / BR-ID-20; orchestrator D10-1099), called by identity on the merge transaction through
// app.module's assembly. Rule tests: test/spec/linking/merge-release/**.
// - Every union_bindings row of the source user (this app only) that is active or invalid becomes
//   released with released_at = cooldown_until = `at` (no cooling period: the same union account
//   and relation id can be authorised again by anyone right away), row_version + 1, updated_at =
//   `at`; relation_id, union_account_id, bound_at and blocked_reason are kept. The rows stay with
//   the source (the tombstone): nothing is moved to the target, no row is inserted or deleted.
// - blocked, released and unbound rows are not touched.
// - Takes the bindings' user lock (binding-lock.ts) like every other writer, on the caller's
//   transaction only; re-entrant (a second call changes nothing).
// - One set-based UPDATE whose source statuses are checked against canTransitionBinding, i.e. the
//   generated union-binding transition() (CT-10a U9, asked at every call; as the deletion cleanup
//   does): a writer without the user lock (the inspection turning active into invalid) is waited
//   for by the row lock and the row re-evaluated against the status set.
// hasAdminDisabledBinding is the merge condition D10-1099 Q-4 (a source with a blocked
// (admin_disable) binding is not merged: releasing it without cooling would wash the console's
// penalty off the relation id); read only, on the caller's executor.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { canTransitionBinding, type BindingStatus } from '../domain/binding-status-transitions.ts';
import { lockBindingUser } from './binding-lock.ts';

export interface ReleaseForMergeInput {
  readonly appId: string;
  /** The source account of the merge (the third-party account that becomes a tombstone). */
  readonly userId: string;
  /** The merge's Clock reading. */
  readonly at: Date;
}

/** The statuses a merge releases (BR-ID-06); each must be a legal change to released (per call). */
function releasable(): readonly BindingStatus[] {
  return (['active', 'invalid'] as const).filter((from) => canTransitionBinding(from, 'released'));
}

/** Releases the source's bindings without cooling, on the caller's transaction. */
export async function releaseForMerge(
  trx: Transaction<DB>,
  input: ReleaseForMergeInput,
): Promise<void> {
  const { appId, userId, at } = input;
  if (!(await lockBindingUser(trx, appId, userId))) return;
  const sources = releasable();
  if (sources.length === 0) return;
  await trx
    .updateTable('union_bindings')
    .set((eb) => ({
      status: 'released',
      released_at: at,
      cooldown_until: at,
      updated_at: at,
      row_version: eb('row_version', '+', 1),
    }))
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .where('status', 'in', [...sources])
    .execute();
}

/** D10-1099 Q-4: true when the user has a binding the console disabled (blocked admin_disable). */
export async function hasAdminDisabledBinding(
  db: Kysely<DB>,
  input: { readonly appId: string; readonly userId: string },
): Promise<boolean> {
  const row = await db
    .withSchema('app')
    .selectFrom('union_bindings')
    .select('id')
    .where('app_id', '=', input.appId)
    .where('user_id', '=', input.userId)
    .where('status', '=', 'blocked')
    .where('blocked_reason', '=', 'admin_disable')
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}
