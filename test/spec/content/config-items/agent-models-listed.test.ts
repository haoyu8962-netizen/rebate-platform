import { expect, it } from 'vitest';
import {
  configItemSpecOf,
  configRegistry,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import { switchSpecOf } from '../../../../apps/api/src/modules/content/domain/switch-registry.ts';

it('[AC-B3-09n#1] agent.models 在预算预占额与上下文轮数之间恰好列出一次', () => {
  const keys = configRegistry().map((entry) => entry.key);
  expect(keys.filter((key) => key === 'agent.models')).toHaveLength(1);

  const index = keys.indexOf('agent.models');
  expect(keys[index - 1]).toBe('agent.budget.reserve_mfen_per_run');
  expect(keys[index + 1]).toBe('agent.context.max_turns');
});

it('[AC-B3-09n#2] agent.models 列为可编辑的业务对象配置，与按键查询共用同一条目', () => {
  const listed = configRegistry().find((entry) => entry.key === 'agent.models');
  expect(listed).toStrictEqual({
    key: 'agent.models',
    valueType: 'object',
    options: null,
    permission: 'config.business',
    adminEditable: true,
  });
  expect(listed).toBe(configItemSpecOf('agent.models'));
  expect(switchSpecOf('agent.models')).toBeNull();
});
