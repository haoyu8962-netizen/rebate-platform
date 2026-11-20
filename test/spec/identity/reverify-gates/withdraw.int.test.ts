// B1-02zq §9 #1, §10: POST /v1/withdrawals at BR-WDR-03 ③b. A member with everything in order, so
// the only thing that can stop the application is the step under test. This entry judges the real
// name in the platform stage, so 30304 answers before ③a and ③b (08 BR-WDR-03 细则「提交接口的检查顺序」,
// D10-233 ①; #44). The order ③a → ③b → ④ is pinned on the rules entry, which runs the chain as written
// (rules.int.test.ts).
import { afterAll, beforeAll, expect, it } from 'vitest';
import { closeKit, openKit, type Kit } from '../reverify/kit.ts';
import { ID_NUMBER, MANUAL, WITHDRAW, answer, gates, refused } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

it('[AC-B1-02zq#1] 有标记且当前设备未加验 → 403 / 10010，不建单、不冻结、余额不动', async () => {
  const f = await gates(kit);
  const m = await f.member();
  await f.flag(m.uid, { realname: true, providers: [] });
  const before = await f.funds(m.uid);
  refused(kit, WITHDRAW, 'post', await f.on(m).withdraw(), ID_NUMBER);
  expect(await f.funds(m.uid)).toEqual(before);
});

it('[AC-B1-02zq#2] ③a 先于 ③b：黑名单命中 → 44001，解除后同账号同设备才是 10010', async () => {
  const f = await gates(kit);
  const m = await f.member();
  await f.flag(m.uid, { realname: true, providers: [] });
  await f.blockPayee(m.payeeHmac!);
  const c = f.on(m);
  const blocked = answer(kit, WITHDRAW, 'post', await c.withdraw(), 44001);
  expect(blocked.data).toEqual({ risk_msg_code: 'blocklist.other' });
  await f.unblock();
  refused(kit, WITHDRAW, 'post', await c.withdraw(), ID_NUMBER);
});

it('[AC-B1-02zq#3] 对照：无标记未实名 → 30304；已实名有标记 → 10010，两个码各有各的条件', async () => {
  const f = await gates(kit);
  const unverified = await f.member({ realname: false });
  answer(kit, WITHDRAW, 'post', await f.on(unverified).withdraw(), 30304);
  const flagged = await f.member();
  await f.flag(flagged.uid, { realname: true, providers: [] });
  refused(kit, WITHDRAW, 'post', await f.on(flagged).withdraw(), ID_NUMBER);
});

// B1-02zzzc (D10-1665, D10-1702): BR-WDR-03 ② is cancelled; a withdrawal without a step-up token
// reaches ③b like any other.
it('[AC-B1-02zq#4] ② 已取消：不带 step-up 也直接是 ③b 的 10010', async () => {
  const f = await gates(kit);
  const m = await f.member();
  await f.flag(m.uid, { realname: true, providers: [] });
  const c = f.on(m);
  refused(kit, WITHDRAW, 'post', await c.withdraw({ step: null }), ID_NUMBER);
  refused(kit, WITHDRAW, 'post', await c.withdraw(), ID_NUMBER);
});

it('[AC-B1-02zq#5] 10010 不写幂等结果：加验通过后同设备、新幂等键建单成功（提现不带 step-up）', async () => {
  const f = await gates(kit);
  const m = await f.member();
  await f.flag(m.uid, { realname: true, providers: [] });
  const c = f.on(m);
  refused(kit, WITHDRAW, 'post', await c.withdraw({ step: null }), ID_NUMBER);
  expect(await f.idempotencyRows(WITHDRAW)).toEqual([]);

  await f.passById(m);
  const created = answer(kit, WITHDRAW, 'post', await c.withdraw({ step: null }), 0);
  expect(created.data).toMatchObject({ status: 'PENDING_REVIEW', amount_fen: 1000 });
  expect(await f.withdrawals(m.uid)).toHaveLength(1);
});

it('[AC-B1-02zq#6] 不带 step-up 连续被 10010 拦下多次，每次都不建单', async () => {
  const f = await gates(kit);
  const m = await f.member();
  await f.flag(m.uid, { realname: true, providers: [] });
  const c = f.on(m);
  refused(kit, WITHDRAW, 'post', await c.withdraw({ step: null }), ID_NUMBER);
  refused(kit, WITHDRAW, 'post', await c.withdraw({ step: null }), ID_NUMBER);
  expect(await f.withdrawals(m.uid)).toEqual([]);
});

it('[AC-B1-02zq#44] 带标记且未实名 → 30304，不是 10010；同账号实名补齐后才是 10010', async () => {
  const f = await gates(kit);
  const m = await f.member({ realname: false });
  await f.flag(m.uid, { realname: false, providers: [] });
  const c = f.on(m);
  answer(kit, WITHDRAW, 'post', await c.withdraw(), 30304);
  expect(await f.withdrawals(m.uid)).toEqual([]);

  // Only the real name changed. The method is still that of the identities frozen at flagging.
  await f.realname(m.uid, m.idNo);
  const pending = answer(kit, WITHDRAW, 'post', await c.withdraw(), 10010);
  expect(pending.msg).toBe('需要先核实是你本人');
  expect(pending.data).toEqual(MANUAL);
  expect(await f.withdrawals(m.uid)).toEqual([]);
});
