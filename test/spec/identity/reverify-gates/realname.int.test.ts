// B1-02zq §9 #5: POST /v1/me/realname, first real name only (contract submitRealname; BR-WDR-01 细则
// 「位置与返回码」). The body and the consent are valid and the number is free: where the gate stands
// among 10004, 20001, 30407, 30410 and 30405 is not in the rule, so no case depends on it.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { closeKit, openKit, type Kit } from '../reverify/kit.ts';
import { MANUAL, REALNAME, answer, gates, oauth, refused } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

const UNVERIFIED = { realname: false, payout: false, balance: null };

it('[AC-B1-02zq#21] 首次实名：有标记且当前设备未加验 → 10010，不调供应商、不写实名', async () => {
  const f = await gates(kit);
  const m = await f.member(UNVERIFIED);
  await f.flag(m.uid, { realname: false, providers: ['wechat'] });
  refused(kit, REALNAME, 'post', await f.on(m).realname(), oauth(['wechat']));
  expect(kit.vendor).not.toHaveBeenCalled();
  expect(await f.realnameRows(m.uid)).toEqual([]);
});

it('[AC-B1-02zq#22] 上次核验失败的账号也算首次：10010，失败记录原样不动', async () => {
  const f = await gates(kit);
  const m = await f.member(UNVERIFIED);
  await f.failedRealname(m.uid);
  await f.flag(m.uid, { realname: false, providers: [] });
  const before = await f.realnameRow(m.uid);
  refused(kit, REALNAME, 'post', await f.on(m).realname(), MANUAL);
  expect(kit.vendor).not.toHaveBeenCalled();
  expect(await f.realnameRow(m.uid)).toBe(before);
});

it('[AC-B1-02zq#23] 10010 不写幂等结果：加验通过后同一个键重新判定，实名成功', async () => {
  const f = await gates(kit);
  const m = await f.member(UNVERIFIED);
  const unionId = await f.bind(m.uid, 'wechat');
  await f.flag(m.uid, { realname: false, providers: ['wechat'] });
  const c = f.on(m);
  const key = randomUUID();
  refused(kit, REALNAME, 'post', await c.realname({ key }), oauth(['wechat']));

  await f.passByOauth(m, unionId);
  kit.vendor.mockReset().mockResolvedValue({ outcome: 'match', provider: 'test-two-elements' });
  const verified = answer(kit, REALNAME, 'post', await c.realname({ key }), 0);
  expect(verified.data).toMatchObject({ realname_status: 'verified' });
  expect(kit.vendor).toHaveBeenCalledTimes(1);
});

it('[AC-B1-02zq#24] 已实名后的既有流程不受影响：有标记也回存好的掩码姓名，不调供应商；未实名的同类账号才 10010', async () => {
  const f = await gates(kit);
  const verified = await f.member({ payout: false, balance: null });
  await f.flag(verified.uid, { realname: true, providers: [] });
  const before = await f.realnameRow(verified.uid);
  const pending = await f.member(UNVERIFIED);
  await f.flag(pending.uid, { realname: false, providers: [] });
  refused(kit, REALNAME, 'post', await f.on(pending).realname(), MANUAL);

  const stored = answer(kit, REALNAME, 'post', await f.on(verified).realname(), 0);
  expect(stored.data).toEqual({ realname_status: 'verified', masked_name: '***明' });
  expect(kit.vendor).not.toHaveBeenCalled();
  expect(await f.realnameRow(verified.uid)).toBe(before);
});
