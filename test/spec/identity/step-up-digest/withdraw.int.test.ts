// B1-02zzzb (BR-ID-08 细则「绑定业务摘要」action=withdraw; BR-WDR-07 建单锁内): the withdraw
// step_up_token's digest (current payout account row id + amount_fen) is compared inside the
// withdrawal lock against the row the snapshot will take and the request's amount_fen; a mismatch
// is 10003 without data, no withdrawal, no freeze, and the token stays usable (not consumed). An
// idempotent replay answers before the step-up check and compares nothing. Real POST
// /v1/withdrawals over the real AppModule, PG and Redis (kit.ts).
import { randomUUID } from 'node:crypto';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  TIMEOUT,
  WITHDRAW,
  answered,
  close,
  digestsOf,
  member,
  open,
  reset,
  stepUpRequired,
  type Kit,
} from './kit.ts';

let database: TestDatabase;
let redis: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  kit = await open(database, redis);
}, 120_000);
beforeEach(() => reset(kit));
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
  '[AC-B1-02zzzb#2] 摘要 = 当前绑定 + 10000：提交 20000 → 10003、不建单不冻结、令牌不核销；同一令牌提交 10000 成功并核销',
  async () => {
    const m = await member(kit, { withdraw: true });
    const current = m.current();
    const step = await m.token('withdraw', { payout_account_id: current.id, amount_fen: 10000 });
    const before = await m.withdrawState();
    stepUpRequired(kit, WITHDRAW, 'post', await m.withdraw(20000, step));
    expect(await m.withdrawState()).toEqual(before);
    const accepted = answered(kit, WITHDRAW, 'post', await m.withdraw(10000, step), 0);
    expect(accepted.data).toMatchObject({ amount_fen: 10000, status: 'PENDING_REVIEW' });
    const after = await m.withdrawState();
    expect(after.withdrawals).toHaveLength(1);
    expect(after.withdrawals[0]).toMatchObject({
      user_id: m.uid,
      amount_fen: 10000n,
      payee_hmac: current.hmac,
    });
    // Consumed by the one successful request.
    stepUpRequired(kit, WITHDRAW, 'post', await m.withdraw(10000, step));
    expect(await m.withdrawState()).toEqual(after);
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzb#2] 例：¥100 取令牌后改成 ¥200 提交 → 10003；重新取令牌（摘要 = 账号 + 20000）沿用原 Idempotency-Key 重放成功并核销',
  async () => {
    const m = await member(kit, { withdraw: true });
    const current = m.current();
    const key = randomUUID();
    const first = await m.token('withdraw', { payout_account_id: current.id, amount_fen: 10000 });
    const before = await m.withdrawState();
    stepUpRequired(kit, WITHDRAW, 'post', await m.withdraw(20000, first, key));
    expect(await m.withdrawState()).toEqual(before);
    const second = await m.token('withdraw', { payout_account_id: current.id, amount_fen: 20000 });
    expect(digestsOf(second)).toEqual([`w:${current.id}:20000`]);
    const accepted = answered(kit, WITHDRAW, 'post', await m.withdraw(20000, second, key), 0);
    expect(accepted.data).toMatchObject({ amount_fen: 20000 });
    const after = await m.withdrawState();
    expect(after.withdrawals).toEqual([expect.objectContaining({ amount_fen: 20000n })]);
    stepUpRequired(kit, WITHDRAW, 'post', await m.withdraw(20000, second));
    expect(await m.withdrawState()).toEqual(after);
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzb#3] 取令牌后在另一请求里换绑收款账号：旧令牌提交 → 10003、不建单；按新绑定重取令牌后建单，快照为新账号',
  async () => {
    const m = await member(kit, { withdraw: true });
    const old = m.current();
    const stale = await m.token('withdraw', { payout_account_id: old.id, amount_fen: 10000 });
    const next = await m.rebind('next.payee@example.com');
    const before = await m.withdrawState();
    stepUpRequired(kit, WITHDRAW, 'post', await m.withdraw(10000, stale));
    expect(await m.withdrawState()).toEqual(before);
    const fresh = await m.token('withdraw', { payout_account_id: next.id, amount_fen: 10000 });
    answered(kit, WITHDRAW, 'post', await m.withdraw(10000, fresh), 0);
    const after = await m.withdrawState();
    expect(after.withdrawals).toHaveLength(1);
    expect(after.withdrawals[0]).toMatchObject({ amount_fen: 10000n, payee_hmac: next.hmac });
    expect(after.withdrawals[0]!.payee_hmac).not.toBe(old.hmac);
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzb#3] 摘要里的账号行 ID 不是锁内读到的当前绑定行（旧行或别的行）→ 10003、不建单',
  async () => {
    const m = await member(kit, { withdraw: true });
    const old = m.current();
    await m.rebind('next.payee@example.com');
    const before = await m.withdrawState();
    for (const id of [old.id, randomUUID()]) {
      const step = await m.token('withdraw', { payout_account_id: id, amount_fen: 10000 });
      stepUpRequired(kit, WITHDRAW, 'post', await m.withdraw(10000, step));
    }
    expect(await m.withdrawState()).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzb#6] claims 不含摘要的 withdraw 令牌（签法同 POST /v1/auth/step-up）→ 10003、不建单',
  async () => {
    const m = await member(kit, { withdraw: true });
    const bare = await m.mint('withdraw');
    expect(digestsOf(bare)).toEqual([]);
    const before = await m.withdrawState();
    stepUpRequired(kit, WITHDRAW, 'post', await m.withdraw(10000, bare));
    expect(await m.withdrawState()).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzb#7] 幂等回放不比对摘要：成功后换绑，带原 Idempotency-Key 原样重发（不带令牌、带已核销或摘要不符的令牌）都返回原响应、不再建单',
  async () => {
    const m = await member(kit, { withdraw: true });
    const current = m.current();
    const key = randomUUID();
    const wrong = await m.token('withdraw', { payout_account_id: current.id, amount_fen: 20000 });
    stepUpRequired(kit, WITHDRAW, 'post', await m.withdraw(10000, wrong, key));
    const right = await m.token('withdraw', { payout_account_id: current.id, amount_fen: 10000 });
    const first = await m.withdraw(10000, right, key);
    answered(kit, WITHDRAW, 'post', first, 0);
    const after = await m.withdrawState();
    expect(after.withdrawals).toHaveLength(1);
    await m.rebind('next.payee@example.com');
    for (const step of [null, right, wrong]) {
      const replay = await m.withdraw(10000, step, key);
      expect(replay.statusCode).toBe(first.statusCode);
      expect(replay.body).toBe(first.body);
    }
    expect(await m.withdrawState()).toEqual(after);
  },
  TIMEOUT,
);
