// @vitest-environment jsdom
// F1-10ka permissions and failures: both lists and the trace need agent.trace — without it the
// tab says there is no permission and sends nothing (agent.report alone shows the menu but no
// list); a 10403 from the server shows no permission without retrying by itself; a network failure
// offers 重试, which reads once more.
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  REPORTS,
  REPORT_ONLY,
  REPORT_ROW,
  SESSIONS,
  SID,
  createServer,
  denied,
  networkDown,
} from './fixtures.ts';
import {
  FORBIDDEN,
  HANDLE_ENTRY,
  LOAD_FAILED,
  RETRY,
  REPORTS_TAB,
  SESSIONS_TAB,
  actions,
  click,
  main,
  menuLink,
  mount,
  openTab,
  panel,
  rowsOf,
  rowsShown,
  settle,
  settled,
  squash,
  textOf,
  usable,
} from './helpers.ts';

it(
  '[AC-F1-10ka-ACCESS#1] 只持 agent.report（没有 agent.trace）：菜单可见，两个页签都显示无权限，不发任何 agent-traces 请求，也没有【标记已处理】',
  { timeout: 60_000 },
  async () => {
    const server = createServer(undefined, { permissions: REPORT_ONLY });
    await mount(server);
    await waitFor(() => expect(menuLink().getAttribute('aria-current')).toBe('page'));
    const sessions = await openTab(SESSIONS_TAB);
    await waitFor(() => expect(squash(textOf(sessions))).toMatch(FORBIDDEN));
    const reports = await openTab(REPORTS_TAB);
    await waitFor(() => expect(squash(textOf(reports))).toMatch(FORBIDDEN));
    await settle();
    await settled(server);
    expect(server.traceRequests()).toEqual([]);
    expect(actions(main(), HANDLE_ENTRY)).toEqual([]);
  },
);

it(
  '[AC-F1-10ka-ACCESS#2] 工作台卡地址只持 agent.report：仍落在 AI 助手记录的 AI 举报页签，显示无权限、不发举报列表请求',
  { timeout: 60_000 },
  async () => {
    const server = createServer(undefined, { permissions: REPORT_ONLY });
    await mount(server, { route: '/agent/reports?overdue=true' });
    await waitFor(() => expect(menuLink().getAttribute('aria-current')).toBe('page'));
    await waitFor(() => expect(squash(textOf(panel(REPORTS_TAB)))).toMatch(FORBIDDEN));
    await settle();
    await settled(server);
    expect(server.traceRequests()).toEqual([]);
  },
);

it(
  '[AC-F1-10ka-ACCESS#3] 服务端 10403（权限已撤回）：会话留痕显示无权限，不显示行，也不自动重读',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    server.once('GET', SESSIONS, () => denied());
    await mount(server);
    const sessions = await openTab(SESSIONS_TAB);
    await waitFor(() => expect(server.sessionReads().length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(squash(textOf(panel(SESSIONS_TAB)))).toMatch(FORBIDDEN));
    for (let round = 0; round < 3; round += 1) await settle();
    await settled(server);
    expect(server.sessionReads()).toHaveLength(1);
    expect(rowsOf(sessions, [SID.member])).toEqual([]);
    expect(server.detailReads()).toEqual([]);
  },
);

it(
  '[AC-F1-10ka-ACCESS#4] 举报列表网络失败：显示读取失败与【重试】，点一次只重读一次并显示行',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    server.once('GET', REPORTS, () => networkDown());
    await mount(server);
    await openTab(REPORTS_TAB);
    await waitFor(() => expect(server.reportReads().length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(squash(textOf(panel(REPORTS_TAB)))).toMatch(LOAD_FAILED));
    expect(server.reportReads()).toHaveLength(1);
    expect(rowsOf(panel(REPORTS_TAB), [REPORT_ROW.overdue])).toEqual([]);
    const retry = usable(panel(REPORTS_TAB), RETRY);
    expect(retry, 'one usable 【重试】').toHaveLength(1);
    await click(retry[0]!);
    await waitFor(() => expect(server.reportReads()).toHaveLength(2));
    await settled(server);
    await rowsShown(panel(REPORTS_TAB), [REPORT_ROW.overdue, REPORT_ROW.handled]);
    expect(server.reportReads()).toHaveLength(2);
  },
);
