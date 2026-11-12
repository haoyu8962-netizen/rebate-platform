// B3-05o rule-test kit (no database, no network, no listen) · BR-AI-01 细则「意图兜底与不空回复」,
// BR-AI-18 细则「比较与适用性的提示」, BR-AI-07 判定规则 7, BR-TEXT-22 {q_short}.
// The SUT is the production composition: createAgentStreamAssembly (real registry and handlers
// for search_products / list_my_orders / explain_order / search_rules / get_my_earnings /
// handoff_to_human, real intent port, result tools, memory result store, routed no-model path)
// under createStreamAgentBody (stream/mount/agent-body.ts). Only the data ports are synthetic:
// union search rows, the card assembler, orders' read queries, the by-number quota, rule chunks,
// wallet reads, configuration values, and a scripted model. The body is built on the first run,
// inside each it, so NotImplemented fails the test body, never collection. The 不空回复 counter is
// an observable double (emptyReplies.record) and the logger's levels are vi.fn (emptyReplyLogs).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import dictionary from '../../../../contracts/texts.default.json' with { type: 'json' };
import { bridge } from '../../../../packages/contracts-ts/src/index.ts';
import type { CatalogCardEntry } from '../../../../apps/api/src/modules/catalog/index.ts';
import type { ParsingOptions } from '../../../../apps/api/src/modules/parsing/index.ts';
import { extractCandidates } from '../../../../apps/api/src/modules/parsing/index.ts';
import {
  FixedClock,
  type RootLogger,
  type Scheduler,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  AgentCaller,
  RunBodyInput,
} from '../../../../apps/api/src/modules/agent/http/index.ts';
import { createRunModelClock } from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import type { ResolvedRoute } from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import type {
  AgentRunBodyDeps,
  InputCheckPort,
  OrchestratorTrace,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type {
  EmptyReplyCounter,
  EmptyReplyLogMessage,
} from '../../../../apps/api/src/modules/agent/orchestrator/core/intent-fallback.ts';
import { createMemoryResultSetStore } from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import { redactForModel } from '../../../../apps/api/src/modules/agent/preprocess/redact/index.ts';
import { createAgentStreamAssembly } from '../../../../apps/api/src/modules/agent/stream/mount/assembly.ts';
import { createStreamAgentBody } from '../../../../apps/api/src/modules/agent/stream/mount/agent-body.ts';
import type { AgentBodyAssembly } from '../../../../apps/api/src/modules/agent/stream/mount/body.ts';
import type {
  RunBodyResult,
  RunContext,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { numberCard } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import type { EarningsReads } from '../../../../apps/api/src/modules/agent/tools/earnings/index.ts';
import type { RuleChunkRow } from '../../../../apps/api/src/modules/agent/tools/rules/index.ts';
import type {
  AgentSearchCandidate,
  SearchProductsDeps,
} from '../../../../apps/api/src/modules/agent/tools/search/index.ts';
import { scriptedModels, type Step } from '../core-reply-templates/kit.ts';
import { candidate, card } from '../tools-search/kit.ts';
import { fixture as orderFixture, item } from '../tools-orders/kit.ts';

export type { Step } from '../core-reply-templates/kit.ts';

export const APP = 'synthetic-app';
/** UTC 2026-11-11 20:00 = +08:00 2026-11-12 04:00: the +08:00 calendar day differs from UTC's. */
export const NOW = '2026-11-11T20:00:00.000Z';
/** +08:00 today of NOW. */
export const TODAY = '2026-11-12';

export const MEMBER: Partial<AgentCaller> = { userId: 'synthetic-user', phoneBound: true };
export const GUEST: Partial<AgentCaller> = { userId: null, phoneBound: false };
export const UNBOUND: Partial<AgentCaller> = { userId: 'synthetic-user', phoneBound: false };

/** A tool name no registry knows (the core rejects it without execute; the call still counts). */
export const UNKNOWN_TOOL = 'synthetic_unknown_tool';

/** Production copy (contracts/texts.default.json); keys A9 has not registered yet fall back to
 * the defaults of pinned 08 BR-TEXT-22. */
const pendingTexts: Readonly<Record<string, string>> = {
  'agent.reply.empty': '没太听明白。可以说说想买什么，或者把商品链接发给我。',
  'agent.suggest.empty.1': '帮我找蓝牙耳机',
  'agent.suggest.empty.2': '查一下我的订单',
  'agent.suggest.empty.3': '怎么联系客服',
  'agent.notice.title_based': '以上只根据商品标题判断，具体以商品详情为准。',
};

export function copy(key: string): string {
  return (dictionary.texts as Readonly<Record<string, string>>)[key] ?? pendingTexts[key] ?? key;
}

export interface SuggestionItem {
  readonly text: string;
  readonly send_text: string;
}

function chip(text: string): SuggestionItem {
  return { text, send_text: text };
}

/** agent.suggest.empty.1–3, as quick questions (text = send_text). */
export function emptyShortcuts(): SuggestionItem[] {
  return [1, 2, 3].map((n) => chip(copy(`agent.suggest.empty.${n}`)));
}

/** agent.suggest.no_result.1–3 with {q_short} = `qShort`; null leaves the second one out. */
export function noResultSuggestions(qShort: string | null): SuggestionItem[] {
  const first = chip(copy('agent.suggest.no_result.1'));
  const third = chip(copy('agent.suggest.no_result.3'));
  if (qShort === null) return [first, third];
  return [first, chip(copy('agent.suggest.no_result.2').replace('{q_short}', qShort)), third];
}

/** The model's final-round intent object, as the model writes it. */
export function intent(name: string, extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({ agent_intent: name, ...extra });
}

type CardFrame = ReturnType<typeof numberCard>['card'];

export type Event =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'card'; readonly card: CardFrame }
  | { readonly kind: 'status'; readonly tool: string; readonly phase: string }
  | { readonly kind: 'suggestions'; readonly items: readonly SuggestionItem[] };

export interface RunView {
  readonly runId: string;
  readonly result: RunBodyResult;
  readonly events: readonly Event[];
  /** Every text frame of the run, joined: what the user reads. */
  readonly text: string;
  readonly cards: readonly CardFrame[];
  readonly suggestions: readonly (readonly SuggestionItem[])[];
  readonly trace: OrchestratorTrace | undefined;
}

export interface RunOptions {
  readonly caller?: Partial<AgentCaller>;
  readonly sessionId?: string;
  readonly controller?: AbortController;
}

/** A handle the assembly may keep; any query fails (the intent port's 承接 read logs and gives null). */
function inertDb(): Kysely<DB> {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('synthetic db is not used');
      },
    },
  ) as Kysely<DB>;
}

/** The message of the 不空回复 log line, as the skeleton declares it. */
export const EMPTY_REPLY_LOG: EmptyReplyLogMessage = 'agent_reply_empty';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

/** Every logger call (any level) whose message, or whose fields' `event`, is `message`. */
function loggedWith(logger: RootLogger, message: string): unknown[][] {
  const levels = logger as unknown as Record<string, { mock: { calls: unknown[][] } }>;
  return LOG_LEVELS.flatMap((level) =>
    (levels[level]?.mock.calls ?? []).filter((args) =>
      args.some(
        (arg) =>
          arg === message ||
          (typeof arg === 'object' &&
            arg !== null &&
            (arg as Record<string, unknown>)['event'] === message),
      ),
    ),
  );
}

function syntheticLogger(): RootLogger {
  const logger: Record<string, unknown> = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };
  logger['child'] = () => logger;
  return logger as unknown as RootLogger;
}

const TOOLS = [
  'search_products',
  'get_rebate_quote',
  'handoff_to_human',
  'prefill_claim',
  'list_my_orders',
  'explain_order',
  'search_rules',
  'get_my_earnings',
];

/** A borrowed candidate (tools-search/kit.ts, quoted on that suite's clock) re-quoted at this
 * suite's NOW: the search handler drops quotes older than agent.search_cache_ttl_s (≤ 300 s). */
function fresh(row: AgentSearchCandidate): AgentSearchCandidate {
  return {
    ...row,
    item: { ...row.item, quoted_at: NOW },
    ref: { ...row.ref, rawFetchedAt: NOW, receivedAt: NOW },
  };
}

export function kit() {
  const clock = new FixedClock(NOW);
  const settings = new Map<string, boolean | number>([
    ['search.enabled.taobao', true],
    ['search.enabled.jd', true],
    ['search.enabled.pdd', true],
    ['agent.page_guide.enabled', true],
    ...TOOLS.map((name): [string, boolean] => [`agent.tools.${name}.enabled`, true]),
  ]);
  const state = {
    rows: [
      candidate('tb:synthetic-cup'),
      candidate('jd:synthetic-cup', 1000, 'jd'),
      candidate('pdd:synthetic-cup', 1000, 'pdd'),
    ] as AgentSearchCandidate[],
    review: 'pass' as Awaited<ReturnType<AgentRunBodyDeps['review']['review']>>,
  };
  const searchProducts = vi.fn<SearchProductsDeps['searchProducts']>(async (query) =>
    state.rows.filter((row) => row.item.platform === query.platform).map(fresh),
  );
  const assemble = vi.fn<CatalogCardEntry['assemble']>(async (input) => {
    const row = state.rows.find((r) => r.ref.productKey === input.ref.productKey)!;
    const full = card(fresh(row));
    if (input.deferLink !== true) return { kind: 'card', card: full };
    const { link_id, ...unlinked } = full;
    void link_id;
    return { kind: 'prepared', card: unlinked, commit: async () => full };
  });

  const orders = orderFixture();
  orders.searchForAgent.mockResolvedValue({
    orders: [
      item(),
      item({ order_id: '0192f3a1-7c00-7000-8000-00000000a002', title: '合成燕麦片' }),
    ],
    total: 2,
  });
  const chunks = vi.fn(async (): Promise<readonly RuleChunkRow[]> => [
    {
      chunk_id: 'synthetic-chunk',
      article_id: 'synthetic-article',
      published_version: 1,
      title: '返利结算规则',
      text: '合成规则：返利一般在确认收货后随联盟月度结算。',
    },
  ]);
  const readEarnings = vi.fn<EarningsReads['read']>(async () => ({
    wallet: {
      available_fen: 1234,
      withdrawable_fen: 1234,
      negative_fen: 0,
      frozen_fen: 0,
      estimated_total_fen: 5678,
      estimated_fen: 5678,
      pending_credit_fen: 0,
      pending_credit_paused_fen: 0,
      next_credit_period: null,
      credit_overdue: false,
      withdrawn_fen: 0,
      risk_paused_reason: null,
      withdraw_enabled: true,
    },
    latestWithdrawal: null,
  }));
  const text = vi.fn(async (_app: string, key: string) => copy(key));
  const texts = { text, toolDisplay: async () => '合成工具状态' };
  const store = createMemoryResultSetStore();
  const logger = syntheticLogger();
  const emptyReplies = { record: vi.fn<EmptyReplyCounter['record']>() };

  const scripts: Record<string, readonly Step[]> = {};
  const complete = scriptedModels(scripts);
  const review = vi.fn<AgentRunBodyDeps['review']['review']>(async () => state.review);
  const traces: { readonly runId: string; readonly trace: OrchestratorTrace }[] = [];
  const inputCheck: InputCheckPort = {
    async check(input) {
      const redacted = redactForModel(input.text);
      return {
        kind: 'proceed',
        modelText: redacted.text,
        placeholders: redacted.placeholders,
        links: extractCandidates(input.text),
        notices: [],
        untrustedInput: false,
        paramsRequested: false,
      };
    },
  };
  const defaultSession = `synthetic-session-${randomUUID()}`;
  const nextCard = new Map<string, number>();
  let built: AgentBodyAssembly | undefined;

  function body(): AgentBodyAssembly {
    built ??= createStreamAgentBody({
      business: createAgentStreamAssembly({
        db: inertDb(),
        clock,
        logger,
        scheduler: {} as Scheduler,
        config: {
          configValue: async (_app, key) => {
            const value = settings.get(key);
            return value === undefined ? null : { value, version: 1 };
          },
        },
        texts,
        routes: {
          configured: async () => ['Wallet', 'WithdrawRecords', 'OrderList'],
          contract: () => bridge.routes,
        },
        results: store,
        ports: {
          search: {
            platforms: ['taobao', 'jd', 'pdd'],
            searchProducts,
            prohibited: async () => false,
            categoryAllowed: async () => true,
          },
          readProduct: async () => {
            throw new Error('synthetic readProduct is not used');
          },
          parsing: {} as ParsingOptions,
          cards: () => ({ assemble }),
          orders: {
            orders: orders.deps.orders,
            claimEntries: { read: orders.read },
            refs: { resolve: orders.resolve },
            quota: { take: orders.take },
          },
          rules: { activeChunks: chunks, config: async () => 0 },
          earnings: { read: readEarnings },
        },
      }),
      model: { complete },
      modelClock: () => createRunModelClock(60_000),
      prompt: { current: async () => ({ version: 'synthetic-v1', system: '合成系统前缀' }) },
      inputCheck,
      review: { review },
      trace: {
        record: (runId, trace) => {
          traces.push({ runId, trace });
        },
      },
      route: async (): Promise<ResolvedRoute> => ({ mode: 'no_model', attempts: [], dropped: [] }),
      errorMsg: async (_app, code) => `合成错误:${String(code)}`,
      logger,
      emptyReplies,
    });
    return built;
  }

  function inputOf(question: string, options: RunOptions, runId: string): RunBodyInput {
    const redacted = redactForModel(question);
    return {
      caller: {
        appId: APP,
        traceId: 'synthetic-trace',
        deviceId: 'synthetic-device',
        deviceHash: 'synthetic-hash',
        ipKey: 'synthetic-ip-key',
        userId: 'synthetic-user',
        phoneBound: true,
        ...options.caller,
      },
      sessionId: options.sessionId ?? defaultSession,
      runId,
      userMessageId: `synthetic-user-message-${runId}`,
      assistantMessageId: `synthetic-assistant-message-${runId}`,
      text: question,
      redactedText: redacted.text,
      limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
    };
  }

  return {
    clock,
    settings,
    state,
    searchProducts,
    orders,
    chunks,
    readEarnings,
    text,
    store,
    complete,
    review,
    traces,
    logger,
    emptyReplies,
    /** The 不空回复 log lines written so far (all runs of this kit). */
    emptyReplyLogs: (): unknown[][] => loggedWith(logger, EMPTY_REPLY_LOG),
    defaultSession,
    /** The scripted model's rounds for the run whose user text is `question` (keyed by the
     * redacted model text, as the model receives it). */
    say(question: string, steps: readonly Step[]): void {
      scripts[redactForModel(question).text] = steps;
    },
    async run(question: string, options: RunOptions = {}): Promise<RunView> {
      const runId = `synthetic-run-${randomUUID()}`;
      const input = inputOf(question, options, runId);
      const controller = options.controller ?? new AbortController();
      const events: Event[] = [];
      const ctx: RunContext = {
        runId,
        sessionId: input.sessionId,
        signal: controller.signal,
        get cardsDelivered() {
          return events.filter((e) => e.kind === 'card').length;
        },
        text: (delta) => {
          events.push({ kind: 'text', text: delta });
        },
        toolStatus: (tool, phase) => {
          events.push({ kind: 'status', tool, phase });
        },
        card: async (unnumbered, delivered) => {
          const first = nextCard.get(input.sessionId) ?? 1;
          const numbered = numberCard(unnumbered, first);
          nextCard.set(input.sessionId, first + numbered.used);
          events.push({ kind: 'card', card: numbered.card });
          delivered?.(numbered.card.card_id);
        },
        suggestions: (items) => {
          events.push({ kind: 'suggestions', items: [...items] });
        },
      };
      const result = await body().body(input)(ctx);
      return {
        runId,
        result,
        events,
        text: events.flatMap((e) => (e.kind === 'text' ? [e.text] : [])).join(''),
        cards: events.flatMap((e) => (e.kind === 'card' ? [e.card] : [])),
        suggestions: events.flatMap((e) => (e.kind === 'suggestions' ? [e.items] : [])),
        trace: traces.find((entry) => entry.runId === runId)?.trace,
      };
    },
  };
}

export type Kit = ReturnType<typeof kit>;

export function done(view: RunView, reason = 'stop'): void {
  expect(view.result).toEqual({ kind: 'done', finishReason: reason });
}

export function typesOf(view: RunView): string[] {
  return view.cards.map((c) => c.type);
}

/** Content frames only (no tool.status), in order. */
export function content(view: RunView): Event[] {
  return view.events.filter((e) => e.kind !== 'status');
}

/** The trace entries of `name`, in call order. */
export function tracedCalls(view: RunView, name: string) {
  return (view.trace?.tool_calls ?? []).filter((call) => call.name === name);
}

/** BR-AI-01 不空回复: agent.reply.empty, then the three quick questions; nothing else. */
export function expectEmptyReply(view: RunView, reason: 'stop' | 'limit'): void {
  done(view, reason);
  expect(view.cards).toEqual([]);
  expect(view.text.trim()).toBe(copy('agent.reply.empty'));
  expect(view.suggestions).toEqual([emptyShortcuts()]);
  // The quick questions follow the text.
  expect(content(view).at(-1)).toEqual({ kind: 'suggestions', items: emptyShortcuts() });
}

/** Nothing of the 不空回复 fallback went out. */
export function expectNoEmptyReply(view: RunView): void {
  expect(view.text).not.toContain(copy('agent.reply.empty'));
  expect(view.suggestions).not.toContainEqual(emptyShortcuts());
}

export function titleNotices(view: RunView): CardFrame[] {
  return view.cards.filter(
    (c) => c.type === 'notice' && c.data['text_key'] === 'agent.notice.title_based',
  );
}

/** One model round with only `text` (the run's final round). */
export function says(text: string): Step {
  return { text };
}

/** One model round asking for `count` calls of a tool no registry knows. */
export function unknownCalls(count: number): Step {
  return { calls: Array.from({ length: count }, () => ({ name: UNKNOWN_TOOL, args: {} })) };
}
