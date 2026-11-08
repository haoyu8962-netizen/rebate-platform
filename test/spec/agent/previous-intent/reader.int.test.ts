// B3-08w · BR-AI-01 细则「判定顺序」②, BR-AI-20, BR-AI-19 (D10-1022 ④「上一轮」): the reader of the
// previous run's intent, agent/store/runs createPgPreviousIntentReader, over real PG (contract in
// ./kit.ts). Rows are written by the fixture; the reader only reads.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createPgPreviousIntentReader } from '../../../../apps/api/src/modules/agent/store/runs/index.ts';
import { usePgEach } from '../stream-mount/kit.ts';
import {
  APP,
  OTHER_APP,
  OTHER_INTENTS,
  READ_FAILURE,
  addRun,
  newSessionRow,
  watchedDb,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);

it.each(['order_query', 'earnings_query'] as const)(
  '[AC-B3-08w#1][BR-AI-01] 同 app 同会话紧挨的上一 run 的 intent=%s → 原样返回',
  async (intent) => {
    const sessionId = await newSessionRow(pg.db);
    await addRun(pg.db, sessionId, 1, intent);
    const runId = await addRun(pg.db, sessionId, 2, null);
    const reader = createPgPreviousIntentReader({ db: pg.db });
    expect(await reader.previousIntent({ appId: APP, sessionId, runId })).toBe(intent);
  },
  120_000,
);

it.each([...OTHER_INTENTS, null])(
  '[AC-B3-08w#2][BR-AI-01] 紧挨的上一 run 的 intent=%s（不是 order_query / earnings_query，含 NULL）→ null',
  async (intent) => {
    const sessionId = await newSessionRow(pg.db);
    await addRun(pg.db, sessionId, 1, intent);
    const runId = await addRun(pg.db, sessionId, 2, null);
    const reader = createPgPreviousIntentReader({ db: pg.db });
    expect(await reader.previousIntent({ appId: APP, sessionId, runId })).toBeNull();
  },
  120_000,
);

it('[AC-B3-08w#3][BR-AI-01] 本轮自己不算上一轮：会话里只有本 run（受理时已插入，intent 不论是什么）→ null', async () => {
  const reader = createPgPreviousIntentReader({ db: pg.db });
  for (const intent of ['order_query', 'earnings_query', null] as const) {
    const sessionId = await newSessionRow(pg.db);
    const runId = await addRun(pg.db, sessionId, 1, intent);
    expect(
      await reader.previousIntent({ appId: APP, sessionId, runId }),
      `only run ${String(intent)}`,
    ).toBeNull();
  }
}, 120_000);

it('[AC-B3-08w#4][BR-AI-01] 只看紧挨的上一 run、不往前跳：order_query 之后隔了一轮 search 或 intent 为 NULL 的 run → null；更早的 search 之后紧挨 order_query → order_query', async () => {
  const reader = createPgPreviousIntentReader({ db: pg.db });
  for (const between of ['search', null] as const) {
    const sessionId = await newSessionRow(pg.db);
    await addRun(pg.db, sessionId, 1, 'order_query');
    await addRun(pg.db, sessionId, 2, between);
    const runId = await addRun(pg.db, sessionId, 3, null);
    expect(
      await reader.previousIntent({ appId: APP, sessionId, runId }),
      `order_query, then ${String(between)}`,
    ).toBeNull();
  }
  const sessionId = await newSessionRow(pg.db);
  await addRun(pg.db, sessionId, 1, 'search');
  await addRun(pg.db, sessionId, 2, 'order_query');
  const runId = await addRun(pg.db, sessionId, 3, null);
  expect(await reader.previousIntent({ appId: APP, sessionId, runId })).toBe('order_query');
}, 120_000);

it('[AC-B3-08w#5][BR-AI-01] 「上一轮」按本 run 的 accepted_at 往前取：本 run 之后受理的 run 不算（即使是 order_query），本 run 自己的 intent 也不算', async () => {
  const sessionId = await newSessionRow(pg.db);
  await addRun(pg.db, sessionId, 1, 'earnings_query');
  const runId = await addRun(pg.db, sessionId, 2, 'order_query');
  await addRun(pg.db, sessionId, 3, 'order_query');
  const reader = createPgPreviousIntentReader({ db: pg.db });
  expect(await reader.previousIntent({ appId: APP, sessionId, runId })).toBe('earnings_query');
}, 120_000);

it('[AC-B3-08w#18][BR-AI-01] 「早于本轮」是严格的：同会话另一 run 与本 run 的 accepted_at 相同（即使是 order_query）不算——只有它 → null；更早还有一轮 earnings_query → earnings_query', async () => {
  const reader = createPgPreviousIntentReader({ db: pg.db });
  for (const intent of ['order_query', 'earnings_query'] as const) {
    const sessionId = await newSessionRow(pg.db);
    await addRun(pg.db, sessionId, 2, intent);
    const runId = await addRun(pg.db, sessionId, 2, null);
    expect(
      await reader.previousIntent({ appId: APP, sessionId, runId }),
      `a ${intent} run accepted at the same instant`,
    ).toBeNull();
  }

  const sessionId = await newSessionRow(pg.db);
  await addRun(pg.db, sessionId, 1, 'earnings_query');
  await addRun(pg.db, sessionId, 2, 'order_query');
  const runId = await addRun(pg.db, sessionId, 2, null);
  expect(
    await reader.previousIntent({ appId: APP, sessionId, runId }),
    'earnings_query earlier, order_query at the same instant',
  ).toBe('earnings_query');
}, 120_000);

it('[AC-B3-08w#6][BR-AI-01] 不设时间窗：上一 run 在 30 天前受理，紧挨本 run 且为 order_query → order_query', async () => {
  const sessionId = await newSessionRow(pg.db);
  await addRun(pg.db, sessionId, 1, 'order_query');
  const runId = await addRun(pg.db, sessionId, 1 + 30 * 24 * 60, null);
  const reader = createPgPreviousIntentReader({ db: pg.db });
  expect(await reader.previousIntent({ appId: APP, sessionId, runId })).toBe('order_query');
}, 120_000);

it('[AC-B3-08w#7][BR-AI-20] 别的会话不算：另一会话里更晚受理的 order_query 不承接（本会话无上一轮 → null；本会话上一轮是 search → null）', async () => {
  const reader = createPgPreviousIntentReader({ db: pg.db });
  const other = await newSessionRow(pg.db);
  await addRun(pg.db, other, 5, 'order_query');

  const alone = await newSessionRow(pg.db);
  const aloneRun = await addRun(pg.db, alone, 6, null);
  expect(
    await reader.previousIntent({ appId: APP, sessionId: alone, runId: aloneRun }),
    'no previous run in this session',
  ).toBeNull();

  const sessionId = await newSessionRow(pg.db);
  await addRun(pg.db, sessionId, 1, 'search');
  const runId = await addRun(pg.db, sessionId, 6, null);
  expect(
    await reader.previousIntent({ appId: APP, sessionId, runId }),
    'previous run of this session is search',
  ).toBeNull();
}, 120_000);

it('[AC-B3-08w#8][BR-AI-20] 别的 app 不算：以另一 app 的 appId 问本会话（上一轮 order_query）→ null；以本 app 问 → order_query', async () => {
  const sessionId = await newSessionRow(pg.db);
  await addRun(pg.db, sessionId, 1, 'order_query');
  const runId = await addRun(pg.db, sessionId, 2, null);
  const reader = createPgPreviousIntentReader({ db: pg.db });
  expect(await reader.previousIntent({ appId: OTHER_APP, sessionId, runId })).toBeNull();
  expect(await reader.previousIntent({ appId: APP, sessionId, runId })).toBe('order_query');
}, 120_000);

it('[AC-B3-08w#9][BR-AI-20] sessionId 不是 uuid → null，且不发任何查询', async () => {
  const watched = watchedDb(pg.db);
  const reader = createPgPreviousIntentReader({ db: watched.db });
  const uuid = randomUUID();
  for (const sessionId of ['not-a-uuid', '', `${uuid}x`, ' ', "' OR 1=1 --"]) {
    expect(
      await reader.previousIntent({ appId: APP, sessionId, runId: randomUUID() }),
      `session ${JSON.stringify(sessionId)}`,
    ).toBeNull();
  }
  expect(watched.seen.queries, 'queries sent').toBe(0);
}, 120_000);

it('[AC-B3-08w#10][BR-AI-19] 读库出错 → previousIntent 以该数据库错误拒绝（由装配层记 warn 并按 null 处理）', async () => {
  const sessionId = await newSessionRow(pg.db);
  await addRun(pg.db, sessionId, 1, 'order_query');
  const runId = await addRun(pg.db, sessionId, 2, null);
  const watched = watchedDb(pg.db, true);
  const reader = createPgPreviousIntentReader({ db: watched.db });
  await expect(reader.previousIntent({ appId: APP, sessionId, runId })).rejects.toThrow(
    READ_FAILURE,
  );
  expect(watched.seen.queries, 'the read was attempted').toBeGreaterThan(0);
}, 120_000);

it('[AC-B3-08w#11][BR-AI-19] 只读：previousIntent 不改任何 agent_runs 行', async () => {
  const sessionId = await newSessionRow(pg.db);
  await addRun(pg.db, sessionId, 1, 'order_query');
  const runId = await addRun(pg.db, sessionId, 2, null);
  const snapshot = () =>
    pg.db
      .selectFrom('agent_runs')
      .selectAll()
      .where('session_id', '=', sessionId)
      .orderBy('accepted_at')
      .execute();
  const before = await snapshot();
  const reader = createPgPreviousIntentReader({ db: pg.db });
  expect(await reader.previousIntent({ appId: APP, sessionId, runId })).toBe('order_query');
  expect(await snapshot()).toEqual(before);
}, 120_000);
