// B3-08zc rule-test kit · BR-AI-19 细则「助手回复落库」(2026-11-12; 规划 11-12 A1, D10-1287) and the
// history interface listAgentSessionMessages (04 §6.5; BR-AI-20; BR-AI-23 GET ①–④). Shared by
// test/spec/agent/reply-persist/** and test/spec/agent/session-history/**. The harness is the
// production stream entry of [AC-B3-08g] over real PG (../trace-persist/kit.ts productionRig:
// ordersFixture → createProductionStreamAssembly → createAgentStreamRuntime; scriptModel for the
// model path), as B3-08q / B3-16a did.
//
// Contract pinned by these tests (the implementation's freedom ends here):
// - The stored reply. When the process that ran a run commits its terminal state (agent_runs
//   final_event; any ending: stop, cancelled, timeout, …; the client connected or not), the SAME
//   transaction writes, on the run's assistant row of app.agent_messages (id = meta.message_id):
//   text = every text.delta of the run joined in order (what the stream wrote after OutputGuard,
//   the timeout notice included); '' — never NULL — when the run had none; card_ids = the card_id
//   of every card of the run in delivery order ({} when none); and one app.agent_cards row per card
//   of the run, none other (card_id, type, schema_version, fallback_text as framed; data as framed
//   except earnings_summary, which keeps {as_of, actions} only; link_id = top-level data.link_id or
//   null; app / session / run of that run). The tests read right after sendMessage resolved (the
//   terminal frame was written): no polling, no waiting for any trace.
// - Not the async trace, not process memory. Cards no longer go through the run trace: the tests
//   set the trace writer of agent/store/results createPgAgentTraceWriter (../trace-persist/kit.ts
//   controlWriter) to 'throw', and the reply is stored all the same. A runtime built after the first
//   one closed (new assembly, new runtime, same database) resolves an order card of an earlier run
//   of the session for explain_order (no in-process pending card involved), and a read side on
//   another pool sees the reply.
// - Atomicity: when the first statement inserting into app.agent_cards fails (failFirstCardInsert,
//   a Kysely plugin on the runtime's handle; any INSERT INTO [app.]agent_cards, builder or raw SQL),
//   the run's terminal state is never committed without its reply: final_event set ⇒ text,
//   card_ids and agent_cards as above; final_event NULL ⇒ text NULL, card_ids {}, no card row and
//   no terminal frame written (expectAllOrNothing). The fault must be hit (failed() = 1).
//   And observed from outside while the reply write waits (no retry can hide it): another
//   connection holds an uncommitted agent_cards row with the card_id the run is about to store
//   (blockCardInsert, referencing an earlier run of the session, never the run itself), or a row
//   lock on the run's assistant row (lockAssistantRow); once the runtime waits on that lock
//   (lockWaiters > 0) a third connection still sees nothing of the ending — final_event NULL, the
//   assistant row with text NULL and card_ids {}, no agent_cards row of the run — and no terminal
//   frame has gone out (expectNothingCommitted). A write of the terminal state (or of the cards,
//   or of the text) committed in a transaction of its own before the waiting write shows here.
// - Disconnected client: after the client went away (FakeReply.close(), within the grace period:
//   the manual clock is not moved) the run goes on; its later text and cards are no longer framed
//   but are still numbered and stored, so the stored reply equals that of the same script run on a
//   connected client in a fresh session (same text, same card ids, types and order ids).
// - Crash: a run whose process died before its terminal state (its body never settles, its clock
//   never moves) and that another process finalizes (a later message of the session once the run
//   lock expired, or a repeated client_msg_id): its assistant row keeps text NULL or '' and card_ids
//   {}; no agent_cards row of that run (cards already framed are not written afterwards); the
//   history shows text '', cards [] and the finish reason that finalization stored. A later turn
//   that names that run's order card (explain_order {card_id}) gets what createOrderCardRefs gives
//   a card with no agent_cards row: {kind: 'invalid'} — orders.get is not called, no order card.
// - last_active_at (BR-AI-20): set when the message is accepted only. The terminal transaction,
//   which now writes agent_messages and agent_cards too, leaves agent_sessions.last_active_at as
//   acceptance left it, so expiry counts from the accepted message, never from the run's end.
// - History: createAgentHistoryRuntime(deps) of agent/stream/mount, deps = {db, clock, logger,
//   contentReader, consentReader} (the read part of createAgentStreamRuntime's deps; nothing shared
//   in memory with a stream runtime), returns AgentHistoryHttp (agent/http/history.ts):
//   listMessages(caller, sessionId, query, reply), query = the parsed query string ({} here: first
//   page, default limit 20). Answers as the contract's GET /v1/agent/sessions/{id}/messages: 200
//   AgentHistoryResponse (checked against contracts/openapi.yaml), items oldest first — per turn
//   the user row, then the assistant row — user: message_id = the user row's id, text = the stored
//   (redacted, BR-AI-14 storage form) text, cards [], finish_reason null; assistant: message_id =
//   meta.message_id, text = the stored reply text, cards = the card frames without seq (earnings:
//   {as_of, actions}), finish_reason = the done frame's (else agent_runs.finish_reason);
//   next_cursor null when nothing older; expired = BR-AI-20 (last_active_at + 24 h ≤ now) and
//   then still 200 for the owner. Checked in BR-AI-23's order, the first failing check answers:
//   ① agent.enabled / whitelist 30501, ② identity (agent.require_phone: guest 10001, member
//   without a bound phone 10005), ③ 10004 with data.consent_type 'ai_third_party', ④ 30504
//   without data for a missing session, one not the caller's or an id that is not a UUID. Owner
//   (BR-AI-20): a caller with a user (access token) owns a session only by agent_sessions.user_id
//   (the device is never looked at: another account on the same device does not, the same
//   account on another device does); a caller without one (guest) only a session with user_id
//   NULL and its device_id (a member's session opened on the same device is not a guest's).
//   JSON envelope status per contracts/error-codes.yaml, trace_id = caller's.
// Out of scope here: mounting the GET route (contract still x-implementation: planned, A9), paging
// beyond the first page, run-level fields of BR-AI-19 细则「运行级字段」. Synthetic values only;
// everything under test is built inside the tests (never in hooks).
//
// Retired by this task (D10-1297; 08 BR-AI-19 细则「助手回复落库」) → what takes their place:
// | retired / changed test | the sentence of the 细则 that ends it | successor |
// | trace-retry/pending.test.ts (deleted, 8 tests: [AC-B3-08y#7] TraceRedoQueue.pendingCard ×3 — 首次写入还挂着…, 写入失败进队后照样取得到…, 记 lost（停机）或 skipped 后也清掉; withPendingCards ×5 — 本会话内存里的 order_status 卡…, 同一 card_id 换一个会话或 app…, 收益卡、别的类型…, 内存不命中时原样返回…, 接在队列上…) | 「stream 可以有多个进程、发布是蓝绿切换，不能靠进程内的待写内容，卡片也不再随留痕异步写」; 「历史接口与下一轮对卡片的引用只读已提交的数据」 | reply-persist/across.int.test.ts [AC-B3-08zc#3] 跨进程…; [AC-B3-08zc#3] 留痕写者挂起…（同会话解析、别的会话不解析）; reply-persist/crash.int.test.ts [AC-B3-08zc#5] 崩溃收尾后下一轮引用… |
// | trace-retry/card-refs.int.test.ts (deleted) [AC-B3-08y#7] 上一个 run 的订单卡还在写（写者挂起…） | 同上 | reply-persist/across.int.test.ts [AC-B3-08zc#3] 留痕写者挂起… |
// | trace-retry/card-refs.int.test.ts (deleted) [AC-B3-08y#7] 上一个 run 的订单卡写入失败、在本地队列里等再写… | 同上 | reply-persist/across.int.test.ts [AC-B3-08zc#3] 跨进程…（写者一直失败） |
// | trace-retry/card-refs.int.test.ts (deleted) [AC-B3-08y#7] 未落库的订单卡只在出卡的会话里有效… | 同上 | reply-persist/across.int.test.ts [AC-B3-08zc#3] 留痕写者挂起…（别的会话引用同一 card_id 不解析） |
// | trace-persist/async-model.int.test.ts [AC-B3-08q#5] 模型路径·trace 写者变慢 (retitled; cards asserted at once, never by the writer) | 「卡片也不再随留痕异步写」; 「都与终态在同一个事务里写」 | the same test; reply-persist/stored.int.test.ts [AC-B3-08zc#1] |
// | trace-retry/runtime.int.test.ts [AC-B3-08y#1] 写者先失败后恢复 (retitled), [AC-B3-08y#5] 停机时队列非空 (lost line cards 0, no recordCards), [AC-B3-08y#8] 队列里的 run 正在再写 (retitled) | 同上 | the same tests; reply-persist/atomic.int.test.ts [AC-B3-08zc#2] |
// | trace-persist/async-model.int.test.ts [AC-B3-08q#5] 模型路径·trace 写者抛错 (retitled; was: recordToolCalls 与 recordCards 都被调用且都失败、该 run 无卡片行 → now: only recordToolCalls asked and failing, cards there at once and once each, recordCards never asked) | 「卡片也不再随留痕异步写」; 「都与终态在同一个事务里写」 | the same test; reply-persist/stored.int.test.ts [AC-B3-08zc#1] (trace writer set to 'throw') |
// | trace-persist/async.int.test.ts [AC-B3-08q#5] trace 写者抛错 (retitled; was: 该 run 不落卡 → now: the degraded run's cards there at once, recordCards never asked; one warn line when the writer was asked for that run at all, none otherwise — a degraded run has no model tool call left to trace) | 同上 | the same test; reply-persist/stored.int.test.ts [AC-B3-08zc#1] |
// | trace-persist/async.int.test.ts [AC-B3-08q#5] trace 写者变慢 (retitled; was: 写入放行后该 run 的卡才落库 → now: cards there at once while held, not written again once released) | 同上 | the same test; reply-persist/across.int.test.ts [AC-B3-08zc#3] 留痕写者挂起… |
// | trace-retry/erased.int.test.ts [AC-B3-08y#6] 首次写入失败后完成注销清理 (title kept; was: 无 agent_cards 行 → now: the ending's rows there at once, the queue's write again after the purge adds none — same card_ids as at the ending; tool-call rows still 0) | 同上 | the same test |
// | trace-retry/queue.test.ts (not changed; its pendingCard assertions in the queue's own tests) | 「不能靠进程内的待写内容」 | kept as they are: the implementation keeps TraceRedoQueue.pendingCard as a queue method, but the runtime no longer reads it (no card reference resolves from it: across / crash tests above) |
// Successors of the deleted files' scenarios that remain under the new rule: the order card of an
// earlier turn resolves in a new assembly (across); a crashed turn leaves no card and naming its
// card_id later is invalid (crash); a reply that ran on after the client left is stored (disconnect).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import {
  PostgresQueryCompiler,
  sql,
  type Kysely,
  type KyselyPlugin,
  type Transaction,
} from 'kysely';
import { expect } from 'vitest';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type { AgentHistoryHttp } from '../../../../apps/api/src/modules/agent/http/history.ts';
import {
  createAgentHistoryRuntime,
  createAgentStreamRuntime,
  createProductionStreamAssembly,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import type { Clock } from '../../../../apps/api/src/modules/platform/index.ts';
import { compile, contract, object, operation } from '../../contracts/agent-http/kit.ts';
import { gate, type Gate } from '../core-reply-templates/kit.ts';
import type { OrderDetail } from '../stream-assembly-orders/kit.ts';
import { httpStatusOf } from '../stream-http/kit.ts';
import {
  FakeReply,
  Logs,
  ManualTime,
  PassInputCheck,
  bindConsentReader,
  contentReaderFor,
  framesOf,
  loadConsentReader,
  message,
  retrace,
  runRow,
  stepUntil,
  until,
  type Frame,
  type Rig,
  type Row,
} from '../stream-mount/kit.ts';
import { item, selfDetail } from '../tools-orders/kit.ts';
import {
  cardFramesOf,
  cardRowsOf,
  finishOf,
  runIdOf,
  type ProductionRig,
  type RunAt,
} from '../trace-persist/kit.ts';

export type { Frame, Row, RunAt };

/** The order every order tool of these tests finds. */
export const ORDER_ID = '0192f3a1-7c00-7000-8000-00000000d081';
export const LIST_ASK = '我最近买的牛奶返了吗';
export const EXPLAIN_ASK = '刚才那一单现在怎么样了';
export const LIST_ARGS = { date_from: '2026-10-01', date_to: '2026-10-06' };
export const HISTORY_PATH = '/v1/agent/sessions/{id}/messages';

/** list_my_orders finds ORDER_ID (taobao); orders.get answers it for that id only. */
export function withOrder(x: ProductionRig): void {
  x.f.searchForAgent.mockResolvedValue({
    orders: [item({ order_id: ORDER_ID, platform: 'taobao' })],
    total: 1,
  });
  const detail: OrderDetail = { ...selfDetail(), order_id: ORDER_ID };
  x.f.get.mockImplementation(async (_subject, orderId) => (orderId === ORDER_ID ? detail : null));
}

// ---- frames -------------------------------------------------------------------------------------

export function deltasOf(frames: readonly Frame[]): string[] {
  return frames
    .filter((frame) => frame.event === 'text.delta')
    .map((frame) => String(frame.data['delta']));
}

/** What the user read: every text.delta of the reply, joined ('' when none). */
export function replyTextOf(frames: readonly Frame[]): string {
  return deltasOf(frames).join('');
}

/** meta.message_id of a reply (the assistant row's id). */
export function messageIdOf(frames: readonly Frame[]): string {
  const id = frames.find((frame) => frame.event === 'meta')?.data['message_id'];
  expect(id, 'meta.message_id').toBeTypeOf('string');
  return id as string;
}

export function cardIdsOf(frames: readonly Frame[]): string[] {
  return cardFramesOf(frames).map((frame) => frame.data['card_id'] as string);
}

/** What agent_cards.data and the history keep of a card's data (earnings: no amounts). */
export function keptDataOf(type: unknown, data: Row): Row {
  if (type !== 'earnings_summary') return data;
  return { as_of: data['as_of'], actions: data['actions'] };
}

export interface HistoryCard {
  readonly card_id: string;
  readonly type: string;
  readonly schema_version: number;
  readonly data: Row;
  readonly fallback_text: string;
}

/** The reply's card frames as the history shows them (no seq; earnings without amounts). */
export function historyCardsOf(frames: readonly Frame[]): HistoryCard[] {
  return cardFramesOf(frames).map((frame) => ({
    card_id: frame.data['card_id'] as string,
    type: frame.data['type'] as string,
    schema_version: frame.data['schema_version'] as number,
    data: keptDataOf(frame.data['type'], frame.data['data'] as Row),
    fallback_text: frame.data['fallback_text'] as string,
  }));
}

/** Whether a card frame was written. */
export function carded(frames: readonly Frame[]): boolean {
  return cardFramesOf(frames).length > 0;
}

export function isTerminal(frame: Frame): boolean {
  return frame.event === 'done' || frame.event === 'error';
}

// ---- stored rows --------------------------------------------------------------------------------

export interface MessageRow {
  readonly id: string;
  readonly role: string;
  readonly text: string | null;
  readonly card_ids: string[];
  readonly created_at: Date;
}

/** The run's row of `role` in app.agent_messages (exactly one). */
export async function messageRowOf(
  db: Kysely<DB>,
  runId: string,
  role: 'user' | 'assistant',
): Promise<MessageRow> {
  const result = await sql<MessageRow>`SELECT id::text AS id, role, text, card_ids, created_at
    FROM app.agent_messages WHERE run_id::text = ${runId} AND role = ${role}`.execute(db);
  expect(result.rows, `agent_messages ${role} row of run ${runId}`).toHaveLength(1);
  return result.rows[0]!;
}

/**
 * Read at once (no polling): the run's assistant row carries the reply's text and card ids, and
 * app.agent_cards holds exactly the reply's cards under the run, as framed.
 */
export async function expectReplyStored(
  db: Kysely<DB>,
  at: RunAt,
  frames: readonly Frame[],
): Promise<void> {
  const assistant = await messageRowOf(db, at.runId, 'assistant');
  expect(assistant.id, 'the assistant row is meta.message_id').toBe(messageIdOf(frames));
  expect(assistant.text, 'assistant text = the deltas joined').toBe(replyTextOf(frames));
  const ids = cardIdsOf(frames);
  expect(assistant.card_ids, 'assistant card_ids = the card frames, in order').toEqual(ids);
  const rows = await cardRowsOf(db, 'run_id', at.runId);
  expect(
    rows.map((row) => row.card_id).sort(),
    'exactly one agent_cards row per card of the run',
  ).toEqual([...ids].sort());
  for (const frame of cardFramesOf(frames)) {
    const id = frame.data['card_id'];
    const data = frame.data['data'] as Row;
    const linkId = data['link_id'];
    expect(
      rows.find((row) => row.card_id === id),
      `stored ${String(id)}`,
    ).toEqual({
      app_id: at.appId,
      session_id: at.sessionId,
      run_id: at.runId,
      card_id: id,
      type: frame.data['type'],
      data: keptDataOf(frame.data['type'], data),
      link_id: typeof linkId === 'string' ? linkId : null,
      schema_version: frame.data['schema_version'],
      fallback_text: frame.data['fallback_text'],
    });
  }
}

/** Either the terminal state and the whole reply are committed, or neither (and no terminal frame). */
export async function expectAllOrNothing(
  db: Kysely<DB>,
  at: RunAt,
  frames: readonly Frame[],
): Promise<'both' | 'neither'> {
  const run = await runRow(db, at.runId);
  if (run['final_event'] !== null) {
    await expectReplyStored(db, at, frames);
    return 'both';
  }
  const assistant = await messageRowOf(db, at.runId, 'assistant');
  expect(assistant.text, 'no terminal state: no reply text').toBeNull();
  expect(assistant.card_ids, 'no terminal state: no card ids').toEqual([]);
  expect(await cardRowsOf(db, 'run_id', at.runId), 'no card rows').toEqual([]);
  expect(frames.some(isTerminal), 'no terminal frame was written').toBe(false);
  return 'neither';
}

// ---- faults -------------------------------------------------------------------------------------

/**
 * The same database where the first statement inserting into agent_cards (builder or raw SQL,
 * with or without the app schema) throws before it is sent; every other statement runs.
 */
export function failFirstCardInsert(db: Kysely<DB>): { db: Kysely<DB>; failed: () => number } {
  const compiler = new PostgresQueryCompiler();
  let failed = 0;
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (failed > 0) return node;
      const compiled = compiler.compileQuery(node, queryId);
      if (/insert\s+into\s+(?:"?app"?\s*\.\s*)?"?agent_cards"?[\s(]/iu.test(compiled.sql)) {
        failed += 1;
        throw new Error('合成故障：agent_cards 写入失败');
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
  return { db: db.withPlugin(plugin), failed: () => failed };
}

// ---- runs that do not simply end ---------------------------------------------------------------

/** A model round that waits at its gate; reached is set once it started. */
export interface Held {
  reached: boolean;
  readonly gate: Gate;
}

export function held(): Held {
  return { reached: false, gate: gate() };
}

/** `before` of a scripted step: marks the round as reached, then waits for the gate. */
export function waitAt(h: Held): () => Promise<void> {
  return async () => {
    h.reached = true;
    await h.gate.promise;
  };
}

export type Interruption = 'timeout' | 'cancelled';

/**
 * Sends `text` on `sessionId`; once `ready(frames)` holds and the held model round is in progress,
 * ends the run by `how` (cancel: before the deadline; timeout: the fixture clock and scheduler moved
 * past it, ../trace-persist/interrupted.int.test.ts precedent). The held round answers only after
 * the run ended. Returns the reply's frames.
 */
export async function interruptedRun(
  db: Kysely<DB>,
  x: ProductionRig,
  h: Held,
  sessionId: string,
  text: string,
  how: Interruption,
  ready: (frames: readonly Frame[]) => boolean,
): Promise<Frame[]> {
  const reply = new FakeReply();
  let settled = false;
  let failure: unknown;
  const sending = x.r.runtime.http
    .sendMessage(retrace(x.f.caller), sessionId, message(text), reply)
    .then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        failure = error;
      },
    );
  try {
    await until(
      'the run is in progress at the held model round',
      () => h.reached && framesOf(reply.chunks).length > 0 && ready(framesOf(reply.chunks)),
    );
    expect(settled, 'the run is in progress').toBe(false);
    const runId = runIdOf(framesOf(reply.chunks));
    const deadlineAt = (await runRow(db, runId))['deadline_at'] as string | Date;
    const leftMs = new Date(deadlineAt).getTime() - x.f.time.clock.now().getTime();
    expect(leftMs, 'the run is before its deadline').toBeGreaterThan(0);
    if (how === 'cancelled') {
      const answer = new FakeReply();
      await x.r.runtime.http.cancelRun(retrace(x.f.caller), runId, answer);
      const call = answer.single();
      expect(call.status, JSON.stringify(call.body)).toBe(200);
      await stepUntil(x.r, db, () => settled, x.f.time.t + leftMs - 1);
      expect(settled, 'the cancelled run ended before its deadline').toBe(true);
    } else {
      await stepUntil(x.r, db, () => settled, x.f.time.t + leftMs + 5_000);
      expect(settled, 'the run ended at its time limit').toBe(true);
    }
    await sending;
    expect(failure, 'the send handler resolved').toBeUndefined();
    return framesOf(reply.chunks);
  } finally {
    h.gate.open();
    await sending;
  }
}

/**
 * Sends `text` on `sessionId`; once the run is accepted and its held model round started, the
 * client goes away (no later write reaches it), then the round answers. The manual clock is not
 * moved, so the run ends within the disconnect grace. Returns the frames written before.
 */
export async function disconnectedRun(
  x: ProductionRig,
  h: Held,
  sessionId: string,
  text: string,
): Promise<{ readonly frames: Frame[]; readonly reply: FakeReply }> {
  const reply = new FakeReply();
  let settled = false;
  let failure: unknown;
  const sending = x.r.runtime.http
    .sendMessage(retrace(x.f.caller), sessionId, message(text), reply)
    .then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        failure = error;
      },
    );
  try {
    await until(
      'the run is accepted and its model round is held',
      () => h.reached && framesOf(reply.chunks).length > 0,
    );
    expect(settled, 'the run is in progress').toBe(false);
    reply.close();
    h.gate.open();
    await until('the run ended after the client went away', () => settled);
    await sending;
    expect(failure, 'the send handler resolved').toBeUndefined();
    return { frames: framesOf(reply.chunks), reply };
  } finally {
    h.gate.open();
    await sending;
  }
}

/**
 * Sends `body` on `sessionId` and returns once `ready(frames)` holds and the held round started;
 * the process then "dies": its handler is left pending and its clock is never moved again.
 */
export async function dyingRun(
  x: ProductionRig,
  h: Held,
  sessionId: string,
  body: Row,
  ready: (frames: readonly Frame[]) => boolean,
): Promise<Frame[]> {
  const reply = new FakeReply();
  void x.r.runtime.http
    .sendMessage(retrace(x.f.caller), sessionId, body, reply)
    .catch(() => undefined);
  await until(
    'the run is in progress at the held model round',
    () => h.reached && framesOf(reply.chunks).length > 0 && ready(framesOf(reply.chunks)),
  );
  return framesOf(reply.chunks);
}

/** A reply in progress at its held model round (heldRun). */
export interface HeldRun {
  readonly reply: FakeReply;
  /** The frames written so far. */
  frames(): Frame[];
  settled(): boolean;
  /** Opens the held round and waits for the send handler; returns every frame of the reply. */
  finish(): Promise<Frame[]>;
}

/**
 * Sends `text` on `sessionId` and returns once the held model round started and `ready(frames)`
 * holds (meta is always there first). Nothing else happens until finish() (or h.gate.open()).
 */
export async function heldRun(
  x: ProductionRig,
  h: Held,
  sessionId: string,
  text: string,
  ready: (frames: readonly Frame[]) => boolean = () => true,
): Promise<HeldRun> {
  const reply = new FakeReply();
  let settled = false;
  let failure: unknown;
  const sending = x.r.runtime.http
    .sendMessage(retrace(x.f.caller), sessionId, message(text), reply)
    .then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        failure = error;
      },
    );
  await until(
    'the run is in progress at the held model round',
    () => h.reached && framesOf(reply.chunks).length > 0 && ready(framesOf(reply.chunks)),
  );
  expect(settled, 'the run is in progress').toBe(false);
  return {
    reply,
    frames: () => framesOf(reply.chunks),
    settled: () => settled,
    async finish() {
      h.gate.open();
      await sending;
      expect(failure, 'the send handler resolved').toBeUndefined();
      return framesOf(reply.chunks);
    },
  };
}

/** Milliseconds of a timestamp column read back (Date or string). */
export function timeOf(value: unknown): number {
  expect(value instanceof Date || typeof value === 'string', 'a timestamp').toBe(true);
  return new Date(value as string | Date).getTime();
}

// ---- observing the ending from outside ---------------------------------------------------------

/** An open transaction of another connection, holding what `work` took until release(). */
export interface Blocker {
  /** Rolls the transaction back (what it held is gone) and waits for it to end. */
  release(): Promise<void>;
}

class Released extends Error {}

/** Runs `work` in a transaction of `db` and keeps that transaction open until release(). */
export async function holdOpen(
  db: Kysely<DB>,
  work: (trx: Transaction<DB>) => Promise<void>,
): Promise<Blocker> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let ready = false;
  let markReady!: () => void;
  const isReady = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const done = db
    .transaction()
    .execute(async (trx) => {
      await work(trx);
      ready = true;
      markReady();
      await gate;
      throw new Released('合成：放开（回滚）');
    })
    .then(
      () => undefined,
      (error: unknown) => {
        if (!(error instanceof Released)) throw error;
      },
    );
  const early = done.then(() => {
    if (!ready) throw new Error('the blocking transaction ended before it held anything');
  });
  await Promise.race([isReady, early]);
  return {
    async release() {
      open();
      await done;
    },
  };
}

/**
 * Another connection inserts, uncommitted, an agent_cards row of the session with `cardId` (the
 * card the run is about to store), under the earlier run `at.runId` of that session — never the
 * run that is ending, whose row it would lock. Storing that card_id then waits for release().
 */
export function blockCardInsert(db: Kysely<DB>, at: RunAt, cardId: string): Promise<Blocker> {
  return holdOpen(db, async (trx) => {
    await sql`INSERT INTO app.agent_cards
        (id, app_id, session_id, run_id, card_id, type, data, schema_version, fallback_text)
      VALUES (${randomUUID()}, ${at.appId}, ${at.sessionId}, ${at.runId}, ${cardId}, 'notice',
        '{}'::jsonb, 1, '合成占位卡')`.execute(trx);
  });
}

/** Another connection locks the assistant row `messageId` (FOR UPDATE) until release(). */
export function lockAssistantRow(db: Kysely<DB>, messageId: string): Promise<Blocker> {
  return holdOpen(db, async (trx) => {
    const locked = await sql`SELECT id FROM app.agent_messages WHERE id = ${messageId}
      FOR UPDATE`.execute(trx);
    expect(locked.rows, 'the assistant row is locked').toHaveLength(1);
  });
}

/** Backends of this database waiting on a lock (pg_stat_activity, any role). */
export async function lockWaiters(db: Kysely<DB>): Promise<number> {
  const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'
      AND pid <> pg_backend_pid()`.execute(db);
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * Read through `db` (another pool) while the reply write waits: nothing of the ending is
 * committed — final_event NULL, the assistant row untouched (text NULL, card_ids {}), no
 * agent_cards row of the run — and no terminal frame has been written.
 */
export async function expectNothingCommitted(
  db: Kysely<DB>,
  at: RunAt,
  frames: readonly Frame[],
): Promise<void> {
  const run = await runRow(db, at.runId);
  expect(run['final_event'], 'no terminal state committed while the reply waits').toBeNull();
  const assistant = await messageRowOf(db, at.runId, 'assistant');
  expect(assistant.text, 'no reply text committed while the reply waits').toBeNull();
  expect(assistant.card_ids, 'no card ids committed while the reply waits').toEqual([]);
  expect(await cardRowsOf(db, 'run_id', at.runId), 'no card committed while waiting').toEqual([]);
  expect(frames.some(isTerminal), 'no terminal frame before the reply is stored').toBe(false);
}

// ---- another process ----------------------------------------------------------------------------

/**
 * Another production stream process on the same database: createProductionStreamAssembly and
 * createAgentStreamRuntime with the fixture's ports (the order stand-ins are shared, so their
 * calls are counted together) but a clock, scheduler, logger and readers of its own; nothing in
 * memory is shared with `x`'s runtime. The scripted model of `x` (scriptModel) applies here too.
 */
export async function anotherProcess(db: Kysely<DB>, x: ProductionRig): Promise<Rig> {
  const time = new ManualTime();
  const logs = new Logs();
  const assembly = createProductionStreamAssembly({
    db,
    clock: time.clock,
    logger: logs.logger,
    scheduler: time.scheduler,
    contentReader: contentReaderFor(db, time.clock),
    ports: x.f.ports,
  });
  const consentReader = bindConsentReader(await loadConsentReader(), db);
  const runtime = createAgentStreamRuntime(
    {
      db,
      clock: time.clock,
      logger: logs.logger,
      contentReader: contentReaderFor(db, time.clock),
      consentReader,
      assembly: () => assembly,
    },
    { inputCheck: new PassInputCheck(), schedule: time.scheduler },
  );
  return { time, logs, runtime };
}

// ---- the history read side ----------------------------------------------------------------------

/**
 * createAgentHistoryRuntime over `db` and `clock` with read dependencies of its own (content and
 * consent readers built here, as app.module provides them; a fresh logger).
 */
export async function historySide(db: Kysely<DB>, clock: Clock): Promise<AgentHistoryHttp> {
  const consentReader = bindConsentReader(await loadConsentReader(), db);
  return createAgentHistoryRuntime({
    db,
    clock,
    logger: new Logs().logger,
    contentReader: contentReaderFor(db, clock),
    consentReader,
  });
}

/** listMessages for `caller` on a new request (new trace id); the reply and that caller. */
export async function listHistory(
  history: AgentHistoryHttp,
  caller: AgentCaller,
  sessionId: string,
  query: unknown = {},
): Promise<{ readonly reply: FakeReply; readonly caller: AgentCaller }> {
  const who = retrace(caller);
  const reply = new FakeReply();
  await history.listMessages(who, sessionId, query, reply);
  return { reply, caller: who };
}

/** The JSON schema the contract declares for `status` on the history operation, as a check. */
export async function historyResponseCheck(status: number): Promise<(value: unknown) => void> {
  const responses = object(operation(await contract(), 'get', HISTORY_PATH)['responses']);
  const key = Object.hasOwn(responses, String(status)) ? String(status) : `${String(status)[0]}XX`;
  expect(responses, `the history operation declares ${String(status)}`).toHaveProperty(key);
  const content = object(object(responses[key])['content']);
  const validate = compile(object(object(content['application/json'])['schema']));
  return (value: unknown) => {
    expect(validate(value), JSON.stringify({ value, errors: validate.errors })).toBe(true);
  };
}

export interface HistoryItem {
  readonly message_id: string;
  readonly role: 'user' | 'assistant';
  readonly created_at: string;
  readonly text: string;
  readonly cards: readonly HistoryCard[];
  readonly finish_reason: string | null;
}

export interface HistoryData {
  readonly items: readonly HistoryItem[];
  readonly next_cursor: string | null;
  readonly expired: boolean;
}

function contentType(headers: Readonly<Record<string, string>>): string {
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'content-type');
  return key === undefined ? '' : (headers[key] ?? '');
}

/** One 200 JSON answer that passes the contract's AgentHistoryResponse; returns data. */
export async function expectHistory(reply: FakeReply, caller: AgentCaller): Promise<HistoryData> {
  const call = reply.single();
  expect(call.status, JSON.stringify(call.body)).toBe(200);
  expect(contentType(call.headers)).toMatch(/^application\/json/u);
  expect(call.body['code']).toBe(0);
  expect(call.body['msg']).toBe('');
  expect(call.body['trace_id']).toBe(caller.traceId);
  (await historyResponseCheck(200))(call.body);
  return object(call.body['data']) as unknown as HistoryData;
}

/** One JSON refusal of the history operation: code, status, data as given (absent when undefined). */
export async function expectHistoryRefused(
  reply: FakeReply,
  caller: AgentCaller,
  code: number,
  data?: Row,
): Promise<void> {
  const call = reply.single();
  expect(call.body['code'], 'error code').toBe(code);
  expect(call.status, `HTTP status of ${String(code)}`).toBe(httpStatusOf(code));
  expect(contentType(call.headers)).toMatch(/^application\/json/u);
  expect(call.body['trace_id']).toBe(caller.traceId);
  if (data === undefined) expect(call.body).not.toHaveProperty('data');
  else expect(call.body['data']).toEqual(data);
  (await historyResponseCheck(call.status))(call.body);
}

/** The history item of a run's user message: the stored (redacted) text. */
export async function userItemOf(
  db: Kysely<DB>,
  runId: string,
): Promise<Omit<HistoryItem, 'created_at'>> {
  const row = await messageRowOf(db, runId, 'user');
  expect(row.text, 'the stored user text').toBeTypeOf('string');
  return {
    message_id: row.id,
    role: 'user',
    text: row.text ?? '',
    cards: [],
    finish_reason: null,
  };
}

/**
 * The history item of a reply its own process ended: finish_reason is the done frame's (the
 * stored agent_runs.finish_reason, which must agree, when the reply ended with an error frame).
 */
export async function assistantItemOf(
  db: Kysely<DB>,
  frames: readonly Frame[],
): Promise<Omit<HistoryItem, 'created_at'>> {
  const stored = (await runRow(db, runIdOf(frames)))['finish_reason'];
  expect(stored, 'the run ended with a finish reason').toBeTypeOf('string');
  const done = finishOf(frames);
  if (done !== undefined) expect(stored, 'the stored finish reason').toBe(done);
  return {
    message_id: messageIdOf(frames),
    role: 'assistant',
    text: replyTextOf(frames),
    cards: historyCardsOf(frames),
    finish_reason: stored as string,
  };
}

/** Items without created_at; created_at is checked to be RFC 3339 and never decreasing. */
export function timelessItems(items: readonly HistoryItem[]): Omit<HistoryItem, 'created_at'>[] {
  let previous = Number.NEGATIVE_INFINITY;
  return items.map(({ created_at: createdAt, ...rest }) => {
    expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u);
    const at = Date.parse(createdAt);
    expect(at, 'items oldest first').toBeGreaterThanOrEqual(previous);
    previous = at;
    return rest;
  });
}
