// B3-05q · BR-AI-01 细则「情境入口」: what comes before the entry card.
// · 输入审核、拒答预判与禁售判断（判定顺序第 1 步）排在按入口出卡之前: a refused message gets no
//   entry card and reads neither the catalog nor any order.
// · 本条消息自身含链接或口令时按链接消息处理，context 不再用: only the link's product is quoted;
//   the entry product is not quoted and the entry order is not read.
// Each case also runs the same context without the refusal / without the link, so it shows the
// card is the entry's and is left out only for the reason under test.
import { expect, it } from 'vitest';
import { selfDetail, type OrderDetail } from '../tools-orders/kit.ts';
import {
  ENTRY_KEY,
  LINK,
  LINK_KEY,
  MEMBER,
  OWN_ORDER,
  TOKEN,
  copy,
  kit,
  personalReads,
  quotedKeys,
  typesOf,
  type Kit,
  type RunView,
} from './kit.ts';

const PRODUCT = { product_key: ENTRY_KEY } as const;
const ORDER = { order_id: OWN_ORDER } as const;

function ownOrder(h: Kit): void {
  const order: OrderDetail = {
    ...selfDetail(),
    order_id: OWN_ORDER,
    display_status: 'PAID',
    reason: null,
  };
  h.orders.get.mockImplementation(async (subject, orderId) =>
    subject.user_id === MEMBER.userId && orderId === OWN_ORDER ? order : null,
  );
}

function entryCards(view: RunView): string[] {
  return typesOf(view).filter((type) => type === 'rebate_quote' || type === 'order_status');
}

it.each([
  ['输入审核拦截', 'agent.refuse.unsafe', 'safety'],
  ['拒答预判', 'agent.refuse.advice', 'stop'],
  ['禁售判断', 'agent.refuse.prohibited', 'stop'],
] as const)(
  '[AC-B3-05q#13][BR-AI-01][BR-AI-18] %s先于按入口出卡（%s）：拒答时不出入口卡、不查 catalog、不读订单；同一条通过时才出入口卡',
  async (_step, textKey, finishReason) => {
    const question = '这个值得买吗';
    for (const context of [PRODUCT, ORDER]) {
      const passed = kit();
      ownOrder(passed);
      const ok = await passed.run(question, { caller: MEMBER, context });
      expect(entryCards(ok), JSON.stringify(context)).toHaveLength(1);

      const h = kit();
      ownOrder(h);
      h.state.refusal = { textKey, finishReason };
      const view = await h.run(question, { caller: MEMBER, context });
      expect(view.result).toEqual({ kind: 'done', finishReason });
      expect(view.cards).toEqual([]);
      expect(view.text).toBe(copy(textKey));
      expect(h.readProduct).not.toHaveBeenCalled();
      expect(h.assemble).not.toHaveBeenCalled();
      expect(personalReads(h)).toBe(0);
      expect(h.complete).not.toHaveBeenCalled();
    }
  },
);

it.each([
  ['链接', LINK],
  ['口令', TOKEN],
] as const)(
  '[AC-B3-05q#14][BR-AI-01][BR-AI-04] 本条自带%s时按链接消息处理、context.product_key 不用：只出链接那件商品的报价卡，不查入口商品；同一 context 不带链接时才出入口商品的卡',
  async (_what, material) => {
    const plain = kit();
    const entry = await plain.run('这个怎么样', { caller: MEMBER, context: PRODUCT });
    expect(quotedKeys(entry)).toEqual([ENTRY_KEY]);

    const h = kit();
    const view = await h.run(`这个怎么样 ${material}`, { caller: MEMBER, context: PRODUCT });
    expect(view.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(quotedKeys(view)).toEqual([LINK_KEY]);
    expect(h.resolveLink).toHaveBeenCalledTimes(1);
    expect(h.readProduct).not.toHaveBeenCalled();
    expect(h.searchProducts).not.toHaveBeenCalled();
  },
);

it.each([
  ['链接', LINK],
  ['口令', TOKEN],
] as const)(
  '[AC-B3-05q#15][BR-AI-01][BR-AI-07] 本条自带%s时按链接消息处理、context.order_id 不用：只出链接那件商品的报价卡，不读入口订单；同一 context 不带链接时才出这笔订单的卡',
  async (_what, material) => {
    const plain = kit();
    ownOrder(plain);
    const entry = await plain.run('这单返了吗', { caller: MEMBER, context: ORDER });
    expect(typesOf(entry)).toEqual(['order_status']);

    const h = kit();
    ownOrder(h);
    const view = await h.run(`这单返了吗 ${material}`, { caller: MEMBER, context: ORDER });
    expect(view.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(quotedKeys(view)).toEqual([LINK_KEY]);
    expect(typesOf(view)).not.toContain('order_status');
    expect(personalReads(h)).toBe(0);
    expect(h.readProduct).not.toHaveBeenCalled();
  },
);
