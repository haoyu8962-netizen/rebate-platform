// B3-08l 同步的真实装配：the real `worker` AppModule (bootstrap.createWorkerContext, loaded by URL as
// the B3-03h / B3-08g module tests do; the job queue a no-op) over real PG as couli_app. app.module
// (the composition root) builds content's published-articles reader and the app list
// (agentRuleArticlesToken(), D10-294 / D10-386) and AgentModule.forWorker's runtime behind
// agentRuleSyncToken() syncs, in one round, every app that has a published help / rule article.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import {
  agentRuleSyncToken,
  type AgentRuleSyncRuntime,
} from '../../../../apps/api/src/modules/agent/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { Logs, usePgEach } from '../stream-mount/kit.ts';
import { NOW, appIdOf, chunkView, expectedChunks, insertArticle } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

interface WorkerContext {
  get(token: unknown, options: { strict: boolean }): unknown;
  close(): Promise<void>;
}

/** The real worker context over pg.db (never closing the test's pool), JOB_QUEUE a no-op. */
async function bootWorker(clock: FixedClock, logs: Logs): Promise<WorkerContext> {
  const src = (path: string) => new URL(`../../../../apps/api/src/${path}`, import.meta.url).href;
  const boot = (await import(src('bootstrap.ts'))) as {
    createWorkerContext(entry: string, overrides: object): Promise<WorkerContext>;
  };
  const platform = (await import(src('modules/platform/index.ts'))) as {
    JOB_QUEUE: symbol;
    loadConfig(env: Record<string, string>): unknown;
    PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
  };
  const original = platform.PlatformModule.forRoot.bind(platform.PlatformModule);
  vi.spyOn(platform.PlatformModule, 'forRoot').mockImplementation((value) => {
    const module = original(value);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === platform.JOB_QUEUE
          ? {
              provide: platform.JOB_QUEUE,
              useValue: {
                send: async () => null,
                register: vi.fn(),
                start: async () => undefined,
                stop: async () => undefined,
              },
            }
          : provider,
      ),
    };
  });
  return boot.createWorkerContext('worker', {
    config: platform.loadConfig({ APP_ENV: 'test' }),
    clock,
    logger: logs.logger,
    dbHandles: { db: pg.db, dbRead: null, close: async () => undefined },
  });
}

it('[AC-B3-08l#4][BR-AI-07] worker 入口真实装配：agentRuleSyncToken() 的运行体跑一轮后，每个有已发布 help / rule 文章的 app 的 active 块与文章一致；只有公告、草稿或未到发布时间文章的 app 不写块', async () => {
  const token = agentRuleSyncToken();
  const clock = new FixedClock(NOW);
  const appA = appIdOf('a');
  const appB = appIdOf('b');
  const appC = appIdOf('c');
  const help = await insertArticle(pg.db, {
    appId: appA,
    category: 'help',
    title: '结算规则',
    texts: ['确认收货后返利进入待结算。'],
  });
  const rule = await insertArticle(pg.db, {
    appId: appA,
    category: 'rule',
    title: '提现规则',
    texts: ['提现最低金额为一元。', '审核后到账。'],
  });
  const other = await insertArticle(pg.db, {
    appId: appB,
    category: 'rule',
    title: '账号规则',
    texts: ['一个手机号只能绑定一个账号。'],
  });
  await insertArticle(pg.db, { appId: appC, category: 'notice', title: '公告', texts: ['公告'] });
  await insertArticle(pg.db, { appId: appC, category: 'help', status: 'draft', texts: ['草稿'] });
  await insertArticle(pg.db, {
    appId: appC,
    category: 'help',
    texts: ['预告'],
    publishedAt: new FixedClock('2026-10-28T00:00:00.000Z').now(),
  });

  const logs = new Logs();
  const context = await bootWorker(clock, logs);
  try {
    const runtime = context.get(token, { strict: false }) as AgentRuleSyncRuntime | null;
    expect(runtime, 'the worker entry provides the rule sync runtime').not.toBeNull();
    const round = await runtime!.syncOnce();
    expect(round.failed).toEqual([]);
    expect(round.synced).toEqual(expect.arrayContaining([appA, appB]));
    expect(await chunkView(pg.db, appA)).toEqual(expectedChunks([help, rule]));
    expect(await chunkView(pg.db, appB)).toEqual(expectedChunks([other]));
    expect(await chunkView(pg.db, appC)).toEqual([]);
    expect(logs.of('agent_rule_sync_disabled')).toEqual([]);
  } finally {
    await context.close();
  }
}, 180_000);
