// B3-05b: downstream contracts (ports). The core lives in factories.ts, run.ts and output.ts.
//
// Invalid model format (BR-AI-06: the model never outputs card JSON). When a round's whole text,
// after trimming and removing one ``` fence, is structured data — it opens with `{`, or is a JSON
// array / array-looking text, parseable or not — that text is never delivered (tool rounds and the
// final round alike). The {"agent_intent": …} handling runs first and is unchanged. Before any
// model / tool text, card or suggestions was delivered (input notices do not count, plan U-11) the
// run degrades exactly like "no usable model answer": DegradedPath with reason `models_failed`
// (done fallback, or whatever the path returns). After delivery the guard tail is flushed and the
// run ends done stop. OrchestratorTrace.model_format_invalid records the deviation.
import type { Platform } from '@couli/contracts-ts';
import type { Candidate } from '../../../parsing/index.ts';
import type { AgentCaller, RunBodyInput } from '../../http/index.ts';
import type { FilterHit, SentenceReviewPort } from '../../guard/index.ts';
import type {
  DegradeReason,
  KeywordSearchPlan,
  PlatformSearchResult,
} from '../../model-gateway/degraded/index.ts';
import type { ToolDefinition } from '../../model-gateway/openai-compat/index.ts';
import type {
  AttemptRecord,
  ModelRouter,
  ResolvedRoute,
  RunModelClock,
} from '../../model-gateway/routing/index.ts';
import type { RunBodyResult, RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import type { SuggestionsData } from '../../stream/writer/index.ts';

// B3-05i: exported function port; tools inject cardReference(ctx, outcome.cards index).
// Import from ./card-references.ts; see its contract for delivery/removal semantics.
// Each execute call gets its own frozen copy of the run's placeholders table: that object's
// identity binds references to the call, so wrappers must forward ctx.placeholders by reference.
// Card ids come from RunContext.card's `delivered` receipt callback (the written frame's card_id);
// a card without a receipt counts as undelivered and its references are removed.

export interface OrchestratorLimits {
  readonly toolCalls: number;
  readonly modelRounds: number;
  readonly textCodePoints: number;
  /** Includes embedded product cards; the containing card also counts. */
  readonly cards: number;
  /** text.delta + card + suggestions; excludes tool.status and embedded cards. */
  readonly contentFrames: number;
}

export interface InputProceed {
  readonly kind: 'proceed';
  readonly modelText: string;
  /** Run-local only; never sent to the model or trace. */
  readonly placeholders: Readonly<Record<string, string>>;
  readonly links: readonly Candidate[];
  /** Core emits once, in order, before model/path output; counted against run limits,
   * but NOT as delivered model/tool content for the no-degrade rule (plan U-11).
   * Downstream paths receive these for context only and MUST NOT re-emit them. */
  readonly notices: readonly UnnumberedCard[];
  readonly untrustedInput: boolean;
  readonly paramsRequested: boolean;
}

export type InputCheckResult =
  | InputProceed
  | {
      readonly kind: 'refuse';
      readonly textKey: string;
      readonly finishReason: Extract<RunBodyResult, { kind: 'done' }>['finishReason'];
      readonly ending?: 'input_review_timeout';
    };

export interface InputCheckPort {
  check(input: RunBodyInput, signal: AbortSignal): Promise<InputCheckResult>;
}

export interface OrchestratorToolCall {
  readonly id: string;
  readonly name: string;
  /** Parsed model arguments, unchanged (including placeholders and forbidden fields). */
  readonly args: unknown;
}

export interface ToolContext {
  readonly subject: AgentCaller;
  /** Scenario entry, passed unchanged from RunBodyInput.context. */
  readonly context?: RunBodyInput['context'];
  readonly runId: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly placeholders: Readonly<Record<string, string>>;
}

export interface ToolTraceFragment {
  readonly card_sources?: readonly {
    readonly card_id: string;
    readonly fields: Readonly<Record<string, number | string | boolean | null>>;
  }[];
  readonly link_registrations?: readonly {
    readonly link_id: string;
    readonly product_key: string;
    readonly ok: boolean;
  }[];
}

export type ToolOutcome =
  | {
      readonly kind: 'ok';
      readonly modelView: unknown;
      readonly cards: readonly UnnumberedCard[];
      readonly suggestions?: SuggestionsData['items'];
      readonly trace?: ToolTraceFragment;
    }
  | { readonly kind: 'failed'; readonly modelView: unknown }
  | { readonly kind: 'rejected'; readonly modelView: { readonly error: 'invalid_args' } };

export interface KeywordSearchOutcome {
  readonly results: readonly PlatformSearchResult[];
  readonly cards: readonly UnnumberedCard[];
  readonly trace?: ToolTraceFragment;
}

export interface OrchestratorTools {
  definitions(appId: string, subject: AgentCaller): Promise<readonly ToolDefinition[]>;
  execute(call: OrchestratorToolCall, ctx: ToolContext): Promise<ToolOutcome>;
  enabledSearchPlatforms(appId: string): Promise<readonly string[]>;
  searchKeyword(plan: KeywordSearchPlan, ctx: ToolContext): Promise<KeywordSearchOutcome>;
}

export interface PathInput {
  readonly input: RunBodyInput;
  readonly proceed: InputProceed;
}

/** B3-05n · BR-AI-14 细则「无模型降级」: the intents the no-model path routes a message to
 * (① page_guide, ② rule_qa, ③ order_query, ④ earnings_query, ⑤ handoff, ⑥ search). */
export const DEGRADED_INTENTS = [
  'page_guide',
  'rule_qa',
  'order_query',
  'earnings_query',
  'handoff',
  'search',
] as const;
export type DegradedIntent = (typeof DEGRADED_INTENTS)[number];

/**
 * Receives a guarded RunContext: cancellation and all output limits still apply. The core calls
 * `run` only. B3-05n: the path registers the intent it routed the message to on that same context
 * (core/degraded-intent.ts routeDegradedIntent); without a registration the run's intent is
 * `search`.
 */
export interface DegradedPath {
  run(
    request: PathInput & { readonly reason: DegradeReason },
    ctx: RunContext,
  ): Promise<RunBodyResult>;
}

export interface DeterministicPath {
  run(request: PathInput, ctx: RunContext): Promise<RunBodyResult>;
}

export interface IntentPort {
  /** Final-round text only. null means ordinary explanation; otherwise the port owns output.
   * B3-05o: `ctx` carries this run's server-initiated calls (intent-fallback.ts serverCallsOf). */
  handle(
    request: PathInput & { readonly text: string },
    ctx: RunContext,
  ): Promise<RunBodyResult | null>;
}

export interface AgentRunTexts {
  text(appId: string, key: string): Promise<string>;
  /** Template lookup only: registered tool + validated platform enum, never raw arguments.
   * Missing/invalid platform uses the generic template (undefined). */
  toolDisplay(
    appId: string,
    tool: string,
    phase: 'start' | 'end' | 'failed',
    platform?: Platform,
  ): Promise<string>;
}

/** Immutable prompt release for the wiring lifetime; labels and body share this source.
 * Deploy a new source with the release, not a mutable "latest" between labels and body. */
export interface PromptSource {
  current(appId: string): Promise<{ readonly version: string; readonly system: string } | null>;
}

export interface OrchestratorTrace extends ToolTraceFragment {
  readonly intent: string | null;
  /** Actual last successful ModelOutcome.model; null when no model answered. */
  readonly model: string | null;
  /** All router attempt records in round order, including failed primary attempts. */
  readonly attempts: readonly AttemptRecord[];
  /** Version of the prompt actually used, or 'none' without a model prompt. */
  readonly prompt_version: string;
  readonly tool_calls: readonly {
    readonly name: string;
    /** Exact storage-safe result from the injected traceMask port.
     * Core does not restore placeholders or implement masking rules. */
    readonly args: unknown;
    readonly status: 'ok' | 'failed' | 'rejected';
    /** B3-05o: present only on a server-initiated call (intent-fallback.ts rule 2). */
    readonly initiator?: 'server';
  }[];
  readonly output_filtered: boolean;
  readonly filter_hits: readonly FilterHit[];
  readonly output_truncated: boolean;
  /** A model round answered with structured text (card JSON etc.) that was not delivered. */
  readonly model_format_invalid: boolean;
  /** B3-08m · BR-AI-07: true when template text replaced the model's reply (reply-templates.ts);
   * false or absent otherwise. */
  readonly text_replaced_by_template?: boolean;
}

export interface RunTraceSink {
  record(runId: string, trace: OrchestratorTrace): void;
}

/**
 * B3-03n · BR-AI-05 (followup 44): the result set's trusted delivery hook (ResultSetStore's
 * recordDelivered). After a successful tool call's product_list card was written, the core records
 * that list's embedded product cards under its data.result_set_id: each product's own delivered
 * card_id (the session sequence, frame first, then its items), in delivery order. A card cut by
 * the output limits, or never written because the run was cancelled or the context gave no
 * receipt, is not recorded; notices and other card types are never product cards.
 */
export interface DeliveryReceiptPort {
  recordDelivered(resultSetId: string, items: readonly DeliveredProductReceipt[]): Promise<void>;
  /**
   * B3-03p · BR-AI-05: the product embedded in a written rebate_quote card (no result set), under
   * the run's app, session and run; findable by its card_id in later rounds of that session, never
   * part of the result set 「第 N 个」 addresses. Absent: quoted products are not recorded.
   */
  recordQuoted?(scope: QuotedScope, items: readonly DeliveredProductReceipt[]): Promise<void>;
}

/** Server-side scope of a quoted product's receipt (never from model arguments). */
export interface QuotedScope {
  readonly appId: string;
  readonly sessionId: string;
  readonly runId: string;
}

/*
 * B3-03p · BR-AI-05 (followups 49, 51): the same receipts on every path, not only the model's tool
 * calls. A product_list written through the guarded RunContext the core hands to the degraded
 * path, the deterministic path or the intent port (再便宜点 / 换一批 / 换平台 …) is recorded exactly
 * as above (its own embedded card_ids, delivery order, frame first; cut by the output limits,
 * cancelled or without a receipt: nothing). The product embedded in a written rebate_quote card
 * (04 §8.2: rebate_quote.product takes the next card_id after its frame) is recorded too, so the
 * session can quote it again by that card_id in a later round; it never becomes the result set that
 * 「第 N 个」 addresses (BR-AI-05: the latest result set with a product_list). Notices and other
 * card types are never product cards. A record that fails or throws is dropped (the stream entry
 * logs it); the run's output and result do not change. Any port member added for this is
 * optional: a body without it behaves as before.
 */

/**
 * B3-03p · BR-AI-18 (followups 52, 53): the output-side sentence review of one run, for that run's
 * app. With AgentRunBodyDeps.outputReview, the core calls forRun(input.caller.appId, ctx.signal)
 * once per run that reaches the model path and builds that run's OutputGuard over the returned
 * port instead of AgentRunBodyDeps.review. Every review call of the returned port is bounded by
 * agent.safety.timeout_ms of that app, read for this run through the content configuration port
 * (no build-time value): a missing key is the BR-AI-18 default 1000 ms, a value that is not a
 * finite positive number takes the same default (the configuration layer's rule). The wait for
 * that read counts toward the same limit as the review it precedes (one deadline from the start
 * of the call, never read time plus budget). A read that fails, does not settle within the
 * default, or outlives the run answers 'timeout' (fail-close); BR-AI-18 then holds the text, reviews
 * it once more before the run ends and replaces it with agent.refuse.safety_timeout, cards kept.
 */
export interface RunSentenceReviewPort {
  forRun(appId: string, signal: AbortSignal): SentenceReviewPort;
}

/** One delivered product (the shape of results' DeliveredProduct, declared here so the core does
 * not import results, which imports the core's types). `card`: a one-product copy of its list. */
export interface DeliveredProductReceipt {
  readonly card_id: string;
  readonly product_key: string;
  readonly platform: Platform;
  readonly final_price_fen: number;
  readonly card: UnnumberedCard;
}

export interface AgentRunBodyDeps {
  readonly model: Pick<ModelRouter, 'complete'>;
  /** Fresh per run, shared by every complete call in that run. */
  readonly modelClock: () => RunModelClock;
  readonly tools: OrchestratorTools;
  readonly inputCheck: InputCheckPort;
  readonly degraded: DegradedPath;
  readonly deterministic?: DeterministicPath;
  readonly intents?: IntentPort;
  readonly review: SentenceReviewPort;
  readonly texts: AgentRunTexts;
  /** Same immutable source passed to createRunLabels. Read once per run, not per round. */
  readonly prompt: PromptSource;
  readonly limits: OrchestratorLimits;
  /** Given unchanged model args and this run's placeholder table, return storage-safe args.
   * The port owns masking semantics; core records its result unchanged and never records
   * the placeholder table or raw values. Must not mutate the args or table. */
  readonly traceMask: (args: unknown, placeholders: Readonly<Record<string, string>>) => unknown;
  readonly trace?: RunTraceSink;
  /** B3-03n: delivery receipts of product cards; absent, nothing is recorded (B3-05b runs). */
  readonly results?: DeliveryReceiptPort;
  /** B3-03p: the per-app output review (RunSentenceReviewPort); absent, every run's OutputGuard
   * uses `review` as before (B3-05b runs). */
  readonly outputReview?: RunSentenceReviewPort;
  /** B3-05o 不空回复 (intent-fallback.ts rule 3): told once per run the core filled with
   * agent.reply.empty (the stream entry: one log line and EmptyReplyCounter.record()). Absent, the
   * run is still filled; nothing is logged or counted. */
  readonly emptyReplies?: EmptyReplyPort;
  /** B3-05o 比较提示 (intent-fallback.ts rule 4): whether the session has product cards in
   * context (its current result set). Absent, or a failed read: no title-based notice. */
  readonly sessionProducts?: SessionProductsPort;
}

/** B3-05o: one call per run filled with agent.reply.empty. */
export interface EmptyReplyPort {
  filled(fields: {
    readonly appId: string;
    readonly runId: string;
    readonly finishReason: 'stop' | 'limit';
  }): void;
}

/** B3-05o: the session's product cards in context (BR-AI-18 细则「比较与适用性的提示」). */
export interface SessionProductsPort {
  inContext(appId: string, sessionId: string): Promise<boolean>;
}

export interface RunLabelsDeps {
  /** Same route provider wired to ModelRouter; label predicts the first entry only.
   * Failover's actual responding model belongs in OrchestratorTrace.model. */
  readonly route: (appId: string) => Promise<ResolvedRoute>;
  readonly prompt: PromptSource;
  readonly modelLabel: (appId: string, modelSnapshot: string | null) => Promise<string>;
  readonly aiLabel: (appId: string) => Promise<string>;
}
