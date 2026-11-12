// B3-05p · BR-AI-18 细则「比较与适用性的提示」: the memory store's recent quotes (quotedRecently), the
// same app / session scoping and turn window as the PG store (agent/store/results). Synthetic only.
import { expect, it } from 'vitest';
import { createKeywordResults } from './keyword.ts';
import { createMemoryResultSetStore, readsRecentQuotes } from './store.ts';
import type { DeliveredProduct } from './types.ts';

const APP = 'synthetic-app';
const SESSION = 'synthetic-session';

function quote(cardId: string): DeliveredProduct {
  return {
    card_id: cardId,
    product_key: `tb:${cardId}`,
    platform: 'taobao',
    final_price_fen: 1000,
    card: {
      type: 'rebate_quote',
      schema_version: 1,
      data: {},
      fallback_text: '合成报价卡',
    },
  };
}

function scope(runId: string, sessionId = SESSION, appId = APP) {
  return { appId, sessionId, runId };
}

/** A run of the session that stored a result set but no quote. */
async function plainRun(store: ReturnType<typeof createMemoryResultSetStore>, runId: string) {
  await store.save({
    id: `set-${runId}`,
    appId: APP,
    sessionId: SESSION,
    runId,
    conditions: { chain_id: 'synthetic-chain' } as never,
  });
}

it('[B3-05p][BR-AI-18] 本会话最近对话里的报价卡算；别的会话、别的应用、正在问的这一轮不算', async () => {
  const store = createMemoryResultSetStore();
  await store.recordQuoted(scope('run-1'), [quote('c1')]);
  expect(await store.quotedRecently(scope('run-2'), 8)).toBe(true);
  expect(await store.quotedRecently(scope('run-2', 'synthetic-other-session'), 8)).toBe(false);
  expect(await store.quotedRecently(scope('run-2', SESSION, 'synthetic-other-app'), 8)).toBe(false);
  // The run asking is never its own recent conversation.
  expect(await store.quotedRecently(scope('run-1'), 8)).toBe(false);
  // No product result set: the quote stays outside 「第 N 个」.
  expect(await store.latestWithProducts(APP, SESSION)).toBeNull();
});

it('[B3-05p][BR-AI-18] 只看最近 turns 轮：更早的报价卡不算；turns 为 0（不带历史）一律不算；空报价不算', async () => {
  const store = createMemoryResultSetStore();
  await store.recordQuoted(scope('run-1'), [quote('c1')]);
  await plainRun(store, 'run-2');
  await plainRun(store, 'run-3');
  expect(await store.quotedRecently(scope('run-4'), 3)).toBe(true);
  expect(await store.quotedRecently(scope('run-4'), 2)).toBe(false);
  expect(await store.quotedRecently(scope('run-4'), 0)).toBe(false);
  await store.recordQuoted(scope('run-4'), []);
  expect(await store.quotedRecently(scope('run-5'), 8)).toBe(true);
  expect(await store.quotedRecently(scope('run-5'), 1)).toBe(false);
});

it('[B3-05p][BR-AI-18] 回执包装照样转发 quotedRecently；没有这项能力的库不加', async () => {
  const store = createMemoryResultSetStore();
  await store.recordQuoted(scope('run-1'), [quote('c1')]);
  const receipts = createKeywordResults(store).receipts(() => undefined);
  expect(readsRecentQuotes(receipts)).toBe(true);
  expect(await receipts.quotedRecently?.(scope('run-2'), 8)).toBe(true);
  const { quotedRecently, ...plain } = store;
  void quotedRecently;
  expect(readsRecentQuotes(createKeywordResults(plain).receipts(() => undefined))).toBe(false);
});
