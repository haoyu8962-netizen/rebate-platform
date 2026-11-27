import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createWithdrawSubjectReader } from '../../../../../apps/api/src/modules/identity/ports/withdraw-subject.ts';
import type { WithdrawPayeeSnapshot } from '../../../../../apps/api/src/modules/payout/application/withdraw-apply.ts';
import {
  close,
  fixture,
  open,
  rows,
  state,
  success,
  TIMEOUT,
  type Fixture,
  type Harness,
} from '../../apply/kit.ts';
import {
  beforeUsersLock,
  changePayee,
  expectSingleFreeze,
  payee,
  useCurrentSnapshot,
} from '../kit.ts';

const ALIPAY_CAP = 'withdraw.method_max_amount_fen.alipay';
const BANK_CARD_CAP = 'withdraw.method_max_amount_fen.bank_card';

let h: Harness;
beforeAll(async (): Promise<void> => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async (): Promise<void> => {
  await close(h);
}, TIMEOUT);

function apply(f: Fixture): ReturnType<Fixture['apply']> {
  return f.h.db.transaction().execute((trx): ReturnType<Fixture['apply']> => f.apply(trx, 1000n));
}

type Payee = ReturnType<typeof payee>;

function useSnapshotWithoutBindingId(f: Fixture, next: Payee): void {
  const accountsByCipher = new Map([
    [f.cipher.toString('utf8'), f.account],
    [next.cipher.toString('utf8'), next.account],
  ]);
  f.options.snapshot = {
    async read(handle, who): Promise<WithdrawPayeeSnapshot | null> {
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
        .where('app_id', '=', who.appId)
        .where('user_id', '=', who.userId)
        .where('is_current', '=', true)
        .executeTakeFirst();
      if (row === undefined) return null;
      const method = row.payout_method;
      if (method !== 'alipay' && method !== 'bank_card') {
        throw new Error('测试夹具仅支持支付宝和银行卡');
      }
      const hmac = method === 'alipay' ? row.alipay_hmac : row.bank_card_hmac;
      const cipher = method === 'alipay' ? row.alipay_logon_id_cipher : row.bank_card_no_cipher;
      if (hmac === null || cipher === null) throw new Error('测试夹具缺少账号 HMAC 或密文');
      const account = accountsByCipher.get(cipher.toString('utf8'));
      if (account === undefined) throw new Error('测试夹具缺少密文对应的合成账号');
      return {
        payout_method: method,
        payee_name: row.payee_name,
        payee_account_cipher: cipher,
        payee_hmac: hmac,
        bank_name: row.bank_name,
        account,
      };
    },
  };
}

function useSubjectWithoutBindingId(f: Fixture, next: Payee): void {
  useCurrentSnapshot(f, next);
  const subject = createWithdrawSubjectReader();
  f.options.rules.subject = {
    read(handle, who): ReturnType<typeof subject.read> {
      return subject.read(handle, who);
    },
  };
}

async function prepareRebind(
  f: Fixture,
  next: Payee,
  assemble: (fixture: Fixture, payee: Payee) => void,
): Promise<ReturnType<typeof beforeUsersLock>> {
  await f.set(ALIPAY_CAP, 2000);
  await f.set(BANK_CARD_CAP, 500);
  assemble(f, next);
  return beforeUsersLock(f, changePayee(f, next));
}

it(
  '[AC-B2-05va#2] 锁外通过后调低支付宝单笔上限，锁内照常建单冻结',
  async (): Promise<void> => {
    const f = await fixture(h, { method: 'alipay' });
    await f.set(ALIPAY_CAP, 2000);
    const acquire = beforeUsersLock(f, async (other): Promise<void> => {
      const updated = await other
        .withSchema('app')
        .updateTable('config_items')
        .set({ value: 500, version: sql<number>`version + 1` })
        .where('app_id', '=', f.actor.appId)
        .where('key', '=', ALIPAY_CAP)
        .returning('value')
        .executeTakeFirstOrThrow();
      expect(updated.value).toBe(500);
    });

    success(await apply(f));
    expect(acquire).toHaveBeenCalledTimes(1);
    await expectSingleFreeze(f);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05va#3] 快照无绑定行 ID 时，同 HMAC 换银行卡仍重跑并按银行卡上限拒绝',
  async (): Promise<void> => {
    const f = await fixture(h, { method: 'alipay' });
    const next = { ...payee('bank_card', '6222020000000222'), hmac: f.hmac };
    const acquire = await prepareRebind(f, next, useSnapshotWithoutBindingId);
    const before = await state(f);

    expect(await apply(f)).toEqual({ code: 30303, data: { reason: 'above_method_max' } });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(await state(f)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05va#4] 快照无绑定行 ID 时，换成另一 HMAC 的支付宝账号重跑后建单',
  async (): Promise<void> => {
    const f = await fixture(h, { method: 'alipay' });
    const next = payee('alipay', 'other-alipay@example.test');
    const acquire = await prepareRebind(f, next, useSnapshotWithoutBindingId);

    success(await apply(f));
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(await rows(f)).toMatchObject([{ payout_method: 'alipay', payee_hmac: next.hmac }]);
    await expectSingleFreeze(f);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05va#5] 初判读口无 bindingIdOf 时，同 HMAC 换银行卡仍重跑并按银行卡上限拒绝',
  async (): Promise<void> => {
    const f = await fixture(h, { method: 'alipay' });
    const next = { ...payee('bank_card', '6222020000000222'), hmac: f.hmac };
    const acquire = await prepareRebind(f, next, useSubjectWithoutBindingId);
    const before = await state(f);

    expect(await apply(f)).toEqual({ code: 30303, data: { reason: 'above_method_max' } });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(await state(f)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05va#6] 初判读口无 bindingIdOf 时，换成另一 HMAC 的支付宝账号重跑后建单',
  async (): Promise<void> => {
    const f = await fixture(h, { method: 'alipay' });
    const next = payee('alipay', 'other-alipay@example.test');
    const acquire = await prepareRebind(f, next, useSubjectWithoutBindingId);

    success(await apply(f));
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(await rows(f)).toMatchObject([{ payout_method: 'alipay', payee_hmac: next.hmac }]);
    await expectSingleFreeze(f);
  },
  TIMEOUT,
);
