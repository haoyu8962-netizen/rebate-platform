// B3-08w rule-test kit · BR-AI-01 细则「判定顺序」②「承接上文的订单按 order_query」, ③ identity first
// (a guest gets auth_required(login): orders `agent.need_login`, earnings
// `agent.earnings.need_login`); BR-AI-20 (only this app, only this session); BR-AI-19 (intent is a
// run-level trace field). D10-1022 ④「上一轮」.
//
// Contract pinned by the tests of this directory (the implementation's freedom ends here):
// - apps/api/src/modules/agent/store/runs/index.ts exports createPgPreviousIntentReader({db});
//   its previousIntent({appId, sessionId, runId}) reads app.agent_runs through deps.db only:
//   · "the previous run" = the one row with app_id = appId, session_id = sessionId, id ≠ runId and
//     accepted_at earlier than the accepted_at of run runId, first by accepted_at desc, id desc
//     (run runId was inserted at its acceptance and never counts itself; "earlier" is strict: a
//     run accepted at the same instant as run runId never counts, whatever its intent);
//   · its intent 'order_query' / 'earnings_query' is returned as is; any other value, NULL, or no
//     previous run → null; no time window; never a look past that one row;
//   · other sessions and other apps never count; a sessionId that is not a UUID → null without any
//     query; a failing read rejects with the database error.
// - The stream assembly (createAgentStreamAssembly, hence createProductionStreamAssembly) obtains
//   its reader from that module's createPgPreviousIntentReader over the assembly's db (when the
//   assembly is built or later; the tests spy on it there before anything is built) and answers
//   the intent port's continuation.previousIntent(request) with exactly one
//   reader.previousIntent({appId: request.input.caller.appId, sessionId: request.input.sessionId,
//   runId: request.input.runId}). A rejecting reader is logged as exactly ONE warn line, msg
//   PREVIOUS_INTENT_WARN, flat field run_id, no user text; previousIntent then answers null and
//   the run goes on unchanged (拿不准按查收益).
// - The intent port itself (classify.ts / port.ts) is not changed: only 「那返了吗」-like questions
//   (personal data without an order or account noun) consult previousIntent.
// Fixture intents are written by the tests (INSERT / UPDATE of agent_runs.intent): the writer of
// intent is B3-08t, not this task. The production runtime never calls a model, so the runtime
// tests wrap its core body with a scripted model (../trace-persist/kit.ts productionRig).
// Everything under test is built inside the tests (never in hooks). Synthetic values only.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely, type KyselyPlugin } from 'kysely';
import { expect, vi } from 'vitest';
import * as runs from '../../../../apps/api/src/modules/agent/store/runs/index.ts';
import type {
  PreviousIntentQuery,
  PreviousIntentReader,
  PreviousRunIntent,
} from '../../../../apps/api/src/modules/agent/store/runs/index.ts';
import { APP, fileText, newGuest, setConfig } from '../stream-mount/kit.ts';
import {
  cardFramesOf,
  finishOf,
  productionRig,
  type Frame,
  type ProductionRig,
  type Step,
} from '../trace-persist/kit.ts';

export { APP };

/** The one warn line of a run whose previous intent could not be read (flat fields, run_id). */
export const PREVIOUS_INTENT_WARN = 'agent_previous_intent_failed';

/** The synthetic read failure (the database error the reader passes on). */
export const READ_FAILURE = '合成读库失败';

/** An app that holds none of the tests' rows. */
export const OTHER_APP = 'synthetic-b3-08w-other-app';

/** The elliptical question: personal data without an order or account noun. */
export const ASK = '那返了吗';
/** Two plain openers (each run's model is scripted by its user text). */
export const OPENER = '你好';
export const OPENER_2 = '在吗';

/** The texts a guest gets (BR-AI-01 判定顺序③). */
export const ORDER_LOGIN = 'agent.need_login';
export const EARNINGS_LOGIN = 'agent.earnings.need_login';

/** Every contract intent that is neither order_query nor earnings_query (db agent_runs_intent_check). */
export const OTHER_INTENTS = [
  'find_by_link',
  'search',
  'refine',
  'rule_qa',
  'handoff',
  'clarify',
  'out_of_scope',
  'page_guide',
] as const;

// ---- rows for the reader tests -------------------------------------------------------------------

const T0 = Date.parse('2026-11-01T02:00:00Z');

/** T0 + n minutes. */
export function minute(n: number): Date {
  return new Date(T0 + n * 60_000);
}

/** A guest's agent_sessions row of `appId` (a real devices row), started at T0. */
export async function newSessionRow(db: Kysely<DB>, appId: string = APP): Promise<string> {
  const guest = await newGuest(db, appId);
  const id = randomUUID();
  await db
    .insertInto('agent_sessions')
    .values({
      id,
      app_id: appId,
      user_id: null,
      device_id: guest.deviceId,
      started_at: minute(0),
      last_active_at: minute(0),
    })
    .execute();
  return id;
}

/** A finished, refunded run on `sessionId` accepted at minute(`at`) with `intent`; its id. */
export async function addRun(
  db: Kysely<DB>,
  sessionId: string,
  at: number,
  intent: string | null,
): Promise<string> {
  const session = await db
    .selectFrom('agent_sessions')
    .select('app_id')
    .where('id', '=', sessionId)
    .executeTakeFirstOrThrow();
  const accepted = minute(at);
  const id = randomUUID();
  await db
    .insertInto('agent_runs')
    .values({
      id,
      app_id: session.app_id,
      session_id: sessionId,
      intent,
      prompt_version: 'none',
      accepted_at: accepted,
      deadline_at: new Date(accepted.getTime() + 20_000),
      quota_subjects: [`fixture:${sessionId}`],
      end_reason: 'stop',
      finish_reason: 'stop',
      settle_result: 'refunded',
      settled_at: accepted,
      final_event: sql`${JSON.stringify({ type: 'done', data: { finish_reason: 'stop' } })}::jsonb`,
      ended_at: accepted,
    })
    .execute();
  return id;
}

/**
 * `db` with a plugin that counts every query it runs; with `fail`, every query throws
 * READ_FAILURE instead of running (a database error).
 */
export function watchedDb(db: Kysely<DB>, fail = false) {
  const seen = { queries: 0 };
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      seen.queries += 1;
      if (fail) throw new Error(READ_FAILURE);
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  };
  return { db: db.withPlugin(plugin), seen };
}

// ---- the production stream runtime ---------------------------------------------------------------

export interface ReaderAsk {
  readonly query: PreviousIntentQuery;
  readonly answer: PreviousRunIntent | null | 'rejected';
}

/**
 * Spies on createPgPreviousIntentReader (agent/store/runs): every reader built from now on is the
 * real one, recorded (query and answer); after fail(), it rejects with READ_FAILURE instead.
 * Install before the assembly is built.
 */
export function watchReader() {
  const original = runs.createPgPreviousIntentReader;
  const asks: ReaderAsk[] = [];
  let failing = false;
  const spy = vi.spyOn(runs, 'createPgPreviousIntentReader').mockImplementation((deps) => {
    const real = original(deps);
    const reader: PreviousIntentReader = {
      async previousIntent(query) {
        const asked = { ...query };
        if (failing) {
          asks.push({ query: asked, answer: 'rejected' });
          throw new Error(READ_FAILURE);
        }
        const answer = await real.previousIntent(query);
        asks.push({ query: asked, answer });
        return answer;
      },
    };
    return reader;
  });
  return {
    spy,
    asks,
    fail(): void {
      failing = true;
    },
    /** The asks of run `runId`. */
    of(runId: string): ReaderAsk[] {
      return asks.filter((ask) => ask.query.runId === runId);
    },
  };
}

/** Each run's model by its user text: the openers answer plain text, ASK ends with earnings_query. */
export function scripts(): Record<string, readonly Step[]> {
  return {
    [OPENER]: [{ text: '你好。' }],
    [OPENER_2]: [{ text: '在的。' }],
    [ASK]: [{ text: JSON.stringify({ agent_intent: 'earnings_query' }) }],
  };
}

/**
 * The production stream entry of [AC-B3-08g] / [AC-B3-08q] for a new guest (agent open, consent
 * given, guest daily quota raised), the model scripted by scripts(), the reader watched.
 */
export async function guestRig(db: Kysely<DB>) {
  const reader = watchReader();
  const guest = await newGuest(db);
  await setConfig(db, guest.appId, 'agent.guest_daily_quota', 50);
  const x = await productionRig(db, { caller: guest, scripts: scripts() });
  return { x, reader };
}

/** The manual-clock gap between two turns of a test. */
export const TURN_GAP_MS = 1_000;

/**
 * Moves the runtime's manual clock (the one that stamps agent_runs.accepted_at) on by
 * TURN_GAP_MS: the next run is accepted strictly later than the one before (the reader's
 * "earlier than this run" is strict). Call between every two turns.
 */
export async function nextTurn(x: ProductionRig): Promise<void> {
  const before = x.r.time.clock.now().getTime();
  await x.r.time.by(TURN_GAP_MS);
  expect(x.r.time.clock.now().getTime(), 'the clock moved between turns').toBeGreaterThan(before);
}

/** Sets agent_runs.intent of an earlier run (the fixture stands in for B3-08t's writer). */
export async function setIntent(
  db: Kysely<DB>,
  runId: string,
  intent: string | null,
): Promise<void> {
  const updated = await db
    .updateTable('agent_runs')
    .set({ intent })
    .where('id', '=', runId)
    .executeTakeFirst();
  expect(Number(updated.numUpdatedRows), `intent fixture on run ${runId}`).toBe(1);
}

/** All text deltas of a reply, joined. */
export function textOf(frames: readonly Frame[]): string {
  return frames
    .filter((frame) => frame.event === 'text.delta')
    .map((frame) => {
      const delta = frame.data['delta'];
      return typeof delta === 'string' ? delta : '';
    })
    .join('');
}

/**
 * The reply is the guest's auth_required(login) for `key` (agent.need_login or
 * agent.earnings.need_login): finish auth_required, exactly one auth_required card whose
 * fallback_text is that text, and that text (never the other one) in the reply's text.
 */
export function expectLogin(frames: readonly Frame[], key: string): void {
  const other = key === ORDER_LOGIN ? EARNINGS_LOGIN : ORDER_LOGIN;
  expect(finishOf(frames), 'finish reason').toBe('auth_required');
  const cards = cardFramesOf(frames);
  expect(
    cards.map((frame) => frame.data['type']),
    'card types',
  ).toEqual(['auth_required']);
  const card = cards[0]?.data;
  expect(card?.['data'], 'auth_required data').toEqual({
    platform: null,
    reason: 'login',
    resume_link_id: null,
  });
  expect(card?.['fallback_text'], 'auth_required fallback_text').toBe(fileText(key));
  const text = textOf(frames);
  expect(text, 'reply text').toContain(fileText(key));
  expect(text, 'reply text').not.toContain(fileText(other));
}
