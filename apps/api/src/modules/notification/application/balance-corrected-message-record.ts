// B2-02z: records the BALANCE_CORRECTED in-app message of a balance recalculation on the caller's
// transaction (D10-2092 ⑤, D10-2097; contracts/openapi.yaml recalcBalanceAdminReconDiff 「Member
// notice」): inbox only — no push, no sms. users.status is read on the caller's transaction: a
// member who is `deleting` or `deleted` gets nothing; a member in the cooling-off period of a
// deletion request (status still one that signs in) gets it as usual. The inbox notify_logs row
// (dedupe key `balance_corrected:{reconDiffId}:{balanceVersion}`, the pair of the B2-02x voucher
// source `recalc:<recon_diff_id>:<version>`, D10-2084) and the inbox message commit or roll back with
// the recalculation itself; a second record of the same pair writes nothing. The recalculation
// (ledger) receives this through app.module, never by import.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { newUuidV7 } from '../../platform/index.ts';
import {
  BALANCE_CORRECTED_CODE,
  renderBalanceCorrectedMessage,
  type BalanceCorrectedFacts,
} from './balance-corrected-message.ts';

export interface BalanceCorrectedRecordInput {
  readonly appId: string;
  readonly userId: string;
  /** The recon_diffs row whose recalculation corrected the balance. */
  readonly reconDiffId: string;
  /** The balance row's version after the recalculation wrote it. */
  readonly balanceVersion: number;
  readonly facts: BalanceCorrectedFacts;
  /** The recalculation's instant (its injected Clock). */
  readonly now: Date;
}

/** users.status values of an account being deleted or already deleted (D10-2097). */
const GONE_STATUSES: ReadonlySet<string> = new Set(['deleting', 'deleted']);

/** True when a message was written (a changed available balance seen for the first time). */
export async function recordBalanceCorrectedMessage(
  trx: Transaction<DB> | Kysely<DB>,
  input: BalanceCorrectedRecordInput,
): Promise<boolean> {
  if (input.facts.before_fen === input.facts.after_fen) return false;
  const db = trx.withSchema('app');
  const { now } = input;
  // A plain read on the caller's transaction (no row lock: the recalculation already holds the
  // balance lock, and locking users after it would invert the users → balance lock order).
  const user = await db
    .selectFrom('users')
    .select('status')
    .where('app_id', '=', input.appId)
    .where('id', '=', input.userId)
    .executeTakeFirst();
  if (user === undefined || GONE_STATUSES.has(user.status)) return false;
  const override = await db
    .selectFrom('notify_templates')
    .select(['title_override', 'body_override'])
    .where('app_id', '=', input.appId)
    .where('code', '=', BALANCE_CORRECTED_CODE)
    .where('variant', '=', 'default')
    .executeTakeFirst();
  const message = renderBalanceCorrectedMessage(input.facts, override ?? null);
  if (message === null) return false;
  const logged = await db
    .insertInto('notify_logs')
    .values({
      id: newUuidV7(now),
      app_id: input.appId,
      user_id: input.userId,
      code: message.code,
      channel: 'inbox',
      dedupe_key: `balance_corrected:${input.reconDiffId}:${String(input.balanceVersion)}`,
      planned_at: now,
      sent_at: now,
      status: 'success',
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(['app_id', 'dedupe_key']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (logged === undefined) return false;
  await db
    .insertInto('inbox_messages')
    .values({
      message_id: newUuidV7(now),
      app_id: input.appId,
      user_id: input.userId,
      code: message.code,
      title: message.title,
      body: message.body,
      route: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return true;
}
