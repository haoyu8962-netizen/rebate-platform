import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { ASK, ORDER_LOGIN, expectLogin, watchReader } from '../previous-intent/kit.ts';
import { LIST_ARGS, ORDER_ID, replyTextOf } from '../reply-persist/kit.ts';
import { fileText, newGuest, openSession, usePgEach } from '../stream-mount/kit.ts';
import { cardTypesOf, finishOf, runIdOf } from '../trace-persist/kit.ts';
import { selfDetail } from '../tools-orders/kit.ts';
import { intent, ORDERS, QUESTION, runtimeRig, SPEC_TIMEOUT, storedRun, tool } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

it(
  '[AC-B3-08t#1][AC-B3-08t#7] 写入服务端改判的订单意图，同会话下一轮能从生产读口承接',
  async () => {
    const reader = watchReader();
    const caller = await newGuest(pg.db);
    const x = await runtimeRig(pg.db, {
      caller,
      steps: [intent('earnings_query'), intent('earnings_query')],
    });
    try {
      const session = await openSession(x.r, caller);
      const first = await x.ask(session, ORDERS);
      expectLogin(first, ORDER_LOGIN);
      const previous = await storedRun(pg.db, x.appId, runIdOf(first));

      await x.r.time.by(1_000);
      const second = await x.ask(session, ASK);
      const runId = runIdOf(second);
      expect(reader.of(runId)).toEqual([
        { query: { appId: x.appId, sessionId: session, runId }, answer: 'order_query' },
      ]);
      expectLogin(second, ORDER_LOGIN);
      expect(previous).toMatchObject({ intent: 'order_query', input_passed: true });
      expect(previous.final_event).not.toBeNull();
      expect(await storedRun(pg.db, x.appId, runId)).toMatchObject({
        intent: 'order_query',
        input_passed: true,
      });
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

const SEARCH = tool('search_products', { q: '合成保温杯' });
const HANDOFF = tool('handoff_to_human', {});
const ORDER_NUMBER = '<num_1>';
const toolCases = [
  ['search_products', SEARCH, 'search'],
  ['get_rebate_quote', tool('get_rebate_quote', { ref_ordinal: 1 }), 'find_by_link'],
  ['list_my_orders', tool('list_my_orders', LIST_ARGS), 'order_query'],
  [
    'explain_order',
    tool('explain_order', { platform: 'taobao', order_no: ORDER_NUMBER }),
    'order_query',
  ],
  [
    'prefill_claim',
    tool('prefill_claim', { platform: 'taobao', order_no: ORDER_NUMBER }),
    'order_query',
  ],
  ['get_my_earnings', tool('get_my_earnings', {}), 'earnings_query'],
  ['search_rules', tool('search_rules', { question: '提现最低多少' }), 'rule_qa'],
  ['handoff_to_human', HANDOFF, 'handoff'],
] as const;

it.each(toolCases)(
  '[AC-B3-08t#2] 无意图对象，按首个工具 %s 推断，即使后面调用其他工具',
  async (name, first, expected) => {
    const second = name === 'handoff_to_human' ? SEARCH : HANDOFF;
    const x = await runtimeRig(pg.db, {
      steps: [
        { calls: [...(first.calls ?? []), ...(second.calls ?? [])] },
        { text: '已按你的问题查看。' },
      ],
    });
    try {
      const session = await openSession(x.r, x.caller);
      const frames = await x.ask(session, '帮我看看淘宝订单 3900112233445566778');
      expect(
        frames
          .filter((frame) => frame.event === 'tool.status' && frame.data['phase'] === 'start')
          .map((frame) => frame.data['tool']),
      ).toEqual([name, second.calls?.[0]?.name]);
      expect(await storedRun(pg.db, x.appId, runIdOf(frames))).toMatchObject({
        intent: expected,
        input_passed: true,
        final_event: expect.any(Object),
      });
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

it(
  '[AC-B3-08t#3] 模型协议的 ref_ordinal 落为 refine',
  async () => {
    const x = await runtimeRig(pg.db, {
      steps: [SEARCH, { text: '请看商品卡。' }, intent('ref_ordinal', { ordinal: 1 })],
    });
    try {
      const session = await openSession(x.r, x.caller);
      expect(cardTypesOf(await x.ask(session, QUESTION))).toContain('product_list');
      await x.r.time.by(1_000);
      const frames = await x.ask(session, '看一下第一个');
      expect(cardTypesOf(frames)).toContain('rebate_quote');
      expect(await storedRun(pg.db, x.appId, runIdOf(frames))).toMatchObject({
        intent: 'refine',
        input_passed: true,
        final_event: expect.any(Object),
      });
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

it.each([
  ['① 页面引导', '钱包在哪', 'page_guide'],
  ['② 规则', '提现最低多少', 'rule_qa'],
  ['③ 查订单', ORDERS, 'order_query'],
  ['④ 查收益', '余额还有多少', 'earnings_query'],
  ['⑤ 人工', '转人工', 'handoff'],
  ['⑥ 搜索', QUESTION, 'search'],
] as const)(
  '[AC-B3-08t#3][AC-B3-08t#6] 无模型分流 %s 保存意图并同步清空预写快照',
  async (_label, question, expected) => {
    const x = await runtimeRig(pg.db, { route: 'models_without_prompt' });
    try {
      const frames = await x.ask(await openSession(x.r, x.caller), question);
      expect(x.complete).not.toHaveBeenCalled();
      expect(await storedRun(pg.db, x.appId, runIdOf(frames))).toMatchObject({
        intent: expected,
        input_passed: true,
        model: null,
        model_snapshot: null,
        prompt_version: 'none',
        final_event: expect.any(Object),
      });
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

const entryCases = [
  { label: '链接', text: '', context: undefined, card: 'rebate_quote', expected: 'find_by_link' },
  {
    label: '商品情境入口',
    text: '这件商品有返利吗',
    context: { product_key: 'tb:synthetic-cup' },
    card: 'rebate_quote',
    expected: 'find_by_link',
  },
  {
    label: '订单情境入口',
    text: '这笔返了吗',
    context: { order_id: ORDER_ID },
    card: 'order_status',
    expected: 'order_query',
  },
] as const;

it.each(entryCases)(
  '[AC-B3-08t#3][AC-B3-08t#6] 无模型的 $label 保存入口意图并同步清空预写快照',
  async ({ label, text, context, card, expected }) => {
    const x = await runtimeRig(pg.db, { route: 'models_without_prompt' });
    try {
      x.f.get.mockResolvedValue({ ...selfDetail(), order_id: ORDER_ID });
      const session = await openSession(x.r, x.caller);
      const sample = await x.f.demo.searchItems(
        { keyword: '演示商品' },
        { appId: x.appId, requestId: session, purpose: 'online' },
      );
      expect(sample.items[0]?.item_id).toBeTypeOf('string');
      const question =
        label === '链接'
          ? `https://demo.invalid/taobao/${encodeURIComponent(sample.items[0]?.item_id ?? '')}`
          : text;
      const frames = await x.ask(session, question, context);
      expect(cardTypesOf(frames)).toContain(card);
      expect(x.complete).not.toHaveBeenCalled();
      expect(await storedRun(pg.db, x.appId, runIdOf(frames))).toMatchObject({
        intent: expected,
        input_passed: true,
        model: null,
        model_snapshot: null,
        prompt_version: 'none',
        final_event: expect.any(Object),
      });
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

it(
  '[AC-B3-08t#3][AC-B3-08t#5] 模型判为范围外仍记录 out_of_scope 和已通过的输入',
  async () => {
    const x = await runtimeRig(pg.db, { steps: [intent('out_of_scope')] });
    try {
      const frames = await x.ask(await openSession(x.r, x.caller), '请讲一下月球背面的地形');
      expect(replyTextOf(frames)).toContain(fileText('agent.refuse.out_of_scope'));
      expect(await storedRun(pg.db, x.appId, runIdOf(frames))).toMatchObject({
        intent: 'out_of_scope',
        input_passed: true,
        final_event: expect.any(Object),
      });
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

it.each([
  ['只给说明', '尺码一般怎么看', '可以查看商品详情页。'],
  ['只有问候', '你好', null],
  ['没有商品词', '这个多少钱', null],
] as const)(
  '[AC-B3-08t#4] %s 且没有搜索，意图留空',
  async (_label, text, output) => {
    const x = await runtimeRig(pg.db, output === null ? {} : { steps: [{ text: output }] });
    try {
      const frames = await x.ask(await openSession(x.r, x.caller), text);
      expect(x.f.searchProducts).not.toHaveBeenCalled();
      expect(frames.some((frame) => frame.event === 'done')).toBe(true);
      expect(await storedRun(pg.db, x.appId, runIdOf(frames))).toMatchObject({
        intent: null,
        input_passed: true,
        final_event: expect.any(Object),
      });
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

it.each([
  ['审核拦截', QUESTION, 'block', 'agent.refuse.unsafe'],
  ['审核不可用', QUESTION, 'timeout', 'agent.refuse.safety_unavailable'],
  ['建议类预判', '帮我诊断头痛是什么病', 'pass', 'agent.refuse.advice'],
  ['禁售预判', '帮我找处方药', 'pass', 'agent.refuse.prohibited'],
] as const)(
  '[AC-B3-08t#4][AC-B3-08t#5] %s 结束后 intent 为空且 input_passed=false',
  async (_label, text, verdict, key) => {
    const x = await runtimeRig(pg.db, { steps: [], review: async () => verdict });
    try {
      const frames = await x.ask(await openSession(x.r, x.caller), text);
      expect(finishOf(frames)).toBe('safety');
      expect(replyTextOf(frames)).toContain(fileText(key));
      expect(x.complete).not.toHaveBeenCalled();
      expect(await storedRun(pg.db, x.appId, runIdOf(frames))).toMatchObject({
        intent: null,
        input_passed: false,
        final_event: expect.any(Object),
      });
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);
