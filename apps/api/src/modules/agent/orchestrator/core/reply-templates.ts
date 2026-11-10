// B3-08m · BR-AI-07 (T5 / T6): reply templates, decided by the core (orchestrator/core/run.ts) for
// every text exit of a run; no gate outside the core (stream/mount) and no reliance on the
// IntentPort's trace.calls. Rule tests: test/spec/agent/core-reply-templates/**. This file is the
// contract: its types, and the run-local record of template calls (ReplyTemplateCalls) that
// core/run.ts keeps per AgentRun and turns into the template keys below.
//
// Template tools: list_my_orders, explain_order, search_rules, get_my_earnings (B3-16a, D32).
//
// Template call: one model tool call of a template tool whose name is among this run's offered
//   definitions (tools.definitions of this run), whatever its outcome: ok, failed, rejected by the
//   handler, or rejected by the core for unparseable arguments. A name that was not offered (core
//   rejection without execute) is not a template call.
//   B3-08p 请求即算 (D10-888): a model round asking for an offered template tool counts it as
//   called when the round's calls start, at any position in the round, also when the run never
//   executes it (tool call budget spent, an earlier call of the round reaching the card cap, the
//   last allowed round still asking for tools). Such a call adds no order entry and no rule hit
//   (orders → order_list.empty unless other entries; rules → agent.rule.not_found unless a hit).
//   The count happens before anything of that round is settled or released (format check, the
//   guard's stop, U-10, budget, card cap): no model text of that round or earlier rounds goes out.
//   The requesting round's text still passes the OutputGuard (review and trace as before); when
//   the guard stops on it (agent.refuse.output_blocked) the run ends as a safety ending: the
//   guard's fixed text only, no model text and no template text (safety endings unchanged).
//   A tool round in structured format that asks for a template tool counts too: templates, done
//   stop (a template run never degrades).
//
// Template keys of a run, over all its template calls (the IntentPort's templateKeys rule):
//   - orders (any list_my_orders / explain_order call): the `orders` of every ok order call's
//     outcome.trace (ReplyTemplateTrace below, as tools/orders writes it), concatenated in call
//     order, one order counted once per run (by trace.order_ids, gate review S2-b); failed / rejected calls add none. 0 → order_list.empty; exactly 1 →
//     order_reason.<reason_code>.summary when reason_code is not null, else
//     order_status.<display_status>.summary; more than 1 → order_list.summary.
//     explain_order by order_no (BR-AI-07 判定 3 / 4; tools/orders marks it with trace.lookup):
//       · lookup 'not_tracked' (no own order with that number; the claim_draft card goes out) counts
//         as one entry with reason_code NOT_TRACKED, so on its own the key is
//         order_reason.NOT_TRACKED.summary, never order_list.empty;
//       · lookup 'rate_limited' (over agent.explain_order.order_no_daily_max, the lookup did not
//         run, no card) adds no entry and writes agent.order.lookup_limited after the orders key;
//         a run whose order calls were all rate limited (0 entries) writes only
//         agent.order.lookup_limited, never order_list.empty.
//     Rule tests run the real tools/orders handler behind the real ToolRegistry, so the marker is
//     whatever tools/orders actually returns (core-reply-templates/orders-lookup.test.ts).
//   - rules (any search_rules call): agent.rule.found when some ok search_rules call's
//     outcome.trace.matched is true (tools/rules), else agent.rule.not_found (no hit, failed or
//     rejected).
//   - earnings (any get_my_earnings call, B3-16a · BR-AI-07 / BR-AI-01 细则「收益查询」):
//     agent.earnings.summary when some ok get_my_earnings call's outcome.trace.earnings is 'shown'
//     (tools/earnings), else agent.earnings.unavailable (read failed, rejected).
//   Order of the keys when several kinds were called: orders (then agent.order.lookup_limited),
//   then earnings, then rules (the intent port's order). Each key is one
//   texts.text(appId, key) written as one ctx.text, through the run's output caps.
//
// Delivery rule (BR-AI-07「本 run 调用过订单类工具或 search_rules 时，模型生成的文本一律不下发」):
//   A run with at least one template call delivers no model text at all: not text of a tool round
//   before or after the template call (also when that text has no sentence end and sat in the
//   OutputGuard's buffer), not the final round's text, not an intent object's out_of_scope copy, not
//   the guard's tail. Instead, on every end of the run that would deliver or flush model text, the
//   template keys are written, and the run ends with the reason that end has today:
//     · final round with ordinary text, blank text (the model said nothing: templates still go
//       out), an {"agent_intent": …} object, or structured (invalid format) text → done stop;
//     · invalid format in a tool round, router degradation after delivery → done stop;
//       (implementation, gate review S1-1: in a run with a template call these two never take the
//       degraded path, delivered or not: templates, done stop)
//     · the last allowed round still asking for tools, the tool call budget spent → done limit.
//     · B3-08p: a tool's card or suggestions frame that ends the output at a cap (does not fit,
//       or reaches the cap exactly) → the templates are written right before that frame; done
//       limit.
//   The IntentPort is not consulted for the final text of such a run. Cards and suggestions the
//   tools returned are delivered as today. Cancellation writes nothing; a reached output cap writes
//   nothing more (as today). Refused / safety endings are unchanged (only agent.refuse.unsafe).
//   A run without a template call delivers its model text exactly as today: every delta through
//   the OutputGuard, in round and delta order, nothing added or dropped. Since a template call may
//   come in a later round, a run whose offered definitions include a template tool has to hold its
//   model text until it is known (e.g. until its final round or other end); when and whether to
//   hold in runs without template tools offered is the implementation's choice.
//   B3-08p (D10-888 (b2)): a holding run without a template call releases its held text, as the
//   OutputGuard emitted it (never raw deltas, no guard.end() flush), at the points where the run
//   is certain to end without another model round: right before a tool's card or suggestions
//   frame that ends the output at a cap, and before a later round's provider refusal
//   (agent.refuse.unsafe, done safety). Cancellation and the run time limit stay as they are: the
//   held text is dropped (BR-AI-14「缓冲中未下发的模型文本丢弃」); a thrown body still ends with
//   the RunManager's error only.
//
// Isolation: what a run has called lives in that run's own state (AgentRun), never in the factory,
//   the deps, a module-level table or anything keyed by runId that outlives the run. Runs of one
//   createAgentRunBody (same app, same deps) running one after another or interleaved never see
//   each other's calls; a later run reusing a runId starts clean.
//
// Trace: OrchestratorTrace.text_replaced_by_template is true when the run wrote template text in
//   place of the model's reply (BR-AI-07 细则「T6 与其他」); false or absent otherwise.
import type { ToolTraceFragment } from './ports.ts';

/** Template tool names the core recognises (get_my_earnings since B3-16a). */
export type ReplyTemplateTool =
  'list_my_orders' | 'explain_order' | 'search_rules' | 'get_my_earnings';

/** One order's template input, as tools/orders puts it on its ok outcome's trace. */
export interface ReplyTemplateOrder {
  readonly reason_code: string | null;
  readonly display_status: string;
}

/**
 * explain_order by order_no only (BR-AI-07 判定 3 / 4): 'not_tracked' = no own order with that
 * number (claim_draft card); 'rate_limited' = over the daily by-number limit, lookup not run.
 */
export type ReplyTemplateLookup = 'not_tracked' | 'rate_limited';

/**
 * The template inputs a template tool's ok outcome carries on `trace`, next to the
 * ToolTraceFragment members (never part of modelView): `orders` (and `lookup` for explain_order
 * by order_no) from list_my_orders / explain_order, `matched` from search_rules.
 */
export interface ReplyTemplateTrace extends ToolTraceFragment {
  readonly orders?: readonly ReplyTemplateOrder[];
  /** B3-08m: orders[i]'s order_id (tools/orders); an order shown twice in a run counts once. */
  readonly order_ids?: readonly string[];
  readonly lookup?: ReplyTemplateLookup;
  readonly matched?: boolean;
  /** B3-16a: get_my_earnings showed its earnings_summary card (tools/earnings). */
  readonly earnings?: 'shown';
}

const TEMPLATE_TOOLS: readonly string[] = [
  'list_my_orders',
  'explain_order',
  'search_rules',
  'get_my_earnings',
];

/** True for a template tool name (the caller still checks it was offered to this run). */
export function isReplyTemplateTool(name: string): name is ReplyTemplateTool {
  return TEMPLATE_TOOLS.includes(name);
}

/** A key segment the core accepts from a tool's trace (enum codes such as PAID, PART_REFUND). */
const KEY_SEGMENT = /^[A-Z][A-Z0-9_]{0,63}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One order of a call: its template input and, when the tool gave it, its order_id. */
interface OrderEntry {
  readonly id: string | null;
  readonly order: ReplyTemplateOrder;
}

/** The template inputs of one ok order call's trace; malformed entries are skipped. */
function ordersOf(trace: unknown): OrderEntry[] {
  if (!isRecord(trace) || !Array.isArray(trace['orders'])) return [];
  const ids: readonly unknown[] = Array.isArray(trace['order_ids']) ? trace['order_ids'] : [];
  const out: OrderEntry[] = [];
  (trace['orders'] as unknown[]).forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const reason = entry['reason_code'];
    const status = entry['display_status'];
    if (typeof status !== 'string') return;
    if (reason !== null && typeof reason !== 'string') return;
    const id = ids[index];
    out.push({
      id: typeof id === 'string' && id !== '' ? id : null,
      order: { reason_code: reason, display_status: status },
    });
  });
  return out;
}

/** One order entry's key (BR-AI-07 T5); an unusable code falls back to the list summary. */
function orderKey(order: ReplyTemplateOrder): string {
  if (order.reason_code !== null) {
    return KEY_SEGMENT.test(order.reason_code)
      ? `order_reason.${order.reason_code}.summary`
      : 'order_list.summary';
  }
  return KEY_SEGMENT.test(order.display_status)
    ? `order_status.${order.display_status}.summary`
    : 'order_list.summary';
}

/** One template text to write: the key, and the order count for order_list.summary's {n}. */
export interface ReplyTemplateText {
  readonly key: string;
  readonly count?: number;
}

/**
 * The template calls of one run (one instance per AgentRun, never shared): called() for each template
 * call, succeeded() for its ok outcome, then texts() gives the keys in the contract's order. Empty until the
 * first record.
 */
export class ReplyTemplateCalls {
  private orderCalled = false;
  /** Distinct orders of the run, first-seen order; one order shown again keeps its latest state. */
  private readonly orders: ReplyTemplateOrder[] = [];
  private readonly orderIndex = new Map<string, number>();
  private rateLimited = false;
  private rulesCalled = false;
  private rulesMatched = false;
  private earningsCalled = false;
  private earningsShown = false;

  get any(): boolean {
    return this.orderCalled || this.rulesCalled || this.earningsCalled;
  }

  /** A template call was made (counted before it runs, whatever its outcome). */
  called(name: ReplyTemplateTool): void {
    if (name === 'search_rules') this.rulesCalled = true;
    else if (name === 'get_my_earnings') this.earningsCalled = true;
    else this.orderCalled = true;
  }

  /** The ok outcome of a template call made earlier: its trace's template inputs. */
  succeeded(name: ReplyTemplateTool, trace: unknown): void {
    this.called(name);
    if (name === 'search_rules') {
      if (isRecord(trace) && trace['matched'] === true) this.rulesMatched = true;
      return;
    }
    if (name === 'get_my_earnings') {
      if (isRecord(trace) && trace['earnings'] === 'shown') this.earningsShown = true;
      return;
    }
    for (const entry of ordersOf(trace)) {
      const seen = entry.id === null ? undefined : this.orderIndex.get(entry.id);
      if (seen !== undefined) {
        this.orders[seen] = entry.order;
        continue;
      }
      if (entry.id !== null) this.orderIndex.set(entry.id, this.orders.length);
      this.orders.push(entry.order);
    }
    const lookup = isRecord(trace) ? trace['lookup'] : undefined;
    if (lookup === 'not_tracked') {
      this.orders.push({ reason_code: 'NOT_TRACKED', display_status: '' });
    } else if (lookup === 'rate_limited') {
      this.rateLimited = true;
    }
  }

  /** The template texts of the run, in order: orders, agent.order.lookup_limited, earnings, rules. */
  texts(): readonly ReplyTemplateText[] {
    const out: ReplyTemplateText[] = [];
    if (this.orderCalled) {
      const [first, ...rest] = this.orders;
      if (first === undefined) {
        if (!this.rateLimited) out.push({ key: 'order_list.empty' });
      } else if (rest.length > 0) {
        out.push({ key: 'order_list.summary', count: this.orders.length });
      } else {
        const key = orderKey(first);
        out.push(key === 'order_list.summary' ? { key, count: 1 } : { key });
      }
      if (this.rateLimited) out.push({ key: 'agent.order.lookup_limited' });
    }
    if (this.earningsCalled) {
      out.push({
        key: this.earningsShown ? 'agent.earnings.summary' : 'agent.earnings.unavailable',
      });
    }
    if (this.rulesCalled) {
      out.push({ key: this.rulesMatched ? 'agent.rule.found' : 'agent.rule.not_found' });
    }
    return out;
  }
}
