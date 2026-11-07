// B1-04zzy (D10-860 ①②④): the production assembly. The real AppModule on the stream entry (the
// B3-03j regression kit's `production`, unchanged) serves Agent search; app.module must hand the
// stream entry's catalog to the Agent as the `categories` port and give every candidate the union
// item's category_l1_id ('' without one). An active app.category_blocklist row of the request's app
// then drops the item on the next search, on the degraded keyword path and on the model tool
// search_products alike; a disabled row lets it back. Only the demo union adapter's normalized
// search DTO is changed (test #7 gives each item a synthetic level-one category id derived from its
// title serial; demo items carry none). Database through createTestDatabase (usePgEach).
// Synthetic values.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { DemoUnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { framesOf, message, openSession, send, usePgEach, type Row } from '../stream-mount/kit.ts';
import { APP } from '../stream-assembly/kit.ts';
import { callTool, production } from '../stream-assembly/regression-kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

type Production = Awaited<ReturnType<typeof production>>;

/** Synthetic decimal level-one category id of a demo item: its two-digit title serial after 90007. */
function categoryOf(serial: string): string {
  return `90007${serial}`;
}

function serialOf(title: string): string {
  return title.slice(-2);
}

function categorizeDemoItems(): void {
  const originalSearch = DemoUnionAdapter.prototype.searchItems;
  vi.spyOn(DemoUnionAdapter.prototype, 'searchItems').mockImplementation(async function (
    this: DemoUnionAdapter,
    query,
    context,
  ) {
    const page = await originalSearch.call(this, query, context);
    return {
      ...page,
      items: page.items.map((item) => ({
        ...item,
        category_l1_id: categoryOf(serialOf(item.title)),
      })),
    };
  });
}

function listTitles(
  cards: readonly { readonly type: unknown; readonly data: Readonly<Row> }[],
): string[] {
  return cards
    .filter((card) => card.type === 'product_list')
    .flatMap((card) => (card.data['items'] as Row[]).map((item) => String(item['title'])));
}

/** One degraded keyword search in a new session; the titles of every product list it delivered. */
async function fallbackSearch(r: Production): Promise<{ sessionId: string; titles: string[] }> {
  const sessionId = await openSession(r, r.caller);
  const frames = framesOf((await send(r, r.caller, sessionId, message('演示商品'))).chunks);
  const cards = frames
    .filter((frame) => frame.event === 'card')
    .map((frame) => ({ type: frame.data['type'], data: frame.data['data'] as Row }));
  return { sessionId, titles: listTitles(cards) };
}

/**
 * The model tool search_products through the runtime's tools, in an existing session, under that
 * session's one real run (the production result set must belong to a run of this session).
 */
async function modelSearch(r: Production, sessionId: string): Promise<string[]> {
  const runs = await pg.db
    .selectFrom('agent_runs')
    .select('id')
    .where('session_id', '=', sessionId)
    .execute();
  expect(runs).toHaveLength(1);
  const context = { ...r.context(sessionId), runId: runs[0]!.id };
  const outcome = await callTool(r.body.tools, context, 'search_products', {
    q: '演示商品',
  });
  expect(outcome.kind).toBe('ok');
  if (outcome.kind !== 'ok') return [];
  return listTitles(outcome.cards);
}

async function insertRule(
  id: string,
  appId: string,
  categoryId: string,
  keyword: string | null,
): Promise<void> {
  await sql`INSERT INTO app.category_blocklist (id, app_id, platform, category_id, keyword, reason, status, updated_by)
    VALUES (${id}, ${appId}, 'taobao', ${categoryId}, ${keyword}, '合成', 'active', 'test')`.execute(
    pg.db,
  );
}

it('[AC-B1-04zzy#7] 生产装配：真实 AppModule 的 Agent 搜索经 catalog 名单按联盟一级类目判——启用行下次搜索即不出该类目商品（降级关键词搜索与 search_products 都是），他应用的行不生效，行改为禁用后恢复', async () => {
  categorizeDemoItems();
  const r = await production(pg.db);
  try {
    const control = await fallbackSearch(r);
    expect(control.titles.length).toBeGreaterThanOrEqual(2);
    const target = serialOf(control.titles[0]!);
    const kept = serialOf(control.titles[1]!);
    expect(target).not.toBe(kept);

    await insertRule('0199b0c4-0000-7000-8000-000000000701', APP, categoryOf(target), null);
    await insertRule(
      '0199b0c4-0000-7000-8000-000000000702',
      'synthetic-other-app',
      categoryOf(kept),
      null,
    );

    const blocked = await fallbackSearch(r);
    expect(blocked.titles.map(serialOf)).not.toContain(target);
    expect(blocked.titles.map(serialOf)).toContain(kept);
    const model = await modelSearch(r, blocked.sessionId);
    expect(model.length).toBeGreaterThan(0);
    expect(model.map(serialOf)).not.toContain(target);

    await sql`UPDATE app.category_blocklist SET status = 'disabled'
      WHERE id = '0199b0c4-0000-7000-8000-000000000701'`.execute(pg.db);
    const restored = await fallbackSearch(r);
    expect(restored.titles.map(serialOf)).toContain(target);
    expect(restored.titles.map(serialOf)).toContain(kept);
  } finally {
    await r.app.close();
  }
}, 120_000);

it('[AC-B1-04zzy#8] 生产装配：联盟商品无一级类目时按无类目判——同平台带关键词行按标题字面匹配即不出卡，不带关键词的类目行不生效', async () => {
  const r = await production(pg.db);
  try {
    const control = await fallbackSearch(r);
    expect(control.titles.length).toBeGreaterThanOrEqual(2);
    const targetTitle = control.titles[0]!;
    const kept = serialOf(control.titles[1]!);
    const target = serialOf(targetTitle);
    expect(target).not.toBe(kept);
    // The demo title ends with its own hash segment and serial: unique to the target item.
    const keyword = /(\S+ \d{2})$/u.exec(targetTitle)?.[1];
    expect(keyword).toBeTypeOf('string');

    await insertRule('0199b0c4-0000-7000-8000-000000000801', APP, '9000899', keyword!);
    await insertRule('0199b0c4-0000-7000-8000-000000000802', APP, '9000898', null);

    const blocked = await fallbackSearch(r);
    expect(blocked.titles.map(serialOf)).not.toContain(target);
    expect(blocked.titles.map(serialOf)).toContain(kept);
  } finally {
    await r.app.close();
  }
}, 120_000);
