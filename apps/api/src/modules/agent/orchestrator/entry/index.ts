// B3-05q · BR-AI-01 细则「情境入口」(2026-11-12): the message that carries `context` (04 §6.5,
// exactly one of product_key / order_id / text) gets the entry's card from the server, after the
// input check (判定顺序第 1 步) and only when the message itself carries no link or token (the
// core decides both; orchestrator/core/run.ts). This file is the entry path the core calls:
//   · context.product_key (商品详情「问问 AI」): format check (BR-PROD-02), then the same quote as a
//     link message — a fresh catalog lookup and the link path's card entry (tools/quote, via
//     ScenarioEntryReaders.quote) — and 1 rebate_quote card; a delisted product, no price, no card
//     or an unrecognised key are the upstream's answer about the product and get the link path's
//     notice (error.<code>, 50301 for price_unavailable / no_card). A server-side failure (upstream
//     timeout, 5xx, circuit open) writes nothing here: the core ends the run with error 50401
//     without a model, or writes agent.notice.quote_failed with one (BR-AI-15 细则).
//   · context.order_id (订单详情「问问 AI」): order_query whatever the words say — 判定顺序③ identity
//     first (guest auth_required(login) + agent.need_login, not phone-bound bind_phone +
//     agent.need_phone), ④ the order tool it needs (explain_order) not offered → the OrderList
//     guide card after every check of 「页面引导」 (input source, agent.page_guide.enabled,
//     configuration ∩ contract), else agent.guide.unavailable; a phone-bound owner: this one order
//     out of 名下订单 (ScenarioEntryReaders.order), 1 order_status card and the T5 template; not in
//     名下 reads exactly like 0 orders (handoff card + order_list.empty). Nothing about the order's
//     platform reaches any other tool; the run ends there (no model).
//   · context.text (clipboard) is never read: the HTTP layer and the core drop it before anything
//     sees the run input (http/context.ts withoutClipboard); which entry a context names is
//     core/scenario-entry.ts scenarioEntryOf (a malformed value names none).
// The model never sees a context value. Platforms for later searches come only from the words of
// this message (the intent port and the no-model path read the message, never the entry).
import type { CatalogConfigReader } from '../../../catalog/index.ts';
import type { RunBodyResult, RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import type { LinkQuoteOutcome } from '../../tools/quote/index.ts';
import type { ToolCallContext } from '../../tools/registry/index.ts';
import type {
  AgentRunTexts,
  EntryCallReport,
  EntryQuoteResult,
  OrchestratorTools,
  PathInput,
  ScenarioEntryPath,
  ToolOutcome,
} from '../core/ports.ts';
import { ReplyTemplateCalls } from '../core/reply-templates.ts';
import type { IntentDeps } from '../intents/index.ts';

type Done = Extract<RunBodyResult, { kind: 'done' }>;

/** A quote of the entry product; server_failed = upstream timeout, 5xx or circuit (no card). */
export type EntryQuoteOutcome = LinkQuoteOutcome | { readonly kind: 'server_failed' };

/** The data side of the entry path (stream/mount/entry.ts over tools/quote and tools/orders). */
export interface ScenarioEntryReaders {
  /** Fresh catalog lookup + the link path's quote card for this product (no card reference). */
  quote(productKey: string, ctx: ToolCallContext): Promise<EntryQuoteOutcome>;
  /** This one order out of the caller's 名下订单 (explain_order's own lookup); 0 orders: the
   * handoff card, as list_my_orders without orders. */
  order(orderId: string, ctx: ToolCallContext): Promise<ToolOutcome>;
}

export interface ScenarioEntryPathDeps {
  readonly readers: ScenarioEntryReaders;
  /** The tools this run is offered (registered, switched on, audience allows the caller). */
  readonly tools: Pick<OrchestratorTools, 'definitions'>;
  readonly texts: AgentRunTexts;
  readonly config: CatalogConfigReader;
  readonly routes: IntentDeps['routes'];
  errorMsg(appId: string, code: number): Promise<string>;
}

const QUOTE_TOOL = 'get_rebate_quote';
const ORDER_TOOL = 'explain_order';
const QUOTE_FAILED = 'agent.notice.quote_failed';
const SERVER_FAILURE = 50401;
/** Same code as the link path for price_unavailable / no_card (dependency unavailable). */
const UNAVAILABLE = 50301;
const PAGE_GUIDE_ENABLED = 'agent.page_guide.enabled';
const GUIDE_UNAVAILABLE = 'agent.guide.unavailable';
const ORDER_LIST = 'OrderList';

function done(finishReason: Done['finishReason']): Done {
  return { kind: 'done', finishReason };
}

/** Identity only from the authenticated caller; never from the words or the context. */
function toolCallContext(request: PathInput, ctx: RunContext): ToolCallContext {
  const input = request.input;
  return {
    appId: input.caller.appId,
    userId: input.caller.userId,
    deviceId: input.caller.deviceId,
    phoneBound: input.caller.phoneBound,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    signal: ctx.signal,
    placeholders: request.proceed.placeholders,
    ...(input.context === undefined ? {} : { context: input.context }),
  };
}

async function configValue(
  config: CatalogConfigReader,
  appId: string,
  key: string,
): Promise<unknown> {
  try {
    return (await config.configValue(appId, key))?.value;
  } catch {
    return undefined;
  }
}

class EntryPath implements ScenarioEntryPath {
  private readonly deps: ScenarioEntryPathDeps;

  constructor(deps: ScenarioEntryPathDeps) {
    this.deps = deps;
  }

  // ---- shared --------------------------------------------------------------------------------

  private async status(
    appId: string,
    tool: string,
    phase: 'start' | 'end' | 'failed',
    ctx: RunContext,
  ): Promise<boolean> {
    const display = await this.deps.texts.toolDisplay(appId, tool, phase);
    if (ctx.signal.aborted) return false;
    ctx.toolStatus(tool, phase, display);
    return true;
  }

  private async notice(
    appId: string,
    key: string,
    level: 'info' | 'warn',
  ): Promise<UnnumberedCard> {
    return {
      type: 'notice',
      schema_version: 1,
      data: { level, text_key: key, actions: [] },
      fallback_text: await this.deps.texts.text(appId, key),
    };
  }

  // ---- context.product_key -------------------------------------------------------------------

  async product(
    request: PathInput,
    productKey: string,
    ctx: RunContext,
    report: EntryCallReport,
  ): Promise<EntryQuoteResult> {
    const appId = request.input.caller.appId;
    const args = { entry: 'product_key' };
    if (!(await this.status(appId, QUOTE_TOOL, 'start', ctx))) return { kind: 'stopped' };
    let outcome: EntryQuoteOutcome;
    try {
      outcome = await this.deps.readers.quote(productKey, toolCallContext(request, ctx));
    } catch {
      // A reader that throws is a server-side failure; its message never reaches a frame.
      outcome = { kind: 'server_failed' };
    }
    if (ctx.signal.aborted) return { kind: 'stopped' };
    if (outcome.kind !== 'ok') {
      if (!(await this.status(appId, QUOTE_TOOL, 'failed', ctx))) return { kind: 'stopped' };
      report(QUOTE_TOOL, args, 'failed');
      if (outcome.kind === 'server_failed') return { kind: 'server_failed' };
      // The upstream's answer about the product: the link path's notice (BR-AI-04).
      const code = outcome.kind === 'parse_error' ? outcome.error_code : UNAVAILABLE;
      const card = await this.notice(appId, `error.${String(code)}`, 'warn');
      if (ctx.signal.aborted) return { kind: 'stopped' };
      await ctx.card(card);
      return ctx.signal.aborted ? { kind: 'stopped' } : { kind: 'answered' };
    }
    if (!(await this.status(appId, QUOTE_TOOL, 'end', ctx))) return { kind: 'stopped' };
    report(QUOTE_TOOL, args, 'ok');
    let quoted: UnnumberedCard | null = null;
    let frameCardId: string | null = null;
    for (const card of outcome.cards) {
      const receipt: { id: string | null } = { id: null };
      await ctx.card(card, (cardId) => {
        receipt.id = cardId;
      });
      if (ctx.signal.aborted) return { kind: 'stopped' };
      if (quoted === null && card.type === 'rebate_quote' && receipt.id !== null) {
        quoted = card;
        frameCardId = receipt.id;
      }
    }
    return { kind: 'quoted', card: quoted, frameCardId };
  }

  quoteFailedNotice(appId: string): Promise<UnnumberedCard> {
    return this.notice(appId, QUOTE_FAILED, 'warn');
  }

  async serverFailure(appId: string): Promise<RunBodyResult> {
    const msg = await this.deps.errorMsg(appId, SERVER_FAILURE);
    return {
      kind: 'error',
      error: { code: SERVER_FAILURE, msg, retryable: false, fallback: null, fallback_q: null },
    };
  }

  // ---- context.order_id ----------------------------------------------------------------------

  async order(
    request: PathInput,
    orderId: string,
    ctx: RunContext,
    report: EntryCallReport,
  ): Promise<RunBodyResult> {
    const caller = request.input.caller;
    const appId = caller.appId;
    if (caller.userId === null || !caller.phoneBound) {
      // 判定顺序③: identity before any tool switch; never a guide card, no order is read.
      const login = caller.userId === null;
      const text = await this.deps.texts.text(
        appId,
        login ? 'agent.need_login' : 'agent.need_phone',
      );
      if (ctx.signal.aborted) return done('stop');
      ctx.text(text);
      await ctx.card({
        type: 'auth_required',
        schema_version: 1,
        data: { platform: null, reason: login ? 'login' : 'bind_phone', resume_link_id: null },
        fallback_text: text,
      });
      return ctx.signal.aborted ? done('stop') : done('auth_required');
    }
    const offered = await this.offered(appId, request);
    if (ctx.signal.aborted) return done('stop');
    // 判定顺序④: the order tool this entry needs is not offered (both off, or only it).
    if (!offered) return this.guide(request, ctx);

    if (!(await this.status(appId, ORDER_TOOL, 'start', ctx))) return done('stop');
    let outcome: ToolOutcome;
    try {
      outcome = await this.deps.readers.order(orderId, toolCallContext(request, ctx));
    } catch {
      outcome = { kind: 'failed', modelView: { error: 'tool_failed' } };
    }
    if (ctx.signal.aborted) return done('stop');
    const phase = outcome.kind === 'ok' ? 'end' : 'failed';
    if (!(await this.status(appId, ORDER_TOOL, phase, ctx))) return done('stop');
    report(ORDER_TOOL, { entry: 'order_id' }, outcome.kind === 'ok' ? 'ok' : 'failed');
    // BR-AI-07 T5: the template of this one call (0 orders → order_list.empty).
    const calls = new ReplyTemplateCalls();
    calls.called(ORDER_TOOL);
    if (outcome.kind === 'ok') {
      calls.succeeded(ORDER_TOOL, outcome.trace);
      for (const card of outcome.cards) {
        await ctx.card(card);
        if (ctx.signal.aborted) return done('stop');
      }
    }
    for (const template of calls.texts()) {
      const text = await this.deps.texts.text(appId, template.key);
      if (ctx.signal.aborted) return done('stop');
      ctx.text(
        template.count === undefined ? text : text.replaceAll('{n}', String(template.count)),
      );
    }
    return done('stop');
  }

  private async offered(appId: string, request: PathInput): Promise<boolean> {
    try {
      const definitions = await this.deps.tools.definitions(appId, request.input.caller);
      return definitions.some((definition) => definition.name === ORDER_TOOL);
    } catch {
      return false;
    }
  }

  /** BR-AI-01 细则「页面引导」: source → switch → contract ∩ configuration. */
  private async guideAllowed(request: PathInput): Promise<boolean> {
    const proceed = request.proceed;
    if (proceed.untrustedInput || proceed.paramsRequested) return false;
    const appId = request.input.caller.appId;
    if ((await configValue(this.deps.config, appId, PAGE_GUIDE_ENABLED)) !== true) return false;
    const contract = this.deps.routes.contract();
    if (!Object.hasOwn(contract, ORDER_LIST) || contract[ORDER_LIST]?.agent_guide !== true) {
      return false;
    }
    try {
      return (await this.deps.routes.configured(appId)).includes(ORDER_LIST);
    } catch {
      return false;
    }
  }

  private async guide(request: PathInput, ctx: RunContext): Promise<RunBodyResult> {
    const appId = request.input.caller.appId;
    const allowed = await this.guideAllowed(request);
    if (ctx.signal.aborted) return done('stop');
    if (!allowed) {
      const text = await this.deps.texts.text(appId, GUIDE_UNAVAILABLE);
      if (ctx.signal.aborted) return done('stop');
      ctx.text(text);
      return done('stop');
    }
    const textKey = `agent.guide.${ORDER_LIST}`;
    const fallback = await this.deps.texts.text(appId, textKey);
    if (ctx.signal.aborted) return done('stop');
    await ctx.card({
      type: 'page_guide',
      schema_version: 1,
      data: { route: ORDER_LIST, text_key: textKey },
      fallback_text: fallback,
    });
    return done('stop');
  }
}

export function createScenarioEntryPath(deps: ScenarioEntryPathDeps): ScenarioEntryPath {
  return new EntryPath(deps);
}
