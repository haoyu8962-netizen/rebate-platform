// B3-05p ① · BR-AI-01 细则「意图兜底与不空回复」: a server-initiated call is traced「照常留痕（标明由
// 服务端发起）」; BR-AI-19: tool calls go to app.agent_tool_calls. The run trace's tool calls become
// agent_tool_calls records through stream/mount/trace.ts toolCallRecords; each record carries
// `initiator`, the value of the column of the same name (migration 0139, D10-1380): 'server' for a
// call the core made on the server's own initiative (OrchestratorTrace tool_calls[].initiator =
// 'server'), 'model' for every other call. Nothing else of the record changes.
import { expect, it } from 'vitest';
import type { OrchestratorTrace } from '../../../../apps/api/src/modules/agent/orchestrator/core/ports.ts';
import { toolCallRecords } from '../../../../apps/api/src/modules/agent/stream/mount/trace.ts';

type TracedCalls = OrchestratorTrace['tool_calls'];

const MODEL_CALL = { name: 'search_products', args: { q: '合成保温杯' }, status: 'ok' } as const;
const SERVER_CALL = {
  name: 'handoff_to_human',
  args: {},
  status: 'ok',
  initiator: 'server',
} as const;

it('[AC-B3-05p#1] 留痕记录带 initiator：模型自己调的记 model，服务端代调的记 server；seq、名称、参数、状态不变', () => {
  const calls: TracedCalls = [MODEL_CALL, SERVER_CALL];
  expect(toolCallRecords(calls)).toEqual([
    {
      seq: 1,
      name: 'search_products',
      args: { q: '合成保温杯' },
      result_digest: null,
      status: 'ok',
      latency_ms: null,
      initiator: 'model',
    },
    {
      seq: 2,
      name: 'handoff_to_human',
      args: {},
      result_digest: null,
      status: 'ok',
      latency_ms: null,
      initiator: 'server',
    },
  ]);
});

it('[AC-B3-05p#2] 服务端代调排在模型调用之前、之间或失败时同样记 server；没有标记的调用一律记 model', () => {
  const calls: TracedCalls = [
    {
      name: 'list_my_orders',
      args: { date_from: '2026-10-13' },
      status: 'failed',
      initiator: 'server',
    },
    { name: 'synthetic_unknown_tool', args: 'not-an-object', status: 'rejected' },
    { name: 'get_my_earnings', args: {}, status: 'ok', initiator: 'server' },
    MODEL_CALL,
  ];
  const records = toolCallRecords(calls);
  expect(records.map((record) => [record.seq, record.name, record.status])).toEqual([
    [1, 'list_my_orders', 'failed'],
    [2, 'synthetic_unknown_tool', 'rejected'],
    [3, 'get_my_earnings', 'ok'],
    [4, 'search_products', 'ok'],
  ]);
  const initiators = records.map(
    (record) => (record as unknown as Readonly<Record<string, unknown>>)['initiator'],
  );
  expect(initiators).toEqual(['server', 'model', 'server', 'model']);
});
