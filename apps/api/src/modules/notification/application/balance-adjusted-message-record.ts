// B2-12c: records the BALANCE_ADJUSTED in-app message of an executed manual adjustment on the
// caller's transaction (08 BR-FUND-24 ⑦, BR-TEXT-19: only on a decrease, inbox only — no push, no
// sms). The inbox notify_logs row (dedupe key `admin_adjustment:{adjust_id}`) and the inbox
// message commit or roll back with the adjustment itself; a second record of the same form writes
// nothing. The adjustment flow (ledger) receives this through app.module, never by import.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { newUuidV7 } from '../../platform/index.ts';
import {
  BALANCE_ADJUSTED_CODE,
  renderBalanceAdjustedMessage,
  type BalanceAdjustedFacts,
} from './balance-adjusted-message.ts';

export interface BalanceAdjustedRecordInput {
  readonly appId: string;
  readonly userId: string;
  /** The executed form (the reversal's own id for a reversal). */
  readonly adjustId: string;
  readonly facts: BalanceAdjustedFacts;
  /** The adjustment's instant (its injected Clock). */
  readonly now: Date;
}

/** True when a message was written (a decrease seen for the first time). */
export async function recordBalanceAdjustedMessage(
  trx: Transaction<DB> | Kysely<DB>,
  input: BalanceAdjustedRecordInput,
): Promise<boolean> {
  if (input.facts.direction !== 'decrease') return false;
  const db = trx.withSchema('app');
  const { now } = input;
  const override = await db
    .selectFrom('notify_templates')
    .select(['title_override', 'body_override'])
    .where('app_id', '=', input.appId)
    .where('code', '=', BALANCE_ADJUSTED_CODE)
    .where('variant', '=', 'default')
    .executeTakeFirst();
  const message = renderBalanceAdjustedMessage(input.facts, override ?? null);
  if (message === null) return false;
  const logged = await db
    .insertInto('notify_logs')
    .values({
      id: newUuidV7(now),
      app_id: input.appId,
      user_id: input.userId,
      code: message.code,
      channel: 'inbox',
      dedupe_key: `admin_adjustment:${input.adjustId}`,
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
