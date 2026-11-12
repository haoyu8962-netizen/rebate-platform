import type { CatalogConfigReader } from '../../../catalog/index.ts';
import type { Clock } from '../../../platform/index.ts';
import { degradeFinishReason } from '../../model-gateway/degraded/index.ts';
import type { RunBodyResult, RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import { handoffCard } from '../../tools/handoff/index.ts';
import type {
  DegradedIntent,
  DegradedPath,
  OrchestratorTools,
  ToolOutcome,
} from '../core/ports.ts';
import { openCardCall, type CardCall } from '../core/card-references.ts';
import { routeDegradedIntent } from '../core/degraded-intent.ts';
import { ReplyTemplateCalls, isReplyTemplateTool } from '../core/reply-templates.ts';
import type { IntentDeps } from '../intents/index.ts';
import {
  classifyDegraded,
  greetingOnly,
  orderNumberOf,
  readMessage,
  type EarningsTopic,
  type GuideRoute,
  type MessageText,
} from './classify.ts';
import { calendarDay } from './calendar.ts';
import { extractSearchTerms, platformsIn } from './extract.ts';
import type { DegradedPathDeps } from './index.ts';
import { createDegradedPath, reportTrace, runKeywordPlan, stopped, toolContext } from './index.ts';
import { degradedEmptyKey, emptyReply, isProhibited, noticeCard } from './replies.ts';

/** B3-05n: full no-model path; mount supplies the same tools/config/routes as the stream.
 * The implementation must wire this entry into createDegradedPath / stream/mount/body.ts.
 * Classification is independent of the model-label checker in intents/classify.ts.
 */
export interface RoutedDegradedPathDeps extends Omit<DegradedPathDeps, 'tools'> {
  readonly tools: OrchestratorTools;
  readonly clock: Clock;
  readonly config: CatalogConfigReader;
  readonly routes: IntentDeps['routes'];
  readonly previousIntent: IntentDeps['continuation']['previousIntent'];
}

// B3-05n · BR-AI-14 细则「无模型降级」(2026-11-12): links and tokens never reach this path (the
// core's deterministic path); every other message is first read by the strict code reading of
// classify.ts and only searched when it is none of ①–⑤:
//   ① page location (钱包 / 提现记录 / 订单列表 only) → page_guide card after every check of BR-AI-01
//     细则「页面引导」 (input source, agent.page_guide.enabled, configuration ∩ contract), else
//     agent.guide.unavailable;
//   ② general rules → search_rules with the redacted question (BR-AI-07 T6 template);
//   ③ own orders / ④ own earnings → identity first (guest auth_required login, not phone-bound
//     bind_phone), then the read tool when this run is offered it, else the guide card (判定顺序
//     ③④); orders: explain_order by the first placeholder's number (platform only when this
//     message names one), else list_my_orders over today − agent.orders.default_span_days (30, not
//     above agent.orders.max_span_days) on the injected Clock (+08:00); template text BR-AI-07;
//   ⑤ handoff card;
//   ⑥ search_products with q / named platforms / sort / price / exclude_keywords taken by code
//     (extract.ts), the tool path's filters, no relaxation: agent.degraded with cards,
//     agent.degraded.empty notice without, agent.refuse.prohibited when refused, 50302 when every
//     platform failed; nothing left of the words → agent.welcome (greetings only) or
//     agent.reply.empty, with agent.suggest.empty.1–3, done stop.
// ⑥ ends fallback (budget when the budget triggered); ①–⑤ end as with a model (stop or
// auth_required). The intent routed to (①–⑥ above) is registered on the core's run context
// (core/degraded-intent.ts), for the run's trace intent and so the next run's 承接
// (previousIntent). agent.degraded.route_intents off (unreadable: on) → createDegradedPath, which
// keeps the three corrections. No error code is returned except 50302.

type Done = Extract<RunBodyResult, { kind: 'done' }>;
type Request = Parameters<DegradedPath['run']>[0];
type PersonalKind = 'order' | 'earnings';

const SWITCH_KEY = 'agent.degraded.route_intents';
const PAGE_GUIDE_ENABLED = 'agent.page_guide.enabled';
const GUIDE_UNAVAILABLE = 'agent.guide.unavailable';
const ORDER_SPAN_KEY = 'agent.orders.default_span_days';
const ORDER_MAX_SPAN_KEY = 'agent.orders.max_span_days';
/** BR-AI-01 细则「意图兜底与不空回复」 default span; BR-AI-07 default max span. */
const DEFAULT_SPAN_DAYS = 30;
const DEFAULT_MAX_SPAN_DAYS = 90;
/** explain_order's order_no bound (tools/orders). */
const MAX_ORDER_NO = 64;
/** search_rules' question bound (tools/rules). */
const MAX_QUESTION = 200;
const PLATFORMS: readonly string[] = ['taobao', 'jd', 'pdd'];

function done(finishReason: Done['finishReason']): Done {
  return { kind: 'done', finishReason };
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

function positiveDays(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const MS_PER_DAY = 86_400_000;
const PLUS_EIGHT_MS = 8 * 3_600_000;

function plusEightToday(clock: Clock): number {
  return Math.floor((clock.now().getTime() + PLUS_EIGHT_MS) / MS_PER_DAY);
}

/** The single platform this message names (BR-AI-07 判定规则 7); none or several: undefined. */
function namedPlatform(named: readonly string[]): string | undefined {
  return named.length === 1 && PLATFORMS.includes(named[0]!) ? named[0] : undefined;
}

class RoutedRun {
  private offered: Promise<ReadonlySet<string>> | undefined;
  private readonly appId: string;
  private readonly message: MessageText;
  private readonly deps: RoutedDegradedPathDeps;
  private readonly request: Request;
  private readonly ctx: RunContext;

  constructor(deps: RoutedDegradedPathDeps, request: Request, ctx: RunContext) {
    this.deps = deps;
    this.request = request;
    this.ctx = ctx;
    this.appId = request.input.caller.appId;
    this.message = readMessage(request.proceed.modelText);
  }

  private get aborted(): boolean {
    return this.ctx.signal.aborted;
  }

  async run(): Promise<RunBodyResult> {
    const reading = classifyDegraded(this.message.trusted);
    switch (reading.kind) {
      case 'page':
        this.routedTo('page_guide');
        return this.guide(reading.route);
      case 'rule':
        this.routedTo('rule_qa');
        return this.rules();
      case 'order':
        this.routedTo('order_query');
        return this.personal('order', 'summary');
      case 'earnings':
        this.routedTo('earnings_query');
        return this.personal('earnings', reading.topic);
      case 'elliptical': {
        // Same as 判定顺序②: an order run just before decides; otherwise own earnings.
        const previous = await this.deps.previousIntent({
          input: this.request.input,
          proceed: this.request.proceed,
        });
        if (this.aborted) return stopped();
        const kind: PersonalKind = previous === 'order_query' ? 'order' : 'earnings';
        this.routedTo(kind === 'order' ? 'order_query' : 'earnings_query');
        return this.personal(kind, 'summary');
      }
      case 'handoff':
        this.routedTo('handoff');
        return this.handoff();
      case 'search':
        this.routedTo('search');
        return this.search();
    }
  }

  /** The intent this message is served as, registered on the core's run context for the run's
   * trace (the next run's 承接 reads it); the tool or card it ends with may still be a fallback of
   * that intent. Only on the very context the core handed run (this.ctx, never a copy). */
  private routedTo(intent: DegradedIntent): void {
    try {
      routeDegradedIntent(this.ctx, intent);
    } catch {
      // Best effort, as the trace it feeds: never changes the run's result.
    }
  }

  // ---- tools ---------------------------------------------------------------------------------

  /** Tools this run is offered (registered, switched on, audience allows the caller). */
  private offers(name: string): Promise<boolean> {
    this.offered ??= this.deps.tools
      .definitions(this.appId, this.request.input.caller)
      .then((list) => new Set(list.map((d) => d.name)));
    return this.offered.then((names) => names.has(name));
  }

  /**
   * One tool call in its own card-reference scope, as the core opens for a model's call
   * (core/card-references.ts): the handlers' cardReference (the core's, wired by the stream
   * assembly) only issues references on a context whose placeholders table was bound by
   * openCardCall, and throws otherwise (the tool would fail). The scope is closed once execute
   * returns; deliver() records each card's delivered card_id against it.
   */
  private async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ readonly outcome: ToolOutcome; readonly refs: CardCall }> {
    const id = `degraded-${name}`;
    const placeholders = Object.freeze({ ...this.request.proceed.placeholders });
    const refs = openCardCall(id, placeholders);
    try {
      const outcome = await this.deps.tools.execute(
        { id, name, args },
        { ...toolContext(this.request, this.ctx), placeholders },
      );
      return { outcome, refs };
    } finally {
      refs.close();
    }
  }

  private async deliver(cards: readonly UnnumberedCard[], refs?: CardCall): Promise<boolean> {
    for (const card of cards) {
      let cardId: string | null = null;
      await this.ctx.card(card, (written) => {
        cardId = written;
      });
      refs?.delivered(cardId);
      if (this.aborted) return false;
    }
    return true;
  }

  /** A template tool (BR-AI-07): its cards, then the template text of its outcome; done stop. */
  private async templateCall(name: string, args: Record<string, unknown>): Promise<RunBodyResult> {
    const { outcome, refs } = await this.execute(name, args);
    if (this.aborted) return stopped();
    const calls = new ReplyTemplateCalls();
    if (isReplyTemplateTool(name)) {
      calls.called(name);
      if (outcome.kind === 'ok') calls.succeeded(name, outcome.trace);
    }
    if (outcome.kind === 'ok') {
      if (!(await this.deliver(outcome.cards, refs))) return stopped();
      if (outcome.suggestions !== undefined && outcome.suggestions.length > 0) {
        this.ctx.suggestions(outcome.suggestions);
      }
    }
    for (const template of calls.texts()) {
      const text = await this.deps.texts.text(this.appId, template.key);
      if (this.aborted) return stopped();
      this.ctx.text(
        template.count === undefined ? text : text.replaceAll('{n}', String(template.count)),
      );
    }
    return done('stop');
  }

  // ---- ① page guide --------------------------------------------------------------------------

  /** BR-AI-01 细则「页面引导」: source → switch → contract ∩ configuration. */
  private async guideAllowed(route: GuideRoute): Promise<boolean> {
    const proceed = this.request.proceed;
    if (proceed.untrustedInput || proceed.paramsRequested) return false;
    if ((await configValue(this.deps.config, this.appId, PAGE_GUIDE_ENABLED)) !== true) {
      return false;
    }
    const contract = this.deps.routes.contract();
    if (!Object.hasOwn(contract, route) || contract[route]?.agent_guide !== true) return false;
    try {
      return (await this.deps.routes.configured(this.appId)).includes(route);
    } catch {
      return false;
    }
  }

  private async guide(route: GuideRoute): Promise<RunBodyResult> {
    const allowed = await this.guideAllowed(route);
    if (this.aborted) return stopped();
    if (!allowed) {
      const text = await this.deps.texts.text(this.appId, GUIDE_UNAVAILABLE);
      if (this.aborted) return stopped();
      this.ctx.text(text);
      return done('stop');
    }
    const textKey = `agent.guide.${route}`;
    const fallback = await this.deps.texts.text(this.appId, textKey);
    if (this.aborted) return stopped();
    await this.ctx.card({
      type: 'page_guide',
      schema_version: 1,
      data: { route, text_key: textKey },
      fallback_text: fallback,
    });
    return this.aborted ? stopped() : done('stop');
  }

  // ---- ② rules, ⑤ handoff --------------------------------------------------------------------

  private async rules(): Promise<RunBodyResult> {
    const question = [...this.message.trustedRaw].slice(0, MAX_QUESTION).join('').trim();
    const offered = question !== '' && (await this.offers('search_rules'));
    if (this.aborted) return stopped();
    // Without search_rules the question goes to people, never to the product search.
    if (!offered) return this.handoff();
    return this.templateCall('search_rules', { question });
  }

  private async handoff(): Promise<RunBodyResult> {
    const offered = await this.offers('handoff_to_human');
    if (this.aborted) return stopped();
    if (offered) {
      const { outcome, refs } = await this.execute('handoff_to_human', {});
      if (this.aborted) return stopped();
      if (outcome.kind === 'ok' && outcome.cards.length > 0) {
        return (await this.deliver(outcome.cards, refs)) ? done('stop') : stopped();
      }
    }
    // The same card search_rules and the order tools give without a hit: no data behind it.
    const card = await handoffCard(
      { texts: (app, key) => this.deps.texts.text(app, key) },
      this.appId,
    );
    if (this.aborted) return stopped();
    return (await this.deliver([card])) ? done('stop') : stopped();
  }

  // ---- ③ orders, ④ earnings ------------------------------------------------------------------

  private async personal(kind: PersonalKind, topic: EarningsTopic): Promise<RunBodyResult> {
    const caller = this.request.input.caller;
    if (caller.userId === null || !caller.phoneBound) {
      // 判定顺序③: identity before any tool switch; never a guide card.
      const login = caller.userId === null;
      const key =
        kind === 'order'
          ? login
            ? 'agent.need_login'
            : 'agent.need_phone'
          : login
            ? 'agent.earnings.need_login'
            : 'agent.earnings.need_phone';
      const text = await this.deps.texts.text(this.appId, key);
      if (this.aborted) return stopped();
      this.ctx.text(text);
      await this.ctx.card({
        type: 'auth_required',
        schema_version: 1,
        data: { platform: null, reason: login ? 'login' : 'bind_phone', resume_link_id: null },
        fallback_text: text,
      });
      return this.aborted ? stopped() : done('auth_required');
    }
    return kind === 'order' ? this.orders() : this.earnings(topic);
  }

  private async orders(): Promise<RunBodyResult> {
    const orderNo = orderNumberOf(this.message, MAX_ORDER_NO);
    if (orderNo !== null && (await this.offers('explain_order'))) {
      if (this.aborted) return stopped();
      const platform = namedPlatform(platformsIn(this.message.trusted));
      return this.templateCall('explain_order', {
        order_no: orderNo,
        ...(platform === undefined ? {} : { platform }),
      });
    }
    if (this.aborted) return stopped();
    if (!(await this.offers('list_my_orders'))) {
      if (this.aborted) return stopped();
      return this.guide('OrderList');
    }
    const [span, max] = await Promise.all([
      configValue(this.deps.config, this.appId, ORDER_SPAN_KEY),
      configValue(this.deps.config, this.appId, ORDER_MAX_SPAN_KEY),
    ]);
    if (this.aborted) return stopped();
    const days = Math.min(
      positiveDays(span, DEFAULT_SPAN_DAYS),
      positiveDays(max, DEFAULT_MAX_SPAN_DAYS),
    );
    const today = plusEightToday(this.deps.clock);
    return this.templateCall('list_my_orders', {
      date_from: calendarDay(today - days),
      date_to: calendarDay(today),
    });
  }

  private async earnings(topic: EarningsTopic): Promise<RunBodyResult> {
    const offered = await this.offers('get_my_earnings');
    if (this.aborted) return stopped();
    if (!offered) return this.guide(topic === 'withdrawal_progress' ? 'WithdrawRecords' : 'Wallet');
    return this.templateCall('get_my_earnings', {});
  }

  // ---- ⑥ keyword search ----------------------------------------------------------------------

  private async search(): Promise<RunBodyResult> {
    const free = this.message.free;
    if (greetingOnly(free)) return emptyReply(this.deps.texts, this.appId, this.ctx, true);
    const terms = extractSearchTerms(free);
    if (terms.q === '') return emptyReply(this.deps.texts, this.appId, this.ctx, false);

    const finish = degradeFinishReason(this.request.reason);
    const enabled = await this.deps.tools.enabledSearchPlatforms(this.appId);
    if (this.aborted) return stopped();
    const platforms =
      terms.named.length === 0 ? [...enabled] : enabled.filter((p) => terms.named.includes(p));
    if (platforms.length === 0) return this.emptyNotice(finish);

    const { outcome, refs } = await this.execute('search_products', {
      q: terms.q,
      platforms,
      sort: terms.sort,
      ...(terms.priceMinFen === undefined ? {} : { price_min_fen: terms.priceMinFen }),
      ...(terms.priceMaxFen === undefined ? {} : { price_max_fen: terms.priceMaxFen }),
      ...(terms.exclude.length === 0 ? {} : { exclude_keywords: [...terms.exclude] }),
    });
    if (this.aborted) return stopped();
    if (outcome.kind === 'rejected') {
      // Arguments the tool would not take. Not its switch: the production degraded tools reach
      // the search_products handler without agent.tools.search_products.enabled (stream/mount
      // degradedTools, BR-AI-14 looks only at agent.degraded.route_intents and the platform
      // switches), so price, sort and exclusions are kept there. Here: the plain keyword search.
      return runKeywordPlan(this.deps, this.request, this.ctx, {
        q: terms.q,
        platforms,
        sort: 'relevance',
      });
    }
    if (outcome.kind === 'failed') {
      // Every searched platform failed (BR-AI-14: 50302, the client opens the search page).
      const msg = await this.deps.errorMsg(this.appId, 50302);
      if (this.aborted) return stopped();
      return {
        kind: 'error',
        error: { code: 50302, msg, retryable: true, fallback: 'search_page', fallback_q: terms.q },
      };
    }
    const cards = outcome.cards;
    const prohibited = isProhibited(cards);
    const listed = cards.some((card) => card.type === 'product_list');
    const delivered = prohibited || listed ? await this.deliver(cards, refs) : true;
    // After delivery, with this call's references resolved to the delivered card ids (records of
    // an undelivered card left out), as the core does for a model's call.
    if (outcome.trace !== undefined) {
      const { card_sources: sources, link_registrations: links } = outcome.trace;
      reportTrace(this.deps, {
        ...(sources === undefined ? {} : { card_sources: refs.records(sources, ['card_id']) }),
        ...(links === undefined
          ? {}
          : { link_registrations: refs.records(links, ['link_id', 'product_key']) }),
      });
    }
    if (!delivered) return stopped();
    if (prohibited) return done(finish);
    if (!listed) return this.emptyNotice(finish);
    const text = await this.deps.texts.text(this.appId, 'agent.degraded');
    if (this.aborted) return stopped();
    this.ctx.text(text);
    return done(finish);
  }

  private async emptyNotice(finish: Done['finishReason']): Promise<RunBodyResult> {
    const card = await noticeCard(this.deps.texts, this.appId, degradedEmptyKey());
    if (this.aborted) return stopped();
    return (await this.deliver([card])) ? done(finish) : stopped();
  }
}

/** agent.degraded.route_intents: only an explicit false turns routing off. */
async function routesIntents(deps: RoutedDegradedPathDeps, appId: string): Promise<boolean> {
  return (await configValue(deps.config, appId, SWITCH_KEY)) !== false;
}

export function createRoutedDegradedPath(deps: RoutedDegradedPathDeps): DegradedPath {
  const keyword = createDegradedPath(deps);
  return {
    async run(request: Request, ctx: RunContext): Promise<RunBodyResult> {
      if (ctx.signal.aborted) return stopped();
      const on = await routesIntents(deps, request.input.caller.appId);
      if (ctx.signal.aborted) return stopped();
      // Off: the keyword search, whose intent is the core's default (search).
      if (!on) return keyword.run(request, ctx);
      return new RoutedRun(deps, request, ctx).run();
    },
  };
}
