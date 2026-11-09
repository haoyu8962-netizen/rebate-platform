// B1-06zi (BR-ID-22 「授权状态按 (user_id, pid) 记录……查询返回已授权才置 active」; brief
// 「查询答已备案处一律补写备案行」): POST /v1/shares for Pinduoduo by a sharer whose binding is not
// active queries the authority with the share identity (shares.ts #pddAuthorization); answered
// filed, the binding is activated as now and the share slot's filing row is written — app_id, the
// sharer, the share slot's pid, the account in use, filed_at from the injected clock. Main activates
// without writing the row, so the first half is red there; a second share on the now-active binding
// leaves the one row (second half).
// The share-creation fixture is the frozen shares kit (real api entry; imported, never modified).
// Its spy on DemoUnionAdapter.prototype.queryPddAuthority answers the demo's own "filed" unless a
// case calls refusePddFiling.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { bodyOf, cardWith, expectShared, sharesHarness } from '../shares/kit.ts';
import { TIMEOUT, filed, filings, type Tenant } from './kit.ts';

const h = sharesHarness({ createTestDatabase, acquireTestRedis });

it.each(['absent', 'unbound', 'pending_auth', 'invalid'] as const)(
  '[AC-B1-06zi#11] 拼多多分享创建 %s 绑定查询答已备案：照现置 active 并出分享素材，且插分享位的备案行（本 App、本人、share pid、所用账户、注入时钟）；再分享同位不再多行',
  async (binding) => {
    const t = await h.tenant();
    const sharer = await t.user({ pdd: binding });
    const db = h.db();
    const account = await db
      .selectFrom('union_accounts')
      .select('id')
      .where('app_id', '=', t.appId)
      .where('platform', '=', 'pdd')
      .executeTakeFirstOrThrow();
    const tenant: Tenant = { db, appId: t.appId, accountId: account.id };
    const card = cardWith(await sharer.search('pdd'), true);
    expect(await filings(tenant)).toEqual([]);
    h.clock.advanceMs(4_321);

    await expectShared(await sharer.share(bodyOf(card)));
    const active = await db
      .selectFrom('union_bindings')
      .select(['user_id', 'union_account_id', 'status'])
      .where('app_id', '=', t.appId)
      .where('platform', '=', 'pdd')
      .execute();
    expect(active).toEqual([
      { user_id: sharer.uid, union_account_id: account.id, status: 'active' },
    ]);
    const rows = await filings(tenant);
    expect(rows).toEqual([filed(tenant, sharer.uid, t.pid('pdd', 'share'), h.clock.now())]);

    // The share slot is filed now: another share on the active binding adds no row.
    h.clock.advanceMs(1_000);
    await expectShared(await sharer.share(bodyOf(card)));
    expect(await filings(tenant)).toEqual(rows);
  },
  TIMEOUT * 2,
);
