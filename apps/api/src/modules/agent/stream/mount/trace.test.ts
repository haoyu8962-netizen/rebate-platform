import { describe, expect, it, vi } from 'vitest';
import type { AgentCaller, RunBodyInput } from '../../http/index.ts';
import type { OrchestratorTrace } from '../../orchestrator/core/ports.ts';
import type { AgentTraceWriter } from '../../store/results/index.ts';
import type { RunBodyResult, RunContext } from '../run/index.ts';
import type { CardInput } from '../writer/index.ts';
import {
  TRACE_WRITE_FAILED,
  createRunTraceRecorder,
  storedCard,
  toolCallRecords,
} from './trace.ts';

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

function writer(impl?: Partial<AgentTraceWriter>) {
  return {
    recordCards: vi.fn<AgentTraceWriter['recordCards']>(impl?.recordCards ?? (async () => {})),
    recordToolCalls: vi.fn<AgentTraceWriter['recordToolCalls']>(
      impl?.recordToolCalls ?? (async () => {}),
    ),
  };
}

function flushed(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

const DONE: RunBodyResult = { kind: 'done', finishReason: 'stop' };

describe('createRunTraceRecorder', () => {
  it('[AC-B3-08q#1] 体结束后写出本 run 的卡与工具调用（seq 1..n，app / session / run 来自服务端上下文）', async () => {
    const w = writer();
    const logger = { warn: vi.fn() };
    const recorder = createRunTraceRecorder({ writer: w, logger });
    const body = recorder.body(input(), async () => {
      recorder.cardWritten(RUN, card('c1'));
      recorder.cardWritten(RUN, card('c2'));
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
    expect(w.recordCards).toHaveBeenCalledWith(APP, SESSION, RUN, [card('c1'), card('c2')]);
    expect(w.recordToolCalls).toHaveBeenCalledWith(APP, RUN, [
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
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('[AC-B3-08q#5] 写者挂起不拖住体的结果；两路写者都失败只记一条 warn（run_id），体结果不变', async () => {
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const w = writer({
      recordCards: async () => {
        await held;
        throw new Error('合成失败');
      },
      recordToolCalls: () => {
        throw new Error('同步抛错');
      },
    });
    const logger = { warn: vi.fn() };
    const recorder = createRunTraceRecorder({ writer: w, logger });
    const body = recorder.body(input(), async () => {
      recorder.cardWritten(RUN, card('c1'));
      recorder.sink.record(RUN, trace([{ name: 'search_rules', args: {}, status: 'ok' }]));
      return DONE;
    });
    expect(await body(context())).toEqual(DONE);
    await flushed();
    expect(logger.warn).not.toHaveBeenCalled();
    open();
    await flushed();
    await flushed();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { run_id: RUN, error_name: 'Error' },
      TRACE_WRITE_FAILED,
    );
  });

  it('[AC-B3-08q#3] 体抛错也写已下发的卡；体结束后到达的卡与别的 run 的卡不记', async () => {
    const w = writer();
    const recorder = createRunTraceRecorder({ writer: w, logger: { warn: vi.fn() } });
    const body = recorder.body(input(), async () => {
      recorder.cardWritten(RUN, card('c1'));
      recorder.cardWritten('0192f3a1-7c00-7000-8000-00000000b999', card('c2'));
      throw new Error('合成体错误');
    });
    await expect(body(context())).rejects.toThrow('合成体错误');
    recorder.cardWritten(RUN, card('c3'));
    await flushed();
    expect(w.recordCards).toHaveBeenCalledTimes(1);
    expect(w.recordCards).toHaveBeenCalledWith(APP, SESSION, RUN, [card('c1')]);
    expect(w.recordToolCalls).not.toHaveBeenCalled();
  });

  it('[AC-B3-08q#5] 无卡无调用的 run 不调写者', async () => {
    const w = writer();
    const recorder = createRunTraceRecorder({ writer: w, logger: { warn: vi.fn() } });
    await recorder.body(input(), async () => DONE)(context());
    await flushed();
    expect(w.recordCards).not.toHaveBeenCalled();
    expect(w.recordToolCalls).not.toHaveBeenCalled();
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

it('[AC-B3-08q#1][BR-AI-19] storedCard：earnings_summary 只存 as_of 与 actions（不存金额副本），其余卡原样', () => {
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
