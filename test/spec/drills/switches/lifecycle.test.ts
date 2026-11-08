import { expect, it } from 'vitest';
import {
  matchesDegradation,
  runSwitchDrill,
  type SwitchCase,
} from '../../../../infra/drills/switches/drill.ts';
import { BASELINE, DEGRADED, fixture, row, STEP_UP, TOKEN } from './fixture.ts';

it('[AC-QA-05c#8] 每个开关先读原值并确认基线，降级验证后恢复，再验证恢复，之后才动下一个', async () => {
  const f = fixture(['agent.enabled', 'jev.enabled']);
  const result = await runSwitchDrill(f.options);
  expect(result).toMatchObject({
    ok: true,
    problems: [],
    restored: ['agent.enabled', 'jev.enabled'],
  });
  expect(f.events[0]).toBe('read');
  expect(f.events.filter((event) => event !== 'read')).toEqual([
    'probe:agent.enabled:true',
    'write:agent.enabled:false:7',
    'probe:agent.enabled:false',
    'write:agent.enabled:true:8',
    'probe:agent.enabled:true',
    'probe:jev.enabled:true',
    'write:jev.enabled:false:7',
    'probe:jev.enabled:false',
    'write:jev.enabled:true:8',
    'probe:jev.enabled:true',
  ]);
  expect([...f.rows.values()].map((item) => item.value)).toEqual([true, true]);
});

it.each(['agent.enabled', 'jev.enabled', 'parse.tpwd.enabled', 'convert.enabled.jd'])(
  '[AC-QA-05c#9] %s 确实核对业务表现，配置变成 false 不等于降级成功',
  async (key) => {
    const f = fixture([key]);
    f.hooks.observe = () => BASELINE;
    const result = await runSwitchDrill(f.options);
    expect(result.ok).toBe(false);
    expect(result.problems).toContainEqual({ key, code: 'degradation_timeout' });
    expect(f.elapsed()).toBe(10_000);
    expect(f.rows.get(key)?.value).toBe(true);
    expect(f.events).toContain(`probe:${key}:true`);
  },
);

it.each([
  [0, true],
  [9_999, true],
  [10_000, true],
  [10_001, false],
] as const)('[AC-QA-05c#10] 降级观测延迟 %i ms，10 秒边界结果为 %s', async (delay, ok) => {
  const f = fixture();
  f.hooks.observe = (_key, value, elapsed) =>
    value === false && elapsed >= delay ? DEGRADED : BASELINE;
  const result = await runSwitchDrill(f.options);
  expect(result.ok).toBe(ok);
  expect(f.elapsed()).toBeLessThanOrEqual(10_000);
  expect(f.rows.get('agent.enabled')?.value).toBe(true);
});

it('[AC-QA-05c#11] 恢复值写成功但业务仍降级，独立给恢复最多 10 秒并判失败', async () => {
  const f = fixture();
  let changed = false;
  f.hooks.afterWrite = () => {
    changed = true;
  };
  f.hooks.observe = () => (changed ? DEGRADED : BASELINE);
  const result = await runSwitchDrill(f.options);
  expect(result.ok).toBe(false);
  expect(result.problems).toContainEqual({ key: 'agent.enabled', code: 'recovery_timeout' });
  expect(f.elapsed()).toBe(10_000);
  expect(f.rows.get('agent.enabled')?.value).toBe(true);
});

it('[AC-QA-05c#12] 恢复也允许缓存延迟，必须等恢复观测通过才成功', async () => {
  const f = fixture();
  let restored = false;
  f.hooks.afterWrite = (_key, value) => {
    if (value === true) restored = true;
  };
  f.hooks.observe = (_key, value, elapsed) =>
    value === false || (restored && elapsed < 10_000) ? DEGRADED : BASELINE;
  const result = await runSwitchDrill(f.options);
  expect(result.ok).toBe(true);
  expect(f.elapsed()).toBe(10_000);
});

it('[AC-QA-05c#13] 降级探针抛错仍恢复原值且不开始第二个开关', async () => {
  const f = fixture(['agent.enabled', 'jev.enabled']);
  f.hooks.observe = (_key, value) => {
    if (value === false) throw new Error(`probe failed ${TOKEN} ${STEP_UP}`);
    return BASELINE;
  };
  const result = await runSwitchDrill(f.options);
  expect(result.ok).toBe(false);
  expect(result.restored).toContain('agent.enabled');
  expect(f.events).toContain('write:agent.enabled:true:8');
  expect(f.events.some((event) => event.startsWith('write:jev.enabled'))).toBe(false);
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  expect(JSON.stringify(result)).not.toContain(STEP_UP);
});

it('[AC-QA-05c#14] PUT 已提交但响应丢失，重新读取当前版本后恢复，不遗留降级值', async () => {
  const f = fixture();
  f.hooks.afterWrite = (_key, value) => {
    if (value === false) throw new Error('response lost after commit');
  };
  const result = await runSwitchDrill(f.options);
  expect(result.ok).toBe(false);
  expect(f.rows.get('agent.enabled')?.value).toBe(true);
  expect(f.events).toContain('write:agent.enabled:true:8');
  const mutation = f.events.indexOf('write:agent.enabled:false:7');
  const restore = f.events.indexOf('write:agent.enabled:true:8');
  expect(f.events.slice(mutation + 1, restore)).toContain('read');
});

it('[AC-QA-05c#15] 恢复写入失败必须记录并判失败，不能声称已恢复', async () => {
  const f = fixture();
  const update = f.options.api.update;
  f.options.api.update = async (key, value, version) => {
    if (value === true) throw new Error(`restore denied ${TOKEN}`);
    return update(key, value, version);
  };
  const result = await runSwitchDrill(f.options);
  expect(result.ok).toBe(false);
  expect(result.problems).toContainEqual({ key: 'agent.enabled', code: 'restore_failed' });
  expect(result.restored).not.toContain('agent.enabled');
  expect(JSON.stringify(result)).not.toContain(TOKEN);
});

it.each(['SIGINT', 'SIGTERM'])(
  '[AC-QA-05c#16] 写入后收到 %s 仍等待恢复且不启动后续项',
  async (signal) => {
    const f = fixture(['agent.enabled', 'jev.enabled']);
    f.hooks.afterWrite = (_key, value) => {
      if (value === false) f.controller.abort(signal);
    };
    const result = await runSwitchDrill(f.options);
    expect(result.ok).toBe(false);
    expect(result.problems).toContainEqual({ key: 'agent.enabled', code: 'interrupted' });
    expect(result.restored).toEqual(['agent.enabled']);
    expect(f.rows.get('agent.enabled')?.value).toBe(true);
    expect(f.events).toContain('probe:agent.enabled:true');
    expect(f.events.some((event) => event.startsWith('write:jev.enabled'))).toBe(false);
  },
);

it('[AC-QA-05c#17] 已取消的演练不产生任何开关写入', async () => {
  const f = fixture();
  f.controller.abort('SIGTERM');
  const result = await runSwitchDrill(f.options);
  expect(result.ok).toBe(false);
  expect(f.events.filter((event) => event.startsWith('write:'))).toEqual([]);
});

it.each([false, null])(
  '[AC-QA-05c#18] 原值为 %s 时不擅自开启或把默认值冒充原值',
  async (original) => {
    const f = fixture();
    f.rows.set('agent.enabled', row('agent.enabled', original, original === null ? 0 : 7));
    const result = await runSwitchDrill(f.options);
    expect(result.ok).toBe(false);
    expect(f.rows.get('agent.enabled')?.value).toBe(original);
    expect(f.events.filter((event) => event.startsWith('write:'))).toEqual([]);
  },
);

it('[AC-QA-05c#19] 远端行不可改或不存在，整批预检失败且零写入', async () => {
  const f = fixture(['agent.enabled', 'jev.enabled']);
  f.rows.delete('jev.enabled');
  const missing = await runSwitchDrill(f.options);
  expect(missing.ok).toBe(false);
  expect(f.events.filter((event) => event.startsWith('write:'))).toEqual([]);
  f.rows.set('jev.enabled', { ...row('jev.enabled'), admin_editable: false });
  const readonly = await runSwitchDrill(f.options);
  expect(readonly.ok).toBe(false);
  expect(f.events.filter((event) => event.startsWith('write:'))).toEqual([]);
});

it('[AC-QA-05c#20] §14 转链、解析、无模型与纯规则降级分别核对完整表现', () => {
  const scenarios: readonly SwitchCase[] = [
    { key: 'convert.enabled.jd', degradedValue: false, behaviour: 'conversion_closed' },
    { key: 'parse.tpwd.enabled', degradedValue: false, behaviour: 'title_search' },
    { key: 'agent.enabled', degradedValue: false, behaviour: 'no_model' },
    { key: 'jev.enabled', degradedValue: false, behaviour: 'rules_only' },
  ];
  const observations = [
    { code: 50301 },
    { code: 30132, guideTitleSearch: true },
    DEGRADED,
    { code: 0, judgeCalled: false, cards: true, specPending: true, semanticPrecheckSkipped: true },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    expect(matchesDegradation(scenario, observations[index]!)).toBe(true);
    expect(matchesDegradation(scenario, BASELINE)).toBe(false);
    expect(matchesDegradation(scenario, { code: 50001 })).toBe(false);
  }
});

it.each(['modelCalled', 'cards', 'fixedCopy'] as const)(
  '[AC-QA-05c#21] 无模型表现缺少 %s 不算通过',
  (field) => {
    const observation = { ...DEGRADED };
    delete observation[field];
    expect(
      matchesDegradation(
        { key: 'agent.enabled', degradedValue: false, behaviour: 'no_model' },
        observation,
      ),
    ).toBe(false);
  },
);

it.each(['judgeCalled', 'cards', 'specPending', 'semanticPrecheckSkipped'] as const)(
  '[AC-QA-05c#22] Jev 降级缺少 %s 不算通过',
  (field) => {
    const observation: import('../../../../infra/drills/switches/drill.ts').Observation = {
      code: 0,
      judgeCalled: false,
      cards: true,
      specPending: true,
      semanticPrecheckSkipped: true,
    };
    const incomplete = { ...observation };
    delete incomplete[field];
    expect(
      matchesDegradation(
        { key: 'jev.enabled', degradedValue: false, behaviour: 'rules_only' },
        incomplete,
      ),
    ).toBe(false);
  },
);

it('[AC-QA-05c#38] 探针尚未返回时中断，不能无限等待它而放弃恢复', async () => {
  const f = fixture();
  const result = await runSwitchDrill({
    ...f.options,
    probe: async () => {
      if (f.rows.get('agent.enabled')?.value === false) {
        f.controller.abort('SIGTERM');
        return new Promise<never>(() => {});
      }
      return BASELINE;
    },
  });
  expect(result.ok).toBe(false);
  expect(result.restored).toContain('agent.enabled');
  expect(f.rows.get('agent.enabled')?.value).toBe(true);
});

it('[AC-QA-05c#39] 读取原值失败时不得写入猜测值', async () => {
  const f = fixture();
  f.hooks.beforeList = () => {
    throw new Error(`read denied ${TOKEN}`);
  };
  const result = await runSwitchDrill(f.options);
  expect(result.ok).toBe(false);
  expect(f.events.filter((event) => event.startsWith('write:'))).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(TOKEN);
});
