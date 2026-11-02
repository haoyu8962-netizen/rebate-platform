// B1-02zq §9 #8: who passes. No flag, or this device already re-verified, behaves as today on all
// four operations; a pass frees that one device and keeps the flag. Each case holds a flagged
// control: without the gate wired, the passing half alone says nothing.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { NOT_REQUIRED, closeKit, openKit, statusOf, type Kit } from '../reverify/kit.ts';
import { MANUAL, RULES, SURFACES, answer, gates, oauth, refused } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

it.each(SURFACES)(
  '[AC-B1-02zq#38] $name：无标记放行，行为同今天；有标记的账号才 10010',
  async (s) => {
    const f = await gates(kit);
    const flagged = await f.member(s.member);
    await f.flag(flagged.uid, { realname: false, providers: [] });
    refused(kit, s.path, s.verb, await s.submit(f.on(flagged)), MANUAL);

    const free = await f.member(s.member);
    s.ready(kit);
    s.accepted(kit, await s.submit(f.on(free)));
  },
);

it.each(SURFACES)(
  '[AC-B1-02zq#39] $name：加验通过只放行那一台设备，另一台仍 10010，标记保留',
  async (s) => {
    const f = await gates(kit);
    const m = await f.member(s.member);
    const unionId = await f.bind(m.uid, 'wechat');
    await f.flag(m.uid, { realname: false, providers: ['wechat'] });
    const flagged = await f.state(m.uid);
    const other = await f.device();
    const data = oauth(['wechat']);
    refused(kit, s.path, s.verb, await s.submit(f.on(m)), data);

    await f.passByOauth(m, unionId);
    expect(await f.devices(m.uid)).toEqual([{ device_hash: m.device.hash, source: 'self' }]);
    refused(kit, s.path, s.verb, await s.submit(f.on(m, other)), data);

    s.ready(kit);
    s.accepted(kit, await s.submit(f.on(m)));
    const after = await f.state(m.uid);
    expect(after.reverify_flagged_at).toEqual(flagged.reverify_flagged_at);
    expect(after.reverify_trusted).toEqual(flagged.reverify_trusted);
  },
);

it('[AC-B1-02zq#40] 换了账号就不算：别的账号在这台设备上加验过，本账号仍 10010', async () => {
  const f = await gates(kit);
  const someone = await f.member();
  const m = await f.member();
  await f.flag(m.uid, { realname: true, providers: [] });
  await f.reverified(someone.uid, m.device);
  const c = f.on(m);
  expect(answer(kit, RULES, 'get', await c.rules(), 0).data).toMatchObject({ block_code: 10010 });
});

it('[AC-B1-02zq#41] rules：已加验设备可提现，另一台设备 block_code 10010，与 GET /v1/me/reverify 一致', async () => {
  const f = await gates(kit);
  const m = await f.member();
  await f.flag(m.uid, { realname: true, providers: [] });
  const other = await f.device();
  await f.passById(m);
  const here = answer(kit, RULES, 'get', await f.on(m).rules(), 0).data;
  expect(here).toMatchObject({ can_withdraw: true, block_code: null, block_reason: null });
  expect(statusOf(kit, await f.client(m.uid, m.device).status())).toEqual(NOT_REQUIRED);
  const there = answer(kit, RULES, 'get', await f.on(m, other).rules(), 0).data;
  expect(there).toMatchObject({ can_withdraw: false, block_code: 10010, block_reason: null });
});
