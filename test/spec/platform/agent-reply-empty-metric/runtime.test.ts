import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { RunBodyInput } from '../../../../apps/api/src/modules/agent/http/index.ts';
import { emptyOrchestratorTools } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { createMemoryResultSetStore } from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import { redactForModel } from '../../../../apps/api/src/modules/agent/preprocess/redact/index.ts';
import * as agentBody from '../../../../apps/api/src/modules/agent/stream/mount/agent-body.ts';
import type { AgentBodyAssembly } from '../../../../apps/api/src/modules/agent/stream/mount/body.ts';
import {
  createAgentStreamRuntime,
  type AgentStreamAssembly,
  type AgentStreamRuntime,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import type { RunContext } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createMetricsRegistry } from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import { scriptedModels } from '../../agent/core-reply-templates/kit.ts';
import { copy, unknownCalls } from '../../agent/intent-fallback/kit.ts';
import { compileOnlyDb } from '../metrics/kit.ts';
import { assertCounter, loadCounterToken, ROOT } from './kit.ts';

interface Counter {
  total(): number;
}
interface App {
  init(): Promise<unknown>;
  close(): Promise<void>;
  get(token: symbol, options: { strict: false }): unknown;
}

afterEach(() => vi.restoreAllMocks());

async function run(body: AgentBodyAssembly, question: string) {
  const runId = randomUUID();
  const input: RunBodyInput = {
    caller: {
      appId: 'couli',
      userId: 'synthetic-user',
      phoneBound: true,
      deviceId: 'synthetic-device',
      deviceHash: 'synthetic-hash',
      traceId: 'synthetic-trace',
      ipKey: 'synthetic-ip',
    },
    runId,
    sessionId: randomUUID(),
    userMessageId: randomUUID(),
    assistantMessageId: randomUUID(),
    text: question,
    redactedText: redactForModel(question).text,
    limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
  };
  const text: string[] = [];
  const suggestions: unknown[] = [];
  const ctx: RunContext = {
    runId,
    sessionId: input.sessionId,
    signal: new AbortController().signal,
    cardsDelivered: 0,
    text: (delta) => {
      text.push(delta);
    },
    suggestions: (items) => {
      suggestions.push(...items);
    },
    toolStatus: () => undefined,
    card: async () => undefined,
  };
  const result = await body.body(input)(ctx);
  return { result, text: text.join(''), suggestions };
}

it('[AC-B1-01zzv#5][BR-AI-01] Nest 令牌和多个 stream 运行体共用进程计数；真实空回复补全使 total 与指标各加一，正常回复及抓取不增计数', async () => {
  const token = await loadCounterToken();
  const agent = (await import(new URL('apps/api/src/modules/agent/index.ts', ROOT).href)) as {
    AgentModule: { forStream(options: object): { exports?: unknown[] } };
  };
  expect(agent.AgentModule.forStream({}).exports).toContain(token);
  const boot = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: 'stream', overrides: object): Promise<App>;
  };
  const db = compileOnlyDb([]);
  const clock = new FixedClock('2026-11-12T00:00:00.000Z');
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'stream', appEnv: 'test' },
    {
      write: (line: string) => {
        lines.push(line);
      },
    },
  );
  const app = await boot.createHttpApp('stream', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock,
    logger,
    dbHandles: { db, dbRead: null, close: async () => undefined },
    startQueue: false,
  });
  const runtimes: AgentStreamRuntime[] = [];
  try {
    await app.init();
    const counter = app.get(token, { strict: false }) as Counter;
    expect(counter).toEqual(expect.objectContaining({ total: expect.any(Function) }));
    expect(app.get(token, { strict: false })).toBe(counter);
    const initial = counter.total();
    expect(Number.isSafeInteger(initial)).toBe(true);
    expect(initial).toBeGreaterThanOrEqual(0);
    const registry = createMetricsRegistry({
      entry: 'stream',
      collectAgentReplyEmpty: () => counter.total(),
    });
    assertCounter(await registry.render(), initial);

    // Synthetic business ports and model/prompt/review/trace isolate external dependencies.
    // The runtime selects its own counter; real createStreamAgentBody performs the fallback
    // and record(), without any test-provided counter.
    // Calling its built body bypasses HTTP admission/storage, so no PG connection is needed.
    const built: AgentBodyAssembly[] = [];
    const realBody = agentBody.createStreamAgentBody;
    const complete = scriptedModels({
      空回复一: [{}],
      空回复二: [unknownCalls(5)],
      正常回复: [{ text: '这是合成的正常答复。' }],
    });
    vi.spyOn(agentBody, 'createStreamAgentBody').mockImplementation((deps) => {
      const result = realBody({
        ...deps,
        model: { complete },
        prompt: { current: async () => ({ version: 'synthetic-v1', system: '合成提示词' }) },
        review: { review: async () => 'pass' },
        trace: { record: () => undefined },
      });
      built.push(result);
      return result;
    });
    const business: AgentStreamAssembly = {
      tools: emptyOrchestratorTools(),
      deterministic: { run: async () => ({ kind: 'done', finishReason: 'stop' }) },
      intents: { handle: async () => null },
      results: createMemoryResultSetStore(),
      texts: { text: async (_app, key) => copy(key), toolDisplay: async () => '合成工具' },
    };
    const makeRuntime = () =>
      createAgentStreamRuntime(
        {
          db,
          clock,
          logger,
          contentReader: {
            configValue: async () => null,
            freshConfigValue: async () => null,
          },
          consentReader: () => ({ check: async () => ({ allowed: false, reason: 'missing' }) }),
          assembly: () => business,
        },
        {
          inputCheck: {
            check: async (input) => ({
              kind: 'proceed',
              modelText: input.text,
              placeholders: {},
              links: [],
              notices: [],
              untrustedInput: false,
              paramsRequested: false,
            }),
          },
        },
      );
    runtimes.push(makeRuntime());
    expect(built).toHaveLength(1);
    const first = await run(built[0]!, '空回复一');
    expect(first.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(first.text).toBe(copy('agent.reply.empty'));
    expect(first.suggestions).toHaveLength(3);
    expect(counter.total()).toBe(initial + 1);
    assertCounter(await registry.render(), initial + 1);

    // Building another runtime must not reset or replace the process counter.
    runtimes.push(makeRuntime());
    expect(built).toHaveLength(2);
    expect(counter.total()).toBe(initial + 1);
    const second = await run(built[1]!, '空回复二');
    expect(second.result).toEqual({ kind: 'done', finishReason: 'limit' });
    expect(second.text).toBe(copy('agent.reply.empty'));
    expect(second.suggestions).toHaveLength(3);
    expect(counter.total()).toBe(initial + 2);
    assertCounter(await registry.render(), initial + 2);

    const normal = await run(built[0]!, '正常回复');
    expect(normal.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(normal.text).toBe('这是合成的正常答复。');
    assertCounter(await registry.render(), initial + 2);
    assertCounter(await registry.render(), initial + 2);
    expect(counter.total()).toBe(initial + 2);
    expect(app.get(token, { strict: false })).toBe(counter);
    expect(lines.filter((line) => JSON.parse(line).msg === 'agent_reply_empty')).toHaveLength(2);
  } finally {
    await Promise.all(runtimes.map((runtime) => runtime.close()));
    await app.close();
    await db.destroy();
  }
}, 60_000);
