// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from './dashboard-fixtures.ts';
import { click, loaded, mainElement, mount } from './dashboard-helpers.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('[AC-F1-14a-YESTERDAY#1] 昨日四项独立数值与分转元两位小数、日期及北京时间聚合时刻', async () => {
  const server = createServer();
  server.state.yesterday = {
    date: '2026-09-30',
    links: 12345,
    orders: 23456,
    est_rebate_fen: 123456789,
    new_users: 34567,
    as_of: '2026-09-30T16:07:00Z',
  };
  await mount(server);
  await loaded();
  expect(within(mainElement()).getByRole('heading', { name: /昨日概览/ }).textContent).toContain(
    '2026-09-30',
  );
  expect(mainElement().textContent).toContain('2026-10-01 00:07');
  for (const [title, value] of [
    ['转链数', '12,345'],
    ['成交订单数', '23,456'],
    ['预估返利合计', '1,234,567.89'],
    ['新增用户', '34,567'],
  ]) {
    const statistics = Array.from(mainElement().querySelectorAll('.ant-statistic'));
    const statistic = statistics.find((node) => node.textContent?.includes(title!));
    expect(statistic, title).toBeDefined();
    expect(statistic!.textContent).toContain(value);
  }
});

it('[AC-F1-14a-YESTERDAY#2] 一分显示 0.01；昨日各项为零仍保留四项概览', async () => {
  const server = createServer();
  const yesterday = server.state.yesterday;
  expect(yesterday).not.toBeNull();
  Object.assign(yesterday!, { links: 0, orders: 0, est_rebate_fen: 1, new_users: 0 });
  await mount(server);
  await loaded();
  const stats = Array.from(mainElement().querySelectorAll('.ant-statistic'));
  for (const title of ['转链数', '成交订单数', '新增用户']) {
    const statistic = stats.find((node) => node.textContent?.includes(title));
    expect(statistic, title).toBeDefined();
    expect(statistic!.querySelector('.ant-statistic-content')?.textContent).toContain('0');
  }
  expect(stats.find((node) => node.textContent?.includes('预估返利合计'))?.textContent).toContain(
    '0.01',
  );
});

it('[AC-F1-14a-STATUS#1] 即便本地超管有 fund.view，响应不含 status 也不补系统状态区', async () => {
  const server = createServer();
  delete server.state.status;
  Object.assign(server.state, { todo: [] });
  await mount(server);
  await loaded();
  expect(mainElement().textContent).not.toMatch(/系统状态|打款队列|企业支付宝余额|月结自动结算/);
  expect(within(mainElement()).queryAllByRole('link')).toHaveLength(0);
});

it('[AC-F1-14a-STATUS#8] 本地只有 dashboard.view 但响应含 status，仍按服务端返回渲染三张状态卡', async () => {
  const server = createServer();
  Object.assign(server.state, { todo: [] });
  await mount(server, {
    permissionsProvider: async () => ({ isSuper: false, permissions: ['dashboard.view'] }),
  });
  await loaded();
  const main = within(mainElement());
  expect(main.queryByRole('heading', { name: /系统状态/ })).not.toBeNull();
  expect(main.queryAllByRole('link')).toHaveLength(3);
  expect(main.getByRole('link', { name: /打款队列.*进入打款队列/ }).textContent).toMatch(
    /正常|未暂停/,
  );
  expect(
    main.getByRole('link', { name: /企业支付宝余额 W.*进入平台资金台账/ }).textContent,
  ).toMatch(/未接入|未录入|暂无数据|未知/);
  expect(main.getByRole('link', { name: /月结自动结算.*进入紧急开关/ }).textContent).toMatch(
    /已开放|已开启|已启用/,
  );
});

for (const [index, sample] of [
  {
    paused: false,
    channels: [],
    expired: null,
    auto: true,
    queue: /正常|未暂停/,
    balance: /未接入|未录入|暂无数据|未知/,
    settle: /已开放|已开启|已启用/,
  },
  {
    paused: true,
    channels: ['bank_card', 'wechat', 'alipay'] as const,
    expired: true,
    auto: false,
    queue: /已暂停/,
    balance: /已过期/,
    settle: /已关闭|未开放|已停用/,
  },
  {
    paused: false,
    channels: ['bank_card'] as const,
    expired: false,
    auto: true,
    queue: /正常|未暂停/,
    balance: /未过期/,
    settle: /已开放|已开启|已启用/,
  },
].entries()) {
  it(`[AC-F1-14a-STATUS#${index + 2}] 三张状态卡反映队列、通道、W 与月结开关（组合 ${index + 1}）`, async () => {
    const server = createServer();
    Object.assign(server.state, { todo: [] });
    server.state.status = {
      payout_queue_paused: sample.paused,
      payout_channel_paused: [...sample.channels],
      balance_w_expired: sample.expired,
      settle_auto_enabled: sample.auto,
    };
    await mount(server);
    await loaded();
    const main = within(mainElement());
    expect(main.queryByRole('heading', { name: /系统状态/ })).not.toBeNull();
    expect(main.queryAllByRole('link')).toHaveLength(3);
    const queue = main.getByRole('link', { name: /打款队列.*进入打款队列/ });
    const balance = main.getByRole('link', { name: /企业支付宝余额 W.*进入平台资金台账/ });
    const settle = main.getByRole('link', { name: /月结自动结算.*进入紧急开关/ });
    expect(queue.textContent).toMatch(sample.queue);
    expect(balance.textContent).toMatch(sample.balance);
    expect(settle.textContent).toMatch(sample.settle);
    if (sample.expired === null) expect(balance.textContent).not.toMatch(/未过期|已过期|正常/);
    for (const [channel, label] of [
      ['bank_card', '银行卡'],
      ['wechat', '微信'],
      ['alipay', '支付宝'],
    ] as const) {
      if ((sample.channels as readonly string[]).includes(channel))
        expect(queue.textContent).toContain(label);
      else expect(queue.textContent).not.toContain(label);
    }
    if (sample.channels.length === 0) expect(queue.textContent).toMatch(/通道.*无|无.*通道/);
    expect(balance.getAttribute('href')).toBe('/fund-ledger');
    expect(settle.getAttribute('href')).toBe('/switches');
    expect(queue.getAttribute('href')).toMatch(/^\/(?:withdrawals|payout[^?]*)(?:[/?]|$)/);
  });
}

for (const [index, [name, destination]] of (
  [
    [/打款队列.*进入打款队列/, /打款队列|提现审核/],
    [/企业支付宝余额 W.*进入平台资金台账/, /平台资金台账/],
    [/月结自动结算.*进入紧急开关/, /紧急开关/],
  ] as const
).entries()) {
  it(`[AC-F1-14a-STATUS#${index + 5}] 状态卡链接 ${index + 1} 可进入对应页面或未接入占位页`, async () => {
    await mount();
    await loaded();
    const link = within(mainElement()).getByRole('link', { name });
    const target = link.getAttribute('href');
    expect(target).toMatch(/^\/(?!\/)/);
    await click(link);
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe(target));
    await waitFor(() =>
      expect(within(mainElement()).queryByRole('heading', { name: destination })).not.toBeNull(),
    );
    expect(within(mainElement()).queryByRole('heading', { name: /昨日概览/ })).toBeNull();
    if (index !== 2) expect(mainElement().textContent).toContain('尚未接入');
  });
}
