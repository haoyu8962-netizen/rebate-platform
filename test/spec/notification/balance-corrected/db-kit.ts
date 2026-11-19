// B2-02z rule-test database fixture (claude-independent; D10-2092 ⑤, D10-2097; contracts/openapi.yaml
// recalcBalanceAdminReconDiff「Member notice」). The writer under test is notification's
// recordBalanceCorrectedMessage, imported directly from its file (not through notification/index.ts)
// and called the way the recalculation calls it: on the caller's transaction, with
// { appId, userId, reconDiffId, balanceVersion, facts, now }. Fixture rows are written directly over
// the business role couli_app (synthetic data, a fresh app id per scenario); the test database is
// the integration test's createTestDatabase (depcruise allows @couli/db/testing in *.int.test.ts
// only), seen here as a Kysely handle.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import {
  recordBalanceCorrectedMessage,
  type BalanceCorrectedRecordInput,
} from '../../../../apps/api/src/modules/notification/application/balance-corrected-message-record.ts';
import { CODE } from './texts.ts';

export { recordBalanceCorrectedMessage };

/** The recalculation's instant: 2026-11-19 10:00 +08:00. */
export const NOW = new Date('2026-11-19T02:00:00.000Z');
export const DAY_MS = 86_400_000;

export type Executor = Kysely<DB> | Transaction<DB>;
export type LogRow = Selectable<DB['notify_logs']>;
export type InboxRow = Selectable<DB['inbox_messages']>;

export interface Member {
  readonly appId: string;
  readonly uid: string;
}

export function newAppId(): string {
  return `bc_${randomBytes(10).toString('hex')}`;
}

function at(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

/** A member (users.status as given) of a fresh app id unless given. */
export async function member(
  db: Executor,
  options: { readonly status: string; readonly appId?: string },
): Promise<Member> {
  const appId = options.appId ?? newAppId();
  const uid = randomUUID();
  await sql`INSERT INTO app.users
    (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, status,
     created_at, updated_at)
    VALUES (${uid}, ${appId}, '小狸', 'https://example.test/avatar.png',
      ${randomBytes(6).toString('hex')}, ${randomBytes(6).toString('hex')}, 'L1', 'sms',
      ${options.status}, ${at(-60 * DAY_MS)}, ${at(-60 * DAY_MS)})`.execute(db);
  return { appId, uid };
}

export type RequestStatus = 'cooling' | 'processing' | 'done';

/**
 * The member's deletion request (BR-ID-27): cooling — applied a day ago, cooling-off period still
 * running for six more days; processing — cooling ended a day ago; done — processed twelve hours ago.
 */
export async function deletionRequest(
  db: Executor,
  m: Member,
  status: RequestStatus,
): Promise<void> {
  const applyAt = status === 'cooling' ? at(-DAY_MS) : at(-8 * DAY_MS);
  const coolingUntil = status === 'cooling' ? at(6 * DAY_MS) : at(-DAY_MS);
  await db
    .withSchema('app')
    .insertInto('deletion_requests')
    .values({
      id: randomUUID(),
      app_id: m.appId,
      user_id: m.uid,
      status,
      apply_at: applyAt,
      cooling_until: coolingUntil,
      cancelled_at: null,
      cancel_reason: null,
      processed_at: status === 'done' ? at(-12 * 3_600_000) : null,
      balance_snapshot_fen: 0n,
      created_at: applyAt,
      updated_at: status === 'cooling' ? applyAt : coolingUntil,
    })
    .execute();
}

/** A notify_templates row of BALANCE_CORRECTED (variant default, inbox) with the given wording. */
export async function overrideRow(
  db: Executor,
  appId: string,
  wording: { readonly title_override: string | null; readonly body_override: string | null },
): Promise<void> {
  await db
    .withSchema('app')
    .insertInto('notify_templates')
    .values({
      app_id: appId,
      code: CODE,
      variant: 'default',
      category: 'service',
      channels: ['inbox'],
      title_override: wording.title_override,
      body_override: wording.body_override,
    })
    .execute();
}

/** The writer's input for a member (defaults: a fresh recon diff, balance version 3, NOW). */
export function inputOf(
  m: Member,
  facts: { readonly before_fen: bigint; readonly after_fen: bigint },
  options: { readonly reconDiffId?: string; readonly balanceVersion?: number } = {},
): BalanceCorrectedRecordInput {
  return {
    appId: m.appId,
    userId: m.uid,
    reconDiffId: options.reconDiffId ?? randomUUID(),
    balanceVersion: options.balanceVersion ?? 3,
    facts,
    now: NOW,
  };
}

/** The dedupe key D10-2084 pairs with the B2-02x voucher source recalc:<recon_diff_id>:<version>. */
export function dedupeKeyOf(input: BalanceCorrectedRecordInput): string {
  return `balance_corrected:${input.reconDiffId}:${String(input.balanceVersion)}`;
}

/** Runs the writer on a transaction of its own (committed), as the recalculation would. */
export function record(db: Kysely<DB>, input: BalanceCorrectedRecordInput): Promise<boolean> {
  return db.transaction().execute((trx) => recordBalanceCorrectedMessage(trx, input));
}

/** Every notify_logs row of the app, in a stable order. */
export function logsOf(db: Executor, appId: string): Promise<LogRow[]> {
  return db
    .withSchema('app')
    .selectFrom('notify_logs')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

/** Every inbox_messages row of the app, in a stable order. */
export function inboxOf(db: Executor, appId: string): Promise<InboxRow[]> {
  return db
    .withSchema('app')
    .selectFrom('inbox_messages')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('created_at')
    .orderBy('message_id')
    .execute();
}

/** Both tables of the app. */
export async function rowsOf(db: Executor, appId: string) {
  return { logs: await logsOf(db, appId), inbox: await inboxOf(db, appId) };
}
