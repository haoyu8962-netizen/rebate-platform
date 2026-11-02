// B1-02zq §9 #9, §10: withdraw.dormant_reverify_days = 0 with no flag changes nothing. The switch
// only decides whether new flags are set: a flag already on the account still answers 10010, until
// a pass or a manual clearing (Jev 0.99; #45). The app with the switch at 180 holds the control of
// #42 and #43: the gate is wired, and it is the missing flag that lets the others through.
//
// #45 seeds the switch at 0 before the app's first request, as every fixture does (the content
// reader caches), and the flag as already set: the state after the switch was turned off.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { closeKit, openKit, type Kit } from '../reverify/kit.ts';
import { ID_NUMBER, MANUAL, RULES, SURFACES, WITHDRAW, answer, gates, refused } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

it.each(SURFACES)('[AC-B1-02zq#42] $name：开关为 0 且无标记 → 行为不变', async (s) => {
  const live = await gates(kit);
  const flagged = await live.member(s.member);
  await live.flag(flagged.uid, { realname: false, providers: [] });
  refused(kit, s.path, s.verb, await s.submit(live.on(flagged)), MANUAL);

  const off = await gates(kit, { days: 0 });
  const m = await off.member(s.member);
  s.ready(kit);
  s.accepted(kit, await s.submit(off.on(m)));
});

it('[AC-B1-02zq#43] rules：开关为 0 且无标记 → 可提现，不出现 block_code', async () => {
  const live = await gates(kit);
  const flagged = await live.member();
  await live.flag(flagged.uid, { realname: false, providers: [] });
  expect(answer(kit, RULES, 'get', await live.on(flagged).rules(), 0).data).toMatchObject({
    block_code: 10010,
  });

  const off = await gates(kit, { days: 0 });
  const m = await off.member();
  expect(answer(kit, RULES, 'get', await off.on(m).rules(), 0).data).toMatchObject({
    can_withdraw: true,
    block_code: null,
  });
});

it('[AC-B1-02zq#45] 开关改为 0 后，已有标记、当前设备未加验的账号提现仍 10010，不建单', async () => {
  const off = await gates(kit, { days: 0 });
  const m = await off.member();
  await off.flag(m.uid, { realname: true, providers: [] });
  const before = await off.funds(m.uid);
  refused(kit, WITHDRAW, 'post', await off.on(m).withdraw(), ID_NUMBER);
  expect(await off.funds(m.uid)).toEqual(before);
});
