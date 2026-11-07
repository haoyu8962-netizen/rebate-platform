// B3-08l 同步的模块装配 (as test/spec/agent/stream-recovery/module.test.ts: a real Nest context, a
// Kysely that only compiles). AppModule.forEntry({entry: 'worker'}) holds agentRuleSyncToken() from
// AgentModule.forWorker: with a database a runtime built from app.module's published-articles
// reader (agentRuleArticlesToken(), assembled by the composition root), building it sends no
// query; without a database null and exactly one info line agent_rule_sync_disabled. An isolated
// worker context (only AgentModule.forWorker, no articles reader) still builds: the token is null,
// nothing throws. The other four entries have no such token.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';

import {
  AgentModule,
  agentContentReaderToken,
  agentRuleArticlesToken,
  agentRuleSyncToken,
  agentSweeperToken,
  type AgentRuleSyncRuntime,
} from '../../../../apps/api/src/modules/agent/index.ts';
import { ports } from '../../risk/freeze-expiry/kit.ts';
import { LEVEL } from '../stream-recovery/kit.ts';

const databases: Kysely<DB>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

function compileOnlyDb(queries: string[]): Kysely<DB> {
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(event) {
      queries.push(event.query.sql);
    },
  });
  databases.push(db);
  return db;
}

interface Context {
  get(token: unknown, options?: { strict: boolean }): unknown;
  close(): Promise<void>;
}

async function nest() {
  const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: { createApplicationContext(module: unknown, options: object): Promise<Context> };
  };
  return NestFactory;
}

async function contextOf(entry: string, withDb: boolean) {
  // Loaded by URL (as the B3-03h module test does): app.module pulls in the Nest controllers,
  // which the `test` project does not compile.
  const { AppModule } = (await import(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as { AppModule: { forEntry(options: object): unknown } };
  const { PlatformModule, JOB_QUEUE, loadConfig } = (await import(
    new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
  )) as {
    PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
    JOB_QUEUE: symbol;
    loadConfig(env: Record<string, string>): unknown;
  };
  const NestFactory = await nest();
  const p = await ports();
  const queries: string[] = [];
  const queue = {
    send: vi.fn(async () => 'fixture'),
    register: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const original = PlatformModule.forRoot.bind(PlatformModule);
  vi.spyOn(PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = original(options);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === JOB_QUEUE
          ? { provide: JOB_QUEUE, useValue: queue }
          : provider,
      ),
    };
  });
  const context = await NestFactory.createApplicationContext(
    AppModule.forEntry({
      entry,
      config: loadConfig({ APP_ENV: 'test' }),
      clock: p.clock,
      logger: p.logger,
      ...(withDb
        ? {
            dbHandles: {
              db: compileOnlyDb(queries),
              dbRead: null,
              close: async () => undefined,
            },
          }
        : {}),
    }),
    { logger: false, abortOnError: false },
  );
  const lines = () => p.lines.map((line) => JSON.parse(line) as { level: number; msg: string });
  return { context, queries, queue, lines };
}

it('[AC-B3-08l#4] worker 入口（有库）：agentRuleSyncToken() 提供运行体（start、syncOnce 为函数），同一实例；组合根提供 agentRuleArticlesToken()（list、apps 为函数）；装配不发 agent_rule_chunks / articles 查询、不调队列', async () => {
  const token = agentRuleSyncToken();
  const articlesToken = agentRuleArticlesToken();
  const { context, queries, queue, lines } = await contextOf('worker', true);
  try {
    const runtime = context.get(token, { strict: false }) as AgentRuleSyncRuntime | null;
    expect(runtime).not.toBeNull();
    expect(typeof runtime?.start).toBe('function');
    expect(typeof runtime?.syncOnce).toBe('function');
    expect(context.get(token, { strict: false })).toBe(runtime);
    const articles = context.get(articlesToken, { strict: false }) as Record<
      string,
      unknown
    > | null;
    expect(typeof articles?.['list']).toBe('function');
    expect(typeof articles?.['apps']).toBe('function');
    expect(queries.filter((q) => /agent_rule_chunks|articles/.test(q))).toEqual([]);
    expect(queue.send).not.toHaveBeenCalled();
    expect(lines().filter((l) => l.msg === 'agent_rule_sync_disabled')).toEqual([]);
  } finally {
    await context.close();
  }
});

it('[AC-B3-08l#4] worker 入口没有库：agentRuleSyncToken() 为 null，恰一条 info agent_rule_sync_disabled', async () => {
  const token = agentRuleSyncToken();
  const { context, lines } = await contextOf('worker', false);
  try {
    expect(context.get(token, { strict: false })).toBeNull();
    const disabled = lines().filter((l) => l.msg === 'agent_rule_sync_disabled');
    expect(disabled).toHaveLength(1);
    expect(disabled[0]!.level).toBe(LEVEL.info);
  } finally {
    await context.close();
  }
});

it('[AC-B3-08l#4] api / stream / admin / payout 入口不装同步：没有 agentRuleSyncToken()，也不记 agent_rule_sync_disabled', async () => {
  const token = agentRuleSyncToken();
  for (const entry of ['api', 'stream', 'admin', 'payout']) {
    const { context, lines } = await contextOf(entry, true);
    try {
      expect(() => context.get(token, { strict: false }), entry).toThrow();
      expect(
        lines().filter((l) => l.msg === 'agent_rule_sync_disabled'),
        entry,
      ).toEqual([]);
    } finally {
      await context.close();
    }
    vi.restoreAllMocks();
  }
});

it('[AC-B3-08l#4] 隔离 worker 上下文（只装 AgentModule.forWorker，组合根没提供已发布文章读取器）：上下文照常建成、清扫运行体照旧，agentRuleSyncToken() 为 null（不抛错），恰一条 info agent_rule_sync_disabled', async () => {
  const token = agentRuleSyncToken();
  const {
    DB: DB_TOKEN,
    CLOCK,
    ROOT_LOGGER,
  } = (await import(
    new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
  )) as { DB: symbol; CLOCK: symbol; ROOT_LOGGER: symbol };
  const NestFactory = await nest();
  const p = await ports();
  class IsolatedTokens {}
  class IsolatedRoot {}
  const platform = {
    module: IsolatedTokens,
    global: true,
    providers: [
      { provide: DB_TOKEN, useValue: compileOnlyDb([]) },
      { provide: CLOCK, useValue: p.clock },
      { provide: ROOT_LOGGER, useValue: p.logger },
      {
        provide: agentContentReaderToken(),
        useValue: { configValue: async () => null, freshConfigValue: async () => null },
      },
    ],
    exports: [DB_TOKEN, CLOCK, ROOT_LOGGER, agentContentReaderToken()],
  };
  const context = await NestFactory.createApplicationContext(
    { module: IsolatedRoot, imports: [platform, AgentModule.forWorker()] },
    { logger: false, abortOnError: false },
  );
  try {
    expect(context.get(agentSweeperToken(), { strict: false })).not.toBeNull();
    expect(context.get(token, { strict: false })).toBeNull();
    const lines = p.lines.map((line) => JSON.parse(line) as { level: number; msg: string });
    const disabled = lines.filter((l) => l.msg === 'agent_rule_sync_disabled');
    expect(disabled).toHaveLength(1);
    expect(disabled[0]!.level).toBe(LEVEL.info);
  } finally {
    await context.close();
  }
});

it('[AC-B3-08l#4] AgentModule.forWorker() 提供并导出 agentRuleSyncToken()（每次同一个 symbol），且仍提供 agentSweeperToken()；agentRuleArticlesToken() 也是同一个 symbol', () => {
  const token = agentRuleSyncToken();
  expect(typeof token).toBe('symbol');
  expect(agentRuleSyncToken()).toBe(token);
  const articles = agentRuleArticlesToken();
  expect(typeof articles).toBe('symbol');
  expect(agentRuleArticlesToken()).toBe(articles);
  expect(articles).not.toBe(token);
  const module = AgentModule.forWorker();
  expect(module.exports).toContain(token);
  expect(module.exports).toContain(agentSweeperToken());
  const provided = (module.providers ?? []).map((p) =>
    typeof p === 'object' && p !== null && 'provide' in p ? p.provide : p,
  );
  expect(provided).toContain(token);
  expect(provided).toContain(agentSweeperToken());
});
