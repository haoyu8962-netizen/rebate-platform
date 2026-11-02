// B1-02zx §9 #2, #5 · the three checks in front of everything (contract
// adminAddUserReverifiedDevice: user.phone_change, totp step-up, the body): a request stopped by
// one of them changes nothing and is not audited.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  PERMISSION,
  REASON,
  account,
  body,
  member,
  ok,
  record,
  records,
  rejected,
  setup,
  stepUp,
  watch,
  type Body,
} from './kit.ts';

const h = useHarness();

const STEP_UP_REQUIRED = { tier: 'totp' };

it.each([
  { permissions: [] as string[] },
  { permissions: ['user.list', 'user.lookup'] },
  { permissions: ['user.realname_fix', 'pii.reveal_phone'] },
])(
  '[AC-B1-02zx#5] 没有 user.phone_change（$permissions）→ 10403 admin_permission_denied，什么都不写、不记审计',
  async ({ permissions }) => {
    const s = await setup(h);
    const { target, device } = await account(s);
    const admin = await member(s, permissions);
    const nothingChanged = await watch(s);
    const response = await record(s, target.id, body(device), { as: admin });
    await rejected(response, 10403, { reason: 'admin_permission_denied' });
    await nothingChanged();
  },
);

it('[AC-B1-02zx#6] 只持 user.phone_change 的非超管可以登记', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  const admin = await member(s, [PERMISSION]);
  const data = await ok(await record(s, target.id, body(device), { as: admin }));
  expect(data).toMatchObject({ user_id: target.id, device_id: device.id, created: true });
  expect(await records(h, target)).toHaveLength(1);
});

it.each([true, false])(
  '[AC-B1-02zx#7] 超管=%s 也要有效 totp 令牌：缺失或无效为 10003 tier=totp，什么都不写、不记审计',
  async (isSuper) => {
    const s = await setup(h);
    const { target, device } = await account(s);
    const admin = isSuper ? undefined : await member(s, [PERMISSION]);
    const nothingChanged = await watch(s);
    for (const step of [null, 'not-a-step-up-token']) {
      const response = await record(s, target.id, body(device), {
        stepUp: step,
        ...(admin === undefined ? {} : { as: admin }),
      });
      await rejected(response, 10003, STEP_UP_REQUIRED);
    }
    await nothingChanged();
  },
);

it('[AC-B1-02zx#8] 别的管理员的 totp 令牌不算数 → 10003 tier=totp', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  const admin = await member(s, [PERMISSION]);
  const colleague = await member(s, [PERMISSION]);
  const step = await stepUp(s, colleague.who, colleague.token);
  const nothingChanged = await watch(s);
  const response = await record(s, target.id, body(device), { as: admin, stepUp: step });
  await rejected(response, 10003, STEP_UP_REQUIRED);
  await nothingChanged();
});

it('[AC-B1-02zx#9] 未登录（无 admin_token）为 401 / 10001，什么都不写、不记审计', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  const nothingChanged = await watch(s);
  await rejected(await record(s, target.id, body(device), { token: null }), 10001);
  await nothingChanged();
});

const INVALID: readonly { case: string; patch: Body; fields: string[] }[] = [
  { case: '缺 device_id', patch: { device_id: undefined }, fields: ['device_id'] },
  { case: 'device_id 空串', patch: { device_id: '' }, fields: ['device_id'] },
  { case: 'device_id 为 null', patch: { device_id: null }, fields: ['device_id'] },
  { case: 'device_id 是数字', patch: { device_id: 123 }, fields: ['device_id'] },
  { case: 'device_id 超过 64 字符', patch: { device_id: 'a'.repeat(65) }, fields: ['device_id'] },
  { case: '缺 reason', patch: { reason: undefined }, fields: ['reason'] },
  { case: 'reason 空串', patch: { reason: '' }, fields: ['reason'] },
  { case: 'reason 全是半角空白', patch: { reason: ' \t\n ' }, fields: ['reason'] },
  { case: 'reason 全是全角空格', patch: { reason: '　　' }, fields: ['reason'] },
  { case: 'reason 超过 200 字', patch: { reason: '核'.repeat(201) }, fields: ['reason'] },
  {
    case: 'reason 连首尾空白 201 字、去空白后 199 字',
    patch: { reason: ` ${'核'.repeat(199)} ` },
    fields: ['reason'],
  },
  { case: 'reason 为 null', patch: { reason: null }, fields: ['reason'] },
  { case: 'reason 是数字', patch: { reason: 123 }, fields: ['reason'] },
  { case: '多带 source', patch: { source: 'self' }, fields: ['source'] },
  { case: '多带 device_hash', patch: { device_hash: 'a'.repeat(64) }, fields: ['device_hash'] },
];

it.each(INVALID)(
  '[AC-B1-02zx#10] 请求体不合格（$case）→ 20001 data.fields 点名，什么都不写、不记审计',
  async ({ patch, fields }) => {
    const s = await setup(h);
    const { target, device } = await account(s);
    const nothingChanged = await watch(s);
    const response = await record(s, target.id, { ...body(device), ...patch });
    await rejected(response, 20001, { fields });
    await nothingChanged();
  },
);

it.each([
  { case: '1 字', reason: '核' },
  { case: '恰好 200 字', reason: '核'.repeat(200) },
  { case: '连首尾空白恰好 200 字', reason: ` ${'核'.repeat(198)} ` },
  { case: '去首尾空白后 1 字', reason: `  核　\n` },
  { case: '首尾空白之内的原文', reason: ` ${REASON} ` },
])('[AC-B1-02zx#11] reason 合法边界（$case）→ 登记成功', async ({ reason }) => {
  const s = await setup(h);
  const { target, device } = await account(s);
  const data = await ok(await record(s, target.id, body(device, reason)));
  expect(data.created).toBe(true);
  expect(await records(h, target)).toHaveLength(1);
});
