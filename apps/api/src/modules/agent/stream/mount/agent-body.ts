// B3-05o: the one composition of the stream entry's agent body over its business assembly
// (createAgentStreamAssembly), so the model path, the intent port, the result tools, the delivery
// receipts and the routed no-model path are wired exactly once. createAgentStreamRuntime (./index.ts)
// builds its body through this function whenever it has a business assembly; rule tests build the
// same body over synthetic data ports (test/spec/agent/intent-fallback/**). Behaviour contract:
// ../../orchestrator/core/intent-fallback.ts (intent fallback, never empty, title-based notice,
// {q_short}).
//
// Explicit ports here take precedence over the assembly's safety ports (inputCheck, review); the
// tools, intents, deterministic path, delivery receipts (business.results, failures logged through
// `logger`), texts and the degraded ports all come from `business`.
import type { RootLogger } from '../../../platform/index.ts';
import type {
  EmptyReplyCounter,
  EmptyReplyLogMessage,
} from '../../orchestrator/core/intent-fallback.ts';
import type {
  AgentRunBodyDeps,
  DeliveryReceiptPort,
  EmptyReplyPort,
  SessionProductsPort,
} from '../../orchestrator/core/ports.ts';
import {
  keepsQuoted,
  readsRecentQuotes,
  type ResultSetStore,
} from '../../orchestrator/results/index.ts';
import type { AgentDegradedPorts, AgentStreamAssembly } from './assembly.ts';
import { createAgentBodyAssembly } from './body.ts';
import type { AgentBodyAssembly, AgentBodyAssemblyDeps } from './body.ts';

export interface StreamAgentBodyDeps {
  /** The business assembly of the stream entry (createAgentStreamAssembly). */
  readonly business: AgentStreamAssembly;
  readonly model: AgentRunBodyDeps['model'];
  readonly modelClock: AgentRunBodyDeps['modelClock'];
  readonly prompt: AgentRunBodyDeps['prompt'];
  readonly inputCheck: AgentRunBodyDeps['inputCheck'];
  readonly review: AgentRunBodyDeps['review'];
  readonly trace?: AgentRunBodyDeps['trace'];
  readonly route: AgentBodyAssemblyDeps['route'];
  readonly errorMsg: AgentBodyAssemblyDeps['errorMsg'];
  readonly logger: RootLogger;
  /** 不空回复 counter: one record() per run filled with agent.reply.empty (intent-fallback.ts rule 3,
   * which also writes one `logger` line with message EmptyReplyLogMessage). */
  readonly emptyReplies: EmptyReplyCounter;
}

const EMPTY_REPLY_LOG: EmptyReplyLogMessage = 'agent_reply_empty';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * B3-03n · BR-AI-05: the business assembly's result store as the core's delivery receipt port. A
 * failed record is logged (flat fields, no card or price) and rejected again; the core keeps the
 * run going without it.
 */
export function deliveryReceipts(store: ResultSetStore, logger: RootLogger): DeliveryReceiptPort {
  const failed = (fields: Record<string, string | number>, error: unknown): void => {
    logger.warn({ ...fields, error_name: errorName(error) }, 'agent_result_receipt_failed');
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

/** 不空回复: one info line (message agent_reply_empty, flat fields) and one record() per filled run;
 * a counter that throws is one warn line and never changes the run. */
function emptyReplyPort(logger: RootLogger, counter: EmptyReplyCounter): EmptyReplyPort {
  return {
    filled({ appId, runId, finishReason }) {
      logger.info({ app_id: appId, run_id: runId, finish_reason: finishReason }, EMPTY_REPLY_LOG);
      try {
        counter.record();
      } catch (error) {
        logger.warn(
          { run_id: runId, error_name: errorName(error) },
          'agent_reply_empty_count_failed',
        );
      }
    },
  };
}

/** BR-AI-05 上下文块: how many earlier turns the conversation keeps (0 = none). */
const CONTEXT_TURNS_KEY = 'agent.context.max_turns';
/** Its default (config registry), also used when the value cannot be read. */
const DEFAULT_CONTEXT_TURNS = 8;

async function contextTurns(
  config: AgentDegradedPorts['config'] | undefined,
  appId: string,
): Promise<number> {
  if (config === undefined) return DEFAULT_CONTEXT_TURNS;
  try {
    const value = (await config.configValue(appId, CONTEXT_TURNS_KEY))?.value;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? value
      : DEFAULT_CONTEXT_TURNS;
  } catch {
    return DEFAULT_CONTEXT_TURNS;
  }
}

/**
 * 比较提示 (BR-AI-18 细则「比较与适用性的提示」): the session's current result set (the latest one
 * that delivered products), or B3-05p a rebate_quote card in the recent conversation — one of the
 * session's latest agent.context.max_turns runs before this one (default 8; 0 = no history), same
 * app and session only (store.quotedRecently). A failed read is one warn line and false.
 */
export function sessionProducts(
  store: ResultSetStore,
  logger: RootLogger,
  config: AgentDegradedPorts['config'] | undefined,
): SessionProductsPort {
  return {
    async inContext(appId, sessionId, runId) {
      try {
        if ((await store.latestWithProducts(appId, sessionId)) !== null) return true;
        if (!readsRecentQuotes(store)) return false;
        const turns = await contextTurns(config, appId);
        return await store.quotedRecently({ appId, sessionId, runId }, turns);
      } catch (error) {
        logger.warn({ error_name: errorName(error) }, 'agent_session_products_failed');
        return false;
      }
    },
  };
}

export function createStreamAgentBody(deps: StreamAgentBodyDeps): AgentBodyAssembly {
  const { business, logger } = deps;
  const outputReview = business.safety?.outputReview;
  const degraded = business.degraded;
  return createAgentBodyAssembly({
    model: deps.model,
    modelClock: deps.modelClock,
    prompt: deps.prompt,
    inputCheck: deps.inputCheck,
    review: deps.review,
    ...(outputReview === undefined ? {} : { outputReview }),
    ...(deps.trace === undefined ? {} : { trace: deps.trace }),
    route: deps.route,
    errorMsg: deps.errorMsg,
    tools: business.tools,
    texts: business.texts,
    deterministic: business.deterministic,
    intents: business.intents,
    results: deliveryReceipts(business.results, logger),
    emptyReplies: emptyReplyPort(logger, deps.emptyReplies),
    sessionProducts: sessionProducts(business.results, logger, degraded?.config),
    // B3-05n: the routed no-model path (BR-AI-14 细则「无模型降级」), over the assembly's ports.
    ...(degraded === undefined
      ? {}
      : {
          config: degraded.config,
          clock: degraded.clock,
          routes: degraded.routes,
          previousIntent: degraded.previousIntent,
          degradedTools: degraded.tools,
        }),
  });
}
