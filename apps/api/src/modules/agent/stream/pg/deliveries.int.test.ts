// B3-08zc · BR-AI-19 细则「助手回复落库」, BR-AI-05, over real PostgreSQL: a client
// that goes away before a card is framed, the run ending within the disconnect grace. RunManager
// on createPgRunPorts (the live tail: settle's terminal transaction with the reply), the result
// store of the next round built anew (createPgResultSetStore). The search itself is not run: the
// test saves the result set as the search would (conditionsOf) and hands the card
// to the run as the orchestrator would. Synthetic values only; the scheduler never fires on its
// own, so the grace never runs out.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import type { Scheduler } from '../../../platform/index.ts';
import { conditionsOf, newChainId } from '../../orchestrator/results/shared.ts';
import type { SearchConditions } from '../../orchestrator/results/types.ts';
import { createPgResultSetStore } from '../../store/results/index.ts';
import type { AdmissionLimits, RedactedText } from '../admission/index.ts';
import { createRunManager, runConfigDefaults } from '../run/index.ts';
import type { RunBody, RunSink, UnnumberedCard } from '../run/index.ts';
import { createPgRunPorts } from './index.ts';

const APP = 'couli';
const START = '2026-10-06T10:00:00+08:00';
const LIMITS: AdmissionLimits = {
  memberDaily: 100,
  guestDaily: 100,
  guestIpDaily: 100,
  perMinute: 100,
  maxRounds: 100,
};

let database: TestDatabase | undefined;
let pool: Kysely<DB> | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  pool = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);

afterAll(async () => {
  if (pool) await destroyDb(pool);
  if (database) await database.drop();
});

function db(): Kysely<DB> {
  if (pool === undefined) throw new Error('database not ready');
  return pool;
}

type Row = Record<string, unknown>;

/** A device-owned session started 1 s before START. */
async function newSession(): Promise<string> {
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const at = new Date(Date.parse(START) - 1_000);
  await sql`INSERT INTO app.devices
    (id, app_id, install_secret_cipher, device_hash, id_source, platform, app_version, last_seen_at)
    VALUES (${deviceId}, ${APP}, ${Buffer.from('synthetic-install-secret')},
      ${deviceId.replaceAll('-', '').repeat(2)}, 'idfv', 'ios', 'synthetic@1', ${at})`.execute(
    db(),
  );
  await sql`INSERT INTO app.agent_sessions (id, app_id, device_id, started_at, last_active_at)
    VALUES (${sessionId}, ${APP}, ${deviceId}, ${at}, ${at})`.execute(db());
  return sessionId;
}

/** Waits never end on their own; only an abort rejects them. */
const idle: Scheduler = {
  now: () => 0,
  sleep: (_ms, signal) =>
    new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
};

/** A client connection: close() is the client going away (every later write throws). */
class Client implements RunSink {
  readonly chunks: string[] = [];
  #closed = false;
  #listeners: (() => void)[] = [];
  write(chunk: string): void {
    if (this.#closed) throw new Error('socket closed');
    this.chunks.push(chunk);
  }
  onClose(listener: () => void): void {
    this.#listeners.push(listener);
  }
  close(): void {
    this.#closed = true;
    for (const listener of this.#listeners) listener();
  }
  events(): string[] {
    return this.chunks.map((chunk) => /^event: ([a-z.]+)\n/.exec(chunk)?.[1] ?? '?');
  }
}

function rig() {
  const clock = new FixedClock(START);
  const ports = createPgRunPorts({
    db: db(),
    clock,
    timings: { runMaxMs: 20_000, lockGraceMs: 30_000, cancelPgPollMs: 2_000 },
    limits: { current: () => Promise.resolve({ ...LIMITS }) },
    texts: { errorMsg: (code) => `错误提示-${String(code)}` },
  });
  // Card numbers of the session: c1 is taken by the first round's delivery below.
  let next = 2;
  const manager = createRunManager({
    admission: ports.admission,
    registry: ports.registry,
    cards: {
      reserve: (_sessionId, count) => {
        const first = next;
        next += count;
        return Promise.resolve(first);
      },
    },
    texts: { text: () => '本轮超时', errorMsg: (code) => `错误提示-${String(code)}` },
    guard: { check: () => Promise.resolve(null) },
    clock,
    scheduler: idle,
    config: runConfigDefaults(),
  });
  return { ports, manager };
}

type Rig = ReturnType<typeof rig>;

/** Admits one run in `sessionId` and runs `body` on `client`; resolves the run id and its end. */
async function round(x: Rig, sessionId: string, client: Client, body: (runId: string) => RunBody) {
  const userId = randomUUID();
  const assistantMessageId = randomUUID();
  const runId = randomUUID();
  const text = '合成提问' as RedactedText;
  const admitted = await x.ports.admission.admit(
    {
      sessionId,
      clientMsgId: `m-${randomUUID()}`,
      runId,
      messageId: randomUUID(),
      subject: { tier: 'member', userId },
      reply: {
        assistantMessageId,
        promptVersion: 'synthetic-prompt@1',
        modelSnapshot: null,
        runUserText: text,
        messageText: text,
      },
    },
    LIMITS,
  );
  if (admitted.kind !== 'accepted') throw new Error(`not accepted: ${admitted.kind}`);
  const final = await x.manager.start(
    {
      ticket: admitted.ticket,
      ownerKey: `u:${userId}`,
      limits: LIMITS,
      meta: {
        message_id: assistantMessageId,
        prompt_version: 'synthetic-prompt@1',
        model_label: '演示模型',
        ai_label: '内容由 AI 生成，仅供参考',
      },
      sink: client,
    },
    body(runId),
  );
  return { runId, final };
}

function item(n: number, title = `合成商品 ${String(n)}`): Row {
  return {
    product_key: `jd:synthetic-${String(n)}`,
    item_ref: `synthetic-item-ref-${String(n)}`,
    platform: 'jd',
    shop_type: null,
    title,
    image: `https://example.com/images/synthetic-${String(n)}.png`,
    shop_name: '合成旗舰店',
    price_fen: 6990,
    coupon_fen: 1000,
    final_price_fen: 5990 + n,
    est_net_price_fen: 5790,
    rebate_min_fen: 200,
    rebate_max_fen: 200,
    rebate_basis: 'normal',
    benefit_tags: [],
    match_tag: 'matched',
    spec_text: null,
    is_presale: false,
    tlj: null,
    link_id: randomUUID(),
    cta: { text_key: 'btn.buy.rebate' },
    quoted_at: START,
    stale: false,
    age_sec: 3,
    source: 'jd_union',
    disclaimer_keys: ['price_basis', 'rebate_estimate'],
    ad_label: null,
    availability: 'ok',
  };
}

function productList(
  resultSetId: string,
  items: readonly Row[],
  fallback = '找到合成商品',
): UnnumberedCard {
  return {
    type: 'product_list',
    schema_version: 1,
    data: { result_set_id: resultSetId, items: items.map((i) => ({ ...i })), layout: 'list' },
    fallback_text: fallback,
  } as unknown as UnnumberedCard;
}

function quote(product: Row): UnnumberedCard {
  return {
    type: 'rebate_quote',
    schema_version: 1,
    data: {
      product: { ...product },
      material: null,
      tlj_kind: 'unknown',
    },
    fallback_text: '已查到合成商品的返利',
  } as unknown as UnnumberedCard;
}

/** What a search saves for its product_list (tools.ts / keyword.ts: conditionsOf on a new chain). */
function searchConditions(q: string): SearchConditions {
  const conditions = conditionsOf(
    { q, platforms: ['jd'], sort: 'relevance', page: 1 },
    newChainId(),
  );
  if (conditions === null) throw new Error('no conditions');
  return conditions;
}

/**
 * Round 1 (client connected): a search whose list got its receipt — set K1 saved, its product
 * delivered as c1, as the orchestrator's receipt writes.
 */
async function firstRound(x: Rig, sessionId: string): Promise<void> {
  const k1 = searchConditions('合成保温杯');
  const store = createPgResultSetStore({ db: db() });
  const client = new Client();
  const { final } = await round(x, sessionId, client, (runId) => async () => {
    const setId = randomUUID();
    await store.save({ id: setId, appId: APP, sessionId, runId, conditions: k1 });
    await store.recordDelivered(setId, [
      {
        card_id: 'c1',
        product_key: 'jd:synthetic-k1',
        platform: 'jd',
        final_price_fen: 1990,
        card: { type: 'product_list', schema_version: 1, data: {}, fallback_text: '合成' },
      },
    ]);
    return { kind: 'done', finishReason: 'stop' };
  });
  expect(final.terminal?.event).toBe('done');
}

/** Round 2: the client goes away right after meta; the body then hands `cards` to the run. */
async function disconnectedRound(
  x: Rig,
  sessionId: string,
  cards: (runId: string) => Promise<readonly UnnumberedCard[]>,
) {
  const client = new Client();
  const result = await round(x, sessionId, client, (runId) => async (ctx) => {
    client.close();
    for (const card of await cards(runId)) await ctx.card(card);
    return { kind: 'done', finishReason: 'stop' };
  });
  return { ...result, client };
}

async function rowsOf(query: RawBuilder<Row>): Promise<Row[]> {
  return (await query.execute(db())).rows;
}

it('[AC-B3-08zc#4][BR-AI-19][BR-AI-05] 断线（商品列表下发前客户端断开，宽限期内跑完）：终态后有下发记录（position、run_id、卡片形状同正常回执）；下一轮新组装按 card_id 能解析', async () => {
  const x = rig();
  const sessionId = await newSession();
  await firstRound(x, sessionId);

  const k2 = searchConditions('合成登山包');
  const setId = randomUUID();
  const items = [item(1), item(2)];
  const { runId, final, client } = await disconnectedRound(x, sessionId, async (run) => {
    await createPgResultSetStore({ db: db() }).save({
      id: setId,
      appId: APP,
      sessionId,
      runId: run,
      conditions: k2,
    });
    return [productList(setId, items)];
  });

  // The run ended as usual and its terminal state is committed; only meta reached the client.
  expect(final.terminal).toMatchObject({ event: 'done', data: { finish_reason: 'stop' } });
  expect(client.events()).toEqual(['meta']);
  const [run] = await rowsOf(sql<Row>`SELECT final_event FROM app.agent_runs WHERE id = ${runId}`);
  expect(run?.['final_event']).not.toBeNull();

  // The list took c2, its items c3 and c4: their delivery records, as the receipt writes them.
  const deliveries = await rowsOf(sql<Row>`SELECT card_id, position, run_id::text AS run_id,
      session_id::text AS session_id, product_key, platform, final_price_fen::text AS fen, card
    FROM app.agent_result_deliveries WHERE result_set_id = ${setId}::uuid ORDER BY position`);
  expect(
    deliveries.map((d) => [d['card_id'], d['position'], d['run_id'], d['session_id']]),
  ).toEqual([
    ['c3', 1, runId, sessionId],
    ['c4', 2, runId, sessionId],
  ]);
  expect(deliveries.map((d) => [d['product_key'], d['platform'], d['fen']])).toEqual([
    ['jd:synthetic-1', 'jd', '5991'],
    ['jd:synthetic-2', 'jd', '5992'],
  ]);
  for (const [index, d] of deliveries.entries()) {
    expect(d['card']).toEqual({
      type: 'product_list',
      schema_version: 1,
      fallback_text: '找到合成商品',
      data: { result_set_id: setId, items: [items[index]], layout: 'list' },
    });
  }

  // Next round, assembled anew: the card_id resolves, and the latest list is this search's.
  const next = createPgResultSetStore({ db: db() });
  const found = await next.findDelivered(APP, sessionId, 'c4');
  expect(found).toMatchObject({
    card_id: 'c4',
    product_key: 'jd:synthetic-2',
    final_price_fen: 5992,
  });
  const latest = await next.latestWithProducts(APP, sessionId);
  expect(latest?.id).toBe(setId);
}, 60_000);

it('[AC-B3-08zc#4][BR-AI-19][BR-AI-05] 断线后的报价卡：终态后在本 run 的报价结果集下有下发记录、下一轮按 card_id 能解析', async () => {
  const x = rig();
  const sessionId = await newSession();
  await firstRound(x, sessionId);

  const product = item(7);
  const { runId, final } = await disconnectedRound(x, sessionId, () =>
    Promise.resolve([quote(product)]),
  );
  expect(final.terminal).toMatchObject({ event: 'done', data: { finish_reason: 'stop' } });

  // The quote took c2, its product c3: in the run's quoted set (recordQuoted's id and marker).
  const deliveries = await rowsOf(sql<Row>`SELECT d.card_id, d.position, d.run_id::text AS run_id,
      d.card, s.conditions
    FROM app.agent_result_deliveries d
    JOIN app.agent_result_sets s ON s.app_id = d.app_id AND s.id = d.result_set_id
    WHERE d.session_id = ${sessionId}::uuid AND d.run_id = ${runId}::uuid
      AND d.result_set_id = md5(${'agent.result.quoted:'}::text || ${runId}::uuid::text)::uuid`);
  expect(deliveries.map((d) => [d['card_id'], d['position'], d['run_id']])).toEqual([
    ['c3', 1, runId],
  ]);
  expect(deliveries[0]?.['conditions']).toEqual({ receipt: 'rebate_quote' });
  expect(deliveries[0]?.['card']).toEqual({
    type: 'rebate_quote',
    schema_version: 1,
    fallback_text: '已查到合成商品的返利',
    data: { product, material: null, tlj_kind: 'unknown' },
  });
  const found = await createPgResultSetStore({ db: db() }).findDelivered(APP, sessionId, 'c3');
  expect(found).toMatchObject({ card_id: 'c3', product_key: 'jd:synthetic-7' });
}, 60_000);

it('[AC-B3-08zc#4][BR-AI-19] 卡片字符串带 \\u0000 与半个代理对：终态照常提交、终止帧照发，存下的卡片与下发记录已清理', async () => {
  const dirtyTitle = '合成\u0000商品\ud800尾';
  const cleanTitle = '合成商品�尾';

  // Connected: the terminal frame goes out, the stored card is cleaned.
  {
    const x = rig();
    const sessionId = await newSession();
    const client = new Client();
    const { runId, final } = await round(x, sessionId, client, () => async (ctx) => {
      await ctx.card(productList(randomUUID(), [item(1, dirtyTitle)], '找到\u0000合成商品'));
      return { kind: 'done', finishReason: 'stop' };
    });
    expect(final.terminal).toMatchObject({ event: 'done', data: { finish_reason: 'stop' } });
    expect(client.events()).toEqual(['meta', 'card', 'done']);
    const cards = await rowsOf(sql<Row>`SELECT card_id, data, fallback_text FROM app.agent_cards
      WHERE run_id = ${runId}::uuid`);
    expect(cards.map((c) => [c['card_id'], c['fallback_text']])).toEqual([['c2', '找到合成商品']]);
    const data = cards[0]?.['data'] as { items: Row[] };
    expect(data.items[0]?.['title']).toBe(cleanTitle);
  }

  // Disconnected: the delivery record is cleaned too.
  {
    const x = rig();
    const sessionId = await newSession();
    const setId = randomUUID();
    const { runId, final } = await disconnectedRound(x, sessionId, async (run) => {
      await createPgResultSetStore({ db: db() }).save({
        id: setId,
        appId: APP,
        sessionId,
        runId: run,
        conditions: searchConditions('合成水杯'),
      });
      return [productList(setId, [item(1, dirtyTitle)])];
    });
    expect(final.terminal).toMatchObject({ event: 'done', data: { finish_reason: 'stop' } });
    const [run] = await rowsOf(
      sql<Row>`SELECT final_event FROM app.agent_runs WHERE id = ${runId}`,
    );
    expect(run?.['final_event']).not.toBeNull();
    const [stored] = await rowsOf(sql<Row>`SELECT data FROM app.agent_cards
      WHERE run_id = ${runId}::uuid`);
    expect((stored?.['data'] as { items: Row[] }).items[0]?.['title']).toBe(cleanTitle);
    const [delivery] = await rowsOf(sql<Row>`SELECT card FROM app.agent_result_deliveries
      WHERE result_set_id = ${setId}::uuid`);
    const card = delivery?.['card'] as { data: { items: Row[] } };
    expect(card.data.items[0]?.['title']).toBe(cleanTitle);
  }
}, 60_000);
