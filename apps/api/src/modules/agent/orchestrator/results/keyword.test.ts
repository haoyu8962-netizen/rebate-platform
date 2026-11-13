import { expect, it, vi } from 'vitest';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import type { ToolContext } from '../core/ports.ts';
import { createKeywordResults } from './keyword.ts';
import { createMemoryResultSetStore, keepsQuoted } from './store.ts';
import type { DeliveredProduct, ResultSetStore } from './types.ts';

const APP = 'synthetic-app';
const SESSION = 'synthetic-session';
const PLAN = { q: '合成保温杯', platforms: ['taobao'], sort: 'relevance' } as const;

function ctx(runId = 'synthetic-run'): ToolContext {
  return {
    subject: {
      appId: APP,
      traceId: 'synthetic-trace',
      deviceId: 'synthetic-device',
      deviceHash: 'synthetic-hash',
      ipKey: 'synthetic-ip-key',
      userId: null,
      phoneBound: false,
    },
    runId,
    sessionId: SESSION,
    signal: new AbortController().signal,
    placeholders: {},
  };
}

function list(resultSetId: string): UnnumberedCard {
  return {
    type: 'product_list',
    schema_version: 1,
    data: { result_set_id: resultSetId, items: [] },
    fallback_text: '合成商品列表',
  };
}

function item(cardId: string): DeliveredProduct {
  return {
    card_id: cardId,
    product_key: `tb:${cardId}`,
    platform: 'taobao',
    final_price_fen: 1000,
    card: list('unused'),
  };
}

it('[AC-B3-03q#5] 降级结果集保存后不切链；首张 product_list 回执后才切，同批其余回执不再追加', async () => {
  const store = createMemoryResultSetStore();
  const append = vi.spyOn(store, 'appendChain');
  const keyword = createKeywordResults(store);
  const receipts = keyword.receipts(() => undefined);
  await keyword.save(PLAN, ctx(), [list('set-a'), list('set-b')]);
  expect(await receipts.currentChain?.(APP, SESSION)).toBeNull();

  await receipts.recordDelivered('set-a', []);
  expect(await receipts.currentChain?.(APP, SESSION)).toBeNull();
  await receipts.recordDelivered('set-a', [item('c2')]);
  expect(await receipts.currentChain?.(APP, SESSION)).toMatchObject({
    status: 'has_products',
    conditions: { q: '合成保温杯', page: 1 },
  });
  await receipts.recordDelivered('set-b', [item('c4')]);
  expect(append).toHaveBeenCalledTimes(1);
  expect((await receipts.latestWithProducts(APP, SESSION))?.delivered).toEqual([item('c4')]);
});

it('[AC-B3-03q#5] 没写出的一批不切链；回执记录失败仍切链并抛回原错误；切链失败只回调不影响回执', async () => {
  const store = createMemoryResultSetStore();
  const keyword = createKeywordResults(store);
  const errors: string[] = [];
  const receipts = keyword.receipts((_error, id) => errors.push(id));
  await keyword.save(PLAN, ctx('run-1'), [list('seen')]);
  await receipts.recordDelivered('seen', [item('c2')]);
  const seen = await receipts.currentChain?.(APP, SESSION);

  await keyword.save({ ...PLAN, q: '合成水杯' }, ctx('run-2'), [list('unseen')]);
  expect(await receipts.currentChain?.(APP, SESSION)).toEqual(seen);

  const failing: ResultSetStore = {
    ...store,
    recordDelivered: async () => {
      throw new Error('synthetic record failure');
    },
  };
  const other = createKeywordResults(failing);
  const failingReceipts = other.receipts(() => undefined);
  await other.save({ ...PLAN, q: '合成茶杯' }, ctx('run-3'), [list('failed')]);
  await expect(failingReceipts.recordDelivered('failed', [item('c6')])).rejects.toThrow(
    'synthetic record failure',
  );
  expect(await store.currentChain(APP, SESSION)).toMatchObject({ conditions: { q: '合成茶杯' } });

  const broken: ResultSetStore = {
    ...store,
    appendChain: async () => {
      throw new Error('synthetic chain failure');
    },
  };
  const third = createKeywordResults(broken);
  const brokenReceipts = third.receipts((_error, id) => errors.push(id));
  await third.save(PLAN, ctx('run-4'), [list('broken')]);
  await expect(brokenReceipts.recordDelivered('broken', [item('c8')])).resolves.toBeUndefined();
  expect(errors).toEqual(['broken']);
  expect(keepsQuoted(brokenReceipts)).toBe(true);
  const { recordQuoted, ...plain } = store;
  void recordQuoted;
  expect(keepsQuoted(createKeywordResults(plain).receipts(() => undefined))).toBe(false);
});

it('[AC-B3-08zh#7][BR-AI-19] kept：断线后保留的列表即刻切到本批的链（与回执同形），只切一次、不写下发记录；未知结果集不动', async () => {
  const store = createMemoryResultSetStore();
  const append = vi.spyOn(store, 'appendChain');
  const deliver = vi.spyOn(store, 'recordDelivered');
  const keyword = createKeywordResults(store);
  const receipts = keyword.receipts(() => undefined);
  await keyword.kept('unknown-set');
  expect(append).not.toHaveBeenCalled();
  await keyword.save(PLAN, ctx(), [list('set-a'), list('set-b')]);
  await keyword.kept('set-a');
  expect(await receipts.currentChain?.(APP, SESSION)).toMatchObject({
    status: 'has_products',
    conditions: { q: PLAN.q, page: 1 },
  });
  await keyword.kept('set-b');
  await receipts.recordDelivered('set-a', [item('c2')]);
  expect(append).toHaveBeenCalledTimes(1);
  expect(deliver).toHaveBeenCalledTimes(1);
});
