// B1-06zi (BR-ID-22 「拼多多：授权状态按 (user_id, pid) 记录」; FU-PDD-BINDING-PID second order):
// linking's reads and writes of app.union_pdd_pid_filings (migration 0135; couli_app SELECT /
// INSERT only). One row = "the authority query answered filed for this user on this pid at
// filed_at, asked through union_account_id". The lookup key is (app_id, user_id, pid); the account
// is recorded only. Both calls run on the executor the caller passes (the open's transaction, the
// refresh's or the share's activation transaction): no second pooled connection. The insert is
// insert-if-absent (ON CONFLICT (app_id, user_id, pid) DO NOTHING), so two concurrent "filed"
// answers leave one row and neither fails; filed_at and created_at are both the caller's injected
// Clock reading and the id is generated here (no SQL clock, no SQL default). A row is never updated or deleted.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { newUuidV7 } from '../../platform/index.ts';

export interface PddPidFilingKey {
  readonly appId: string;
  readonly userId: string;
  readonly pid: string;
}

/** Whether the user has a filing row on this pid. */
export async function hasPddPidFiling(
  executor: Kysely<DB>,
  key: PddPidFilingKey,
): Promise<boolean> {
  const row = await executor
    .selectFrom('union_pdd_pid_filings')
    .select('id')
    .where('app_id', '=', key.appId)
    .where('user_id', '=', key.userId)
    .where('pid', '=', key.pid)
    .executeTakeFirst();
  return row !== undefined;
}

/** Records the filing of this pid (insert-if-absent; an existing row is left as it is). */
export async function recordPddPidFiling(
  executor: Kysely<DB>,
  input: PddPidFilingKey & { readonly unionAccountId: string; readonly filedAt: Date },
): Promise<void> {
  await executor
    .insertInto('union_pdd_pid_filings')
    .values({
      id: newUuidV7(input.filedAt),
      app_id: input.appId,
      user_id: input.userId,
      pid: input.pid,
      union_account_id: input.unionAccountId,
      platform: 'pdd',
      filed_at: input.filedAt,
      // created_at is written from the same injected Clock reading, not the column's DEFAULT
      // now(), so a staging run with an advanced clock keeps both columns on one timeline.
      created_at: input.filedAt,
    })
    .onConflict((oc) => oc.columns(['app_id', 'user_id', 'pid']).doNothing())
    .execute();
}
