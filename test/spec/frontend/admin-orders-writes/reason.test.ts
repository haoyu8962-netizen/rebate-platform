// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { settled } from '../admin-orders/orders-helpers.ts';
import { SUB_REASON_LABEL, choose, open, renderOrder, submit } from './flows.ts';
import { createWriteServer, expectOrderPosts, order, writes } from './kit.ts';

const NONE = { code: 'none', label: '无' };
const REFUND = [
  { code: 'IN_SALE', label: /售中退款|IN_SALE/ },
  { code: 'AFTER_SETTLE', label: /结算后退款|AFTER_SETTLE/ },
] as const;
const RIGHTS = { code: 'AFTER_SALE', label: /售后退款|AFTER_SALE/ };
const PUNISH = [
  { code: 'FAKE_TRADE', label: /虚假交易|FAKE_TRADE/ },
  { code: 'VIOLATION_PROMO', label: /违规推广|VIOLATION_PROMO/ },
  { code: 'SHOP_TK', label: /店铺淘宝客|SHOP_TK/ },
  { code: 'INSITE_PROMO', label: /站内推广|INSITE_PROMO/ },
  { code: 'PROXY_BUY', label: /违规代购|PROXY_BUY/ },
  { code: 'INSITE_RESALE', label: /站内二次售卖|INSITE_RESALE/ },
  { code: 'OVER_LIMIT', label: /累计超出上限|OVER_LIMIT/ },
  { code: 'MARKET_DISRUPT', label: /扰乱市场秩序|MARKET_DISRUPT/ },
  { code: 'MULTI_TRADE_ABNORMAL', label: /多笔交易异常|MULTI_TRADE_ABNORMAL/ },
  { code: 'SINGLE_TRADE_ABNORMAL', label: /单笔交易异常|SINGLE_TRADE_ABNORMAL/ },
  { code: 'RISK_ORDER', label: /风险订单|RISK_ORDER/ },
  { code: 'PUNISH_ORDER', label: /处罚订单|PUNISH_ORDER/ },
] as const;

it('[AC-F1-07ee-REASON#1] 退款只可选两个退款子原因或无，按当前版本提交并显示更新后的子原因', async () => {
  const shown = order();
  const server = createWriteServer(shown);
  server.succeed('reason-sub', { ...shown, reason_sub: 'AFTER_SETTLE', row_version: 20 });
  await renderOrder(server, 'order.claim');
  const form = await open('reason-sub');
  await choose(form, SUB_REASON_LABEL, REFUND[1], [...REFUND, NONE]);
  await submit(form);
  await waitFor(() => expect(screen.getByRole('main').textContent).toMatch(REFUND[1].label));
  expect(screen.getByRole('main').textContent).toContain('REFUND');
  expect(screen.getByRole('main').textContent).not.toMatch(REFUND[0].label);
  await settled(server);
  expectOrderPosts(server, 'reason-sub', {
    reason_sub: 'AFTER_SETTLE',
    expected_row_version: shown.row_version,
  });
  expect(writes(server)).toHaveLength(1);
}, 40_000);

it('[AC-F1-07ee-REASON#2] 维权只可选售后退款或无，选无向接口发送 none 并清掉原子原因', async () => {
  const shown = order({ reason: 'RIGHTS', reason_sub: 'AFTER_SALE' });
  const server = createWriteServer(shown);
  server.succeed('reason-sub', { ...shown, reason_sub: null, row_version: 20 });
  await renderOrder(server, 'order.claim');
  expect(screen.getByRole('main').textContent).toMatch(RIGHTS.label);
  const form = await open('reason-sub');
  await choose(form, SUB_REASON_LABEL, NONE, [RIGHTS, NONE]);
  await submit(form);
  await waitFor(() => expect(screen.getByRole('main').textContent).not.toMatch(RIGHTS.label));
  expect(screen.getByRole('main').textContent).toContain('RIGHTS');
  await settled(server);
  expectOrderPosts(server, 'reason-sub', {
    reason_sub: 'none',
    expected_row_version: shown.row_version,
  });
  expect(writes(server)).toHaveLength(1);
}, 40_000);

it('[AC-F1-07ee-REASON#3] 处罚原因只提供契约中的十二项处罚子原因和无', async () => {
  const shown = order({
    reason: 'PUNISH',
    reason_sub: 'PUNISH_ORDER',
    rebate_status: 'CLAWED_BACK',
  });
  const server = createWriteServer(shown);
  await renderOrder(server, 'order.claim');
  const form = await open('reason-sub');
  await choose(form, SUB_REASON_LABEL, PUNISH[0], [...PUNISH, NONE]);
  expect(writes(server)).toEqual([]);
}, 40_000);
