// @vitest-environment jsdom
// F1-10ka: the menu 「AI 助手记录」 (agent-traces) has two tabs, 「会话留痕」 and 「AI 举报」; the
// workbench card agent_report_overdue (route /agent/reports?overdue=true) lands on the same menu
// with the AI 举报 tab open and the overdue filter applied.
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { REPORT_PARAMS, REPORT_ROW, SESSION_PARAMS, SID, createServer } from './fixtures.ts';
import {
  REPORTS_TAB,
  SESSIONS_TAB,
  extraParams,
  last,
  menuLink,
  mount,
  openTab,
  panel,
  rowsOf,
  rowsShown,
  selected,
  settled,
  tabOf,
} from './helpers.ts';

it(
  '[AC-F1-10ka-ENTRY#1] 菜单「AI 助手记录」：侧栏高亮，页内两个页签「会话留痕」「AI 举报」；会话留痕只按 page / page_size 读列表，AI 举报首读不带 status / overdue；全程不读明细',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mount(server);
    await waitFor(() => expect(menuLink().getAttribute('aria-current')).toBe('page'));
    const sessions = await openTab(SESSIONS_TAB);
    await rowsShown(sessions, [SID.member, SID.guest, SID.deleted]);
    await settled(server);
    expect(server.sessionReads().length).toBeGreaterThan(0);
    for (const read of server.sessionReads()) {
      expect(extraParams(read, SESSION_PARAMS)).toEqual([]);
      expect(extraParams(read, ['page', 'page_size'])).toEqual([]);
      expect(read.headers.get('Authorization')).toBe('Bearer example-admin-token');
    }
    const reports = await openTab(REPORTS_TAB);
    await rowsShown(reports, [REPORT_ROW.overdue, REPORT_ROW.handled]);
    await settled(server);
    const first = server.reportReads()[0];
    expect(first, 'one read of the report list').toBeDefined();
    expect(extraParams(first!, REPORT_PARAMS)).toEqual([]);
    expect(first!.query).not.toHaveProperty('status');
    expect(first!.query).not.toHaveProperty('overdue');
    expect(server.detailReads()).toEqual([]);
    expect(server.requests('POST')).toEqual([]);
  },
);

it(
  '[AC-F1-10ka-ENTRY#2] 工作台卡地址 /agent/reports?overdue=true：侧栏高亮 AI 助手记录、打开 AI 举报页签、举报列表请求带 overdue=true，只显示超时的举报',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mount(server, { route: '/agent/reports?overdue=true' });
    await waitFor(() => expect(menuLink().getAttribute('aria-current')).toBe('page'));
    await waitFor(() => expect(selected(tabOf(REPORTS_TAB)), 'AI 举报 tab open').toBe(true));
    await waitFor(() => expect(server.reportReads().length).toBeGreaterThan(0));
    await settled(server);
    const reads = server.reportReads();
    expect(reads[0]!.query['overdue']).toBe('true');
    expect(extraParams(reads[0]!, REPORT_PARAMS)).toEqual([]);
    expect(last(reads).query['overdue']).toBe('true');
    const reports = panel(REPORTS_TAB);
    await rowsShown(reports, [REPORT_ROW.overdue]);
    expect(rowsOf(reports, [REPORT_ROW.handled])).toEqual([]);
    expect(rowsOf(reports, [REPORT_ROW.fresh])).toEqual([]);
    expect(server.detailReads()).toEqual([]);
    expect(server.requests('POST')).toEqual([]);
  },
);
