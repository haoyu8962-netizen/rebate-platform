import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  ALIPAY_CONTEXT,
  LOGIN,
  NOW,
  account,
  block,
  change,
  close,
  config,
  fixture,
  open,
  pid,
  service,
  state,
  waitBlocked,
  type Kit,
} from './kit.ts';
import { bound } from '../step-up-digest/payout-summary.ts';

let database: TestDatabase;
let redis: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  kit = await open(database, redis);
});
beforeEach(() => {
  kit.clock.set(NOW);
  kit.lines.length = 0;
});
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
});

it.each(['limit', 'same-account', 'first-binding'] as const)(
  '[AC-B1-13e#30] 两个真实连接并发 %s：等待 users 行锁后重读绑定和计数',
  async (mode) => {
    const f = await fixture(kit);
    if (mode !== 'first-binding') {
      await account(kit, f, 'old@example.com');
      await change(kit, f);
    }
    const app = await service(kit);
    const a = await kit.db.startTransaction().execute();
    let finished = false;
    let pending: Promise<unknown> | undefined;
    try {
      await sql`SET LOCAL statement_timeout = '5s'`.execute(a);
      const first = await app.save(a, f.command);
      expect(first.code).toBe(0);
      const aPid = await pid(a);
      const started = Promise.withResolvers<number>();
      const next = mode === 'same-account' ? LOGIN : 'second@example.com';
      const b = kit.db.transaction().execute(async (trx) => {
        await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
        started.resolve(await pid(trx));
        return app.save(trx, bound(kit, { ...f.command, alipayLogonId: next }));
      });
      pending = b;
      void b.catch(() => undefined);
      const bPid = await started.promise;
      expect(bPid).not.toBe(aPid);
      // A owns users FOR UPDATE; B must wait, including for an apparently identical login.
      await waitBlocked(kit, bPid, aPid);
      await a.commit().execute();
      finished = true;
      const second = await b;
      if (mode === 'limit')
        expect(second).toEqual({ code: 30303, data: { reason: 'payout_account_change_limit' } });
      else
        expect(second).toMatchObject({
          code: 0,
          data: { change_remaining_this_month: mode === 'first-binding' ? 1 : 0 },
        });
      const rows = await state(kit, f);
      expect(rows.accounts).toHaveLength(2);
      expect(rows.accounts.filter((row) => row.is_current)).toHaveLength(1);
      expect(rows.accounts.find((row) => row.is_current)?.alipay_hmac).toBe(
        kit.crypto.blindIndex(mode === 'first-binding' ? next : LOGIN, ALIPAY_CONTEXT),
      );
      expect(rows.changes).toHaveLength(mode === 'first-binding' ? 1 : 2);
      if (mode === 'first-binding')
        expect(rows.changes[0]).toMatchObject({
          old_hmac: kit.crypto.blindIndex(LOGIN, ALIPAY_CONTEXT),
          new_hmac: kit.crypto.blindIndex(next, ALIPAY_CONTEXT),
        });
    } finally {
      if (!finished) await a.rollback().execute();
      await pending?.catch(() => undefined);
    }
  },
  20_000,
);

it.each(['invalid-logon', 'disabled-method'] as const)(
  '[AC-B1-13e#31] 锁前本地校验 %s：users 被独立连接锁住仍立即拒绝，且不写行',
  async (mode) => {
    const f = await fixture(kit);
    if (mode === 'disabled-method') await config(kit, f, 'withdraw.payout_methods', ['bank_card']);
    const app = await service(kit);
    const holder = await kit.db.startTransaction().execute();
    try {
      await holder
        .selectFrom('users')
        .select('id')
        .where('app_id', '=', f.appId)
        .where('id', '=', f.uid)
        .forUpdate()
        .execute();
      const result = await kit.db.transaction().execute(async (trx) => {
        await sql`SET LOCAL statement_timeout = '1s'`.execute(trx);
        return app.save(trx, bound(kit, { ...f.command, alipayLogonId: '@' }));
      });
      expect(result).toEqual({
        code: 20001,
        data: { fields: [mode === 'invalid-logon' ? 'alipay_logon_id' : 'payout_method'] },
      });
      expect(await state(kit, f)).toEqual({ accounts: [], changes: [] });
    } finally {
      await holder.rollback().execute();
    }
  },
  10_000,
);

it('[AC-B1-13e#32] 部分唯一索引的真实 23505 竞态映射 30308，旧行与计次回滚且调用方事务可继续', async () => {
  const f = await fixture(kit);
  const other = await fixture(kit, { appId: f.appId });
  await account(kit, f, 'old@example.com');
  const before = await state(kit, f);
  const app = await service(kit);
  const holder = await kit.db.startTransaction().execute();
  let finished = false;
  let pending: Promise<unknown> | undefined;
  try {
    // Uncommitted foreign ownership is invisible to the occupancy SELECT but reserves the index.
    await account(kit, other, LOGIN, { handle: holder });
    const holderPid = await pid(holder);
    const started = Promise.withResolvers<number>();
    const competing = kit.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
      started.resolve(await pid(trx));
      const result = await app.save(trx, f.command);
      expect(result).toEqual({ code: 30308 });
      // Catches both an aborted transaction and partial writes accidentally committed on refusal.
      expect(await state(kit, f, trx)).toEqual(before);
      return result;
    });
    pending = competing;
    void competing.catch(() => undefined);
    const competingPid = await started.promise;
    expect(competingPid).not.toBe(holderPid);
    await waitBlocked(kit, competingPid, holderPid);
    await holder.commit().execute();
    finished = true;
    expect(await competing).toEqual({ code: 30308 });
    expect(await state(kit, f)).toEqual(before);
    expect((await state(kit, other)).accounts).toHaveLength(1);
  } finally {
    if (!finished) await holder.rollback().execute();
    await pending?.catch(() => undefined);
  }
}, 20_000);

it('[AC-B1-13e#33] 保存持有的锁不含 advisory lock，也不访问余额表', async () => {
  const f = await fixture(kit);
  const app = await service(kit);
  await kit.db.transaction().execute(async (trx) => {
    expect((await app.save(trx, f.command)).code).toBe(0);
    const locks = (
      await sql<{ locktype: string; relation_name: string | null }>`
      SELECT l.locktype, c.relname AS relation_name FROM pg_locks l
      LEFT JOIN pg_class c ON c.oid = l.relation WHERE l.pid = pg_backend_pid()`.execute(trx)
    ).rows;
    expect(locks.filter((lock) => lock.locktype === 'advisory')).toEqual([]);
    expect(locks.filter((lock) => /balance/i.test(lock.relation_name ?? ''))).toEqual([]);
  });
});

it('[AC-B1-13e#34] 等待 users 行锁期间新登记的黑名单在锁内重查，禁止保存缓存的通过结果', async () => {
  const f = await fixture(kit);
  await account(kit, f, 'old@example.com');
  const before = await state(kit, f);
  const app = await service(kit);
  const holder = await kit.db.startTransaction().execute();
  let finished = false;
  let pending: Promise<unknown> | undefined;
  try {
    await holder
      .selectFrom('users')
      .select('id')
      .where('app_id', '=', f.appId)
      .where('id', '=', f.uid)
      .forUpdate()
      .execute();
    const holderPid = await pid(holder);
    const started = Promise.withResolvers<number>();
    const saving = kit.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
      started.resolve(await pid(trx));
      return app.save(trx, f.command);
    });
    pending = saving;
    void saving.catch(() => undefined);
    await waitBlocked(kit, await started.promise, holderPid);
    await block(kit, f, LOGIN);
    await holder.commit().execute();
    finished = true;
    expect(await saving).toMatchObject({ code: 44001, data: { risk_msg_code: 'blocklist.other' } });
    expect(await state(kit, f)).toEqual(before);
  } finally {
    if (!finished) await holder.rollback().execute();
    await pending?.catch(() => undefined);
  }
}, 20_000);
