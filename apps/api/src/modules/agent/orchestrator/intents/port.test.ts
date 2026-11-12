import { bridge } from '@couli/contracts-ts';
import { expect, it, vi } from 'vitest';
import type { AgentCaller } from '../../http/index.ts';
import type { RedactedText } from '../../stream/admission/index.ts';
import type { RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import { bindServerCalls, type ServerToolCalls } from '../core/intent-fallback.ts';
import { createIntentPort } from './index.ts';
import type { IntentDeps, IntentRequest, TemplateCall } from './index.ts';

// Synthetic only. BR-AI-01 细则「判定顺序」②③④ through the whole port: the server's clear
// reading of the user's text decides between personal queries, page_guide and rule_qa.
const GUEST = { userId: null, phoneBound: false };
const MEMBER = { userId: 'synthetic-user', phoneBound: true };
const CONFIGURED = [
  'Wallet',
  'WithdrawRecords',
  'AuthManage',
  'OrderList',
  'InviteShare',
  'Messages',
];

function copy(key: string): string {
  return `合成文案:${key}`;
}

function request(
  output: unknown,
  text: string,
  caller: Pick<AgentCaller, 'userId' | 'phoneBound'>,
): IntentRequest {
  return {
    text: JSON.stringify(output),
    input: {
      caller: {
        appId: 'synthetic-app',
        traceId: 'synthetic-trace',
        deviceId: 'synthetic-device',
        deviceHash: 'synthetic-hash',
        ipKey: 'synthetic-ip',
        ...caller,
      },
      sessionId: 'synthetic-session',
      runId: 'synthetic-run',
      userMessageId: 'synthetic-user-message',
      assistantMessageId: 'synthetic-assistant-message',
      text,
      redactedText: text as RedactedText,
      limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
    },
    proceed: {
      kind: 'proceed',
      modelText: text,
      placeholders: {},
      links: [],
      notices: [],
      untrustedInput: false,
      paramsRequested: false,
    },
  };
}

function harness(
  disabled: readonly string[] = [],
  calls: readonly TemplateCall[] = [],
  configured: readonly string[] = CONFIGURED,
) {
  const off = new Set(disabled);
  const unused = () => Promise.reject(new Error('synthetic: clarification not expected'));
  const deps: IntentDeps = {
    routes: { configured: async () => configured, contract: () => bridge.routes },
    flags: { enabled: async (_app, key) => !off.has(key) },
    tools: { registered: () => true },
    texts: { text: async (_app, key) => copy(key) },
    trace: { calls: async () => calls, record: vi.fn() },
    clarification: {
      scope: unused,
      takeOnce: unused,
      options: unused,
      latestProducts: unused,
      fallbackNotice: unused,
      withoutCondition: unused,
    },
    continuation: {
      previousIntent: vi.fn(async () => null),
      run: vi.fn<IntentDeps['continuation']['run']>(async () => ({
        kind: 'done',
        finishReason: 'stop',
      })),
    },
  };
  const port = createIntentPort(deps);
  return {
    deps,
    async run(req: IntentRequest, server?: ServerToolCalls) {
      const cards: UnnumberedCard[] = [];
      const texts: string[] = [];
      const ctx: RunContext = {
        runId: req.input.runId,
        sessionId: req.input.sessionId,
        signal: new AbortController().signal,
        cardsDelivered: 0,
        text: (delta) => {
          texts.push(delta);
        },
        card: async (card) => {
          cards.push(card);
        },
        suggestions: vi.fn(),
        toolStatus: vi.fn(),
      };
      if (server !== undefined) bindServerCalls(ctx, server);
      return { result: await port.handle(req, ctx), cards, texts, ctx };
    },
  };
}

function guideCard(route: string): UnnumberedCard {
  return {
    type: 'page_guide',
    schema_version: 1,
    data: { route, text_key: `agent.guide.${route}` },
    fallback_text: copy(`agent.guide.${route}`),
  };
}

const EARNINGS_OFF = ['agent.tools.get_my_earnings.enabled'];
const ORDERS_OFF = ['agent.tools.list_my_orders.enabled', 'agent.tools.explain_order.enabled'];

it.each([
  ['我这笔提现到账了吗', 'withdrawal_progress', 'WithdrawRecords'],
  ['那笔提现到哪了', 'withdrawal_progress', 'WithdrawRecords'],
  ['这笔提现怎么还没到', 'summary', 'WithdrawRecords'],
  ['那单的提现到账了吗', 'withdrawal_progress', 'WithdrawRecords'],
  ['这笔余额什么时候能提', 'summary', 'Wallet'],
  ['这笔收益多少', 'summary', 'Wallet'],
  ['这笔返了吗', 'summary', 'Wallet'],
] as const)(
  '[B3-05f][BR-AI-01] 收益问法不被量词改成订单，工具关闭时出收益对应引导卡：%s',
  async (text, topic, route) => {
    const h = harness(EARNINGS_OFF);
    const output = await h.run(request({ agent_intent: 'earnings_query', topic }, text, MEMBER));
    expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(output.cards).toEqual([guideCard(route)]);
    expect(output.texts).toEqual([]);
    expect(h.deps.continuation.run).not.toHaveBeenCalled();
  },
);

it('[B3-05f][BR-AI-01] 收益工具开启时原样转交模型的收益意图，不转订单', async () => {
  const h = harness();
  const model = { agent_intent: 'earnings_query', topic: 'withdrawal_progress' } as const;
  const req = request(model, '我这笔提现到账了吗', MEMBER);
  const output = await h.run(req);
  expect(output.cards).toEqual([]);
  expect(h.deps.continuation.run).toHaveBeenCalledExactlyOnceWith(model, req, output.ctx);
});

it.each([
  '那单返了吗',
  '这笔订单返了吗',
  '这单到账了吗',
  '昨天买的牛奶返利什么时候结算',
  '刚下单的怎么还没显示',
  '上一单的返利呢',
])('[B3-05f][BR-AI-01] 有订单类名词时仍按订单，工具关闭出 OrderList：%s', async (text) => {
  const h = harness(ORDERS_OFF);
  const output = await h.run(request({ agent_intent: 'earnings_query' }, text, MEMBER));
  expect(output.cards).toEqual([guideCard('OrderList')]);
  expect(h.deps.continuation.run).not.toHaveBeenCalled();
});

it.each([
  ['提现最低多少', 'earnings_query'],
  ['返利一般什么时候结算', 'earnings_query'],
  ['提现手续费是多少', 'earnings_query'],
  ['订单一般多久返利', 'order_query'],
  ['提现一般多久到账', 'earnings_query'],
  ['返利规则是什么', 'order_query'],
] as const)(
  '[B3-05f][BR-AI-01] 服务端判为泛规则时纠正模型的个人查询标签，游客不要求登录：%s',
  async (text, intent) => {
    const h = harness();
    const req = request({ agent_intent: intent }, text, GUEST);
    const output = await h.run(req);
    expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(output.cards).toEqual([]);
    expect(output.texts).toEqual([]);
    expect(h.deps.continuation.run).toHaveBeenCalledExactlyOnceWith(
      { agent_intent: 'rule_qa' },
      req,
      output.ctx,
    );
  },
);

it.each([
  ['钱包在哪', 'earnings_query', 'Wallet'],
  ['怎么提现', 'earnings_query', 'Wallet'],
  ['订单列表在哪', 'order_query', 'OrderList'],
] as const)(
  '[B3-05f][BR-AI-01] 服务端判为页面位置时纠正个人查询标签，游客也出引导卡：%s',
  async (text, intent, route) => {
    const h = harness();
    const output = await h.run(request({ agent_intent: intent }, text, GUEST));
    expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(output.cards).toEqual([guideCard(route)]);
    expect(h.deps.continuation.run).not.toHaveBeenCalled();
  },
);

it.each([
  ['我的提现一般多久到账', 'rule_qa', 'agent.earnings.need_login'],
  ['这笔提现一般多久到账', 'earnings_query', 'agent.earnings.need_login'],
  ['那单一般多久返', 'rule_qa', 'agent.need_login'],
  ['我的订单最低返多少', 'rule_qa', 'agent.need_login'],
  ['我余额还有多少', 'rule_qa', 'agent.earnings.need_login'],
  ['合成查询请求', 'order_query', 'agent.need_login'],
] as const)(
  '[B3-05f][BR-AI-01] 指向本人数据或判定不明时保持个人查询，游客出 auth_required：%s',
  async (text, intent, key) => {
    const h = harness();
    const output = await h.run(request({ agent_intent: intent }, text, GUEST));
    expect(output.result).toEqual({ kind: 'done', finishReason: 'auth_required' });
    expect(output.cards.map((card) => card.type)).toEqual(['auth_required']);
    expect(output.texts).toEqual([copy(key)]);
    expect(h.deps.continuation.run).not.toHaveBeenCalled();
  },
);

// BR-AI-01 「页面引导」: location / entry questions stay page guides for every identity, and a
// sentence-final particle is no evidence of a progress question.
it.each([
  [
    '提现记录在哪看呢？',
    { agent_intent: 'page_guide', guide_route: 'WithdrawRecords' },
    'WithdrawRecords',
  ],
  ['订单列表在哪呢', { agent_intent: 'page_guide', guide_route: 'OrderList' }, 'OrderList'],
  ['钱包在哪里啊', { agent_intent: 'page_guide', guide_route: 'Wallet' }, 'Wallet'],
  [
    '提现记录哪里看嘛',
    { agent_intent: 'page_guide', guide_route: 'WithdrawRecords' },
    'WithdrawRecords',
  ],
  ['钱包呢', { agent_intent: 'page_guide', guide_route: 'Wallet' }, 'Wallet'],
  ['提现记录在哪个页面呀', { agent_intent: 'earnings_query' }, 'WithdrawRecords'],
  ['我的订单怎么找呢', { agent_intent: 'order_query' }, 'OrderList'],
  ['余额入口在哪儿呢', { agent_intent: 'earnings_query' }, 'Wallet'],
] as const)(
  '[B3-05f][BR-AI-01] 位置或入口问法带语气词仍出引导卡，游客不要求登录：%s',
  async (text, model, route) => {
    const h = harness();
    const output = await h.run(request(model, text, GUEST));
    expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(output.cards).toEqual([guideCard(route)]);
    expect(output.texts).toEqual([]);
  },
);

it.each([
  ['余额呢', 'agent.earnings.need_login'],
  ['我的提现到哪了呢', 'agent.earnings.need_login'],
  ['提现到哪里了啊', 'agent.earnings.need_login'],
  ['我余额还有多少呀', 'agent.earnings.need_login'],
  ['那单返了吗', 'agent.need_login'],
  ['上一单的返利呢', 'agent.need_login'],
] as const)('[B3-05f][BR-AI-01] 数额与进度问法即使带语气词仍按本人查询：%s', async (text, key) => {
  const h = harness();
  const model = { agent_intent: 'page_guide', guide_route: 'Wallet' };
  const output = await h.run(request(model, text, GUEST));
  expect(output.result).toEqual({ kind: 'done', finishReason: 'auth_required' });
  expect(output.cards.map((card) => card.type)).toEqual(['auth_required']);
  expect(output.texts).toEqual([copy(key)]);
});

// BR-AI-07: templates summarise every call of the run, not only the last one.
const PAID = { reason_code: null, display_status: 'PAID' } as const;
const WAITING = { reason_code: null, display_status: 'WAITING' } as const;
const REFUND = { reason_code: 'REFUND', display_status: 'INVALID' } as const;
const NOT_TRACKED = { reason_code: 'NOT_TRACKED', display_status: 'WAITING' } as const;

async function templateTexts(calls: readonly TemplateCall[]) {
  const h = harness([], calls);
  const output = await h.run(request('模型伪造结论：已到账', '合成订单问题', MEMBER));
  expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(output.cards).toEqual([]);
  expect(h.deps.continuation.run).not.toHaveBeenCalled();
  return output.texts;
}

it.each<[string, readonly TemplateCall[]]>([
  [
    '两次 explain_order 各一笔',
    [
      { name: 'explain_order', orders: [PAID] },
      { name: 'explain_order', orders: [REFUND] },
    ],
  ],
  [
    'explain_order 与 list_my_orders 各一笔',
    [
      { name: 'explain_order', orders: [WAITING] },
      { name: 'list_my_orders', orders: [PAID] },
    ],
  ],
  ['一次 list_my_orders 两笔', [{ name: 'list_my_orders', orders: [PAID, REFUND] }]],
  [
    '空列表后两次单笔',
    [
      { name: 'list_my_orders', orders: [] },
      { name: 'explain_order', orders: [PAID] },
      { name: 'explain_order', orders: [WAITING] },
    ],
  ],
  [
    '查不到的单号与另一笔',
    [
      { name: 'explain_order', orders: [NOT_TRACKED] },
      { name: 'explain_order', orders: [WAITING] },
    ],
  ],
  [
    '三次 explain_order',
    [
      { name: 'explain_order', orders: [PAID] },
      { name: 'explain_order', orders: [PAID] },
      { name: 'explain_order', orders: [REFUND] },
    ],
  ],
])('[B3-05f][BR-AI-07] 本 run 合计多笔订单一律用 order_list.summary：%s', async (_name, calls) => {
  expect(await templateTexts(calls)).toEqual([copy('order_list.summary')]);
});

it.each<[readonly TemplateCall[], string]>([
  [[{ name: 'explain_order', orders: [PAID] }], 'order_status.PAID.summary'],
  [[{ name: 'explain_order', orders: [REFUND] }], 'order_reason.REFUND.summary'],
  [
    [
      { name: 'list_my_orders', orders: [] },
      { name: 'explain_order', orders: [WAITING] },
    ],
    'order_status.WAITING.summary',
  ],
  [
    [
      { name: 'list_my_orders', orders: [] },
      { name: 'explain_order', orders: [NOT_TRACKED] },
    ],
    'order_reason.NOT_TRACKED.summary',
  ],
  [
    [
      { name: 'list_my_orders', orders: [] },
      { name: 'list_my_orders', orders: [] },
    ],
    'order_list.empty',
  ],
  [
    [
      { name: 'list_my_orders', orders: [] },
      { name: 'list_my_orders', orders: [REFUND] },
    ],
    'order_reason.REFUND.summary',
  ],
])(
  '[B3-05f][BR-AI-07] 本 run 合计只有一笔或零笔时用单笔模板或空列表模板 %#',
  async (calls, key) => {
    expect(await templateTexts(calls)).toEqual([copy(key)]);
  },
);

it.each<[readonly TemplateCall[], readonly string[]]>([
  [
    [
      { name: 'get_my_earnings', status: 'unavailable' },
      { name: 'get_my_earnings', status: 'shown' },
    ],
    ['agent.earnings.summary'],
  ],
  [
    [
      { name: 'get_my_earnings', status: 'shown' },
      { name: 'get_my_earnings', status: 'unavailable' },
    ],
    ['agent.earnings.summary'],
  ],
  [
    [
      { name: 'get_my_earnings', status: 'unavailable' },
      { name: 'get_my_earnings', status: 'unavailable' },
    ],
    ['agent.earnings.unavailable'],
  ],
  [
    [
      { name: 'search_rules', matched: true },
      { name: 'search_rules', matched: false },
    ],
    ['agent.rule.found'],
  ],
  [
    [
      { name: 'search_rules', matched: false },
      { name: 'search_rules', matched: false },
    ],
    ['agent.rule.not_found'],
  ],
  [
    [
      { name: 'explain_order', orders: [PAID] },
      { name: 'search_rules', matched: true },
      { name: 'explain_order', orders: [WAITING] },
    ],
    ['order_list.summary', 'agent.rule.found'],
  ],
])('[B3-05f][BR-AI-07][BR-AI-01] 收益与规则同样按本 run 全部调用汇总 %#', async (calls, keys) => {
  expect(await templateTexts(calls)).toEqual(keys.map(copy));
});

/** B3-05p: this run's server calls with only `offered` order tools on offer. */
function serverCalls(offered: readonly string[], calledByModel: readonly string[] = []) {
  const server: ServerToolCalls = {
    offered: (name) => offered.includes(name),
    calledByModel: (name) => calledByModel.includes(name),
    call: vi.fn<ServerToolCalls['call']>(),
  };
  return server;
}

const RECENT = '帮我看看最近的单';
const BY_NUMBER = '帮我查订单<num_1>返了没';
const LIST_OFF = ['agent.tools.list_my_orders.enabled'];
const EXPLAIN_OFF = ['agent.tools.explain_order.enabled'];

it.each([
  [RECENT, LIST_OFF, ['explain_order']],
  [BY_NUMBER, EXPLAIN_OFF, ['list_my_orders']],
] as const)(
  '[B3-05p][BR-AI-01] 判定顺序④：服务端代调需要的那个订单工具关着（%s）→ 同全关出 OrderList 引导卡，不交给代调',
  async (text, disabled, offered) => {
    const h = harness(disabled);
    const server = serverCalls(offered);
    const output = await h.run(request({ agent_intent: 'order_query' }, text, MEMBER), server);
    expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(output.cards).toEqual([guideCard('OrderList')]);
    expect(output.texts).toEqual([]);
    expect(h.deps.continuation.run).not.toHaveBeenCalled();
    expect(server.call).not.toHaveBeenCalled();
  },
);

it.each([
  ['页面引导关闭', [...LIST_OFF, 'agent.page_guide.enabled'], CONFIGURED],
  ['OrderList 不在配置里', LIST_OFF, CONFIGURED.filter((route) => route !== 'OrderList')],
] as const)(
  '[B3-05p][BR-AI-01] 判定顺序④：订单工具部分关闭且%s → 只出 agent.guide.unavailable 文本，不出卡',
  async (_label, disabled, configured) => {
    const h = harness(disabled, [], configured);
    const output = await h.run(
      request({ agent_intent: 'order_query' }, RECENT, MEMBER),
      serverCalls(['explain_order']),
    );
    expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(output.cards).toEqual([]);
    expect(output.texts).toEqual([copy('agent.guide.unavailable')]);
    expect(h.deps.continuation.run).not.toHaveBeenCalled();
  },
);

it.each([
  ['需要的工具在', RECENT, LIST_OFF, ['explain_order', 'list_my_orders'], []],
  ['按单号且 explain_order 在', BY_NUMBER, LIST_OFF, ['explain_order'], []],
  ['模型自己调过订单工具', RECENT, LIST_OFF, ['explain_order'], ['explain_order']],
] as const)(
  '[B3-05p][BR-AI-01] 判定顺序④：%s → 照旧交给续接（代调或模型自己的调用）',
  async (_label, text, disabled, offered, called) => {
    const h = harness(disabled);
    const output = await h.run(
      request({ agent_intent: 'order_query' }, text, MEMBER),
      serverCalls(offered, called),
    );
    expect(output.cards).toEqual([]);
    expect(h.deps.continuation.run).toHaveBeenCalledTimes(1);
  },
);
