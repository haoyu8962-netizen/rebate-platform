// B3-05q implementation unit tests: the entry path (createScenarioEntryPath) over synthetic readers,
// tools, texts, configuration and routes. No database, no listen.
import { expect, it, vi } from 'vitest';
import type { AgentCaller, RunBodyInput } from '../../http/index.ts';
import type { RedactedText } from '../../stream/admission/index.ts';
import type { RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import type { PathInput, ToolOutcome } from '../core/ports.ts';
import type { ReplyTemplateTrace } from '../core/reply-templates.ts';
import {
  createScenarioEntryPath,
  type EntryQuoteOutcome,
  type ScenarioEntryPathDeps,
} from './index.ts';

const ORDER = '0192f3a1-7c00-7000-8000-0000000e0001';
const MEMBER: Partial<AgentCaller> = { userId: 'synthetic-user', phoneBound: true };

const orderCard: UnnumberedCard = {
  type: 'order_status',
  schema_version: 1,
  data: { order_id: ORDER, display_status: 'PAID', reason: null },
  fallback_text: '合成',
};

const PAID_TRACE: ReplyTemplateTrace = {
  orders: [{ reason_code: null, display_status: 'PAID' }],
  order_ids: [ORDER],
};
const EMPTY_TRACE: ReplyTemplateTrace = { orders: [] };

const quoteCard: UnnumberedCard = {
  type: 'rebate_quote',
  schema_version: 1,
  data: { product: { product_key: 'tb:synthetic-entry' } },
  fallback_text: '合成',
};

function request(
  caller: Partial<AgentCaller> = MEMBER,
  flags: Partial<Pick<PathInput['proceed'], 'untrustedInput' | 'paramsRequested'>> = {},
): PathInput {
  const input: RunBodyInput = {
    caller: {
      appId: 'synthetic-app',
      traceId: 'synthetic-trace',
      deviceId: 'synthetic-device',
      deviceHash: 'synthetic-hash',
      ipKey: 'synthetic-ip-key',
      userId: 'synthetic-user',
      phoneBound: true,
      ...caller,
    },
    sessionId: 'synthetic-session',
    runId: 'synthetic-run',
    userMessageId: 'synthetic-user-message',
    assistantMessageId: 'synthetic-assistant-message',
    text: '合成问题',
    redactedText: '合成问题' as RedactedText,
    limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
  };
  return {
    input,
    proceed: {
      kind: 'proceed',
      modelText: '合成问题',
      placeholders: {},
      links: [],
      notices: [],
      untrustedInput: flags.untrustedInput ?? false,
      paramsRequested: flags.paramsRequested ?? false,
    },
  };
}

interface RigOptions {
  readonly offered?: readonly string[];
  readonly guide?: boolean;
  readonly quote?: () => Promise<EntryQuoteOutcome>;
  readonly order?: () => Promise<ToolOutcome>;
}

function rig(options: RigOptions = {}) {
  const log: string[] = [];
  const ctx: RunContext = {
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    cardsDelivered: 0,
    text: (text) => log.push(`text:${text}`),
    toolStatus: (tool, phase) => log.push(`status:${tool}:${phase}`),
    card: async (card, delivered) => {
      log.push(`card:${card.type}:${String(card.data['text_key'] ?? card.data['reason'] ?? '')}`);
      delivered?.('c1');
    },
    suggestions: () => log.push('suggestions'),
  };
  const quote = vi.fn<ScenarioEntryPathDeps['readers']['quote']>(
    options.quote ?? (async () => ({ kind: 'ok', modelView: {}, cards: [quoteCard] })),
  );
  const order = vi.fn<ScenarioEntryPathDeps['readers']['order']>(
    options.order ??
      (async () => ({
        kind: 'ok',
        modelView: {},
        cards: [orderCard],
        trace: PAID_TRACE,
      })),
  );
  const offered = options.offered ?? ['list_my_orders', 'explain_order'];
  const deps: ScenarioEntryPathDeps = {
    readers: { quote, order },
    tools: {
      definitions: async () =>
        offered.map((name) => ({ name, description: 'synthetic', parameters: {} })),
    },
    texts: { text: async (_app, key) => `[${key}]`, toolDisplay: async () => 'synthetic' },
    config: {
      configValue: async (_app, key) =>
        key === 'agent.page_guide.enabled' ? { value: options.guide ?? true, version: 1 } : null,
    },
    routes: {
      configured: async () => ['OrderList'],
      contract: () => ({ OrderList: { agent_guide: true } }),
    },
    errorMsg: async (_app, code) => `合成错误:${String(code)}`,
  };
  const reports: unknown[][] = [];
  const report = (...args: unknown[]) => {
    reports.push(args);
  };
  return { log, ctx, deps, path: createScenarioEntryPath(deps), quote, order, reports, report };
}

it.each([
  ['游客', { userId: null, phoneBound: false }, 'login', '[agent.need_login]'],
  ['未绑手机', { userId: 'synthetic-user', phoneBound: false }, 'bind_phone', '[agent.need_phone]'],
] as const)(
  '[B3-05q][BR-AI-01] 订单入口%s：auth_required，不看工具开关、不读订单',
  async (_who, caller, reason, text) => {
    const r = rig({ offered: [] });
    const result = await r.path.order(request(caller), ORDER, r.ctx, r.report);
    expect(result).toEqual({ kind: 'done', finishReason: 'auth_required' });
    expect(r.log).toEqual([`text:${text}`, `card:auth_required:${reason}`]);
    expect(r.order).not.toHaveBeenCalled();
    expect(r.reports).toEqual([]);
  },
);

it('[B3-05q][BR-AI-01] 订单入口、explain_order 没有下发（全关或只关它）：OrderList 引导卡；引导不可用时只给 agent.guide.unavailable', async () => {
  const off = rig({ offered: ['list_my_orders'] });
  expect(await off.path.order(request(), ORDER, off.ctx, off.report)).toEqual({
    kind: 'done',
    finishReason: 'stop',
  });
  expect(off.log).toEqual(['card:page_guide:agent.guide.OrderList']);
  expect(off.order).not.toHaveBeenCalled();

  const disabled = rig({ offered: [], guide: false });
  await disabled.path.order(request(), ORDER, disabled.ctx, disabled.report);
  expect(disabled.log).toEqual(['text:[agent.guide.unavailable]']);
  const untrusted = rig({ offered: [] });
  await untrusted.path.order(
    request(MEMBER, { untrustedInput: true }),
    ORDER,
    untrusted.ctx,
    untrusted.report,
  );
  expect(untrusted.log).toEqual(['text:[agent.guide.unavailable]']);
  const params = rig({ offered: [] });
  await params.path.order(
    request(MEMBER, { paramsRequested: true }),
    ORDER,
    params.ctx,
    params.report,
  );
  expect(params.log).toEqual(['text:[agent.guide.unavailable]']);
});

it('[B3-05q][BR-AI-07] 订单入口、名下这一笔：order_status 卡 + T5 模板；0 笔：卡照出、文本 order_list.empty；读失败：只给 order_list.empty', async () => {
  const own = rig();
  expect(await own.path.order(request(), ORDER, own.ctx, own.report)).toEqual({
    kind: 'done',
    finishReason: 'stop',
  });
  expect(own.log).toEqual([
    'status:explain_order:start',
    'status:explain_order:end',
    'card:order_status:',
    'text:[order_status.PAID.summary]',
  ]);
  expect(own.order.mock.calls[0]?.[0]).toBe(ORDER);
  expect(own.order.mock.calls[0]?.[1]).toMatchObject({
    userId: 'synthetic-user',
    phoneBound: true,
  });
  expect(own.reports).toEqual([['explain_order', { entry: 'order_id' }, 'ok']]);

  const handoff: UnnumberedCard = {
    type: 'handoff',
    schema_version: 1,
    data: { entry: 'AgentChat', summary: '合成' },
    fallback_text: '合成',
  };
  const none = rig({
    order: async () => ({ kind: 'ok', modelView: {}, cards: [handoff], trace: EMPTY_TRACE }),
  });
  await none.path.order(request(), ORDER, none.ctx, none.report);
  expect(none.log.slice(2)).toEqual(['card:handoff:', 'text:[order_list.empty]']);

  const broken = rig({
    order: async () => {
      throw new Error('synthetic read failure');
    },
  });
  await broken.path.order(request(), ORDER, broken.ctx, broken.report);
  expect(broken.log).toEqual([
    'status:explain_order:start',
    'status:explain_order:failed',
    'text:[order_list.empty]',
  ]);
  expect(broken.reports).toEqual([['explain_order', { entry: 'order_id' }, 'failed']]);
});

it('[B3-05q][BR-AI-04][BR-AI-15] 商品入口：出卡 quoted（带帧编号）；上游答复出链接路径的 notice；服务端原因与读取抛错都不写任何东西', async () => {
  const ok = rig();
  expect(await ok.path.product(request(), 'tb:synthetic-entry', ok.ctx, ok.report)).toEqual({
    kind: 'quoted',
    card: quoteCard,
    frameCardId: 'c1',
  });
  expect(ok.log).toEqual([
    'status:get_rebate_quote:start',
    'status:get_rebate_quote:end',
    'card:rebate_quote:',
  ]);

  for (const [outcome, key] of [
    [{ kind: 'parse_error', error_code: 30141, cards: [] }, 'error.30141'],
    [{ kind: 'price_unavailable', cards: [] }, 'error.50301'],
    [{ kind: 'no_card', cards: [] }, 'error.50301'],
  ] as const) {
    const r = rig({ quote: async () => outcome });
    expect(await r.path.product(request(), 'tb:synthetic-entry', r.ctx, r.report)).toEqual({
      kind: 'answered',
    });
    expect(r.log).toEqual([
      'status:get_rebate_quote:start',
      'status:get_rebate_quote:failed',
      `card:notice:${key}`,
    ]);
  }

  for (const quote of [
    async (): Promise<EntryQuoteOutcome> => ({ kind: 'server_failed' }),
    async (): Promise<EntryQuoteOutcome> => {
      throw new Error('synthetic upstream timeout');
    },
  ]) {
    const r = rig({ quote });
    expect(await r.path.product(request(), 'tb:synthetic-entry', r.ctx, r.report)).toEqual({
      kind: 'server_failed',
    });
    expect(r.log.filter((line) => !line.startsWith('status:'))).toEqual([]);
    expect(r.reports).toEqual([['get_rebate_quote', { entry: 'product_key' }, 'failed']]);
  }
});

it('[B3-05q][BR-AI-15] quote_failed notice 与 50401 结束', async () => {
  const r = rig();
  expect(await r.path.quoteFailedNotice('synthetic-app')).toEqual({
    type: 'notice',
    schema_version: 1,
    data: { level: 'warn', text_key: 'agent.notice.quote_failed', actions: [] },
    fallback_text: '[agent.notice.quote_failed]',
  });
  expect(await r.path.serverFailure('synthetic-app')).toEqual({
    kind: 'error',
    error: {
      code: 50401,
      msg: '合成错误:50401',
      retryable: false,
      fallback: null,
      fallback_q: null,
    },
  });
});
