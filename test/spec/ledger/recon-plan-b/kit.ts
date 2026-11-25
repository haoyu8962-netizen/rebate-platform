// B2-17 rule-test kit (claude-independent, SPEC_REF 1025764b): 08 BR-FUND-24 ⑨ and 细则「对外差错单的
// 调账」(负责人 2026-11-21 方案 B, 编排 D10-2317 ②; 多受益人取 (c), 变更记录 §5-14) with the task's
// 编排者补充 §9 (D10-2417, D10-3185, D10-3191): every executed manual adjustment that links recon
// diffs locks them, takes one row per diff in app.adjustment_recon_diffs, and CASes each diff from
// open / processing to adjusted (all involved members covered) or processing (some not yet); a
// second unreversed one for the same (diff, member) and any diff no longer open / processing →
// 20902 data.resource=recon_diff; a reversal marks the links and sends adjusted diffs back to
// processing; union_mismatch / channel_mismatch diffs are never linked by a person (20001
// adjust_ref_invalid). Shapes of the new objects: §9.2 (table app.adjustment_recon_diffs, column
// app.recon_diffs.involved_user_ids, index recon_diffs_app_id_id_key).
// Real pieces: the admin entry and its fixtures (../admin-adjustments/kit.ts), the close entry
// (../admin-recon-close/kit.ts), PostgreSQL as couli_app. Synthetic: members, diffs (written
// directly, with or without an involved-members list), holds and seeded forms. No real data.
// The new table and column do not exist before the migration: every test first asserts they do
// (schemaReady), so a missing migration is an assertion failure, never a database error.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  answer,
  audits,
  expectAdjusted,
  invalid,
  moneyOf,
  newForm,
  seedReconDiff,
  trace,
  type AdjustAdmin,
  type AdjustFixture,
  type Adjusted,
  type AdminCaller,
  type AdminSent,
  type Direction,
  type Expectation,
  type FormRow,
  type Ref,
} from '../admin-adjustments/kit.ts';
import type { DiffRow } from '../admin-recon-diffs/kit.ts';

export const LINKS = 'adjustment_recon_diffs';
export const ACTIVE_KEY = 'adjustment_recon_diffs_active_key';
export const LIST_COLUMN = 'involved_user_ids';
/** The minutes before the clock at which seeded diffs were registered (updated_at moves visibly). */
export const SEEDED_MINUTES_AGO = 120;

/** The new table and the new column exist (asserted before anything reads or writes them). */
export async function schemaReady(db: Kysely<DB>): Promise<void> {
  const result = await sql<{ links_table: boolean; list_column: boolean }>`
    SELECT to_regclass(${`app.${LINKS}`}) IS NOT NULL AS links_table,
      EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'recon_diffs'
          AND column_name = ${LIST_COLUMN}) AS list_column`.execute(db);
  expect(
    result.rows,
    `app.${LINKS} 与 app.recon_diffs.${LIST_COLUMN} 存在（迁移 *_adjustment-recon-diffs.sql）`,
  ).toEqual([{ links_table: true, list_column: true }]);
}

function earlier(f: AdjustFixture): Date {
  return new Date(f.clock.now().getTime() - SEEDED_MINUTES_AGO * 60_000);
}

export type DiffStatus = 'open' | 'processing' | 'adjusted' | 'written_off' | 'closed';

export interface TicketSeed {
  readonly status?: DiffStatus;
  readonly type?: string;
  readonly source?: 'R1' | 'R2' | 'R3' | 'R4';
  readonly refType?: string;
  readonly refId?: string;
  readonly period?: string;
  /** The involved members as registered; undefined: no list (NULL). */
  readonly users?: readonly string[];
}

/**
 * A diff of the fixture's app registered two hours ago (default R3 ledger_mismatch, open); with
 * `users` the involved-members list is written in the same INSERT (couli_app has no UPDATE on it).
 */
export async function seedTicket(f: AdjustFixture, seed: TicketSeed = {}): Promise<DiffRow> {
  const at = earlier(f);
  const status = seed.status ?? 'open';
  const closedAt = status === 'open' || status === 'processing' ? null : at;
  if (seed.users === undefined) {
    return seedReconDiff(f, {
      status,
      closed_at: closedAt,
      created_at: at,
      updated_at: at,
      ...(seed.type === undefined ? {} : { type: seed.type }),
      ...(seed.source === undefined ? {} : { source: seed.source }),
      ...(seed.refType === undefined ? {} : { ref_type: seed.refType }),
      ...(seed.refId === undefined ? {} : { ref_id: seed.refId }),
      ...(seed.period === undefined ? {} : { period: seed.period }),
    });
  }
  const id = randomUUID();
  await sql`INSERT INTO app.recon_diffs
    (id, app_id, type, source, period, ref_type, ref_id, expected_fen, actual_fen, diff_fen, status,
     handler_id, closed_at, dedupe_key, resolution, created_at, updated_at, involved_user_ids)
    VALUES (${id}, ${f.appId}, ${seed.type ?? 'ledger_mismatch'}, ${seed.source ?? 'R3'},
      ${seed.period ?? '2026-11-29'}, ${seed.refType ?? 'order'},
      ${seed.refId ?? `08:taobao:${id}`}, 0, 0, 0, ${status}, NULL, ${closedAt}, NULL, NULL,
      ${at}, ${at}, ${[...seed.users]}::uuid[])`.execute(f.db);
  return diffNow(f, id);
}

/** One recon_diffs row of the fixture's app as it is now (every column). */
export async function diffNow(f: AdjustFixture, id: string): Promise<DiffRow> {
  const row = await f.db
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('id', '=', id)
    .executeTakeFirst();
  expect(row, `recon_diffs ${id}`).toBeDefined();
  return row!;
}

/** The registered involved-members list of a diff (text form; null when NULL). */
export async function listOf(db: Kysely<DB>, appId: string, id: string): Promise<string[] | null> {
  const result = await sql<{ users: string[] | null }>`
    SELECT involved_user_ids::text[] AS users FROM app.recon_diffs
    WHERE app_id = ${appId} AND id = ${id}`.execute(db);
  expect(result.rows, `recon_diffs ${id}`).toHaveLength(1);
  return result.rows[0]!.users;
}

/** A ref to a diff. */
export function diffRef(diff: { readonly id: string }): Ref {
  return { ref_type: 'recon_diff', ref_id: diff.id };
}

// ---------------------------------------------------------------------------------------------
// The link table.

export interface LinkRow {
  readonly app_id: string;
  readonly adjust_id: string;
  readonly recon_diff_id: string;
  readonly user_id: string;
  readonly reversed_by_adjust_id: string | null;
  readonly created_at: Date;
}

/** Every link row of the app (or `appId`), by adjust_id then recon_diff_id. */
export async function linksOf(f: AdjustFixture, appId = f.appId): Promise<LinkRow[]> {
  const result = await sql<LinkRow>`
    SELECT app_id, adjust_id::text AS adjust_id, recon_diff_id::text AS recon_diff_id,
      user_id::text AS user_id, reversed_by_adjust_id::text AS reversed_by_adjust_id, created_at
    FROM app.adjustment_recon_diffs WHERE app_id = ${appId}
    ORDER BY adjust_id, recon_diff_id`.execute(f.db);
  return result.rows;
}

/** The link row an executed form takes for one diff, at the fixture's clock. */
export function linkOf(
  f: AdjustFixture,
  adjustId: string,
  diffId: string,
  userId: string,
  reversedBy: string | null = null,
  at: Date = f.clock.now(),
): LinkRow {
  return {
    app_id: f.appId,
    adjust_id: adjustId,
    recon_diff_id: diffId,
    user_id: userId,
    reversed_by_adjust_id: reversedBy,
    created_at: at,
  };
}

/** Link rows in the order linksOf returns them. */
export function sortedLinks(rows: readonly LinkRow[]): LinkRow[] {
  const key = (row: LinkRow) => `${row.adjust_id}|${row.recon_diff_id}`;
  return [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// Everything a refused or rolled-back request must leave as it was (§9.3 「不留痕」).

/** Every withdraw_holds row of the app, by id. */
export function holdsOf(f: AdjustFixture) {
  return f.db
    .selectFrom('withdraw_holds')
    .selectAll()
    .where('app_id', '=', f.appId)
    .orderBy('id')
    .execute();
}

/** Every recon_diffs row of the app, by id. */
export function diffsOf(f: AdjustFixture) {
  return f.db
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', f.appId)
    .orderBy('id')
    .execute();
}

/**
 * Forms, vouchers, entries, balances, events, inbox messages, notify_logs (kit trace), audit
 * records, link rows, diffs and holds of the app.
 */
export async function footprint(f: AdjustFixture) {
  return {
    trace: await trace(f),
    audits: await audits(f),
    links: await linksOf(f),
    diffs: await diffsOf(f),
    holds: await holdsOf(f),
  };
}

// ---------------------------------------------------------------------------------------------
// The three status writes of §9.3.

/** 置 adjusted: status, handler = the filer, closed_at = updated_at = the clock; nothing else. */
export async function expectNowAdjusted(
  f: AdjustFixture,
  before: DiffRow,
  handlerId: string,
): Promise<DiffRow> {
  const now = await diffNow(f, before.id);
  expect(now, `差错单 ${before.id} 置 adjusted`).toEqual({
    ...before,
    status: 'adjusted',
    handler_id: handlerId,
    closed_at: f.clock.now(),
    updated_at: f.clock.now(),
  });
  return now;
}

/** 置 processing (from open): status and updated_at; handler_id and closed_at stay empty. */
export async function expectNowProcessing(f: AdjustFixture, before: DiffRow): Promise<DiffRow> {
  expect(before.status, '置 processing 只写 open 的行').toBe('open');
  const now = await diffNow(f, before.id);
  expect(now, `差错单 ${before.id} 置 processing`).toEqual({
    ...before,
    status: 'processing',
    handler_id: null,
    closed_at: null,
    updated_at: f.clock.now(),
  });
  return now;
}

/** 退回 processing (from adjusted, a reversal): closed_at emptied, handler_id kept. */
export async function expectSentBack(f: AdjustFixture, before: DiffRow): Promise<DiffRow> {
  expect(before.status, '退回只写 adjusted 的行').toBe('adjusted');
  const now = await diffNow(f, before.id);
  expect(now, `差错单 ${before.id} 退回 processing`).toEqual({
    ...before,
    status: 'processing',
    closed_at: null,
    updated_at: f.clock.now(),
  });
  return now;
}

/** The row is exactly as it was. */
export async function expectUnchanged(f: AdjustFixture, before: DiffRow): Promise<void> {
  expect(await diffNow(f, before.id), `差错单 ${before.id} 整行不变`).toEqual(before);
}

// ---------------------------------------------------------------------------------------------
// Answers.

/** 20902 with data exactly { resource: 'recon_diff' }. */
export function diffConflict(sent: AdminSent) {
  return answer(sent, 20902, { resource: 'recon_diff' });
}

/** 20001 with data exactly { fields: ['refs'], reason: 'adjust_ref_invalid' }. */
export function refInvalid(sent: AdminSent) {
  return invalid(sent, ['refs'], 'adjust_ref_invalid');
}

// ---------------------------------------------------------------------------------------------
// Filing.

export interface Filing {
  readonly userId: string;
  readonly refs: readonly Ref[];
  readonly caller?: AdminCaller;
  readonly amount?: bigint;
  readonly direction?: 'increase' | 'decrease';
  readonly reason?: 'RECON_FIX' | 'OTHER';
  readonly key?: string;
}

const NOTE = '差错单核对后的更正';

/** The body of a RECON_FIX (or OTHER) form against COMMISSION_REVENUE. */
export function fixBody(filing: Filing): Record<string, unknown> {
  return newForm({
    userId: filing.userId,
    direction: filing.direction ?? 'increase',
    amount: filing.amount ?? 100n,
    reason: filing.reason ?? 'RECON_FIX',
    refs: filing.refs,
    note: NOTE,
    contra: 'COMMISSION_REVENUE',
  });
}

/** Sends the form (as `caller`, default maker). */
export function send(h: AdjustAdmin, filing: Filing): Promise<AdminSent> {
  return h.create(fixBody(filing), {
    ...(filing.caller === undefined ? {} : { caller: filing.caller }),
    ...(filing.key === undefined ? {} : { key: filing.key }),
  });
}

/** The expectation of kit.expectAdjusted for the filing with the member's money before. */
export async function expectationOf(
  f: AdjustFixture,
  h: AdjustAdmin,
  filing: Filing,
): Promise<Expectation> {
  const direction: Direction = filing.direction ?? 'increase';
  return {
    caller: filing.caller ?? h.maker,
    userId: filing.userId,
    direction,
    amount: filing.amount ?? 100n,
    reason: filing.reason ?? 'RECON_FIX',
    contra: 'COMMISSION_REVENUE',
    refs: filing.refs,
    note: NOTE,
    before: await moneyOf(f, filing.userId),
  };
}

/** Files the form and checks it took effect exactly as the trunk's submission does. */
export async function fileOk(f: AdjustFixture, h: AdjustAdmin, filing: Filing): Promise<Adjusted> {
  const expectation = await expectationOf(f, h, filing);
  return expectAdjusted(f, await send(h, filing), expectation);
}

/** Reverses a form whole (note given) and checks it took effect; returns the reversal. */
export async function reverseOk(
  f: AdjustFixture,
  h: AdjustAdmin,
  original: FormRow,
  caller: AdminCaller = h.maker,
): Promise<Adjusted> {
  const before = await moneyOf(f, original.user_id);
  const note = '核对有误，整笔冲回';
  const sent = await h.create({ reverses_adjust_id: original.adjust_id, note }, { caller });
  return expectAdjusted(f, sent, {
    caller,
    userId: original.user_id,
    direction: original.direction === 'increase' ? 'decrease' : 'increase',
    amount: original.amount_fen!,
    reason: original.reason_code,
    contra: original.contra_subject,
    platform: original.contra_platform,
    refs: [],
    note,
    reverses: original,
    before,
  });
}

/** Moves the clock one minute on (same accounting day), so each status write has its own instant. */
export function tick(f: AdjustFixture): void {
  f.clock.advanceMs(60_000);
}

// ---------------------------------------------------------------------------------------------
// PostgreSQL errors.

export interface PgOutcome {
  readonly code: string;
  readonly constraint: string | null;
}

/** 'ok' or the SQLSTATE and constraint of the error the statement raised. */
export async function outcome(run: Promise<unknown>): Promise<PgOutcome> {
  try {
    await run;
    return { code: 'ok', constraint: null };
  } catch (error) {
    const e = error as { code?: unknown; constraint?: unknown };
    if (typeof e.code !== 'string') throw error;
    return { code: e.code, constraint: typeof e.constraint === 'string' ? e.constraint : null };
  }
}
