// B3-08l 同步 (ledger: worker 入口按 app 定时调用 syncRuleChunks；启动后先跑一轮；周期 300 秒代码常量；
// 停机先停、正在跑的一轮等完；单个 app 失败只记日志不影响其他 app). The runtime of
// apps/api/src/modules/agent/rag/chunks/worker.ts over real PG as couli_app, with content's real
// published-articles reader (built here as app.module builds it) and the app list stubbed:
// content's app list is published-apps.int.test.ts's, its wiring app-wiring.int.test.ts's.
// Time: a FixedClock; timers: the manual schedule seam (no fake timers with a real database).
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createAgentRuleSyncRuntime,
  type RuleSyncArticles,
} from '../../../../apps/api/src/modules/agent/index.ts';
import { createPublishedArticlesReader } from '../../../../apps/api/src/modules/content/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { LEVEL, Logs, usePgEach } from '../stream-mount/kit.ts';
import {
  ManualRuleSchedule,
  NOW,
  SYNC_INTERVAL_MS,
  appIdOf,
  chunkView,
  deferred,
  expectedChunks,
  insertArticle,
  pause,
  setArticleStatus,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

/** content's real reader over `db` with app.module's shape; apps() answered by the test. */
function articlesOf(db: Kysely<DB>, clock: FixedClock, apps: () => Promise<readonly string[]>) {
  const reader = createPublishedArticlesReader({ db, clock });
  const list = vi.fn<RuleSyncArticles['list']>((appId) => reader.list(appId));
  const listApps = vi.fn<RuleSyncArticles['apps']>(apps);
  const articles: RuleSyncArticles = { list, apps: listApps };
  return { articles, list, apps: listApps };
}

it('[AC-B3-08l#4][BR-AI-07] start 立即跑一轮（不等定时器）：apps() 的每个 app 的 active 块与其已发布 help / rule 文章一致（公告不切块）；只排一个 300 000 ms 的重复定时器；stop 等这一轮跑完、停掉定时器，迟到的触发不再同步', async () => {
  const clock = new FixedClock(NOW);
  const appA = appIdOf('a');
  const appB = appIdOf('b');
  const help = await insertArticle(pg.db, {
    appId: appA,
    category: 'help',
    title: '结算规则',
    texts: ['确认收货后返利进入待结算。', '结算后可提现。'],
  });
  const rule = await insertArticle(pg.db, {
    appId: appA,
    category: 'rule',
    title: '提现规则',
    texts: ['提现最低金额为一元。'],
  });
  await insertArticle(pg.db, { appId: appA, category: 'notice', title: '公告', texts: ['公告'] });
  const other = await insertArticle(pg.db, {
    appId: appB,
    category: 'help',
    title: '账号规则',
    texts: ['一个手机号只能绑定一个账号。'],
  });
  const logs = new Logs();
  const port = articlesOf(pg.db, clock, async () => [appB, appA]);
  const runtime = createAgentRuleSyncRuntime({
    db: pg.db,
    clock,
    logger: logs.logger,
    articles: port.articles,
  });
  expect(port.apps, 'building starts nothing').not.toHaveBeenCalled();

  const schedule = new ManualRuleSchedule();
  const loop = runtime.start({ schedule: schedule.schedule });

  // The first round begins without any firing; stop then waits for it to end.
  await vi.waitFor(() => expect(port.apps).toHaveBeenCalledTimes(1), {
    timeout: 20_000,
    interval: 20,
  });
  expect(schedule.sole().intervalMs).toBe(SYNC_INTERVAL_MS);
  await loop.stop();
  expect(port.apps).toHaveBeenCalledTimes(1);
  expect(schedule.sole().stopped, 'stop stops the timer').toBe(true);
  expect(await chunkView(pg.db, appA)).toEqual(expectedChunks([help, rule]));
  expect(await chunkView(pg.db, appB)).toEqual(expectedChunks([other]));
  expect(port.list.mock.calls.map(([appId]) => appId).sort()).toEqual([appA, appB].sort());

  // A firing already queued when stop ran: no new round.
  await schedule.fireLate();
  expect(port.apps).toHaveBeenCalledTimes(1);
  await loop.stop();
}, 120_000);

it('[AC-B3-08l#4][BR-AI-07] 定时器到点再跑一轮：新发布的版本写入、上一版与下线文章的块置 retired，active 块再次与已发布文章一致', async () => {
  const clock = new FixedClock(NOW);
  const appA = appIdOf('a');
  const help = await insertArticle(pg.db, {
    appId: appA,
    title: '结算规则',
    texts: ['旧版说明。'],
  });
  const rule = await insertArticle(pg.db, {
    appId: appA,
    category: 'rule',
    title: '提现规则',
    texts: ['提现最低金额为一元。'],
  });
  const port = articlesOf(pg.db, clock, async () => [appA]);
  const runtime = createAgentRuleSyncRuntime({
    db: pg.db,
    clock,
    logger: new Logs().logger,
    articles: port.articles,
  });
  const schedule = new ManualRuleSchedule();
  const loop = runtime.start({ schedule: schedule.schedule });
  try {
    await vi.waitFor(
      async () => {
        expect(await chunkView(pg.db, appA)).toEqual(expectedChunks([help, rule]));
      },
      { timeout: 20_000, interval: 50 },
    );

    const next = await insertArticle(pg.db, {
      appId: appA,
      id: help.id,
      version: 2,
      title: '结算规则',
      texts: ['新版说明。'],
    });
    await setArticleStatus(pg.db, rule.id, 'offline');
    // A firing while the first round still finishes does nothing; fire until the second round ran
    // (each firing resolves once the round it started is over).
    await vi.waitFor(
      async () => {
        await schedule.fire();
        expect(port.apps).toHaveBeenCalledTimes(2);
      },
      { timeout: 20_000, interval: 50 },
    );
    expect(await chunkView(pg.db, appA)).toEqual(expectedChunks([next]));
    expect(await chunkView(pg.db, appA, 'retired')).toEqual(expectedChunks([help, rule]));
  } finally {
    await loop.stop();
  }
}, 120_000);

it('[AC-B3-08l#5] 单个 app 同步失败只记一条 warn（agent_rule_sync_app_failed，带 app_id），其他 app 照常同步；syncOnce 不拒绝，按 app id 升序报 synced / failed', async () => {
  const clock = new FixedClock(NOW);
  const appA = appIdOf('a');
  const appB = appIdOf('b');
  const broken = appIdOf('c');
  const a = await insertArticle(pg.db, { appId: appA, title: '结算规则', texts: ['甲。'] });
  const b = await insertArticle(pg.db, { appId: appB, title: '结算规则', texts: ['乙。'] });
  await insertArticle(pg.db, { appId: broken, title: '结算规则', texts: ['丙。'] });
  const logs = new Logs();
  const port = articlesOf(pg.db, clock, async () => [broken, appB, appA]);
  const real = port.list.getMockImplementation()!;
  port.list.mockImplementation((appId) =>
    appId === broken ? Promise.reject(new Error('synthetic-articles-read-failed')) : real(appId),
  );
  const runtime = createAgentRuleSyncRuntime({
    db: pg.db,
    clock,
    logger: logs.logger,
    articles: port.articles,
  });

  const round = await runtime.syncOnce();
  expect(round).toEqual({ synced: [appA, appB], failed: [broken] });
  expect(await chunkView(pg.db, appA)).toEqual(expectedChunks([a]));
  expect(await chunkView(pg.db, appB)).toEqual(expectedChunks([b]));
  expect(await chunkView(pg.db, broken)).toEqual([]);
  const failures = logs.of('agent_rule_sync_app_failed');
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ level: LEVEL.warn, app_id: broken });

  // The next round tries the failed app again and leaves the others as they are.
  port.list.mockImplementation(real);
  expect(await runtime.syncOnce()).toEqual({ synced: [appA, appB, broken].sort(), failed: [] });
  expect(await chunkView(pg.db, appA)).toEqual(expectedChunks([a]));
}, 120_000);

it('[AC-B3-08l#5] apps() 拒绝时只记一条 warn（agent_rule_sync_failed），syncOnce 不拒绝、这一轮不同步任何 app；下一轮照常同步', async () => {
  const clock = new FixedClock(NOW);
  const appA = appIdOf('a');
  const article = await insertArticle(pg.db, { appId: appA, title: '结算规则', texts: ['甲。'] });
  const logs = new Logs();
  const port = articlesOf(pg.db, clock, async () => [appA]);
  port.apps.mockImplementationOnce(() => Promise.reject(new Error('synthetic-apps-read-failed')));
  const runtime = createAgentRuleSyncRuntime({
    db: pg.db,
    clock,
    logger: logs.logger,
    articles: port.articles,
  });

  expect(await runtime.syncOnce()).toEqual({ synced: [], failed: [] });
  expect(port.list).not.toHaveBeenCalled();
  expect(await chunkView(pg.db, appA)).toEqual([]);
  const failures = logs.of('agent_rule_sync_failed');
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ level: LEVEL.warn });
  expect(logs.of('agent_rule_sync_app_failed')).toEqual([]);

  // The next round reads the app list again and syncs as usual.
  expect(await runtime.syncOnce()).toEqual({ synced: [appA], failed: [] });
  expect(await chunkView(pg.db, appA)).toEqual(expectedChunks([article]));
  expect(logs.of('agent_rule_sync_failed')).toHaveLength(1);
}, 120_000);

it('[AC-B3-08l#4][BR-AI-07] 某 app 的帮助 / 规则文章全部下线后 apps() 不再列它：一轮仍同步该 app（它在 agent_rule_chunks 有 active 块），其块全部置 retired', async () => {
  const clock = new FixedClock(NOW);
  const appD = appIdOf('d');
  const article = await insertArticle(pg.db, { appId: appD, title: '结算规则', texts: ['丁。'] });
  let listed: readonly string[] = [appD];
  const port = articlesOf(pg.db, clock, async () => listed);
  const runtime = createAgentRuleSyncRuntime({
    db: pg.db,
    clock,
    logger: new Logs().logger,
    articles: port.articles,
  });
  expect(await runtime.syncOnce()).toEqual({ synced: [appD], failed: [] });
  expect(await chunkView(pg.db, appD)).toEqual(expectedChunks([article]));

  await setArticleStatus(pg.db, article.id, 'offline');
  listed = [];
  expect(await runtime.syncOnce()).toEqual({ synced: [appD], failed: [] });
  expect(await chunkView(pg.db, appD)).toEqual([]);
  expect(await chunkView(pg.db, appD, 'retired')).toEqual(expectedChunks([article]));
}, 120_000);

it('[AC-B3-08l#4] 轮次不重叠：一轮未完时定时器触发不另起一轮；stop 等正在跑的一轮结束才 resolve，之后迟到的触发也不再同步', async () => {
  const clock = new FixedClock(NOW);
  const gate = deferred<readonly string[]>();
  const port = articlesOf(pg.db, clock, async () => []);
  port.apps.mockImplementationOnce(() => gate.promise);
  const runtime = createAgentRuleSyncRuntime({
    db: pg.db,
    clock,
    logger: new Logs().logger,
    articles: port.articles,
  });
  const schedule = new ManualRuleSchedule();
  const loop = runtime.start({ schedule: schedule.schedule });
  await vi.waitFor(() => expect(port.apps).toHaveBeenCalledTimes(1), {
    timeout: 20_000,
    interval: 20,
  });

  await schedule.fire();
  expect(port.apps, 'no second round while the first runs').toHaveBeenCalledTimes(1);

  let stopped = false;
  const stopping = loop.stop().then(() => {
    stopped = true;
  });
  await pause();
  expect(schedule.sole().stopped).toBe(true);
  expect(stopped, 'stop waits for the round in flight').toBe(false);
  gate.resolve([]);
  await stopping;
  expect(stopped).toBe(true);

  await schedule.fireLate();
  expect(port.apps).toHaveBeenCalledTimes(1);
}, 120_000);
