// B3-05q · BR-AI-01 细则「情境入口」context.order_id (订单详情「问问 AI」): handled as order_query
// whatever the model says — 判定顺序 ③ identity first (guest → auth_required(login), unbound →
// auth_required(bind_phone)), ④ all order tools off → OrderList guide card; a phone-bound owner
// gets this one order from 名下订单 (BR-AI-07 判定规则 1): 1 order_status card + the T5 text, and
// the round ends there. Not in 名下 reads exactly like 0 orders (order_list.empty + handoff card),
// never telling whether the order exists.
import { expect, it } from 'vitest';
import { selfDetail, type OrderDetail } from '../tools-orders/kit.ts';
import {
  GUEST,
  MEMBER,
  MISSING_ORDER,
  OTHERS_ORDER,
  OWN_ORDER,
  UNBOUND,
  comparable,
  content,
  copy,
  intent,
  kit,
  personalReads,
  says,
  typesOf,
  type Kit,
  type RunView,
  type Step,
} from './kit.ts';

const QUESTION = '这单返了吗';
/** What a model must never get delivered here: a conclusion and a product search. */
const MODEL_STEPS: readonly Step[] = [
  { calls: [{ name: 'search_products', args: { q: '合成纸巾' } }] },
  says('这单已经返了，放心吧。'),
];
const MODEL_TEXT = '这单已经返了';

type DetailPatch = Partial<Pick<OrderDetail, 'order_id' | 'display_status' | 'reason'>>;

function detail(patch: DetailPatch = {}): OrderDetail {
  return { ...selfDetail(), order_id: OWN_ORDER, ...patch };
}

/** orders.get answers for the order's owner only (the scope of 名下订单). */
function owns(h: Kit, order: OrderDetail): void {
  h.orders.get.mockImplementation(async (subject, orderId) =>
    subject.user_id === MEMBER.userId && orderId === order.order_id ? order : null,
  );
}

it.each(['model', 'no_model'] as const)(
  '[AC-B3-05q#8][BR-AI-01][BR-AI-07] 已绑手机本人、订单在名下（%s）：从名下取这一笔，出 1 张 order_status 卡，文本用 T5 模板 order_status.<display_status>.summary，本轮到此为止',
  async (mode) => {
    const h = kit();
    owns(h, detail({ display_status: 'PAID', reason: null }));
    if (mode === 'no_model') h.state.noModel = true;
    else h.say(QUESTION, MODEL_STEPS);
    const view = await h.run(QUESTION, { caller: MEMBER, context: { order_id: OWN_ORDER } });
    expect(view.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(view.cards).toEqual([
      expect.objectContaining({
        type: 'order_status',
        data: expect.objectContaining({ order_id: OWN_ORDER, display_status: 'PAID' }),
      }),
    ]);
    expect(view.text).toBe(copy('order_status.PAID.summary'));
    expect(h.orders.get).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: MEMBER.userId }),
      OWN_ORDER,
    );
    // The round ends there: no model text, no other tool (and no lookup by the entry order's
    // platform or number).
    expect(view.text).not.toContain(MODEL_TEXT);
    expect(h.searchProducts).not.toHaveBeenCalled();
    expect(h.orders.searchForAgent).not.toHaveBeenCalled();
    expect(h.orders.findOwnByNumber).not.toHaveBeenCalled();
    expect(h.orders.take).not.toHaveBeenCalled();
    expect(view.suggestions).toEqual([]);
  },
);

it('[AC-B3-05q#9][BR-AI-07] 名下订单带原因码：T5 文本用 order_reason.<reason_code>.summary，卡片照原因渲染', async () => {
  const h = kit();
  owns(h, detail({ display_status: 'WAITING', reason: 'PART_REFUND' }));
  h.say(QUESTION, MODEL_STEPS);
  const view = await h.run(QUESTION, { caller: MEMBER, context: { order_id: OWN_ORDER } });
  expect(view.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(view.cards).toEqual([
    expect.objectContaining({
      type: 'order_status',
      data: expect.objectContaining({ order_id: OWN_ORDER, reason: 'PART_REFUND' }),
    }),
  ]);
  expect(view.text).toBe(copy('order_reason.PART_REFUND.summary'));
  expect(h.searchProducts).not.toHaveBeenCalled();
});

it.each([
  ['游客', 'login', 'agent.need_login', GUEST],
  ['已登录未绑手机', 'bind_phone', 'agent.need_phone', UNBOUND],
] as const)(
  '[AC-B3-05q#10][BR-AI-01] %s带 context.order_id → auth_required(%s) + %s，以 auth_required 结束，不读任何订单',
  async (_who, reason, textKey, caller) => {
    const h = kit();
    owns(h, detail({ display_status: 'PAID', reason: null }));
    h.say(QUESTION, MODEL_STEPS);
    const view = await h.run(QUESTION, { caller, context: { order_id: OWN_ORDER } });
    expect(view.result).toEqual({ kind: 'done', finishReason: 'auth_required' });
    expect(view.cards).toEqual([
      expect.objectContaining({
        type: 'auth_required',
        data: expect.objectContaining({ reason }),
      }),
    ]);
    expect(view.text).toBe(copy(textKey));
    expect(personalReads(h)).toBe(0);
    expect(h.searchProducts).not.toHaveBeenCalled();
  },
);

it('[AC-B3-05q#11][BR-AI-01] 已绑手机、订单工具都关闭时带 context.order_id → OrderList 页面引导卡，不读订单、不放行模型文字', async () => {
  const h = kit();
  h.settings.set('agent.tools.list_my_orders.enabled', false);
  h.settings.set('agent.tools.explain_order.enabled', false);
  owns(h, detail({ display_status: 'PAID', reason: null }));
  h.say(QUESTION, MODEL_STEPS);
  const view = await h.run(QUESTION, { caller: MEMBER, context: { order_id: OWN_ORDER } });
  expect(view.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(view.cards).toEqual([
    expect.objectContaining({
      type: 'page_guide',
      data: expect.objectContaining({ route: 'OrderList' }),
    }),
  ]);
  expect(personalReads(h)).toBe(0);
  expect(view.text).not.toContain(MODEL_TEXT);
  expect(h.searchProducts).not.toHaveBeenCalled();
});

it('[AC-B3-05q#12][BR-AI-01][BR-AI-07] 订单不在名下（他人的单、不存在的单）与本人 0 笔对外完全相同：order_list.empty + handoff 卡、同一结束原因、帧序列除编号外一致，不透露订单是否存在', async () => {
  // Reference: a phone-bound user's own 0 orders (order_query → list_my_orders finds none).
  const reference = kit();
  const ask = '帮我看看最近的单';
  reference.say(ask, [says(intent('order_query'))]);
  const zero = await reference.run(ask, { caller: MEMBER });
  expect(typesOf(zero)).toEqual(['handoff']);
  expect(zero.text).toBe(copy('order_list.empty'));

  const views: RunView[] = [];
  for (const orderId of [OTHERS_ORDER, MISSING_ORDER]) {
    const h = kit();
    // OTHERS_ORDER exists, but for another user: the caller's scope never returns it.
    h.orders.get.mockImplementation(async (subject, id) =>
      subject.user_id === 'synthetic-other-user' && id === OTHERS_ORDER
        ? detail({ order_id: OTHERS_ORDER })
        : null,
    );
    h.say(QUESTION, MODEL_STEPS);
    const view = await h.run(QUESTION, { caller: MEMBER, context: { order_id: orderId } });
    expect(view.result, orderId).toEqual(zero.result);
    expect(comparable(content(view)), orderId).toEqual(comparable(content(zero)));
    expect(typesOf(view)).not.toContain('order_status');
    expect(typesOf(view)).not.toContain('claim_draft');
    expect(view.text).not.toContain(MODEL_TEXT);
    expect(h.orders.get).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: MEMBER.userId }),
      orderId,
    );
    expect(h.searchProducts).not.toHaveBeenCalled();
    views.push(view);
  }
  // Someone else's order and an order that does not exist: every frame alike, tool status too.
  expect(comparable(views[0]?.events ?? [])).toEqual(comparable(views[1]?.events ?? []));
});
