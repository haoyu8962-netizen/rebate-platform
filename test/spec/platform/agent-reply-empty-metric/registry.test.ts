// BR-AI-01 不空回复计数的抓取出口；不重测 B3-05o 的回复判定与文案。
import { expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import { assertCounter, METRIC } from './kit.ts';

it('[AC-B1-01zzv#1] stream 输出无标签 counter，包含 0；每次抓取读取当前累计值', async () => {
  let total = 0;
  const collectAgentReplyEmpty = vi.fn(() => total);
  const registry = createMetricsRegistry({ entry: 'stream', collectAgentReplyEmpty });
  for (const next of [0, 1, 7, 7, 1024]) {
    total = next;
    const before = collectAgentReplyEmpty.mock.calls.length;
    assertCounter(await registry.render(), next);
    expect(collectAgentReplyEmpty).toHaveBeenCalledTimes(before + 1);
  }
});

it('[AC-B1-01zzv#2] 同一回调只在 stream 生效；其他四个入口不调用、不输出；缺回调时不冒充零', async () => {
  const collectAgentReplyEmpty = vi.fn(() => 3);
  // Positive control: prevents an implementation that omits the metric everywhere from passing.
  assertCounter(
    await createMetricsRegistry({ entry: 'stream', collectAgentReplyEmpty }).render(),
    3,
  );
  collectAgentReplyEmpty.mockClear();
  for (const entry of ['api', 'admin', 'worker', 'payout'] as const) {
    const text = await createMetricsRegistry({ entry, collectAgentReplyEmpty }).render();
    expect(text, entry).not.toContain(METRIC);
  }
  expect(collectAgentReplyEmpty).not.toHaveBeenCalled();
  expect(await createMetricsRegistry({ entry: 'stream' }).render()).not.toContain(METRIC);
});
