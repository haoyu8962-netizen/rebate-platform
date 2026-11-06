// B2-08f: synthetic W9-returned withdrawal with a chosen created_at. Seed and FREEZE
// logic adapted from tax-ytd/kit.ts whose helper requires a port-level fixture.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { buildVouchers } from '@couli/domain';
import { sql, type Transaction } from 'kysely';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import type { Ledger, PostingEntry } from '../../../../apps/api/src/modules/ledger/index.ts';
import type { WriteOffFixture, Seeded } from '../../ledger/admin-recon-write-off/kit.ts';

const SERVICE_FEE = 'SERVICE_FEE';
const MINUTE = 60_000;
const RETURNED_AT = new Date('2027-01-02T02:00:00.000Z');

async function freeze(
  trx: Transaction<DB>,
  ledger: Ledger,
  appId: string,
  userId: string,
  withdrawalId: string,
  amount: bigint,
): Promise<void> {
  await lockUsersForUpdate(trx, { appId, userIds: [userId] });
  const [balance] = await ledger.lockBalances(trx, { appId, userIds: [userId] });
  const [built] = buildVouchers('WITHDRAW:FREEZE', {
    withdrawal_id: withdrawalId,
    user_id: userId,
    withdraw_fen: amount,
  });
  if (balance === undefined || built === undefined) {
    throw new Error('seed: the member has no balance row or FREEZE built no voucher');
  }
  const entries: PostingEntry[] = built.entries.map((entry) => ({
    account: { ownerType: 'user', accountId: balance.account_id },
    sub_account: entry.sub_account === 'frozen' ? 'frozen' : 'available',
    amount_fen: entry.amount_fen,
    ledger_type: entry.ledger_type,
    sub_type: entry.sub_type,
    income_type: null,
  }));
  await ledger.post(trx, {
    appId,
    uniqKey: built.uniq_key,
    bizType: 'withdrawal',
    bizId: withdrawalId,
    operator: 'system',
    memo: null,
    orderKey: null,
    beneficiaryUserId: null,
    role: null,
    voucherKind: null,
    entries,
  });
}

export async function seedReturnedAt(
  f: WriteOffFixture,
  values: { readonly userId: string; readonly createdAt: Date },
): Promise<Seeded> {
  const id = randomUUID();
  const appId = f.appId;
  const owner = values.userId;
  const net = 8_000n;
  const fee = 300n;
  const tax = 2_000n;
  const amount = 10_300n;
  const outBizNo = randomBytes(16).toString('hex');
  const batchId = randomUUID();
  const reviewedAt = new Date(RETURNED_AT.getTime() - 30 * MINUTE);
  await sql`INSERT INTO app.payout_batches (id, app_id, kind, created_by, created_at)
    VALUES (${batchId}, ${appId}, 'manual', 'finance:synthetic', ${reviewedAt})`.execute(f.db);
  await f.db.transaction().execute(async (trx) => {
    await sql`INSERT INTO app.withdrawals
      (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
       payee_name, payee_account_cipher, payee_hmac, status, out_biz_no, payout_channel,
       review_mode, reviewer_id, reviewed_at, batch_id, execute_seq, hold_reason, hold_at,
       row_version, created_at, updated_at)
      VALUES (${id}, ${appId}, ${owner}, ${amount}, ${fee}, ${tax}, ${net}, ${SERVICE_FEE},
       'alipay', '合成姓名', ${Buffer.from('synthetic-encrypted-account')},
       ${randomBytes(32).toString('hex')}, 'APPROVED', ${outBizNo}, 'alipay', 'manual',
       ${randomUUID()}, ${reviewedAt}, ${batchId}, 1, 'payer_side_after_transfer',
       ${RETURNED_AT}, 3, ${values.createdAt}, ${RETURNED_AT})`.execute(trx);
    await freeze(trx, f.ledger, appId, owner, id, amount);
  });
  await sql`INSERT INTO app.payout_attempts
    (id, app_id, withdrawal_id, kind, request, response, resp_code, resp_sub_code, result, at)
    VALUES (${randomUUID()}, ${appId}, ${id}, 'transfer',
      ${JSON.stringify({ logon_id: 'log**********26' })}::jsonb,
      ${JSON.stringify({ code: '40004' })}::jsonb, '40004', 'TEST_PAYER_SIDE', 'fail',
      ${RETURNED_AT})`.execute(f.payout);
  return { id, appId, userId: owner, outBizNo, net, fee, tax, amount, status: 'APPROVED' };
}
