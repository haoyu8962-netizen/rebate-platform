// B1-02zq §9 #4: PUT /v1/me/payout-account, the gate after the step-up check (contract
// savePayoutAccount; BR-WDR-01 细则「位置与返回码」). Both methods go through it. Its place among the
// business refusals (⓪ blocklist, 30307 …) is not in the rule, so bodies here pass all of them.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bankBody, card } from '../payout-bank-card/kit.ts';
import { closeKit, openKit, type Kit } from '../reverify/kit.ts';
import { ID_NUMBER, PAYOUT, PERSON, answer, gates, refused } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

it('[AC-B1-02zq#17] step-up 之后：无令牌 → 10003，有令牌 → 10010，都不写入', async () => {
  const f = await gates(kit);
  const m = await f.member({ payout: false, balance: null });
  await f.flag(m.uid, { realname: true, providers: [] });
  const before = await f.payoutState(m.uid);
  const c = f.on(m);
  const required = answer(kit, PAYOUT, 'put', await c.payout({ step: null }), 10003);
  expect(required).not.toHaveProperty('data');
  refused(kit, PAYOUT, 'put', await c.payout(), ID_NUMBER);
  expect(await f.payoutState(m.uid)).toEqual(before);
});

it('[AC-B1-02zq#18] 已有账号的变更同样拦下：当前账号不动，不记变更', async () => {
  const f = await gates(kit);
  const m = await f.member({ balance: null });
  await f.flag(m.uid, { realname: true, providers: [] });
  const before = await f.payoutState(m.uid);
  refused(kit, PAYOUT, 'put', await f.on(m).payout(), ID_NUMBER);
  expect(await f.payoutState(m.uid)).toEqual(before);
});

it('[AC-B1-02zq#19] 银行卡同样拦下：不占核验次数、不写入', async () => {
  const f = await gates(kit);
  const m = await f.member({ payout: false, balance: null });
  await f.flag(m.uid, { realname: true, providers: [] });
  const before = await f.payoutState(m.uid);
  const body = bankBody(card(7), { payee_name: PERSON });
  refused(kit, PAYOUT, 'put', await f.on(m).payout({ body }), ID_NUMBER);
  expect(await f.payoutState(m.uid)).toEqual(before);
});

it('[AC-B1-02zq#20] 10010 不写幂等结果、不消耗令牌：加验通过后同令牌新键保存成功', async () => {
  const f = await gates(kit);
  const m = await f.member({ payout: false, balance: null });
  await f.flag(m.uid, { realname: true, providers: [] });
  const c = f.on(m);
  const step = await c.stepUp('payout_account_change');
  refused(kit, PAYOUT, 'put', await c.payout({ step }), ID_NUMBER);
  expect(await f.idempotencyRows(PAYOUT)).toEqual([]);

  await f.passById(m);
  answer(kit, PAYOUT, 'put', await c.payout({ step }), 0);
  expect((await f.payoutState(m.uid)).accounts).toHaveLength(1);
});
