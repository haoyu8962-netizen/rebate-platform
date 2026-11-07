// B3-08n · BR-AI-07 (gate review S2-a of B3-08m): the template rule applies only to a run that
// called search_rules or an order tool. A run that is merely offered those tools but only calls
// search_products delivers its model text exactly as a run without them on offer (same deltas,
// same finish reason, no template text, no replaced flag), at each of the three ends that could
// have been confused with a template run: the round limit, the tool call budget, and the router
// degrading after a search_products call without cards (with text already answered: done stop;
// without any text: the degraded path, as before).
import { expect, it } from 'vitest';
import type { AgentRunBodyDeps } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import {
  PRODUCTS_ONLY,
  TEMPLATE_OFFER,
  expectReplaced,
  productTools,
  rig,
  type RunView,
  type Step,
} from './kit.ts';

const PRODUCTS = { name: 'search_products', args: { q: '保温杯' } } as const;
const TEMPLATE_KEYS = ['agent.rule.', 'order_list.', 'order_status.', 'order_reason.'];

const LIMITS: AgentRunBodyDeps['limits'] = {
  toolCalls: 4,
  modelRounds: 3,
  textCodePoints: 20_000,
  cards: 12,
  contentFrames: 400,
};

/** search_products answering ok without cards. */
const noCards = () => ({ kind: 'ok' as const, modelView: { items: [] }, cards: [] });

/** The same script once with the template tools offered, once with search_products only. */
async function both(
  steps: readonly Step[],
  limits: Partial<AgentRunBodyDeps['limits']>,
  products?: typeof noCards,
) {
  const patch = { limits: { ...LIMITS, ...limits } };
  const offered = productTools(TEMPLATE_OFFER, products);
  const plain = productTools(PRODUCTS_ONLY, products);
  const withTemplates = rig({ steps, tools: offered.tools, patch });
  const baseline = rig({ steps, tools: plain.tools, patch });
  return {
    offered: { ...withTemplates, execute: offered.execute, view: await withTemplates.run() },
    baseline: { ...baseline, execute: plain.execute, view: await baseline.run() },
  };
}

function expectNoTemplate(view: RunView): void {
  for (const key of TEMPLATE_KEYS) expect(view.text, `template ${key}`).not.toContain(key);
  expectReplaced(view, false);
}

it('[AC-B3-08n#3.1][BR-AI-07] 提供模板工具但只调 search_products，最后一轮仍要工具（轮数上限）→ 模型文本逐字照发、done limit，与不提供模板工具的 run 相同', async () => {
  const x = await both(
    [
      { text: '甲。', calls: [PRODUCTS] },
      { text: '乙。', calls: [PRODUCTS] },
    ],
    { modelRounds: 2 },
  );
  expect(x.offered.view.result).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(x.offered.view.text).toBe('甲。乙。');
  expect(x.offered.execute).toHaveBeenCalledTimes(1);
  expect(x.offered.degraded).not.toHaveBeenCalled();
  expectNoTemplate(x.offered.view);
  expect(x.offered.view.result).toEqual(x.baseline.view.result);
  expect(x.offered.view.text).toBe(x.baseline.view.text);
});

it('[AC-B3-08n#3.2][BR-AI-07] 提供模板工具但只调 search_products，工具调用次数用尽（工具调用上限）→ 模型文本逐字照发、done limit，与不提供模板工具的 run 相同', async () => {
  const x = await both([{ text: '甲。', calls: [PRODUCTS, PRODUCTS] }], { toolCalls: 1 });
  expect(x.offered.view.result).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(x.offered.execute).toHaveBeenCalledTimes(1);
  expect(x.offered.view.text).toBe('甲。');
  expect(x.offered.degraded).not.toHaveBeenCalled();
  expectNoTemplate(x.offered.view);
  expect(x.offered.view.result).toEqual(x.baseline.view.result);
  expect(x.offered.view.text).toBe(x.baseline.view.text);
});

it('[AC-B3-08n#3.3][BR-AI-07] 提供模板工具但只调 search_products 且无卡，下一轮路由降级：已有文本 → 文本照发、done stop、不走降级；无文本 → 照旧走降级路径（fallback），均与不提供模板工具的 run 相同', async () => {
  const answered = await both(
    [{ text: '甲。', calls: [PRODUCTS] }, { degraded: 'models_failed' }],
    {},
    noCards,
  );
  expect(answered.offered.view.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(answered.offered.view.text).toBe('甲。');
  expect(answered.offered.view.frames).toEqual([]);
  expect(answered.offered.degraded).not.toHaveBeenCalled();
  expectNoTemplate(answered.offered.view);
  expect(answered.offered.view.result).toEqual(answered.baseline.view.result);
  expect(answered.offered.view.text).toBe(answered.baseline.view.text);
  expect(answered.baseline.degraded).not.toHaveBeenCalled();

  const silent = await both([{ calls: [PRODUCTS] }, { degraded: 'models_failed' }], {}, noCards);
  expect(silent.offered.view.result).toEqual({ kind: 'done', finishReason: 'fallback' });
  expect(silent.offered.degraded).toHaveBeenCalledTimes(1);
  expect(silent.offered.degraded.mock.calls[0]?.[0].reason).toBe('models_failed');
  expect(silent.offered.view.text).toBe('');
  expectNoTemplate(silent.offered.view);
  expect(silent.offered.view.result).toEqual(silent.baseline.view.result);
  expect(silent.baseline.degraded).toHaveBeenCalledTimes(1);
});
