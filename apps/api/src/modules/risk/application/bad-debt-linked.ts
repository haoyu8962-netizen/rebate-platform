// B2-12g: 08 BR-FUND-12「核销时给同实名、同设备、同收款账号的关联账户打风控标记」. Trace only: the marks
// change no withdrawal decision, send no notice and have no console endpoint.
//
// - risk is the only writer of app.risk_linked_marks (append only: couli_app SELECT / INSERT).
// - ledger's bad-debt approval calls mark() on its own transaction, only when it writes the
//   BAD_DEBT_WRITEOFF voucher (not on CANCELLED, not when the frozen check refuses); app.module
//   hands the marker to ledger.
// - Same real name (id_no) is not done in this phase (orchestrator D10-767): it would have to read
//   the prior identities kept by realname corrections, a privacy purpose extension; follow-up
//   FU-BAD-DEBT-LINKED-REALNAME, not scheduled. The table still accepts dimension 'id_no' for it;
//   this writer never writes it.
// - Linked accounts, same app, the written-off user excluded, one row per (user, dimension):
//   device: the devices of the written-off user's sessions (revoked ones too) are taken by
//   device_hash (a reinstall registers a new devices row with the same hash); another user with a
//   session (revoked ones too) on any devices row of the app with that hash; never devices.user_id;
//   payout_account: any payout_accounts row of the written-off user and any row of another user
//   (is_current=false history rows on both sides: only one member holds a value as current at a
//   time) with the same alipay_hmac or the same bank_card_hmac.
// - Index use: sessions by (app_id, user_id) and (app_id, device_id), devices by (app_id, id) and
//   (app_id, device_hash), payout_accounts by (app_id, user_id), (app_id, alipay_hmac) and
//   (app_id, bank_card_hmac) (the last four added by migration 0128).
// - Replays write nothing new (unique (app_id, source_ref, user_id, dimension), ON CONFLICT DO
//   NOTHING); created_at is the injected Clock's now. No plaintext and no HMAC is stored.
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

/** risk_linked_marks.dimension ('id_no' is reserved for FU-BAD-DEBT-LINKED-REALNAME, not written). */
export type BadDebtLinkedDimension = 'id_no' | 'device' | 'payout_account';

export interface BadDebtLinkedMarkInput {
  readonly appId: string;
  /** The written-off user (source_user_id). */
  readonly sourceUserId: string;
  /** The write-off candidate's id (source_ref). */
  readonly sourceRef: string;
}

export interface BadDebtLinkedMarker {
  /** Marks the linked accounts on the approving transaction. */
  mark(trx: Transaction<DB>, input: BadDebtLinkedMarkInput): Promise<void>;
}

export interface BadDebtLinkedMarkerOptions {
  readonly clock: Clock;
}

/**
 * The linked members of `input.sourceUserId` in its app, one (user, dimension) per row, the
 * written-off member excluded. UNION drops a repeated (user, dimension), so a member matched by
 * both alipay_hmac and bank_card_hmac (or by several devices) gets one row per dimension.
 */
function linkedMembers(input: BadDebtLinkedMarkInput) {
  const { appId, sourceUserId } = input;
  return sql`
    SELECT other.user_id, 'device'::text AS dimension
    FROM app.sessions mine
    JOIN app.devices mine_device
      ON mine_device.app_id = mine.app_id AND mine_device.id = mine.device_id
    JOIN app.devices other_device
      ON other_device.app_id = mine_device.app_id
      AND other_device.device_hash = mine_device.device_hash
    JOIN app.sessions other
      ON other.app_id = other_device.app_id AND other.device_id = other_device.id
    WHERE mine.app_id = ${appId} AND mine.user_id = ${sourceUserId}::uuid
      AND other.user_id <> mine.user_id
    UNION
    SELECT other.user_id, 'payout_account'::text AS dimension
    FROM app.payout_accounts mine
    JOIN app.payout_accounts other
      ON other.app_id = mine.app_id AND other.alipay_hmac = mine.alipay_hmac
    WHERE mine.app_id = ${appId} AND mine.user_id = ${sourceUserId}::uuid
      AND other.user_id <> mine.user_id
    UNION
    SELECT other.user_id, 'payout_account'::text AS dimension
    FROM app.payout_accounts mine
    JOIN app.payout_accounts other
      ON other.app_id = mine.app_id AND other.bank_card_hmac = mine.bank_card_hmac
    WHERE mine.app_id = ${appId} AND mine.user_id = ${sourceUserId}::uuid
      AND other.user_id <> mine.user_id`;
}

export function createBadDebtLinkedMarker(
  options: BadDebtLinkedMarkerOptions,
): BadDebtLinkedMarker {
  return {
    async mark(trx, input) {
      const at = options.clock.now();
      // One statement on the caller's transaction: reads and the insert see the same snapshot;
      // ordered by (user, dimension) so the identity follows a stable order.
      await sql`
        INSERT INTO app.risk_linked_marks
          (app_id, user_id, source_user_id, source_ref, dimension, created_at)
        SELECT ${input.appId}::text, linked.user_id, ${input.sourceUserId}::uuid,
          ${input.sourceRef}::text, linked.dimension, ${at}::timestamptz
        FROM (${linkedMembers(input)}) AS linked
        ORDER BY linked.user_id, linked.dimension
        ON CONFLICT (app_id, source_ref, user_id, dimension) DO NOTHING`.execute(trx);
    },
  };
}
