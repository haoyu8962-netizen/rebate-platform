// B1-06zi (BR-ID-22 「查询返回已授权才置 active」): GET /v1/unions/bindings' Pinduoduo refresh,
// answered filed, activates as now and also writes the filing row of the slot it queried (the
// account in use's self_buy slot), filed_at from the injected clock.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../open-pdd-auth/database.ts';
import { fixture, listed } from '../bindings-pdd-query/kit.ts';
import { REFRESH_PID, TIMEOUT, filed, filings } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each(['absent', 'unbound', 'pending_auth', 'invalid', 'released'] as const)(
  '[AC-B1-06zi#10] 授权管理页刷新 %s 查询答已备案：照现置 active，并插所查自买位的备案行',
  async (binding) => {
    const f = await fixture(database(), binding);
    f.clock.advanceMs(12_345);
    await listed(await f.list(), 'active');
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls[0]![0].claims).toMatchObject({
      appId: f.appId,
      platform: 'pdd',
      promotionSlot: REFRESH_PID,
      userId: f.a.attr,
    });
    expect(await filings(f)).toEqual([filed(f, f.a.userId, REFRESH_PID, f.clock.now())]);
    const active = (await f.bindings()).filter((row) => row.status === 'active');
    expect(active).toEqual([
      expect.objectContaining({ user_id: f.a.userId, union_account_id: f.accountId }),
    ]);
  },
  TIMEOUT,
);
