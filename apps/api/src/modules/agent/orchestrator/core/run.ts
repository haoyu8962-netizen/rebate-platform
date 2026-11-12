// B3-05b: one Agent run (contract in factories.ts). Every piece of state lives in AgentRun, one
// instance per run: model clock, OutputGuard, counters, delivered flag and trace never leak
// between runs of the same factory.
// B3-08m · BR-AI-07 (contract: ./reply-templates.ts): when this run's offered tools include a
// template tool, the OutputGuard's emits of model text are held in the run (`held`) instead of
// being written; every end of the run settles them in one place (settleHeld / finishText): a run
// with a template call drops them and writes the template keys instead, any other run writes them
// in guard order before it ends exactly as before. Once a template call was made no later model
// text reaches the guard at all.
// B3-08p · FU-AGENT-RUN-CACHED-TEXT (D10-888 (b2), contract: ./reply-templates.ts): held text is
// also settled where the run is certain to end without another model round: before a tool's card
// or suggestions frame that ends the output at a cap (settleAtCap), and before a later round's
// provider refusal. Only the OutputGuard's emits are released (never raw deltas, no guard.end()).
// 请求即算: a round asking for an offered template tool counts it as called before any of the
// round's calls runs (countRequested), so a call the run never reaches still counts.
import { platform as platformEnum } from '@couli/contracts-ts';
import type { Platform } from '@couli/contracts-ts';
import type { RunBodyInput } from '../../http/index.ts';
import { createOutputGuard } from '../../guard/index.ts';
import type { GuardEmit, OutputGuard } from '../../guard/index.ts';
import type { DegradeReason } from '../../model-gateway/degraded/index.ts';
import type { AssembledToolCall, ChatMessage } from '../../model-gateway/openai-compat/index.ts';
import type { AttemptRecord } from '../../model-gateway/routing/index.ts';
import type { RunBodyResult, RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import { StreamProtocolError } from '../../stream/writer/index.ts';
import { openCardCall } from './card-references.ts';
import type { CardCall } from './card-references.ts';
import { RunOutput } from './output.ts';
import { ReplyTemplateCalls, isReplyTemplateTool } from './reply-templates.ts';
import type { CardWrite } from './output.ts';
import { openDegradedRoute } from './degraded-intent.ts';
import type { DegradedRoute } from './degraded-intent.ts';
import type {
  AgentRunBodyDeps,
  DeliveredProductReceipt,
  InputProceed,
  OrchestratorTrace,
  ToolContext,
  ToolOutcome,
  ToolTraceFragment,
} from './ports.ts';

const ABORTED: unique symbol = Symbol('aborted');
type Aborted = typeof ABORTED;

type Done = Extract<RunBodyResult, { kind: 'done' }>;
const done = (finishReason: Done['finishReason']): Done => ({ kind: 'done', finishReason });

const INVALID_ARGS = { error: 'invalid_args' } as const;
/** Degrade reason for a model answer in an invalid format (see ports.ts header). */
const INVALID_FORMAT_REASON: DegradeReason = 'models_failed';
const PLATFORMS: readonly string[] = platformEnum;
/** B3-05j: intent of the link branch (deterministic path or its empty fallback). */
const LINK_INTENT = 'find_by_link';
/** B3-05j default: a degraded run without a model intent is a keyword search (BR-AI-14); B3-05n:
 * unless the degraded path registered the intent it routed the message to (./degraded-intent.ts). */
const DEGRADED_INTENT = 'search';
/** The tool the deterministic path reports, one start → end / failed pair per url link. */
const QUOTE_TOOL = 'get_rebate_quote';

type ToolStatus = OrchestratorTrace['tool_calls'][number]['status'];
type CardSource = NonNullable<ToolTraceFragment['card_sources']>[number];
type LinkRegistration = NonNullable<ToolTraceFragment['link_registrations']>[number];

/** The platform argument as a validated enum value; anything else uses the generic template. */
function platformOf(args: unknown): Platform | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)['platform'];
  return typeof value === 'string' && PLATFORMS.includes(value) ? (value as Platform) : undefined;
}

function parseArgs(raw: string): { readonly ok: boolean; readonly args: unknown } {
  if (raw.trim() === '') return { ok: true, args: {} };
  try {
    return { ok: true, args: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, args: raw };
  }
}

/**
 * A final-round reply shaped as an intent object ({"agent_intent": …}, optionally fenced).
 * Returns the declared intent name (null when not a string), or undefined for ordinary text.
 * Unparseable text that still opens an object naming agent_intent counts as an intent: it is
 * never delivered as explanation.
 */
export function intentOf(text: string): { readonly name: string | null } | undefined {
  let body = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(body);
  if (fence !== null) body = (fence[1] ?? '').trim();
  if (!body.startsWith('{')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return body.includes('"agent_intent"') ? { name: null } : undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  if (!Object.hasOwn(value, 'agent_intent')) return undefined;
  const name = (value as Record<string, unknown>)['agent_intent'];
  return { name: typeof name === 'string' ? name : null };
}

const CARD_ID = /^c([1-9][0-9]*)$/u;

/** The guard's replacement for a blocked sentence: the run ends with safety. */
function isBlocked(emit: GuardEmit): boolean {
  return emit.kind === 'fixed' && emit.key === 'agent.refuse.output_blocked';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * B3-03n · BR-AI-05: the receipts of a written product_list whose frame took `frameCardId`. The
 * embedded products are numbered right after their container, in item order (04 §8.2, the
 * RunManager's numberCard), so item i took c<frame + 1 + i>. Each receipt keeps a one-product copy
 * of the list (no card_id: a later re-delivery is numbered afresh). An item without a product key,
 * a known platform or an integer final price is skipped (nothing to resolve it to).
 */
function deliveredProductsOf(
  card: UnnumberedCard,
  frameCardId: string,
): { readonly resultSetId: string; readonly items: readonly DeliveredProductReceipt[] } | null {
  if (card.type !== 'product_list' || !isRecord(card.data)) return null;
  const resultSetId = card.data['result_set_id'];
  const items = card.data['items'];
  const frame = CARD_ID.exec(frameCardId);
  if (typeof resultSetId !== 'string' || resultSetId === '' || !Array.isArray(items)) return null;
  if (frame === null) return null;
  const first = Number(frame[1]);
  const out: DeliveredProductReceipt[] = [];
  items.forEach((item: unknown, index) => {
    if (!isRecord(item)) return;
    const productKey = item['product_key'];
    const platform = item['platform'];
    const finalPrice = item['final_price_fen'];
    const no = first + 1 + index;
    if (typeof productKey !== 'string' || productKey === '') return;
    if (typeof platform !== 'string' || !PLATFORMS.includes(platform)) return;
    if (typeof finalPrice !== 'number' || !Number.isSafeInteger(finalPrice)) return;
    if (!Number.isSafeInteger(no)) return;
    const product = Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'card_id'));
    out.push({
      card_id: `c${String(no)}`,
      product_key: productKey,
      platform: platform as Platform,
      final_price_fen: finalPrice,
      card: { ...card, data: { ...card.data, items: [product] } },
    });
  });
  return out.length === 0 ? null : { resultSetId, items: out };
}

/**
 * B3-03p · BR-AI-05: the receipt of a written rebate_quote card's embedded product (04 §8.2: it
 * takes the card_id right after its frame), with a copy of the card whose product carries no
 * card_id. null without a product key, a known platform or an integer final price.
 */
function quotedProductOf(
  card: UnnumberedCard,
  frameCardId: string,
): DeliveredProductReceipt | null {
  if (!isRecord(card.data)) return null;
  const product = card.data['product'];
  const frame = CARD_ID.exec(frameCardId);
  if (!isRecord(product) || frame === null) return null;
  const productKey = product['product_key'];
  const platform = product['platform'];
  const finalPrice = product['final_price_fen'];
  const no = Number(frame[1]) + 1;
  if (typeof productKey !== 'string' || productKey === '') return null;
  if (typeof platform !== 'string' || !PLATFORMS.includes(platform)) return null;
  if (typeof finalPrice !== 'number' || !Number.isSafeInteger(finalPrice)) return null;
  if (!Number.isSafeInteger(no)) return null;
  const copy = Object.fromEntries(Object.entries(product).filter(([key]) => key !== 'card_id'));
  return {
    card_id: `c${String(no)}`,
    product_key: productKey,
    platform: platform as Platform,
    final_price_fen: finalPrice,
    card: { ...card, data: { ...card.data, product: copy } },
  };
}

/** Whole text without surrounding white space and one ``` fence (closed or not). */
function unfenced(text: string): string {
  const body = text.trim();
  const fence = /^```[\w-]*[^\S\r\n]*\r?\n?([\s\S]*?)\s*(?:```)?$/u.exec(body);
  return fence === null ? body : (fence[1] ?? '').trim();
}

const ARRAY_LIKE = /^\[\s*(?:[{["\d\]-]|true\b|false\b|null\b)/u;
const OBJECT_MEMBER = /\{\s*"(?:[^"\\]|\\[\s\S])*"\s*:/u;

function hasStructuredStart(body: string): boolean {
  if (body.startsWith('{')) return true;
  if (!body.startsWith('[')) return false;
  try {
    JSON.parse(body);
    return true;
  } catch {
    return ARRAY_LIKE.test(body);
  }
}

/**
 * BR-AI-06: inspect the whole round before any delta is delivered, including JSON objects
 * embedded in prose or code fences. Keep rejecting malformed structured starts; ordinary
 * inline braces and bracketed tags without a JSON member remain explanation text.
 */
export function isStructuredText(text: string): boolean {
  if (OBJECT_MEMBER.test(text) || hasStructuredStart(unfenced(text))) return true;
  // Fences may follow prose and contain arrays without object members, or incomplete JSON.
  for (const fence of text.matchAll(/```[\w-]*[^\S\r\n]*\r?\n?([\s\S]*?)(?:```|$)/gu)) {
    if (hasStructuredStart((fence[1] ?? '').trim())) return true;
  }
  return false;
}

class AgentRun {
  private readonly deps: AgentRunBodyDeps;
  private readonly input: RunBodyInput;
  private readonly signal: AbortSignal;
  private readonly appId: string;
  private readonly out: RunOutput;
  private readonly abortGate: Promise<Aborted>;
  private readonly onAbort: () => void;
  /** Model or tool text / card / suggestions written (input notices excluded, plan U-11). */
  private delivered = false;
  private guard: OutputGuard | null = null;
  private placeholders: Readonly<Record<string, string>> = {};
  private intent: string | null = null;
  private formatInvalid = false;
  private model: string | null = null;
  private promptVersion = 'none';
  private readonly attempts: AttemptRecord[] = [];
  private readonly toolTrace: OrchestratorTrace['tool_calls'][number][] = [];
  private readonly cardSources: CardSource[] = [];
  private readonly linkRegistrations: LinkRegistration[] = [];
  /** Set once the trace is recorded: later path output never changes it. */
  private traced = false;
  /** B3-05n: the degraded run call's intent slot, read when the trace is recorded. */
  private routed: DegradedRoute | null = null;
  /** B3-08m: this run offers a template tool, so model text is held until the run's end. */
  private holding = false;
  /** Guard emits of model text not written yet (holding runs only), in guard order. */
  private held: GuardEmit[] = [];
  /** This run's template calls (BR-AI-07); never shared with another run. */
  private readonly templateCalls = new ReplyTemplateCalls();
  /** Template text replaced the model's reply (trace text_replaced_by_template). */
  private replaced = false;
  /** B3-08p: the template texts were written (once per run). */
  private templatesWritten = false;
  /** B3-08p: held text or templates were settled before a capping write; the run ends there. */
  private capSettled = false;

  constructor(deps: AgentRunBodyDeps, input: RunBodyInput, ctx: RunContext) {
    this.deps = deps;
    this.input = input;
    this.signal = ctx.signal;
    this.appId = input.caller.appId;
    this.out = new RunOutput(ctx, deps.limits);
    let resolveAbort: (value: Aborted) => void = () => undefined;
    this.abortGate = new Promise<Aborted>((resolve) => {
      resolveAbort = resolve;
    });
    this.onAbort = () => resolveAbort(ABORTED);
    if (this.signal.aborted) this.onAbort();
    else this.signal.addEventListener('abort', this.onAbort, { once: true });
  }

  async run(): Promise<RunBodyResult> {
    if (this.signal.aborted) {
      this.release();
      return done('stop');
    }
    try {
      return await this.main();
    } finally {
      this.release();
      this.recordTrace();
    }
  }

  private release(): void {
    this.signal.removeEventListener('abort', this.onAbort);
  }

  /** Awaits a port, giving up at once on abort; a late result or rejection is discarded. */
  private async wait<T>(pending: Promise<T>): Promise<T | Aborted> {
    let value: T | Aborted;
    try {
      value = await Promise.race([pending, this.abortGate]);
    } catch (error) {
      if (this.signal.aborted) return ABORTED;
      throw error;
    }
    return this.signal.aborted ? ABORTED : value;
  }

  /** Result of a path or of the core: cancellation, then a reached output cap, win. */
  private final(result: RunBodyResult): RunBodyResult {
    if (this.signal.aborted) return done('stop');
    if (this.out.limitHit) return done('limit');
    return result;
  }

  private async main(): Promise<RunBodyResult> {
    const checked = await this.wait(this.deps.inputCheck.check(this.input, this.signal));
    if (checked === ABORTED) return done('stop');
    if (checked.kind === 'refuse') {
      if (!(await this.fixed(checked.textKey))) return done('stop');
      return this.final({
        kind: 'done',
        finishReason: checked.finishReason,
        ...(checked.ending === undefined ? {} : { ending: checked.ending }),
      });
    }
    this.placeholders = checked.placeholders;
    // Notices: once, by the core, before any path output; never "delivered content" (U-11).
    for (const notice of checked.notices) {
      if ((await this.card(notice)) === ABORTED) return done('stop');
      if (this.out.limitHit) return done('limit');
    }
    if (checked.links.length > 0) return this.linkPath(checked);
    return this.modelPath(checked);
  }

  /** Fixed server text by key; false when cancelled. */
  private async fixed(key: string): Promise<boolean> {
    const text = await this.wait(this.deps.texts.text(this.appId, key));
    if (text === ABORTED) return false;
    return this.out.text(text);
  }

  /** Writes a core card; an invalid card is dropped and the run goes on (B3-03b). */
  private async card(card: UnnumberedCard): Promise<boolean | Aborted> {
    const written = await this.deliver(card);
    return written === ABORTED ? ABORTED : written.written;
  }

  /** card(), with the delivered frame's card_id for reference resolution (B3-05i). */
  private async deliver(card: UnnumberedCard): Promise<CardWrite | Aborted> {
    try {
      return await this.wait(this.out.deliver(card));
    } catch (error) {
      if (error instanceof StreamProtocolError && error.code === 'invalid_frame') {
        return { written: false, cardId: null };
      }
      throw error;
    }
  }

  private async linkPath(proceed: InputProceed): Promise<RunBodyResult> {
    this.intent = LINK_INTENT;
    const deterministic = this.deps.deterministic;
    if (deterministic !== undefined) {
      const result = await this.wait(
        deterministic.run({ input: this.input, proceed }, this.quoteObserver(proceed)),
      );
      return result === ABORTED ? done('stop') : this.final(result);
    }
    const key = 'agent.degraded.empty';
    const fallback = await this.wait(this.deps.texts.text(this.appId, key));
    if (fallback === ABORTED) return done('stop');
    const notice: UnnumberedCard = {
      type: 'notice',
      schema_version: 1,
      data: { level: 'info', text_key: key, actions: [] },
      fallback_text: fallback,
    };
    if ((await this.card(notice)) === ABORTED) return done('stop');
    return this.final(done('fallback'));
  }

  /**
   * B3-05j: the guarded context for the deterministic path, observing its tool.status pairs.
   * The n-th get_rebate_quote start belongs to the n-th link of proceed.links (B3-04g: urls and
   * tokens alike are quoted in order, one start each); its end / failed records one call with
   * args { link_index } (that 1-based position, never the raw link), masked like a model call. A start without its end (cancellation) is not
   * recorded; nothing is recorded after the trace was written. Not counted in limits.toolCalls.
   */
  private quoteObserver(proceed: InputProceed): RunContext {
    const ctx = this.pathContext();
    const linkCount = proceed.links.length;
    let started = 0;
    let open: number | null = null;
    const observe = (tool: string, phase: 'start' | 'end' | 'failed'): void => {
      if (tool !== QUOTE_TOOL || this.traced || this.signal.aborted) return;
      if (phase === 'start') {
        started += 1;
        open = started <= linkCount ? started : null;
        return;
      }
      if (open === null) return;
      const linkIndex = open;
      open = null;
      this.traceCall(QUOTE_TOOL, { link_index: linkIndex }, phase === 'end' ? 'ok' : 'failed');
    };
    return {
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      signal: ctx.signal,
      get cardsDelivered() {
        return ctx.cardsDelivered;
      },
      text: (delta) => ctx.text(delta),
      toolStatus: (tool, phase, display) => {
        observe(tool, phase);
        ctx.toolStatus(tool, phase, display);
      },
      card: (card, delivered) => ctx.card(card, delivered),
      suggestions: (items) => ctx.suggestions(items),
    };
  }

  /**
   * B3-03p · BR-AI-05: the guarded context handed to the degraded path, the deterministic path
   * and the intent port. Same caps and signal as RunOutput.context(); a card the run context
   * confirmed as written (a receipt card_id) has its products recorded like a model tool call's
   * (receipt()) before the path's next write. The path's own `delivered` callback, when given,
   * gets the frame's card_id too.
   */
  private pathContext(): RunContext {
    const ctx = this.out.context();
    return {
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      signal: ctx.signal,
      get cardsDelivered() {
        return ctx.cardsDelivered;
      },
      text: (delta) => ctx.text(delta),
      toolStatus: (tool, phase, display) => ctx.toolStatus(tool, phase, display),
      card: async (card, delivered) => {
        const written = await this.out.deliver(card);
        if (written.cardId === null) return;
        delivered?.(written.cardId);
        await this.receipt(card, written.cardId);
      },
      suggestions: (items) => ctx.suggestions(items),
    };
  }

  private async degrade(proceed: InputProceed, reason: DegradeReason): Promise<RunBodyResult> {
    // An intent the model already gave is kept; otherwise the intent the no-model path registers
    // on the context of this run call (B3-05n · BR-AI-14 细则「无模型降级」 ①–⑥, so the next run's
    // 承接 reads it), read when the trace is recorded (also after a stop), else the keyword
    // search's. Nothing changes it once the trace is recorded (recordTrace closes the slot).
    const modelIntent = this.intent !== null;
    if (!modelIntent) this.intent = DEGRADED_INTENT;
    const ctx = this.pathContext();
    this.routed = openDegradedRoute(ctx, modelIntent);
    const request = { reason, input: this.input, proceed };
    const result = await this.wait(this.deps.degraded.run(request, ctx));
    return result === ABORTED ? done('stop') : this.final(result);
  }

  private async modelPath(proceed: InputProceed): Promise<RunBodyResult> {
    const prompt = await this.wait(this.deps.prompt.current(this.appId));
    if (prompt === ABORTED) return done('stop');
    if (prompt === null) return this.degrade(proceed, 'route_no_model');
    this.promptVersion = prompt.version;
    const tools = await this.wait(this.deps.tools.definitions(this.appId, this.input.caller));
    if (tools === ABORTED) return done('stop');
    const known = new Set(tools.map((tool) => tool.name));
    // B3-08m: a template tool on offer may be called in any later round (reply-templates.ts).
    this.holding = tools.some((tool) => isReplyTemplateTool(tool.name));
    const clock = this.deps.modelClock();
    // B3-03p · BR-AI-18: this run's app's sentence review (its own budget), when wired.
    const review = this.deps.outputReview?.forRun(this.appId, this.signal) ?? this.deps.review;
    this.guard = createOutputGuard({ review });
    const messages: ChatMessage[] = [{ role: 'user', content: proceed.modelText }];
    let toolCalls = 0;
    for (let round = 1; ; round += 1) {
      const outcome = await this.wait(
        this.deps.model.complete(
          { system: prompt.system, tools, messages: [...messages] },
          { clock, signal: this.signal },
        ),
      );
      if (outcome === ABORTED) return done('stop');
      this.attempts.push(...outcome.attempts);
      if (outcome.kind === 'aborted') return done('stop');
      if (outcome.kind === 'refused') {
        // B3-08p: held text goes out before the refusal (dropped in a template run).
        const settled = await this.settleHeld();
        if (settled !== null) return settled;
        if (!(await this.fixed('agent.refuse.unsafe')) && this.signal.aborted) return done('stop');
        return done('safety');
      }
      if (outcome.kind === 'degraded') {
        // B3-08m: held model text is settled first (written, or dropped for a template run).
        const settled = await this.settleHeld();
        if (settled !== null) return settled;
        // U-11: degrade only before any model / tool content; otherwise end with what was sent.
        // B3-08m (gate review S1-1): a template run never degrades; it ends with its templates.
        if (!this.templated && !this.delivered) return this.degrade(proceed, outcome.reason);
        return this.finishText('stop');
      }
      this.model = outcome.model;
      const deltas: string[] = [];
      const calls: AssembledToolCall[] = [];
      for (const event of outcome.events) {
        if (event.t === 'text_delta') deltas.push(event.text);
        else if (event.t === 'tool_call') calls.push(event.call);
      }
      const roundText = deltas.join('');
      if (calls.length === 0) return this.finalRound(proceed, deltas, roundText);
      // B3-08m: after a template call no model text is delivered; it never reaches the guard.
      const templatedBefore = this.templated;
      // B3-08p 请求即算 (gate review r1 S1): counted before anything of this round can be settled
      // or released (format check, guard stop, U-10, tool call budget, card cap); from here on
      // held text of this and earlier rounds is never delivered (flushHeld writes no model text).
      this.countRequested(calls, known);
      // Same format check as the final round, before any of this text reaches the guard.
      if (isStructuredText(roundText)) return this.invalidFormat(proceed);
      // The round asking for its first template tool still passes the guard (review, trace,
      // safety ending, as in B3-08m); its text is held and never delivered.
      if (!templatedBefore) {
        const pushed = await this.pushText(deltas);
        if (pushed !== null) return pushed;
      }
      // The last allowed round still asks for tools: its calls are not run (U-10).
      if (round >= this.deps.limits.modelRounds) return this.finishText('limit');
      messages.push({ role: 'assistant', content: roundText || null, tool_calls: calls });
      for (const call of calls) {
        if (toolCalls >= this.deps.limits.toolCalls) return this.finishText('limit');
        toolCalls += 1;
        const step = await this.runTool(call, known);
        if (!('view' in step)) return step;
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(step.view) });
      }
    }
  }

  private async finalRound(
    proceed: InputProceed,
    deltas: readonly string[],
    text: string,
  ): Promise<RunBodyResult> {
    const blank = text.trim() === '';
    const intent = blank ? undefined : intentOf(text);
    if (intent !== undefined) this.intent = intent.name;
    if (this.templated) {
      // B3-08m · BR-AI-07: ordinary, blank, intent or structured text alike: only the templates;
      // the IntentPort is not consulted.
      if (intent === undefined && !blank && isStructuredText(text)) this.formatInvalid = true;
      return this.finishText('stop');
    }
    // Earlier rounds' held text goes out first, as it did when it was written at once.
    const settled = await this.settleHeld();
    if (settled !== null) return settled;
    const intents = this.deps.intents;
    if (intents !== undefined && !blank) {
      const handled = await this.wait(
        intents.handle({ text, input: this.input, proceed }, this.pathContext()),
      );
      if (handled === ABORTED) return done('stop');
      if (handled !== null) return this.final(handled);
    } else if (intent !== undefined) {
      // U-7: without an IntentPort every intent output is out_of_scope; model text is dropped.
      if (!(await this.fixed('agent.refuse.out_of_scope')) && this.signal.aborted) {
        return done('stop');
      }
      return this.final(done('stop'));
    }
    if (isStructuredText(text)) return this.invalidFormat(proceed);
    const pushed = await this.pushText(deltas);
    if (pushed !== null) return pushed;
    return this.finishText('stop');
  }

  /**
   * Model text that is structured data (card JSON etc.) is dropped as an invalid answer: before
   * any model / tool content it degrades like "no usable model answer" (models_failed); after
   * delivery it flushes the guard tail and ends normally (U-11). Trace records the deviation.
   */
  private async invalidFormat(proceed: InputProceed): Promise<RunBodyResult> {
    this.formatInvalid = true;
    const settled = await this.settleHeld();
    if (settled !== null) return settled;
    // B3-08m (gate review S1-1): a template run never degrades; it ends with its templates.
    if (!this.templated && !this.delivered) return this.degrade(proceed, INVALID_FORMAT_REASON);
    return this.finishText('stop');
  }

  /**
   * B3-08p 请求即算: every offered template tool this round asks for counts as called now, at any
   * position, whether or not the run gets to execute it; held text is never delivered after it.
   */
  private countRequested(calls: readonly AssembledToolCall[], known: ReadonlySet<string>): void {
    for (const call of calls) {
      const name = call.function.name;
      if (known.has(name) && isReplyTemplateTool(name)) {
        this.templateCalls.called(name);
        this.held = [];
      }
    }
  }

  /**
   * B3-08p: right before a write that ends the output at a cap (the run ends with limit, no model
   * round follows): a template run writes its templates, any other holding run its held guard
   * emits. A result means the run ends here. Sets capSettled when something was settled.
   */
  private async settleAtCap(): Promise<RunBodyResult | null> {
    if (!this.holding) return null;
    if (this.templated) {
      this.capSettled = true;
      return this.writeTemplateTexts();
    }
    if (this.held.length === 0) return null;
    this.capSettled = true;
    return this.flushHeld();
  }

  /** B3-08m: a template call was made in this run (reply-templates.ts). */
  private get templated(): boolean {
    return this.templateCalls.any;
  }

  /** Model text through the OutputGuard; a result means the run ends here. */
  private async pushText(deltas: readonly string[]): Promise<RunBodyResult | null> {
    const guard = this.guard;
    if (guard === null) return null;
    for (const delta of deltas) {
      const emits = await this.wait(guard.push(delta));
      if (emits === ABORTED) return done('stop');
      if (this.holding) {
        // B3-08m: held until the run knows whether it calls a template tool.
        this.held.push(...emits);
        // A guard that stopped ends the run here, as before: the held text goes out with it.
        if (guard.stopped || emits.some(isBlocked))
          return (await this.flushHeld()) ?? done('safety');
        continue;
      }
      const stop = await this.writeEmits(emits, guard);
      if (stop !== null) return stop;
    }
    return null;
  }

  /** Writes the held emits in guard order; a result means the run ends here. */
  private async flushHeld(): Promise<RunBodyResult | null> {
    const guard = this.guard;
    // B3-08p (gate review r1 S1): in a template run only the guard's fixed safety texts go out
    // (e.g. agent.refuse.output_blocked when the guard stops); model text never does.
    const emits = this.templated ? this.held.filter((emit) => emit.kind === 'fixed') : this.held;
    this.held = [];
    if (guard === null || emits.length === 0) return null;
    return this.writeEmits(emits, guard);
  }

  /** Held model text at an end of the run: dropped in a template run, else written. */
  private async settleHeld(): Promise<RunBodyResult | null> {
    if (this.templated) {
      this.held = [];
      return null;
    }
    return this.flushHeld();
  }

  /**
   * B3-08m · BR-AI-07: the template texts in place of all model text (no guard flush), through
   * the run's caps; then the end the run has (`reason`, or limit / stop as final() decides).
   */
  private async writeTemplates(reason: Done['finishReason']): Promise<RunBodyResult> {
    const stop = await this.writeTemplateTexts();
    if (stop !== null) return stop;
    return this.final(done(reason));
  }

  /** The template texts, once per run (B3-08p: possibly before a capping card); stop on abort. */
  private async writeTemplateTexts(): Promise<RunBodyResult | null> {
    this.held = [];
    this.replaced = true;
    if (this.templatesWritten) return null;
    this.templatesWritten = true;
    for (const template of this.templateCalls.texts()) {
      if (this.out.limitHit) break;
      const text = await this.wait(this.deps.texts.text(this.appId, template.key));
      if (text === ABORTED) return done('stop');
      const filled =
        template.count === undefined ? text : text.replaceAll('{n}', String(template.count));
      if (this.out.text(filled)) this.delivered = true;
    }
    return null;
  }

  /** Flushes the guard (end of run) and ends with `reason` unless the flush decides otherwise. */
  private async finishText(reason: Done['finishReason']): Promise<RunBodyResult> {
    if (this.templated) return this.writeTemplates(reason);
    const settled = await this.flushHeld();
    if (settled !== null) return settled;
    const guard = this.guard;
    if (guard !== null && !this.out.limitHit) {
      const emits = await this.wait(guard.end());
      if (emits === ABORTED) return done('stop');
      const stop = await this.writeEmits(emits, guard);
      if (stop !== null) return stop;
    }
    return this.final(done(reason));
  }

  /** One ctx.text per GuardEmit, in guard order. */
  private async writeEmits(
    emits: readonly GuardEmit[],
    guard: OutputGuard,
  ): Promise<RunBodyResult | null> {
    for (const emit of emits) {
      let text: string;
      if (emit.kind === 'text') {
        text = emit.text;
      } else {
        const fixed = await this.wait(this.deps.texts.text(this.appId, emit.key));
        if (fixed === ABORTED) return done('stop');
        text = fixed;
      }
      if (this.out.text(text)) this.delivered = true;
      if (emit.kind === 'fixed' && emit.key === 'agent.refuse.output_blocked') {
        return done('safety');
      }
      if (this.out.limitHit) return done('limit');
    }
    if (this.signal.aborted) return done('stop');
    return guard.stopped ? done('safety') : null;
  }

  private traceCall(name: string, args: unknown, status: ToolStatus): void {
    let masked: unknown;
    try {
      masked = this.deps.traceMask(args, this.placeholders);
    } catch {
      // Never fall back to the unmasked arguments.
      masked = null;
    }
    this.toolTrace.push({ name, args: masked, status });
  }

  private async runTool(
    call: AssembledToolCall,
    known: ReadonlySet<string>,
  ): Promise<{ readonly view: unknown } | RunBodyResult> {
    const name = call.function.name;
    const parsed = parseArgs(call.function.arguments);
    if (!known.has(name)) {
      // Unregistered name: no execute, template or tool.status; the call still counts.
      this.traceCall(name, parsed.args, 'rejected');
      return { view: INVALID_ARGS };
    }
    // B3-08m · BR-AI-07: an offered template tool's call counts whatever its outcome; from here
    // on held and later model text is never delivered.
    const template = isReplyTemplateTool(name) ? name : null;
    if (template !== null) {
      this.templateCalls.called(template);
      this.held = [];
    }
    const platform = platformOf(parsed.args);
    const texts = this.deps.texts;
    const start = await this.wait(texts.toolDisplay(this.appId, name, 'start', platform));
    if (start === ABORTED) return done('stop');
    this.out.status(name, 'start', start);
    // B3-05i: each call gets its own copy of the run's placeholders table; that object's identity
    // binds cardReference to this call (card-references.ts header). Same entries, frozen.
    const placeholders = Object.freeze({ ...this.placeholders });
    const refs = openCardCall(call.id, placeholders);
    try {
      let outcome: ToolOutcome;
      if (parsed.ok) {
        const executed = await this.wait(
          this.deps.tools.execute(
            { id: call.id, name, args: parsed.args },
            this.toolContext(placeholders),
          ),
        );
        if (executed === ABORTED) return done('stop');
        outcome = executed;
      } else {
        outcome = { kind: 'rejected', modelView: INVALID_ARGS };
      }
      // References are issued while execute runs; none can be added once the outcome is in.
      refs.close();
      const phase = outcome.kind === 'ok' ? 'end' : 'failed';
      const display = await this.wait(texts.toolDisplay(this.appId, name, phase, platform));
      if (display === ABORTED) return done('stop');
      this.out.status(name, phase, display);
      this.traceCall(name, parsed.args, outcome.kind);
      if (template !== null && outcome.kind === 'ok') {
        this.templateCalls.succeeded(template, outcome.trace);
      }
      if (outcome.kind === 'ok') {
        const stop = await this.toolOutput(outcome, refs);
        if (stop !== null) return stop;
      }
      // Only this resolved copy reaches the model (unchanged when no reference was issued).
      return { view: refs.view(outcome.modelView) };
    } finally {
      refs.close();
    }
  }

  /**
   * Cards and suggestions of a successful call, in order; a result means the run ends here.
   * Each card's delivered frame card_id is recorded for this call's references (B3-05i).
   */
  private async toolOutput(
    outcome: Extract<ToolOutcome, { readonly kind: 'ok' }>,
    refs: CardCall,
  ): Promise<RunBodyResult | null> {
    try {
      for (const card of outcome.cards) {
        if (this.out.closesWith(card)) {
          const settled = await this.settleAtCap();
          if (settled !== null) return settled;
        }
        const written = await this.deliver(card);
        if (written === ABORTED) return done('stop');
        refs.delivered(written.cardId);
        if (written.written) this.delivered = true;
        if (written.cardId !== null && (await this.receipt(card, written.cardId)) === ABORTED) {
          return done('stop');
        }
        // B3-08p: settled for a cap, the run ends here even if the card was dropped as invalid.
        if (this.out.limitHit || this.capSettled) return done('limit');
      }
      const suggestions = outcome.suggestions ?? [];
      if (suggestions.length > 0) {
        if (this.out.closesWithSuggestions(suggestions)) {
          const settled = await this.settleAtCap();
          if (settled !== null) return settled;
        }
        if (this.out.suggestions(suggestions)) this.delivered = true;
        if (this.out.limitHit || this.capSettled) return done('limit');
      }
      return null;
    } finally {
      // On every exit (limit, cancellation, a thrown write), after delivery: the trace gets
      // delivered card ids, and records naming an undelivered card's reference are left out.
      this.cardSources.push(...refs.records(outcome.trace?.card_sources ?? [], ['card_id']));
      this.linkRegistrations.push(
        ...refs.records(outcome.trace?.link_registrations ?? [], ['link_id', 'product_key']),
      );
    }
  }

  /**
   * B3-03n · BR-AI-05: records the products of a product_list the run context confirmed as
   * written (a receipt card_id) in the result set it names, before the next card goes out. A
   * failed record never changes the run: the card is already out; the reference to it then
   * resolves as unknown (invalid_args), as before receipts existed.
   */
  private async receipt(card: UnnumberedCard, cardId: string): Promise<void | Aborted> {
    const port = this.deps.results;
    if (port === undefined) return undefined;
    let pending: Promise<void>;
    try {
      const quoted = card.type === 'rebate_quote' ? quotedProductOf(card, cardId) : null;
      if (quoted !== null) {
        // B3-03p: the quote card's product, outside every result set (ports.ts recordQuoted).
        if (port.recordQuoted === undefined) return undefined;
        const scope = {
          appId: this.appId,
          sessionId: this.input.sessionId,
          runId: this.input.runId,
        };
        pending = port.recordQuoted(scope, [quoted]);
      } else {
        const delivered = deliveredProductsOf(card, cardId);
        if (delivered === null) return undefined;
        pending = port.recordDelivered(delivered.resultSetId, delivered.items);
      }
    } catch {
      return undefined;
    }
    const recorded = await this.wait(pending.catch(() => undefined));
    return recorded === ABORTED ? ABORTED : undefined;
  }

  private toolContext(placeholders: Readonly<Record<string, string>>): ToolContext {
    const input = this.input;
    return {
      subject: input.caller,
      ...(input.context === undefined ? {} : { context: input.context }),
      runId: input.runId,
      sessionId: input.sessionId,
      signal: this.signal,
      placeholders,
    };
  }

  private recordTrace(): void {
    this.traced = true;
    const routed = this.routed?.close() ?? null;
    if (routed !== null) this.intent = routed;
    const sink = this.deps.trace;
    if (sink === undefined) return;
    const summary = this.guard?.summary();
    const trace: OrchestratorTrace = {
      intent: this.intent,
      model: this.model,
      attempts: [...this.attempts],
      prompt_version: this.promptVersion,
      tool_calls: [...this.toolTrace],
      output_filtered: summary?.outputFiltered ?? false,
      filter_hits: summary?.filterHits ?? [],
      output_truncated: summary?.outputTruncated ?? false,
      model_format_invalid: this.formatInvalid,
      ...(this.replaced ? { text_replaced_by_template: true } : {}),
      ...(this.cardSources.length > 0 ? { card_sources: [...this.cardSources] } : {}),
      ...(this.linkRegistrations.length > 0
        ? { link_registrations: [...this.linkRegistrations] }
        : {}),
    };
    try {
      sink.record(this.input.runId, trace);
    } catch {
      // Trace is best effort; it never changes the run's result.
    }
  }
}

export function runAgent(
  deps: AgentRunBodyDeps,
  input: RunBodyInput,
  ctx: RunContext,
): Promise<RunBodyResult> {
  return new AgentRun(deps, input, ctx).run();
}
