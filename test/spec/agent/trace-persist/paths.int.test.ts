// B3-08q · BR-AI-19: the production stream entry's no-model route (its model route is fixed to
// no_model) writes cards on the degraded keyword search and on the deterministic link path; both
// are persisted like the model path's, with the link ids of the link registrations inside the
// stored card data. Production stream entry of [AC-B3-08g] over real PG, no scripted model.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { openSession, usePgEach } from '../stream-mount/kit.ts';
import {
  KEYWORD,
  ask,
  cardTypesOf,
  demoUrl,
  expectCardsStored,
  finishOf,
  productionRig,
  runIdOf,
  type Row,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

/** Every string link_id at any depth of a card's data. */
function linkIdsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(linkIdsIn);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Row).flatMap(([key, inner]) =>
    key === 'link_id' && typeof inner === 'string' ? [inner] : linkIdsIn(inner),
  );
}

it('[AC-B3-08q#3][BR-AI-19] 降级路径（模型不可用走关键词搜索）：done fallback 的 run 写出的 product_list 落 agent_cards（card_id、数据与帧一致，app / session / run 正确），卡内各商品的 link_id 随卡数据落库', async () => {
  const x = await productionRig(pg.db);
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const frames = await ask(x, x.f.caller, sessionId, KEYWORD);
    expect(finishOf(frames)).toBe('fallback');
    expect(cardTypesOf(frames)).toEqual(['product_list']);
    const runId = runIdOf(frames);

    const rows = await expectCardsStored(pg.db, { appId: x.appId, sessionId, runId }, frames);
    const links = linkIdsIn(rows.map((row) => row.data));
    expect(links.length, 'link ids of the delivered products').toBeGreaterThan(0);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08q#3][BR-AI-19] 确定性路径（报价 runner，消息里是商品链接）：写出的 rebate_quote 落 agent_cards（card_id、数据与帧一致，app / session / run 正确），转链的 link_id 随卡数据落库', async () => {
  const x = await productionRig(pg.db);
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const url = await demoUrl(x);
    const frames = await ask(x, x.f.caller, sessionId, url);
    expect(finishOf(frames)).toBe('stop');
    expect(cardTypesOf(frames)).toEqual(['rebate_quote']);
    const runId = runIdOf(frames);

    const rows = await expectCardsStored(pg.db, { appId: x.appId, sessionId, runId }, frames);
    expect(linkIdsIn(rows.map((row) => row.data)).length).toBeGreaterThan(0);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08q#3][BR-AI-19] 同一会话先降级搜索、再发链接：两个 run 的卡各落在自己的 run 下，card_id 按会话递增不重号', async () => {
  const x = await productionRig(pg.db);
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const searched = await ask(x, x.f.caller, sessionId, KEYWORD);
    const quoted = await ask(x, x.f.caller, sessionId, await demoUrl(x));
    const searchRun = runIdOf(searched);
    const quoteRun = runIdOf(quoted);
    expect(searchRun).not.toBe(quoteRun);

    const first = await expectCardsStored(
      pg.db,
      { appId: x.appId, sessionId, runId: searchRun },
      searched,
    );
    const second = await expectCardsStored(
      pg.db,
      { appId: x.appId, sessionId, runId: quoteRun },
      quoted,
    );
    const ids = [...first, ...second].map((row) => row.card_id);
    expect(new Set(ids).size).toBe(ids.length);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);
