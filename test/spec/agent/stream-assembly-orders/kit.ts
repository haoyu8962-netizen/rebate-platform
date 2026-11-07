// B3-08g rule-test kit: the production stream assembly (createProductionStreamAssembly) over real
// PG, with B3-03j's synthetic product ports (../stream-assembly/kit.ts, unchanged) and recording
// stand-ins for the three ports app.module adds (orders, claimEntries, dailyCounter); real
// agent_sessions / agent_runs / agent_cards rows for card_id references; the real stream AppModule
// booted without listening (B3-03f / B3-03j precedent) to read agentStreamPortsToken()'s value.
// Everything under test is built inside the tests (never in hooks): NotImplemented and missing
// wiring redden the test body itself. The integration tests pass the database in.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import * as content from '../../../../apps/api/src/modules/content/index.ts';
import type { ClaimEntryReader } from '../../../../apps/api/src/modules/linking/index.ts';
import type { AgentCapableOrderQueries } from '../../../../apps/api/src/modules/orders/index.ts';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type {
  OrchestratorTools,
  ToolContext,
  ToolOutcome,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { openCardCall } from '../../../../apps/api/src/modules/agent/orchestrator/core/card-references.ts';
import {
  agentStreamPortsToken,
  createProductionStreamAssembly,
  type AgentStreamAssembly,
  type AgentStreamProvidedPorts,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import type { DailyCounter } from '../../../../apps/api/src/modules/agent/stream/mount/orders.ts';
import type { UnnumberedCard } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { fixture } from '../stream-assembly/kit.ts';
import {
  APP,
  consent,
  contentReaderFor,
  openSession,
  rig,
  setConfig,
  type Logs,
  type ManualTime,
} from '../stream-mount/kit.ts';
import { NEVER_OFFERED, NEW_TOOLS, switchKey } from './scan.ts';

export { APP };

export type OrderDetail = NonNullable<Awaited<ReturnType<AgentCapableOrderQueries['get']>>>;

/** In-memory DailyCounter: counts per key and records every call (key, expireAt). */
export function memoryCounter() {
  const counts = new Map<string, number>();
  const incr = vi.fn<DailyCounter['incr']>(async (key) => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next;
  });
  const counter: DailyCounter = { incr };
  return { counter, counts, incr };
}

/**
 * How a switch of `agent.tools.<name>.enabled` is left for one case. 'missing' writes nothing: the
 * key is never written for the caller's app (couli_app has no DELETE on config_items, so no row is
 * ever removed); pair it with a caller of a freshly made app (see `freshAppId`).
 */
export type SwitchState = 'on' | 'false' | 'missing' | 'string' | 'throws';

/** An app id made up for one case: no config_items row exists for it before the case writes one. */
export function freshAppId(): string {
  return `synthetic-b3-08g-${randomUUID()}`;
}

/** Whether config_items holds a row for (appId, key). */
export async function hasConfigRow(db: Kysely<DB>, appId: string, key: string): Promise<boolean> {
  const row = await db
    .selectFrom('config_items')
    .select('key')
    .where('app_id', '=', appId)
    .where('key', '=', key)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Makes content's configValue of `key` reject for every reader built from now on (build() builds
 * the production assembly's content reader when called; B3-08k); other keys read through.
 */
export function failConfigRead(key: string): void {
  const original = content.createContentReader;
  vi.spyOn(content, 'createContentReader').mockImplementation((deps) => {
    const real = original(deps);
    const configValue: typeof real.configValue = (...args) =>
      args[1] === key ? Promise.reject(new Error('合成开关读取失败')) : real.configValue(...args);
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'configValue') return configValue;
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  });
}

/**
 * B3-03j's fixture for `caller` (agent open, consent, product switches and synthetic product ports),
 * every switch of NEW_TOOLS, of search_rules and of NEVER_OFFERED set to true for the caller's app
 * unless `switches` says otherwise, and the production assembly over stand-in order ports.
 * B3-08l: search_rules left NEVER_OFFERED (now registered); its switch is still seeded as before.
 */
export async function ordersFixture(
  db: Kysely<DB>,
  options: {
    readonly caller?: AgentCaller;
    readonly switches?: Readonly<Record<string, SwitchState>>;
  } = {},
) {
  const f = await fixture(db, options.caller);
  const appId = f.caller.appId;
  for (const name of [...NEW_TOOLS, 'search_rules', ...NEVER_OFFERED]) {
    const state = options.switches?.[name] ?? 'on';
    const key = switchKey(name);
    if (state === 'on') await setConfig(db, appId, key, true);
    else if (state === 'false') await setConfig(db, appId, key, false);
    else if (state === 'string') await setConfig(db, appId, key, 'true');
    else if (state === 'missing') continue;
    else {
      await setConfig(db, appId, key, true);
      failConfigRead(key);
    }
  }
  const searchForAgent = vi.fn<AgentCapableOrderQueries['searchForAgent']>(async () => ({
    orders: [],
    total: 0,
  }));
  const findOwnByNumber = vi.fn<AgentCapableOrderQueries['findOwnByNumber']>(async () => []);
  const get = vi.fn<AgentCapableOrderQueries['get']>(async () => null);
  const read = vi.fn<ClaimEntryReader['read']>(async () => ({ logs: [], bindings: [] }));
  const daily = memoryCounter();
  const ports: AgentStreamProvidedPorts = {
    platforms: f.deps.ports.search.platforms,
    searchProducts: f.deps.ports.search.searchProducts,
    readProduct: f.deps.ports.readProduct,
    parsing: f.deps.ports.parsing,
    cards: f.deps.ports.cards,
    orders: { searchForAgent, findOwnByNumber, get },
    claimEntries: { read },
    dailyCounter: daily.counter,
  };
  function build(): AgentStreamAssembly {
    return createProductionStreamAssembly({
      db,
      clock: f.time.clock,
      logger: f.logs.logger,
      scheduler: f.time.scheduler,
      // B3-08k: content's reads come in (as app.module provides them), built here at build time.
      contentReader: contentReaderFor(db, f.time.clock),
      ports,
    });
  }
  function contextOf(subject: AgentCaller, sessionId: string = randomUUID()): ToolContext {
    return {
      subject,
      sessionId,
      runId: randomUUID(),
      placeholders: {},
      signal: new AbortController().signal,
    };
  }
  /** Ports the order tools may reach; none of them may run for a refused call. */
  function orderPortCalls(): number {
    return (
      searchForAgent.mock.calls.length +
      findOwnByNumber.mock.calls.length +
      get.mock.calls.length +
      read.mock.calls.length +
      daily.incr.mock.calls.length
    );
  }
  return {
    ...f,
    ports,
    searchForAgent,
    findOwnByNumber,
    get,
    read,
    daily,
    build,
    contextOf,
    orderPortCalls,
  };
}

/** One tool call inside a card call scope, as the core runs it (card references available). */
export async function callTool(
  tools: OrchestratorTools,
  ctx: ToolContext,
  name: string,
  args: unknown,
): Promise<ToolOutcome> {
  const id = randomUUID();
  const scope = openCardCall(id, ctx.placeholders);
  try {
    return await tools.execute({ id, name, args }, ctx);
  } finally {
    scope.close();
  }
}

/** The cards of an ok outcome (an assertion failure otherwise). */
export function cardsOf(outcome: ToolOutcome): readonly UnnumberedCard[] {
  expect(outcome.kind, JSON.stringify(outcome)).toBe('ok');
  return outcome.kind === 'ok' ? outcome.cards : [];
}

export async function definitionNames(
  assembly: AgentStreamAssembly,
  subject: AgentCaller,
): Promise<string[]> {
  return (await assembly.tools.definitions(subject.appId, subject)).map(
    (definition) => definition.name,
  );
}

// ---- sessions and stored cards -----------------------------------------------------------------

/** A real agent session of `caller` (createSession through a minimal runtime), consent given. */
export async function sessionOf(db: Kysely<DB>, caller: AgentCaller): Promise<string> {
  await consent(db, caller);
  const r = await rig(db);
  try {
    return await openSession(r, caller);
  } finally {
    await r.runtime.close();
  }
}

/** A finished, refunded run on `sessionId` (B3-03j regression precedent); returns its id. */
export async function insertRun(db: Kysely<DB>, sessionId: string): Promise<string> {
  const session = await db
    .selectFrom('agent_sessions')
    .select(['app_id', 'started_at'])
    .where('id', '=', sessionId)
    .executeTakeFirstOrThrow();
  const at = new Date(session.started_at);
  const hex = randomUUID().replace(/-/gu, '');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  await db
    .insertInto('agent_runs')
    .values({
      id,
      app_id: session.app_id,
      session_id: sessionId,
      prompt_version: 'none',
      accepted_at: at,
      deadline_at: new Date(at.getTime() + 20_000),
      quota_subjects: [`fixture:${sessionId}`],
      end_reason: 'stop',
      finish_reason: 'stop',
      settle_result: 'refunded',
      settled_at: at,
      final_event: sql`${JSON.stringify({ type: 'done', data: { finish_reason: 'stop' } })}::jsonb`,
      ended_at: at,
    })
    .execute();
  return id;
}

/** One delivered card row of an earlier run (agent is the writer of agent_cards). */
export async function insertCard(
  db: Kysely<DB>,
  card: {
    readonly sessionId: string;
    readonly runId: string;
    readonly cardId: string;
    readonly type: string;
    readonly data: Record<string, unknown>;
  },
): Promise<void> {
  const session = await db
    .selectFrom('agent_sessions')
    .select('app_id')
    .where('id', '=', card.sessionId)
    .executeTakeFirstOrThrow();
  await db
    .insertInto('agent_cards')
    .values({
      id: randomUUID(),
      app_id: session.app_id,
      session_id: card.sessionId,
      run_id: card.runId,
      card_id: card.cardId,
      type: card.type,
      data: sql`${JSON.stringify(card.data)}::jsonb`,
      schema_version: 1,
      fallback_text: '合成卡片',
    })
    .execute();
}

// ---- the real stream AppModule ------------------------------------------------------------------

interface StreamApp {
  init(): Promise<unknown>;
  close(): Promise<void>;
  get(token: unknown, options: { strict: boolean }): unknown;
}

/** One recorded Redis script call of the fake handle. */
export interface EvalCall {
  readonly namespace: string;
  readonly script: string;
  readonly options: { readonly keys: readonly string[]; readonly args: readonly string[] };
  readonly ttlSeconds: number;
}

/** A RedisHandle stand-in: every namespace answers eval with `reply` (or rejects with it). */
export function fakeRedis(reply: unknown) {
  const evals: EvalCall[] = [];
  const handle = {
    namespace(name: string) {
      return {
        get: async () => null,
        set: async () => undefined,
        async eval(
          script: string,
          options: {
            readonly keys: readonly string[];
            readonly args: readonly string[];
            readonly ttlSeconds: number;
          },
        ) {
          evals.push({ namespace: name, script, options, ttlSeconds: options.ttlSeconds });
          if (reply instanceof Error) throw reply;
          return reply;
        },
      };
    },
    close: async () => undefined,
    onApplicationShutdown: async () => undefined,
  };
  return { handle, evals };
}

/**
 * The real `stream` AppModule (bootstrap.createHttpApp, never listening), loaded by URL as the
 * B3-03f / B3-03j module tests do. The job queue is a no-op; with `redis` the platform's REDIS
 * provider is replaced by that handle. Returns the app and agentStreamPortsToken()'s value.
 */
export async function bootStream(options: {
  readonly db?: Kysely<DB>;
  readonly redis?: ReturnType<typeof fakeRedis>['handle'];
  readonly time: ManualTime;
  readonly logs: Logs;
}) {
  const src = (path: string) => new URL(`../../../../apps/api/src/${path}`, import.meta.url).href;
  const boot = (await import(src('bootstrap.ts'))) as {
    createHttpApp(entry: string, overrides: object): Promise<StreamApp>;
  };
  const platform = (await import(src('modules/platform/index.ts'))) as {
    JOB_QUEUE: symbol;
    REDIS: symbol;
    loadConfig(env: Record<string, string>): unknown;
    PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
  };
  // A second boot in the same test starts again from the real forRoot (never a spy of a spy).
  const previous = platform.PlatformModule.forRoot;
  if (vi.isMockFunction(previous)) previous.mockRestore();
  const original = platform.PlatformModule.forRoot.bind(platform.PlatformModule);
  vi.spyOn(platform.PlatformModule, 'forRoot').mockImplementation((value) => {
    const module = original(value);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) => {
        if (typeof provider !== 'object' || provider === null || !('provide' in provider)) {
          return provider;
        }
        if (provider.provide === platform.JOB_QUEUE) {
          return {
            provide: platform.JOB_QUEUE,
            useValue: {
              send: async () => null,
              register: vi.fn(),
              start: async () => undefined,
              stop: async () => undefined,
            },
          };
        }
        if (provider.provide === platform.REDIS && options.redis !== undefined) {
          return { provide: platform.REDIS, useValue: options.redis };
        }
        return provider;
      }),
    };
  });
  const app = await boot.createHttpApp('stream', {
    config: platform.loadConfig({ APP_ENV: 'test' }),
    clock: options.time.clock,
    logger: options.logs.logger,
    ...(options.db === undefined
      ? {}
      : { dbHandles: { db: options.db, dbRead: null, close: async () => undefined } }),
    ...(options.redis === undefined ? {} : { redisUrl: 'redis://127.0.0.1:6379/0' }),
  });
  try {
    await app.init();
    const ports = app.get(agentStreamPortsToken(), { strict: false }) as
      AgentStreamProvidedPorts | null | undefined;
    return { app, ports };
  } catch (error) {
    await app.close();
    throw error;
  }
}

/** `value` after asserting it is present (an assertion failure, never a TypeError, when absent). */
export function present<T>(value: T | null | undefined, what: string): T {
  expect(value, what).toBeDefined();
  expect(value, what).not.toBeNull();
  return value as T;
}
