import { expect, it } from 'vitest';

import { parseModelPrices } from '../../../../apps/api/src/modules/agent/budget/index.ts';
import type { RunCallBudget } from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import { FLASH, PLUS, chatInput, ctx, fail, ok, resolved, setup } from '../model-routing/kit.ts';

function budget(): RunCallBudget {
  const price = { in_mfen_per_m: 100_000, out_mfen_per_m: 400_000, version: 'synthetic-v1' };
  return {
    reserveMfen: 5_000n,
    spentMfen: 0n,
    calls: 0,
    prices: parseModelPrices({ [FLASH]: price, [PLUS]: price }),
  };
}

it.each(['timeout', 'server', 'rate_limited', 'malformed'] as const)(
  '[AC-B3-09m#42] 主模型请求发出后以 %s 失败且没有用量，按最坏成本计并阻止备用调用',
  async (kind) => {
    const rig = setup({ steps: { [FLASH]: [fail(kind)], [PLUS]: [ok(20, 10)] } });
    const run = budget();
    const outcome = await rig.router().complete(chatInput(), { ...ctx(), budget: run });
    expect(outcome).toMatchObject({ kind: 'degraded', reason: 'budget' });
    expect(rig.transport.calls.map((call) => call.model)).toEqual([FLASH]);
    // 无配置上限时，示例输出单价和向上取整使这次请求的 W 恰好用完预占额。
    expect(run).toMatchObject({ spentMfen: 5_000n, calls: 1 });
  },
);

it('[AC-B3-09m#43] 厂商失败响应带用量时按回报的用量记成本', async () => {
  const rig = setup({
    route: () => resolved('flash'),
    steps: { [FLASH]: [fail('server', { input_tokens: 20, output_tokens: 10 })] },
  });
  const run = budget();
  const outcome = await rig.router().complete(chatInput(), { ...ctx(), budget: run });
  expect(outcome).toMatchObject({ kind: 'degraded', reason: 'models_failed' });
  expect(rig.transport.calls.map((call) => call.model)).toEqual([FLASH]);
  expect(run).toMatchObject({ spentMfen: 6n, calls: 1 });
});

it('[AC-B3-09m#47] 主模型挂起至单次调用超时，按最坏成本计并阻止备用调用', async () => {
  const attemptTimeoutMs = 3_000;
  const rig = setup({
    attemptTimeoutMs,
    steps: { [FLASH]: [{ t: 'hang' }], [PLUS]: [ok(20, 10)] },
  });
  const run = budget();
  const [outcome] = await Promise.all([
    rig.router().complete(chatInput(), { ...ctx(), budget: run }),
    rig.scheduler.advance(attemptTimeoutMs + 1),
  ]);

  expect(rig.transport.calls.map((call) => call.model)).toEqual([FLASH]);
  expect(outcome).toMatchObject({ kind: 'degraded', reason: 'budget' });
  expect(run).toMatchObject({ spentMfen: 5_000n, calls: 1 });
});
