// B2-05e: the negative balance handling of BR-WDR-05 (a). ledger publishes account.went_negative
// when a posting takes a member's available below zero; this consumer (worker entry, queue
// evt.payout-went-negative, one worker) re-checks under the locks and acts:
//   still negative   every PENDING_REVIEW / APPROVED withdrawal of the member without any
//                    transfer attempt is system-rejected (W3 NEGATIVE_BALANCE, WITHDRAW:RETURN
//                    back to available, so the returned money offsets the debt); an APPROVED one
//                    with an attempt is only blocked (blocked_reason NEGATIVE_BALANCE) and warned
//                    (`withdrawal_blocked_negative`); PAYING ones are left to the payout process
//                    (W9's recheck re-runs `run` for the member, B2-06). B2-09p (BR-WDR-10,
//                    D10-619): each system rejection writes one audit record on the same
//                    transaction, system_actor system:payout.
//   back to ≥ 0      only the block is cleared. 08 places this clearing in the posting transaction
//                    that restores the balance; ledger cannot write withdrawals, so this consumer
//                    clears it when it re-checks (transitional, recorded in the lane's followups).
// Deduplication: processed_events (consumer, event_id) claimed in the same transaction as the
// effects — through registerEventConsumer in production, and here for a direct `consume` — so
// a failed attempt leaves no claim and a redelivery runs once. Logs carry ids only.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { ReceivedEvent } from '../../platform/index.ts';
import { WITHDRAWAL_REJECT_AUDIT_ACTION } from './admin-withdrawal-review.ts';
import { createWithdrawalCommands, type WithdrawalCommandsOptions } from './withdrawal-commands.ts';

export const WENT_NEGATIVE_CONSUMER = 'payout-went-negative';
const BLOCKED_NEGATIVE = 'NEGATIVE_BALANCE';
const REASON_NEGATIVE = 'NEGATIVE_BALANCE';
const OPEN_FOR_REJECT: readonly string[] = ['PENDING_REVIEW', 'APPROVED'];

/** admin's system audit, by shape: payout imports nothing from admin (B2-09p, BR-WDR-10). */
export interface WentNegativeAuditPort {
  appendAction(
    trx: Transaction<DB>,
    input: {
      readonly appId: string;
      readonly actor: 'system:payout';
      readonly action: string;
      readonly target: string;
      readonly before: { readonly withdrawal_id: string; readonly status: string };
      readonly after: {
        readonly withdrawal_id: string;
        readonly status: string;
        readonly reason_code: string;
        readonly note: null;
      };
    },
  ): Promise<void>;
}

export interface WentNegativeOptions extends WithdrawalCommandsOptions {
  db: Kysely<DB>;
  logger: { warn(fields: Record<string, unknown>, message: string): void };
  /** B2-09p: omitted only by tests of the rejection itself; the worker entry always passes it. */
  audit?: WentNegativeAuditPort;
}
export interface WentNegativeConsumer {
  /** Own transaction; processed_events claim and business effects commit together. */
  consume(event: ReceivedEvent): Promise<void>;
  /** The handler registerEventConsumer runs inside its claim transaction (worker wiring). */
  handle(event: ReceivedEvent, trx: Transaction<DB>): Promise<void>;
  /** W9's follow-up job uses the same locked recheck, without event-id deduplication. */
  run(input: { appId: string; userId: string }): Promise<void>;
}

function userIdOf(event: ReceivedEvent): string {
  const value = (event.payload as Record<string, unknown>)['user_id'];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('payout: account.went_negative without user_id');
  }
  return value;
}

export function createWentNegativeConsumer(options: WentNegativeOptions): WentNegativeConsumer {
  const { db, logger, ledger } = options;
  const commands = createWithdrawalCommands(options);

  /** The locked recheck (users row → balance row), then the member's open withdrawals. */
  async function recheck(
    trx: Transaction<DB>,
    input: { appId: string; userId: string },
  ): Promise<void> {
    await options.lockUsersForUpdate(trx, { appId: input.appId, userIds: [input.userId] });
    const balances = await ledger.lockBalances(trx, {
      appId: input.appId,
      userIds: [input.userId],
    });
    const own = balances.find((row) => row.user_id === input.userId);
    const available = own === undefined ? 0n : own.available_fen;
    if (available >= 0n) {
      await trx
        .withSchema('app')
        .updateTable('withdrawals')
        .set({ blocked_reason: null })
        .where('app_id', '=', input.appId)
        .where('user_id', '=', input.userId)
        .where('blocked_reason', '=', BLOCKED_NEGATIVE)
        .execute();
      return;
    }
    const open = await trx
      .withSchema('app')
      .selectFrom('withdrawals')
      .select(['id', 'status', 'row_version'])
      .where('app_id', '=', input.appId)
      .where('user_id', '=', input.userId)
      .where('status', 'in', [...OPEN_FOR_REJECT])
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    for (const row of open) {
      const result = await commands.systemRejectNegative(trx, {
        appId: input.appId,
        withdrawalId: row.id,
        expectedStatus: row.status as 'PENDING_REVIEW' | 'APPROVED',
        expectedRowVersion: row.row_version,
        reviewerId: null,
      });
      if (result.kind === 'changed') {
        // BR-WDR-10: on this transaction, so it commits or rolls back with the rejection.
        await options.audit?.appendAction(trx, {
          appId: input.appId,
          actor: 'system:payout',
          action: WITHDRAWAL_REJECT_AUDIT_ACTION,
          target: row.id,
          before: { withdrawal_id: row.id, status: row.status },
          after: {
            withdrawal_id: row.id,
            status: result.status,
            reason_code: REASON_NEGATIVE,
            note: null,
          },
        });
        continue;
      }
      // A transfer attempt exists: the money may already be on its way; block, never refund.
      await trx
        .withSchema('app')
        .updateTable('withdrawals')
        .set({ blocked_reason: BLOCKED_NEGATIVE })
        .where('app_id', '=', input.appId)
        .where('id', '=', row.id)
        .where('status', '=', row.status)
        .execute();
      logger.warn(
        {
          app_id: input.appId,
          user_id: input.userId,
          withdrawal_id: row.id,
          reason: result.reason,
        },
        'withdrawal_blocked_negative',
      );
    }
  }

  return {
    async handle(event, trx) {
      await recheck(trx, { appId: event.appId, userId: userIdOf(event) });
    },
    async consume(event) {
      const userId = userIdOf(event);
      await db.transaction().execute(async (trx) => {
        const claimed = await trx
          .withSchema('app')
          .insertInto('processed_events')
          .values({ consumer: WENT_NEGATIVE_CONSUMER, event_id: event.eventId })
          .onConflict((oc) => oc.columns(['consumer', 'event_id']).doNothing())
          .returning('event_id')
          .executeTakeFirst();
        if (claimed === undefined) return;
        await recheck(trx, { appId: event.appId, userId });
        await sql`select 1`.execute(trx);
      });
    },
    async run(input) {
      await db.transaction().execute((trx) => recheck(trx, input));
    },
  };
}
