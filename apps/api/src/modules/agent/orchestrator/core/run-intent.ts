// B3-08t · BR-AI-19 细则「运行级字段」: the intent stored in agent_runs.intent (agent_intent, 10 values,
// or null), written with the terminal state. Pure: the caller hands in what this run decided.
//
// Order of the sources:
//   1. the intent port's verdict (判定顺序② server-checked; e.g. 查一下我的订单 with a model label
//      earnings_query is order_query) — when the port recorded one, it is the run's label;
//   2. otherwise the core's trace intent: the deterministic link path and the entries
//      (find_by_link / order_query), the no-model path's ①–⑥, or the model's own label (without an
//      intent port, or a template run);
//   3. a degraded run that served nothing (greetings only, no product word, so no search) has none;
//   4. a label that is not one of the 10 (null, unknown) falls back to the first tool called in the
//      run (search_products → search, get_rebate_quote → find_by_link, the three order tools →
//      order_query, get_my_earnings → earnings_query, search_rules → rule_qa, handoff_to_human →
//      handoff); no tool either → null.
// The model protocol's 「第 N 个」 (ref_ordinal) is stored as refine. Never the model's raw label
// unless it passed through one of the above; never a value outside the contract enum.
import { agent_intent as AGENT_INTENTS, type AgentIntent } from '@couli/contracts-ts';

export interface StoredIntentFacts {
  /** The intent port's verdict when it recorded one (null: it decided on none). */
  readonly checked?: string | null;
  /** The core's trace intent (OrchestratorTrace.intent). */
  readonly traced: string | null;
  /** The no-model path served the message without an intent (greetings, no product word). */
  readonly unserved?: boolean;
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
  const label =
    facts.checked !== undefined ? facts.checked : facts.unserved === true ? null : facts.traced;
  const intent = contractIntentOf(label);
  if (intent !== null) return intent;
  if (facts.firstTool === null || !Object.hasOwn(TOOL_INTENTS, facts.firstTool)) return null;
  return TOOL_INTENTS[facts.firstTool] ?? null;
}
