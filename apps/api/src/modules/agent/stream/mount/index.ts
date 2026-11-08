// The stream entry's assembly of the agent module (B3-03f; B3-05-plan §1.1, §3.3; B3-03g design
// §5.1, §6.2; followups 18, 21–23, 30, 31; BR-AI-13, BR-AI-23). The rule tests in
// test/spec/agent/stream-mount/** import this file by path: names, signatures and the semantics
// written here are the contract. AgentModule.forStream(options) (agent.module.ts) provides
// agentStreamProvider(options) and exports agentStreamToken(); app.module imports it on the
// `stream` entry only, providing identity's createAiConsentReader bound to its handle as
// agentConsentReaderToken() (agent never imports identity; B3-08k), and gives the stream entry's
// request check plan identity's token check ② ③ (no signature check). api, worker, admin and
// payout neither import it nor serve /v1/agent/*; stream starts no sweeper.
//
// agentStreamToken(): the DI token of the stream runtime; the same symbol on every call.
// agentStreamProvider(options): the Nest factory provider of agentStreamToken(), injected [CLOCK,
//   ROOT_LOGGER, {token: DB, optional: true}, {token: REDIS, optional: true},
//   {token: agentStreamPortsToken(), optional: true}, agentContentReaderToken(),
//   agentConsentReaderToken()]. Without a DB handle its value is null and one info line
//   'agent_stream_disabled' is logged; with one it is createAgentStreamRuntime({db, clock, logger,
//   signals?, assembly?, contentReader, consentReader}) (B3-08k: both readers from app.module; a
//   DB handle without them is a wiring error and throws).
//   The four routes of B3-03d (createAgentSession, getCurrentAgentSession, sendAgentMessage,
//   cancelAgentRun) are registered either way; without a runtime each answers the JSON 50001
//   envelope. On application shutdown runtime.close() resolves before the platform closes the
//   database handles (Nest lifecycle; entry.ts unchanged).
// createAgentStreamRuntime(deps, seams?) → AgentStreamRuntime, built with nothing running (no
//   timer, no query):
//   texts: errorMsg = agentDefaultTexts().errorMsg; the run texts' text(appId, key) =
//   texts['<key>'] of contracts/texts.default.json. timings = runTimingsDefaults(), frozen at
//   build; runConfig = {...runConfigDefaults(), maxRunMs: timings.runMaxMs} with
//   0 < guardPollMs ≤ 5 000; assertRunTimings({...timings, admissionRunMaxMs: runConfig.maxRunMs,
//   sweepMarginMs: 0}) is called at build (a throw: the entry does not start).
//   limits = createQuotaLimitsSource({reader: deps.contentReader, logger}): ONE
//   instance, given to createPgRunPorts({db, clock, timings, limits, texts, signals?, logger}) and
//   to AgentHttpDeps.limits, and exposed as runtime.limits.
//   runs = createRunManager on the PG ports' admission and registry, config runConfig, guardFor =
//   B3-03i createRunGuardFactory, scheduler = seams.schedule ?? the system scheduler.
//   access / identity / consent = B3-03i createAgentAccessPort / createAgentIdentityPort /
//   createAgentConsentPort; consent over deps.consentReader({currentVersion: version}) with
//   version = createConsentVersionSource({reader: deps.contentReader, logger}); the same version
//   source goes to the guard factory. The reader through which access and the guard read the
//   agent.* switches (createAgentConfigReader over deps.contentReader.freshConfigValue, as
//   createAgentSwitchReader before B3-08k) keeps an answer for less than 1 000 ms on the injected
//   Clock (followup 23); other keys go through deps.contentReader.configValue.
//   redactor = B3-05a createAgentRedactor(); traceMask(args, table) =
//   maskForTrace(restorePlaceholders(args, table)) (followup 22), also runtime.traceMask.
//   body, labels and traceMask come from the shared createAgentBodyAssembly (./body.ts, B3-05m;
//   the local evaluation uses the same one): body = B3-05b createAgentRunBody({tools: seams.tools
//   ?? emptyOrchestratorTools(), inputCheck:
//   seams.inputCheck ?? failClosedInputCheck(), degraded: B3-05c createDegradedPath over the same
//   tools and texts, without onTrace (its cards reach the run trace as written frames, B3-08q);
//   no intents, no deterministic; review always answers timeout (B3-03j: with deps.assembly, its
//   tools / texts / deterministic / intents replace the minimal ones; seams.tools still wins); the route is fixed to no_model; prompt
//   always null; limits: orchestratorLimitsDefaults(); traceMask}). B3-03m: an assembly's safety
//   ports (createStreamReview, ./review.ts) replace the fail-closed input check (seams.inputCheck
//   still wins) and the always-timeout review; labels = createRunLabels over the same route and
//   prompt; sessions = createPgAgentSessionStore; ids = new UUIDv7 ids. B3-03n: an assembly's
//   results store is also the body's delivery receipt port (core recordDelivered of written
//   product cards); failures are logged and never end the run. No model transport is ever
//   called. seams are test seams only (production passes none).
//   B3-08q (BR-AI-19; rule tests test/spec/agent/trace-persist/**): every run's written card frames
//   (RunManagerDeps.onCardWritten) and the core's tool calls (AgentRunBodyDeps.trace, the
//   RunTraceSink) are written to app.agent_cards / app.agent_tool_calls by agent/store/results
//   createPgAgentTraceWriter (obtained at build), after the run's body settled and apart from the
//   stream (./trace.ts): a slow or failing writer changes no frame and no finish reason; a failure
//   is one warn line agent_trace_write_failed with run_id.
//   close(): stops accepting (a message after close() started is refused and opens no run), waits
//   for the runs in progress to end (at most timings.runMaxMs plus a margin; a run still live after
//   that is left to the worker's sweeper), then resolves. It never closes the database. The
//   runtime is a plain (not frozen) object; whoever stops it calls runtime.close() through it.
// B3-08k (D10-294; rule tests: test/spec/agent/foreign-db-handoff/**): content's reader is
//   deps.contentReader (app.module's, never built here): limits and the consent version over its
//   configValue, the switches over createAgentConfigReader({clock, content: deps.contentReader}),
//   and the assembly's context.contentReader (that very object). agentStreamProvider injects
//   agentContentReaderToken() and passes its value on as deps.contentReader.
//   Review r1 (the sixth place, D10-287): agent hands no database handle to any function value it
//   is handed (a deps / options property, a parameter, an injected token value), whatever agent
//   type it carries. deps.consentReader is called with {currentVersion: version} only (identity's
//   createAiConsentReader over app.module's handle; AgentConsentReaderFactory loses its db), and
//   agentStreamProvider injects it by agentConsentReaderToken() (app.module provides it on the
//   stream entry, null without a database handle) instead of options.consentReader: forStream's
//   options keep assembly and safety only. Review r2 (D10-305): deps.assembly (and the provider's
//   wrapper of options.assembly) may keep receiving the context with db, for agent's own stores:
//   the assembly app.module hands in must resolve to agent's own function with a body
//   (createProductionStreamAssembly), which the rule test proves from app.module's source.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no process.env, no import of identity.
import type { FactoryProvider } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import {
  CLOCK,
  DB,
  REDIS,
  ROOT_LOGGER,
  newUuidV7,
  systemScheduler,
  type Clock,
  type RedisHandle,
  type RootLogger,
  type Scheduler,
} from '../../../platform/index.ts';
import { agentHttpDefaults, createAgentHttp, type AgentHttp } from '../../http/index.ts';
import {
  emptyOrchestratorTools,
  failClosedInputCheck,
  type InputCheckPort,
  type OrchestratorTools,
  type AgentRunTexts,
} from '../../orchestrator/index.ts';
import type { DeliveryReceiptPort } from '../../orchestrator/core/ports.ts';
import { keepsQuoted, type ResultSetStore } from '../../orchestrator/results/index.ts';
import { createRunModelClock, type ResolvedRoute } from '../../model-gateway/routing/index.ts';
import { createAgentRedactor } from '../../preprocess/redact/index.ts';
import { agentSessionDefaults, createPgAgentSessionStore } from '../../store/index.ts';
import { createPgAgentTraceWriter } from '../../store/results/index.ts';
import {
  createAgentAccessPort,
  createAgentIdentityPort,
  createAgentConsentPort,
  createConsentVersionSource,
  createRunGuardFactory,
  type AgentConsentReader,
} from '../access/index.ts';
import {
  assertRunTimings,
  createPgRunPorts,
  createQuotaLimitsSource,
  runTimingsDefaults,
  type QuotaLimitsSource,
  type RunTimings,
} from '../pg/index.ts';
import {
  createRunManager,
  runConfigDefaults,
  type RunConfig,
  type RunRegistry,
  type RunTexts,
} from '../run/index.ts';
import {
  agentContentReaderToken,
  createAgentConfigReader,
  type AgentContentReader,
} from './config.ts';
import { agentDefaultTexts, agentText } from './texts.ts';
import type { AgentStreamAssemblyFactory, AgentStreamProvidedPorts } from './assembly.ts';
import { agentStreamPortsToken } from './production.ts';
import type { StreamReviewOptions } from './review.ts';
import { createAgentBodyAssembly } from './body.ts';
import { createRunTraceRecorder } from './trace.ts';
export { createAgentStreamAssembly } from './assembly.ts';
export type {
  AgentStreamAssembly,
  AgentStreamAssemblyContext,
  AgentStreamAssemblyFactory,
  AgentStreamAssemblyDeps,
  AgentStreamBusinessPorts,
  AgentStreamProvidedPorts,
} from './assembly.ts';
export { agentStreamPortsToken, createProductionStreamAssembly } from './production.ts';
export { createStreamReview } from './review.ts';
export type {
  StreamReviewConfigReader,
  StreamReviewDeps,
  StreamReviewOptions,
  StreamReviewPorts,
} from './review.ts';

export { createAgentBodyAssembly } from './body.ts';
export type { AgentBodyAssembly, AgentBodyAssemblyDeps } from './body.ts';

export { agentContentReaderToken, createAgentConfigReader } from './config.ts';
export type { AgentConfigReaderDeps, AgentContentReader } from './config.ts';

/**
 * identity's createAiConsentReader (B1-02r), bound by app.module to its own database handle and
 * handed in (agent never imports it). B3-08k: agent passes currentVersion only, never a handle.
 */
export type AgentConsentReaderFactory = (options: {
  readonly currentVersion: (appId: string) => Promise<number>;
}) => AgentConsentReader;

const CONSENT_READER = Symbol('AGENT_CONSENT_READER');

/**
 * B3-08k (review r1, D10-287): DI token of the AgentConsentReaderFactory app.module provides on
 * the stream entry (identity's createAiConsentReader bound to its handle; null without one);
 * agentStreamProvider injects it. The same symbol on every call.
 */
export function agentConsentReaderToken(): symbol {
  return CONSENT_READER;
}

export interface AgentStreamRuntimeDeps {
  readonly assembly?: AgentStreamAssemblyFactory;
  readonly db: Kysely<Database>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  /** Redis fast path of cancel signals; absent without Redis. */
  readonly signals?: Pick<RunRegistry, 'requestCancel' | 'cancelRequested'>;
  readonly consentReader: AgentConsentReaderFactory;
  /**
   * B3-08k (D10-294): content's reads, assembled by app.module and injected through
   * agentContentReaderToken() (agentStreamProvider passes it on). The switches of access, identity
   * and the run guard (createAgentConfigReader over it), the consent version and the daily limits
   * read only through it, and the business assembly gets it as context.contentReader; the runtime
   * builds no content reader of its own.
   */
  readonly contentReader: AgentContentReader;
}

/** Test seams only; production passes none. */
export interface AgentStreamSeams {
  readonly inputCheck?: InputCheckPort;
  readonly tools?: OrchestratorTools;
  /** The RunManager's scheduler (the system scheduler otherwise). */
  readonly schedule?: Scheduler;
}

export interface AgentStreamRuntime {
  readonly http: AgentHttp;
  readonly timings: RunTimings;
  readonly runConfig: RunConfig;
  /** The one QuotaLimitsSource of the HTTP layer and the PG ports. */
  readonly limits: QuotaLimitsSource;
  readonly texts: Pick<RunTexts, 'errorMsg'>;
  traceMask(args: unknown, placeholders: Readonly<Record<string, string>>): unknown;
  close(): Promise<void>;
}

export interface AgentStreamModuleOptions {
  /** B3-03j: the business assembly (app.module passes createProductionStreamAssembly); absent,
   * the minimal B3-03f mount. Called once per runtime with {db, clock, logger, scheduler,
   * contentReader} (B3-08k) and the value of agentStreamPortsToken() when one is provided. */
  readonly assembly?: AgentStreamAssemblyFactory;
  /** B3-03m: the content safety review configuration handed to the assembly as context.safety
   * (app.module, stream entry). Absent: the assembly's review stays fail-closed. */
  readonly safety?: StreamReviewOptions;
  // B3-08k: no consentReader / callerReader here; agentConsentReaderToken() and
  // agentCallerReaderToken() (./caller.ts) carry what app.module built over its own handle.
}

const STREAM_RUNTIME = Symbol('AGENT_STREAM_RUNTIME');

export function agentStreamToken(): symbol {
  return STREAM_RUNTIME;
}

export function agentStreamProvider(
  options: Pick<AgentStreamModuleOptions, 'assembly' | 'safety'>,
): FactoryProvider {
  return {
    provide: agentStreamToken(),
    inject: [
      CLOCK,
      ROOT_LOGGER,
      { token: DB, optional: true },
      { token: REDIS, optional: true },
      { token: agentStreamPortsToken(), optional: true },
      agentContentReaderToken(),
      agentConsentReaderToken(),
    ],
    useFactory: (
      clock: Clock,
      logger: RootLogger,
      db: Kysely<Database> | undefined,
      redis: RedisHandle | undefined,
      ports: AgentStreamProvidedPorts | null | undefined,
      contentReader: AgentContentReader | null | undefined,
      consentReader: AgentConsentReaderFactory | null | undefined,
    ): AgentStreamRuntime | null => {
      if (db == null) {
        logger.info('agent_stream_disabled');
        return null;
      }
      // app.module provides both whenever it provides the handle; anything else is a wiring error.
      if (contentReader == null || consentReader == null) {
        throw new Error('agent: the stream entry needs the content and consent readers');
      }
      // Only called after PG's ownership check and committed cancellation. PG remains the
      // authority; the fast path carries no user data and never extends a run's lifetime.
      const cache = redis?.namespace('agent_cancel');
      const signals: AgentStreamRuntimeDeps['signals'] =
        cache === undefined
          ? undefined
          : {
              async requestCancel(runId) {
                await cache.set(runId, '1', Math.ceil(runTimingsDefaults().runMaxMs / 1_000));
                return 'ok';
              },
              async cancelRequested(runId) {
                return (await cache.get(runId)) === '1';
              },
            };
      const factory = options.assembly;
      const safety = options.safety;
      const assembly: AgentStreamAssemblyFactory | undefined =
        factory === undefined
          ? undefined
          : (context) =>
              factory({
                ...context,
                ...(ports == null ? {} : { ports }),
                ...(safety === undefined ? {} : { safety }),
              });
      return createAgentStreamRuntime({
        db,
        clock,
        logger,
        contentReader,
        consentReader,
        ...(assembly === undefined ? {} : { assembly }),
        ...(signals === undefined ? {} : { signals }),
      });
    },
  };
}

/**
 * B3-03n · BR-AI-05: the business assembly's result store as the core's delivery receipt port. A
 * failed record is logged (flat fields, no card or price) and rejected again; the core keeps the
 * run going without it.
 */
function deliveryReceipts(store: ResultSetStore, logger: RootLogger): DeliveryReceiptPort {
  const failed = (fields: Record<string, string | number>, error: unknown): void => {
    logger.warn(
      { ...fields, error_name: error instanceof Error ? error.name : typeof error },
      'agent_result_receipt_failed',
    );
  };
  const port: DeliveryReceiptPort = {
    async recordDelivered(resultSetId, items) {
      try {
        await store.recordDelivered(resultSetId, items);
      } catch (error) {
        failed({ result_set_id: resultSetId, cards: items.length }, error);
        throw error;
      }
    },
  };
  // B3-03p: quoted products, when the store keeps them (memory store; the PG store since B3-03q).
  if (!keepsQuoted(store)) return port;
  return {
    ...port,
    async recordQuoted(scope, items) {
      try {
        await store.recordQuoted(scope, items);
      } catch (error) {
        failed({ run_id: scope.runId, cards: items.length }, error);
        throw error;
      }
    },
  };
}

export function createAgentStreamRuntime(
  deps: AgentStreamRuntimeDeps,
  seams?: AgentStreamSeams,
): AgentStreamRuntime {
  const { clock, logger, contentReader } = deps;
  const db = deps.db.withSchema('app');
  const timings = Object.freeze(runTimingsDefaults());
  const runConfig = Object.freeze({ ...runConfigDefaults(), maxRunMs: timings.runMaxMs });
  assertRunTimings({ ...timings, admissionRunMaxMs: runConfig.maxRunMs, sweepMarginMs: 0 });
  const scheduler = seams?.schedule ?? systemScheduler();
  const texts = agentDefaultTexts();
  const switches = createAgentConfigReader({ clock, content: contentReader });
  const version = createConsentVersionSource({ reader: contentReader, logger });
  // B3-08k: identity's reader is bound to app.module's handle; agent hands it the version only.
  const consent = deps.consentReader({ currentVersion: version });
  const limits = createQuotaLimitsSource({ reader: contentReader, logger });
  // B3-08q · BR-AI-19: every run's written cards and tool calls go to PG apart from the stream
  // (./trace.ts), through agent/store/results' trace writer obtained here, at build time.
  const trace = createRunTraceRecorder({
    writer: createPgAgentTraceWriter({ db: deps.db, newId: () => newUuidV7(clock.now()) }),
    logger,
  });
  const pg = createPgRunPorts({
    db,
    clock,
    logger,
    timings,
    limits,
    texts,
    ...(deps.signals === undefined ? {} : { signals: deps.signals }),
  });
  const runs = createRunManager({
    admission: pg.admission,
    registry: pg.registry,
    clock,
    scheduler,
    config: runConfig,
    logger,
    texts: { ...texts, text: agentText },
    guard: { check: async () => ({ code: 30501 }) },
    guardFor: createRunGuardFactory({ reader: switches, consent, version }),
    onCardWritten: (runId, card) => trace.cardWritten(runId, card),
    cards: {
      async reserve(sessionId, count) {
        if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('Invalid card count');
        const row = await db
          .updateTable('agent_sessions')
          .set({ card_seq: sql`card_seq + ${count}` })
          .where('id', '=', sessionId)
          .returning('card_seq')
          .executeTakeFirstOrThrow();
        return row.card_seq - count + 1;
      },
    },
  });
  // B3-03j: the business assembly is built once, with nothing running (no query, no timer).
  // B3-08k: the context keeps the handle for agent's own stores; content's reads are contentReader.
  const business = deps.assembly?.({ db: deps.db, clock, logger, scheduler, contentReader });
  const tools = seams?.tools ?? business?.tools ?? emptyOrchestratorTools();
  const runTexts: AgentRunTexts = business?.texts ?? {
    text: async (_appId, key) => agentText(key),
    // No model tools are registered in the minimal mount.
    toolDisplay: async () => {
      throw new Error('No model tool display in this runtime');
    },
  };
  const route = async (): Promise<ResolvedRoute> => ({
    mode: 'no_model',
    attempts: [],
    dropped: [],
  });
  const prompt = { current: async () => null };
  const { body, traceMask, labels } = createAgentBodyAssembly({
    tools,
    inputCheck: seams?.inputCheck ?? business?.safety?.inputCheck ?? failClosedInputCheck(),
    errorMsg: async (_appId, code) => texts.errorMsg(code),
    ...(business === undefined
      ? {}
      : {
          deterministic: business.deterministic,
          intents: business.intents,
          results: deliveryReceipts(business.results, logger),
        }),
    model: {
      complete: async () => {
        await route();
        return { kind: 'degraded', reason: 'route_no_model', attempts: [] };
      },
    },
    modelClock: () => createRunModelClock(timings.runMaxMs),
    trace: trace.sink,
    review: business?.safety?.review ?? { review: async () => 'timeout' },
    // B3-03p: the per-app output review, when the assembly's safety ports carry one.
    ...(business?.safety?.outputReview === undefined
      ? {}
      : { outputReview: business.safety.outputReview }),
    texts: runTexts,
    prompt,
    route,
  });

  let stopping = false;
  let closing: Promise<void> | undefined;
  const active = new Set<Promise<void>>();
  const http = createAgentHttp({
    access: createAgentAccessPort({ reader: switches }),
    identity: createAgentIdentityPort({ reader: switches }),
    consent: createAgentConsentPort({ consent, version }),
    sessions: createPgAgentSessionStore({ db, clock, ...agentSessionDefaults() }),
    admission: {
      admit: (request, currentLimits) => {
        // A request already checking consent when shutdown starts cannot enter admission.
        if (stopping) return Promise.reject(new Error('Agent stream is stopping'));
        return pg.admission.admit(request, currentLimits);
      },
    },
    runs,
    cancel: pg.cancel,
    limits,
    body: (input) => trace.body(input, body(input)),
    redactor: createAgentRedactor(),
    labels,
    settings: agentHttpDefaults(),
    texts,
    ids: () => newUuidV7(clock.now()),
    clock,
    logger,
  });
  function tracked<T extends unknown[]>(
    operation: (...args: T) => Promise<void>,
    ...args: T
  ): Promise<void> {
    const task = operation(...args);
    active.add(task);
    void task.then(
      () => active.delete(task),
      () => active.delete(task),
    );
    return task;
  }
  return {
    timings,
    runConfig,
    limits,
    texts,
    traceMask,
    http: {
      ...http,
      sendMessage(caller, sessionId, message, reply) {
        if (stopping) {
          reply.json(
            500,
            { 'content-type': 'application/json' },
            {
              code: 50001,
              msg: texts.errorMsg(50001),
              trace_id: caller.traceId,
            },
          );
          return Promise.resolve();
        }
        return tracked(http.sendMessage, caller, sessionId, message, reply);
      },
    },
    close() {
      stopping = true;
      closing ??= (async () => {
        if (active.size === 0) return;
        const wait = new AbortController();
        try {
          await Promise.race([
            Promise.allSettled([...active]),
            scheduler.sleep(timings.runMaxMs + timings.lockGraceMs, wait.signal),
          ]);
        } finally {
          wait.abort();
        }
      })();
      return closing;
    },
  };
}
