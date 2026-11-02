// B1-02zz §9 #2 · who may list (contract adminListUserDevices): user.phone_change, the same point as
// recording a re-verified device; read only, so no step-up token and no audit record, for an answer
// or a refusal.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  PERMISSION,
  account,
  list,
  listed,
  member,
  minutesAgo,
  owned,
  pageOf,
  readOnly,
  recorded,
  rejected,
  setup,
  user,
} from './kit.ts';

const h = useHarness();

const DENIED = { reason: 'admin_permission_denied' };
const NO_STEP_UP: readonly Record<string, string>[] = [
  {},
  { 'x-step-up-token': 'not-a-step-up-token' },
];

it.each([
  { permissions: [] as string[] },
  { permissions: ['user.list', 'user.lookup'] },
  { permissions: ['user.realname_fix', 'pii.reveal_phone'] },
])(
  '[AC-B1-02zz#5] 没有 user.phone_change（$permissions）→ 10403 admin_permission_denied，不漏设备、什么都不写、不记审计',
  async ({ permissions }) => {
    const s = await setup(h);
    const { target, device } = await account(s);
    const admin = await member(s, permissions);
    const nothingChanged = await readOnly(s);
    const response = await list(s, target.id, { as: admin });
    await rejected(response, 10403, DENIED);
    expect(JSON.stringify(response.json())).not.toContain(device.id);
    await nothingChanged();
  },
);

it('[AC-B1-02zz#6] 没有权限时用户是否存在不影响答复：未知 user_id 也是 10403，不是 20001', async () => {
  const s = await setup(h);
  const admin = await member(s, ['user.list']);
  const response = await list(s, randomUUID(), { as: admin });
  await rejected(response, 10403, DENIED);
});

it.each([
  { case: '只持 user.phone_change 的非超管', permissions: [PERMISSION] as string[] | null },
  { case: '超管', permissions: null },
])(
  '[AC-B1-02zz#7] $case可以列：不带二次验证令牌、带无效令牌都照常返回（只读，不要 step-up）',
  async ({ permissions }) => {
    const s = await setup(h);
    const target = await user(h, s.appId);
    const seeded = await owned(s, target);
    const admin = permissions === null ? undefined : await member(s, permissions);
    for (const headers of NO_STEP_UP) {
      const response = await list(s, target.id, {
        headers,
        ...(admin === undefined ? {} : { as: admin }),
      });
      const page = await listed(response);
      expect(page.items.map((item) => item.device_id)).toEqual([seeded.id]);
    }
  },
);

it('[AC-B1-02zz#8] 未登录（无 admin_token）为 401 / 10001，不漏设备、什么都不写、不记审计', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  const nothingChanged = await readOnly(s);
  const response = await list(s, target.id, { token: null });
  await rejected(response, 10001);
  expect(JSON.stringify(response.json())).not.toContain(device.id);
  await nothingChanged();
});

it('[AC-B1-02zz#9] 只读：列表与它的 20001 都不写审计（任何动作名都不算），也不碰设备、会话、账号与已加验记录', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  await recorded(s, target, device, 'self', minutesAgo(s, 10));
  const admin = await member(s, [PERMISSION]);
  const nothingChanged = await readOnly(s);
  // Later than the seeds: a read that stamped last_seen_at or updated_at would show.
  s.clock.advanceMs(60_000);
  expect((await pageOf(s, target, { as: admin })).total).toBe(1);
  await rejected(await list(s, randomUUID(), { as: admin }), 20001, { fields: ['user_id'] });
  await rejected(await list(s, target.id, { as: admin, query: { page_size: '201' } }), 20001, {
    fields: ['page_size'],
  });
  await nothingChanged();
});
