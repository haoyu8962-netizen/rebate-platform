// B1-06zi (BR-ID-22; migration 0135: insert-if-absent on (app_id, user_id, pid)): two opens of the
// same user on the same pid both told "filed" at the same time leave one filing row and both
// succeed — the losing insert is not a 500. The query answers meet at a rendezvous (bounded, so an
// implementation serializing the opens earlier still finishes).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../open-pdd-auth/database.ts';
import { fixture, outcome, service } from '../open-pdd-auth/kit.ts';
import { success } from '../open-pdd-auth/assertions.ts';
import { TIMEOUT, activeUnfiled, currentPid, filed, filings, rendezvous } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each(['active', 'invalid'] as const)(
  '[AC-B1-06zi#8] 并发：%s 绑定、同一用户同一 pid 两个 open 同时答已备案 → 只一行备案、两个都 200、仅一条未释放 active 绑定',
  async (binding) => {
    // Active built unfiled (pending_auth → active): the open kit may seed rows for 'active'.
    const f =
      binding === 'active'
        ? await activeUnfiled(database(), { query: true })
        : await fixture(database(), { binding, query: true });
    const meet = rendezvous(2, 5_000);
    f.query.mockImplementation(async () => {
      await meet();
      return { authorized: true };
    });
    const open = service(f);
    const [first, second] = await Promise.all([
      outcome(() => open.open(f.request())),
      outcome(() => open.open(f.request())),
    ]);
    await success(first);
    await success(second);
    expect(f.query.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(f.query.mock.calls.length).toBeLessThanOrEqual(2);
    expect(await filings(f)).toEqual([filed(f, f.a.userId, currentPid('self_buy'), f.clock.now())]);
    const rows = await f.bindings();
    expect(rows).toEqual([
      expect.objectContaining({
        user_id: f.a.userId,
        status: 'active',
        union_account_id: f.accountId,
      }),
    ]);
  },
  TIMEOUT,
);
