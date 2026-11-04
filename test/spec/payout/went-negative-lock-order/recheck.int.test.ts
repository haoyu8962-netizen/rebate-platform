// B2-09r / BR-WDR-05 (a). Existing implementation should pass; no red-phase skeleton.
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  changeAvailable,
  expectReturn,
  invariant,
  snapshot,
  withdrawal,
  TIMEOUT,
} from '../state/kit.ts';
import {
  afterInsert,
  audits,
  effects,
  expectAudit,
  worker,
} from '../went-negative-audit/fixtures.ts';
import {
  adjustHeld,
  afterW9,
  balanceNowait,
  beforeReject,
  hold,
  suite,
  usersNowait,
  waiting,
} from './fixtures.ts';

const s = suite();

it(
  '[AC-B2-09r#1] W9 复查等余额锁期间 −37 变 +37：只清阻断，不驳回、不退冻结、不写审计',
  async () => {
    const { f, id, job } = await afterW9(s.h);
    await changeAvailable(f, -37n);
    const before = await withdrawal(f, id);
    const app = await worker(f, s.db);
    const locked = await hold(f, 'account_balances');
    const done = app.handle(job);
    void done.catch(() => {});
    try {
      await waiting(s.h.observer, s.applicationName, locked.pid, 'account_balances');
      await locked.release((trx) => adjustHeld(f, trx, 74n));
      await done;
      expect(await withdrawal(f, id)).toEqual({ ...before, blocked_reason: null });
      const state = await snapshot(f);
      expect(state.balances[0]).toMatchObject({ available_fen: 37n, frozen_fen: 101n });
      expect(state.vouchers.filter((v) => v.uniq_key === `wd:${id}:RETURN`)).toEqual([]);
      expect(state.returns).toEqual([]);
      expect(await audits(f)).toEqual([]);
      await invariant(f);
    } finally {
      await Promise.allSettled([locked.release(), done]);
      await app.close();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-09r#2] W9 复查等余额锁期间 +37 变 −37：驳回并退 101 分，恰一条审计',
  async () => {
    const { f, id, job } = await afterW9(s.h);
    await changeAvailable(f, 37n);
    const app = await worker(f, s.db);
    const locked = await hold(f, 'account_balances');
    const done = app.handle(job);
    void done.catch(() => {});
    try {
      await waiting(s.h.observer, s.applicationName, locked.pid, 'account_balances');
      await locked.release((trx) => adjustHeld(f, trx, -74n));
      await done;
      expect(await withdrawal(f, id)).toMatchObject({
        status: 'REJECTED',
        reject_reason_code: 'NEGATIVE_BALANCE',
      });
      await expectReturn(f, id, 101n);
      expect((await snapshot(f)).balances[0]).toMatchObject({ available_fen: 64n, frozen_fen: 0n });
      expect(await audits(f)).toHaveLength(1);
      await expectAudit(f, id, 'APPROVED');
      await invariant(f);
    } finally {
      await Promise.allSettled([locked.release(), done]);
      await app.close();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-09r#3] W9 复查先等 users，第三连接此时可 NOWAIT 锁余额：禁止余额锁先于 users',
  async () => {
    const { f, id, job } = await afterW9(s.h);
    await changeAvailable(f, -37n);
    const app = await worker(f, s.db);
    const locked = await hold(f, 'users');
    const done = app.handle(job);
    void done.catch(() => {});
    try {
      await waiting(s.h.observer, s.applicationName, locked.pid, 'users');
      expect((await balanceNowait(f)).rows).toHaveLength(1);
      expect((await withdrawal(f, id)).status).toBe('APPROVED');
      await locked.release();
      await done;
      await expectReturn(f, id, 101n);
      await expectAudit(f, id, 'APPROVED');
    } finally {
      await Promise.allSettled([locked.release(), done]);
      await app.close();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-09r#4] W9 初次余额锁一直属于驳回事务：审计已写未提交时状态不可见、余额 NOWAIT 仍失败',
  async () => {
    const { f, id, job } = await afterW9(s.h);
    await changeAvailable(f, -37n);
    const before = await effects(f, job);
    let firstWait: { pid: number; backend_xid: string | null } | undefined;
    async function sameTransaction() {
      expect(firstWait).toBeDefined();
      const result = await sql<{ backend_xid: string | null; state: string }>`
      SELECT backend_xid::text, state FROM pg_stat_activity
      WHERE pid = ${firstWait!.pid}`.execute(s.h.observer);
      expect(firstWait!.backend_xid).not.toBeNull();
      expect(result.rows).toEqual([
        { backend_xid: firstWait!.backend_xid, state: 'idle in transaction' },
      ]);
      await expect(balanceNowait(f)).rejects.toMatchObject({ code: '55P03' });
      await expect(usersNowait(f)).rejects.toMatchObject({ code: '55P03' });
      expect(await effects(f, job, s.h.observer)).toEqual(before);
    }
    // W3 locks balances again: checking only after its audit would miss an earlier autocommit lock.
    const early = beforeReject(sameTransaction);
    const late = afterInsert('audit_logs', sameTransaction);
    const app = await worker(f, s.db.withPlugin(early.plugin).withPlugin(late.plugin));
    const locked = await hold(f, 'account_balances');
    const done = app.handle(job);
    void done.catch(() => {});
    try {
      firstWait = await waiting(s.h.observer, s.applicationName, locked.pid, 'account_balances');
      await locked.release();
      await done;
      expect(early.hits()).toBe(1);
      expect(late.hits()).toBe(1);
      expect((await withdrawal(f, id)).status).toBe('REJECTED');
      await expectReturn(f, id, 101n);
      expect(await audits(f)).toHaveLength(1);
      await expectAudit(f, id, 'APPROVED');
      expect((await balanceNowait(f)).rows, '提交后余额锁释放').toHaveLength(1);
      expect((await usersNowait(f)).rows, '提交后 users 锁释放').toHaveLength(1);
      await invariant(f);
    } finally {
      await Promise.allSettled([locked.release(), done]);
      await app.close();
    }
  },
  TIMEOUT,
);
