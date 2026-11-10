// B2-16d §10 #1, #6 · who may read the invite reward records (contracts adminListInviteRewards /
// adminGetInviteReward): fund.view (04 §6.6 invite-rewards), read only, so no step-up token; without
// the point 10403 admin_permission_denied, without a login or with an expired one 10001; no answer
// or refusal writes anything or an audit record.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { DETAIL, LIST } from './schema.ts';
import {
  DENIED,
  VIEW,
  detail,
  ids,
  list,
  listed,
  member,
  readOnly,
  rejected,
  reward,
  setup,
  shown,
} from './kit.ts';

const h = useHarness();

const NO_STEP_UP: readonly Record<string, string>[] = [
  {},
  { 'x-step-up-token': 'not-a-step-up-token' },
];

it.each([
  { permissions: [] as string[] },
  { permissions: ['user.list', 'user.lookup', 'pii.reveal_phone'] },
  { permissions: ['config.business', 'user.inviter', 'order.view', 'dashboard.view'] },
])(
  '[AC-B2-16d#5] 没有 fund.view（$permissions）→ 列表与详情都是 10403 admin_permission_denied，不漏记录、什么都不写、不记审计',
  async ({ permissions }) => {
    const s = await setup(h);
    const seeded = await reward(s, { status: 'processed' });
    const admin = await member(s, permissions);
    const nothingChanged = await readOnly(s);
    const listing = await list(s, {}, { as: admin });
    await rejected(LIST, listing, 10403, DENIED);
    const one = await detail(s, seeded.invitee.id, { as: admin });
    await rejected(DETAIL, one, 10403, DENIED);
    for (const response of [listing, one]) {
      const text = JSON.stringify(response.json());
      expect(text).not.toContain(seeded.invitee.id);
      expect(text).not.toContain(seeded.inviter.id);
      expect(text).not.toContain('budget');
    }
    await nothingChanged();
  },
);

it('[AC-B2-16d#6] 没有 fund.view 时记录是否存在不影响答复：未知受邀人的详情也是 10403，不是 30701', async () => {
  const s = await setup(h);
  const admin = await member(s, ['user.list']);
  await rejected(DETAIL, await detail(s, randomUUID(), { as: admin }), 10403, DENIED);
});

it.each([
  { case: '只持 fund.view 的非超管', permissions: [VIEW] as string[] | null },
  { case: '超管', permissions: null },
])(
  '[AC-B2-16d#7] $case可以读：不带二次验证令牌、带无效令牌都照常返回列表与详情（只读，不要 step-up）',
  async ({ permissions }) => {
    const s = await setup(h);
    const seeded = await reward(s);
    const admin = permissions === null ? undefined : await member(s, permissions);
    const as = admin === undefined ? {} : { as: admin };
    for (const headers of NO_STEP_UP) {
      const page = await listed(await list(s, {}, { headers, ...as }));
      expect(ids(page)).toEqual([seeded.invitee.id]);
      const one = await shown(await detail(s, seeded.invitee.id, { headers, ...as }));
      expect(one.invitee_id).toBe(seeded.invitee.id);
    }
  },
);

it('[AC-B2-16d#8] 未登录（无 admin_token）与伪造令牌都是 401 / 10001，不漏记录、什么都不写、不记审计', async () => {
  const s = await setup(h);
  const seeded = await reward(s);
  const nothingChanged = await readOnly(s);
  for (const token of [null, 'not-an-admin-token']) {
    const listing = await list(s, {}, { token });
    await rejected(LIST, listing, 10001);
    const one = await detail(s, seeded.invitee.id, { token });
    await rejected(DETAIL, one, 10001);
    for (const response of [listing, one]) {
      expect(JSON.stringify(response.json())).not.toContain(seeded.invitee.id);
    }
  }
  await nothingChanged();
});

it('[AC-B2-16d#9] 令牌闲置超时后（30 分钟无操作）列表与详情都是 401 / 10001', async () => {
  const s = await setup(h);
  const seeded = await reward(s);
  const admin = await member(s, [VIEW]);
  expect(ids(await listed(await list(s, {}, { as: admin })))).toEqual([seeded.invitee.id]);
  s.clock.advanceMs(1_801_000);
  await rejected(LIST, await list(s, {}, { as: admin }), 10001);
  await rejected(DETAIL, await detail(s, seeded.invitee.id, { as: admin }), 10001);
});

it('[AC-B2-16d#10] 只读：列表、详情与它们的 20001 / 30701 都不写审计（任何动作名都不算），也不碰记录、预算、账号与凭证', async () => {
  const s = await setup(h);
  const seeded = await reward(s, { status: 'processed' });
  await reward(s, { status: 'deferred' });
  const admin = await member(s, [VIEW]);
  const nothingChanged = await readOnly(s);
  // Later than the seeds: a read that stamped updated_at or bumped row_version would show.
  s.clock.advanceMs(60_000);
  expect((await listed(await list(s, {}, { as: admin }))).total).toBe(2);
  expect((await listed(await list(s, { status: 'deferred' }, { as: admin }))).total).toBe(1);
  await shown(await detail(s, seeded.invitee.id, { as: admin }));
  await rejected(DETAIL, await detail(s, randomUUID(), { as: admin }), 30701);
  await rejected(LIST, await list(s, { page_size: '201' }, { as: admin }), 20001, {
    fields: ['page_size'],
  });
  await nothingChanged();
});
