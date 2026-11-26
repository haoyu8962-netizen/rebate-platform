import { expect, it } from 'vitest';

import type {
  RouterChatInput,
  RunCallBudget,
} from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import { FLASH, PLUS, chatInput, ctx, fail, ok, setup } from '../model-routing/kit.ts';

function budget(): RunCallBudget {
  const price = { inMfenPerM: 100_000n, outMfenPerM: 400_000n, version: 'synthetic-v1' };
  return {
    reserveMfen: 5_000n,
    spentMfen: 0n,
    calls: 0,
    prices: {
      priceOf: () => price,
    },
  };
}

it('[AC-B3-09m#33] 含图片或音频的厂商请求不发出', async () => {
  const nonText = [
    { type: 'image_url', image_url: { url: 'synthetic-image' } },
    { type: 'input_audio', input_audio: { data: 'synthetic-audio' } },
  ];
  for (const part of nonText) {
    const rig = setup({ steps: { [FLASH]: [ok(20, 10)] } });
    // 从厂商请求的输入边界注入非文本内容。
    const content = [{ type: 'text', text: '保温杯' }, part];
    const messages = [{ role: 'user', content }] as unknown as RouterChatInput['messages'];
    const run = budget();
    const input = { ...chatInput(), messages };
    const outcome = await rig.router().complete(input, { ...ctx(), budget: run });
    expect(outcome).toMatchObject({ kind: 'degraded', reason: 'budget' });
    expect(rig.transport.calls).toEqual([]);
    expect(run).toMatchObject({ spentMfen: 0n, calls: 0 });
  }
});

it('[AC-B3-09m#34] 已发出但用量不明按最坏成本计，备用尝试也受同一 run 的余额限制', async () => {
  const rig = setup({ steps: { [FLASH]: [fail('network')], [PLUS]: [ok(20, 10)] } });
  const run = budget();
  const outcome = await rig.router().complete(chatInput(), { ...ctx(), budget: run });
  expect(outcome).toMatchObject({ kind: 'degraded', reason: 'budget' });
  expect(rig.transport.calls.map((call) => call.model)).toEqual([FLASH]);
  expect(run).toMatchObject({ spentMfen: 5_000n, calls: 1 });
});

it('[AC-B3-09m#35] 厂商请求实际携带较低的配置上限，已知用量按实际累加', async () => {
  const rig = setup({ steps: { [FLASH]: [ok(20, 10)] } });
  const run = budget();
  const input = { ...chatInput(), sampling: { max_tokens: 512 } };
  expect(await rig.router().complete(input, { ...ctx(), budget: run })).toMatchObject({
    kind: 'model',
  });
  expect(rig.transport.calls.map((call) => call.body)).toEqual([
    expect.objectContaining({ max_tokens: 512 }),
  ]);
  expect(run).toMatchObject({ spentMfen: 6n, calls: 1 });
});
