// B3-16a (D10-1244 / approvals 71) · BR-AI-01 细则「收益查询」/ BR-AI-02 ③ / BR-AI-04 (D32): the
// production EarningsReads of get_my_earnings, built by the composition root (beside app.module,
// outside modules/**) so the agent module neither imports ledger / payout nor hands a database
// handle to them. Rule tests: test/spec/agent/earnings-tool/**.
//
// createEarningsReads({db, clock, wallet}): EarningsReads. read(subject) calls, for that subject
//   only, ledger/read.ts getWalletSummary (the query behind GET /v1/wallet/summary) and
//   payout/read.ts listWithdrawalsForUser (the query behind GET /v1/withdrawals; newest first, its
//   first item is the latest withdrawal, none → null), one after the other in one read-only
//   REPEATABLE READ transaction (one snapshot for the card). Nothing else of ledger or payout is
//   imported; nothing is computed, cached or written. A failure of either query rejects.
//   app.module hands the result to the stream entry as AgentEarningsProvidedPorts.earningsReads.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { EarningsReads } from './modules/agent/tools/earnings/index.ts';
import { getWalletSummary } from './modules/ledger/read.ts';
import { listWithdrawalsForUser } from './modules/payout/read.ts';
import type { Clock } from './modules/platform/index.ts';

export interface EarningsReadsDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** getWalletSummary's owner-module ports (its third parameter). */
  readonly wallet: Parameters<typeof getWalletSummary>[2];
}

export function createEarningsReads(deps: EarningsReadsDeps): EarningsReads {
  const { db, clock, wallet } = deps;
  return {
    async read(subject) {
      // Only the caller's own app and user (server side), never anything from the model.
      const who = { appId: subject.appId, userId: subject.userId };
      // Both queries for this one call, one after the other on one read-only REPEATABLE READ
      // transaction, so the card's figures come from one snapshot (BR-AI-04). Nothing cached; a
      // failure of either rejects the read (the transaction rolls back).
      const readBoth = async (trx: Kysely<DB>) => {
        const summary = await getWalletSummary(trx, who, wallet);
        const records = await listWithdrawalsForUser(
          trx,
          { ...who, limit: 1 },
          { now: clock.now() },
        );
        return { wallet: summary, latestWithdrawal: records.items[0] ?? null };
      };
      // A caller's transaction already is one snapshot (the owner modules' readOnly does the same).
      if (db.isTransaction) return readBoth(db);
      return db
        .transaction()
        .setIsolationLevel('repeatable read')
        .setAccessMode('read only')
        .execute((trx: Transaction<DB>) => readBoth(trx));
    },
  };
}
