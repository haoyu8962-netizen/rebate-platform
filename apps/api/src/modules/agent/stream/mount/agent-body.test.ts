// B3-05p · BR-AI-18 细则「比较与适用性的提示」: the stream entry's session products port — the current
// result set, or a rebate_quote card of the session's latest agent.context.max_turns runs (default
// 8, also when the value cannot be read). Synthetic only.
import { expect, it, vi } from 'vitest';
import type { RootLogger } from '../../../platform/index.ts';
import { createMemoryResultSetStore } from '../../orchestrator/results/index.ts';
import type { DeliveredProduct } from '../../orchestrator/results/index.ts';
import { sessionProducts } from './agent-body.ts';
import type { AgentDegradedPorts } from './assembly.ts';

const APP = 'synthetic-app';
const SESSION = 'synthetic-session';

function quote(): DeliveredProduct {
  return {
    card_id: 'c1',
    product_key: 'tb:synthetic',
    platform: 'taobao',
    final_price_fen: 1000,
    card: { type: 'rebate_quote', schema_version: 1, data: {}, fallback_text: '合成报价卡' },
  };
}

function logger() {
  const warn = vi.fn();
  return { warn, logger: { warn } as unknown as RootLogger };
}

function config(value: unknown): AgentDegradedPorts['config'] {
  return {
    configValue: vi.fn(async (_app: string, key: string) =>
      key === 'agent.context.max_turns' && value !== undefined ? { value, version: 1 } : null,
    ),
  } as unknown as AgentDegradedPorts['config'];
}

/** One quote in run-1, then `later` runs that stored a result set only. */
async function storeWithQuote(later: number) {
  const store = createMemoryResultSetStore();
  await store.recordQuoted({ appId: APP, sessionId: SESSION, runId: 'run-1' }, [quote()]);
  for (let i = 0; i < later; i += 1) {
    await store.save({
      id: `set-${String(i)}`,
      appId: APP,
      sessionId: SESSION,
      runId: `run-later-${String(i)}`,
      conditions: { chain_id: 'synthetic-chain' } as never,
    });
  }
  return store;
}

it('[B3-05p][BR-AI-18] 只有报价卡：默认 8 轮内算，读不到配置也按 8；更早的、别的会话的不算', async () => {
  const { logger: log } = logger();
  const recent = await storeWithQuote(7);
  expect(await sessionProducts(recent, log, undefined).inContext(APP, SESSION, 'run-now')).toBe(
    true,
  );
  const failing = {
    configValue: vi.fn(async () => {
      throw new Error('合成配置失败');
    }),
  } as unknown as AgentDegradedPorts['config'];
  expect(await sessionProducts(recent, log, failing).inContext(APP, SESSION, 'run-now')).toBe(true);
  expect(
    await sessionProducts(recent, log, config(8)).inContext(APP, 'other-session', 'run-now'),
  ).toBe(false);
  const older = await storeWithQuote(8);
  expect(
    await sessionProducts(older, log, config(undefined)).inContext(APP, SESSION, 'run-now'),
  ).toBe(false);
});

it('[B3-05p][BR-AI-18] agent.context.max_turns 取配置值：0 不带历史，不算；更大的窗口算', async () => {
  const { logger: log } = logger();
  const store = await storeWithQuote(8);
  expect(await sessionProducts(store, log, config(0)).inContext(APP, SESSION, 'run-now')).toBe(
    false,
  );
  expect(await sessionProducts(store, log, config(9)).inContext(APP, SESSION, 'run-now')).toBe(
    true,
  );
});

it('[B3-05p][BR-AI-18] 读报价失败：按 false，记一行 warn', async () => {
  const { warn, logger: log } = logger();
  const store = await storeWithQuote(0);
  vi.spyOn(store, 'quotedRecently').mockRejectedValue(new Error('合成读失败'));
  expect(await sessionProducts(store, log, config(8)).inContext(APP, SESSION, 'run-now')).toBe(
    false,
  );
  expect(warn).toHaveBeenCalledWith({ error_name: 'Error' }, 'agent_session_products_failed');
});
