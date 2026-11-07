// B3-08p rule-test kit (no database, no Nest) · FU-AGENT-RUN-CACHED-TEXT (D10-888 (b2)), on top of
// B3-08m's BR-AI-07「本 run 调用过订单类工具或 search_rules 时，模型生成的文本一律不下发，由服务端输出
// 模板文本」(contract: apps/api/src/modules/agent/orchestrator/core/reply-templates.ts).
//
// What the rule tests of this directory pin (orchestrator/core only; the RunManager is unchanged):
//   · A run whose offered tools include a template tool holds its model text (B3-08m). When such a
//     run made no template call, the held text is released at the points where the run is certain
//     to end: before it reaches an output cap (a card that does not fit, or one that reaches the cap
//     exactly), and before a later round's provider refusal (agent.refuse.unsafe, done safety). The
//     user then gets the same text, in the same order, as a run without template tools offered.
//   · 请求即算: a round that asks for a template tool counts as a template call even when that call
//     is never executed (tool call budget spent, or the card cap reached by an earlier call of the
//     round). That round's and earlier rounds' held text is not delivered; the run writes the
//     template fallback of B3-08m's key selection (no order entries → order_list.empty, rules
//     without a hit → agent.rule.not_found) and ends with the end it has (done limit).
//   · Unchanged: a run without template tools offered (frame by frame); a run with a template call
//     that is refused (only agent.refuse.unsafe); cancellation and the run time limit (the signal
//     is aborted: the held text is dropped, BR-AI-14「缓冲中未下发的模型文本丢弃」).
//
// One rig is one core body (createAgentRunBody over ../stream-model-prereq/kit.ts syntheticBody)
// for exactly one run. Its run context numbers cards as the RunManager does and logs every write
// (text, card, tool.status, suggestions) in one sequence, also writes attempted after an abort.
// Existing kits are imported unchanged.
import { randomUUID } from 'node:crypto';
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
  numberCard,
  type RunBodyResult,
  type RunContext,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { PAID, fixed, ordersFound, rulesHit } from '../core-reply-templates/kit.ts';
import { inputFor, list, syntheticBody } from '../stream-model-prereq/kit.ts';

export { fixed };

export const APP_ID = 'synthetic-app-b3-08p';
const SESSION_ID = 'synthetic-session-b3-08p';

/** A tool round's lead-in (one sentence, leaves the OutputGuard at once). */
export const LEAD = '我先看看。';
/** A later tool round's text (the second and last sentence the guard lets through). */
export const NEXT = '再看看别的。';
export const UNSAFE = fixed('agent.refuse.unsafe');

/** Offered tools of a holding run: search_products plus the template tools. */
export const TEMPLATE_OFFER: readonly string[] = [
  'search_products',
  'search_rules',
  'list_my_orders',
  'explain_order',
];
/** Offered tools of a run that never holds (no template tool). */
export const PLAIN_OFFER: readonly string[] = ['search_products'];

export type Limits = AgentRunBodyDeps['limits'];
/** syntheticBody's B3-05b limits (02 §9.1–9.2). */
export const LIMITS: Limits = {
  toolCalls: 4,
  modelRounds: 3,
  textCodePoints: 20_000,
  cards: 12,
  contentFrames: 400,
};

export const LIMIT = { kind: 'done', finishReason: 'limit' } as const;
export const SAFETY = { kind: 'done', finishReason: 'safety' } as const;
export const STOP = { kind: 'done', finishReason: 'stop' } as const;

// ---- the scripted model -----------------------------------------------------------------------

type Complete = AgentRunBodyDeps['model']['complete'];
type Outcome = Awaited<ReturnType<Complete>>;
type ModelOk = Extract<Outcome, { kind: 'model' }>;
type ModelEvent = ModelOk['events'][number];

/** One model round. */
export interface Step {
  /** One text delta per element (a string is one delta); absent means no text. */
  readonly text?: string | readonly string[];
  /** Tool names asked for in this round, in order (arguments `{}`). */
  readonly calls?: readonly string[];
  /** The provider refuses this round (content_refused). */
  readonly refused?: boolean;
}

/** model.complete answering the steps in order; an empty final round once they run out. */
function scripted(steps: readonly Step[]) {
  let index = 0;
  return vi.fn<Complete>(async () => {
    const round = index;
    index += 1;
    const step: Step = steps[round] ?? {};
    if (step.refused === true) {
      const refused: Outcome = { kind: 'refused', entryId: 'synthetic-entry', attempts: [] };
      return refused;
    }
    const deltas = typeof step.text === 'string' ? [step.text] : (step.text ?? []);
    const events: ModelEvent[] = [];
    for (const text of deltas) {
      if (text !== '') events.push({ t: 'text_delta', text });
    }
    (step.calls ?? []).forEach((name, position) => {
      events.push({
        t: 'tool_call',
        index: position,
        call: {
          id: `synthetic-call-${String(round + 1)}-${String(position)}`,
          type: 'function',
          function: { name, arguments: '{}' },
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

/** search_products with one product_list of `count` items (1 + count cards toward the cap). */
export function products(count: number, tag: string): ToolOutcome {
  const keys = Array.from({ length: count }, (_, i) => `tb:synthetic-${tag}-${String(i)}`);
  return {
    kind: 'ok',
    modelView: { items: keys.map(() => ({ title: '<untrusted>合成商品</untrusted>' })) },
    cards: [list(`synthetic-results-b3-08p-${tag}`, keys)],
  };
}

const REJECTED: ToolOutcome = { kind: 'rejected', modelView: { error: 'invalid_args' } };

function defaultOutcome(name: string): ToolOutcome {
  switch (name) {
    case 'search_products':
      return products(1, 'default');
    case 'search_rules':
      return rulesHit();
    case 'list_my_orders':
    case 'explain_order':
      return ordersFound([PAID]);
    default:
      return REJECTED;
  }
}

// ---- the run context --------------------------------------------------------------------------

/** A RunManager-like context logging every write in order (also writes after an abort). */
function logContext(runId: string, controller: AbortController) {
  const log: string[] = [];
  const texts: string[] = [];
  const cardTypes: string[] = [];
  let next = 1;
  const ctx: RunContext = {
    runId,
    sessionId: SESSION_ID,
    signal: controller.signal,
    get cardsDelivered() {
      return cardTypes.filter((type) => type !== 'notice').length;
    },
    text: (delta) => {
      texts.push(delta);
      log.push(`text:${delta}`);
    },
    toolStatus: (tool, phase) => {
      log.push(`status:${tool}:${phase}`);
    },
    card: async (card, delivered) => {
      const numbered = numberCard(card, next);
      next += numbered.used;
      cardTypes.push(numbered.card.type);
      log.push(`card:${numbered.card.type}:${numbered.card.card_id}`);
      delivered?.(numbered.card.card_id);
    },
    suggestions: (items) => {
      log.push(`suggestions:${String(items.length)}`);
    },
  };
  return { ctx, log, texts, cardTypes, cardsUsed: () => next - 1 };
}

export interface RunView {
  readonly result: RunBodyResult;
  /** Every write in order: `text:<delta>`, `card:<type>:<card_id>`, `status:<tool>:<phase>`, `suggestions:<n>`. */
  readonly log: readonly string[];
  readonly deltas: readonly string[];
  /** Every ctx.text joined: what the user reads. */
  readonly text: string;
  readonly cardTypes: readonly string[];
  /** Card numbers used: frames plus embedded products (the cards cap counts both). */
  readonly cardsUsed: number;
  /** text + card + suggestions frames (tool.status excluded), as the contentFrames cap counts. */
  readonly contentFrames: number;
  readonly trace: OrchestratorTrace | undefined;
}

export interface RigOptions {
  readonly offered: readonly string[];
  readonly steps: readonly Step[];
  /** The n-th call of a tool gets answers[name][n]; else a default answer per tool. */
  readonly answers?: Readonly<Record<string, readonly ToolOutcome[]>>;
  readonly limits?: Partial<Limits>;
  /** Called when a tool starts executing (before it answers), with the run's controller. */
  readonly onExecute?: (name: string, controller: AbortController) => void;
}

/** One core body for exactly one run (the model script is not shared between runs). */
export function rig(options: RigOptions) {
  const complete = scripted(options.steps);
  const controller = new AbortController();
  const used = new Map<string, number>();
  const execute = vi.fn<OrchestratorTools['execute']>(async (call) => {
    const n = used.get(call.name) ?? 0;
    used.set(call.name, n + 1);
    options.onExecute?.(call.name, controller);
    return options.answers?.[call.name]?.[n] ?? defaultOutcome(call.name);
  });
  const tools: OrchestratorTools = {
    definitions: async () =>
      options.offered.map((name) => ({
        name,
        description: `合成工具 ${name}`,
        parameters: { type: 'object', properties: {}, additionalProperties: true },
      })),
    execute,
    enabledSearchPlatforms: async () => [],
    searchKeyword: async () => ({ results: [], cards: [] }),
  };
  const traces: OrchestratorTrace[] = [];
  const limits: Limits = { ...LIMITS, ...options.limits };
  const deps = syntheticBody(tools, [], {
    model: { complete },
    trace: {
      record: (_runId, trace) => {
        traces.push(trace);
      },
    },
    limits,
  });
  const body = createAgentRunBody(deps);

  async function run(): Promise<RunView> {
    const runId = `synthetic-run-b3-08p-${randomUUID()}`;
    const out = logContext(runId, controller);
    const input: RunBodyInput = { ...inputFor(APP_ID, '合成问题'), runId };
    const result = await body(input)(out.ctx);
    return {
      result,
      log: [...out.log],
      deltas: [...out.texts],
      text: out.texts.join(''),
      cardTypes: [...out.cardTypes],
      cardsUsed: out.cardsUsed(),
      contentFrames: out.log.filter((entry) => !entry.startsWith('status:')).length,
      trace: traces[0],
    };
  }

  return { deps, complete, execute, limits, run };
}

/** Tool names the core executed, in order. */
export function executed(x: ReturnType<typeof rig>): string[] {
  return x.execute.mock.calls.map(([call]) => call.name);
}

/** The card entries of the log (type and card_id), in order. */
export function cardsOf(view: RunView): string[] {
  return view.log.filter((entry) => entry.startsWith('card:'));
}

/** 02 §9.2「输出上限」: cards (frames plus embedded products) and content frames within the caps. */
export function expectWithinCaps(view: RunView, limits: Limits): void {
  expect(view.cardsUsed, 'cards incl. embedded products').toBeLessThanOrEqual(limits.cards);
  expect(view.contentFrames, 'content frames').toBeLessThanOrEqual(limits.contentFrames);
}

/** BR-AI-07 细则「T6 与其他」: the trace marks a replaced reply; never for a reply sent as is. */
export function expectReplaced(view: RunView, replaced: boolean): void {
  const flag = view.trace?.text_replaced_by_template;
  if (replaced) expect(flag, 'trace text_replaced_by_template').toBe(true);
  else expect(flag, 'trace text_replaced_by_template').not.toBe(true);
}

/** No piece of any model text reached the user. */
export function expectNoModelText(view: RunView, pieces: readonly string[]): void {
  for (const piece of pieces) expect(view.text, `model text ${piece}`).not.toContain(piece);
}
