// B3-05o · BR-AI-01 细则「意图兜底与不空回复」, BR-AI-18 细则「比较与适用性的提示」, BR-AI-07 判定规则 7,
// BR-TEXT-22 agent.suggest.no_result.2 ({q_short}). Contract only (types and this header); the
// behaviour lives in the core run and its production composition (stream/mount/agent-body.ts).
// Rule tests: test/spec/agent/intent-fallback/**.
//
// 1. Intent fallback. The model's final round is an intent object and this run made no call of the
//    tool behind that intent: the server serves the intent itself, identity first, then the tool's
//    availability (BR-AI-01 判定顺序 ③④ unchanged: guest → auth_required(login), not phone-bound →
//    auth_required(bind_phone), tool off → page guide card; B3-05p: for order_query the one order
//    tool this message needs (fallbackOrderTool) decides, so one order tool off is like both off):
//      order_query    → list_my_orders, date_from = today − agent.orders.default_span_days (30, never
//                       above agent.orders.max_span_days), date_to = today, both +08:00 calendar days
//                       of the injected Clock; when the message holds a long-number placeholder
//                       (BR-AI-14) → explain_order instead, order_no = the string containing the first
//                       placeholder with the digits, letters and hyphens right next to it, platform
//                       only when this message names exactly that platform (never guessed from the
//                       number or earlier turns); not found without platform → platform_required:
//                       text order_list.empty, no card, no question asked;
//      earnings_query → get_my_earnings;
//      rule_qa        → search_rules, question = this message's redacted text;
//      handoff        → handoff_to_human;
//      search / find_by_link (no call, no link) → BR-AI-14 细则「无模型降级」⑥ keyword search,
//                       the run ends done stop.
//    Replies follow BR-AI-07 templates (the core's reply-templates.ts), never the model's text.
// 2. Every server-initiated call counts toward limits.toolCalls together with the model's calls of
//    the run; with no call left none is made and rule 3 applies. explain_order by order_no takes the
//    daily by-number quota (agent.explain_order.order_no_daily_max) like a model call (over it:
//    rate_limited, agent.order.lookup_limited). The run trace records the call like a model call
//    (name, masked args, status) plus `initiator: 'server'` (ServerInitiatedToolCall); the model's
//    own calls are never marked 'server'.
// 3. Never empty. A run ending done stop or done limit that delivered no text, card or suggestions
//    gets the text agent.reply.empty and the suggestions agent.suggest.empty.1–3 (text = send_text),
//    plus one log line (message EmptyReplyLogMessage) and one EmptyReplyCounter.record(); a run
//    that is not filled logs and counts nothing. A run that delivered only notice cards is not
//    empty. Blank model text (white space only) delivers nothing. Cancellation, errors, the run time limit and
//    safety endings keep their own wording and get nothing added.
// 4. Title-based notice. The model called no tool this run, gave no intent object, and text of its
//    explanation was actually delivered, while the session has product cards in context (its
//    current result set, or the scenario entry's product card; B3-05p: or a rebate_quote card of
//    one of the session's latest agent.context.max_turns runs, default 8): the notice
//    agent.notice.title_based follows the text (server-built; the model never writes it).
// 5. {q_short}. agent.suggest.no_result.2 has {q_short} replaced by the first 8 characters (Unicode
//    code points) of this search's q, in text and send_text alike; with no search term the second
//    suggestion is left out. No delivered text or suggestion keeps a brace placeholder.
//
// Implementation: the core (run.ts) binds this run's ServerToolCalls to the context it hands the
// IntentPort (bindServerCalls / serverCallsOf); the port's continuation (results/continuation.ts)
// calls serveIntentFallback for an intent left without its tool, after the port's identity and
// availability checks. Rule 3 and rule 4 are the core's (run.ts neverEmpty / titleBased); rule 5 is
// results/shared.ts noResultSuggestions.

import { randomUUID } from 'node:crypto';
import { platform as platformEnum } from '@couli/contracts-ts';
import type { Clock } from '../../../platform/index.ts';
import type { RunBodyResult, RunContext } from '../../stream/run/index.ts';
import {
  greetingOnly,
  orderNumberOf,
  readMessage,
  type MessageText,
} from '../degraded/classify.ts';
import { extractSearchTerms, platformsIn } from '../degraded/extract.ts';
import { emptyReply } from '../degraded/replies.ts';
import { calendarDay } from '../degraded/calendar.ts';
import type { AgentRunTexts, OrchestratorToolCall, PathInput, ToolOutcome } from './ports.ts';

/** The mark a server-initiated tool call carries in OrchestratorTrace.tool_calls (rule 2). */
export interface ServerInitiatedToolCall {
  readonly initiator: 'server';
}

/** The message of the one log line written when a run is filled with agent.reply.empty (rule 3). */
export type EmptyReplyLogMessage = 'agent_reply_empty';

/** The 不空回复 counter (rule 3): one record() per run filled with agent.reply.empty, none otherwise.
 * The stream entry passes it to createStreamAgentBody (StreamAgentBodyDeps.emptyReplies). */
export interface EmptyReplyCounter {
  record(): void;
}

/** Intents the server serves itself when the model named one without calling its tool (rule 1). */
export type FallbackIntent =
  'order_query' | 'earnings_query' | 'rule_qa' | 'handoff' | 'search' | 'find_by_link';

const FALLBACK_INTENTS: readonly string[] = [
  'order_query',
  'earnings_query',
  'rule_qa',
  'handoff',
  'search',
  'find_by_link',
];

export function isFallbackIntent(name: string): name is FallbackIntent {
  return FALLBACK_INTENTS.includes(name);
}

/** What one server-initiated call came to (rule 2). */
export type ServerToolCallResult =
  /** The tool is not among this run's offered definitions: nothing ran, nothing counted. */
  | { readonly kind: 'unavailable' }
  /** limits.toolCalls is spent: nothing ran (rule 3 follows). */
  | { readonly kind: 'exhausted' }
  /** The run ends here (cancelled, an output cap reached by the call's cards). */
  | { readonly kind: 'ended'; readonly result: RunBodyResult }
  /** The call ran, was counted and traced; an ok outcome's cards and suggestions are delivered. */
  | { readonly kind: 'called'; readonly outcome: ToolOutcome };

/**
 * B3-05o: the core's server-initiated calls of one run, handed to the IntentPort with the final
 * round (IntentRequest.server). Calls run exactly like a model call (tool.status, card references,
 * delivery receipts, BR-AI-07 template bookkeeping, the run's output caps) and count toward the
 * same limits.toolCalls; the trace marks them `initiator: 'server'`.
 */
export interface ServerToolCalls {
  /** The tool is among this run's offered definitions (registered, switched on, audience). */
  offered(name: string): boolean;
  /** The model asked for this tool in this run (rule 1: then the server never calls it). */
  calledByModel(name: string): boolean;
  call(call: OrchestratorToolCall): Promise<ServerToolCallResult>;
}

/** The server calls of each IntentPort.handle call, keyed by the context the core handed it. */
const bound = new WeakMap<object, ServerToolCalls>();

/**
 * Core only: binds `server` to `ctx`, the fresh guarded context handed to one IntentPort.handle
 * call (as core/degraded-intent.ts binds its slot): only code holding that very context reaches
 * the run's server calls; a copied context does not.
 */
export function bindServerCalls(ctx: RunContext, server: ServerToolCalls): void {
  bound.set(ctx, server);
}

/** The run's server calls on the context the core handed the IntentPort, else null. */
export function serverCallsOf(ctx: RunContext): ServerToolCalls | null {
  return bound.get(ctx) ?? null;
}

/** What the fallback reads besides the run (configuration, clock, enabled search platforms). */
export interface IntentFallbackDeps {
  readonly config: {
    configValue(appId: string, key: string): Promise<{ readonly value: unknown } | null>;
  };
  readonly clock: Clock;
  readonly texts: Pick<AgentRunTexts, 'text'>;
  enabledSearchPlatforms(appId: string): Promise<readonly string[]>;
  /** The server-built keyword search's call (results: a marker for no relaxation, no clarify). */
  keywordCall?(call: OrchestratorToolCall): OrchestratorToolCall;
}

const ORDER_SPAN_KEY = 'agent.orders.default_span_days';
const ORDER_MAX_SPAN_KEY = 'agent.orders.max_span_days';
const DEFAULT_SPAN_DAYS = 30;
const DEFAULT_MAX_SPAN_DAYS = 90;
/** explain_order's order_no bound (tools/orders) and search_rules' question bound (tools/rules). */
const MAX_ORDER_NO = 64;
const MAX_QUESTION = 200;
const PLATFORMS: readonly string[] = platformEnum;
const MS_PER_DAY = 86_400_000;
const PLUS_EIGHT_MS = 8 * 3_600_000;
/** A failed server search (no model turn follows to explain it): the 50302 copy as a notice. */
const SEARCH_FAILED_KEY = 'error.50302';

type Done = Extract<RunBodyResult, { kind: 'done' }>;
const stop = (): Done => ({ kind: 'done', finishReason: 'stop' });

/** The tools behind each intent (rule 1: a model call of any of them means no fallback). */
function toolsOf(intent: FallbackIntent): readonly string[] {
  switch (intent) {
    case 'order_query':
      return ['list_my_orders', 'explain_order'];
    case 'earnings_query':
      return ['get_my_earnings'];
    case 'rule_qa':
      return ['search_rules'];
    case 'handoff':
      return ['handoff_to_human'];
    case 'search':
    case 'find_by_link':
      return ['search_products'];
  }
}

async function configValue(deps: IntentFallbackDeps, appId: string, key: string): Promise<unknown> {
  try {
    return (await deps.config.configValue(appId, key))?.value;
  } catch {
    return undefined;
  }
}

function positiveDays(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** The single platform this message names (BR-AI-07 判定规则 7); none or several: undefined. */
function namedPlatform(named: readonly string[]): string | undefined {
  return named.length === 1 && PLATFORMS.includes(named[0]!) ? named[0] : undefined;
}

class Fallback {
  private readonly appId: string;
  private readonly message: MessageText;
  private readonly server: ServerToolCalls;
  private readonly deps: IntentFallbackDeps;
  private readonly ctx: RunContext;

  constructor(
    deps: IntentFallbackDeps,
    request: PathInput,
    server: ServerToolCalls,
    ctx: RunContext,
  ) {
    this.deps = deps;
    this.server = server;
    this.ctx = ctx;
    this.appId = request.input.caller.appId;
    this.message = readMessage(request.proceed.modelText);
  }

  /** One server call; a run that has to end here gives its result, anything else null. */
  private async call(
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly ended: RunBodyResult } | { readonly outcome: ToolOutcome | null }> {
    const base: OrchestratorToolCall = { id: `server-${randomUUID()}`, name, args };
    const keyword = name === 'search_products' ? this.deps.keywordCall : undefined;
    const result = await this.server.call(keyword === undefined ? base : keyword(base));
    switch (result.kind) {
      case 'ended':
        return { ended: result.result };
      case 'called':
        return { outcome: result.outcome };
      default:
        return { outcome: null };
    }
  }

  private async single(
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<RunBodyResult> {
    const called = await this.call(name, args);
    return 'ended' in called ? called.ended : stop();
  }

  async serve(intent: FallbackIntent): Promise<RunBodyResult> {
    if (toolsOf(intent).some((tool) => this.server.calledByModel(tool))) return stop();
    switch (intent) {
      case 'order_query':
        return this.orders();
      case 'earnings_query':
        return this.single('get_my_earnings', {});
      case 'rule_qa':
        return this.rules();
      case 'handoff':
        return this.single('handoff_to_human', {});
      case 'search':
      case 'find_by_link':
        return this.search();
    }
  }

  private async orders(): Promise<RunBodyResult> {
    const trusted = this.message.trusted;
    const orderNo = orderNumberOf(this.message, MAX_ORDER_NO);
    // B3-05p: only the tool this message needs (fallbackOrderTool); the IntentPort has already
    // answered with the page guide when it is not offered, so this never falls back to the other.
    if (orderNo !== null) {
      if (!this.server.offered('explain_order')) return stop();
      const platform = namedPlatform(platformsIn(trusted));
      return this.single('explain_order', {
        order_no: orderNo,
        ...(platform === undefined ? {} : { platform }),
      });
    }
    if (!this.server.offered('list_my_orders')) return stop();
    const [span, max] = await Promise.all([
      configValue(this.deps, this.appId, ORDER_SPAN_KEY),
      configValue(this.deps, this.appId, ORDER_MAX_SPAN_KEY),
    ]);
    if (this.ctx.signal.aborted) return stop();
    const days = Math.min(
      positiveDays(span, DEFAULT_SPAN_DAYS),
      positiveDays(max, DEFAULT_MAX_SPAN_DAYS),
    );
    const today = Math.floor((this.deps.clock.now().getTime() + PLUS_EIGHT_MS) / MS_PER_DAY);
    return this.single('list_my_orders', {
      date_from: calendarDay(today - days),
      date_to: calendarDay(today),
    });
  }

  private async rules(): Promise<RunBodyResult> {
    // This message's redacted text (placeholders and masks kept), never the raw message.
    const question = [...this.message.trustedRaw].slice(0, MAX_QUESTION).join('').trim();
    if (question === '') return stop();
    return this.single('search_rules', { question });
  }

  /** BR-AI-14 细则「无模型降级」⑥: the code reading of the message, searched once, never relaxed. */
  private async search(): Promise<RunBodyResult> {
    const free = this.message.free;
    if (greetingOnly(free)) return emptyReply(this.deps.texts, this.appId, this.ctx, true);
    const terms = extractSearchTerms(free);
    // Nothing to search: the run ends empty and is filled by rule 3.
    if (terms.q === '') return stop();
    if (!this.server.offered('search_products')) return stop();
    const enabled = await this.deps.enabledSearchPlatforms(this.appId);
    if (this.ctx.signal.aborted) return stop();
    const platforms =
      terms.named.length === 0 ? [...enabled] : enabled.filter((p) => terms.named.includes(p));
    if (platforms.length === 0) return stop();
    const called = await this.call('search_products', {
      q: terms.q,
      platforms,
      sort: terms.sort,
      ...(terms.priceMinFen === undefined ? {} : { price_min_fen: terms.priceMinFen }),
      ...(terms.priceMaxFen === undefined ? {} : { price_max_fen: terms.priceMaxFen }),
      ...(terms.exclude.length === 0 ? {} : { exclude_keywords: [...terms.exclude] }),
    });
    if ('ended' in called) return called.ended;
    if (called.outcome !== null && called.outcome.kind !== 'ok') {
      // No model turn follows to explain the failure: the search-unavailable copy as a notice.
      const fallback = await this.deps.texts.text(this.appId, SEARCH_FAILED_KEY);
      if (this.ctx.signal.aborted) return stop();
      await this.ctx.card({
        type: 'notice',
        schema_version: 1,
        data: { level: 'warn', text_key: SEARCH_FAILED_KEY, actions: [] },
        fallback_text: fallback,
      });
    }
    return stop();
  }
}

/**
 * B3-05p · BR-AI-01 判定顺序④ (D10-1378): the one order tool rule 1 calls for this message —
 * explain_order when it holds a long-number placeholder, else list_my_orders. When that tool is not
 * offered the IntentPort answers as with both order tools off (the OrderList page guide, or only
 * agent.guide.unavailable when the guide is rejected); the other order tool is never called instead.
 */
export function fallbackOrderTool(request: PathInput): 'explain_order' | 'list_my_orders' {
  const message = readMessage(request.proceed.modelText);
  return orderNumberOf(message, MAX_ORDER_NO) === null ? 'list_my_orders' : 'explain_order';
}

/**
 * Rule 1: the server serves `intent` itself, through the core's server calls of this run. Identity
 * and the 判定顺序 ④ guide are the IntentPort's (it calls this only for a phone-bound caller of a
 * personal intent whose tools are available). Returns done stop unless the run has to end
 * otherwise; a run that delivered nothing is filled by the core (rule 3).
 */
export function serveIntentFallback(
  intent: FallbackIntent,
  request: PathInput,
  server: ServerToolCalls,
  ctx: RunContext,
  deps: IntentFallbackDeps,
): Promise<RunBodyResult> {
  if (ctx.signal.aborted) return Promise.resolve(stop());
  return new Fallback(deps, request, server, ctx).serve(intent);
}

/** Rule 5: {q_short} = the first 8 code points of `q`. */
export function qShort(q: string): string {
  return [...q].slice(0, 8).join('');
}
