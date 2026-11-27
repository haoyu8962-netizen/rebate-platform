import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import { createSameDeviceLoginReader } from '../../../../apps/api/src/modules/identity/ports/same-device-logins.ts';
import { createWithdrawPayeeSnapshotReader } from '../../../../apps/api/src/modules/identity/ports/withdraw-subject.ts';
import type { WithdrawRiskFlags } from '../../../../apps/api/src/modules/payout/application/withdraw-risk-flags.ts';
import type { WithdrawRiskFlag } from '../../../../apps/api/src/modules/payout/domain/risk-flags.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import {
  createSameDeviceAccountsCheck,
  type SameDeviceAccountsOptions,
} from '../../../../apps/api/src/modules/risk/application/same-device-accounts.ts';
import { invariant, state, type Fixture } from '../apply/kit.ts';

type Method = 'alipay' | 'bank_card';
type Payee = {
  method: Method;
  name: string;
  account: string;
  hmac: string;
  cipher: Buffer;
};

export function payee(method: Method, account: string, name = '合成姓名'): Payee {
  const hmac = randomBytes(32).toString('hex');
  return { method, account, name, hmac, cipher: Buffer.from(`synthetic-cipher-${hmac}`) };
}

export function useCurrentSnapshot(f: Fixture, ...payees: Payee[]): void {
  const cleartext = new Map([[f.cipher.toString('utf8'), f.account]]);
  for (const p of payees) cleartext.set(p.cipher.toString('utf8'), p.account);
  f.options.snapshot = createWithdrawPayeeSnapshotReader({
    decrypt(ciphertext: string): string {
      const account = cleartext.get(ciphertext);
      expect(account).toBeDefined();
      return account!;
    },
  });
}

export function controlRealname(f: Fixture): (name: string | null) => void {
  let name: string | null = '合成姓名';
  const { realname } = f.options.rules;
  f.options.rules.realname = {
    async read(): ReturnType<typeof realname.read> {
      return name === null ? 'none' : 'verified';
    },
    async verified(handle, subject): ReturnType<typeof realname.verified> {
      const current = await realname.verified(handle, subject);
      return name === null || current === null ? null : { ...current, name };
    },
  };
  return (nextName): void => {
    name = nextName;
  };
}

async function rebind(trx: Transaction<DB>, f: Fixture, p: Payee): Promise<void> {
  const { appId, userId } = f.actor;
  await sql`UPDATE app.payout_accounts SET is_current = false
    WHERE app_id = ${appId} AND user_id = ${userId} AND is_current`.execute(trx);
  const alipay = p.method === 'alipay';
  await sql`INSERT INTO app.payout_accounts
    (id, app_id, user_id, payout_method, payee_name, is_current, alipay_hmac, alipay_logon_id_cipher,
     bank_card_hmac, bank_card_no_cipher, bank_name, card_bin)
    VALUES (${randomUUID()}, ${appId}, ${userId}, ${p.method}, ${p.name}, true,
      ${alipay ? p.hmac : null}, ${alipay ? p.cipher : null},
      ${alipay ? null : p.hmac}, ${alipay ? null : p.cipher},
      ${alipay ? null : '合成银行'}, ${alipay ? null : p.account.slice(0, 6)})`.execute(trx);
}

type Change = (trx: Transaction<DB>) => Promise<void>;

export function changePayee(f: Fixture, p: Payee, setName?: (name: string) => void): Change {
  return async (trx): Promise<void> => {
    await rebind(trx, f, p);
    setName?.(p.name);
  };
}

export function beforeUsersLock(f: Fixture, ...changes: Change[]) {
  const lockUsers = f.options.lockUsersForUpdate;
  let pass = 0;
  const acquire = vi.fn<typeof lockUsers>(async (trx, input): Promise<ReadonlySet<string>> => {
    const change = changes[pass];
    pass += 1;
    if (change !== undefined) {
      // The competing identity transaction commits before the application takes its users lock.
      await f.h.observer.transaction().execute(async (other): Promise<void> => {
        await sql`SET LOCAL lock_timeout = '3s'`.execute(other);
        await lockUsers(other, { appId: f.actor.appId, userIds: [f.actor.userId] });
        await change(other);
      });
    }
    return lockUsers(trx, input);
  });
  f.options.lockUsersForUpdate = acquire;
  return acquire;
}

export const PAYEE_FLAG = { code: 'payee_prev_other_user', value: true, threshold: null } as const;

export function watchRisk(f: Fixture, markedHmac: string) {
  const sameDevice = createSameDeviceAccountsCheck({
    clock: f.clock,
    logger: createRootLogger(
      { level: 'trace', entry: 'api', appEnv: 'test' },
      { write: (): void => undefined },
    ),
    logins: createSameDeviceLoginReader(),
    config(): ReturnType<SameDeviceAccountsOptions['config']> {
      return { configValue: async (): Promise<null> => null };
    },
  });
  const compute = vi.fn<WithdrawRiskFlags['compute']>(
    async (trx, subject): Promise<readonly WithdrawRiskFlag[]> => {
      // The real judgement leaves a transaction-bound row to detect leakage from a failed pass.
      await sameDevice.judge(trx, {
        app_id: subject.appId,
        user_id: subject.userId,
        ref: { type: 'withdrawal', id: subject.withdrawalId },
      });
      return subject.payeeHmac === markedHmac ? [PAYEE_FLAG] : [];
    },
  );
  f.options.riskFlags = { compute };
  return compute;
}

export async function riskJudgements(f: Fixture): Promise<{ ref_id: string }[]> {
  const { rows } = await sql<{ ref_id: string }>`SELECT ref_id FROM app.risk_judgements
    WHERE app_id = ${f.actor.appId} AND ref_type = 'withdrawal'`.execute(f.h.db);
  return rows;
}

export async function expectSingleFreeze(f: Fixture): Promise<void> {
  const result = await state(f);
  expect(result.withdrawals).toHaveLength(1);
  expect(result.vouchers).toHaveLength(1);
  expect(result.entries).toHaveLength(2);
  expect(result.balances).toMatchObject([{ available_fen: 9000n, frozen_fen: 1000n }]);
  await invariant(f);
}
