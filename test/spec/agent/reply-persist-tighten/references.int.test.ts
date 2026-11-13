// BR-AI-19 / BR-AI-05：通过真实模型调用和数据库，验证断线后卡片能在下一轮重新报价。
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { createPgResultSetStore } from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import type { Step } from '../core-reply-templates/kit.ts';
import { openSession, runRow, usePgEach, type Row } from '../stream-mount/kit.ts';
import { ask, cardFramesOf, cardRowsOf, productionRig, runIdOf } from '../trace-persist/kit.ts';
import { disconnectedRun, held, waitAt } from '../reply-persist/kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

async function reference(kind: 'product_list' | 'rebate_quote'): Promise<void> {
  const h = held();
  const firstAsk = '帮我找合成保温杯';
  const quoteAsk = '看看刚才的商品返利';
  const nextAsk = '再查一下这件商品的返利';
  const scripts: Record<string, readonly Step[]> = {
    [firstAsk]: [
      {
        ...(kind === 'product_list' ? { before: waitAt(h) } : {}),
        calls: [{ name: 'search_products', args: { q: '合成保温杯' } }],
      },
      { text: '已找到合成商品。' },
    ],
  };
  const x = await productionRig(pg.db, { scripts });
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    let frames;
    if (kind === 'rebate_quote') {
      const list = await ask(x, x.f.caller, sessionId, firstAsk);
      const listCard = cardFramesOf(list).find((card) => card.data['type'] === 'product_list');
      expect(listCard, '连线的前置搜索确实生成列表').toBeDefined();
      const items = listCard!.data['data'] as Row;
      expect(items['items']).toBeInstanceOf(Array);
      const product = (items['items'] as Row[])[0];
      expect(product?.['card_id']).toBeTypeOf('string');
      scripts[quoteAsk] = [
        {
          before: waitAt(h),
          calls: [{ name: 'get_rebate_quote', args: { card_id: product?.['card_id'] } }],
        },
        { text: '已查到合成返利。' },
      ];
      frames = (await disconnectedRun(x, h, sessionId, quoteAsk)).frames;
    } else frames = (await disconnectedRun(x, h, sessionId, firstAsk)).frames;
    const runId = runIdOf(frames);
    expect(cardFramesOf(frames)).toEqual([]);
    expect((await runRow(pg.db, runId))['finish_reason']).toBe('stop');
    const cards = await cardRowsOf(pg.pool(), 'run_id', runId);
    const stored = cards.find((card) => card.type === kind);
    expect(stored, '断线期间产生的卡片已提交').toBeDefined();
    const data = stored!.data as Row;
    if (kind === 'product_list') expect(data['items']).toBeInstanceOf(Array);
    const product =
      kind === 'product_list' ? (data['items'] as Row[])[0]! : (data['product'] as Row);
    expect(product, '已提交卡片包含商品').toBeDefined();
    const cardId = product['card_id'];
    expect(cardId).toBeTypeOf('string');
    const found = await createPgResultSetStore({ db: pg.pool() }).findDelivered(
      x.appId,
      sessionId,
      cardId as string,
    );
    expect(found).toMatchObject({ card_id: cardId, product_key: product['product_key'] });
    x.f.readProduct.mockClear();
    scripts[nextAsk] = [
      { calls: [{ name: 'get_rebate_quote', args: { card_id: cardId } }] },
      { text: '已重新查询。' },
    ];
    const next = await ask(x, x.f.caller, sessionId, nextAsk);
    expect(runIdOf(next)).not.toBe(runId);
    expect(x.f.readProduct.mock.calls.map(([key]) => key)).toContain(product['product_key']);
    const quote = cardFramesOf(next).find((card) => card.data['type'] === 'rebate_quote');
    expect(quote).toBeDefined();
    expect((quote!.data['data'] as Row)['product']).toMatchObject({
      product_key: product['product_key'],
    });
  } finally {
    h.gate.open();
    await x.r.runtime.close();
  }
}

it('[AC-B3-08zd#6][BR-AI-19][BR-AI-05] 断线后的商品列表落库后，下一轮模型按商品 card_id 调 get_rebate_quote 解析到同一件商品', async () => {
  await reference('product_list');
}, 120_000);

it('[AC-B3-08zd#6][BR-AI-19][BR-AI-05] 断线后的报价卡落库后，下一轮模型按商品 card_id 调 get_rebate_quote 解析到同一件商品', async () => {
  await reference('rebate_quote');
}, 120_000);
