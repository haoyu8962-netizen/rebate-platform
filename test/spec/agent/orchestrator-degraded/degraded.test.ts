import { expect, it, vi } from 'vitest';
import { createDegradedPath } from '../../../../apps/api/src/modules/agent/orchestrator/degraded/index.ts';
import type { DegradedPathDeps } from '../../../../apps/api/src/modules/agent/orchestrator/degraded/index.ts';
import type { DegradeReason } from '../../../../apps/api/src/modules/agent/model-gateway/degraded/index.ts';
import type { KeywordSearchOutcome } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { createAgentRunBody } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { createFrameValidator } from '../../../../apps/api/src/modules/agent/stream/writer/index.ts';
import { numberCard } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { context, input, notice, proceed, setup } from '../orchestrator-core/kit.ts';
import { syntheticProductList } from './product-fixture.ts';

// BR-AI-14 §无模型降级: expected plans/keys/results are literals, never planner output.
function fixture() {
  const output = context();
  const card = syntheticProductList();
  // Deliberately non-alphabetical so reordering enabled platforms fails the plan assertions.
  const enabledSearchPlatforms = vi.fn<DegradedPathDeps['tools']['enabledSearchPlatforms']>(
    async () => ['taobao', 'jd'],
  );
  const searchKeyword = vi.fn<DegradedPathDeps['tools']['searchKeyword']>(async () => ({
    results: [
      { platform: 'jd', ok: false },
      { platform: 'taobao', ok: true, items: [{ product_key: 'tb:synthetic-0' }] },
    ],
    cards: [card],
  }));
  const text = vi.fn<DegradedPathDeps['texts']['text']>(async (_appId, key) =>
    key === 'agent.degraded' ? '请查看搜索结果。' : '暂未找到相关商品。',
  );
  const errorMsg = vi.fn<DegradedPathDeps['errorMsg']>(async () => '合成搜索暂不可用');
  const deps: DegradedPathDeps = {
    tools: { enabledSearchPlatforms, searchKeyword },
    texts: { text },
    errorMsg,
  };
  return {
    ...output,
    card,
    deps,
    enabledSearchPlatforms,
    searchKeyword,
    text,
    errorMsg,
    request: { input: input(), proceed: proceed(), reason: 'models_failed' as DegradeReason },
  };
}

it('[AC-B3-05c#1][BR-AI-14] 只将模型形态剩余文本传入关键词计划，不还原长数字或抽取条件', async () => {
  const f = fixture();
  const path = createDegradedPath(f.deps);
  const request = {
    ...f.request,
    input: {
      ...input(),
      caller: { ...input().caller, appId: 'synthetic-other-app' },
      text: '合成987654321012345678 500ml 30元以内',
      context: { source: 'agent' },
    },
    proceed: proceed({
      modelText: '  ，合成<num_1> 500ml 30元以内！？ ',
      placeholders: { '<num_1>': '987654321012345678' },
      paramsRequested: true,
    }),
  };
  await path.run(request, f.ctx);
  expect(f.enabledSearchPlatforms).toHaveBeenCalledExactlyOnceWith('synthetic-other-app');
  expect(f.searchKeyword).toHaveBeenCalledExactlyOnceWith(
    { q: '合成 500ml 30元以内', platforms: ['taobao', 'jd'], sort: 'relevance' },
    {
      subject: request.input.caller,
      context: request.input.context,
      runId: f.ctx.runId,
      sessionId: f.ctx.sessionId,
      signal: f.ctx.signal,
      placeholders: request.proceed.placeholders,
    },
  );
  expect(JSON.stringify(f.searchKeyword.mock.calls[0]?.[0])).not.toContain('987654321012345678');
  // createDegradedPath is the keyword path (agent.degraded.route_intents off): no condition is
  // taken, but keeping placeholders out of q does not follow the switch (BR-AI-14 细则 开关).
  expect(JSON.stringify(f.searchKeyword.mock.calls[0]?.[0])).not.toContain('<num_');
  expect(f.searchKeyword.mock.calls[0]?.[0]).not.toHaveProperty('price_min_fen');
  expect(f.searchKeyword.mock.calls[0]?.[0]).not.toHaveProperty('price_max_fen');
  expect(f.text).toHaveBeenCalledWith('synthetic-other-app', 'agent.degraded');
  expect(f.events.filter((e) => e.kind === 'suggestions')).toEqual([]);
});

it('[AC-B3-05c#2][BR-AI-14] 接线使用默认三十字符计划，错误预填也使用截断后的 q', async () => {
  const f = fixture();
  const path = createDegradedPath(f.deps);
  f.searchKeyword.mockResolvedValue({
    results: [
      { platform: 'jd', ok: false },
      { platform: 'taobao', ok: false },
    ],
    cards: [],
  });
  const result = await path.run(
    { ...f.request, proceed: proceed({ modelText: '  ！abcdefghijklmnopqrstuvwxyzABCDEF。  ' }) },
    f.ctx,
  );
  expect(f.searchKeyword.mock.calls[0]?.[0]).toEqual({
    q: 'abcdefghijklmnopqrstuvwxyzABCD',
    platforms: ['taobao', 'jd'],
    sort: 'relevance',
  });
  expect(result).toMatchObject({
    kind: 'error',
    error: { code: 50302, fallback: 'search_page', fallback_q: 'abcdefghijklmnopqrstuvwxyzABCD' },
  });
});

it.each([
  ['models_failed', 'fallback'],
  ['model_timeout', 'fallback'],
  ['route_no_model', 'fallback'],
  ['budget', 'budget'],
] as const)(
  '[AC-B3-05c#3][BR-AI-14] %s：部分平台成功即出原始商品卡和固定文案，以 %s 结束',
  async (reason, finishReason) => {
    const f = fixture();
    const result = await createDegradedPath(f.deps).run({ ...f.request, reason }, f.ctx);
    expect(result).toEqual({ kind: 'done', finishReason });
    expect(f.events).toEqual([
      { kind: 'card', card: f.card },
      { kind: 'text', text: '请查看搜索结果。' },
    ]);
    expect(f.text).toHaveBeenCalledWith('synthetic-app', 'agent.degraded');
    expect(f.errorMsg).not.toHaveBeenCalled();
    expect(
      createFrameValidator()({
        event: 'card',
        id: 2,
        data: { ...numberCard(f.card, 1).card, seq: 2 },
      }),
    ).toEqual({ ok: true });
  },
);

it.each(['models_failed', 'budget'] as const)(
  '[AC-B3-05c#4][BR-AI-14] %s：有平台成功但为空，仅出 empty notice，无错误码',
  async (reason) => {
    const f = fixture();
    const path = createDegradedPath(f.deps);
    f.searchKeyword.mockResolvedValue({
      results: [
        { platform: 'jd', ok: false },
        { platform: 'taobao', ok: true, items: [] },
      ],
      cards: [],
    });
    const result = await path.run({ ...f.request, reason }, f.ctx);
    expect(result).toEqual({
      kind: 'done',
      finishReason: reason === 'budget' ? 'budget' : 'fallback',
    });
    expect(f.events).toEqual([{ kind: 'card', card: notice('暂未找到相关商品。') }]);
    expect(f.text).toHaveBeenCalledWith('synthetic-app', 'agent.degraded.empty');
    expect(f.errorMsg).not.toHaveBeenCalled();
  },
);

it.each(['no_platform', 'no_keyword'] as const)(
  '[AC-B3-05c#5][BR-AI-14] %s：不搜索，出 empty notice，保留 budget 完成原因',
  async (mode) => {
    const f = fixture();
    const path = createDegradedPath(f.deps);
    if (mode === 'no_platform') f.enabledSearchPlatforms.mockResolvedValue([]);
    const result = await path.run(
      {
        ...f.request,
        reason: 'budget',
        proceed: proceed({ modelText: mode === 'no_keyword' ? '  ，！？。\n' : '合成保温杯' }),
      },
      f.ctx,
    );
    if (mode === 'no_platform') {
      expect(result).toEqual({ kind: 'done', finishReason: 'budget' });
      expect(f.searchKeyword).not.toHaveBeenCalled();
      expect(f.events).toEqual([{ kind: 'card', card: notice('暂未找到相关商品。') }]);
      expect(f.errorMsg).not.toHaveBeenCalled();
      return;
    }
    // BR-AI-14 细则 ⑥: nothing left (punctuation only, no greeting) → no search, done stop,
    // agent.reply.empty with agent.suggest.empty.1–3; not agent.welcome, not agent.degraded.empty.
    expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(f.searchKeyword).not.toHaveBeenCalled();
    expect(f.text.mock.calls.map(([, key]) => key)).toEqual([
      'agent.reply.empty',
      'agent.suggest.empty.1',
      'agent.suggest.empty.2',
      'agent.suggest.empty.3',
    ]);
    expect(f.text).not.toHaveBeenCalledWith('synthetic-app', 'agent.welcome');
    expect(f.text).not.toHaveBeenCalledWith('synthetic-app', 'agent.degraded.empty');
    const shortcut = { text: '暂未找到相关商品。', send_text: '暂未找到相关商品。' };
    expect(f.events).toEqual([
      { kind: 'text', text: '暂未找到相关商品。' },
      { kind: 'suggestions', items: [shortcut, shortcut, shortcut] },
    ]);
    expect(f.events.filter((e) => e.kind === 'card')).toEqual([]);
    expect(f.errorMsg).not.toHaveBeenCalled();
  },
);

it('[AC-B3-05c#6][BR-AI-14] 全部已开启平台明确失败才返回契约合法的 50302 和 fallback_q，不出卡', async () => {
  const f = fixture();
  const path = createDegradedPath(f.deps);
  f.searchKeyword.mockResolvedValue({
    results: [
      { platform: 'jd', ok: false },
      { platform: 'taobao', ok: false },
    ],
    cards: [],
  });
  const result = await path.run(f.request, f.ctx);
  expect(result).toMatchObject({
    kind: 'error',
    error: {
      code: 50302,
      msg: '合成搜索暂不可用',
      fallback: 'search_page',
      fallback_q: '合成保温杯',
    },
  });
  expect(result.kind).toBe('error');
  if (result.kind !== 'error') throw new Error('unreachable after assertion');
  expect(createFrameValidator()({ event: 'error', id: 2, data: result.error })).toEqual({
    ok: true,
  });
  expect(f.events).toEqual([]);
  expect(f.errorMsg).toHaveBeenCalledExactlyOnceWith('synthetic-app', 50302);
});

it('[AC-B3-05c#7][BR-AI-14] 计划内平台结果缺失向核心抛错，不掩盖为空结果或全平台失败', async () => {
  const f = fixture();
  const path = createDegradedPath(f.deps);
  f.searchKeyword.mockResolvedValue({ results: [{ platform: 'jd', ok: false }], cards: [] });
  await expect(path.run(f.request, f.ctx)).rejects.toThrow(
    'Missing search result for an enabled platform',
  );
  expect(f.events).toEqual([]);
  expect(f.errorMsg).not.toHaveBeenCalled();
});

it('[AC-B3-05c#8][BR-AI-14] 进入时已经中止，不搜索也不输出', async () => {
  const f = fixture();
  const path = createDegradedPath(f.deps);
  f.controller.abort('cancelled');
  await path.run(f.request, f.ctx);
  expect(f.events).toEqual([]);
  expect(f.searchKeyword).not.toHaveBeenCalled();
  expect(f.text).not.toHaveBeenCalled();
});

it('[AC-B3-05c#9][BR-AI-14] 等待搜索时中止，晚到的商品卡和文字都不输出', async () => {
  const f = fixture();
  const path = createDegradedPath(f.deps);
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<KeywordSearchOutcome>();
  f.searchKeyword.mockImplementation(() => {
    started.resolve();
    return pending.promise;
  });
  const run = path.run(f.request, f.ctx);
  await started.promise;
  f.controller.abort('cancelled');
  pending.resolve({
    results: [
      { platform: 'jd', ok: true, items: [{}] },
      { platform: 'taobao', ok: false },
    ],
    cards: [f.card],
  });
  await run;
  expect(f.events).toEqual([]);
});

it('[AC-B3-05c#10][BR-AI-14] 固定文案读取中止后不再写文字或新增卡片', async () => {
  const f = fixture();
  const path = createDegradedPath(f.deps);
  let deliveredAtAbort = 0;
  f.text.mockImplementation(async () => {
    deliveredAtAbort = f.events.length;
    f.controller.abort('cancelled');
    return '不应输出的合成晚到文案';
  });
  await path.run(f.request, f.ctx);
  expect(f.text).toHaveBeenCalled();
  expect(f.events).toHaveLength(deliveredAtAbort);
  expect(f.events.filter((e) => e.kind === 'text')).toEqual([]);
});

it('[AC-B3-05c#11][BR-AI-14] 无模型核心实际接入降级路径，预处理 notice 不重复，且不调用模型', async () => {
  const f = fixture();
  const path = createDegradedPath(f.deps);
  const r = setup([], { proceed: proceed({ notices: [notice('合成预处理提示')] }) });
  const body = createAgentRunBody({
    ...r.deps,
    degraded: path,
    prompt: { current: async () => null },
  });
  expect(await body(input())(f.ctx)).toEqual({ kind: 'done', finishReason: 'fallback' });
  expect(f.events).toEqual([
    { kind: 'card', card: notice('合成预处理提示') },
    { kind: 'card', card: f.card },
    { kind: 'text', text: '请查看搜索结果。' },
  ]);
  expect(r.complete).not.toHaveBeenCalled();
});
