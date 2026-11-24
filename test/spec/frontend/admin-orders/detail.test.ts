// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BENEFICIARY,
  DETAIL,
  LIST,
  NUMBER,
  PARENT,
  ROUTE,
  RULE,
  UID,
  createServer,
  detail,
  failure,
  rows,
} from './orders-fixtures.ts';
import {
  FLOW_TIMEOUT,
  button,
  click,
  fill,
  loaded,
  mainElement,
  mount,
  openDetail,
  queries,
  query,
  readOnly,
  section,
  select,
  settled,
  textbox,
  time,
} from './orders-helpers.ts';

it(
  '[AC-F1-07e-DETAIL#1] 详情直达及刷新都仅取该订单，在主内容区展示基本信息和归属信息',
  async () => {
    const first = await mount(createServer(), ROUTE);
    await loaded();
    await settled(first.server);
    expect(window.location.pathname).toBe(ROUTE);
    expect(first.server.requests('GET', DETAIL)).toHaveLength(1);
    expect(first.server.requests('GET', LIST)).toHaveLength(0);
    expect(first.server.requests('GET', DETAIL)[0]!.query).toEqual({});
    for (const text of [
      NUMBER,
      PARENT,
      '61234',
      '12,345.67',
      '1,234.56',
      '1,123.45',
      '2026-10-07',
      '01:05',
      '2026-11',
    ])
      expect(section('基本信息').textContent).toContain(text);
    for (const text of [UID, '138****5678', 'self', 'param', 'claim'])
      expect(section('归属信息').textContent).toContain(text);
    expect(first.directFetch).not.toHaveBeenCalled();
    first.unmount();
    const refreshed = await mount(createServer(), ROUTE);
    await loaded();
    await settled(refreshed.server);
    expect(window.location.pathname).toBe(ROUTE);
    expect(refreshed.server.requests('GET', DETAIL)).toHaveLength(1);
    expect(refreshed.server.requests('GET', LIST)).toHaveLength(0);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07e-DETAIL#2] 状态卡呈现平台、返利、用户侧显示，两个锁定标记在同一卡片并列',
  async () => {
    await mount(createServer(), ROUTE);
    await loaded();
    const status = within(mainElement()).queryByText('已锁定', { exact: true });
    const attribution = within(mainElement()).queryByText('归属已锁定', { exact: true });
    expect(status).not.toBeNull();
    expect(attribution).not.toBeNull();
    const card = status!.closest<HTMLElement>('.ant-card, section, [role="region"]');
    expect(card).not.toBeNull();
    expect(card!.contains(attribution)).toBe(true);
    for (const text of ['平台状态', '返利状态', '用户侧显示', 'SETTLED', 'CREDITED'])
      expect(card!.textContent).toContain(text);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07e-DETAIL#3] 暂停原因与用户侧状态照服务端显示，不以返利状态自行推导或混淆锁定标记',
  async () => {
    const server = createServer(
      undefined,
      detail({
        platform_status: 'PAID',
        rebate_status: 'ESTIMATED',
        display_status: 'REVIEWING',
        hold_reason: 'CS',
        flags: { locked: true, status_locked: false, rights_pending: true, hold: true },
      }),
    );
    const held = await mount(server, ROUTE);
    await loaded();
    expect(mainElement().textContent).toContain('REVIEWING');
    expect(mainElement().textContent).toContain('CS');
    expect(within(mainElement()).queryAllByText('维权中', { exact: true }).length).toBeGreaterThan(
      0,
    );
    expect(within(mainElement()).queryByText('归属已锁定', { exact: true })).not.toBeNull();
    expect(within(mainElement()).queryByText('已锁定', { exact: true })).toBeNull();
    held.unmount();
    await mount(createServer(), ROUTE);
    await loaded();
    expect(mainElement().textContent).not.toContain('CS');
    expect(within(mainElement()).queryAllByText('维权中', { exact: true })).toHaveLength(0);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07e-DETAIL#4] 分佣快照金额按分转元，万分之一比例显示两位百分比并保留受益人与没收原因',
  async () => {
    await mount(createServer(), ROUTE);
    await loaded();
    const snapshot = section('分佣快照');
    for (const text of [
      RULE,
      'self',
      '1,234.56',
      '1.01',
      '12.34%',
      '152.34',
      '1.02',
      '1,082.21',
      '324.67',
      '2026-10-08',
      '09:30',
    ])
      expect(snapshot.textContent).toContain(text);
    const beneficiaries = within(snapshot).queryAllByRole('row');
    const own = beneficiaries.find((node) => node.textContent?.includes(UID));
    const direct = beneficiaries.find((node) => node.textContent?.includes(BENEFICIARY));
    expect(own).toBeDefined();
    expect(direct).toBeDefined();
    expect(own!.textContent).toContain('60.00%');
    expect(own!.textContent).toContain('self');
    expect(direct!.textContent).toContain('10.00%');
    expect(direct!.textContent).toContain('direct');
    expect(direct!.textContent).toContain('banned');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07e-DETAIL#5] 状态历史和转链记录展示每条时间及契约内容，不渲染原始报文，写操作只有已接入的入口',
  async () => {
    const { expectWriteEntries } = await import('../admin-orders-writes/kit.ts');
    const { server } = await mount(createServer(undefined, detail({ reason: 'REFUND' })), ROUTE, {
      isSuper: true,
      permissions: [],
    });
    await loaded();
    const history = section('状态历史');
    for (const text of [
      'P2',
      'PAID',
      'sync',
      '01:06',
      'R3',
      'UNATTRIBUTED',
      'ESTIMATED',
      'claim',
      '09:30',
      'R5',
      'WAITING',
      'CREDITED',
      'system',
      '12:15',
    ])
      expect(history.textContent).toContain(text);
    const logs = section('转链记录');
    const records = within(logs).queryAllByRole('row');
    const opened = records.find((node) => node.textContent?.includes('open'));
    const converted = records.find((node) => node.textContent?.includes('convert'));
    expect(opened).toBeDefined();
    expect(converted).toBeDefined();
    expect(opened!.textContent).toContain('detail');
    expect(opened!.textContent).toContain('2026-10-07');
    expect(opened!.textContent).toContain('01:04');
    expect(converted!.textContent).toContain('search');
    expect(converted!.textContent).toContain('01:03');
    expectWriteEntries(server, ['原因细分']);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07e-DETAIL#6] 未归因订单及尚无快照、历史、转链的区块如实显示为空，零值仍可见',
  async () => {
    const server = createServer(
      undefined,
      detail({
        user: null,
        display_status: null,
        user_basis: null,
        buy_type: null,
        scene_basis: null,
        platform_status: 'RECEIVED',
        rebate_status: 'UNATTRIBUTED',
        commission_split: null,
        status_history: [],
        link_logs: [],
        pay_amount_fen: 0,
        est_commission_fen: 0,
        settle_commission_fen: null,
        flags: rows()[1]!.flags,
      }),
    );
    await mount(server, ROUTE);
    await loaded();
    expect(section('归属信息').textContent).toContain('未归因');
    expect(section('归属信息').textContent).not.toContain(UID);
    expect(section('基本信息').textContent).toContain('0.00');
    expect(section('分佣快照').textContent).toMatch(/暂无|尚未|未生成/);
    expect(section('状态历史').textContent).toMatch(/暂无|没有/);
    expect(section('转链记录').textContent).toMatch(/暂无|没有/);
    expect(mainElement().textContent).not.toMatch(/undefined|null/);
    readOnly(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07e-DETAIL#7] 未知或不可见 order_id 的 20001 提示不区分两者，不回退请求列表',
  async () => {
    const server = createServer();
    server.once('GET', DETAIL, () => failure(20001, { fields: ['order_id'] }, '参数错误'));
    await mount(server, ROUTE);
    await waitFor(() =>
      expect(mainElement().textContent).toMatch(/订单不存在.*(?:无权|不可见)|不存在或无权查看/),
    );
    await settled(server);
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
    expect(server.requests('GET', LIST)).toHaveLength(0);
    expect(mainElement().textContent).not.toContain(NUMBER);
    expect(mainElement().textContent).not.toContain('138****5678');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07e-DETAIL#8] 查询后进入详情再返回保留已应用筛选，表单与恢复的请求一致',
  async () => {
    const { server } = await mount();
    await loaded();
    await select(/^平台$/, /拼多多|pdd/);
    await select(/^返利状态/, 'CREDITED');
    await select(/^平台状态/, 'SETTLED');
    await select(/^订单标记/, '归属已锁定');
    await fill(textbox(/^订单号/), NUMBER);
    await fill(textbox(/^用户/), UID);
    await time(/开始日期|起始日期|开始时间|起始时间|付款时间.*开始/, '2026-10-01');
    await time(/结束日期|结束时间|付款时间.*结束/, '2026-10-07');
    await query();
    await waitFor(() => expect(queries(server)).toHaveLength(2));
    await settled(server);
    const applied = queries(server)[1];
    expect(Date.parse(applied!['paid_from']!)).toBe(Date.parse('2026-10-01T00:00:00+08:00'));
    expect(Date.parse(applied!['paid_to']!)).toBe(Date.parse('2026-10-08T00:00:00+08:00'));
    await openDetail();
    await waitFor(() => expect(mainElement().textContent).toContain('分佣快照'));
    const count = queries(server).length;
    await click(button(mainElement(), /返回/));
    await waitFor(() => expect(window.location.pathname).toBe('/orders'));
    await loaded();
    await settled(server);
    expect((textbox(/^订单号/) as HTMLInputElement).value).toBe(NUMBER);
    expect((textbox(/^用户/) as HTMLInputElement).value).toBe(UID);
    // A cached restore is allowed; any refetch must retain exactly the applied conditions.
    for (const restored of queries(server).slice(count)) expect(restored).toEqual(applied);
    const beforeQuery = queries(server).length;
    await query();
    await waitFor(() => expect(queries(server)).toHaveLength(beforeQuery + 1));
    await settled(server);
    expect(queries(server).at(-1)).toEqual(applied);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07e-DETAIL#9] 只有订单状态锁定时不误显示归属锁定',
  async () => {
    const server = createServer(
      undefined,
      detail({
        flags: { locked: false, status_locked: true, rights_pending: false, hold: false },
      }),
    );
    await mount(server, ROUTE);
    await loaded();
    expect(within(mainElement()).queryByText('已锁定', { exact: true })).not.toBeNull();
    expect(within(mainElement()).queryByText('归属已锁定', { exact: true })).toBeNull();
  },
  FLOW_TIMEOUT,
);
