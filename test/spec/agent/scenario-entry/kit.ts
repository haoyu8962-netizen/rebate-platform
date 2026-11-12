// B3-05q rule-test kit (no database, no network, no listen) · BR-AI-01 细则「情境入口」, BR-AI-05,
// BR-AI-07, BR-AI-15 细则 (入口报价因服务端原因失败).
// The SUT is the production composition, as in ../intent-fallback/kit.ts: createAgentStreamAssembly
// (real registry and handlers, real deterministic link path, real intent port, result tools, memory
// result store, routed no-model path) under createStreamAgentBody. Only data ports are synthetic:
// union search rows, catalog's readProduct, the card assembler, a governed union adapter behind the
// real parsing.parseUrl / parseToken (so a link or a token in the message resolves to LINK_KEY),
// orders' read queries, rule chunks, wallet reads, configuration, the input check and a scripted
// model. A run carries the message's `context` in RunBodyInput exactly as the HTTP layer hands it
// over. The body is built on the first run, inside each it, so a failure lands in the test body.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { vi } from 'vitest';
import dictionary from '../../../../contracts/texts.default.json' with { type: 'json' };
import { bridge } from '../../../../packages/contracts-ts/src/index.ts';
import type { CatalogCardEntry } from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  OFF_SHELF,
  ParsingError,
  extractCandidates,
  type ParsingOptions,
} from '../../../../apps/api/src/modules/parsing/index.ts';
import {
  FixedClock,
  type RootLogger,
  type Scheduler,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
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
import type { EmptyReplyCounter } from '../../../../apps/api/src/modules/agent/orchestrator/core/intent-fallback.ts';
import { createMemoryResultSetStore } from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import { redactForModel } from '../../../../apps/api/src/modules/agent/preprocess/redact/index.ts';
import {
  createAgentStreamAssembly,
  type AgentStreamBusinessPorts,
} from '../../../../apps/api/src/modules/agent/stream/mount/assembly.ts';
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
import { candidate, card, type Platform } from '../tools-search/kit.ts';
import { fixture as orderFixture } from '../tools-orders/kit.ts';

export type { Step } from '../core-reply-templates/kit.ts';

export const APP = 'synthetic-app';
/** UTC 2026-11-11 20:00 = +08:00 2026-11-12 04:00. */
export const NOW = '2026-11-11T20:00:00.000Z';

export const MEMBER: Partial<AgentCaller> = { userId: 'synthetic-user', phoneBound: true };
export const GUEST: Partial<AgentCaller> = { userId: null, phoneBound: false };
export const UNBOUND: Partial<AgentCaller> = { userId: 'synthetic-user', phoneBound: false };

/** The product of the 商品详情「问问 AI」entry (a taobao product, in the synthetic catalog). */
export const ENTRY_KEY = 'tb:synthetic-entry';
/** A well-formed key the catalog no longer has (delisted: a business answer, not a server fault). */
export const MISSING_KEY = 'tb:synthetic-delisted';
/** The product a link or a token in the message itself resolves to. */
export const LINK_KEY = 'tb:synthetic-link';
export const LINK = 'https://demo.invalid/taobao/synthetic-link';
export const TOKEN = '￥Synthetic01￥';

/** Order ids of the 订单详情「问问 AI」entry. */
export const OWN_ORDER = '0192f3a1-7c00-7000-8000-0000000e0001';
export const OTHERS_ORDER = '0192f3a1-7c00-7000-8000-0000000e0002';
export const MISSING_ORDER = '0192f3a1-7c00-7000-8000-0000000e0003';

/** Production copy (contracts/texts.default.json); a key it lacks reads as the key itself. */
export function copy(key: string): string {
  return (dictionary.texts as Readonly<Record<string, string>>)[key] ?? key;
}

/** The model's final-round intent object, as the model writes it. */
export function intent(name: string, extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({ agent_intent: name, ...extra });
}

/** One model round with only `text`. */
export function says(text: string): Step {
  return { text };
}

function product(key: string, platform: Platform, title: string): AgentSearchCandidate {
  const base = candidate(key, 1000, platform);
  return { ...base, item: { ...base.item, title }, ref: { ...base.ref, title } };
}

const ENTRY_ROW = product(ENTRY_KEY, 'taobao', '合成入口保温杯');
const LINK_ROW = product(LINK_KEY, 'taobao', '合成链接台灯');
const LINK_ITEM_ID = 'synthetic-link';

/** Re-quoted at this suite's NOW (the borrowed rows are quoted on another clock). */
function fresh(row: AgentSearchCandidate): AgentSearchCandidate {
  return {
    ...row,
    item: { ...row.item, quoted_at: NOW },
    ref: { ...row.ref, rawFetchedAt: NOW, receivedAt: NOW },
  };
}

type CardFrame = ReturnType<typeof numberCard>['card'];
type DoneReason = Extract<RunBodyResult, { kind: 'done' }>['finishReason'];

export interface SuggestionItem {
  readonly text: string;
  readonly send_text: string;
}

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
  /** The message's `context` (04 §6.5), handed to the run as the HTTP layer does. */
  readonly context?: Readonly<Record<string, unknown>>;
}

/** A handle the assembly may keep; any query fails (reads that need it log and give null). */
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

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

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
    /** Union search rows (keyword search and the model's search_products). */
    rows: [
      product('tb:synthetic-tissue', 'taobao', '合成纸巾 淘宝款'),
      product('jd:synthetic-tissue', 'jd', '合成纸巾 京东款'),
      product('pdd:synthetic-tissue', 'pdd', '合成纸巾 拼多多款'),
    ] as AgentSearchCandidate[],
    /** What catalog's fresh lookup knows by product_key. */
    catalog: [ENTRY_ROW] as AgentSearchCandidate[],
    /** When set, catalog's lookup rejects with it (an upstream timeout: a server-side reason). */
    quoteFailure: null as Error | null,
    /** No prompt for this app: the run goes the no-model way (BR-AI-14 无模型降级). */
    noModel: false,
    /** When set, the input check refuses (输入审核 / 拒答预判 / 禁售, 判定顺序第 1 步). */
    refusal: null as null | { readonly textKey: string; readonly finishReason: DoneReason },
  };

  const searchProducts = vi.fn<SearchProductsDeps['searchProducts']>(async (query) =>
    state.rows.filter((row) => row.item.platform === query.platform).map(fresh),
  );
  const readProduct = vi.fn<AgentStreamBusinessPorts['readProduct']>(async (productKey) => {
    if (state.quoteFailure !== null) throw state.quoteFailure;
    const row = state.catalog.find((r) => r.ref.productKey === productKey);
    if (row === undefined) throw new ParsingError(OFF_SHELF, 'synthetic: not in the catalog');
    return fresh(row);
  });
  const known = (): AgentSearchCandidate[] => [...state.rows, ...state.catalog, LINK_ROW];
  const assemble = vi.fn<CatalogCardEntry['assemble']>(async (input) => {
    const rows = known();
    const row =
      rows.find((r) => r.ref.productKey === input.ref.productKey) ??
      rows.find((r) => r.item.title === input.item.title);
    if (row === undefined) throw new Error('synthetic: unknown product');
    const full = card(fresh(row));
    if (input.deferLink !== true) return { kind: 'card', card: full };
    const { link_id, ...unlinked } = full;
    void link_id;
    return { kind: 'prepared', card: unlinked, commit: async () => full };
  });
  const cards = vi.fn<AgentStreamBusinessPorts['cards']>(() => ({ assemble }));

  // The governed union adapter behind the real parseUrl / parseToken: any link or token resolves
  // to LINK_ROW.
  const resolveLink = vi.fn<UnionAdapter['resolveLink']>(async () => ({
    item: { platform: 'taobao', item_id: LINK_ITEM_ID },
  }));
  const getItem = vi.fn<UnionAdapter['getItem']>(async () => ({
    ...LINK_ROW.item,
    item_id: LINK_ITEM_ID,
    quoted_at: NOW,
  }));
  const parsing: ParsingOptions = {
    config: { configValue: async () => null },
    clock,
    catalog: {
      listPlatforms: async () => [
        {
          code: 'taobao',
          key_prefix: 'tb',
          key_stability: 'unverified',
          search_support: 'full',
          convert_support: 'full',
          order_sync_support: 'full',
          stage: 'demo',
        },
      ],
      resolveProductKey: async (key) => key,
    },
    cards: {
      assemble: async () => {
        throw new Error('parse must not register cards');
      },
    },
    getGovernedAdapter: () => ({ resolveLink, getItem }),
    linkPatterns: {
      version: 'synthetic',
      rules: [
        {
          platform: 'taobao',
          category: 'product',
          hosts: ['demo.invalid'],
          path_patterns: ['/taobao/*'],
        },
      ],
    },
  };

  const orders = orderFixture();
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
  const review = vi.fn<AgentRunBodyDeps['review']['review']>(async () => 'pass');
  const traces: { readonly runId: string; readonly trace: OrchestratorTrace }[] = [];
  const check = vi.fn<InputCheckPort['check']>(async (input) => {
    const refusal = state.refusal;
    if (refusal !== null) {
      return { kind: 'refuse', textKey: refusal.textKey, finishReason: refusal.finishReason };
    }
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
  });
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
          readProduct,
          parsing,
          cards,
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
      prompt: {
        current: async () =>
          state.noModel ? null : { version: 'synthetic-v1', system: '合成系统前缀' },
      },
      inputCheck: { check },
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

  function inputOf(question: string, options: RunOptions): RunBodyInput {
    const runId = `synthetic-run-${randomUUID()}`;
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
      ...(options.context === undefined ? {} : { context: options.context }),
      limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
    };
  }

  async function runInput(input: RunBodyInput): Promise<RunView> {
    const controller = new AbortController();
    const events: Event[] = [];
    const ctx: RunContext = {
      runId: input.runId,
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
      runId: input.runId,
      result,
      events,
      text: events.flatMap((e) => (e.kind === 'text' ? [e.text] : [])).join(''),
      cards: events.flatMap((e) => (e.kind === 'card' ? [e.card] : [])),
      suggestions: events.flatMap((e) => (e.kind === 'suggestions' ? [e.items] : [])),
      trace: traces.find((entry) => entry.runId === input.runId)?.trace,
    };
  }

  /** Everything the data ports, the model, the review and the logger received (all runs). */
  function received(): unknown[] {
    const levels = logger as unknown as Record<string, { mock: { calls: unknown[][] } }>;
    return [
      complete.mock.calls,
      review.mock.calls,
      cards.mock.calls,
      readProduct.mock.calls,
      searchProducts.mock.calls,
      resolveLink.mock.calls,
      getItem.mock.calls,
      orders.searchForAgent.mock.calls,
      orders.findOwnByNumber.mock.calls,
      orders.get.mock.calls,
      orders.read.mock.calls,
      orders.resolve.mock.calls,
      orders.take.mock.calls,
      chunks.mock.calls,
      readEarnings.mock.calls,
      traces,
      ...LOG_LEVELS.map((level) => levels[level]?.mock.calls ?? []),
    ];
  }

  return {
    clock,
    settings,
    state,
    searchProducts,
    readProduct,
    assemble,
    cards,
    resolveLink,
    orders,
    chunks,
    readEarnings,
    text,
    store,
    complete,
    review,
    check,
    traces,
    logger,
    defaultSession,
    received,
    /** The scripted model's rounds for the run whose user text is `question` (keyed by the
     * redacted model text, as the model receives it). */
    say(question: string, steps: readonly Step[]): void {
      scripts[redactForModel(question).text] = steps;
    },
    run(question: string, options: RunOptions = {}): Promise<RunView> {
      return runInput(inputOf(question, options));
    },
    /** Runs a RunBodyInput as given (e.g. the one the HTTP layer handed to its body). */
    runInput,
  };
}

export type Kit = ReturnType<typeof kit>;

export function typesOf(view: RunView): string[] {
  return view.cards.map((c) => c.type);
}

/** Content frames only (no tool.status), in order. */
export function content(view: RunView): Event[] {
  return view.events.filter((e) => e.kind !== 'status');
}

/** product_key of every rebate_quote card, in order. */
export function quotedKeys(view: RunView): unknown[] {
  return view.cards
    .filter((c) => c.type === 'rebate_quote')
    .map(
      (c) => (c.data['product'] as Readonly<Record<string, unknown>> | undefined)?.['product_key'],
    );
}

/** Cards that carry a product (quote or list). */
export function productCards(view: RunView): CardFrame[] {
  return view.cards.filter((c) => c.type === 'rebate_quote' || c.type === 'product_list');
}

/** The cards that are not notices. */
export function nonNotices(view: RunView): string[] {
  return typesOf(view).filter((type) => type !== 'notice');
}

/** No personal data was read: orders, link logs, the by-number budget, earnings. */
export function personalReads(h: Kit): number {
  return (
    h.orders.searchForAgent.mock.calls.length +
    h.orders.findOwnByNumber.mock.calls.length +
    h.orders.get.mock.calls.length +
    h.orders.read.mock.calls.length +
    h.orders.take.mock.calls.length +
    h.readEarnings.mock.calls.length
  );
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'card_id')
        .map(([key, inner]) => [key, strip(inner)]),
    );
  }
  return value;
}

/** Frames as the user sees them, without card numbers; adjacent text deltas joined. */
export function comparable(events: readonly Event[]): unknown[] {
  const merged: Event[] = [];
  for (const event of events) {
    const last = merged.at(-1);
    if (event.kind === 'text' && last !== undefined && last.kind === 'text') {
      merged[merged.length - 1] = { kind: 'text', text: last.text + event.text };
    } else {
      merged.push(event);
    }
  }
  return merged.map(strip);
}

function isBufferJson(value: unknown): value is { readonly data: number[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['type'] === 'Buffer' &&
    Array.isArray((value as Record<string, unknown>)['data'])
  );
}

/** JSON text of `value` for substring checks (bigint as decimal, byte columns as UTF-8). */
export function serialized(value: unknown): string {
  return String(
    JSON.stringify(value, (_key, inner: unknown) => {
      if (typeof inner === 'bigint') return inner.toString();
      if (isBufferJson(inner)) return Buffer.from(inner.data).toString('utf8');
      return inner;
    }),
  );
}
