// Identity's read port for the withdrawal rules (task B2-05c; BR-WDR-03 ⑤ ⑥, BR-WDR-04 payee
// counts, BR-WDR-07 ③ advisory lock key): the member's CURRENT payout account only (is_current),
// as payout_method, the stored (normalised) payee_name and the account HMAC that the withdrawal
// snapshot and the payee counts use (alipay_hmac for alipay, bank_card_hmac for a bank card). On the
// caller's handle (a transaction included, READ ONLY as well): one SELECT, no cipher is read, no
// writes, no logging. Nothing bound (or another app) → null.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { FieldCrypto } from '../../platform/index.ts';
import { blocklistHmacContexts } from '../../risk/index.ts';

/** Identity-owned, current binding only; no writes and no second connection. */
export interface WithdrawSubject {
  payout_method: 'alipay' | 'bank_card' | 'wechat';
  payee_name: string;
  payee_hmac: string;
}

export interface WithdrawSubjectReader {
  read(
    handle: Kysely<DB>,
    subject: { appId: string; userId: string },
  ): Promise<WithdrawSubject | null>;
}

export function createWithdrawSubjectReader(): WithdrawSubjectReader {
  return {
    async read(handle, subject) {
      const row = await handle
        .withSchema('app')
        .selectFrom('payout_accounts')
        .select(['payout_method', 'payee_name', 'alipay_hmac', 'bank_card_hmac'])
        .where('app_id', '=', subject.appId)
        .where('user_id', '=', subject.userId)
        .where('is_current', '=', true)
        .executeTakeFirst();
      if (row === undefined) return null;
      const method = row.payout_method;
      if (method !== 'alipay' && method !== 'bank_card' && method !== 'wechat') {
        throw new Error('identity: unknown payout_method on the current payout account');
      }
      const hmac = method === 'alipay' ? row.alipay_hmac : row.bank_card_hmac;
      // payout_accounts_details_check guarantees the HMAC of the row's own method.
      if (hmac === null) throw new Error('identity: payout account row without its account HMAC');
      return { payout_method: method, payee_name: row.payee_name, payee_hmac: hmac };
    },
  };
}

/**
 * B2-05d (BR-WDR-02 ⑤, BR-WDR-07 ⑥): the payee snapshot a withdrawal fixes at creation — the current
 * binding's method, normalised name, the stored account cipher and HMAC, the bank name of a card
 * — plus the decrypted account for the response's masking only (never stored again, logged or
 * published). Decrypted with the field cipher the binding used (payout_accounts.alipay /
 * payout_accounts.bank_card contexts, B1-13e / B1-13f). On the caller's handle, no writes.
 */
export interface WithdrawPayeeSnapshot {
  payout_method: 'alipay' | 'bank_card';
  payee_name: string;
  payee_account_cipher: Buffer;
  payee_hmac: string;
  bank_name: string | null;
  account: string;
}

export interface WithdrawPayeeSnapshotReader {
  read(
    handle: Kysely<DB>,
    subject: { appId: string; userId: string },
  ): Promise<WithdrawPayeeSnapshot | null>;
}

export function createWithdrawPayeeSnapshotReader(
  crypto: Pick<FieldCrypto, 'decrypt'>,
): WithdrawPayeeSnapshotReader {
  const contexts = blocklistHmacContexts();
  return {
    async read(handle, subject) {
      const row = await handle
        .withSchema('app')
        .selectFrom('payout_accounts')
        .select([
          'payout_method',
          'payee_name',
          'alipay_hmac',
          'alipay_logon_id_cipher',
          'bank_card_hmac',
          'bank_card_no_cipher',
          'bank_name',
        ])
        .where('app_id', '=', subject.appId)
        .where('user_id', '=', subject.userId)
        .where('is_current', '=', true)
        .executeTakeFirst();
      if (row === undefined) return null;
      if (row.payout_method === 'alipay') {
        if (row.alipay_hmac === null || row.alipay_logon_id_cipher === null) {
          throw new Error('identity: alipay payout account row without its cipher or HMAC');
        }
        const cipher = Buffer.from(row.alipay_logon_id_cipher);
        return {
          payout_method: 'alipay',
          payee_name: row.payee_name,
          payee_account_cipher: cipher,
          payee_hmac: row.alipay_hmac,
          bank_name: null,
          account: crypto.decrypt(cipher.toString('utf8'), contexts.alipay),
        };
      }
      if (row.payout_method === 'bank_card') {
        if (row.bank_card_hmac === null || row.bank_card_no_cipher === null) {
          throw new Error('identity: bank card payout account row without its cipher or HMAC');
        }
        const cipher = Buffer.from(row.bank_card_no_cipher);
        return {
          payout_method: 'bank_card',
          payee_name: row.payee_name,
          payee_account_cipher: cipher,
          payee_hmac: row.bank_card_hmac,
          bank_name: row.bank_name,
          account: crypto.decrypt(cipher.toString('utf8'), contexts.bank_card),
        };
      }
      // TODO(规划/11 §2.3): 微信零钱收款账号快照 — blocked on B2-14 / CT-20 的微信收款表与密文列
      throw new Error('identity: unsupported payout_method for a withdrawal snapshot');
    },
  };
}
