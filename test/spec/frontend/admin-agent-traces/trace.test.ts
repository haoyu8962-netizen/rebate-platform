// @vitest-environment jsdom
// F1-10ka 留痕明细: GET /admin/v1/agent-traces/sessions/{session_id} writes one agent_trace_view
// audit record per successful read, so it is sent only when the operator opens a row's trace, once
// per opening — never on mount, tab switch, list refresh or re-render; closing and opening again
// reads again. The trace shows the stored masked texts as given (null text: a placeholder, never
// "null"), feedback / badcase / report fields, runs, tool calls and cards; 20001 is 不存在.
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  CARD_FALLBACK,
  REASON,
  REPORT_ROW,
  SID,
  TEXT,
  createServer,
  rejected,
  sessionPath,
} from './fixtures.ts';
import {
  GUEST,
  NOT_FOUND,
  REPORTS_TAB,
  SESSIONS_TAB,
  closeTrace,
  freshText,
  mount,
  openTab,
  openTrace,
  panel,
  query,
  rowsShown,
  settle,
  settled,
  snapshotText,
  squash,
  textOf,
  traceDialog,
  traceDialogs,
  traceEntries,
} from './helpers.ts';

/** Text without spaces and thousands separators (a number may be grouped). */
function norm(text: string): string {
  return squash(text).replace(/[,，](?=\d{3}(?!\d))/g, '');
}
/** The trace's text with its text nodes spaced and numbers ungrouped. */
function spaced(dialog: HTMLElement): string {
  return textOf(dialog).replace(/(\d)[,，](?=\d{3}(?!\d))/g, '$1');
}
function hasNumber(text: string, value: number): boolean {
  return new RegExp(`(?<![\\d.])${value}(?![\\d.])`).test(text);
}

it(
  '[AC-F1-10ka-TRACE#1] 明细只在点开某行时读一次：挂载、切页签、刷新列表都不读；打开期间不重复读；关闭再打开才再读一次',
  { timeout: 90_000 },
  async () => {
    const server = createServer();
    await mount(server);
    await openTab(SESSIONS_TAB);
    await rowsShown(panel(SESSIONS_TAB), [SID.guest, SID.member]);
    await settled(server);
    await openTab(REPORTS_TAB);
    await rowsShown(panel(REPORTS_TAB), [REPORT_ROW.overdue]);
    await settled(server);
    await openTab(SESSIONS_TAB);
    await settled(server);
    expect(server.detailReads(), 'no trace read before an opening').toEqual([]);

    await openTrace(panel(SESSIONS_TAB), SID.guest);
    const dialog = await traceDialog(SID.guest);
    await waitFor(() => expect(norm(textOf(dialog))).toContain(norm(TEXT.guestReply)));
    await settled(server);
    expect(server.detailReads(SID.guest)).toHaveLength(1);
    expect(server.detailReads()).toHaveLength(1);
    for (let round = 0; round < 3; round += 1) await settle();
    await settled(server);
    expect(server.detailReads(), 'still one read while the trace stays open').toHaveLength(1);

    await closeTrace(dialog);
    const lists = server.sessionReads().length;
    await query(panel(SESSIONS_TAB));
    await waitFor(() => expect(server.sessionReads().length).toBeGreaterThan(lists));
    await settled(server);
    await rowsShown(panel(SESSIONS_TAB), [SID.guest]);
    expect(server.detailReads(), 'a list refresh reads no trace').toHaveLength(1);

    await openTrace(panel(SESSIONS_TAB), SID.guest);
    await traceDialog(SID.guest);
    await settled(server);
    expect(server.detailReads(SID.guest), 'opened again: read again, once').toHaveLength(2);
    expect(server.detailReads()).toHaveLength(2);
    expect(server.requests('POST')).toEqual([]);
  },
);

it(
  '[AC-F1-10ka-TRACE#2] 明细内容：消息按服务端脱敏文本原样、角色、反馈与 badcase、举报时间 / 理由 / 状态；run 的 intent、model、prompt_version、token、耗时、finish_reason、filter_hits；工具调用；卡片类型与 fallback_text',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mount(server);
    await openTab(SESSIONS_TAB);
    await rowsShown(panel(SESSIONS_TAB), [SID.guest]);
    await openTrace(panel(SESSIONS_TAB), SID.guest);
    const dialog = await traceDialog(SID.guest);
    await waitFor(() => expect(norm(textOf(dialog))).toContain(norm(TEXT.guestAsk)));
    await settled(server);
    const shown = norm(textOf(dialog));
    // Messages: the masked texts exactly as stored, both roles.
    expect(shown).toContain(norm(TEXT.guestAsk));
    expect(shown).toContain(norm(TEXT.guestReply));
    expect(shown).toMatch(/助手|assistant|AI/i);
    expect(shown).toContain(GUEST);
    // Feedback down, badcase, and the report of the reply.
    expect(shown).toMatch(/down|踩|差评|不满意|不喜欢|没帮助/i);
    expect(shown).toMatch(/badcase|坏例/i);
    expect(shown).toContain(norm('2026-09-29 10:00'));
    expect(shown).toContain(norm(REASON.overdue));
    expect(shown).toMatch(/待处理|pending/);
    // Run.
    expect(shown).toContain('earnings_query');
    expect(shown).toContain('qwen-plus');
    expect(shown).toContain('p-2026-09-01');
    const text = spaced(dialog);
    expect(hasNumber(text, 1200), 'input tokens 1200').toBe(true);
    expect(hasNumber(text, 300), 'output tokens 300').toBe(true);
    const latency = hasNumber(text, 3200) || /(?<![\d.])3\.2\d?\s*s/.test(text);
    expect(latency, 'latency 3200 ms').toBe(true);
    expect(shown).toMatch(/stop|正常结束|正常完成/);
    expect(shown).toMatch(/amount|金额/);
    expect(shown).toMatch(/url|链接|网址/i);
    // Tool call and card.
    expect(shown).toContain('get_my_earnings');
    expect(shown).toContain('earnings_summary');
    expect(shown).toContain(norm(CARD_FALLBACK));
    expect(shown).not.toMatch(/null|undefined|NaN|\[objectObject\]/);
    expect(server.detailReads(SID.guest)).toHaveLength(1);
  },
);

it(
  '[AC-F1-10ka-TRACE#3] 注销后的会话：text 为 null 的消息显示占位而不是 null，举报理由为 null 不显示 null；降级 run 的空字段也不显示 null',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mount(server);
    await openTab(SESSIONS_TAB);
    await rowsShown(panel(SESSIONS_TAB), [SID.deleted]);
    await openTrace(panel(SESSIONS_TAB), SID.deleted);
    const dialog = await traceDialog(SID.deleted);
    await waitFor(() => expect(norm(textOf(dialog))).toMatch(/fallback|降级/));
    await settled(server);
    const shown = norm(textOf(dialog));
    expect(shown).toMatch(/注销|已删除|已清除|已抹除|不可见|无内容|无文本|（空）|\(空\)/);
    expect(shown).toContain('p-2026-09-01');
    expect(shown).not.toMatch(/null|undefined|NaN/);
    for (const value of Object.values(TEXT)) expect(shown).not.toContain(norm(value));
    expect(server.detailReads(SID.deleted)).toHaveLength(1);
  },
);

it(
  '[AC-F1-10ka-TRACE#4] 服务端 20001（未知会话）：明细处显示不存在，只读一次不自动重读',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    server.once('GET', sessionPath(SID.member), () => rejected(['session_id']));
    await mount(server);
    await openTab(SESSIONS_TAB);
    await rowsShown(panel(SESSIONS_TAB), [SID.member]);
    await settled(server);
    const before = snapshotText();
    await openTrace(panel(SESSIONS_TAB), SID.member);
    await waitFor(() => expect(server.detailReads(SID.member)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshText(before)).toMatch(NOT_FOUND));
    for (let round = 0; round < 3; round += 1) await settle();
    await settled(server);
    expect(server.detailReads()).toHaveLength(1);
    expect(squash(document.body.textContent)).not.toContain(squash(TEXT.memberReply));
  },
);

it(
  '[AC-F1-10ka-TRACE#5] 从 AI 举报行打开对应会话的留痕：读该行 session_id 的明细一次，关闭再打开再读一次',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mount(server);
    const reports = await openTab(REPORTS_TAB);
    await rowsShown(reports, [REPORT_ROW.overdue]);
    await settled(server);
    expect(server.detailReads()).toEqual([]);
    expect(traceEntries(reports, REPORT_ROW.overdue).length).toBeGreaterThan(0);
    await openTrace(reports, REPORT_ROW.overdue);
    const dialog = await traceDialog(SID.guest);
    await waitFor(() => expect(norm(textOf(dialog))).toContain(norm(TEXT.guestReply)));
    await settled(server);
    expect(server.detailReads(SID.guest)).toHaveLength(1);
    expect(server.detailReads()).toHaveLength(1);
    await closeTrace(dialog);
    expect(traceDialogs()).toEqual([]);
    await openTrace(panel(REPORTS_TAB), REPORT_ROW.overdue);
    await traceDialog(SID.guest);
    await settled(server);
    expect(server.detailReads(SID.guest)).toHaveLength(2);
    expect(server.detailReads()).toHaveLength(2);
  },
);
