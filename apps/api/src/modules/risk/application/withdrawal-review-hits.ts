// B2-05q: the hit record of a withdrawal sent to manual review by the live blocklist check of the
// automatic payout decision (规划/08 BR-ID-36 正文「每次风控规则命中必须写 1 条 risk_hits」, BR-WDR-29 ⑨
// blacklist_hit, BR-WDR-30 ⑫; 04 §3.2 risk_hits). One row per call: ref_type withdrawal, ref_id the
// withdrawal id, risk_action manual_review (the decision only sends the withdrawal to a reviewer,
// it refuses nothing), the dimension, its value digest and the rule code BLACKLIST_<DIMENSION>.
// request_type, amount_fen and the related phone columns belong to blocked requests and stay null
// (the table's checks).
//
// Everything runs on the caller's transaction — the decision's — and nowhere else: the hit commits
// or rolls back with the decision, and payout judges a withdrawal once, so a withdrawal has at
// most one such row. The rule code is registered first when the app has no row of it yet (INSERT …
// ON CONFLICT (app_id, rule_id) DO NOTHING, the values ./blocklist.ts registers, created_at and
// updated_at from the Clock instant of the hit): the foreign key risk_hits → risk_rules holds on a
// first hit, and an existing row — disabled ones included — is never changed.
//
// The rule status is not read here (B1-03zh, one read per judgement): the caller's match already
// found the rule in force and decided on it; a rule disabled since then still gets this hit, the
// record of a decision that was made.
//
// Nothing is logged: no value, digest or member id leaves through this writer.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for types, `.ts` relative imports, no decorators.
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import { newUuidV7, type Clock } from '../../platform/index.ts';
import type { BlockedHitTarget } from './blocklist.ts';

/** BR-ID-36 / BR-WDR-29 ⑨: a decided hit, recorded on the decision's transaction. */
export interface WithdrawalReviewHit extends BlockedHitTarget {
  readonly app_id: string;
  readonly user_id: string;
  readonly withdrawal_id: string;
}

export interface WithdrawalReviewHits {
  record(trx: Transaction<DB>, input: WithdrawalReviewHit): Promise<void>;
}

/** No rule-status reader: the caller already decided that this rule was in force. */
export function createWithdrawalReviewHits(options: { clock: Clock }): WithdrawalReviewHits {
  const { clock } = options;
  return Object.freeze({
    async record(trx: Transaction<DB>, input: WithdrawalReviewHit): Promise<void> {
      const now = clock.now();
      const app = trx.withSchema('app');
      await app
        .insertInto('risk_rules')
        .values({
          id: newUuidV7(now),
          app_id: input.app_id,
          rule_id: input.rule_id,
          scene: 'withdraw',
          conditions: sql`'{}'::jsonb`,
          risk_action: 'block',
          status: 'active',
          version: 1,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.columns(['app_id', 'rule_id']).doNothing())
        .execute();
      await app
        .insertInto('risk_hits')
        .values({
          app_id: input.app_id,
          user_id: input.user_id,
          rule_id: input.rule_id,
          risk_action: 'manual_review',
          dimension: input.dimension,
          value_hmac: input.value_hmac,
          ref_type: 'withdrawal',
          ref_id: input.withdrawal_id,
          request_type: null,
          related_phone_hmac: null,
          related_phone_masked: null,
          amount_fen: null,
          created_at: now,
        })
        .execute();
    },
  });
}
