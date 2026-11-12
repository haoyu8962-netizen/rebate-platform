// @vitest-environment jsdom
// F1-10ka 【标记已处理】: only with agent.report and only on pending rows (overdue ones too). The
// handling note is trimmed and must keep 1–500 Unicode code points (apps/admin/src/text-length.ts),
// else nothing is sent; POST /admin/v1/agent-traces/reports/{message_id}/handle carries exactly
// {note (trimmed), expected_row_version (the row's row_version)}. Success shows the row handled;
// 20902 says someone else handled it / it changed and reloads the list; 20001 [note] flags the note.
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  MID,
  REPORT_ROW,
  SELF_NAME,
  TRACE_ONLY,
  createServer,
  handlePath,
  rejected,
} from './fixtures.ts';
import {
  CONFLICT,
  HANDLED_NAME,
  HANDLE_ENTRY,
  LABEL,
  OVERDUE_MARK,
  PENDING_NAME,
  REPORTS_TAB,
  SUBMIT,
  action,
  actions,
  click,
  fieldError,
  fill,
  freshText,
  mount,
  noteDialog,
  noteDialogs,
  openTab,
  panel,
  rowOf,
  rowsShown,
  searchable,
  settle,
  settled,
  snapshotText,
  squash,
  statusText,
  textOf,
  textbox,
  usable,
} from './helpers.ts';

const ALL = [REPORT_ROW.overdue, REPORT_ROW.fresh, REPORT_ROW.handled, REPORT_ROW.orphan];
const NOTE_NEW = '已复核：答复口径与钱包页一致，已通知运营调整话术';
/** 499 Han characters + one 「𠮷」: 500 code points, 501 UTF-16 units. */
const FITS = `${'处'.repeat(499)}𠮷`;
/** One 「𠮷」 more: 501 code points. */
const OVER = `${FITS}𠮷`;

async function openHandle(which: string): Promise<HTMLElement> {
  const row = rowOf(panel(REPORTS_TAB), which);
  const entries = usable(row, HANDLE_ENTRY);
  expect(entries, `one usable 【标记已处理】 on ${which}`).toHaveLength(1);
  await click(entries[0]!);
  return noteDialog();
}

it(
  '[AC-F1-10ka-HANDLE#1] 超时的待处理举报照样能标记：填说明（首尾空白去掉）提交，请求体只有 note 与 expected_row_version（行上的 row_version）；成功后该行显示已处理、处理人与说明，按钮与超时标识消失',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mount(server);
    const root = await openTab(REPORTS_TAB);
    await rowsShown(root, ALL);
    await settled(server);
    expect(searchable(rowOf(root, REPORT_ROW.overdue))).toMatch(OVERDUE_MARK);
    const modal = await openHandle(REPORT_ROW.overdue);
    expect(server.handles()).toEqual([]);
    await fill(textbox(modal, LABEL.note), `  ${NOTE_NEW}\n `);
    await click(action(modal, SUBMIT));
    await waitFor(() => expect(server.handles(MID.overdue)).toHaveLength(1));
    await settled(server);
    const sent = server.handles(MID.overdue)[0]!;
    expect(sent.path).toBe(handlePath(MID.overdue));
    expect(sent.headers.get('Authorization')).toBe('Bearer example-admin-token');
    expect(sent.body).toEqual({ note: NOTE_NEW, expected_row_version: 1 });
    expect(server.report(MID.overdue).report_status).toBe('handled');
    await waitFor(() => {
      const row = rowOf(panel(REPORTS_TAB), REPORT_ROW.overdue);
      expect(statusText(row)).toContain(HANDLED_NAME);
      expect(statusText(row)).not.toContain(PENDING_NAME);
      expect(squash(textOf(row))).toContain(squash(NOTE_NEW));
      expect(squash(textOf(row))).toContain(SELF_NAME);
      expect(actions(row, HANDLE_ENTRY)).toEqual([]);
      expect(searchable(row)).not.toMatch(OVERDUE_MARK);
    });
    await waitFor(() => expect(noteDialogs()).toEqual([]));
    expect(server.handles()).toHaveLength(1);
  },
);

it(
  '[AC-F1-10ka-HANDLE#2] 说明为空、全是空白或超过 500 码点（501 个，含「𠮷」）：不发请求、在说明旁提示；499 汉字 + 1 个「𠮷」（500 码点）不截断照常提交',
  { timeout: 90_000 },
  async () => {
    const server = createServer();
    await mount(server);
    const root = await openTab(REPORTS_TAB);
    await rowsShown(root, ALL);
    await settled(server);
    const modal = await openHandle(REPORT_ROW.fresh);
    for (const note of ['', '   \n  ', OVER, `  ${OVER}  `]) {
      await fill(textbox(modal, LABEL.note), note);
      await click(action(modal, SUBMIT));
      await settle();
      await settled(server);
      await waitFor(() =>
        expect(fieldError(textbox(modal, LABEL.note)), 'a note error').not.toBe(''),
      );
      expect(server.handles(), 'nothing sent for an invalid note').toEqual([]);
      expect(noteDialogs()).toHaveLength(1);
    }
    await fill(textbox(modal, LABEL.note), `  ${FITS}  `);
    await click(action(modal, SUBMIT));
    await waitFor(() => expect(server.handles(MID.fresh)).toHaveLength(1));
    await settled(server);
    expect(server.handles(MID.fresh)[0]!.body).toEqual({ note: FITS, expected_row_version: 3 });
    expect(server.report(MID.fresh).report_note).toBe(FITS);
  },
);

it(
  '[AC-F1-10ka-HANDLE#3] 服务端 20902（已被他人处理）：提示已被处理或已变化并刷新列表，该行显示服务端最新的已处理状态、没有按钮',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mount(server);
    const root = await openTab(REPORTS_TAB);
    await rowsShown(root, ALL);
    await settled(server);
    const modal = await openHandle(REPORT_ROW.fresh);
    // Another admin handles the report while this dialog is open.
    server.handledElsewhere(MID.fresh, '另一位运营已回复用户');
    const reads = server.reportReads().length;
    const before = snapshotText();
    await fill(textbox(modal, LABEL.note), NOTE_NEW);
    await click(action(modal, SUBMIT));
    await waitFor(() => expect(server.handles(MID.fresh)).toHaveLength(1));
    await settled(server);
    expect(server.handles(MID.fresh)[0]!.body).toEqual({
      note: NOTE_NEW,
      expected_row_version: 3,
    });
    await waitFor(() => expect(freshText(before)).toMatch(CONFLICT));
    await waitFor(() => expect(server.reportReads().length).toBeGreaterThan(reads));
    await settled(server);
    await waitFor(() => {
      const row = rowOf(panel(REPORTS_TAB), REPORT_ROW.fresh);
      expect(statusText(row)).toContain(HANDLED_NAME);
      expect(squash(textOf(row))).toContain('另一位运营已回复用户');
      expect(actions(row, HANDLE_ENTRY)).toEqual([]);
    });
    expect(server.handles()).toHaveLength(1);
  },
);

it(
  '[AC-F1-10ka-HANDLE#4] 服务端 20001 data.fields=[note]：在说明旁提示不合格，对话框不关，该行仍待处理',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    server.once('POST', handlePath(MID.overdue), () => rejected(['note']));
    await mount(server);
    const root = await openTab(REPORTS_TAB);
    await rowsShown(root, ALL);
    await settled(server);
    const modal = await openHandle(REPORT_ROW.overdue);
    await fill(textbox(modal, LABEL.note), NOTE_NEW);
    await click(action(modal, SUBMIT));
    await waitFor(() => expect(server.handles(MID.overdue)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(fieldError(textbox(modal, LABEL.note))).not.toBe(''));
    expect(noteDialogs()).toHaveLength(1);
    const row = rowOf(panel(REPORTS_TAB), REPORT_ROW.overdue);
    expect(statusText(row)).toContain(PENDING_NAME);
    expect(server.report(MID.overdue).report_status).toBe('pending');
  },
);

it(
  '[AC-F1-10ka-HANDLE#5] 持 agent.trace 与 agent.report：待处理行（超时与否）都有可用的【标记已处理】，已处理行没有',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mount(server);
    const root = await openTab(REPORTS_TAB);
    await rowsShown(root, ALL);
    await settled(server);
    expect(usable(rowOf(root, REPORT_ROW.overdue), HANDLE_ENTRY)).toHaveLength(1);
    expect(usable(rowOf(root, REPORT_ROW.fresh), HANDLE_ENTRY)).toHaveLength(1);
    expect(actions(rowOf(root, REPORT_ROW.handled), HANDLE_ENTRY)).toEqual([]);
    expect(actions(rowOf(root, REPORT_ROW.orphan), HANDLE_ENTRY)).toEqual([]);
  },
);

it(
  '[AC-F1-10ka-HANDLE#6] 只持 agent.trace：举报列表照常显示，任何行都没有可用的【标记已处理】，不发 POST',
  { timeout: 60_000 },
  async () => {
    const server = createServer(undefined, { permissions: TRACE_ONLY });
    await mount(server);
    const root = await openTab(REPORTS_TAB);
    await rowsShown(root, ALL);
    await settled(server);
    for (const which of ALL) expect(usable(rowOf(root, which), HANDLE_ENTRY), which).toEqual([]);
    expect(squash(textOf(root))).toContain(PENDING_NAME);
    expect(server.requests('POST')).toEqual([]);
    expect(noteDialogs()).toEqual([]);
  },
);
