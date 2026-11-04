import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { appendHold } from '../../admin/system-audit/kit.ts';
import {
  open,
  close,
  TIMEOUT,
  changeAvailable,
  seedStatus,
  snapshot,
  withdrawal,
  expectReturn,
  invariant,
  type Harness,
} from '../state/kit.ts';
import { afterInsert, audits, effects, event, expectAudit, member, worker } from './fixtures.ts';

let h: Harness;
let payout: ReturnType<typeof createDb>;
beforeAll(async () => {
  const database = await createTestDatabase();
  h = await open(async () => database);
  payout = createDb({ connectionString: database.urlFor('couli_payout'), max: 2 });
}, 180_000);
afterAll(async () => {
  try {
    if (payout) await destroyDb(payout);
  } finally {
    await close(h);
  }
}, TIMEOUT);

it.each(['PENDING_REVIEW', 'APPROVED'] as const)(
  '[AC-B2-09p#1] worker 将 %s 系统驳回，恰一条完整审计；101 分原额退冻结',
  async (status) => {
    const f = await member(h);
    const id = await f.startWithdrawal();
    await seedStatus(f, id, status);
    await changeAvailable(f, -37n);
    const job = event(f);
    // The audit timestamp must be the processing clock, not created_at or occurred_at.
    f.clock.advanceMs(12_345);
    const app = await worker(f);
    try {
      await app.handle(job);
      expect(await withdrawal(f, id)).toMatchObject({
        status: 'REJECTED',
        reject_reason_code: 'NEGATIVE_BALANCE',
        reviewer_id: null,
        reject_note: 'system:went_negative',
        reviewed_at: f.clock.now(),
      });
      await expectReturn(f, id, 101n);
      expect((await snapshot(f)).balances[0]).toMatchObject({ available_fen: 64n, frozen_fen: 0n });
      await invariant(f);
      expect(await audits(f)).toHaveLength(1);
      await expectAudit(f, id, status);
    } finally {
      await app.close();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-09p#13] 系统驳回和审计只归属事件会员及 app，其他负余额会员不被处理',
  async () => {
    const f = await member(h);
    const sibling = await member(h, 101n, f.actor.appId);
    const foreign = await member(h);
    const id = await f.startWithdrawal();
    const siblingId = await sibling.startWithdrawal();
    const foreignId = await foreign.startWithdrawal();
    for (const current of [f, sibling, foreign]) await changeAvailable(current, -37n);
    const siblingBefore = await withdrawal(sibling, siblingId);
    const foreignBefore = await snapshot(foreign);
    const app = await worker(f);
    try {
      await app.handle(event(f));
      expect(await withdrawal(sibling, siblingId)).toEqual(siblingBefore);
      expect((await snapshot(sibling)).balances[0]).toMatchObject({
        available_fen: -37n,
        frozen_fen: 101n,
      });
      expect(await snapshot(foreign)).toEqual(foreignBefore);
      expect((await withdrawal(foreign, foreignId)).status).toBe('PENDING_REVIEW');
      expect(await audits(foreign)).toEqual([]);
      expect(await audits(f)).toHaveLength(1);
      await expectAudit(f, id, 'PENDING_REVIEW');
    } finally {
      await app.close();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-09p#2] 同会员两张单各留一条，before 状态及 target 不串单，仍欠 103 分',
  async () => {
    const f = await member(h, 204n);
    const pending = await f.startWithdrawal(101n);
    const approved = await f.startWithdrawal(103n);
    await seedStatus(f, approved, 'APPROVED');
    await changeAvailable(f, -307n);
    const app = await worker(f);
    try {
      await app.handle(event(f));
      await expectReturn(f, pending, 101n);
      await expectReturn(f, approved, 103n);
      expect((await snapshot(f)).balances[0]).toMatchObject({
        available_fen: -103n,
        frozen_fen: 0n,
      });
      expect(await audits(f)).toHaveLength(2);
      await expectAudit(f, pending, 'PENDING_REVIEW');
      await expectAudit(f, approved, 'APPROVED');
    } finally {
      await app.close();
    }
  },
  TIMEOUT,
);

it.each(['pending', 'success', 'unknown', 'fail'] as const)(
  '[AC-B2-09p#3] transfer/%s 的单只阻断无审计；同会员无尝试的单正常留痕',
  async (result) => {
    const f = await member(h, 204n);
    const blocked = await f.startWithdrawal(101n);
    const eligible = await f.startWithdrawal(103n);
    await seedStatus(f, blocked, 'APPROVED');
    await payout
      .withSchema('app')
      .insertInto('payout_attempts')
      .values({
        id: randomUUID(),
        app_id: f.actor.appId,
        withdrawal_id: blocked,
        kind: 'transfer',
        result,
        request: '{}',
        at: f.clock.now(),
      })
      .execute();
    await changeAvailable(f, -307n);
    const app = await worker(f);
    try {
      await app.handle(event(f));
      expect(await withdrawal(f, blocked)).toMatchObject({
        status: 'APPROVED',
        blocked_reason: 'NEGATIVE_BALANCE',
      });
      expect(
        (await snapshot(f)).vouchers.filter((v) => v.uniq_key === `wd:${blocked}:RETURN`),
      ).toEqual([]);
      expect((await audits(f)).filter((row) => row.target === blocked)).toEqual([]);
      await expectReturn(f, eligible, 103n);
      expect((await snapshot(f)).balances[0]).toMatchObject({
        available_fen: -204n,
        frozen_fen: 101n,
      });
      expect(await audits(f)).toHaveLength(1);
      await expectAudit(f, eligible, 'PENDING_REVIEW');
    } finally {
      await app.close();
    }
  },
  TIMEOUT,
);

it.each([0n, 101n])(
  '[AC-B2-09p#4] 旧事件到达时余额已恢复到 %s：只清阻断不留审计；再次变负才驳回留痕',
  async (recovered) => {
    const f = await member(h);
    const id = await f.startWithdrawal();
    await seedStatus(f, id, 'APPROVED');
    await changeAvailable(f, -37n);
    const stale = event(f);
    await h.db
      .withSchema('app')
      .updateTable('withdrawals')
      .set({ blocked_reason: 'NEGATIVE_BALANCE' })
      .where('id', '=', id)
      .execute();
    await changeAvailable(f, recovered === 0n ? 37n : 138n);
    const before = await snapshot(f);
    const app = await worker(f);
    try {
      await app.handle(stale);
      expect(await withdrawal(f, id)).toMatchObject({ status: 'APPROVED', blocked_reason: null });
      expect((await snapshot(f)).balances).toEqual(before.balances);
      expect((await snapshot(f)).vouchers).toEqual(before.vouchers);
      expect(await audits(f)).toEqual([]);
      await changeAvailable(f, recovered === 0n ? -37n : -138n);
      await app.handle(event(f));
      expect(await audits(f)).toHaveLength(1);
      await expectAudit(f, id, 'APPROVED');
    } finally {
      await app.close();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-09p#5] 同一事件并发与顺序重投，只有一个消费标记、一个退回凭证、一条审计',
  async () => {
    const f = await member(h);
    const id = await f.startWithdrawal();
    await changeAvailable(f, -37n);
    const job = event(f);
    const app = await worker(f);
    try {
      await Promise.all([app.handle(job), app.handle({ ...job, attempt: 2 })]);
      const once = await effects(f, job);
      await app.handle({ ...job, attempt: 3 });
      expect(await effects(f, job)).toEqual(once);
      expect(once.claims).toHaveLength(1);
      await expectReturn(f, id, 101n);
      expect(await audits(f)).toHaveLength(1);
      await expectAudit(f, id, 'PENDING_REVIEW');
    } finally {
      await app.close();
    }
  },
  TIMEOUT,
);

it.each(['audit_logs', 'ledger_entries'] as const)(
  '[AC-B2-09p#6] %s 写入后故障：状态、分录、审计和消费标记均回滚；原事件重投恰一条',
  async (table) => {
    const f = await member(h);
    const id = await f.startWithdrawal();
    await changeAvailable(f, -37n);
    const job = event(f);
    const before = await effects(f, job);
    const failure = new Error(`synthetic ${table} failure after insert`);
    let fail = true;
    const probe = afterInsert(table, async () => {
      if (fail) throw failure;
    });
    const app = await worker(f, h.db.withPlugin(probe.plugin));
    try {
      await expect(app.handle(job)).rejects.toBe(failure);
      expect(probe.hits()).toBeGreaterThan(0);
      expect(await effects(f, job, h.observer)).toEqual(before);
      fail = false;
      await app.handle({ ...job, attempt: 2 });
      await app.handle({ ...job, attempt: 3 });
      expect((await effects(f, job)).claims).toHaveLength(1);
      await expectReturn(f, id, 101n);
      expect(await audits(f)).toHaveLength(1);
      await expectAudit(f, id, 'PENDING_REVIEW');
    } finally {
      await app.close();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-09p#7] 审计已 INSERT、事务未提交时，另一连接仍看不到任何驳回结果',
  async () => {
    const f = await member(h);
    const id = await f.startWithdrawal();
    await changeAvailable(f, -37n);
    const job = event(f);
    const before = await effects(f, job);
    const probe = afterInsert('audit_logs', async () => {
      expect(await effects(f, job, h.observer)).toEqual(before);
    });
    const app = await worker(f, h.db.withPlugin(probe.plugin));
    try {
      await app.handle(job);
      expect(probe.hits()).toBe(1);
      expect(await audits(f)).toHaveLength(1);
      await expectAudit(f, id, 'PENDING_REVIEW');
    } finally {
      await app.close();
    }
  },
  TIMEOUT,
);

it.each(['queue', 'run'] as const)(
  '[AC-B2-09p#8] PAYING 事件先消费不留痕，W9 回到 APPROVED 后 %s 复查留一条，重复复查不重复写',
  async (path) => {
    const f = await member(h);
    const id = await f.startWithdrawal();
    await seedStatus(f, id, 'PAYING');
    await changeAvailable(f, -101n);
    const app = await worker(f);
    try {
      await app.handle(event(f));
      expect((await withdrawal(f, id)).status).toBe('PAYING');
      expect(await audits(f)).toEqual([]);
      // W9 itself is outside this task: seed its result, then use the real worker's follow-up.
      await seedStatus(f, id, 'APPROVED');
      const followup = { ...event(f), payload: { app_id: f.actor.appId, user_id: f.actor.userId } };
      const recheck = () => (path === 'queue' ? app.handle(followup) : app.run(f.actor));
      await recheck();
      await recheck();
      await expectReturn(f, id, 101n);
      expect((await snapshot(f)).balances[0]).toMatchObject({ available_fen: 0n, frozen_fen: 0n });
      expect(await audits(f)).toHaveLength(1);
      await expectAudit(f, id, 'APPROVED');
    } finally {
      await app.close();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-09p#9] 系统驳回审计只含单号、状态、原因；不复制会员及收款个人信息',
  async () => {
    const f = await member(h);
    const phone = '13800138073';
    const identity = '110101199003071234';
    await h.db
      .withSchema('app')
      .updateTable('users')
      .set({
        phone_cipher: Buffer.from(phone),
        nickname: '审计隔离合成姓名',
      })
      .where('id', '=', f.actor.userId)
      .execute();
    // Account identifiers are immutable: retire the fixture account and seed a new current one.
    await h.db
      .withSchema('app')
      .updateTable('payout_accounts')
      .set({ is_current: false })
      .where('app_id', '=', f.actor.appId)
      .where('user_id', '=', f.actor.userId)
      .execute();
    // Deliberately recognisable synthetic bytes, set at INSERT; no real identity is used.
    await h.db
      .withSchema('app')
      .insertInto('payout_accounts')
      .values({
        id: randomUUID(),
        app_id: f.actor.appId,
        user_id: f.actor.userId,
        payout_method: 'alipay',
        payee_name: '合成姓名',
        is_current: true,
        alipay_hmac: f.hmac,
        alipay_logon_id_cipher: Buffer.from(`${f.account}|${identity}`),
      })
      .execute();
    const id = await f.startWithdrawal();
    await changeAvailable(f, -37n);
    const app = await worker(f);
    try {
      await app.handle(event(f));
      expect(await audits(f)).toHaveLength(1);
      await expectAudit(f, id, 'PENDING_REVIEW');
      const text = JSON.stringify(await audits(f), (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      for (const secret of [
        phone,
        identity,
        '审计隔离合成姓名',
        '合成姓名',
        f.account,
        f.hmac,
        `${f.account}|${identity}`,
      ]) {
        expect(text).not.toContain(secret);
      }
    } finally {
      await app.close();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-09p#10] [AC-B1-34p] 同库订单挂起和系统驳回并存：订单审计逐字段保持原样',
  async () => {
    const f = await member(h);
    const id = await f.startWithdrawal();
    await changeAvailable(f, -37n);
    const orderId = '724e909a-ec54-4cc8-9b41-59c09a355ac3';
    await appendHold(h.db, f.clock, f.actor.appId, orderId);
    const app = await worker(f);
    try {
      await app.handle(event(f));
      const rows = await audits(f);
      expect(rows).toHaveLength(2);
      const hold = rows.filter((row) => row.target === `orders:${orderId}`);
      expect(hold).toHaveLength(1);
      expect(hold[0]).toMatchObject({
        app_id: f.actor.appId,
        admin_id: null,
        system_actor: 'system:risk',
        action: 'order_auto_hold',
        target: `orders:${orderId}`,
        ip: null,
        at: f.clock.now(),
      });
      expect(hold[0]!.before).toStrictEqual({ hold: false, hold_reason: null });
      expect(hold[0]!.after).toStrictEqual({ hold: true, hold_reason: 'UNMAPPED_STATUS' });
      await expectAudit(f, id, 'PENDING_REVIEW');
    } finally {
      await app.close();
    }
  },
  TIMEOUT,
);
