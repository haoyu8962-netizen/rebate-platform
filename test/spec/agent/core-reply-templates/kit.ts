// B3-08m rule-test kit (no database, no Nest) · BR-AI-07「本 run 调用过订单类工具（list_my_orders、
// explain_order）或 search_rules 时，模型生成的文本一律不下发，由服务端输出模板文本」, decided in
// orchestrator/core (contract: apps/api/src/modules/agent/orchestrator/core/reply-templates.ts).
// One core body (createAgentRunBody over synthetic ports, ../stream-model-prereq/kit.ts
// syntheticBody) runs any number of runs; the scripted model answers each run by its user text, so
// runs of the same body can interleave. The template tools answer as tools/rules and tools/orders
// do (their template inputs on outcome.trace). Existing kits are imported unchanged.
import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import type { RunBodyInput } from '../../../../apps/api/src/modules/agent/http/index.ts';
import { createAgentRunBody } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type {
  AgentRunBodyDeps,
  OrchestratorTools,
  OrchestratorTrace,
  ToolContext,
  ToolOutcome,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type {
  ReplyTemplateOrder,
  ReplyTemplateTrace,
} from '../../../../apps/api/src/modules/agent/orchestrator/core/reply-templates.ts';
import type {
  RunBodyResult,
  UnnumberedCard,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import {
  inputFor,
  list,
  receiptContext,
  syntheticBody,
  type CardFrame,
} from '../stream-model-prereq/kit.ts';

export const APP_ID = 'synthetic-app-b3-08m';

/** The model's own conclusion (BR-AI-07: never reaches the user once a template tool ran). */
export const MODEL_TEXT = '提现最低10元，返利已到账。';
/** A model conclusion about an order (BR-AI-07: 不得下“已返 / 已到账 / 没返”这类结论). */
export const ORDER_MODEL_TEXT = '这笔订单已返利到账，放心。';
/** A tool round's lead-in with a sentence end. */
export const LEAD = '我先看看。';
/** A tool round's lead-in without a sentence end (stays in the OutputGuard's buffer). */
export const LEAD_OPEN = '我先看看';

/** What syntheticBody's texts port answers for a fixed key. */
export function fixed(key: string): string {
  return `固定文案:${key}`;
}

// ---- the scripted model -----------------------------------------------------------------------

type Complete = AgentRunBodyDeps['model']['complete'];
type Outcome = Awaited<ReturnType<Complete>>;
type ModelOk = Extract<Outcome, { kind: 'model' }>;
type ModelEvent = ModelOk['events'][number];
type DegradeReason = Extract<Outcome, { kind: 'degraded' }>['reason'];

/** One model round of one run. */
export interface Step {
  /** One text delta per element (a string is one delta); absent or '' means no text. */
  readonly text?: string | readonly string[];
  readonly calls?: readonly { readonly name: string; readonly args: unknown }[];
  /** The router degrades this round instead of answering (no events). */
  readonly degraded?: DegradeReason;
  /** Awaited before the round answers (to interleave runs). */
  readonly before?: () => Promise<void>;
}

/**
 * model.complete answering each run by its user text (the first message, the run's modelText):
 * the n-th complete call of that text gets the n-th step; once its steps run out, an empty final
 * round (no text, no calls).
 */
export function scriptedModels(scripts: Readonly<Record<string, readonly Step[]>>) {
  const seen = new Map<string, number>();
  let rounds = 0;
  return vi.fn<Complete>(async (chat) => {
    rounds += 1;
    const round = rounds;
    const first = chat.messages[0];
    const key = typeof first?.content === 'string' ? first.content : '';
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    const step: Step = scripts[key]?.[index] ?? {};
    if (step.before !== undefined) await step.before();
    if (step.degraded !== undefined) {
      const degraded: Outcome = { kind: 'degraded', reason: step.degraded, attempts: [] };
      return degraded;
    }
    const deltas = typeof step.text === 'string' ? [step.text] : (step.text ?? []);
    const events: ModelEvent[] = [];
    for (const text of deltas) {
      if (text !== '') events.push({ t: 'text_delta', text });
    }
    (step.calls ?? []).forEach((call, position) => {
      events.push({
        t: 'tool_call',
        index: position,
        call: {
          id: `synthetic-call-${String(round)}-${String(position)}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        },
      });
    });
    const outcome: ModelOk = {
      kind: 'model',
      entryId: 'synthetic-entry',
      model: 'synthetic-model',
      events,
      usage: { input_tokens: 0, output_tokens: 0 },
      attempts: [],
    };
    return outcome;
  });
}

/** The tool names offered to the model on the first round of the run with user text `text`. */
export function offeredFor(complete: ReturnType<typeof scriptedModels>, text: string): string[] {
  const call = complete.mock.calls.find(([chat]) => chat.messages[0]?.content === text);
  return (call?.[0].tools ?? []).map((tool) => tool.name);
}

// ---- cards and tool outcomes ------------------------------------------------------------------

export const PAID: ReplyTemplateOrder = { reason_code: null, display_status: 'PAID' };
export const WAITING: ReplyTemplateOrder = { reason_code: null, display_status: 'WAITING' };
export const PART_REFUND: ReplyTemplateOrder = {
  reason_code: 'PART_REFUND',
  display_status: 'WAITING',
};

export function ruleRefCard(n = 1): UnnumberedCard {
  return {
    type: 'rule_ref',
    schema_version: 1,
    data: {
      chunk_id: `synthetic-chunk-${String(n)}`,
      title: '提现规则',
      excerpt: '提现最低金额以提现页显示为准。',
      published_version: '1',
      action: { route: 'Help', params: { article_id: `synthetic-article-${String(n)}` } },
    },
    fallback_text: '提现规则',
  };
}

export function handoffCard(): UnnumberedCard {
  return {
    type: 'handoff',
    schema_version: 1,
    data: { text_key: 'agent.handoff.default', actions: [] },
    fallback_text: '可以联系客服确认。',
  };
}

export function orderStatusCard(order: ReplyTemplateOrder, n = 1): UnnumberedCard {
  return {
    type: 'order_status',
    schema_version: 1,
    data: {
      order_id: `0192f3a1-7c00-7000-8000-00000000c00${String(n)}`,
      platform: 'jd',
      title: '合成牛奶',
      is_other_product: false,
      display_status: order.display_status,
      reason: order.reason_code,
      est_rebate_fen: 1234,
      expected_credit_period: null,
    },
    fallback_text: '订单状态请在卡片或订单页查看。',
  };
}

/** search_rules with a hit (tools/rules: rule_ref cards, trace.matched true). */
export function rulesHit(): ToolOutcome {
  const trace: ReplyTemplateTrace = { matched: true };
  return {
    kind: 'ok',
    modelView: { cards: [{ title: '<untrusted>提现规则</untrusted>' }] },
    cards: [ruleRefCard()],
    trace,
  };
}

/** search_rules without a hit (tools/rules: the handoff card, trace.matched false). */
export function rulesMiss(): ToolOutcome {
  const trace: ReplyTemplateTrace = { matched: false };
  return { kind: 'ok', modelView: {}, cards: [handoffCard()], trace };
}

/** An order tool's result (tools/orders: one order_status card per order, trace.orders). */
export function ordersFound(orders: readonly ReplyTemplateOrder[]): ToolOutcome {
  const trace: ReplyTemplateTrace = { orders: [...orders] };
  return {
    kind: 'ok',
    modelView: { orders: orders.map(() => ({ platform: 'jd', title: null })) },
    cards:
      orders.length === 0
        ? [handoffCard()]
        : orders.map((order, i) => orderStatusCard(order, i + 1)),
    trace,
  };
}

export function failedTool(): ToolOutcome {
  return { kind: 'failed', modelView: { error: 'tool_failed' } };
}

/** search_products with one product list (no template input). */
export function productsFound(): ToolOutcome {
  return {
    kind: 'ok',
    modelView: { items: [{ title: '<untrusted>合成保温杯</untrusted>' }] },
    cards: [list('synthetic-results-b3-08m', ['tb:synthetic-a', 'tb:synthetic-b'])],
  };
}

export type Answer = (ctx: ToolContext) => Promise<ToolOutcome>;

const REJECTED: ToolOutcome = { kind: 'rejected', modelView: { error: 'invalid_args' } };

function defaultAnswer(name: string): Answer | undefined {
  switch (name) {
    case 'search_products':
      return async () => productsFound();
    case 'search_rules':
      return async () => rulesHit();
    case 'list_my_orders':
      return async () => ordersFound([PAID, WAITING]);
    case 'explain_order':
      return async () => ordersFound([PAID]);
    default:
      return undefined;
  }
}

/** The tools this kit offers to the model on every run. */
export const OFFERED = ['search_products', 'search_rules', 'list_my_orders', 'explain_order'];

/** Offers OFFERED; each name answers with `answers[name]`, else the default above. */
export function templateTools(answers: Readonly<Record<string, Answer>> = {}) {
  const execute = vi.fn<OrchestratorTools['execute']>(async (call, ctx) => {
    const answer = answers[call.name] ?? defaultAnswer(call.name);
    return answer === undefined ? REJECTED : answer(ctx);
  });
  const tools: OrchestratorTools = {
    definitions: async () =>
      OFFERED.map((name) => ({
        name,
        description: `合成工具 ${name}`,
        parameters: { type: 'object', properties: {}, additionalProperties: true },
      })),
    execute,
    enabledSearchPlatforms: async () => [],
    searchKeyword: async () => ({ results: [], cards: [] }),
  };
  return { tools, execute };
}

// ---- one core body, many runs -----------------------------------------------------------------

export interface RunView {
  readonly runId: string;
  readonly result: RunBodyResult;
  /** Every ctx.text of the run, joined: what the user reads. */
  readonly text: string;
  readonly deltas: readonly string[];
  readonly frames: readonly CardFrame[];
  /** The trace the core recorded for this run (undefined when none). */
  readonly trace: OrchestratorTrace | undefined;
}

export interface Started {
  readonly runId: string;
  readonly controller: AbortController;
  readonly done: Promise<RunView>;
}

/**
 * One createAgentRunBody over syntheticBody (B3-05b limits, pass review, `固定文案:<key>` texts)
 * with the scripted model and the template tools; `patch` replaces any dependency (limits,
 * intents …). start / run begin one run of that same body.
 */
export function coreRig(options: {
  readonly scripts: Readonly<Record<string, readonly Step[]>>;
  readonly answers?: Readonly<Record<string, Answer>>;
  readonly patch?: Partial<AgentRunBodyDeps>;
}) {
  const complete = scriptedModels(options.scripts);
  const { tools, execute } = templateTools(options.answers);
  const traces: { readonly runId: string; readonly trace: OrchestratorTrace }[] = [];
  const deps = syntheticBody(tools, [], {
    model: { complete },
    trace: {
      record: (runId, trace) => {
        traces.push({ runId, trace });
      },
    },
    ...options.patch,
  });
  const body = createAgentRunBody(deps);

  function start(text: string, runId = `synthetic-run-${randomUUID()}`): Started {
    const out = receiptContext({ runId, sessionId: 'synthetic-session-b3-08m' });
    const input: RunBodyInput = { ...inputFor(APP_ID, text), runId };
    const before = traces.length;
    const done = body(input)(out.ctx).then((result): RunView => ({
      runId,
      result,
      text: out.texts.join(''),
      deltas: [...out.texts],
      frames: [...out.frames],
      trace: traces.slice(before).find((entry) => entry.runId === runId)?.trace,
    }));
    return { runId, controller: out.controller, done };
  }

  return {
    deps,
    complete,
    execute,
    traces,
    start,
    run: (text: string, runId?: string): Promise<RunView> => start(text, runId).done,
  };
}

export function typesOf(frames: readonly CardFrame[]): string[] {
  return frames.map((frame) => frame.type);
}

/** BR-AI-07 细则「T6 与其他」: the trace marks a replaced reply; never for a reply sent as is. */
export function expectReplaced(view: RunView, replaced: boolean): void {
  const flag = view.trace?.text_replaced_by_template;
  if (replaced) expect(flag, 'trace text_replaced_by_template').toBe(true);
  else expect(flag, 'trace text_replaced_by_template').not.toBe(true);
}

/** The user got exactly `expected` as text, and no piece of any model text. */
export function expectOnly(view: RunView, expected: string, modelTexts: readonly string[]): void {
  expect(view.text).toBe(expected);
  for (const piece of modelTexts) {
    expect(view.text, `model text ${piece}`).not.toContain(piece);
  }
}

export interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

export function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}
