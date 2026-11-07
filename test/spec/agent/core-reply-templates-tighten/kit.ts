// B3-08n rule-test kit (no database, no Nest, no listen) · BR-AI-07「本 run 调用过订单类工具
// （list_my_orders、explain_order）或 search_rules 时，模型生成的文本一律不下发，由服务端输出模板文本」.
// Tightens B3-08m's gate review follow-ups (S1-1, S1-2, S2-a, S2-b) at the rule level, through one
// createAgentRunBody over synthetic ports (../stream-model-prereq/kit.ts syntheticBody). Unlike
// ../core-reply-templates/kit.ts the scripted model here can send raw (unparseable) tool call
// arguments, and the template tools can be the real tools/rules and tools/orders handlers behind
// the real ToolRegistry. Existing kits are imported read-only and unchanged.
import { expect, vi } from 'vitest';
import type { RunBodyInput } from '../../../../apps/api/src/modules/agent/http/index.ts';
import { createAgentRunBody } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type {
  AgentRunBodyDeps,
  OrchestratorTools,
  OrchestratorTrace,
  ToolOutcome,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import {
  createExplainOrderHandler,
  createListMyOrdersHandler,
} from '../../../../apps/api/src/modules/agent/tools/orders/index.ts';
import { createToolRegistry } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import { createSearchRulesHandler } from '../../../../apps/api/src/modules/agent/tools/rules/index.ts';
import type { RunBodyResult } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { productsFound } from '../core-reply-templates/kit.ts';
import {
  inputFor,
  receiptContext,
  syntheticBody,
  type CardFrame,
} from '../stream-model-prereq/kit.ts';
import { fixture as ordersFixture } from '../tools-orders/kit.ts';
import { fixture as rulesFixture } from '../tools-rules/kit.ts';

export const APP_ID = 'synthetic-app-b3-08n';
export const QUESTION = '合成问题：提现最低多少，我的订单返了吗';

/** A tool round's lead-in (sentence end: the OutputGuard emits it at once). */
export const LEAD = '我先看看。';
/** The model's own conclusion; BR-AI-07: never reaches the user once a template tool ran. */
export const MODEL_TEXT = '提现最低10元，这笔订单已返利到账。';
/** Structured text (card JSON): an invalid model answer format. */
export const STRUCTURED = '{"type":"order_status","data":{"display_status":"PAID"}}';

/** What syntheticBody's texts port answers for a fixed key. */
export function fixed(key: string): string {
  return `固定文案:${key}`;
}

// ---- the scripted model (raw arguments allowed) ----------------------------------------------

type Complete = AgentRunBodyDeps['model']['complete'];
type Outcome = Awaited<ReturnType<Complete>>;
type ModelOk = Extract<Outcome, { kind: 'model' }>;
type ModelEvent = ModelOk['events'][number];
type DegradeReason = Extract<Outcome, { kind: 'degraded' }>['reason'];

export interface Call {
  readonly name: string;
  /** Serialized with JSON.stringify unless `raw` is given. */
  readonly args?: unknown;
  /** The exact arguments string the model sends (may be unparseable JSON). */
  readonly raw?: string;
}

export interface Step {
  readonly text?: string;
  readonly calls?: readonly Call[];
  /** The router degrades this round instead of answering. */
  readonly degraded?: DegradeReason;
}

/** model.complete answering the n-th round with steps[n]; afterwards an empty final round. */
export function scriptedModel(steps: readonly Step[]) {
  let rounds = 0;
  return vi.fn<Complete>(async () => {
    const step: Step = steps[rounds] ?? {};
    rounds += 1;
    if (step.degraded !== undefined) {
      const degraded: Outcome = { kind: 'degraded', reason: step.degraded, attempts: [] };
      return degraded;
    }
    const events: ModelEvent[] = [];
    if (step.text !== undefined && step.text !== '') {
      events.push({ t: 'text_delta', text: step.text });
    }
    (step.calls ?? []).forEach((call, index) => {
      events.push({
        t: 'tool_call',
        index,
        call: {
          id: `synthetic-call-${String(rounds)}-${String(index)}`,
          type: 'function',
          function: { name: call.name, arguments: call.raw ?? JSON.stringify(call.args ?? {}) },
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

// ---- tools ------------------------------------------------------------------------------------

/**
 * The real search_rules, list_my_orders and explain_order handlers behind the real ToolRegistry
 * (all switches on); `rules` / `orders` are the tools-rules / tools-orders kit fixtures to mock.
 */
export function realTemplateTools() {
  const rules = rulesFixture([]);
  const orders = ordersFixture();
  const registry = createToolRegistry({
    handlers: [
      createSearchRulesHandler(rules.deps),
      createListMyOrdersHandler(orders.deps),
      createExplainOrderHandler(orders.deps),
    ],
    switches: { get: async () => true },
    logger: { warn: vi.fn() },
  });
  const execute = vi.spyOn(registry, 'execute');
  return { tools: registry, execute, rules, orders };
}

/** Outcomes the registry's execute resolved to, in call order. */
export async function outcomesOf(
  execute: ReturnType<typeof realTemplateTools>['execute'],
): Promise<ToolOutcome[]> {
  return Promise.all(execute.mock.results.map((result) => result.value as Promise<ToolOutcome>));
}

/**
 * Synthetic tools offering `offered` (template tools among them or not); search_products answers
 * `products` (default: one product list), anything else is rejected.
 */
export function productTools(
  offered: readonly string[],
  products: () => ToolOutcome = productsFound,
) {
  const execute = vi.fn<OrchestratorTools['execute']>(async (call) =>
    call.name === 'search_products'
      ? products()
      : { kind: 'rejected', modelView: { error: 'invalid_args' } },
  );
  const tools: OrchestratorTools = {
    definitions: async () =>
      offered.map((name) => ({
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

export const TEMPLATE_OFFER = [
  'search_products',
  'search_rules',
  'list_my_orders',
  'explain_order',
];
export const PRODUCTS_ONLY = ['search_products'];

// ---- one run ----------------------------------------------------------------------------------

export interface RunView {
  readonly result: RunBodyResult;
  /** Every ctx.text of the run, joined: what the user reads. */
  readonly text: string;
  readonly frames: readonly CardFrame[];
  readonly trace: OrchestratorTrace | undefined;
}

/** One run of createAgentRunBody over syntheticBody with the scripted model; degraded.run spied. */
export function rig(options: {
  readonly steps: readonly Step[];
  readonly tools: OrchestratorTools;
  readonly patch?: Partial<AgentRunBodyDeps>;
}) {
  const complete = scriptedModel(options.steps);
  const degraded = vi.fn<AgentRunBodyDeps['degraded']['run']>(async () => ({
    kind: 'done',
    finishReason: 'fallback',
  }));
  const traces: OrchestratorTrace[] = [];
  const deps = syntheticBody(options.tools, [], {
    model: { complete },
    degraded: { run: degraded },
    trace: {
      record: (_runId, trace) => {
        traces.push(trace);
      },
    },
    ...options.patch,
  });
  const body = createAgentRunBody(deps);
  const runId = 'synthetic-run-b3-08n';
  // One run per rig: its context is made up front so a test can read the frames delivered so far.
  const out = receiptContext({ runId, sessionId: 'synthetic-session-b3-08n' });
  async function run(): Promise<RunView> {
    const input: RunBodyInput = { ...inputFor(APP_ID, QUESTION), runId };
    const result = await body(input)(out.ctx);
    return { result, text: out.texts.join(''), frames: [...out.frames], trace: traces[0] };
  }
  /** Frames written so far in this rig's run (live, in delivery order). */
  return { complete, degraded, run, delivered: out.frames as readonly CardFrame[] };
}

export function typesOf(frames: readonly CardFrame[]): string[] {
  return frames.map((frame) => frame.type);
}

/** The user got exactly `expected` as text, and no piece of any model text. */
export function expectOnly(view: RunView, expected: string, modelTexts: readonly string[]): void {
  expect(view.text).toBe(expected);
  for (const piece of modelTexts) {
    expect(view.text, `model text ${piece}`).not.toContain(piece);
  }
}

/** BR-AI-07 细则「T6 与其他」: the trace marks a replaced reply. */
export function expectReplaced(view: RunView, replaced: boolean): void {
  const flag = view.trace?.text_replaced_by_template;
  if (replaced) expect(flag, 'trace text_replaced_by_template').toBe(true);
  else expect(flag, 'trace text_replaced_by_template').not.toBe(true);
}
