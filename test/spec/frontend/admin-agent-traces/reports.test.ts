// @vitest-environment jsdom
// F1-10ka AI 举报 list: GET /admin/v1/agent-traces/reports (agent.trace). Rows show the session,
// the user (访客 for user_id null), report time, reason, status, deadline_at, and handled time /
// handler / note, all times in Beijing time; overdue rows carry a visible mark taken only from the
// row's `overdue` (never the console clock); rows keep the server's order. Filters status, overdue
// and the report-time window from / to.
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  MID,
  NOTE,
  REASON,
  REPORT_PARAMS,
  REPORT_ROW,
  SID,
  TEXT,
  UID,
  createServer,
  reports,
  withReport,
} from './fixtures.ts';
import {
  GUEST,
  HANDLED_NAME,
  LABEL,
  OVERDUE_MARK,
  PENDING_NAME,
  REPORTS_TAB,
  choose,
  extraParams,
  fillTime,
  filterOverdue,
  last,
  mount,
  openTab,
  panel,
  query,
  rowOf,
  rowOrder,
  rowsOf,
  rowsShown,
  searchable,
  settled,
  squash,
  statusText,
  textOf,
} from './helpers.ts';

const ALL = [REPORT_ROW.overdue, REPORT_ROW.fresh, REPORT_ROW.handled, REPORT_ROW.orphan];

function shows(row: HTMLElement, values: readonly string[]): void {
  const text = squash(textOf(row));
  for (const value of values) expect(text, value).toContain(squash(value));
}

it(
  '[AC-F1-10ka-REPORTS#1] 举报行：会话、用户（访客）、举报时间、理由、状态、截止时间、处理时间 / 处理人 / 说明（北京时间）；理由或处理人为 null 不显示 null；列表无对话文本、不读明细',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mount(server);
    const root = await openTab(REPORTS_TAB);
    await rowsShown(root, ALL);
    await settled(server);
    const overdue = rowOf(root, REPORT_ROW.overdue);
    expect(rowsOf(root, [REPORT_ROW.overdue, SID.guest])).toHaveLength(1);
    shows(overdue, [GUEST, '2026-09-29 10:00', REASON.overdue, '2026-10-01 10:00']);
    expect(statusText(overdue)).toContain(PENDING_NAME);
    const fresh = rowOf(root, REPORT_ROW.fresh);
    expect(rowsOf(root, [REPORT_ROW.fresh, SID.deleted, UID.deleted])).toHaveLength(1);
    shows(fresh, ['2026-09-30 09:00', '2026-10-02 09:00']);
    expect(statusText(fresh)).toContain(PENDING_NAME);
    const handled = rowOf(root, REPORT_ROW.handled);
    expect(rowsOf(root, [REPORT_ROW.handled, UID.member])).toHaveLength(1);
    shows(handled, [
      '2026-09-28 09:00',
      '2026-09-30 09:00',
      '2026-09-28 15:30',
      '运营小王',
      NOTE.handled,
    ]);
    expect(statusText(handled)).toContain(HANDLED_NAME);
    expect(statusText(handled)).not.toContain(PENDING_NAME);
    const orphan = rowOf(root, REPORT_ROW.orphan);
    shows(orphan, ['2026-09-27 09:00', '2026-09-27 18:45', NOTE.orphan]);
    expect(statusText(orphan)).toContain(HANDLED_NAME);
    const all = squash(textOf(root));
    expect(all).not.toMatch(/null|undefined|NaN/);
    for (const text of Object.values(TEXT)) expect(all).not.toContain(squash(text));
    expect(server.detailReads()).toEqual([]);
  },
);

it(
  '[AC-F1-10ka-REPORTS#2] 超时标识只看行里的 overdue：时钟未到 deadline_at 但 overdue=true 的行有醒目超时标识；时钟已过 deadline_at 但 overdue=false 的待处理行与已处理行都没有',
  { timeout: 60_000 },
  async () => {
    // The console clock (2026-09-30 12:00 Beijing time) contradicts both pending rows on purpose:
    // the overdue one's deadline is still ahead, the other's has passed.
    const rows = withReport(MID.fresh, {
      reported_at: '2026-09-28T01:00:00Z',
      deadline_at: '2026-09-30T01:00:00Z',
      overdue: false,
    });
    const server = createServer(undefined, { reports: rows });
    await mount(server, { clock: '2026-09-30T12:00:00+08:00' });
    const root = await openTab(REPORTS_TAB);
    await rowsShown(root, ALL);
    await settled(server);
    expect(searchable(rowOf(root, REPORT_ROW.overdue))).toMatch(OVERDUE_MARK);
    expect(searchable(rowOf(root, REPORT_ROW.fresh))).not.toMatch(OVERDUE_MARK);
    expect(searchable(rowOf(root, REPORT_ROW.handled))).not.toMatch(OVERDUE_MARK);
    expect(searchable(rowOf(root, REPORT_ROW.orphan))).not.toMatch(OVERDUE_MARK);
  },
);

it('[AC-F1-10ka-REPORTS#3] 行顺序照服务端返回，不在页面重排', { timeout: 60_000 }, async () => {
  const byId = new Map(reports().map((row) => [row.message_id, row]));
  const order = [MID.orphan, MID.overdue, MID.handled, MID.fresh];
  const shuffled = order.map((id) => byId.get(id)!);
  const server = createServer(undefined, { reports: shuffled });
  await mount(server);
  const root = await openTab(REPORTS_TAB);
  await rowsShown(root, ALL);
  await settled(server);
  expect(
    rowOrder(root, [REPORT_ROW.fresh, REPORT_ROW.handled, REPORT_ROW.overdue, REPORT_ROW.orphan]),
  ).toEqual([REPORT_ROW.orphan, REPORT_ROW.overdue, REPORT_ROW.handled, REPORT_ROW.fresh]);
});

it(
  '[AC-F1-10ka-REPORTS#4] 筛选状态待处理、只看超时与举报时间 from / to（北京时间、带时区）一次提交，回第一页',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mount(server);
    const root = await openTab(REPORTS_TAB);
    await rowsShown(root, ALL);
    await settled(server);
    const before = server.reportReads().length;
    await choose(root, LABEL.status, /^待处理$/);
    await filterOverdue(panel(REPORTS_TAB));
    await fillTime(panel(REPORTS_TAB), 'from', '2026-09-29 00:00:00');
    await fillTime(panel(REPORTS_TAB), 'to', '2026-09-30 00:00:00');
    await query(panel(REPORTS_TAB));
    await waitFor(() => expect(server.reportReads().length).toBeGreaterThan(before));
    await settled(server);
    const sent = last(server.reportReads());
    expect(extraParams(sent, REPORT_PARAMS)).toEqual([]);
    expect(Object.keys(sent.query).sort()).toEqual([
      'from',
      'overdue',
      'page',
      'page_size',
      'status',
      'to',
    ]);
    expect(sent.query).toMatchObject({ status: 'pending', overdue: 'true', page: '1' });
    expect(sent.query['from']).toMatch(/(?:Z|[+-]\d{2}:\d{2})$/);
    expect(sent.query['to']).toMatch(/(?:Z|[+-]\d{2}:\d{2})$/);
    expect(Date.parse(sent.query['from']!)).toBe(Date.parse('2026-09-29T00:00:00+08:00'));
    expect(Date.parse(sent.query['to']!)).toBe(Date.parse('2026-09-30T00:00:00+08:00'));
    await waitFor(() => {
      const current = panel(REPORTS_TAB);
      expect(rowsOf(current, [REPORT_ROW.overdue])).toHaveLength(1);
      expect(rowsOf(current, [REPORT_ROW.fresh])).toEqual([]);
      expect(rowsOf(current, [REPORT_ROW.handled])).toEqual([]);
    });
    expect(server.detailReads()).toEqual([]);
  },
);
