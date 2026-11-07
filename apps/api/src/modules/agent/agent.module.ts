// The agent module's worker assembly (B3-03h; design couli-runs/B3-03g/design.md v5 §5.3 「worker 内
// 循环 + advisory lock」, §5.1, §7.4 B3-03h, §10.1 T10 / T14; BR-AI-23 细则「受理记录与收尾 · 谁来收尾」,
// BR-AI-15 退还). app.module imports AgentModule.forWorker() on the `worker` entry only; entry.ts
// starts the loop after startWorkerServices and stops it first on shutdown. The HTTP mount on the
// stream entry is B3-03f's, not this file's. Rule tests: test/spec/agent/stream-recovery/** import
// this file by path: names, signatures and the semantics written here are the contract.
//
// agentSweeperToken(): the DI token of the worker's sweeper runtime; the same symbol on every call.
// agentDefaultTexts(): {errorMsg(code)} over contracts/texts.default.json, read synchronously once
//   when this module is loaded (path relative to import.meta.url, as linking's apps-json.ts does;
//   the same depth in the build output). errorMsg(code) = fallbacks['error.<code>'] when present (the
//   08 「变量缺失时」 form: a server-side frame has no placeholder values), else texts['error.<code>'],
//   else errorMsg(50001). A returned text never contains a `{name}` placeholder. Stand-in until a
//   texts service exists (BR-TEXT-14); every call returns the same object.
// createAgentSweeperRuntime({db, clock, logger, contentReader}) → AgentSweeperRuntime, built with
//   nothing running:
//   texts = agentDefaultTexts(); timings = runTimingsDefaults(); sweeperConfig = sweeperDefaults();
//   loopConfig = agentSweepLoopDefaults() with loopConfig.maxPerTick = sweeperConfig.maxPerTick
//   (each a fresh value of those functions; T14: the one frozen RunTimings,
//   assertRunTimings({...timings, admissionRunMaxMs: timings.runMaxMs, sweepMarginMs:
//   sweeperConfig.marginMs}) holds);
//   finalizer = createPgRunPorts({db, clock, timings, limits: createQuotaLimitsSource({reader:
//   deps.contentReader, logger}), texts, logger}).finalizer (no signals: the sweeper needs no
//   Redis; B3-08k); step = createSweeper({db, finalizer, clock, config: {...sweeperConfig,
//   maxPerTick: 1}, logger}) — one row per call, so the loop can stop between rows (loop.ts).
//   start(options?) = startAgentSweeper({step, db, clock, logger, config: loopConfig,
//   ...options}) — every call starts one more loop (entry.ts calls it once).
// AgentModule.forWorker(): a DynamicModule providing and exporting agentSweeperToken(), injected
//   [CLOCK, ROOT_LOGGER, {token: DB, optional: true}, agentContentReaderToken()]. Without a DB
//   handle the provider is null and one info line 'agent_sweeper_disabled' is logged (as
//   RiskScanModule's 'risk_scan_disabled'); with one and a null / undefined content reader it
//   throws (a wiring error: the worker does not start); with both it is exactly
//   createAgentSweeperRuntime({db, clock, logger, contentReader}) (one assembly path: the
//   provider's value has the same fields and its start() runs the real loop over the real step —
//   a tick takes the advisory lock and finalizes left-over runs). Building it starts nothing (no
//   timer, no query); only start() does. start(options) takes the loop's test seams (schedule,
//   random); production passes nothing.
// entry.ts (worker only, after startWorkerServices resolved and before `started`): resolves the
//   token with context.get(agentSweeperToken(), {strict: false}); a throw, null, undefined or a
//   value without a start function → no loop, no crash (as startRiskScanHeal); a stop already
//   requested → no loop. Shutdown awaits loop.stop() before services.stop() (services.stop runs
//   even when loop.stop rejects). COULI_EXIT_AFTER_INIT=1 and the api / stream / admin / payout
//   entries never start it.
// B3-08k (D10-294; rule tests: test/spec/agent/foreign-db-handoff/**): agent never hands its
//   database handle to another module's function. createAgentSweeperRuntime builds the limits
//   with createQuotaLimitsSource({reader: deps.contentReader, logger}) and exposes that one source
//   as runtime.limits (the finalizer's); forWorker()'s provider also injects
//   agentContentReaderToken() (app.module provides content's reads, assembled there) and passes it
//   as deps.contentReader. D10-306: deps.contentReader is required — the daily limits never fall
//   back to defaults that may be wider than the configured ones (quota fail-closed, R-04 /
//   D10-248); the provider throws when a DB handle is present but the reader is null / undefined
//   (as forStream does for its two required readers). Without a DB handle the provider stays null
//   with one 'agent_sweeper_disabled' line, as before. forStream: the AGENT_CALLER
//   provider injects agentCallerReaderToken() (./stream/mount/caller.ts) instead of
//   options.callerReader, and the stream runtime's provider injects agentContentReaderToken() and
//   agentConsentReaderToken() instead of options.consentReader (review r1); forStream's options
//   keep assembly and safety only.
// B3-08m (contract: ./rag/chunks/worker.ts): forWorker() also provides and exports
//   agentRuleSyncToken(), the worker's rule chunk sync runtime, over the published-articles reader
//   app.module provides as agentRuleArticlesToken() (optional: an isolated worker context without
//   it, or without a DB handle, gets null and one info line 'agent_rule_sync_disabled').
//
// Also compiled by the `test` project: a class decorator only (no parameter decorators or
// parameter properties; dependencies are injected through factories); erasable syntax only,
// `import type` for type-only imports, relative imports with `.ts`, no process.env.
import { type DynamicModule, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import { CLOCK, DB, ROOT_LOGGER, type Clock, type RootLogger } from '../platform/index.ts';
import {
  assertRunTimings,
  createPgRunPorts,
  createQuotaLimitsSource,
  runTimingsDefaults,
  type QuotaLimitsSource,
  type RunTimings,
} from './stream/pg/index.ts';
import type { RunTexts } from './stream/run/index.ts';
import { agentContentReaderToken, type AgentContentReader } from './stream/mount/config.ts';
import { agentDefaultTexts } from './stream/mount/texts.ts';
import {
  agentRuleArticlesToken,
  agentRuleSyncToken,
  createAgentRuleSyncRuntime,
  type AgentRuleSyncRuntime,
  type RuleSyncArticles,
} from './rag/chunks/worker.ts';
import { agentCallerProvider } from './stream/mount/caller.ts';
import { agentStreamController } from './stream/mount/controller.ts';
import {
  agentStreamProvider,
  agentStreamToken,
  type AgentStreamModuleOptions,
  type AgentStreamRuntime,
} from './stream/mount/index.ts';
export { agentDefaultTexts } from './stream/mount/texts.ts';
export { agentContentReaderToken } from './stream/mount/config.ts';
export { agentCallerReaderToken } from './stream/mount/caller.ts';
import {
  createSweeper,
  sweeperDefaults,
  type Sweeper,
  type SweeperConfig,
} from './stream/sweeper/index.ts';
import { agentSweepLoopDefaults, startAgentSweeper } from './stream/sweeper/loop.ts';
import type {
  AgentSweepLoop,
  AgentSweepLoopConfig,
  AgentSweepSchedule,
} from './stream/sweeper/loop.ts';

export type {
  AgentSweepLoop,
  AgentSweepLoopConfig,
  AgentSweepLoopDeps,
  AgentSweepSchedule,
  AgentSweepTimer,
  AgentSweepTimerHandle,
} from './stream/sweeper/loop.ts';

export interface AgentSweeperRuntimeDeps {
  readonly db: Kysely<Database>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  /**
   * B3-08k (D10-294): content's reads, assembled by app.module on the worker entry and injected
   * through agentContentReaderToken(); the finalizer's daily limits read only its configValue
   * (agent builds no content reader). Required (D10-306): no fallback to default limits, which
   * could be wider than the configured ones (quota fail-closed, R-04 / D10-248).
   */
  readonly contentReader: AgentContentReader;
}

/** Test seams of one loop start; production passes nothing. */
export interface AgentSweeperStartOptions {
  readonly schedule?: AgentSweepSchedule;
  readonly random?: () => number;
}

export interface AgentSweeperRuntime {
  readonly texts: Pick<RunTexts, 'errorMsg'>;
  readonly timings: RunTimings;
  readonly sweeperConfig: SweeperConfig;
  readonly loopConfig: AgentSweepLoopConfig;
  /** The one-row sweeper the loop calls row by row (createSweeper with maxPerTick 1). */
  readonly step: Sweeper;
  /**
   * B3-08k: the one QuotaLimitsSource given to createPgRunPorts (the finalizer's), over
   * deps.contentReader.
   */
  readonly limits: QuotaLimitsSource;
  start(options?: AgentSweeperStartOptions): AgentSweepLoop;
}

const AGENT_SWEEPER = Symbol('AGENT_SWEEPER');

export function agentSweeperToken(): symbol {
  return AGENT_SWEEPER;
}

export function createAgentSweeperRuntime(deps: AgentSweeperRuntimeDeps): AgentSweeperRuntime {
  const { db, clock, logger } = deps;
  const texts = agentDefaultTexts();
  const timings = Object.freeze(runTimingsDefaults());
  const sweeperConfig = sweeperDefaults();
  const loopConfig = { ...agentSweepLoopDefaults(), maxPerTick: sweeperConfig.maxPerTick };
  assertRunTimings({
    ...timings,
    admissionRunMaxMs: timings.runMaxMs,
    sweepMarginMs: sweeperConfig.marginMs,
  });
  const limits = createQuotaLimitsSource({ reader: deps.contentReader, logger });
  const { finalizer } = createPgRunPorts({ db, clock, timings, limits, texts, logger });
  const step = createSweeper({
    db,
    finalizer,
    clock,
    config: { ...sweeperConfig, maxPerTick: 1 },
    logger,
  });
  return {
    texts,
    timings,
    sweeperConfig,
    loopConfig,
    step,
    limits,
    start: (options) =>
      startAgentSweeper({ step, db, clock, logger, config: loopConfig, ...options }),
  };
}

@Module({})
export class AgentModule {
  static forStream(options: AgentStreamModuleOptions): DynamicModule {
    return {
      module: AgentModule,
      controllers: [agentStreamController(agentStreamToken())],
      providers: [
        agentStreamProvider(options),
        agentCallerProvider(),
        {
          provide: Symbol('AGENT_STREAM_SHUTDOWN'),
          inject: [agentStreamToken()],
          useFactory: (runtime: AgentStreamRuntime | null) => ({
            // All destroy hooks precede platform's onApplicationShutdown (PG / Redis close).
            onModuleDestroy: async () => {
              await runtime?.close();
            },
          }),
        },
      ],
      exports: [agentStreamToken()],
    };
  }

  static forWorker(): DynamicModule {
    return {
      module: AgentModule,
      providers: [
        {
          provide: agentSweeperToken(),
          inject: [CLOCK, ROOT_LOGGER, { token: DB, optional: true }, agentContentReaderToken()],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db: Kysely<Database> | undefined,
            contentReader: AgentContentReader | null | undefined,
          ): AgentSweeperRuntime | null => {
            if (db == null) {
              logger.info('agent_sweeper_disabled');
              return null;
            }
            // D10-306: app.module provides the reader whenever it provides the handle; anything
            // else is a wiring error, and the limits never fall back to defaults (fail-closed).
            if (contentReader == null) {
              throw new Error('agent: the worker entry needs the content reader');
            }
            return createAgentSweeperRuntime({ db, clock, logger, contentReader });
          },
        },
        {
          provide: agentRuleSyncToken(),
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB, optional: true },
            { token: agentRuleArticlesToken(), optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db: Kysely<Database> | undefined,
            articles: RuleSyncArticles | null | undefined,
          ): AgentRuleSyncRuntime | null => {
            if (db == null || articles == null) {
              logger.info('agent_rule_sync_disabled');
              return null;
            }
            return createAgentRuleSyncRuntime({ db, clock, logger, articles });
          },
        },
      ],
      exports: [agentSweeperToken(), agentRuleSyncToken()],
    };
  }
}
