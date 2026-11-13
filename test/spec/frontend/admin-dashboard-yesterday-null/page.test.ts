// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CARDS, createServer } from '../admin-dashboard/dashboard-fixtures.ts';
import {
  button,
  click,
  loaded,
  mainElement,
  mount,
  settled,
} from '../admin-dashboard/dashboard-helpers.ts';

beforeEach(() => {
  // 北京时间已到 10 月 12 日，UTC 仍是 11 日；只替换时钟，异步等待使用真实计时器。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-11T16:30:00Z'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

function overview(): HTMLElement {
  const heading = within(mainElement()).queryByRole('heading', { name: /昨日概览/ });
  expect(heading).not.toBeNull();
  const section = heading?.closest('section');
  expect(section).toBeInstanceOf(HTMLElement);
  return section!;
}

function expectOtherSections(): void {
  const main = within(mainElement());
  expect(main.queryByRole('heading', { name: '待办' })).not.toBeNull();
  for (const [, title, , route] of CARDS) {
    const link = main.queryByRole('link', { name: (name) => name.startsWith(`${title} `) });
    expect(link, title).not.toBeNull();
    expect(link?.getAttribute('href')).toBe(route);
  }
  expect(main.getByRole('link', { name: /^待审提现 / }).textContent).toContain('12');
  expect(main.queryByRole('heading', { name: '系统状态' })).not.toBeNull();
  expect(main.getByRole('link', { name: /打款队列.*进入打款队列/ }).textContent).toContain(
    '正常，未暂停',
  );
  expect(
    main.getByRole('link', { name: /企业支付宝余额 W.*进入平台资金台账/ }).textContent,
  ).toContain('未接入');
  expect(main.getByRole('link', { name: /月结自动结算.*进入紧急开关/ }).textContent).toContain(
    '已开放',
  );
  expect(main.queryByRole('button', { name: '重试' })).toBeNull();
  expect(mainElement().textContent).not.toContain('工作台数据加载失败');
}

function expectEmptyOverview(): void {
  const section = overview();
  expect(within(section).queryByText('暂无数据', { exact: true })).not.toBeNull();
  // 允许保留指标名称或占位符，但概览不能伪造任何数字（尤其是 0 / 0.00）。
  for (const content of section.querySelectorAll('.ant-statistic-content'))
    expect(content.textContent).not.toMatch(/\d/);
  expect(within(section).queryAllByText(/^\s*[\d,]+(?:\.\d+)?\s*$/)).toHaveLength(0);
  expect(section.textContent).not.toMatch(/1,780|268|1,236\.40|96/);
  expect(mainElement().textContent).not.toMatch(/截至|更新于|2026-10-12 00:07|undefined|NaN/);
  expectOtherSections();
}

function expectNumbers(date: string): void {
  const section = overview();
  expect(within(section).getByRole('heading', { name: /昨日概览/ }).textContent).toBe(
    `昨日概览（${date} 整日）`,
  );
  expect(within(section).queryByText('暂无数据', { exact: true })).toBeNull();
  const statistics = Array.from(section.querySelectorAll('.ant-statistic'));
  expect(statistics).toHaveLength(4);
  for (const [title, value] of [
    ['转链数', '1,780'],
    ['成交订单数', '268'],
    ['预估返利合计', '¥1,236.40'],
    ['新增用户', '96'],
  ] as const) {
    const statistic = statistics.find((node) => node.textContent?.includes(title));
    expect(statistic, title).toBeDefined();
    expect(statistic?.querySelector('.ant-statistic-content')?.textContent).toBe(value);
  }
}

it(
  '[AC-CT-24zzk-FE-NULL#1] 从未聚合时显示暂无数据，保留待办和系统状态且不伪造统计或聚合时间',
  { timeout: 40_000 },
  async () => {
    const server = createServer();
    server.state.yesterday = null;
    await mount(server);
    // 旧页面把 null 当成加载失败；这里应以缺少概览的断言失败，而非直接调用模型抛错。
    await loaded();
    await settled(server);
    expectEmptyOverview();
  },
);

it(
  '[AC-CT-24zzk-FE-DATE#1] 北京时间昨天的行正常显示，较早的行显示与标题同格式的数据截至日期',
  { timeout: 40_000 },
  async () => {
    const server = createServer();
    const yesterday = server.state.yesterday;
    expect(yesterday).not.toBeNull();
    yesterday!.as_of = '2026-10-11T16:07:00Z';
    await mount(server);
    await loaded();
    expectNumbers('2026-10-11');
    expect(mainElement().textContent).not.toContain('数据截至');
    expect(mainElement().textContent).toContain('2026-10-12 00:07');

    // 10 月 10 日恰是 UTC 的昨天，却早于北京时间的昨天，不能误判成最新日。
    yesterday!.date = '2026-10-10';
    yesterday!.as_of = '2026-10-10T16:07:00Z';
    await click(button(mainElement(), /^刷新$/));
    await waitFor(() =>
      expect(
        within(mainElement()).queryByText('数据截至 2026-10-10', { exact: true }),
      ).not.toBeNull(),
    );
    await settled(server);
    expectNumbers('2026-10-10');
    expect(mainElement().textContent).toContain('2026-10-11 00:07');
    expect(mainElement().textContent).not.toContain('2026-10-12 00:07');
    expectOtherSections();

    yesterday!.date = '2026-10-11';
    yesterday!.as_of = '2026-10-11T16:07:00Z';
    await click(button(mainElement(), /^刷新$/));
    await waitFor(() => expect(mainElement().textContent).not.toContain('数据截至'));
    await settled(server);
    expectNumbers('2026-10-11');
  },
);

it(
  '[AC-CT-24zzk-FE-REFRESH#1] 刷新后非空转 null 清除旧数字与时间，再次刷新恢复四项',
  { timeout: 40_000 },
  async () => {
    const server = createServer();
    const yesterday = server.state.yesterday;
    expect(yesterday).not.toBeNull();
    yesterday!.as_of = '2026-10-11T16:07:00Z';
    await mount(server);
    await loaded();
    expectNumbers('2026-10-11');

    server.state.yesterday = null;
    await click(button(mainElement(), /^刷新$/));
    await waitFor(() =>
      expect(within(mainElement()).queryByText('暂无数据', { exact: true })).not.toBeNull(),
    );
    await settled(server);
    expectEmptyOverview();

    server.state.yesterday = yesterday;
    await click(button(mainElement(), /^刷新$/));
    await waitFor(() => expectNumbers('2026-10-11'));
    await settled(server);
    expect(mainElement().textContent).toContain('2026-10-12 00:07');
    expect(mainElement().textContent).not.toContain('数据截至');
    expectOtherSections();
    expect(server.log).toHaveLength(3);
  },
);
