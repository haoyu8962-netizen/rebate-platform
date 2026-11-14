// @vitest-environment jsdom
import { cleanup } from '@testing-library/react';
import { expect, it } from 'vitest';
import { CASHIER, CASHIER_GRANTS, ENTRY, EXECUTOR, VIEWER, type Grants } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  MULTI_TIMEOUT,
  buttons,
  channelCard,
  entryNames,
  entryOf,
  isShown,
  openPanel,
  serverFor,
  settled,
  squash,
} from './helpers.ts';

// F1-08bc ①: the entries are offered only to an account holding fund.cash_entry (adminCreatePayout
// Watermark: permission point fund.cash_entry): 【录入企业支付宝余额】 once on the page, and
// 【录入运营账户余额】 on the 微信零钱 channel card. The bank card channel has no entry (the contract's
// AdminPayoutWatermarkChannel is alipay or wechat; bank_card opens with its channel, D10-592). An
// account with fund.view, or fund.view + payout.execute, gets no entry at all, shown or hidden.
// Opening the tab sends nothing but GET.

/** Names (spaces removed) of the buttons and links of `root` starting with 录入. */
function entriesIn(root: HTMLElement): string[] {
  const nodes = Array.from(root.querySelectorAll('button, a, [role="button"], [role="link"]'));
  return nodes.map((node) => squash(node.textContent)).filter((name) => name.startsWith('录入'));
}

it(
  '[AC-F1-08bc-ACCESS#1] 持 fund.view + fund.cash_entry：页面有且只有一个可用的【录入企业支付宝余额】，微信零钱通道卡上有一个【录入运营账户余额】，银行卡通道卡没有录入入口；页面上的录入入口只有这两个，进页只发 GET',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openPanel(server, CASHIER);
    entryOf(ENTRY.alipay);
    entryOf(ENTRY.wechat);
    const onCard = buttons(channelCard(panel, 'wechat'), ENTRY.wechat).filter(isShown);
    expect(onCard, `${ENTRY.wechat} on the 微信零钱 card`).toHaveLength(1);
    expect(entriesIn(channelCard(panel, 'bank_card')), 'no entry on the bank card').toEqual([]);
    const wanted = [ENTRY.alipay, ENTRY.wechat].sort();
    expect(entryNames().sort(), 'the only 录入 entries of the page').toEqual(wanted);
    await settled(server);
    expect(server.writes(), 'only GET on opening').toEqual([]);
  },
);

interface Account {
  readonly snapshot: typeof VIEWER;
  readonly grants: Grants;
  /** The 录入 entries of the page, sorted. */
  readonly names: readonly string[];
}

it(
  '[AC-F1-08bc-ACCESS#2] 入口只认 fund.cash_entry：持 fund.view + fund.cash_entry 时两个入口都在；只持 fund.view、或持 fund.view + payout.execute 时没有【录入企业支付宝余额】【录入运营账户余额】（含隐藏、置灰），概览照常显示，只发 GET',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const accounts: readonly Account[] = [
      { snapshot: CASHIER, grants: CASHIER_GRANTS, names: [ENTRY.alipay, ENTRY.wechat].sort() },
      { snapshot: VIEWER, grants: ['fund.view'], names: [] },
      { snapshot: EXECUTOR, grants: ['fund.view', 'payout.execute'], names: [] },
    ];
    for (const account of accounts) {
      const server = serverFor({ permissions: account.grants });
      await openPanel(server, account.snapshot);
      await settled(server);
      const label = `the 录入 entries for ${account.grants.join(' + ')}`;
      expect(entryNames().sort(), label).toEqual(account.names);
      expect(server.writes(), 'only GET').toEqual([]);
      cleanup();
    }
  },
);
