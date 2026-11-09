// F1-07b · GET /admin/v1/users/lookup (adminLookupUser): user.lookup only (user.list alone is
// 10403), exactly one of uid / phone, phone normalised as BR-ID-05 细则「手机号规范化」, only the
// console's app, phone matches only a user not deleted (ruling §9.2 #5), the body is the detail.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  at,
  binding,
  detail,
  detailUrl,
  get,
  member,
  noPlaintext,
  normalDetail,
  ok,
  rejected,
  riskRow,
  setup,
  syntheticPhone,
  url,
  user,
  type Detail,
} from './kit.ts';
import { DETAIL, LOOKUP } from './schema.ts';

const h = useHarness();

it('[AC-F1-07b#13] 持 user.lookup 的非超管按 uid 查到本 app 用户，不要求二次验证', async () => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  await user(h, f.appId, { createdAt: at(5) });
  const token = await member(h, f, ['user.lookup']);
  for (const headers of [{}, { 'x-step-up-token': 'not-a-valid-step-up-token' }]) {
    const response = await get(f, url(LOOKUP, { uid: target.id }), { token, headers });
    const data = await ok<Detail>(response, LOOKUP);
    expect(normalDetail(data)).toEqual(detail(target));
    noPlaintext(f, [target], response);
  }
});

it.each([
  { permissions: ['user.list'] },
  { permissions: [] },
  { permissions: ['pii.reveal_phone'] },
])(
  '[AC-F1-07b#14] 只持 $permissions（没有 user.lookup）不能查找：10403 admin_permission_denied',
  async ({ permissions }) => {
    const f = await setup(h);
    const target = await user(h, f.appId);
    const token = await member(h, f, permissions);
    for (const query of [{ uid: target.id }, { phone: target.phone! }]) {
      const response = await get(f, url(LOOKUP, query), { token });
      await rejected(response, LOOKUP, 10403, { reason: 'admin_permission_denied' });
      noPlaintext(f, [target], response);
    }
  },
);

it('[AC-F1-07b#15] 未登录（无 admin_token）为 401 / 10001', async () => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  const response = await get(f, url(LOOKUP, { uid: target.id }), { token: null });
  await rejected(response, LOOKUP, 10001);
  noPlaintext(f, [target], response);
});

it('[AC-F1-07b#16] 按完整手机号查找：+86 / 0086 / 86 前缀、空格、连字符、全角写法都规范化后命中', async () => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  await user(h, f.appId, { createdAt: at(5) });
  const token = await member(h, f, ['user.lookup']);
  const p = target.phone!;
  const spaced = `${p.slice(0, 3)} ${p.slice(3, 7)} ${p.slice(7)}`;
  const fullWidth = [...p].map((d) => String.fromCharCode(0xff10 + Number(d))).join('');
  const spellings = [
    p,
    `+86${p}`,
    `+86 ${spaced}`,
    `0086${p}`,
    `86${p}`,
    spaced,
    `${p.slice(0, 3)}-${p.slice(3, 7)}-${p.slice(7)}`,
    ` ${p} `,
    fullWidth,
  ];
  for (const phone of spellings) {
    const response = await get(f, url(LOOKUP, { phone }), { token });
    const data = await ok<Detail>(response, LOOKUP);
    expect(normalDetail(data), JSON.stringify(phone)).toEqual(detail(target));
    noPlaintext(f, [target], response);
  }
});

it.each([
  { label: '都不给', query: {} },
  { label: '都给', query: 'both' as const },
])('[AC-F1-07b#17] uid 与 phone $label → 20001 data.fields=[uid, phone]', async ({ query }) => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  const params = query === 'both' ? { uid: target.id, phone: target.phone! } : query;
  const response = await get(f, url(LOOKUP, params));
  // Exact order as in the contract example AdminUserLookupInvalid.
  await rejected(response, LOOKUP, 20001, { fields: ['uid', 'phone'] });
  noPlaintext(f, [target], response);
});

it.each(['', '12345', '23800138000', '+14155550100', '1380013800', '138001380001', 'abc'])(
  '[AC-F1-07b#18] 规范化不了的手机号 %j → 20001 data.fields=[phone] reason=phone_invalid',
  async (phone) => {
    const f = await setup(h);
    await user(h, f.appId);
    const response = await get(f, url(LOOKUP, { phone }));
    await rejected(response, LOOKUP, 20001, { fields: ['phone'], reason: 'phone_invalid' });
  },
);

it.each(['not-a-uuid', '12345', '0199a3b4-5c6d-7e8f-9a0b'])(
  '[AC-F1-07b#19] uid 不是 UUID（%s）在查库前即 20001 data.fields=[uid]，不是 50001',
  async (uid) => {
    const f = await setup(h);
    await user(h, f.appId);
    const response = await get(f, url(LOOKUP, { uid }));
    await rejected(response, LOOKUP, 20001, { fields: ['uid'] });
  },
);

it('[AC-F1-07b#20] 查不到：未知 uid → [uid]，没人用的号码 → [phone]', async () => {
  const f = await setup(h);
  const existing = await user(h, f.appId);
  let unused = existing.phone!;
  while (unused === existing.phone) unused = syntheticPhone();
  const byUid = await get(f, url(LOOKUP, { uid: randomUUID() }));
  await rejected(byUid, LOOKUP, 20001, { fields: ['uid'] });
  const byPhone = await get(f, url(LOOKUP, { phone: unused }));
  await rejected(byPhone, LOOKUP, 20001, { fields: ['phone'] });
  noPlaintext(f, [existing], byUid);
  noPlaintext(f, [existing], byPhone);
});

it('[AC-F1-07b#21] 别的 app 的用户按 uid、按手机号都查不到，X-App-Id 改不了范围', async () => {
  const f = await setup(h);
  const otherApp = `foreign-${randomUUID()}`;
  const foreign = await user(h, otherApp);
  for (const headers of [{}, { 'x-app-id': otherApp }]) {
    const byUid = await get(f, url(LOOKUP, { uid: foreign.id }), { headers });
    await rejected(byUid, LOOKUP, 20001, { fields: ['uid'] });
    const byPhone = await get(f, url(LOOKUP, { phone: foreign.phone! }), { headers });
    await rejected(byPhone, LOOKUP, 20001, { fields: ['phone'] });
    noPlaintext(f, [foreign], byUid);
    noPlaintext(f, [foreign], byPhone);
  }
});

it('[AC-F1-07b#22] 已注销用户按手机号查不到、按 uid 查得到；同号另有在用账号时手机号只命中在用的', async () => {
  const f = await setup(h);
  const gone = await user(h, f.appId, { status: 'deleted', createdAt: at(1) });
  const byPhone = await get(f, url(LOOKUP, { phone: gone.phone! }));
  await rejected(byPhone, LOOKUP, 20001, { fields: ['phone'] });
  const byUid = await ok<Detail>(await get(f, url(LOOKUP, { uid: gone.id })), LOOKUP);
  expect(normalDetail(byUid)).toEqual(detail(gone));
  const live = await user(h, f.appId, { phone: gone.phone, createdAt: at(2) });
  const again = await ok<Detail>(await get(f, url(LOOKUP, { phone: gone.phone! })), LOOKUP);
  expect(normalDetail(again)).toEqual(detail(live));
});

it('[AC-F1-07b#23] lookup 返回体与详情接口逐字段相同（含风控与联盟绑定，手机号脱敏）', async () => {
  const f = await setup(h);
  const parent = await user(h, f.appId, { createdAt: at(1) });
  const target = await user(h, f.appId, {
    createdAt: at(2),
    parentId: parent.id,
    level: 'L2',
    registeredChannel: null,
  });
  const risk = await riskRow(h, target, {
    state: 'frozen',
    reason_category: 'abnormal_trade',
    reason: '人工复核中',
    frozen_until: at(60 * 24 * 30),
    row_version: 1,
  });
  const taobao = await binding(h, target, 'taobao', { status: 'active', createdAt: at(3) });
  const expected = detail(target, { ...risk, reason: null }, [taobao]);
  const token = await member(h, f, ['user.lookup']);
  const byUid = await ok<Detail>(await get(f, url(LOOKUP, { uid: target.id }), { token }), LOOKUP);
  const byPhone = await get(f, url(LOOKUP, { phone: target.phone! }), { token });
  const phoneData = await ok<Detail>(byPhone, LOOKUP);
  const shown = await ok<Detail>(await get(f, detailUrl(target.id), { token }), DETAIL);
  expect(normalDetail(byUid)).toEqual(expected);
  expect(normalDetail(phoneData)).toEqual(expected);
  expect(normalDetail(shown)).toEqual(expected);
  noPlaintext(f, [target, parent], byPhone);
});
