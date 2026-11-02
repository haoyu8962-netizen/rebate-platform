// B1-02zq §9 #3: GET /v1/withdrawals/rules does not skip ③b (08 BR-WDR-03 细则: the rules entry judges
// in the order of the rule, ② skipped; x-auth login, so stage ⑨ does not answer first). This is
// where ③a → ③b → ④ is observable in full. WithdrawRules has additionalProperties false and no
// field for providers or fail_limit (contract: the Reverify page takes the method from GET
// /v1/me/reverify), so "not lost" means: the answer stays contract-valid and the two other entries
// carry them for the same account.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { closeKit, openKit, statusOf, type Kit } from '../reverify/kit.ts';
import { RULES, WITHDRAW, answer, gates, oauth, refused, sameConclusion } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

/** What a blocked member's rules say, the estimate and maximum empty. */
const BLOCKED = {
  can_withdraw: false,
  block_reason: null,
  max_withdrawable_fen: 0,
  est_fee_fen: null,
  est_tax_fen: null,
  est_net_fen: null,
};

it('[AC-B1-02zq#7] 有标记且当前设备未加验 → code 0、block_code 10010、block_reason null，估算为空', async () => {
  const f = await gates(kit);
  const m = await f.member();
  await f.flag(m.uid, { realname: true, providers: [] });
  const data = answer(kit, RULES, 'get', await f.on(m).rules(), 0).data;
  expect(data).toMatchObject({ ...BLOCKED, block_code: 10010, withdrawable_fen: 10000 });
});

it('[AC-B1-02zq#8] 带 amount_fen 也不跳过这一步：block_code 10010，不给估算', async () => {
  const f = await gates(kit);
  const m = await f.member();
  await f.flag(m.uid, { realname: true, providers: [] });
  const data = answer(kit, RULES, 'get', await f.on(m).rules('?amount_fen=1000'), 0).data;
  expect(data).toMatchObject({ ...BLOCKED, block_code: 10010 });
});

it('[AC-B1-02zq#9] 顺序 ③a → ③b：黑名单命中 → block_code 44001，解除后 → 10010', async () => {
  const f = await gates(kit);
  const m = await f.member();
  await f.flag(m.uid, { realname: true, providers: [] });
  await f.blockPayee(m.payeeHmac!);
  const c = f.on(m);
  expect(answer(kit, RULES, 'get', await c.rules(), 0).data).toMatchObject({
    ...BLOCKED,
    block_code: 44001,
  });
  await f.unblock();
  expect(answer(kit, RULES, 'get', await c.rules(), 0).data).toMatchObject({
    ...BLOCKED,
    block_code: 10010,
  });
});

it('[AC-B1-02zq#10] 顺序 ③b → ④：未实名且有标记 → 10010；清除标记后才是 30304', async () => {
  const f = await gates(kit);
  const m = await f.member({ realname: false });
  await f.flag(m.uid, { realname: false, providers: [] });
  const c = f.on(m);
  expect(answer(kit, RULES, 'get', await c.rules(), 0).data).toMatchObject({
    ...BLOCKED,
    block_code: 10010,
  });
  await f.unflag(m.uid);
  expect(answer(kit, RULES, 'get', await c.rules(), 0).data).toMatchObject({
    ...BLOCKED,
    block_code: 30304,
  });
});

it('[AC-B1-02zq#11] providers、fail_limit 不丢：rules 过契约，同账号的 GET /v1/me/reverify 与提交的 10010 都带着', async () => {
  const f = await gates(kit);
  const m = await f.member();
  await f.bind(m.uid, 'wechat');
  await f.flag(m.uid, { realname: false, providers: ['wechat'] });
  const c = f.on(m);
  expect(answer(kit, RULES, 'get', await c.rules(), 0).data).toMatchObject({
    ...BLOCKED,
    block_code: 10010,
  });
  const data = oauth(['wechat']);
  sameConclusion(statusOf(kit, await f.client(m.uid, m.device).status()), data);
  refused(kit, WITHDRAW, 'post', await c.withdraw(), data);
});

it('[AC-B1-02zq#12] 查询本身不改账号：标记、失败计数、已加验设备都不变', async () => {
  const f = await gates(kit);
  const m = await f.member();
  await f.flag(m.uid, { realname: true, providers: [] });
  await f.failures(m.uid, 2);
  const before = await f.state(m.uid);
  expect(answer(kit, RULES, 'get', await f.on(m).rules(), 0).data).toMatchObject({
    block_code: 10010,
  });
  expect(await f.state(m.uid)).toEqual(before);
  expect(await f.devices(m.uid)).toEqual([]);
});
