// @vitest-environment jsdom
// F1-08fa 菜单与直达（任务依据摘录 第 1、2 条）：持 fund.view 在「资金 / 余额流水」进入；契约
// 允许 fund.view 或 user.lookup 读，只持 user.lookup 直达 /ledger 也照常可用（菜单仍按 resources
// 现有登记，不出现）；两者都没有时直达显示无权限、不发请求。进入时只有 UID 输入，不先发请求。
import { expect, it } from 'vitest';
import {
  COPY,
  FILTER_LABEL,
  LOOKUP_ONLY,
  NO_READ,
  PAGE_SIZE,
  SUPER,
  UID,
  createServer,
  summaryPath,
  summaryShown,
} from './fixtures.ts';
import {
  breadcrumb,
  inputsLabelled,
  main,
  mountLedger,
  pageTitle,
  queryUser,
  settled,
  shows,
  sidebarLinks,
  summaryPairs,
  tableCount,
  uidInput,
} from './helpers.ts';

it(
  '[AC-F1-08fa-MENU#1] 持 fund.view 直达 /ledger：侧栏「余额流水」高亮、面包屑「资金 / 余额流水」、页标题「余额流水」，只有 UID 输入，没有摘要、筛选与表格，不发任何请求',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    await settled(server);
    const links = sidebarLinks(COPY.title);
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('/ledger');
    expect(links[0]!.getAttribute('aria-current')).toBe('page');
    expect(breadcrumb()).toEqual(['资金', '余额流水']);
    expect(pageTitle()).toBe(COPY.title);
    expect(uidInput().value).toBe('');
    expect(summaryPairs()).toEqual([]);
    expect(tableCount()).toBe(0);
    for (const label of Object.values(FILTER_LABEL))
      expect(inputsLabelled(main(), label), label).toEqual([]);
    expect(server.log).toEqual([]);
  },
);

it(
  '[AC-F1-08fa-MENU#2] 只持 user.lookup：侧栏没有「余额流水」，直达 /ledger 照常显示 UID 输入，【查询】读该用户的资金摘要与流水第 1 页',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: ['user.lookup'] });
    await mountLedger(server, LOOKUP_ONLY);
    await settled(server);
    expect(sidebarLinks(COPY.title)).toEqual([]);
    expect(pageTitle()).toBe(COPY.title);
    expect(server.log).toEqual([]);
    await queryUser(server, UID);
    expect(server.summaryReads().map((read) => [read.path, read.query])).toEqual([
      [summaryPath(UID), {}],
    ]);
    expect(server.ledgerQueries()).toEqual([{ user_id: UID, page: '1', page_size: PAGE_SIZE }]);
    expect(summaryPairs()).toEqual(summaryShown(UID));
  },
);

it(
  '[AC-F1-08fa-MENU#3] 既无 fund.view 也无 user.lookup：直达 /ledger 显示无权限标题与说明，没有 UID 输入，不发任何请求',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: ['order.view'] });
    await mountLedger(server, NO_READ);
    await settled(server);
    expect(sidebarLinks(COPY.title)).toEqual([]);
    expect(shows(main(), COPY.forbiddenTitle), COPY.forbiddenTitle).toBe(true);
    expect(shows(main(), COPY.forbiddenDescription), COPY.forbiddenDescription).toBe(true);
    expect(inputsLabelled(main(), COPY.uidLabel)).toEqual([]);
    expect(tableCount()).toBe(0);
    expect(server.log).toEqual([]);
  },
);

it(
  '[AC-F1-08fa-MENU#4] 超管：菜单可见，直达 /ledger 只有 UID 输入、不先发请求',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ isSuper: true });
    await mountLedger(server, SUPER);
    await settled(server);
    expect(sidebarLinks(COPY.title)).toHaveLength(1);
    expect(breadcrumb()).toEqual(['资金', '余额流水']);
    expect(uidInput().value).toBe('');
    expect(summaryPairs()).toEqual([]);
    expect(tableCount()).toBe(0);
    expect(server.log).toEqual([]);
  },
);
