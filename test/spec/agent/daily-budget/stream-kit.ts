import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';

import {
  createVendorGateway,
  type VendorResponse,
  type VendorTransport,
} from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import type { OrchestratorTools } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { createAgentStreamRuntime } from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import { FLASH, resolved } from '../model-routing/kit.ts';
import { fixture, passInput } from '../stream-assembly/kit.ts';
import {
  bindConsentReader,
  contentReaderFor,
  framesOf,
  loadConsentReader,
  type FakeReply,
} from '../stream-mount/kit.ts';

export const MODELS = 'agent.models';
export const DAILY = 'agent.daily_budget_fen';
export const RESERVE = 'agent.budget.reserve_mfen_per_run';
export const QUERY = '帮我找个合成保温杯';
export const ANSWER = '这是一条合成答复。';

export function price(version = 'synthetic-v1', input = 100_000, output = 400_000) {
  return { in_mfen_per_m: input, out_mfen_per_m: output, version };
}

export function flashPrices(version?: string) {
  return { [FLASH]: price(version) };
}

export function answer(input = 2_000, output = 300, tool = false): VendorResponse {
  const toolCall = {
    index: 0,
    id: 'synthetic-tool-call',
    type: 'function',
    function: { name: 'search_products', arguments: '{"q":"合成保温杯"}' },
  };
  return {
    chunks: [
      { choices: [{ index: 0, delta: { content: ANSWER } }] },
      ...(tool ? [{ choices: [{ index: 0, delta: { tool_calls: [toolCall] } }] }] : []),
      {
        choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: input, completion_tokens: output },
      },
    ],
    usage: { input_tokens: input, output_tokens: output },
  };
}

interface MountOptions {
  readonly attempts?: readonly string[];
  readonly answer?: VendorTransport['send'];
  readonly tools?: OrchestratorTools;
  readonly failPriceRead?: boolean;
}

export async function mountBudget(db: Kysely<DB>, options: MountOptions = {}) {
  const f = await fixture(db);
  const content = contentReaderFor(db, f.time.clock);
  const configValuesByKey = content.configValuesByKey;
  const failPrice = (read: typeof content.configValue): typeof read => {
    return async (appId, key) => {
      if (key === MODELS) throw new Error('fixture: agent.models read failed');
      return read(appId, key);
    };
  };
  const transport = vi.fn<VendorTransport['send']>(options.answer ?? (async () => answer()));
  const gateway = createVendorGateway({
    transport: { billable: true, send: transport },
    clock: f.time.clock,
    onlineMeter: { record: vi.fn() },
    offlineMeter: { record: vi.fn() },
    offlineBudgetApproved: [],
    rewrittenSampleGrants: [],
    ownerAggregateApprovals: [],
  });
  const runtime = createAgentStreamRuntime(
    {
      db,
      clock: f.time.clock,
      logger: f.logs.logger,
      consentReader: bindConsentReader(await loadConsentReader(), db),
      contentReader: options.failPriceRead
        ? {
            ...content,
            configValue: failPrice(content.configValue),
            freshConfigValue: failPrice(content.freshConfigValue),
            ...(configValuesByKey === undefined
              ? {}
              : {
                  async configValuesByKey(key: string) {
                    if (key === MODELS) throw new Error('fixture: agent.models read failed');
                    return configValuesByKey(key);
                  },
                }),
          }
        : content,
      assembly: () => {
        const assembly = f.build();
        return options.tools === undefined ? assembly : { ...assembly, tools: options.tools };
      },
    },
    {
      schedule: f.time.scheduler,
      inputCheck: passInput,
      modelRouting: {
        gateway,
        route: async () => resolved(...(options.attempts ?? ['flash'])),
        prompt: {
          current: async () => ({ version: 'synthetic-v1', system: '合成系统前缀。'.repeat(150) }),
        },
        review: { review: async () => 'pass' },
      },
    },
  );
  return { ...f, runtime, transport };
}

export function doneView(reply: FakeReply, reason: string) {
  expect(reply.jsons).toEqual([]);
  const frames = framesOf(reply.chunks);
  expect(frames[0]?.event).toBe('meta');
  expect(frames.at(-1)).toMatchObject({ event: 'done', data: { finish_reason: reason } });
  const runId = frames[0]?.data['run_id'];
  expect(runId).toBeTypeOf('string');
  return {
    frames,
    runId: String(runId),
    text: frames
      .filter((frame) => frame.event === 'text.delta')
      .map((frame) => String(frame.data['delta']))
      .join(''),
  };
}
