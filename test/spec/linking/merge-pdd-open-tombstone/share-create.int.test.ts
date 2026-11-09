// B1-06zk #2 (FU-MERGE-PDD-OPEN-TOMBSTONE, D10-1123): POST /v1/shares for Pinduoduo by a sharer
// whose binding is not active, the union authority answering filed, the sharer's row becoming a
// tombstone (users.status = 'deleted') while that query is in flight (the merge committed after the
// request's checks, before its activation) → 10001 (the banned sharer's answer), no active binding,
// no union_pdd_pid_filings row, no link or share_materials row, no conversion, never a 500. Main
// activates the tombstone (red there). The tombstone is written in the query: earlier, identity's
// attr_code reader (deleted → unavailable) would refuse the share before any activation.
// The second half is the control: another, normal sharer of the tenant is activated and filed.
// The share-creation fixture is the frozen shares kit (real api entry; imported, never modified);
// its spy on DemoUnionAdapter.prototype.queryPddAuthority is answered once by this case.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { DemoUnionAdapter } from '../../../../apps/api/src/modules/union/infra/demo/demo-adapter.ts';
import { bodyOf, cardWith, expectRefused, expectShared, sharesHarness } from '../shares/kit.ts';
import { filed, filings, type Tenant } from '../pdd-pid-filings/kit.ts';
import { TIMEOUT, expectTombstone, tombstone, type TombstoneReason } from './kit.ts';

const h = sharesHarness({ createTestDatabase, acquireTestRedis });

/** The kit's spy (installed in its beforeAll): the governed adapter calls through it. */
function authority() {
  return vi.mocked(DemoUnionAdapter.prototype.queryPddAuthority);
}

const SHARE_CASES: readonly {
  readonly binding: 'absent' | 'unbound' | 'pending_auth' | 'invalid';
  readonly reason: TombstoneReason;
}[] = [
  { binding: 'absent', reason: 'merged' },
  { binding: 'unbound', reason: 'merged' },
  { binding: 'pending_auth', reason: 'merged' },
  { binding: 'invalid', reason: 'account_deleted' },
];

it.each(SHARE_CASES)(
  '[AC-B1-06zk#2] 拼多多分享创建：$binding 绑定、查询答已备案，查询期间分享者成墓碑（deleted_reason=$reason）→ 10001，不写 active 绑定、不写备案、不登记 link、不转链；对照：正常分享者照常置 active 并写分享位备案',
  async ({ binding, reason }) => {
    const t = await h.tenant();
    const db = h.db();
    const account = await db
      .selectFrom('union_accounts')
      .select('id')
      .where('app_id', '=', t.appId)
      .where('platform', '=', 'pdd')
      .executeTakeFirstOrThrow();
    const tenant: Tenant = { db, appId: t.appId, accountId: account.id };
    const pddBindings = (userId: string) =>
      db
        .selectFrom('union_bindings')
        .selectAll()
        .where('app_id', '=', t.appId)
        .where('user_id', '=', userId)
        .where('platform', '=', 'pdd')
        .orderBy('id')
        .execute();

    const sharer = await t.user({ pdd: binding });
    const card = cardWith(await sharer.search('pdd'), true);
    const before = await pddBindings(sharer.uid);
    const persisted = await h.persisted(t.appId);
    const calls = authority().mock.calls.length;
    authority().mockImplementationOnce(async () => {
      await tombstone(db, t.appId, sharer.uid, reason);
      return { authorized: true };
    });
    h.clearObservations();

    await expectRefused(await sharer.share(bodyOf(card)), 401, 10001);
    expect(authority().mock.calls.length).toBe(calls + 1);
    const after = await pddBindings(sharer.uid);
    expect(after.filter((row) => row.status === 'active')).toEqual([]);
    expect(after).toEqual(before);
    expect(await filings(tenant)).toEqual([]);
    expect(await h.persisted(t.appId)).toEqual(persisted);
    expect(h.converts()).toEqual([]);
    await expectTombstone(db, t.appId, sharer.uid, reason);

    // Control (not a tombstone): the same share activates and files the share slot, as now.
    const other = await t.user({ pdd: binding });
    h.clock.advanceMs(1_000);
    await expectShared(await other.share(bodyOf(cardWith(await other.search('pdd'), true))));
    expect((await pddBindings(other.uid)).filter((row) => row.status === 'active')).toEqual([
      expect.objectContaining({ user_id: other.uid, union_account_id: account.id }),
    ]);
    expect(await filings(tenant)).toEqual([
      filed(tenant, other.uid, t.pid('pdd', 'share'), h.clock.now()),
    ]);
  },
  TIMEOUT * 2,
);
