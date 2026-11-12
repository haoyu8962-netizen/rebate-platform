import { describe, expect, it, vi } from 'vitest';
import type { AgentCaller, RunBodyInput } from '../../http/index.ts';
import type { OrchestratorTrace } from '../../orchestrator/core/ports.ts';
import type { RunBodyResult, RunContext } from '../run/index.ts';
import type { CardInput } from '../writer/index.ts';
import { storedCard } from '../pg/reply.ts';
import { createRunTraceRecorder, toolCallRecords } from './trace.ts';
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

function trace(calls: OrchestratorTrace['tool_calls']): OrchestratorTrace {
  return {
    intent: null,
    model: null,
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
        },
        {
          seq: 2,
          name: 'explain_order',
          args: null,
          result_digest: null,
          status: 'rejected',
          latency_ms: null,
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
