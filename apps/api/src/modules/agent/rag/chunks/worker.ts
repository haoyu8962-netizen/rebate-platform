// B3-08l: the agent worker's periodic rule chunk sync (syncRuleChunks per app; 规划/11 §2.3, ledger
// B3-08i 触发 / B3-08l 同步). Rule tests: test/spec/agent/rule-search-wiring/** import these names
// through agent's index.ts: names, signatures and the semantics written here are the contract.
//
// RuleSyncArticles: content's published help / rule articles as app.module (the composition root)
//   assembles them on the worker entry (D10-294 / D10-386: agent never queries app.articles and
//   never hands its handle to content; app.module does not query app.articles either). Both halves
//   come from content's read-only entry (content/index.ts): list(appId) is
//   createPublishedArticlesReader({db, clock}).list and apps() is
//   createPublishedArticleAppsReader({db, clock}).apps (the distinct app ids, ascending, that have
//   at least one current published help / rule article: the same "current revision" rule as list).
// agentRuleArticlesToken(): DI token of the RuleSyncArticles app.module provides on the worker
//   entry (null without a database handle); the same symbol on every call.
// agentRuleSyncToken(): DI token of the worker's AgentRuleSyncRuntime; the same symbol on every
//   call.
// createAgentRuleSyncRuntime({db, clock, logger, articles}) → AgentRuleSyncRuntime, built with
//   nothing running (no timer, no query):
//   syncOnce(): one round. The apps of the round are articles.apps() together with every app that
//     has an active row in app.agent_rule_chunks (agent's own table: an app whose last help / rule
//     article went offline still gets its chunks retired), each once, in ascending app id order,
//     one after another. For each app: syncRuleChunks({db, clock, articles}, appId). An app whose
//     sync rejects is one warn line 'agent_rule_sync_app_failed' with app_id and error_name, and
//     the round goes on with the next app. Resolves with {synced, failed} (app ids, ascending);
//     never rejects. articles.apps() rejecting: one warn line 'agent_rule_sync_failed' with
//     error_name, the round syncs no app (list is not called) and resolves {synced: [],
//     failed: []}; the next round reads the app list again.
//   start(options?) → RuleSyncLoop: begins the first round right away, without waiting for any
//     firing (「启动后先跑一轮」; it need not have begun when start returns), and arms one
//     repeating timer of 300 000 ms (the B3-08i ledger's default period, a code constant: no
//     configuration key) through options.schedule (default: setInterval, unref'd). A firing while a round still runs does nothing (rounds never
//     overlap); the promise a firing returns resolves when the round it started is over (at once
//     when it started none). stop(): stops the timer (no round starts after it, a late firing
//     does nothing), then resolves once the round in flight, if any, is over; repeating it is
//     harmless.
// AgentModule.forWorker(): additionally provides and exports agentRuleSyncToken(), injected
//   [CLOCK, ROOT_LOGGER, {token: DB, optional: true}, {token: agentRuleArticlesToken(), optional:
//   true}]. Without a DB handle or without the articles (an isolated worker context) the provider
//   is null and one info line 'agent_rule_sync_disabled' is logged; with both it is exactly
//   createAgentRuleSyncRuntime({db, clock, logger, articles}). Building it starts nothing.
// entry.ts (worker only, after startWorkerServices resolved and before `started`): resolves the
//   token with context.get(agentRuleSyncToken(), {strict: false}); a throw, null, undefined or a
//   value without a start function → no loop, no crash, no startup failure; a stop already
//   requested → no loop. start() is called once without options. Shutdown awaits loop.stop()
//   before services.stop() (services.stop runs even when loop.stop rejects).
//   COULI_EXIT_AFTER_INIT=1 and the api / stream / admin / payout entries never start it.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { PublishedArticleApps, PublishedArticlesReader } from '../../../content/index.ts';
import type { Clock, RootLogger } from '../../../platform/index.ts';
import { syncRuleChunks } from './sync.ts';

/** content's published help / rule articles, plus the apps that have any (app.module's). */
export type RuleSyncArticles = PublishedArticlesReader & PublishedArticleApps;

export interface AgentRuleSyncRuntimeDeps {
  /** Primary couli_app handle, for app.agent_rule_chunks only. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly articles: RuleSyncArticles;
}

/** One round's apps, each in ascending app id order. */
export interface RuleSyncRound {
  readonly synced: readonly string[];
  readonly failed: readonly string[];
}

export interface RuleSyncTimer {
  stop(): void;
}

/** Calls `tick` every `intervalMs` until stopped. */
export type RuleSyncSchedule = (tick: () => Promise<void>, intervalMs: number) => RuleSyncTimer;

/** Test seams of one start; production passes nothing. */
export interface RuleSyncStartOptions {
  readonly schedule?: RuleSyncSchedule;
}

export interface RuleSyncLoop {
  stop(): Promise<void>;
}

export interface AgentRuleSyncRuntime {
  syncOnce(): Promise<RuleSyncRound>;
  start(options?: RuleSyncStartOptions): RuleSyncLoop;
}

const RULE_ARTICLES = Symbol('AGENT_RULE_ARTICLES');
const RULE_SYNC = Symbol('AGENT_RULE_SYNC');

export function agentRuleArticlesToken(): symbol {
  return RULE_ARTICLES;
}

export function agentRuleSyncToken(): symbol {
  return RULE_SYNC;
}

/** The B3-08i ledger's default period (a code constant, no configuration key). */
function syncIntervalMs(): number {
  return 300_000;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** setInterval, unref'd, so the timer alone never keeps the process alive. */
const intervalSchedule: RuleSyncSchedule = (tick, intervalMs) => {
  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  handle.unref();
  return { stop: () => clearInterval(handle) };
};

function ascending(appIds: Iterable<string>): string[] {
  // JavaScript's default order (UTF-16 code units).
  return [...new Set(appIds)].sort();
}

export function createAgentRuleSyncRuntime(deps: AgentRuleSyncRuntimeDeps): AgentRuleSyncRuntime {
  const { db, clock, logger, articles } = deps;

  /** articles.apps() with every app that still has an active chunk (agent's own table). */
  async function appsOfRound(): Promise<string[]> {
    const listed = await articles.apps();
    const active = await db
      .withSchema('app')
      .selectFrom('agent_rule_chunks')
      .select('app_id')
      .distinct()
      .where('status', '=', 'active')
      .execute();
    return ascending([...listed, ...active.map((row) => row.app_id)]);
  }

  async function syncOnce(): Promise<RuleSyncRound> {
    let apps: string[];
    try {
      apps = await appsOfRound();
    } catch (error) {
      logger.warn({ error_name: errorName(error) }, 'agent_rule_sync_failed');
      return { synced: [], failed: [] };
    }
    const synced: string[] = [];
    const failed: string[] = [];
    // One app after another: each sync holds its own app's advisory lock (sync.ts).
    for (const appId of apps) {
      try {
        await syncRuleChunks({ db, clock, articles }, appId);
        synced.push(appId);
      } catch (error) {
        logger.warn({ app_id: appId, error_name: errorName(error) }, 'agent_rule_sync_app_failed');
        failed.push(appId);
      }
    }
    return { synced, failed };
  }

  function start(options?: RuleSyncStartOptions): RuleSyncLoop {
    const schedule = options?.schedule ?? intervalSchedule;
    let stopped = false;
    let inFlight: Promise<void> | null = null;
    // A round never overlaps another; after stop no round starts.
    const round = (): Promise<void> => {
      if (stopped || inFlight !== null) return Promise.resolve();
      const current = syncOnce().then(
        () => undefined,
        () => undefined,
      );
      inFlight = current;
      void current.then(() => {
        if (inFlight === current) inFlight = null;
      });
      return current;
    };
    // 「启动后先跑一轮」: the first round begins now, the timer only repeats it.
    void round();
    const timer = schedule(round, syncIntervalMs());
    return {
      async stop() {
        if (!stopped) {
          stopped = true;
          timer.stop();
        }
        await inFlight;
      },
    };
  }

  return { syncOnce, start };
}
