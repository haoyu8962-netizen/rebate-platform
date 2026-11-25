import { expect, it } from 'vitest';

import {
  parseBudgetConfig,
  parseModelPrices,
} from '../../../../apps/api/src/modules/agent/budget/index.ts';
import {
  configItemSpecOf,
  configRegistry,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';

it('[AC-B3-09m#5] 缺省日预算和预占分别为 100,000 分和 5,000 mfen', () => {
  expect(parseBudgetConfig({ dailyBudgetFen: undefined, reserveMfenPerRun: undefined })).toEqual({
    budgetMfen: 100_000_000n,
    reserveMfen: 5_000n,
    invalid: [],
  });
  expect(parseBudgetConfig({ dailyBudgetFen: 23, reserveMfenPerRun: 567 })).toEqual({
    budgetMfen: 23_000n,
    reserveMfen: 567n,
    invalid: [],
  });
});

it('[AC-B3-09m#6] 配置为 0 时原样保留', () => {
  expect(parseBudgetConfig({ dailyBudgetFen: 0, reserveMfenPerRun: 0 })).toEqual({
    budgetMfen: 0n,
    reserveMfen: 0n,
    invalid: [],
  });
});

it.each([-1, 0.5, '5000', Number.NaN, Infinity])(
  '[AC-B3-09m#7] 非法配置 %s 回落到缺省并报出对应的配置键',
  (invalid) => {
    expect(parseBudgetConfig({ dailyBudgetFen: invalid, reserveMfenPerRun: 11 })).toEqual({
      budgetMfen: 100_000_000n,
      reserveMfen: 11n,
      invalid: ['daily_budget_fen'],
    });
    expect(parseBudgetConfig({ dailyBudgetFen: 11, reserveMfenPerRun: invalid })).toEqual({
      budgetMfen: 11_000n,
      reserveMfen: 5_000n,
      invalid: ['reserve_mfen_per_run'],
    });
  },
);

it('[AC-B3-09m#8] 只读出输入、输出正整数单价和非空版本齐备的模型', () => {
  const entry = { in_mfen_per_m: 100_000, out_mfen_per_m: 400_000, version: 'synthetic-v1' };
  const prices = parseModelPrices({
    good: entry,
    missingInput: { out_mfen_per_m: 1, version: 'v1' },
    missingOutput: { in_mfen_per_m: 1, version: 'v1' },
    missingVersion: { in_mfen_per_m: 1, out_mfen_per_m: 1 },
    zero: { ...entry, in_mfen_per_m: 0 },
    negative: { ...entry, out_mfen_per_m: -1 },
    fraction: { ...entry, out_mfen_per_m: 0.5 },
    string: { ...entry, in_mfen_per_m: '100000' },
    emptyVersion: { ...entry, version: '' },
    invalidVersion: { ...entry, version: 1 },
  });
  expect(prices.priceOf('good')).toEqual({
    inMfenPerM: 100_000n,
    outMfenPerM: 400_000n,
    version: 'synthetic-v1',
  });
  for (const id of [
    'missingInput',
    'missingOutput',
    'missingVersion',
    'zero',
    'negative',
    'fraction',
    'string',
    'emptyVersion',
    'invalidVersion',
    'absent',
  ]) {
    expect(prices.priceOf(id), id).toBeUndefined();
  }
});

it('[AC-B3-09m#9] 缺省或非法的整张价格表视为无单价', () => {
  for (const raw of [undefined, null, 1, 'prices', []]) {
    expect(parseModelPrices(raw).priceOf('qwen-flash-2026-09-01')).toBeUndefined();
  }
});

it('[AC-B3-09m#36] agent.models 按键登记为对象配置', () => {
  expect(configItemSpecOf('agent.models')).toMatchObject({
    key: 'agent.models',
    valueType: 'object',
  });
  expect(configRegistry().map((entry) => entry.key)).not.toContain('agent.models');
});
