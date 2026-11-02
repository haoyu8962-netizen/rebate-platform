// B1-02zq §9 #6: POST /v1/me/deletion, step ② of application/deletion-request.ts: after the step-up
// check and under the users lock, before the open-request answer and 30412 / 30416 (contract
// requestDeletion; BR-ID-27; BR-WDR-01 细则「位置与返回码」). A restricted session offers no
// self-service: 10010 always says manual, and neither whitelist gains an operation.
//
// An open request normally stops at stage ⑥ (10007) long before step ②, so the order against it is
// reached the way it really can be: the request is parked on the user's row, past stage ⑥, and the
// cooling request appears before the row is released.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BY_ID, ID, STATUS, closeKit, envelope, openKit, type Kit } from '../reverify/kit.ts';
import {
  DELETION,
  ID_NUMBER,
  MANUAL,
  answer,
  gates,
  refused,
  type Gates,
  type Member,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

const ACCOUNT = { payout: false, balance: null };

it('[AC-B1-02zq#25] 二次验证之后：无令牌 → 10003，有令牌 → 10010，不建单', async () => {
  const f = await gates(kit);
  const m = await f.member(ACCOUNT);
  await f.flag(m.uid, { realname: true, providers: [] });
  const c = f.on(m);
  const required = answer(kit, DELETION, 'post', await c.deletion({ step: null }), 10003);
  expect(required).not.toHaveProperty('data');
  refused(kit, DELETION, 'post', await c.deletion(), ID_NUMBER);
  expect(await f.deletions(m.uid)).toEqual([]);
});

it('[AC-B1-02zq#26] 10010 不写幂等结果、不消耗令牌：加验通过后同令牌新键进入冷静期', async () => {
  const f = await gates(kit);
  const m = await f.member(ACCOUNT);
  await f.flag(m.uid, { realname: true, providers: [] });
  const c = f.on(m);
  const step = await c.stepUp('account_deletion');
  refused(kit, DELETION, 'post', await c.deletion({ step }), ID_NUMBER);
  expect(await f.idempotencyRows(DELETION)).toEqual([]);

  await f.passById(m);
  const applied = answer(kit, DELETION, 'post', await c.deletion({ step }), 0);
  expect(applied.data).toMatchObject({ status: 'cooling' });
  expect(await f.deletions(m.uid)).toHaveLength(1);
});

it('[AC-B1-02zq#27] 先于 30412：有进行中的提现也回 10010', async () => {
  const f = await gates(kit);
  const m = await f.member(ACCOUNT);
  await f.inFlight(m.uid);
  await f.flag(m.uid, { realname: true, providers: [] });
  refused(kit, DELETION, 'post', await f.on(m).deletion(), ID_NUMBER);
  await f.unflag(m.uid);
  answer(kit, DELETION, 'post', await f.on(m).deletion(), 30412);
});

it('[AC-B1-02zq#28] 先于 30416：负余额也回 10010', async () => {
  const f = await gates(kit);
  const m = await f.member(ACCOUNT);
  await f.negative(m.uid, -500n);
  await f.flag(m.uid, { realname: true, providers: [] });
  refused(kit, DELETION, 'post', await f.on(m).deletion(), ID_NUMBER);
  await f.unflag(m.uid);
  const owed = answer(kit, DELETION, 'post', await f.on(m).deletion(), 30416);
  expect(owed.data).toEqual({ amount_fen: 500 });
});

it('[AC-B1-02zq#29] 先于 open 申请的判断：等 users 行锁时出现冷静期申请，仍回 10010，不把它当结果返回', async () => {
  const f = await gates(kit);
  const m = await f.member(ACCOUNT);
  await f.flag(m.uid, { realname: true, providers: [] });
  const c = f.on(m);
  const step = await c.stepUp('account_deletion');
  const hold = await f.holdUser(m.uid);
  const pending = c.deletion({ step });
  try {
    expect(await f.lockWaiters(1, [pending])).toBeGreaterThanOrEqual(1);
    await f.cooling(m.uid);
  } finally {
    await hold.release();
  }
  refused(kit, DELETION, 'post', await pending, ID_NUMBER);
});

type Restricted = 'deletion_only' | 'banned';

/** A client of the restricted session, with what the self-service status answers there. */
async function restricted(f: Gates, m: Member, kind: Restricted) {
  if (kind === 'banned') await f.ban(m.uid);
  const scope = kind === 'deletion_only' ? 'deletion_only' : 'full';
  return {
    scope,
    closed: kind === 'deletion_only' ? 10405 : 10006,
    client: f.on(m, m.device, scope),
  } as const;
}

it.each(['deletion_only', 'banned'] as const)(
  '[AC-B1-02zq#30] 受限会话（%s）：可信身份含实名和第三方也一律 manual，不带 providers、fail_limit',
  async (kind) => {
    const f = await gates(kit);
    const m = await f.member(ACCOUNT);
    await f.bind(m.uid, 'wechat');
    await f.flag(m.uid, { realname: true, providers: ['wechat'] });
    const { client } = await restricted(f, m, kind);
    refused(kit, DELETION, 'post', await client.deletion(), MANUAL);
    expect(await f.deletions(m.uid)).toEqual([]);
  },
);

it.each(['deletion_only', 'banned'] as const)(
  '[AC-B1-02zq#31] 受限会话（%s）：白名单不增加接口，自助加验的查询与提交仍被拒',
  async (kind) => {
    const f = await gates(kit);
    const m = await f.member(ACCOUNT);
    await f.flag(m.uid, { realname: true, providers: [] });
    const { client, closed, scope } = await restricted(f, m, kind);
    refused(kit, DELETION, 'post', await client.deletion(), MANUAL);
    const reverify = f.client(m.uid, m.device, scope);
    envelope(kit, STATUS, await reverify.status(), closed, 'get');
    envelope(kit, BY_ID, await reverify.byId(ID), closed);
    expect(await f.devices(m.uid)).toEqual([]);
  },
);

it.each(['deletion_only', 'banned'] as const)(
  '[AC-B1-02zq#32] 受限会话（%s）不改放行条件：已加验设备照常进入冷静期，别的设备 manual',
  async (kind) => {
    const f = await gates(kit);
    const m = await f.member(ACCOUNT);
    await f.flag(m.uid, { realname: true, providers: [] });
    await f.reverified(m.uid, m.device);
    const { client, scope } = await restricted(f, m, kind);
    const other = await f.device();
    refused(kit, DELETION, 'post', await f.on(m, other, scope).deletion(), MANUAL);
    const applied = answer(kit, DELETION, 'post', await client.deletion(), 0);
    expect(applied.data).toMatchObject({ status: 'cooling' });
  },
);

it('[AC-B1-02zq#33] 冻结不是受限会话：账号冻结时仍按可信身份给 id_number', async () => {
  const f = await gates(kit);
  const m = await f.member(ACCOUNT);
  await f.flag(m.uid, { realname: true, providers: [] });
  await f.freeze(m.uid);
  refused(kit, DELETION, 'post', await f.on(m).deletion(), ID_NUMBER);
});
