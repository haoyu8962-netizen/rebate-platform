// @vitest-environment jsdom
// F1-10kc (D10-1341 / D10-1347): in the trace drawer (adminGetAgentSession) a message whose text is
// null shows a neutral placeholder containing 「无文本」 — never "null", never a blank. A null text has
// more causes than account deletion (BR-AI-22): a reply still being written, a reply closed by
// another request after a crash. So the drawer never says 「注销」 for a session whose user_id is set
// (a signed-in user's session), and for a session with user_id null (which is also what a guest
// session looks like, BR-AI-20) a deletion note may appear only as a condition (若 / 如 / 可能), never
// as a fact. Texts that are present are shown as stored. The frozen admin-agent-traces mount, fake
// server and drawer helpers are reused as they are.
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  SID,
  TEXT,
  UID,
  createServer,
  sessions,
  type Server,
  type SessionDetail,
  type TraceMessage,
} from '../admin-agent-traces/fixtures.ts';
import {
  GUEST,
  SESSIONS_TAB,
  mount,
  openTab,
  openTrace,
  panel,
  rowsShown,
  searchable,
  settled,
  squash,
  textOf,
  traceDialog,
} from '../admin-agent-traces/helpers.ts';

/** The neutral placeholder of a message without text. */
const PLACEHOLDER = '无文本';
/** The word a deletion note uses. */
const DELETION = '注销';
/** What makes a deletion note a condition rather than a statement. */
const CONDITIONAL = /若|如|可能/;
/** The prompt version of the fixture run of the deleted-texts session (shown with the body). */
const PROMPT = 'p-2026-09-01';
/** A second question of the member, distinct from every fixture text. */
const MEMBER_FOLLOW_UP = '那上个月的订单呢';

/** Text without spaces and thousands separators. */
function norm(text: string): string {
  return squash(text).replace(/[,，](?=\d{3}(?!\d))/g, '');
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

/** One stored message (never reported, no feedback). */
function message(id: string, role: 'user' | 'assistant', text: string | null): TraceMessage {
  return {
    message_id: id,
    role,
    text,
    card_ids: [],
    feedback: null,
    badcase: false,
    reported_at: null,
    report_reason: null,
    report_status: null,
    report_note: null,
  };
}

/** The fixture sessions with the messages of `id` replaced by `messages`. */
function withMessages(id: string, messages: TraceMessage[]): SessionDetail[] {
  return sessions().map((row) => (row.session_id === id ? { ...row, messages } : row));
}

/**
 * The smallest elements of `root` whose text holds `word`, and every element whose aria-label or
 * title holds it: each is one piece of text the operator reads.
 */
function piecesWith(root: HTMLElement, word: string): string[] {
  const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
  const holds = (node: Element): boolean => squash(node.textContent).includes(word);
  const texts = elements
    .filter((node) => holds(node) && !Array.from(node.children).some(holds))
    .map((node) => squash(node.textContent));
  const labels = elements
    .flatMap((node) => [node.getAttribute('aria-label'), node.getAttribute('title')])
    .map((value) => squash(value))
    .filter((value) => value.includes(word));
  return [...texts, ...labels];
}

/** Opens the trace of `sessionId` from the sessions tab and waits until it shows `ready`. */
async function openSession(server: Server, sessionId: string, ready: string) {
  await mount(server);
  await openTab(SESSIONS_TAB);
  await rowsShown(panel(SESSIONS_TAB), [sessionId]);
  await openTrace(panel(SESSIONS_TAB), sessionId);
  const dialog = await traceDialog(sessionId);
  await waitFor(() => expect(norm(textOf(dialog))).toContain(norm(ready)));
  await settled(server);
  return dialog;
}

it(
  '[AC-F1-10kc-EMPTY#1] user_id 非空的会话（夹具里文本已为 null 的那一个）：每条空文本消息显示「无文本」，不显示 null；抽屉里任何位置（含 aria-label / title）都不出现「注销」',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    const dialog = await openSession(server, SID.deleted, PROMPT);
    const shown = norm(textOf(dialog));
    expect(shown).toContain(squash(UID.deleted));
    expect(
      occurrences(shown, PLACEHOLDER),
      'one placeholder for each of the two null texts',
    ).toBeGreaterThanOrEqual(2);
    expect(shown).not.toMatch(/null|undefined|NaN/);
    for (const value of Object.values(TEXT)) expect(shown).not.toContain(norm(value));
    expect(squash(searchable(dialog)), 'no deletion wording for a signed-in user').not.toContain(
      DELETION,
    );
    expect(server.detailReads(SID.deleted)).toHaveLength(1);
  },
);

it(
  '[AC-F1-10kc-EMPTY#2] 登录用户会话里回复文本为 null（进行中 / 崩溃后收尾）：有文本的提问照原样显示，每条空回复在原位置显示「无文本」，不显示 null 或空白，不出现「注销」',
  { timeout: 60_000 },
  async () => {
    const server = createServer(
      withMessages(SID.member, [
        message('0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c11', 'user', TEXT.memberAsk),
        message('0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c12', 'assistant', null),
        message('0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c13', 'user', MEMBER_FOLLOW_UP),
        message('0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c14', 'assistant', null),
      ]),
    );
    const dialog = await openSession(server, SID.member, TEXT.memberAsk);
    const shown = norm(textOf(dialog));
    expect(shown).toContain(squash(UID.member));
    // ask, placeholder, ask, placeholder — each null reply has its own placeholder in place.
    const firstAsk = shown.indexOf(norm(TEXT.memberAsk));
    expect(firstAsk, 'the first question as stored').toBeGreaterThanOrEqual(0);
    const firstGap = shown.indexOf(PLACEHOLDER, firstAsk);
    expect(firstGap, 'a placeholder after the first question').toBeGreaterThan(firstAsk);
    const secondAsk = shown.indexOf(norm(MEMBER_FOLLOW_UP), firstGap);
    expect(secondAsk, 'the second question after the first placeholder').toBeGreaterThan(firstGap);
    const secondGap = shown.indexOf(PLACEHOLDER, secondAsk);
    expect(secondGap, 'a placeholder after the second question').toBeGreaterThan(secondAsk);
    expect(shown).not.toMatch(/null|undefined|NaN/);
    expect(squash(searchable(dialog)), 'no deletion wording for a signed-in user').not.toContain(
      DELETION,
    );
    expect(server.detailReads(SID.member)).toHaveLength(1);
  },
);

it(
  '[AC-F1-10kc-EMPTY#3] user_id 为 null 的会话里回复文本为 null：提问照原样，空回复显示「无文本」；若出现「注销」，所在那段文字须是条件句（含 若 / 如 / 可能），不能断言账号已注销',
  { timeout: 60_000 },
  async () => {
    const server = createServer(
      withMessages(SID.guest, [
        message('0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c21', 'user', TEXT.guestAsk),
        message('0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c22', 'assistant', null),
      ]),
    );
    const dialog = await openSession(server, SID.guest, TEXT.guestAsk);
    const shown = norm(textOf(dialog));
    expect(shown).toContain(GUEST);
    const ask = shown.indexOf(norm(TEXT.guestAsk));
    expect(ask, 'the question as stored').toBeGreaterThanOrEqual(0);
    expect(shown.indexOf(PLACEHOLDER, ask), 'a placeholder after the question').toBeGreaterThan(
      ask,
    );
    expect(shown).not.toContain(norm(TEXT.guestReply));
    expect(shown).not.toMatch(/null|undefined|NaN/);
    const notes = piecesWith(dialog, DELETION);
    if (squash(searchable(dialog)).includes(DELETION)) {
      expect(notes.length, 'the deletion wording is found in a piece of text').toBeGreaterThan(0);
    }
    for (const note of notes) expect(note, 'a deletion note is a condition').toMatch(CONDITIONAL);
    expect(server.detailReads(SID.guest)).toHaveLength(1);
  },
);
