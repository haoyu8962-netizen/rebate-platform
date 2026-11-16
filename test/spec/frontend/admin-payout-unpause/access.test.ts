// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { TAB, openTab } from '../admin-payouts-readonly/helpers.ts';
import {
  ALL,
  ENTRY,
  PAUSE,
  RESUME,
  SUPER,
  SUPER_GRANTS,
  SWITCHER,
  SWITCHER_GRANTS,
  SWITCH_ALL_GRANTS,
  accountOf,
  failedWith,
  overview,
  pausedOverview,
  resumeChannel,
  type Grants,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  MULTI_TIMEOUT,
  buttons,
  channelCard,
  click,
  entryFor,
  isShown,
  listReads,
  main,
  mount,
  openPanel,
  overviewReads,
  pauseNames,
  pressables,
  scriptRead,
  serverFor,
  settled,
} from './helpers.ts';

// F1-08bd ①: the pause entries follow the overview and the permission points of adminUpdate
// KillSwitch (payout.queue_paused, payout.channel_paused.<channel>: switch.payout or switch.all; a
// super admin holds every point). While queue_paused=false the title row has 【暂停队列】, while it
// is true 【解除暂停】 (never both). Each channel card whose channel is paused has one 【解除通道暂停】
// (channel and queue pauses are lifted separately, BR-WDR-33 ①); a channel that is not paused has
// none, and nothing offers to pause a channel (the system sets it) or to change 开通 / 打款开关 (not
// on this page). Entries are hidden, not disabled, when they do not apply. Opening the tab sends
// only GETs and does not read the switch list yet.

/** Words of entries this page must not have: channel pause, 开通 / 打款开关 writes. */
const NOT_HERE = /暂停通道|开通|开启|启用|停用|打款开关/;

it(
  '[AC-F1-08bd-ACCESS#1] 持 fund.view + switch.payout：队列运行时标题行恰有一个可用的【暂停队列】、没有【解除暂停】；队列暂停时恰有【解除暂停】、没有【暂停队列】；只有暂停的通道卡上各有一个【解除通道暂停】，未暂停的通道卡上没有任何按钮；没有暂停通道、开通或打款开关的入口；进页只发 GET、不读开关列表',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const scenarios = [
      {
        view: overview(),
        names: [ENTRY.pause, ENTRY.channel].sort(),
        queue: PAUSE,
        cards: { alipay: [], bank_card: [], wechat: [ENTRY.channel] },
      },
      {
        view: pausedOverview(),
        names: [ENTRY.resume, ENTRY.channel, ENTRY.channel].sort(),
        queue: RESUME,
        cards: { alipay: [ENTRY.channel], bank_card: [], wechat: [ENTRY.channel] },
      },
    ];
    for (const scenario of scenarios) {
      const server = serverFor({ overview: scenario.view });
      const panel = await openPanel(server, SWITCHER);
      await settled(server);
      expect(pauseNames(), 'the pause entries of the page').toEqual(scenario.names);
      entryFor(panel, scenario.queue);
      const other = scenario.queue === PAUSE ? ENTRY.resume : ENTRY.pause;
      expect(buttons(main(), other), `no ${other}, not even hidden`).toEqual([]);
      for (const channel of ['alipay', 'bank_card', 'wechat'] as const) {
        const names = pressables(channelCard(panel, channel));
        expect(names, `the buttons of the ${channel} card`).toEqual(scenario.cards[channel]);
        if (names.length > 0) entryFor(panel, resumeChannel(channel));
      }
      const wrong = pressables(main()).filter((name) => NOT_HERE.test(name));
      expect(wrong, 'no channel pause, 开通 or 打款开关 entry').toEqual([]);
      expect(server.writes(), 'only GET on opening').toEqual([]);
      expect(listReads(server), 'the switch list is not read on opening').toEqual([]);
      cleanup();
    }
  },
);

interface Account {
  readonly snapshot: PermissionSnapshot;
  readonly grants: Grants;
  /** The pause entries of the page, sorted. */
  readonly names: readonly string[];
}

it(
  '[AC-F1-08bd-ACCESS#2] 入口按权限点 switch.payout / switch.all 判、不按角色判：队列与企业支付宝、微信零钱都暂停时，只持 fund.view、持 fund.view + payout.execute、持 fund.view + fund.cash_entry、持 fund.view + payout.execute + fund.cash_entry、持除开关外的全部财务权限点、持 fund.view + switch.pay，都没有【暂停队列】【解除暂停】【解除通道暂停】（含隐藏、置灰）；持 fund.view + switch.payout、持 fund.view + switch.all 与超管都恰有【解除暂停】与两个【解除通道暂停】；只发 GET',
  { timeout: 3 * MULTI_TIMEOUT },
  async () => {
    const all = [ENTRY.resume, ENTRY.channel, ENTRY.channel].sort();
    const without = (grants: Grants): Account => ({
      snapshot: accountOf(grants),
      grants,
      names: [],
    });
    const accounts: readonly Account[] = [
      without(['fund.view']),
      without(['fund.view', 'payout.execute']),
      without(['fund.view', 'fund.cash_entry']),
      without(['fund.view', 'payout.execute', 'fund.cash_entry']),
      without([...ALL, 'fund.cash_entry']),
      without(['fund.view', 'switch.pay']),
      { snapshot: SWITCHER, grants: SWITCHER_GRANTS, names: all },
      { snapshot: accountOf(SWITCH_ALL_GRANTS), grants: SWITCH_ALL_GRANTS, names: all },
      { snapshot: SUPER, grants: SUPER_GRANTS, names: all },
    ];
    for (const account of accounts) {
      const server = serverFor({ overview: pausedOverview(), permissions: account.grants });
      await openPanel(server, account.snapshot);
      await settled(server);
      const who = account.snapshot.isSuper ? 'a super admin' : account.grants.join(' + ');
      expect(pauseNames(), `the pause entries for ${who}`).toEqual(account.names);
      expect(server.writes(), `${who}: only GET`).toEqual([]);
      expect(listReads(server), `${who}: the switch list is not read on opening`).toEqual([]);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08bd-ACCESS#3] 打款概览读取失败时（不知道队列与通道是否暂停）没有【暂停队列】【解除暂停】【解除通道暂停】；点【重试】读到概览后才出现对应入口',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor({ overview: pausedOverview() });
    scriptRead(server, () => failedWith(50001));
    await mount(server, SWITCHER);
    await openTab(TAB.queue);
    await waitFor(() => expect(overviewReads(server)).toHaveLength(1));
    await settled(server);
    expect(pauseNames(), 'no pause entry without an overview').toEqual([]);
    const retry = await waitFor(() => {
      const found = buttons(main(), '重试').filter(isShown);
      expect(found, 'one 【重试】 of the overview').toHaveLength(1);
      return found[0]!;
    });
    await click(retry);
    await waitFor(() => expect(overviewReads(server)).toHaveLength(2));
    await settled(server);
    await waitFor(() =>
      expect(pauseNames()).toEqual([ENTRY.resume, ENTRY.channel, ENTRY.channel].sort()),
    );
    expect(server.writes(), 'only GET').toEqual([]);
  },
);
