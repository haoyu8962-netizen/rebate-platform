import { expect, it, vi } from 'vitest';
import type { Candidate } from '../../../parsing/index.ts';
import type { LinkQuoteRunner } from '../../tools/quote/index.ts';
import type { RunContext } from '../../stream/run/index.ts';
import type { AgentRunTexts, PathInput } from '../core/ports.ts';
import { createDeterministicPath } from './index.ts';

function request(): PathInput {
  const link: Candidate = { kind: 'url', raw: 'https://item.example.invalid/syn/1', index: 0 };
  return {
    input: {
      caller: { appId: 'app-syn', userId: 'user-syn', deviceId: 'device-syn', phoneBound: true },
    },
    proceed: { links: [link], placeholders: {} },
  } as unknown as PathInput;
}

function context() {
  const events: unknown[] = [];
  const ctx: RunContext = {
    runId: 'run-syn',
    sessionId: 'session-syn',
    signal: new AbortController().signal,
    get cardsDelivered() {
      return 0;
    },
    text: (text) => {
      events.push({ kind: 'text', text });
    },
    card: async (card) => {
      events.push({ kind: 'card', card });
    },
    toolStatus: (tool, phase) => {
      events.push({ kind: 'status', tool, phase });
    },
    suggestions: (items) => {
      events.push({ kind: 'suggestions', items });
    },
  };
  return { ctx, events };
}

const texts: AgentRunTexts = {
  text: async (_appId, key) => `固定文案:${key}`,
  toolDisplay: async (_appId, tool, phase) => `模板:${tool}:${phase}`,
} as AgentRunTexts;

it('[AC-B3-05u#impl-1] 异常对象的 constructor 被置空时按服务端原因记一次 unknown，终帧 50401', async () => {
  const thrown = Object.defineProperty(new Error('x'), 'constructor', { value: null });
  const quotes: LinkQuoteRunner = {
    run: vi.fn<LinkQuoteRunner['run']>(async () => {
      throw thrown;
    }),
  };
  const logger = { error: vi.fn<(obj: Record<string, unknown>, msg: string) => void>() };
  const { ctx, events } = context();
  const path = createDeterministicPath({ quotes, texts, logger });

  const result = await path.run(request(), ctx);

  expect(result).toMatchObject({ kind: 'error', error: { code: 50401, retryable: false } });
  expect(logger.error).toHaveBeenCalledTimes(1);
  const [record, msg] = logger.error.mock.calls[0]!;
  expect(record).toEqual({ code: 'AGENT_LINK_QUOTE_FAILED', link_index: 0, cause: 'unknown' });
  expect(Object.values(record)).not.toContain('x');
  expect(msg).toBe('agent_link_quote_failed');
  expect(events.filter((e) => (e as { kind: string }).kind === 'card')).toEqual([]);
});
