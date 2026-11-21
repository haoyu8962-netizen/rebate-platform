// B3-08t · BR-AI-19 细则「运行级字段」: the intent stored in agent_runs.intent (agent_intent, 10 values,
// or null), written with the terminal state. Pure: the caller hands in what this run decided.
//
// 统一原则 (编排 D10-2368): only what was checked is stored; anything unchecked stays empty
// (宁可漏判留空，不可误判). The model's own label is never stored as such — it is unchecked by
// default, not only in a template run. Order of the sources:
//   0. a scenario entry's intent (product → find_by_link, order → order_query): a deterministic fact,
//      kept over any later text handling (the page guide reason of that handling is still stored);
//   1. the intent port's recorded verdict (判定顺序② server-checked; e.g. 查一下我的订单 with a model
//      label earnings_query is order_query) — when the port recorded one, it is the run's label;
//   2. otherwise a deterministic rule's result (`ruled`): the link path (find_by_link), the order
//      entry, the no-model path's ①–⑥ (not when it served nothing: greetings only, no product word);
//   3. a run answered without any checked intent (`withheld`: U-7, no IntentPort) has none;
//   4. otherwise (no port verdict yet — cancelled, timed out, failed, a template run — or a verdict
//      outside the 10) the first tool called in the run (search_products → search,
//      get_rebate_quote → find_by_link, the three order tools → order_query, get_my_earnings →
//      earnings_query, search_rules → rule_qa, handoff_to_human → handoff); no tool either → null.
// The model protocol's 「第 N 个」 (ref_ordinal) is stored as refine. Never a value outside the
// contract enum.
import { agent_intent as AGENT_INTENTS, type AgentIntent } from '@couli/contracts-ts';

export interface StoredIntentFacts {
  /** The scenario entry's intent (OrchestratorTrace.entry_intent), when the run had an entry. */
  readonly entry?: string | null;
  /** The intent port's verdict when it recorded one (null: it decided on none). */
  readonly checked?: string | null;
  /** A deterministic rule's intent (OrchestratorTrace.intent with intent_ruled), else null. */
  readonly ruled?: string | null;
  /** The run was answered without any checked intent (OrchestratorTrace.intent_withheld). */
  readonly withheld?: boolean;
  /** Name of the first tool called in the run (model or server initiated), null without one. */
  readonly firstTool: string | null;
}

const TOOL_INTENTS: Readonly<Record<string, AgentIntent>> = {
  search_products: 'search',
  get_rebate_quote: 'find_by_link',
  list_my_orders: 'order_query',
  explain_order: 'order_query',
  prefill_claim: 'order_query',
  get_my_earnings: 'earnings_query',
  search_rules: 'rule_qa',
  handoff_to_human: 'handoff',
};

/** A label as one of the 10 contract values; ref_ordinal is refine; anything else null. */
export function contractIntentOf(label: string | null | undefined): AgentIntent | null {
  if (typeof label !== 'string') return null;
  if (label === 'ref_ordinal') return 'refine';
  return (AGENT_INTENTS as readonly string[]).includes(label) ? (label as AgentIntent) : null;
}

/** The intent agent_runs.intent stores for one run (see the header). */
export function storedIntentOf(facts: StoredIntentFacts): AgentIntent | null {
  const entry = contractIntentOf(facts.entry);
  if (entry !== null) return entry;
  const label = facts.checked !== undefined ? facts.checked : (facts.ruled ?? null);
  const intent = contractIntentOf(label);
  if (intent !== null) return intent;
  if (facts.withheld === true) return null;
  if (facts.firstTool === null || !Object.hasOwn(TOOL_INTENTS, facts.firstTool)) return null;
  return TOOL_INTENTS[facts.firstTool] ?? null;
}
