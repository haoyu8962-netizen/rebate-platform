// BR-ID-36 细则「规则清单的启停」 × BR-INV-09 首次登录 App 同设备解除邀请归属 (rule
// inv_09_same_device; D10-536 §9.2 2): growth's first App login review asks the rule status before
// judging, so a disabled rule unbinds nothing, writes no risk_same_device relation change and no
// hit. Real signed SMS login on the real AppModule (growth review assembled by app.module).
import { expect, it } from 'vitest';
import { accepted, type Fixture } from '../../identity/oauth-login/kit.ts';
import {
  assertHit,
  hits as inviteHits,
  relationLogs,
  user,
} from '../../growth/landing-review/kit.ts';
import { SMS_LOGIN_PATH, TTL_MS, boundAccount, smsLogin, toggle, withApp } from './kit.ts';

/** The account's SMS login on the fixture's device succeeds as an existing account. */
async function loggedIn(f: Fixture, uid: string, number: string) {
  const data = accepted(f.kit, SMS_LOGIN_PATH, await smsLogin(f, number));
  expect(data).toMatchObject({ user_id: uid, is_new_user: false });
}

/** The invitee is still bound to the inviter through the landing page. */
async function stillBound(f: Fixture, uid: string, parentId: string) {
  expect(await user(f.db, f.appId, uid)).toMatchObject({
    parent_id: parentId,
    parent_bind_source: 'landing',
  });
}

it('[AC-B1-03zh#11][BR-ID-36][BR-INV-09] inv_09_same_device 停用：用上级登录过的设备首次登录不解除归属、不写变更与命中；启用并过缓存周期后恢复', async () => {
  await withApp(async (f) => {
    await toggle(f, 'inv_09_same_device', 'disabled');
    const a = await boundAccount(f);
    // Login bookkeeping is outside this rule, so these columns may change either way.
    const loginColumns = new Set([
      'last_active_at',
      'last_login_device_hash',
      'reverify_flagged_at',
      'reverify_trusted',
      'updated_at',
    ]);
    const stableRow = async () =>
      Object.fromEntries(
        Object.entries(await user(f.db, f.appId, a.uid)).filter(([k]) => !loginColumns.has(k)),
      );
    const before = await stableRow();
    await loggedIn(f, a.uid, a.number);
    await stillBound(f, a.uid, a.parentId);
    expect(await stableRow()).toEqual(before);
    expect(await relationLogs(f.db, f.appId)).toEqual([]);
    expect(await inviteHits(f.db, f.appId)).toEqual([]);

    await toggle(f, 'inv_09_same_device', 'enabled');
    f.kit.clock.advanceMs(TTL_MS);
    const b = await boundAccount(f);
    await loggedIn(f, b.uid, b.number);
    await assertHit(f.db, f.appId, b.uid, b.parentId, b.hash, f.kit.clock.now());
    // The account judged while the rule was off is not judged again afterwards.
    expect(await stableRow()).toEqual(before);
  });
});

it('[AC-B1-03zh#12][BR-ID-36][BR-INV-09] 停用不追溯：已解除的归属、变更记录与命中保持不变；停用后的首次登录不再判定', async () => {
  await withApp(async (f) => {
    // No row yet: the rule takes part.
    const a = await boundAccount(f);
    await loggedIn(f, a.uid, a.number);
    const at = f.kit.clock.now();
    await assertHit(f.db, f.appId, a.uid, a.parentId, a.hash, at);
    const unbound = await user(f.db, f.appId, a.uid);
    const logs = await relationLogs(f.db, f.appId);
    const recorded = await inviteHits(f.db, f.appId);

    await toggle(f, 'inv_09_same_device', 'disabled');
    f.kit.clock.advanceMs(TTL_MS);
    const b = await boundAccount(f);
    await loggedIn(f, b.uid, b.number);
    await stillBound(f, b.uid, b.parentId);
    expect(await user(f.db, f.appId, a.uid)).toEqual(unbound);
    expect(await relationLogs(f.db, f.appId)).toEqual(logs);
    expect(await inviteHits(f.db, f.appId)).toEqual(recorded);
  });
});
