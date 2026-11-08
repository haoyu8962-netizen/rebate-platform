import { expect, it } from 'vitest';
import {
  assertSwitchTarget,
  planSwitchDrill,
  runSwitchDrill,
} from '../../../../infra/drills/switches/drill.ts';
import { switchSpecOf } from '../../../../apps/api/src/modules/content/domain/switch-registry.ts';
import { fixture, LOCAL } from './fixture.ts';

it('[AC-QA-05c#1] 清单取 §14 与实际可改注册表交集，平台键逐个展开', () => {
  const keys = [
    'agent.enabled',
    'jev.enabled',
    'parse.tpwd.enabled',
    'convert.enabled.taobao',
    'convert.enabled.jd',
    'convert.enabled.pdd',
    'convert.enabled.meituan',
  ];
  const plan = planSwitchDrill(keys);
  expect(plan.map((item) => item.key)).toEqual(keys);
  expect(plan.map((item) => item.behaviour)).toEqual([
    'no_model',
    'rules_only',
    'title_search',
    'conversion_closed',
    'conversion_closed',
    'conversion_closed',
    'conversion_closed',
  ]);
  for (const item of plan) {
    expect(switchSpecOf(item.key)?.adminEditable).toBe(true);
    expect(item.degradedValue).toBe(false);
  }
});

it.each([
  'payout.enabled',
  'payout.queue_paused',
  'payout.channel_enabled.bank_card',
  'pay.enabled',
  'pay.channel_enabled.alipay',
  'withdraw.enabled',
  'withdraw.auto_payout.enabled',
])('[AC-QA-05c#2] 资金键 %s 与安全键混选时整批在任何读取或写入前拒绝', async (key) => {
  const f = fixture(['agent.enabled', key]);
  await expect(runSwitchDrill(f.options)).rejects.toMatchObject({ code: 'forbidden_switch' });
  expect(f.events).toEqual([]);
});

it.each([
  ['agent.model_route', 'readonly_switch'],
  ['sms.provider', 'unregistered_switch'],
  ['agent.result_check.provider', 'unregistered_switch'],
  ['convert.enabled.<platform>', 'unregistered_switch'],
  ['convert.enabled.jd.extra', 'unregistered_switch'],
  ['made.up.enabled', 'unregistered_switch'],
  ['settle.auto.enabled', 'out_of_scope'],
  ['credit.enabled.jd', 'out_of_scope'],
  ['growth.invite_reward.enabled', 'out_of_scope'],
  ['agent.tools.search.enabled', 'out_of_scope'],
])('[AC-QA-05c#3] %s 不能绕过注册表或借配置中心写入', (key, code) => {
  expect(() => planSwitchDrill([key])).toThrow(expect.objectContaining({ code }));
});

it.each([[[]], [['agent.enabled', 'agent.enabled']]])(
  '[AC-QA-05c#4] 空清单或重复项不能伪造成功 %j',
  (keys) => {
    expect(() => planSwitchDrill(keys)).toThrow(
      expect.objectContaining({ code: 'invalid_option' }),
    );
  },
);

it.each(['http://localhost:3100', 'http://127.0.0.1:3100', 'http://[::1]:3100'])(
  '[AC-QA-05c#5] local 回环目标可用 %s',
  (baseUrl) => {
    expect(assertSwitchTarget({ ...LOCAL, baseUrl })).toBeUndefined();
  },
);

it('[AC-QA-05c#6] staging 只允许显式参数和可信配置登记的 HTTPS origin', () => {
  expect(
    assertSwitchTarget({
      appEnv: 'staging',
      staging: true,
      baseUrl: 'https://stage.example.invalid',
      stagingOrigins: ['https://stage.example.invalid'],
    }),
  ).toBeUndefined();
});

it.each([
  { appEnv: 'prod' },
  { appEnv: 'production' },
  { appEnv: '' },
  { baseUrl: 'http://10.0.0.1:3100' },
  { baseUrl: 'http://localhost.attacker.invalid:3100' },
  { baseUrl: 'https://prod.example.invalid' },
  { baseUrl: 'http://user:secret@localhost:3100' },
  { baseUrl: 'http://localhost:3100?host=prod.example.invalid' },
  { baseUrl: 'http://localhost:3100/#secret' },
  { baseUrl: 'file:///etc/passwd' },
  {
    appEnv: 'staging',
    staging: false,
    baseUrl: 'https://stage.example.invalid',
    stagingOrigins: ['https://stage.example.invalid'],
  },
  {
    appEnv: 'staging',
    staging: true,
    baseUrl: 'https://unregistered.example.invalid',
    stagingOrigins: ['https://stage.example.invalid'],
  },
  {
    appEnv: 'staging',
    staging: true,
    baseUrl: 'https://stage.example.invalid:444',
    stagingOrigins: ['https://stage.example.invalid'],
  },
  {
    appEnv: 'staging',
    staging: true,
    baseUrl: 'http://stage.example.invalid',
    stagingOrigins: ['http://stage.example.invalid'],
  },
])('[AC-QA-05c#7] 危险环境或地址在任何 API 调用前拒绝 %j', async (overrides) => {
  const f = fixture();
  await expect(
    runSwitchDrill({ ...f.options, target: { ...LOCAL, ...overrides } }),
  ).rejects.toMatchObject({ code: 'unsafe_target' });
  expect(f.events).toEqual([]);
});
