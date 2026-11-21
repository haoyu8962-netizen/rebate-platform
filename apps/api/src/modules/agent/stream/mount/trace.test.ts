import { describe, expect, it, vi } from 'vitest';
import type { AgentCaller, RunBodyInput } from '../../http/index.ts';
import type { OrchestratorTrace } from '../../orchestrator/core/ports.ts';
import type { RunBodyResult, RunContext } from '../run/index.ts';
import type { CardInput } from '../writer/index.ts';
import { storedCard } from '../pg/reply.ts';
import type { IntentTrace } from '../../orchestrator/intents/index.ts';
import {
  createRunTraceRecorder,
  initiatedCalls,
  recordIntentVerdict,
  toolCallRecords,
} from './trace.ts';
import type { TraceRedoQueue } from './trace-retry.ts';

const APP = 'synthetic-app';
const SESSION = '0192f3a1-7c00-7000-8000-00000000a001';
const RUN = '0192f3a1-7c00-7000-8000-00000000b001';

function input(): RunBodyInput {
  const caller = { appId: APP } as AgentCaller;
  return { caller, sessionId: SESSION, runId: RUN } as RunBodyInput;
}

function context(): RunContext {
  return { runId: RUN, sessionId: SESSION } as RunContext;
}

function card(cardId: string): CardInput {
  return {
    card_id: cardId,
    type: 'notice',
    schema_version: 1,
    data: { level: 'info', text_key: 'k', actions: [] },
    fallback_text: '合成',
  };
}

function trace(
  calls: OrchestratorTrace['tool_calls'],
  model: string | null = 'synthetic-model',
): OrchestratorTrace {
  return {
    intent: null,
    model,
    attempts: [],
    prompt_version: 'none',
    tool_calls: calls,
    output_filtered: false,
    filter_hits: [],
    output_truncated: false,
    model_format_invalid: false,
  };
}

function queue(impl?: TraceRedoQueue['persist']) {
  return { persist: vi.fn<TraceRedoQueue['persist']>(impl ?? (async () => {})) };
}

function flushed(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

const DONE: RunBodyResult = { kind: 'done', finishReason: 'stop' };

describe('createRunTraceRecorder', () => {
  it('[AC-B3-08q#1][AC-B3-08zc#1] 体结束后把本 run 的工具调用（seq 1..n，app / session / run 来自服务端上下文）交给队列，卡片不经留痕（cards 为空）', async () => {
    const q = queue();
    const recorder = createRunTraceRecorder({ queue: q });
    const body = recorder.body(input(), async () => {
      recorder.sink.record(
        RUN,
        trace([
          { name: 'search_products', args: { q: '合成' }, status: 'ok' },
          { name: 'explain_order', args: null, status: 'rejected' },
        ]),
      );
      return DONE;
    });
    expect(await body(context())).toEqual(DONE);
    await flushed();
    expect(q.persist).toHaveBeenCalledTimes(1);
    expect(q.persist).toHaveBeenCalledWith({
      appId: APP,
      sessionId: SESSION,
      runId: RUN,
      cards: [],
      toolCalls: [
        {
          seq: 1,
          name: 'search_products',
          args: { q: '合成' },
          result_digest: null,
          status: 'ok',
          latency_ms: null,
          initiator: 'model',
        },
        {
          seq: 2,
          name: 'explain_order',
          args: null,
          result_digest: null,
          status: 'rejected',
          latency_ms: null,
          initiator: 'model',
        },
      ],
    });
  });

  it('[AC-B3-08q#5][AC-B3-08y#8] 队列挂起或拒绝都不拖住、不改变体的结果', async () => {
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const q = queue(async () => {
      await held;
      throw new Error('合成失败');
    });
    const recorder = createRunTraceRecorder({ queue: q });
    const body = recorder.body(input(), async () => {
      recorder.sink.record(RUN, trace([{ name: 'search_products', args: {}, status: 'ok' }]));
      return DONE;
    });
    expect(await body(context())).toEqual(DONE);
    expect(q.persist).toHaveBeenCalledTimes(1);
    open();
    await flushed();
    expect(q.persist).toHaveBeenCalledTimes(1);
  });

  it('[AC-B3-08q#3] 体抛错也交出已记的工具调用；体结束后到达的与别的 run 的不记', async () => {
    const q = queue();
    const recorder = createRunTraceRecorder({ queue: q });
    const body = recorder.body(input(), async () => {
      recorder.sink.record(RUN, trace([{ name: 'search_products', args: {}, status: 'ok' }]));
      recorder.sink.record(
        '0192f3a1-7c00-7000-8000-00000000b999',
        trace([{ name: 'explain_order', args: {}, status: 'ok' }]),
      );
      throw new Error('合成体错误');
    });
    await expect(body(context())).rejects.toThrow('合成体错误');
    recorder.sink.record(RUN, trace([{ name: 'list_my_orders', args: {}, status: 'ok' }]));
    await flushed();
    expect(q.persist).toHaveBeenCalledTimes(1);
    expect(q.persist.mock.calls[0]?.[0]).toMatchObject({
      cards: [],
      toolCalls: [{ seq: 1, name: 'search_products' }],
    });
  });

  it('[AC-B3-08q#5] 无工具调用的 run 不交给队列', async () => {
    const q = queue();
    const recorder = createRunTraceRecorder({ queue: q });
    await recorder.body(input(), async () => DONE)(context());
    await flushed();
    expect(q.persist).not.toHaveBeenCalled();
  });
});

it('[AC-B3-08q#1] toolCallRecords：非对象参数（traceMask 失败为 null、数组）存 null', () => {
  expect(
    toolCallRecords([
      { name: 'a', args: ['x'], status: 'failed' },
      { name: 'b', args: 'x', status: 'ok' },
    ]).map((record) => [record.seq, record.args]),
  ).toEqual([
    [1, null],
    [2, null],
  ]);
});

it('[AC-B3-05p#1] toolCallRecords：服务端代调记 initiator server，其余（含没有标记的）记 model', () => {
  expect(
    toolCallRecords([
      { name: 'search_products', args: { q: '合成' }, status: 'ok' },
      { name: 'handoff_to_human', args: {}, status: 'ok', initiator: 'server' },
      { name: 'get_rebate_quote', args: { link_index: 1 }, status: 'failed', initiator: 'server' },
    ]).map((record) => [record.seq, record.name, record.initiator]),
  ).toEqual([
    [1, 'search_products', 'model'],
    [2, 'handoff_to_human', 'server'],
    [3, 'get_rebate_quote', 'server'],
  ]);
});

it('[AC-B3-05p#9] initiatedCalls：没有模型答过的 run（确定性链接路径）每个调用记 server；模型答过的保留核心自己的标记', () => {
  const quote = { name: 'get_rebate_quote', args: { link_index: 1 }, status: 'ok' } as const;
  const calls: OrchestratorTrace['tool_calls'] = [
    quote,
    { name: 'handoff_to_human', args: {}, status: 'ok', initiator: 'server' },
  ];
  expect(toolCallRecords(initiatedCalls(trace(calls, null))).map((r) => r.initiator)).toEqual([
    'server',
    'server',
  ]);
  expect(toolCallRecords(initiatedCalls(trace(calls))).map((r) => r.initiator)).toEqual([
    'model',
    'server',
  ]);
  // The core's own entries are never changed.
  expect(calls[0]).toEqual(quote);
});

it('[AC-B3-05p#9] 记录器：没有模型答过的 run 交给队列的工具调用记 server', async () => {
  const q = queue();
  const recorder = createRunTraceRecorder({ queue: q });
  await recorder.body(input(), async () => {
    recorder.sink.record(
      RUN,
      trace([{ name: 'get_rebate_quote', args: { link_index: 1 }, status: 'ok' }], null),
    );
    return DONE;
  })(context());
  await flushed();
  expect(q.persist.mock.calls[0]?.[0].toolCalls).toEqual([
    {
      seq: 1,
      name: 'get_rebate_quote',
      args: { link_index: 1 },
      result_digest: null,
      status: 'ok',
      latency_ms: null,
      initiator: 'server',
    },
  ]);
});

it('[AC-B3-08q#1][AC-B3-08zc#1][BR-AI-19] storedCard（随终态写库）：earnings_summary 只存 as_of 与 actions（不存金额副本），其余卡原样', () => {
  const earnings: CardInput = {
    card_id: 'c1',
    type: 'earnings_summary',
    schema_version: 1,
    data: { as_of: '2026-10-01T00:00:00+08:00', actions: [], withdrawable_fen: 100 },
    fallback_text: '合成',
  };
  expect(storedCard(earnings).data).toEqual({ as_of: '2026-10-01T00:00:00+08:00', actions: [] });
  const notice = card('c2');
  expect(storedCard(notice)).toBe(notice);
});

it('[AC-B3-08t#5][AC-B3-08t#10] 记录器（runFields）：终态取意图、输入通过与模型使用，留痕带耗时、用量与过滤', async () => {
  const q = queue();
  let now = 1_000;
  const clock = { now: () => new Date(now) };
  const recorder = createRunTraceRecorder({ queue: q, runFields: { clock } as never });
  const texts: string[] = [];
  const ctx = { ...context(), text: (delta: string) => texts.push(delta) } as unknown as RunContext;
  const body = recorder.body(input(), async (inner) => {
    recorder.inputPassed(RUN);
    now += 137;
    inner.text('合成');
    now += 284;
    recorder.sink.record(RUN, {
      ...trace([{ name: 'search_products', args: { q: '合成' }, status: 'ok' }], 'synthetic-plus'),
      usage: { input_tokens: 32, output_tokens: 18 },
      filter_hits: ['url', 'amount', 'url'],
      output_filtered: true,
      output_truncated: true,
    });
    return DONE;
  });
  expect(await body(ctx)).toEqual(DONE);
  expect(texts).toEqual(['合成']);
  expect(recorder.settleFields(RUN)).toEqual({
    intent: 'search',
    inputPassed: true,
    modelUsed: true,
  });
  // Taken once: a second settle gets nothing.
  expect(recorder.settleFields(RUN)).toBeUndefined();
  await flushed();
  expect(q.persist.mock.calls[0]?.[0].runFields).toEqual({
    model: 'synthetic-plus',
    input_tokens: 32,
    output_tokens: 18,
    ttft_ms: 137,
    latency_ms: 421,
    filter_hits: ['url', 'amount'],
    output_truncated: true,
    page_guide_reject_reason: null,
  });
});

it('[AC-B3-08t#6] 记录器（runFields）：降级结果不记模型；核心未留痕时模型使用未知', async () => {
  const q = queue();
  const clock = { now: () => new Date(0) };
  const recorder = createRunTraceRecorder({
    queue: q,
    runFields: { clock } as never,
  });
  const degraded = recorder.body(input(), async () => {
    recorder.sink.record(RUN, { ...trace([], 'synthetic-plus'), degraded: true });
    return DONE;
  });
  await degraded({ ...context(), text: () => undefined } as unknown as RunContext);
  expect(recorder.settleFields(RUN)).toEqual({
    intent: null,
    inputPassed: false,
    modelUsed: false,
  });
  await flushed();
  expect(q.persist.mock.calls[0]?.[0].runFields?.model).toBeNull();

  let release!: () => void;
  const pending = recorder.body(
    input(),
    () => new Promise((resolve) => (release = () => resolve(DONE))),
  );
  const running = pending({ ...context(), text: () => undefined } as unknown as RunContext);
  recorder.inputPassed(RUN);
  expect(recorder.settleFields(RUN)).toEqual({ intent: null, inputPassed: true, modelUsed: null });
  release();
  await running;
});

it('[AC-B3-08t#5][AC-B3-08t#10] 记录器（runFields）：无模型分流的页面引导拒绝原因随留痕写入', async () => {
  const q = queue();
  const recorder = createRunTraceRecorder({
    queue: q,
    runFields: { clock: { now: () => new Date(0) } } as never,
  });
  const body = recorder.body(input(), async () => {
    recorder.inputPassed(RUN);
    recorder.sink.record(RUN, {
      ...trace([], null),
      intent: 'page_guide',
      degraded: true,
      page_guide_reject_reason: 'disabled',
    });
    return DONE;
  });
  await body({ ...context(), text: () => undefined } as unknown as RunContext);
  expect(recorder.settleFields(RUN)).toEqual({
    intent: 'page_guide',
    inputPassed: true,
    modelUsed: false,
  });
  await flushed();
  expect(q.persist.mock.calls[0]?.[0].runFields).toMatchObject({
    model: null,
    page_guide_reject_reason: 'disabled',
  });
});

it('[AC-B3-08t#3][AC-B3-08t#6] 记录器（runFields）：商品情境入口的意图优先于后续文字处理，引导拒绝原因照写', async () => {
  const q = queue();
  const recorder = createRunTraceRecorder({
    queue: q,
    runFields: { clock: { now: () => new Date(0) } } as never,
  });
  const body = recorder.body(input(), async (inner) => {
    recorder.inputPassed(RUN);
    // The intent port's verdict on the entry run's text (钱包在哪 with the guide disabled).
    recordIntentVerdict(APP, RUN, {
      intent: 'page_guide',
      page_guide_reject_reason: 'disabled',
    } as IntentTrace);
    inner.text('合成');
    recorder.sink.record(RUN, {
      ...trace([{ name: 'get_rebate_quote', args: null, status: 'ok' }]),
      intent: 'page_guide',
      entry_intent: 'find_by_link',
    });
    return DONE;
  });
  await body({ ...context(), text: () => undefined } as unknown as RunContext);
  expect(recorder.settleFields(RUN)).toEqual({
    intent: 'find_by_link',
    inputPassed: true,
    modelUsed: true,
  });
  await flushed();
  expect(q.persist.mock.calls[0]?.[0].runFields?.page_guide_reject_reason).toBe('disabled');
});

it('[AC-B3-08t#1][AC-B3-08t#2] 记录器（runFields）：模板轮次未经意图端口核对的模型标签不落库，按首个工具推断', async () => {
  const recorder = createRunTraceRecorder({
    queue: queue(),
    runFields: { clock: { now: () => new Date(0) } } as never,
  });
  const body = recorder.body(input(), async () => {
    recorder.sink.record(RUN, {
      ...trace([{ name: 'list_my_orders', args: null, status: 'ok' }]),
      intent: 'earnings_query',
      intent_unchecked: true,
    });
    return DONE;
  });
  await body({ ...context(), text: () => undefined } as unknown as RunContext);
  expect(recorder.settleFields(RUN)?.intent).toBe('order_query');
});
