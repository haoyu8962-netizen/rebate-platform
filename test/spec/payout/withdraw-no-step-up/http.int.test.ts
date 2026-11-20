// B1-02zzzc (负责人 2026-11-14；D10-1665 / D10-1666): 提现申请不要二次验证。BR-ID-08、BR-WDR-01:
// POST /v1/withdrawals needs a valid access_token, a passing request signature and an
// Idempotency-Key, but no step_up_token; BR-WDR-03 ② (step-up → 10003) is cancelled, so after ①
// the check order goes straight to ③ banned (10006) and BR-ID-01 ⑨ not realname (30304).
// BR-WDR-07: success and 3xxxx are stored with the key, 1xxxx / 2xxxx are not; 【放弃上一笔提现】
// still abandons a withdrawal key through POST /v1/idempotency-keys/abandon (action withdraw).
// Real AppModule, PG and Redis; nothing is replaced (kit.ts).
import { randomUUID } from 'node:crypto';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { close, config, open, type Kit } from '../../identity/payout-account/kit.ts';
import { fund } from '../apply/kit.ts';
import { assertContract } from '../rules/http-kit.ts';
import {
  accepted,
  AMOUNT,
  BALANCE,
  client,
  nothingMoved,
  PATH,
  refused,
  STEP_UP_PATH,
  TIMEOUT,
} from './kit.ts';

let database: TestDatabase;
let redis: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  kit = await open(database, redis);
}, 120_000);
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      await redis?.stop();
    } finally {
      await database?.drop();
    }
  }
}, TIMEOUT);

it(
  '[AC-B1-02zzzc#1] 不带 X-Step-Up-Token 的提现照常受理：契约响应、建单冻结一次、幂等键存结果；同键原样重放不再建单',
  async () => {
    const c = await client(kit);
    const initial = await c.state();
    expect(initial.withdrawals).toEqual([]);
    const key = randomUUID();
    const first = await c.post({ key });
    accepted(first);
    await assertContract(first, 'WithdrawalResponse');
    const after = await c.state();
    expect(after.withdrawals).toHaveLength(1);
    expect(after.withdrawals[0]).toMatchObject({
      user_id: c.f.uid,
      status: 'PENDING_REVIEW',
      amount_fen: BigInt(AMOUNT),
    });
    expect(after.balances).toEqual([
      expect.objectContaining({
        available_fen: BALANCE - BigInt(AMOUNT),
        frozen_fen: BigInt(AMOUNT),
      }),
    ]);
    expect(after.vouchers).toHaveLength(1);
    expect(after.keys).toEqual([
      expect.objectContaining({
        key,
        method: 'POST',
        path: PATH,
        user_id: c.f.uid,
        status: 'completed',
        response: { status: first.statusCode, body: first.body },
      }),
    ]);
    const replay = await c.post({ key });
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.body).toBe(first.body);
    expect(await c.state()).toEqual(after);
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzc#2] 提现不判 X-Step-Up-Token：带别的动作的有效 token 或乱码 token 都照常受理，各建一单',
  async () => {
    const c = await client(kit);
    accepted(await c.post({ step: await c.stepUp('payout_account_change') }));
    accepted(await c.post({ step: await c.stepUp('account_deletion') }));
    accepted(await c.post({ step: 'not-a-step-up-token' }));
    const after = await c.state();
    expect(after.withdrawals).toHaveLength(3);
    expect(after.balances).toEqual([
      expect.objectContaining({
        available_fen: BALANCE - 3n * BigInt(AMOUNT),
        frozen_fen: 3n * BigInt(AMOUNT),
      }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzc#3] 其余要求照旧（BR-WDR-01）：缺 Idempotency-Key 20001、签名错 10401、h5_token 10403，均无副作用；三项齐全且不带 step-up 才受理',
  async () => {
    const c = await client(kit);
    const initial = await c.state();
    const missingKey = await c.post({ key: null });
    refused(missingKey, 400, 20001);
    await assertContract(missingKey, 'ErrorEnvelope');
    const badSign = await c.post({ badSign: true });
    refused(badSign, 401, 10401);
    await assertContract(badSign, 'ErrorEnvelope');
    const h5 = await c.post({ access: await c.h5() });
    refused(h5, 403, 10403);
    await assertContract(h5, 'ErrorEnvelope');
    expect(await c.state()).toEqual(initial);
    accepted(await c.post());
    expect((await c.state()).withdrawals).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzc#4] 检查顺序去掉 ②：封禁用户不带 token 答 10006（不是 10003），1xxxx 不写幂等结果、无副作用',
  async () => {
    const c = await client(kit);
    await c.ban();
    const initial = await c.state();
    const key = randomUUID();
    const response = await c.post({ key });
    refused(response, 403, 10006);
    await assertContract(response, 'ErrorEnvelope');
    const after = await c.state();
    expect(after.keys.filter((row) => row.key === key && row.status === 'completed')).toEqual([]);
    nothingMoved(after, initial);
    // Same key again: still judged afresh (nothing stored), still 10006.
    refused(await c.post({ key }), 403, 10006);
    nothingMoved(await c.state(), initial);
    // Control: an account that is not banned, the same request without a token, passes.
    const normal = await client(kit);
    accepted(await normal.post());
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzc#5] 检查顺序去掉 ②：未实名用户不带 token 答 30304（不是 10003），不建单',
  async () => {
    const c = await client(kit, { verified: false });
    const initial = await c.state();
    const response = await c.post();
    refused(response, 422, 30304);
    await assertContract(response, 'ErrorEnvelope');
    nothingMoved(await c.state(), initial);
    // Control: a verified account, the same request without a token, passes.
    const verified = await client(kit);
    accepted(await verified.post());
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzc#6] 开关关闭不带 token 答 30306 并存幂等结果、同键原样重放；开关打开的应用里同样不带 token 受理',
  async () => {
    const c = await client(kit);
    const initial = await c.state();
    await config(kit, c.f, 'withdraw.enabled', false);
    const key = randomUUID();
    const off = await c.post({ key });
    refused(off, 422, 30306);
    await assertContract(off, 'ErrorEnvelope');
    const stored = await c.state();
    expect(stored.keys).toEqual([
      expect.objectContaining({
        key,
        status: 'completed',
        response: { status: off.statusCode, body: off.body },
      }),
    ]);
    nothingMoved(stored, initial);
    const replay = await c.post({ key });
    expect(replay.statusCode).toBe(off.statusCode);
    expect(replay.body).toBe(off.body);
    expect(await c.state()).toEqual(stored);
    // Control in a separate app id with the switch on: the same request without a token passes.
    const on = await client(kit);
    await config(kit, on.f, 'withdraw.enabled', true);
    accepted(await on.post());
    expect((await on.state()).withdrawals).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzc#7] 余额不足不带 token 答 30301 并存幂等结果（3xxxx 写入），补款后同键原样重放、新键受理',
  async () => {
    const c = await client(kit, { balance: 0n });
    const key = randomUUID();
    const first = await c.post({ key });
    refused(first, 422, 30301);
    await assertContract(first, 'ErrorEnvelope');
    expect((await c.state()).keys).toEqual([
      expect.objectContaining({
        key,
        status: 'completed',
        response: { status: first.statusCode, body: first.body },
      }),
    ]);
    await fund(kit.db, c.ledger, c.actor, 2n * BigInt(AMOUNT));
    const replay = await c.post({ key });
    expect(replay.body).toBe(first.body);
    accepted(await c.post());
    expect((await c.state()).withdrawals).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzc#8] 【放弃上一笔提现】照旧：action=withdraw 作废未到达的键，之后同键 20903 不建单；已完成的键返回原结果；新键不带 token 受理',
  async () => {
    const c = await client(kit);
    const initial = await c.state();
    const lost = randomUUID();
    const abandoned = await c.abandon(lost);
    expect(abandoned.statusCode, abandoned.body).toBe(200);
    expect(abandoned.json()).toMatchObject({
      code: 0,
      data: { outcome: 'abandoned', original: null },
    });
    const late = await c.post({ key: lost });
    refused(late, 409, 20903);
    await assertContract(late, 'ErrorEnvelope');
    nothingMoved(await c.state(), initial);

    const done = randomUUID();
    const created = await c.post({ key: done });
    accepted(created);
    const original = created.json<{ code: number; msg: string; data: unknown }>();
    const before = await c.state();
    const completed = await c.abandon(done);
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json()).toMatchObject({
      code: 0,
      data: {
        outcome: 'completed',
        original: { code: original.code, msg: original.msg, data: original.data },
      },
    });
    expect(await c.state()).toEqual(before);
    expect((await c.post({ key: done })).body).toBe(created.body);
    expect((await c.state()).withdrawals).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzc#9] POST /v1/auth/step-up 不再签发 withdraw：action=withdraw → 20001，不发 token；收款账号变更带提现形状的 summary → 20001',
  async () => {
    const c = await client(kit);
    for (const body of [
      { action: 'withdraw', code: '123456' },
      {
        action: 'withdraw',
        code: '123456',
        summary: { payout_account_id: randomUUID(), amount_fen: AMOUNT },
      },
      {
        action: 'payout_account_change',
        code: '123456',
        summary: { payout_account_id: randomUUID(), amount_fen: AMOUNT },
      },
    ]) {
      const response = await c.send(STEP_UP_PATH, body);
      refused(response, 400, 20001);
      await assertContract(response, 'ErrorEnvelope');
      expect(response.json()).not.toHaveProperty('data.step_up_token');
    }
    accepted(await c.post());
  },
  TIMEOUT,
);
