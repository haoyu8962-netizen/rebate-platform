// B3-08m · BR-AI-07 T5 / BR-TEXT-22 (Codex money r1 S1): every order summary key the core may write
// reads the contract copy when it has one, else the 08 package default
// 「{BR-TEXT-02 状态文案或 BR-TEXT-05 标题}，详情见卡片。」 with one agent.template_missing warning;
// never the key itself.
import { display_status, order_reason } from '@couli/contracts-ts';
import { expect, it, vi } from 'vitest';
import { productionRunTexts } from './production.ts';
import { agentTextIfPresent } from './texts.ts';

/** BR-TEXT-05 默认标题 (08 12_TEXT, SPEC_REF). */
const TITLES: Readonly<Record<string, string>> = {
  REFUND: '订单已退款或取消',
  PART_REFUND: '部分退款',
  RIGHTS: '发起售后维权，返利取消',
  PUNISH: '订单被联盟判定违规',
  PRICE_COMPARE: '比价订单',
  PRICE_PROTECT: '商家价保退差',
  SETTLE_DIFF: '结算金额调整',
  NOT_TRACKED: '未找到这笔订单的返利记录',
  EXPIRED_CLICK: '下单时链接已过期',
  RELATION_INVALID: '淘宝授权未完成或已失效',
  OTHER_TLJ: '订单归其他推广者',
  BLACKLIST: '订单未通过安全校验',
  PRESALE_UNPAID: '预售尾款未付',
  COMMISSION_ZERO: '返利已取消',
  OTHER: '其他原因',
};

/** BR-TEXT-02 状态文案 (08 12_TEXT, SPEC_REF); CREDITED_PART_CLAWED's carries an amount. */
const STATUSES: Readonly<Record<string, string>> = {
  DEPOSIT_PAID: '已付定金',
  PAID: '已付款，返利待确认',
  WAITING: '已收货，等待联盟结算',
  CREDITING: '入账核对中',
  RIGHTS_PENDING: '售后处理中，入账暂停',
  REVIEWING: '入账核对中',
  NO_REBATE: '本单无返利',
  CREDITED: '已结算',
  INVALID: '已失效',
  CLAWED_BACK: '已扣回',
};

const ONE_ORDER = '找到 1 笔订单，详情见卡片。';

function texts() {
  const warn = vi.fn();
  return { warn, texts: productionRunTexts(async () => [], { warn }) };
}

it('[AC-B3-08m#3][BR-AI-07] every order_reason code: contract copy, else the BR-TEXT-05 title + 「，详情见卡片。」 with agent.template_missing; never the literal key', async () => {
  const contract = agentTextIfPresent('order_list.summary');
  expect(contract).toBe('找到 {n} 笔订单，详情见卡片。');
  for (const code of order_reason) {
    const key = `order_reason.${code}.summary`;
    const t = texts();
    const text = await t.texts.text('synthetic-app', key);
    expect(text, key).not.toBe(key);
    expect(text, key).not.toMatch(/[{}]/u);
    const configured = agentTextIfPresent(key);
    if (configured !== undefined) {
      expect(text, key).toBe(configured);
      expect(t.warn, key).not.toHaveBeenCalled();
      continue;
    }
    const title = TITLES[code];
    expect(text, key).toBe(title === undefined ? ONE_ORDER : `${title}，详情见卡片。`);
    expect(t.warn, key).toHaveBeenCalledTimes(1);
    expect(t.warn.mock.calls[0]?.[1], key).toBe('agent.template_missing');
  }
});

it('[AC-B3-08m#3][BR-AI-07] REFUND without contract copy → 「订单已退款或取消，详情见卡片。」(08 example, AC-S1-44 ②); NOT_TRACKED → 「未找到这笔订单的返利记录，详情见卡片。」', async () => {
  expect(agentTextIfPresent('order_reason.REFUND.summary')).toBeUndefined();
  const t = texts();
  expect(await t.texts.text('a', 'order_reason.REFUND.summary')).toBe(
    '订单已退款或取消，详情见卡片。',
  );
  expect(await t.texts.text('a', 'order_reason.NOT_TRACKED.summary')).toBe(
    '未找到这笔订单的返利记录，详情见卡片。',
  );
});

it('[AC-B3-08m#3][BR-AI-07] every display_status: contract copy, else the BR-TEXT-02 status text + 「，详情见卡片。」; CREDITED_PART_CLAWED (amount in its text) and an unknown code never show the key', async () => {
  for (const code of display_status) {
    const key = `order_status.${code}.summary`;
    const text = await texts().texts.text('synthetic-app', key);
    expect(text, key).not.toBe(key);
    expect(text, key).not.toMatch(/[{}]/u);
    const configured = agentTextIfPresent(key);
    if (configured !== undefined) expect(text, key).toBe(configured);
    else if (code === 'CREDITED_PART_CLAWED') expect(text, key).toBe(ONE_ORDER);
    else expect(text, key).toBe(`${STATUSES[code]!}，详情见卡片。`);
  }
  const unknown = await texts().texts.text('a', 'order_status.SOMETHING_NEW.summary');
  expect(unknown).toBe('状态更新中，详情见卡片。');
});

it('[AC-B3-08m#1][BR-AI-07] the other template keys the core writes come from the contract copy', async () => {
  for (const key of [
    'order_list.summary',
    'order_list.empty',
    'agent.order.lookup_limited',
    'agent.rule.found',
    'agent.rule.not_found',
  ]) {
    const t = texts();
    const configured = agentTextIfPresent(key);
    expect(configured, key).toBeDefined();
    expect(await t.texts.text('a', key), key).toBe(configured);
    expect(t.warn, key).not.toHaveBeenCalled();
  }
});
