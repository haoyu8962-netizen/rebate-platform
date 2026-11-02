// B1-02zp §9 #7, #10, #13 (BR-WDR-01 细则「加验依据」「已加验设备」; BR-ID-25: only compares): POST
// /v1/me/reverify/id-number. The real controller, idempotency module and stored realname row; the
// two-element vendor is kit.vendor and must never be called.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { outbox } from '../sms-codes/http-kit.ts';
import {
  BY_ID,
  DORMANT,
  FAIL_LIMIT,
  HOUR,
  ID,
  MANUAL_REQUIRED,
  MIDNIGHT,
  NOT_REQUIRED,
  OTHER_ID,
  PENDING_MANUAL,
  TODAY,
  THIRD_ID,
  ago,
  closeKit,
  envelope,
  fixture,
  idNumberRequired,
  mismatch,
  oauthRequired,
  openKit,
  passed,
  pending,
  statusOf,
  trustedOf,
  type Fixture,
  type Kit,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

/** An account flagged with its real name as the trusted identity, and one device. */
async function flagged(f: Fixture) {
  const { uid } = await f.user();
  const device = await f.device();
  await f.realname(uid);
  await f.flag(uid, { realname: true, providers: [] });
  return { uid, device, c: f.client(uid, device) };
}

it('[AC-B1-02zp#50] 比对一致 → passed，只把本设备记为已加验（source self），标记与可信身份保留，其他设备仍要加验', async () => {
  const f = await fixture(kit);
  const { uid, device, c } = await flagged(f);
  const other = await f.device();
  const before = await f.state(uid);
  passed(kit, BY_ID, await c.byId(ID));
  expect(await f.devices(uid)).toEqual([{ device_hash: device.hash, source: 'self' }]);
  const after = await f.state(uid);
  expect(after.reverify_flagged_at).toEqual(before.reverify_flagged_at);
  expect(trustedOf(after)).toEqual({ realname: true, providers: [] });
  expect(statusOf(kit, await c.status())).toEqual(NOT_REQUIRED);
  expect(statusOf(kit, await f.client(uid, other).status())).toEqual(idNumberRequired(FAIL_LIMIT));
});

it('[AC-B1-02zp#51] 只比对：不调二要素接口、不发短信，实名记录不变', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  const texts = outbox(kit.app).length;
  const stored = await f.realnameRow(uid);
  // The row was written at this instant: a rewrite of verified_at must show.
  kit.clock.advanceMs(HOUR);
  passed(kit, BY_ID, await c.byId(ID));
  mismatch(kit, BY_ID, await f.client(uid, await f.device()).byId(OTHER_ID), 4);
  expect(kit.vendor).not.toHaveBeenCalled();
  expect(outbox(kit.app)).toHaveLength(texts);
  expect(await f.realnameRow(uid)).toBe(stored);
});

it('[AC-B1-02zp#52] 比对不一致 → 20005 带 fail_limit、fail_remaining，计一次失败，不记设备', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  mismatch(kit, BY_ID, await c.byId(OTHER_ID), FAIL_LIMIT - 1);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 1, reverify_fail_day: TODAY });
  expect(await f.devices(uid)).toEqual([]);
  expect(statusOf(kit, await c.status())).toEqual(idNumberRequired(FAIL_LIMIT - 1));
});

it('[AC-B1-02zp#53] 比对的是本账号已存的实名：别人的证件号不算一致', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  const someone = await f.user();
  await f.realname(someone.uid, THIRD_ID);
  mismatch(kit, BY_ID, await c.byId(THIRD_ID), FAIL_LIMIT - 1);
  expect(await f.devices(uid)).toEqual([]);
});

it('[AC-B1-02zp#54] 打标后才完成的实名不在可信身份里：提交正确证件号也 → 10010（当前方式），不计失败', async () => {
  const f = await fixture(kit);
  const device = await f.device();
  const viaOauth = await f.user();
  await f.flag(viaOauth.uid, { realname: false, providers: ['wechat'] });
  await f.realname(viaOauth.uid);
  pending(kit, BY_ID, await f.client(viaOauth.uid, device).byId(ID), {
    method: 'oauth',
    providers: ['wechat'],
    fail_limit: FAIL_LIMIT,
  });

  const viaManual = await f.user();
  await f.flag(viaManual.uid, { realname: false, providers: [] });
  await f.realname(viaManual.uid, THIRD_ID);
  pending(kit, BY_ID, await f.client(viaManual.uid, device).byId(THIRD_ID), PENDING_MANUAL);

  for (const { uid } of [viaOauth, viaManual]) {
    expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 0 });
    expect(await f.devices(uid)).toEqual([]);
  }
  expect(statusOf(kit, await f.client(viaManual.uid, device).status())).toEqual(MANUAL_REQUIRED);
});

it('[AC-B1-02zp#55] 无标记账号提交 → passed，不记设备、不计失败、不比对', async () => {
  const f = await fixture(kit);
  const { uid } = await f.user();
  const device = await f.device();
  await f.realname(uid);
  passed(kit, BY_ID, await f.client(uid, device).byId(OTHER_ID));
  expect(await f.devices(uid)).toEqual([]);
  expect(await f.state(uid)).toMatchObject({
    reverify_fail_count: 0,
    reverify_flagged_at: null,
  });
});

it('[AC-B1-02zp#56] 本设备已加验再提交 → passed，不新增设备行、不计失败', async () => {
  const f = await fixture(kit);
  const { uid, device, c } = await flagged(f);
  await f.reverified(uid, device);
  await f.failures(uid, 2);
  passed(kit, BY_ID, await c.byId(OTHER_ID));
  expect(await f.devices(uid)).toEqual([{ device_hash: device.hash, source: 'self' }]);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 2 });
});

it('[AC-B1-02zp#57] 证件号格式不对 → 20001 fields=[id_no]，没有比对，不计失败', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  await f.failures(uid, 2);
  const body = envelope(kit, BY_ID, await c.byId('not-an-id-number'), 20001);
  expect(body.data).toMatchObject({ fields: ['id_no'] });
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 2 });
  expect(await f.devices(uid)).toEqual([]);
});

it('[AC-B1-02zp#58] 通过写幂等结果：同键同体重放原样返回且不多记设备，同键换体 → 20901', async () => {
  const f = await fixture(kit);
  const { uid, device, c } = await flagged(f);
  const key = randomUUID();
  passed(kit, BY_ID, await c.byId(ID, { key }));
  passed(kit, BY_ID, await c.byId(ID, { key }));
  envelope(kit, BY_ID, await c.byId(OTHER_ID, { key }), 20901);
  expect(await f.devices(uid)).toEqual([{ device_hash: device.hash, source: 'self' }]);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 0 });
});

it('[AC-B1-02zp#59] 缺 Idempotency-Key → 20001，不比对', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  envelope(kit, BY_ID, await c.byId(ID, { noKey: true }), 20001);
  expect(await f.devices(uid)).toEqual([]);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 0 });
});

it('[AC-B1-02zp#60] 20005 不写幂等结果（D10-149）：同键每次实际比对都计一次，同键改对证件号可以通过', async () => {
  const f = await fixture(kit);
  const { uid, device, c } = await flagged(f);
  const key = randomUUID();
  mismatch(kit, BY_ID, await c.byId(OTHER_ID, { key }), 4);
  mismatch(kit, BY_ID, await c.byId(OTHER_ID, { key }), 3);
  mismatch(kit, BY_ID, await c.byId(THIRD_ID, { key }), 2);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 3 });
  expect(await f.idempotencyRows(BY_ID)).toEqual([]);
  passed(kit, BY_ID, await c.byId(ID, { key }));
  expect(await f.devices(uid)).toEqual([{ device_hash: device.hash, source: 'self' }]);
});

it('[AC-B1-02zp#61] 10010 不写幂等结果（BR-WDR-07）：锁定当天的键次日可用', async () => {
  const f = await fixture(kit);
  const { uid, device, c } = await flagged(f);
  await f.failures(uid, FAIL_LIMIT);
  const key = randomUUID();
  pending(kit, BY_ID, await c.byId(ID, { key }), PENDING_MANUAL);
  expect(await f.idempotencyRows(BY_ID)).toEqual([]);
  kit.clock.set(MIDNIGHT);
  passed(kit, BY_ID, await c.byId(ID, { key }));
  expect(await f.devices(uid)).toEqual([{ device_hash: device.hash, source: 'self' }]);
});

it('[AC-B1-02zp#62] 证件号明文不进日志、审计、响应与幂等记录；请求摘要用带密钥的 hmac', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  const wrong = await c.byId(OTHER_ID);
  mismatch(kit, BY_ID, wrong, FAIL_LIMIT - 1);
  const right = await c.byId(ID);
  passed(kit, BY_ID, right);
  const records = await f.idempotencyRows(BY_ID);
  expect(records).toHaveLength(1);
  expect(records[0]!.status).toBe('completed');
  expect(records[0]!.request_hash).toMatch(/^hmac1:/);
  const text = [
    kit.lines.join('\n'),
    await f.auditText(),
    JSON.stringify(wrong.json()),
    JSON.stringify(right.json()),
    JSON.stringify(records),
    JSON.stringify(await f.state(uid)),
  ].join('\n');
  for (const number of [ID, OTHER_ID]) expect(text).not.toContain(number);
});

it('[AC-B1-02zp#63] 端到端：登录打标 → 新设备加验通过 → 旧设备仍要加验，再次登录不清除已加验设备', async () => {
  const f = await fixture(kit);
  const [earlier, current] = [await f.device(), await f.device()];
  const { uid, number } = await f.user();
  await f.realname(uid);
  await f.bind(uid, 'wechat');
  await f.active(uid, ago(kit, DORMANT), earlier.hash);
  await f.smsLogin(number, current);
  const c = f.client(uid, current);
  expect(statusOf(kit, await c.status())).toEqual(idNumberRequired(FAIL_LIMIT));
  passed(kit, BY_ID, await c.byId(ID));
  expect(statusOf(kit, await c.status())).toEqual(NOT_REQUIRED);
  expect(statusOf(kit, await f.client(uid, earlier).status())).toEqual(
    idNumberRequired(FAIL_LIMIT),
  );

  kit.clock.advanceMs(HOUR);
  await f.smsLogin(number, earlier);
  expect(statusOf(kit, await c.status())).toEqual(NOT_REQUIRED);
  expect(await f.devices(uid)).toEqual([{ device_hash: current.hash, source: 'self' }]);
  const state = await f.state(uid);
  expect(state.reverify_flagged_at).not.toBeNull();
  expect(trustedOf(state)).toEqual({ realname: true, providers: ['wechat'] });
});

it('[AC-B1-02zp#64] 可信身份只有第三方的账号提交证件号 → 10010 oauth，带 providers 与 fail_limit', async () => {
  const f = await fixture(kit);
  const device = await f.device();
  const { uid } = await f.user();
  await f.flag(uid, { realname: false, providers: ['apple'] });
  const c = f.client(uid, device);
  pending(kit, BY_ID, await c.byId(ID), {
    method: 'oauth',
    providers: ['apple'],
    fail_limit: FAIL_LIMIT,
  });
  expect(statusOf(kit, await c.status())).toEqual(oauthRequired(['apple'], FAIL_LIMIT));
});

it('[AC-B1-02zp#107] 末位小写 x 是同一个证件号（先规范化再比对，同实名提交的 parseResidentIdNo）：→ passed，记本设备，不计失败', async () => {
  const f = await fixture(kit);
  const { uid, device, c } = await flagged(f);
  passed(kit, BY_ID, await c.byId(ID.toLowerCase()));
  expect(await f.devices(uid)).toEqual([{ device_hash: device.hash, source: 'self' }]);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 0 });
});
