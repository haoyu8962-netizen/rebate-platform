// B1-20c: the two merge conditions D10-1099 adds are also judged by the offer (POST /v1/me/phone,
// first binding; 规划/08 BR-ID-06 并号条件): Q-3 any admin_adjustments row of the current account
// (whatever its status) and Q-4 a blocked(admin_disable) union binding of the current account →
// 30411 without the merge offer (no reason, no merge_ticket), nothing bound. Only the current
// account counts: another user's rows do not.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { closeKit, mergeable, occupied, openKit, type Kit } from '../bind-phone/http-kit.ts';
import { BIND_PATH, RESEND_GAP_MS, scene, type Scene } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

/** Binds the target's number with a fresh code; nothing may move. */
async function attempt(s: Scene) {
  const code = await s.send();
  const before = await s.snapshot();
  const response = await s.post(BIND_PATH, { phone: s.number, code });
  expect(await s.snapshot()).toEqual(before);
  return response;
}

for (const status of ['PENDING', 'CANCELLED', 'REJECTED'] as const) {
  it(`[AC-B1-20c#18] Q-3 第三方空号有一条 ${status} 的调账单 → 绑他人号只返回 30411（无 mergeable、无 ticket）`, async () => {
    const s = await scene(kit);
    await s.adjustment(s.source, status);
    occupied(kit, await attempt(s));
  });
}

it('[AC-B1-20c#19] Q-4 第三方空号有 blocked(admin_disable) 的联盟绑定 → 只返回 30411（无 mergeable、无 ticket）', async () => {
  const s = await scene(kit);
  await s.binding(s.source, {
    platform: 'taobao',
    status: 'blocked',
    blocked_reason: 'admin_disable',
  });
  occupied(kit, await attempt(s));
});

it('[AC-B1-20c#20] 只看当前账号：别人的调账单与 admin_disable 绑定不影响（可并号）；当前账号补一条调账单后再绑 → 只返回 30411', async () => {
  const s = await scene(kit);
  const other = await s.bystander();
  await s.adjustment(other, 'PENDING');
  await s.binding(other, {
    platform: 'taobao',
    status: 'blocked',
    blocked_reason: 'admin_disable',
  });
  mergeable(kit, await attempt(s));

  await s.adjustment(s.source, 'CANCELLED');
  kit.clock.advanceMs(RESEND_GAP_MS);
  occupied(kit, await attempt(s));
});

it('[AC-B1-20c#21] 先可并号；当前账号的淘宝绑定被后台停用（admin_disable）后再绑同一号码 → 只返回 30411', async () => {
  const s = await scene(kit);
  await s.binding(s.source, { platform: 'taobao', status: 'active' });
  mergeable(kit, await attempt(s));

  await s.db
    .updateTable('union_bindings')
    .set({ status: 'blocked', blocked_reason: 'admin_disable' })
    .where('app_id', '=', s.appId)
    .where('user_id', '=', s.source)
    .execute();
  kit.clock.advanceMs(RESEND_GAP_MS);
  occupied(kit, await attempt(s));
});
