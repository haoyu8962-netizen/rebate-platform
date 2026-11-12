import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { expect, it } from 'vitest';
import type { CardInput } from '../writer/index.ts';
import { deliveryReceiptOf } from './deliveries.ts';
import { writeReply } from './reply.ts';
import type { RunRow, SessionRow } from './store.ts';
import type { Queries } from './transaction.ts';

const APP = 'couli';
const SESSION = '019a0000-0000-7000-8000-000000000201';
const RUN = '019a0000-0000-7000-8000-000000000301';
const SET = '6f1c2a4e-1b2c-4d3e-8f40-000000000401';
const NOW = new Date('2026-11-12T00:00:00Z');

const compiler = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** Records every statement; answers the owner / quoted-set reads and the inserts. */
function fakeQueries(options: { readonly setOwned?: boolean } = {}) {
  const statements: Statement[] = [];
  const q: Queries = {
    query<T>(statement: { compile(db: Kysely<DB>): Statement }): Promise<T[]> {
      const compiled = statement.compile(compiler);
      statements.push({ sql: compiled.sql, parameters: compiled.parameters });
      const text = compiled.sql;
      let rows: unknown[] = [];
      if (text.includes('JOIN app.agent_runs r')) {
        rows = options.setOwned === false ? [] : [{ run_id: RUN }];
      } else if (text.startsWith('SELECT id::text AS id FROM app.agent_result_sets')) {
        rows = [{ id: 'quoted-set' }];
      } else if (text.includes('SELECT max(position)')) {
        rows = [{ max: 2 }];
      } else if (text.includes('INSERT INTO app.agent_result_deliveries')) {
        rows = [{ card_id: compiled.parameters[5] }];
      }
      return Promise.resolve(rows as T[]);
    },
  } as unknown as Queries;
  const deliveries = () =>
    statements
      .filter((s) => s.sql.includes('INSERT INTO app.agent_result_deliveries'))
      .map((s) => s.parameters);
  return { q, statements, deliveries };
}

const run = { app_id: APP, id: RUN, session_id: SESSION } as unknown as RunRow;
const session = { user_id: 'u', user_hash: 'h' } as unknown as SessionRow;

function productList(cardId: string, keys: readonly string[], first: number): CardInput {
  return {
    card_id: cardId,
    type: 'product_list',
    schema_version: 1,
    data: {
      result_set_id: SET,
      items: keys.map((key, i) => ({
        card_id: `c${String(first + i)}`,
        product_key: key,
        platform: 'jd',
        final_price_fen: 1990 + i,
        title: key,
      })),
    },
    fallback_text: '商品列表',
  };
}

function quote(cardId: string, productId: string): CardInput {
  return {
    card_id: cardId,
    type: 'rebate_quote',
    schema_version: 1,
    data: {
      product: {
        card_id: productId,
        product_key: 'jd:q',
        platform: 'jd',
        final_price_fen: 500,
      },
      rebate_fen: 12,
    },
    fallback_text: '返利报价',
  };
}

it('[AC-B3-08zc#4][BR-AI-19][BR-AI-05] 断线卡：商品容器与内嵌商品按正常回执的形状编号（c<容器+1+i>、无 card_id 的单品副本）', () => {
  const receipt = deliveryReceiptOf(productList('c1', ['jd:a', 'jd:b'], 2));
  expect(receipt).toEqual({
    kind: 'list',
    resultSetId: SET,
    items: [0, 1].map((i) => ({
      card_id: `c${String(2 + i)}`,
      product_key: i === 0 ? 'jd:a' : 'jd:b',
      platform: 'jd',
      final_price_fen: BigInt(1990 + i),
      card: {
        type: 'product_list',
        schema_version: 1,
        fallback_text: '商品列表',
        data: {
          result_set_id: SET,
          items: [
            {
              product_key: i === 0 ? 'jd:a' : 'jd:b',
              platform: 'jd',
              final_price_fen: 1990 + i,
              title: i === 0 ? 'jd:a' : 'jd:b',
            },
          ],
        },
      },
    })),
  });
  const quoted = deliveryReceiptOf(quote('c5', 'c6'));
  expect(quoted?.kind).toBe('quoted');
  expect(quoted?.items.map((item) => [item.card_id, item.card])).toEqual([
    [
      'c6',
      {
        type: 'rebate_quote',
        schema_version: 1,
        fallback_text: '返利报价',
        data: {
          product: { product_key: 'jd:q', platform: 'jd', final_price_fen: 500 },
          rebate_fen: 12,
        },
      },
    ],
  ]);
});

it('[AC-B3-08zc#4][BR-AI-19] 断线卡：负价、非法平台、缺 result_set_id、别的卡型都不产生下发记录', () => {
  const bad = productList('c1', ['jd:a'], 2);
  const negative = {
    ...bad,
    data: { ...bad.data, items: [{ product_key: 'jd:a', platform: 'jd', final_price_fen: -1 }] },
  };
  expect(deliveryReceiptOf(negative)).toBeNull();
  const platform = {
    ...bad,
    data: { ...bad.data, items: [{ product_key: 'jd:a', platform: 'x', final_price_fen: 1 }] },
  };
  expect(deliveryReceiptOf(platform)).toBeNull();
  expect(deliveryReceiptOf({ ...bad, data: { items: [] } })).toBeNull();
  expect(
    deliveryReceiptOf({
      card_id: 'c1',
      type: 'notice',
      schema_version: 1,
      data: {},
      fallback_text: 'n',
    }),
  ).toBeNull();
});

it('[AC-B3-08zc#4][BR-AI-19][BR-AI-05] 终态事务里只给断线卡补下发记录：已写帧的卡（已有回执）不重复写，引用的是本 run 的会话与结果集', async () => {
  const f = fakeQueries();
  const framed = productList('c1', ['jd:a'], 2);
  const offline = productList('c3', ['jd:b', 'jd:c'], 4);
  const offlineQuote = quote('c6', 'c7');
  await writeReply(
    f.q,
    run,
    session,
    { text: '好的', cards: [framed, offline, offlineQuote], unframed: ['c3', 'c6'] },
    NOW,
  );
  const rows = f.deliveries();
  expect(rows.map((p) => p[5])).toEqual(['c4', 'c5', 'c7']);
  for (const p of rows) {
    expect(p[0]).toBe(APP);
    expect(p[1]).toBe(SESSION);
    expect(p[2]).toBe(RUN);
  }
  // Positions continue after the set's current max (2), one per inserted row.
  expect(rows.slice(0, 2).map((p) => [p[3], p[4]])).toEqual([
    [SET, 3],
    [SET, 4],
  ]);
  expect(rows[2]?.[3]).toBe('quoted-set');
  // The quoted set is created like recordQuoted's (derived id, marker conditions).
  expect(f.statements.some((s) => s.sql.startsWith('INSERT INTO app.agent_result_sets'))).toBe(
    true,
  );
  // Every append takes the same advisory lock as store/results.
  const locks = f.statements.filter((s) => s.sql.includes('pg_advisory_xact_lock'));
  expect(locks.map((s) => s.parameters[0])).toEqual([
    JSON.stringify(['agent.result.deliveries', APP, SET]),
    JSON.stringify(['agent.result.deliveries', APP, 'quoted-set']),
  ]);
  // The reply itself is written first, cards included.
  const cardsInsert = f.statements.findIndex((s) => s.sql.includes('INSERT INTO app.agent_cards'));
  const firstDelivery = f.statements.findIndex((s) =>
    s.sql.includes('INSERT INTO app.agent_result_deliveries'),
  );
  expect(cardsInsert).toBeGreaterThanOrEqual(0);
  expect(firstDelivery).toBeGreaterThan(cardsInsert);
});

it('[AC-B3-08zc#4][BR-AI-19] 连线时（无断线卡）终态事务不写下发记录；结果集不属于本会话的断线卡也不写', async () => {
  const connected = fakeQueries();
  await writeReply(
    connected.q,
    run,
    session,
    { text: '', cards: [productList('c1', ['jd:a'], 2)], unframed: [] },
    NOW,
  );
  expect(connected.deliveries()).toEqual([]);
  expect(connected.statements.some((s) => s.sql.includes('agent_result_sets'))).toBe(false);

  const legacy = fakeQueries();
  await writeReply(
    legacy.q,
    run,
    session,
    { text: '', cards: [productList('c1', ['jd:a'], 2)] },
    NOW,
  );
  expect(legacy.deliveries()).toEqual([]);

  const foreign = fakeQueries({ setOwned: false });
  await writeReply(
    foreign.q,
    run,
    session,
    { text: '', cards: [productList('c1', ['jd:a'], 2)], unframed: ['c1'] },
    NOW,
  );
  expect(foreign.deliveries()).toEqual([]);
});

it('[AC-B3-08zc#4][BR-AI-22] 已与用户脱钩的会话：回复与下发记录都不写', async () => {
  const f = fakeQueries();
  await writeReply(
    f.q,
    run,
    { user_id: null, user_hash: 'h' } as unknown as SessionRow,
    { text: 'x', cards: [productList('c1', ['jd:a'], 2)], unframed: ['c1'] },
    NOW,
  );
  expect(f.statements).toEqual([]);
});

it('[AC-B3-08zc#4][BR-AI-19] 卡片 JSON 写库前清理：字符串（含键）去 NUL、半个代理对换成 U+FFFD；卡片与下发记录都写清理后的', async () => {
  const f = fakeQueries();
  const dirty = productList('c1', ['jd:a'], 2);
  const items = dirty.data['items'] as Record<string, unknown>[];
  const item = { ...items[0], title: 'a\u0000b\ud800c', ['k\u0000']: '\udc00' };
  const card: CardInput = {
    ...dirty,
    data: { ...dirty.data, items: [item] },
    fallback_text: '商品\u0000列表',
  };
  await writeReply(f.q, run, session, { text: '', cards: [card], unframed: ['c1'] }, NOW);
  const insert = f.statements.find((s) => s.sql.includes('INSERT INTO app.agent_cards'));
  const data = JSON.parse(insert?.parameters[6] as string) as Record<string, unknown>;
  const stored = (data['items'] as Record<string, unknown>[])[0];
  expect(stored?.['title']).toBe('ab\ufffdc');
  expect(stored?.['k']).toBe('\ufffd');
  expect(insert?.parameters[9]).toBe('商品列表');
  const record = JSON.parse(f.deliveries()[0]?.[9] as string) as {
    data: { items: Record<string, unknown>[] };
  };
  expect(record.data.items[0]?.['title']).toBe('ab\ufffdc');
  for (const s of f.statements) {
    for (const p of s.parameters) {
      if (typeof p === 'string') {
        expect(p.includes('\u0000')).toBe(false);
        expect(p.isWellFormed()).toBe(true);
      }
    }
  }
});

it('[AC-B3-08zc#4][BR-AI-19] agent_cards 约束不收的卡不写，记一条带 run_id 的 warn（不含卡片内容）', async () => {
  const f = fakeQueries();
  const warns: unknown[][] = [];
  const logger = { warn: (...args: unknown[]) => void warns.push(args) };
  const bad: CardInput = { ...productList('c1', ['jd:secret'], 2), fallback_text: '' };
  await writeReply(
    f.q,
    run,
    session,
    { text: '', cards: [bad, quote('c2', 'c3')], unframed: [] },
    NOW,
    logger as never,
  );
  const insert = f.statements.find((s) => s.sql.includes('INSERT INTO app.agent_cards'));
  expect(insert?.parameters).toContain('c2');
  expect(insert?.parameters).not.toContain('c1');
  expect(warns).toEqual([
    [{ run_id: RUN, card_type: 'product_list', card_id: 'c1' }, 'agent.reply_card_unstorable'],
  ]);
  expect(JSON.stringify(warns)).not.toContain('jd:secret');
});
