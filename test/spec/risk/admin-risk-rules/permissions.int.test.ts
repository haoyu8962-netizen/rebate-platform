// B1-03zg: config.risk guards all three operations (04 §11.2; a super admin holds every point);
// the list is read only (no step-up), enable / disable need a totp step-up on every call
// (CT-24f: without a valid totp-tier X-Step-Up-Token → 10003 data.tier=totp). The routes exist on
// the admin entry only and need an admin session.
import { expect, it } from 'vitest';
import { fixture, useHarness } from '../../admin/auth/kit.ts';
import {
  CHANGES,
  DENIED,
  LIST,
  PERMISSION,
  TOTP_REQUIRED,
  accepted,
  expectedRule,
  instant,
  listed,
  mounted,
  otherOf,
  rejected,
  ruleAudits,
  seedRule,
  setup,
  snapshot,
  targetOf,
  unlistedId,
  type Scenario,
} from './kit.ts';

const h = useHarness();

async function seeded(s: Scenario, status: 'enabled' | 'disabled' = 'enabled') {
  return seedRule(s, { rule_id: unlistedId(), scene: 'register', status, version: 4 });
}

it.each<[string, readonly string[]]>([
  ['没有任何权限', []],
  [
    '只有其他风控与配置权限',
    [
      'risk.ban',
      'risk.freeze',
      'risk.appeal',
      'risk.blocklist',
      'config.general',
      'config.business',
    ],
  ],
])('[AC-B1-03zg#7] %s → 列表与启停都 10403 admin_permission_denied', async (_label, grants) => {
  const s = await setup(h, { grants });
  const row = await seeded(s, 'disabled');
  await rejected(await s.list(), 10403, DENIED);
  const before = await snapshot(s);
  for (const change of CHANGES) {
    await rejected(
      await s.change(change, row.rule_id, { expected_version: row.version, reason: '核对后调整' }),
      10403,
      DENIED,
    );
  }
  expect(await snapshot(s)).toEqual(before);
});

it('[AC-B1-03zg#8] 超管不需单独授权即可查看与启停', async () => {
  const s = await setup(h, { grants: [], isSuper: true });
  const row = await seeded(s, 'disabled');
  expect((await listed(await s.list())).map(instant)).toEqual([expectedRule(row)]);
  const data = await accepted(await s.change('enable', row.rule_id, { expected_version: 4 }));
  expect(data).toMatchObject({ rule_id: row.rule_id, status: 'enabled', version: 5 });
});

it('[AC-B1-03zg#9] 只持 config.risk 即可查看列表，不需动态码；无效的 step-up 头被忽略', async () => {
  const s = await setup(h);
  const row = await seeded(s);
  const before = await snapshot(s);
  const variants: Record<string, string>[] = [
    {},
    { 'x-step-up-token': 'not-a-valid-step-up-token' },
  ];
  for (const headers of variants) {
    expect((await listed(await s.list(headers))).map(instant)).toEqual([expectedRule(row)]);
  }
  expect(await snapshot(s)).toEqual(before);
});

for (const change of CHANGES) {
  it.each([false, true])(
    `[AC-B1-03zg#10] ${change} 缺动态码或动态码无效 → 10003 tier=totp，超管=%s`,
    async (isSuper) => {
      const s = await setup(h, { grants: isSuper ? [] : [PERMISSION], isSuper });
      const row = await seeded(s, otherOf(change));
      const before = await snapshot(s);
      for (const token of [null, 'invalid-step-up-token']) {
        await rejected(
          await s.change(change, row.rule_id, { expected_version: row.version }, { token }),
          10003,
          TOTP_REQUIRED,
        );
        expect(await snapshot(s)).toEqual(before);
      }
    },
  );

  it(`[AC-B1-03zg#11] ${change} 已过期的动态码不能操作`, async () => {
    const s = await setup(h);
    const row = await seeded(s, otherOf(change));
    const token = await s.issue();
    s.f.clock.advanceMs(300_001);
    const before = await snapshot(s);
    await rejected(
      await s.change(change, row.rule_id, { expected_version: row.version }, { token }),
      10003,
      TOTP_REQUIRED,
    );
    expect(await snapshot(s)).toEqual(before);
  });
}

it('[AC-B1-03zg#12] 每次启停都要新的动态码：生效一次后同一令牌再用 → 10003', async () => {
  const s = await setup(h);
  const row = await seeded(s, 'disabled');
  const token = await s.issue();
  const enabled = await accepted(
    await s.change('enable', row.rule_id, { expected_version: 4 }, { token }),
  );
  expect(enabled).toMatchObject({ status: targetOf('enable'), version: 5 });
  const before = await snapshot(s);
  await rejected(
    await s.change('disable', row.rule_id, { expected_version: 5 }, { token }),
    10003,
    TOTP_REQUIRED,
  );
  expect(await snapshot(s)).toEqual(before);
});

it('[AC-B1-03zg#13] 撤销 config.risk 后下一次查看与启停立即 10403', async () => {
  const s = await setup(h);
  const row = await seeded(s, 'disabled');
  expect(await listed(await s.list())).toHaveLength(1);
  await h.db
    .deleteFrom('admin_permissions')
    .where('app_id', '=', s.appId)
    .where('admin_id', '=', s.a.id)
    .where('permission_key', '=', PERMISSION)
    .execute();
  await rejected(await s.list(), 10403, DENIED);
  await rejected(
    await s.change('enable', row.rule_id, { expected_version: row.version }),
    10403,
    DENIED,
  );
  expect(await ruleAudits(s)).toEqual([]);
});

it('[AC-B1-03zg#14] 伪造身份头不能越权或换应用', async () => {
  const s = await setup(h, { grants: [] });
  const other = await setup(h);
  const row = await seeded(other, 'disabled');
  const forged = {
    'x-is-super': 'true',
    'x-admin-id': other.a.id,
    'x-app-id': other.appId,
    'x-permissions': PERMISSION,
  };
  const before = await snapshot(other);
  await rejected(await s.list(forged), 10403, DENIED);
  await rejected(
    await s.change('enable', row.rule_id, { expected_version: row.version }, { headers: forged }),
    10403,
    DENIED,
  );
  expect(await snapshot(other)).toEqual(before);
});

it('[AC-B1-03zg#15] 三个接口都必须登录后台', async () => {
  const s = await setup(h);
  const row = await seeded(s, 'disabled');
  const before = await snapshot(s);
  const variants: Record<string, string>[] = [{}, { authorization: 'Bearer forged' }];
  for (const headers of variants) {
    await rejected(await s.f.app.inject({ method: 'GET', url: LIST, headers }), 10001);
    for (const change of CHANGES) {
      await rejected(
        await s.f.app.inject({
          method: 'POST',
          url: `${LIST}/${row.rule_id}/${change}`,
          headers: { 'content-type': 'application/json', ...headers },
          payload: JSON.stringify({ expected_version: row.version }),
        }),
        10001,
      );
    }
  }
  expect(await snapshot(s)).toEqual(before);
});

it('[AC-B1-03zg#16] 三个接口只在 admin 入口注册', async () => {
  const s = await setup(h);
  expect(mounted(s.f)).toEqual([true, true, true]);
  for (const entry of ['api', 'stream'] as const) {
    expect(mounted(await fixture(h, { entry })), entry).toEqual([false, false, false]);
  }
});
