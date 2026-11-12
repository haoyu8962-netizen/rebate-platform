// @vitest-environment jsdom
// F1-10ka 会话留痕 list: GET /admin/v1/agent-traces/sessions (agent.trace). Rows show the session,
// the user (访客 for user_id null), start / last active time in Beijing time, expired, and the run,
// badcase and report counts; never a message text. Filters user_id, session_id, badcase,
// reported and the start-time window from / to (from not earlier than to is refused); paging with
// page / page_size.
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SESSION_PARAMS, SID, TEXT, UID, createServer, withFiller } from './fixtures.ts';
import {
  GUEST,
  LABEL,
  SESSIONS_TAB,
  cellText,
  choose,
  extraParams,
  fill,
  fillTime,
  freshText,
  last,
  mount,
  nextPage,
  noticeText,
  openTab,
  panel,
  query,
  rowOf,
  rowOrder,
  rowsOf,
  rowsShown,
  settled,
  snapshotText,
  squash,
  textOf,
  textbox,
} from './helpers.ts';

/** Column titles of the list (spaces removed). */
const COLUMN = {
  expired: /过期|状态/,
  runs: /run|运行/i,
  badcase: /badcase|坏例/i,
  reports: /举报/,
} as const;

function numbers(text: string): string[] {
  return squash(text).match(/\d+/g) ?? [];
}

it(
  '[AC-F1-10ka-SESSIONS#1] 会话留痕行：会话、用户（user_id 为 null 显示访客）、开始 / 最近活跃北京时间、是否过期、run / badcase / 举报数；按服务端顺序；不出现对话文本、null 字样，也不读明细',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mount(server);
    const root = await openTab(SESSIONS_TAB);
    await rowsShown(root, [SID.member, SID.guest, SID.deleted]);
    await settled(server);
    expect(rowOrder(root, [SID.deleted, SID.guest, SID.member])).toEqual([
      SID.member,
      SID.guest,
      SID.deleted,
    ]);
    expect(rowsOf(root, [SID.member, UID.member]), 'member row shows its user_id').toHaveLength(1);
    expect(rowsOf(root, [SID.deleted, UID.deleted])).toHaveLength(1);
    expect(squash(textOf(rowOf(root, SID.guest)))).toContain(GUEST);
    expect(squash(textOf(rowOf(root, SID.member)))).not.toContain(GUEST);
    // Beijing time of 03:20Z / 03:26Z and 01:50Z / 02:05Z.
    const member = squash(textOf(rowOf(root, SID.member)));
    expect(member).toContain(squash('2026-09-29 11:20'));
    expect(member).toContain(squash('2026-09-29 11:26'));
    const guest = squash(textOf(rowOf(root, SID.guest)));
    expect(guest).toContain(squash('2026-09-29 09:50'));
    expect(guest).toContain(squash('2026-09-29 10:05'));
    expect(squash(cellText(root, SID.member, COLUMN.expired))).toMatch(/已过期|^是$/);
    const live = squash(cellText(root, SID.guest, COLUMN.expired));
    expect(live).not.toBe('');
    expect(live).not.toMatch(/已过期|^是$/);
    expect(numbers(cellText(root, SID.member, COLUMN.runs))).toEqual(['7']);
    expect(numbers(cellText(root, SID.member, COLUMN.badcase))).toEqual(['2']);
    expect(numbers(cellText(root, SID.member, COLUMN.reports))).toEqual(['0']);
    expect(numbers(cellText(root, SID.guest, COLUMN.runs))).toEqual(['5']);
    expect(numbers(cellText(root, SID.guest, COLUMN.badcase))).toEqual(['1']);
    expect(numbers(cellText(root, SID.guest, COLUMN.reports))).toEqual(['3']);
    expect(numbers(cellText(root, SID.deleted, COLUMN.runs))).toEqual(['9']);
    const all = squash(textOf(root));
    for (const text of Object.values(TEXT)) expect(all).not.toContain(squash(text));
    expect(all).not.toMatch(/null|undefined|NaN/);
    expect(server.detailReads()).toEqual([]);
  },
);

it(
  '[AC-F1-10ka-SESSIONS#2] 筛选 user_id、session_id、badcase=true、reported=false 与开始时间 from / to（北京时间、带时区）以 AND 一次提交，回第一页',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mount(server);
    const root = await openTab(SESSIONS_TAB);
    await rowsShown(root, [SID.member, SID.guest]);
    await settled(server);
    const before = server.sessionReads().length;
    await fill(textbox(root, LABEL.user), UID.member);
    await fill(textbox(root, LABEL.session), SID.member);
    await choose(root, LABEL.badcase, /^(?:有|是)/);
    await choose(root, LABEL.reported, /^(?:无|否|没有|未)/);
    await fillTime(root, 'from', '2026-09-29 00:00:00');
    await fillTime(root, 'to', '2026-09-30 00:00:00');
    await query(root);
    await waitFor(() => expect(server.sessionReads().length).toBeGreaterThan(before));
    await settled(server);
    const sent = last(server.sessionReads());
    expect(extraParams(sent, SESSION_PARAMS)).toEqual([]);
    expect(Object.keys(sent.query).sort()).toEqual([
      'badcase',
      'from',
      'page',
      'page_size',
      'reported',
      'session_id',
      'to',
      'user_id',
    ]);
    expect(sent.query).toMatchObject({
      user_id: UID.member,
      session_id: SID.member,
      badcase: 'true',
      reported: 'false',
      page: '1',
    });
    expect(sent.query['from']).toMatch(/(?:Z|[+-]\d{2}:\d{2})$/);
    expect(sent.query['to']).toMatch(/(?:Z|[+-]\d{2}:\d{2})$/);
    expect(Date.parse(sent.query['from']!)).toBe(Date.parse('2026-09-29T00:00:00+08:00'));
    expect(Date.parse(sent.query['to']!)).toBe(Date.parse('2026-09-30T00:00:00+08:00'));
    await waitFor(() => {
      const current = panel(SESSIONS_TAB);
      expect(rowsOf(current, [SID.member])).toHaveLength(1);
      expect(rowsOf(current, [SID.guest])).toEqual([]);
      expect(rowsOf(current, [SID.deleted])).toEqual([]);
    });
    expect(server.detailReads()).toEqual([]);
  },
);

it(
  '[AC-F1-10ka-SESSIONS#3] 开始时间 from 不早于 to（相等或倒置）：不按该区间读出列表，在时间筛选处给出提示',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mount(server);
    const root = await openTab(SESSIONS_TAB);
    await rowsShown(root, [SID.member]);
    await settled(server);
    const hint = /时间|早于|晚于|区间|范围|起|止/;
    for (const [round, [from, to]] of [
      ['2026-09-29 12:00:00', '2026-09-29 12:00:00'],
      ['2026-09-30 00:00:00', '2026-09-29 00:00:00'],
    ].entries()) {
      const reads = server.sessionReads().length;
      const before = snapshotText();
      await fillTime(panel(SESSIONS_TAB), 'from', from!);
      await fillTime(panel(SESSIONS_TAB), 'to', to!);
      await query(panel(SESSIONS_TAB));
      await settled(server);
      // The first refusal must be a new hint; the second may keep the hint already shown.
      await waitFor(() => expect(round === 0 ? freshText(before) : noticeText()).toMatch(hint));
      const sent = server.sessionReads().slice(reads);
      // Either nothing is sent, or the one request sent is refused by the server (20001).
      expect(sent.length, `${from} / ${to}`).toBeLessThanOrEqual(1);
      for (const request of sent) {
        expect(request.query['from'], 'a refused window keeps its from').toBeDefined();
        expect(request.query['to'], 'a refused window keeps its to').toBeDefined();
        expect(Date.parse(request.query['from']!)).toBeGreaterThanOrEqual(
          Date.parse(request.query['to']!),
        );
      }
    }
    expect(server.detailReads()).toEqual([]);
  },
);

it(
  '[AC-F1-10ka-SESSIONS#4] 翻页带着当前筛选（page=2）；改筛选再查询回到 page=1，page_size 不变',
  { timeout: 60_000 },
  async () => {
    const server = createServer(withFiller(45));
    await mount(server);
    const root = await openTab(SESSIONS_TAB);
    await rowsShown(root, [SID.member]);
    await settled(server);
    await choose(root, LABEL.reported, /^(?:无|否|没有|未)/);
    await query(root);
    await waitFor(() => expect(last(server.sessionReads()).query['reported']).toBe('false'));
    await settled(server);
    const size = last(server.sessionReads()).query['page_size'];
    expect(size, 'the list sends page_size').toBeDefined();
    const reads = server.sessionReads().length;
    await nextPage(panel(SESSIONS_TAB));
    await waitFor(() => expect(server.sessionReads().length).toBeGreaterThan(reads));
    await settled(server);
    expect(last(server.sessionReads()).query).toEqual({
      page: '2',
      page_size: size,
      reported: 'false',
    });
    await choose(panel(SESSIONS_TAB), LABEL.badcase, /^(?:无|否|没有)/);
    await query(panel(SESSIONS_TAB));
    await waitFor(() => expect(last(server.sessionReads()).query['badcase']).toBe('false'));
    await settled(server);
    expect(last(server.sessionReads()).query).toEqual({
      page: '1',
      page_size: size,
      reported: 'false',
      badcase: 'false',
    });
    expect(server.detailReads()).toEqual([]);
  },
);
