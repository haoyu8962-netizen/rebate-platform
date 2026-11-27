import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
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

function rebindBeforeFirstTwoLocks(f: Fixture) {
  const secondPayee = payee('alipay', 'second-payee@example.test');
  const thirdPayee = payee('alipay', 'third-payee@example.test');
  useCurrentSnapshot(f, secondPayee, thirdPayee);
  const acquire = beforeUsersLock(f, changePayee(f, secondPayee), changePayee(f, thirdPayee));
  return { acquire, thirdPayee };
}

it(
  '[AC-B2-05va#7] 第三遍读完账号后换出再换回，绑定行不同仍返回 50001 且不动资金',
  async (): Promise<void> => {
    const f = await fixture(h, { method: 'alipay' });
    const { lockUsersForUpdate: lockUsers } = f.options;
    const { acquire, thirdPayee } = rebindBeforeFirstTwoLocks(f);
    const changeAway = changePayee(f, payee('alipay', 'temporary-payee@example.test'));
    const changeBack = changePayee(f, thirdPayee);
    const { laborAgreementSigned } = f.options.rules;
    let reads = 0;
    const rebinds: { read: number; priorLocks: number }[] = [];
    f.options.rules.laborAgreementSigned = async (handle, who): Promise<boolean> => {
      const signed = await laborAgreementSigned(handle, who);
      reads += 1;
      // 前两遍在快照比较时回滚，各调用一次。第三次在账号读完后、风险标签计算和拿锁前。
      if (reads === 3) {
        await f.h.observer.transaction().execute(async (other): Promise<void> => {
          await sql`SET LOCAL lock_timeout = '3s'`.execute(other);
          await lockUsers(other, { appId: f.actor.appId, userIds: [f.actor.userId] });
          await changeAway(other);
          await changeBack(other);
        });
        rebinds.push({ read: reads, priorLocks: acquire.mock.calls.length });
      }
      return signed;
    };
    const before = await state(f);

    expect(await apply(f)).toEqual({ code: 50001, data: {} });
    expect(rebinds).toEqual([{ read: 3, priorLocks: 2 }]);
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(await state(f)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05va#8] 前两遍换绑且第三遍绑定行稳定，以第三遍的账号建单并冻结一次',
  async (): Promise<void> => {
    const f = await fixture(h, { method: 'alipay' });
    const { acquire, thirdPayee } = rebindBeforeFirstTwoLocks(f);

    success(await apply(f));
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(await rows(f)).toMatchObject([{ payout_method: 'alipay', payee_hmac: thirdPayee.hmac }]);
    await expectSingleFreeze(f);
  },
  TIMEOUT,
);
