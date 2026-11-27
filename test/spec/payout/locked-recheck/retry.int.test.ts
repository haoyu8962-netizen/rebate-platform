import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  answer,
  close,
  fixture,
  open,
  rows,
  state,
  success,
  TIMEOUT,
  type Fixture,
  type Harness,
} from '../apply/kit.ts';
import {
  beforeUsersLock,
  changePayee,
  controlRealname,
  expectSingleFreeze,
  payee,
  PAYEE_FLAG,
  riskJudgements,
  useCurrentSnapshot,
  watchRisk,
} from './kit.ts';

let h: Harness;
beforeAll(async (): Promise<void> => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async (): Promise<void> => {
  await close(h);
}, TIMEOUT);

function apply(f: Fixture, amountFen: bigint): ReturnType<Fixture['apply']> {
  return f.h.db
    .transaction()
    .execute((trx): ReturnType<Fixture['apply']> => f.apply(trx, amountFen));
}

function changeBeforeAllThreeLocks(f: Fixture) {
  const b = payee('alipay', 'test-payee-b@example.test', '合成乙');
  const c = payee('alipay', 'test-payee-c@example.test', '合成丙');
  const d = payee('alipay', 'test-payee-d@example.test', '合成丁');
  const setName = controlRealname(f);
  useCurrentSnapshot(f, b, c, d);
  const acquire = beforeUsersLock(
    f,
    changePayee(f, b, setName),
    changePayee(f, c, setName),
    changePayee(f, d, setName),
  );
  return { acquire, payees: [b, c, d] };
}

it(
  '[AC-B2-05v#4] 拿锁前由支付宝换绑银行卡，按新快照和新账号风险标签只建单冻结一次，账号稳定时只算一次标签',
  async (): Promise<void> => {
    const f = await fixture(h);
    const b = payee('bank_card', '6222020000000111', '合成乙');
    const setName = controlRealname(f);
    useCurrentSnapshot(f, b);
    const acquire = beforeUsersLock(f, changePayee(f, b, setName));
    const compute = watchRisk(f, b.hmac);

    const accepted = success(await apply(f, 1000n));
    expect(compute.mock.lastCall?.[1]).toMatchObject({
      payeeHmac: b.hmac,
      withdrawalId: accepted.withdrawal_id,
    });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(await rows(f)).toMatchObject([
      {
        id: accepted.withdrawal_id,
        payout_method: 'bank_card',
        payee_hmac: b.hmac,
        payee_name: b.name,
        risk_flags: [PAYEE_FLAG],
      },
    ]);
    expect(await riskJudgements(f)).toEqual([{ ref_id: accepted.withdrawal_id }]);
    await expectSingleFreeze(f);

    const stable = await fixture(h);
    const stableCompute = watchRisk(stable, stable.hmac);
    const stableAcquire = beforeUsersLock(stable);
    success(await apply(stable, 1000n));
    expect(stableCompute).toHaveBeenCalledTimes(1);
    expect(stableAcquire).toHaveBeenCalledTimes(1);
    await expectSingleFreeze(stable);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05v#5] 同一夹具 HMAC 换了收款方式也重跑，按银行卡上限返回 30303，银行卡上限足够时可建单',
  async (): Promise<void> => {
    const f = await fixture(h);
    await f.set('withdraw.method_max_amount_fen.alipay', 2000);
    await f.set('withdraw.method_max_amount_fen.bank_card', 500);
    const b = { ...payee('bank_card', '6222020000000222'), hmac: f.hmac };
    useCurrentSnapshot(f, b);
    beforeUsersLock(f, changePayee(f, b));

    const before = await state(f);
    const result = await apply(f, 1000n);
    expect(result).toEqual({ code: 30303, data: { reason: 'above_method_max' } });
    expect(await state(f)).toEqual(before);

    const bank = await fixture(h, { method: 'bank_card' });
    await bank.set('withdraw.method_max_amount_fen.alipay', 500);
    await bank.set('withdraw.method_max_amount_fen.bank_card', 2000);
    success(await apply(bank, 1000n));
    expect(await rows(bank)).toMatchObject([{ payout_method: 'bank_card', payee_hmac: bank.hmac }]);
    await expectSingleFreeze(bank);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05v#6] 同方式的账号连续变三次，建单用例返回 50001，回滚资金与风险判定，只打一条脱敏警告',
  async (): Promise<void> => {
    const f = await fixture(h);
    const { acquire, payees } = changeBeforeAllThreeLocks(f);
    watchRisk(f, f.hmac);
    const warn = vi.fn();
    f.options.rules.logger = { warn };
    const before = await state(f);

    const result = await apply(f, 1000n);
    expect(result).toEqual({ code: 50001, data: {} });
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(await state(f)).toEqual(before);
    expect(await riskJudgements(f)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: f.actor.userId, passes: 3 }),
      'withdraw_payee_changed_retry_exhausted',
    );
    const serialized = JSON.stringify(warn.mock.calls);
    for (const { account, hmac, name } of [
      { account: f.account, hmac: f.hmac, name: '合成姓名' },
      ...payees,
    ]) {
      expect(serialized).not.toContain(account);
      expect(serialized).not.toContain(hmac);
      expect(serialized).not.toContain(name);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-05v#7] 50001 不留下幂等结果，收款账号稳定后原键可建单冻结',
  async (): Promise<void> => {
    const f = await fixture(h);
    changeBeforeAllThreeLocks(f);
    const key = randomUUID();
    const before = await state(f);

    expect(answer(await f.request(key, 1000n))).toMatchObject({ code: 50001, data: {} });
    expect(await state(f)).toEqual(before);

    expect(answer(await f.request(key, 1000n)).code).toBe(0);
    const after = await state(f);
    expect(after.keys).toMatchObject([{ key, status: 'completed' }]);
    await expectSingleFreeze(f);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05v#8] 前两遍账号变化、第三遍稳定时照常建单，按第三遍账号入库风险标签',
  async (): Promise<void> => {
    const f = await fixture(h);
    const b = payee('bank_card', '6222020000000333');
    const c = payee('bank_card', '6222020000000444');
    useCurrentSnapshot(f, b, c);
    const acquire = beforeUsersLock(f, changePayee(f, b), changePayee(f, c));
    const compute = watchRisk(f, c.hmac);

    const accepted = success(await apply(f, 1000n));
    expect(compute.mock.lastCall?.[1]).toMatchObject({
      payeeHmac: c.hmac,
      withdrawalId: accepted.withdrawal_id,
    });
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(await rows(f)).toMatchObject([
      {
        payout_method: 'bank_card',
        payee_hmac: c.hmac,
        payee_name: c.name,
        risk_flags: [PAYEE_FLAG],
      },
    ]);
    expect(await riskJudgements(f)).toEqual([{ ref_id: accepted.withdrawal_id }]);
    await expectSingleFreeze(f);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05v#9] 换绑重跑后、拿锁前实名失效，锁内 ⑥ 返回 30304，不建单不冻结',
  async (): Promise<void> => {
    const f = await fixture(h);
    const b = payee('bank_card', '6222020000000555');
    const setName = controlRealname(f);
    useCurrentSnapshot(f, b);
    const acquire = beforeUsersLock(f, changePayee(f, b), async (): Promise<void> => {
      setName(null);
    });
    const before = await state(f);

    const result = await apply(f, 1000n);
    expect(result).toEqual({ code: 30304, data: {} });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(await state(f)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05v#10] 换绑重跑后、拿锁前收款人姓名与实名不符，锁内 ⑥ 返回 30307，不建单不冻结',
  async (): Promise<void> => {
    const f = await fixture(h);
    const b = payee('bank_card', '6222020000000666');
    useCurrentSnapshot(f, b);
    const acquire = beforeUsersLock(
      f,
      changePayee(f, b),
      changePayee(f, { ...b, name: '合成不符姓名' }),
    );
    const before = await state(f);

    const result = await apply(f, 1000n);
    expect(result).toEqual({ code: 30307, data: {} });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(await state(f)).toEqual(before);
  },
  TIMEOUT,
);
