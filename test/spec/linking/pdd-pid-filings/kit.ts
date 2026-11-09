// B1-06zi rule-test helpers (FU-PDD-BINDING-PID second order; BR-ID-22 「拼多多：授权状态按
// (user_id, pid) 记录……查询返回已授权才置 active」; D10-1061 ② / D10-1063 / D10-1097 (B)).
// app.union_pdd_pid_filings (B1-06zh, migration 0135) holds one row per (app_id, user_id, pid):
// "authority.query answered filed for this user on this pid at filed_at, through union_account_id".
// The open / bindings fixtures come from the frozen kits (open-pdd-auth/kit.ts,
// bindings-pdd-query/kit.ts), imported and never modified. Their pid service answers
// `current-pdd-<scene>` during an open and `snapshot-pdd-<scene>` while the link was registered
// (open-pdd-auth); the bindings refresh's self_buy slot is `synthetic-self-buy`.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { fixture, type Setup } from '../open-pdd-auth/kit.ts';

export const TIMEOUT = 60_000;
/** A filing instant earlier than every injected clock reading of the fixtures. */
export const EARLIER = new Date('2026-09-01T00:00:00.000Z');
/** The bindings refresh fixture's self_buy slot (bindings-pdd-query/kit.ts getActivePid). */
export const REFRESH_PID = 'synthetic-self-buy';

/** The tenant fields both frozen fixtures expose (open-pdd-auth/database.ts seed). */
export interface Tenant {
  readonly db: Kysely<DB>;
  readonly appId: string;
  readonly accountId: string;
}

/** The slot getActivePid answers during an open (open-pdd-auth/kit.ts, phase `current`). */
export function currentPid(pidScene: string): string {
  return `current-pdd-${pidScene}`;
}

/** The slot getActivePid answered while the link was registered (phase `snapshot`). */
export function snapshotPid(pidScene: string): string {
  return `snapshot-pdd-${pidScene}`;
}

/** The tenant's filing rows (id / created_at left out: application-generated, not asserted). */
export function filings(t: Tenant) {
  return t.db
    .selectFrom('union_pdd_pid_filings')
    .select(['app_id', 'user_id', 'pid', 'union_account_id', 'platform', 'filed_at'])
    .where('app_id', '=', t.appId)
    .orderBy('pid')
    .orderBy('user_id')
    .execute();
}

/** The row expected for `userId` on `pid`, filed through the fixture's account at `at`. */
export function filed(t: Tenant, userId: string, pid: string, at: Date) {
  return {
    app_id: t.appId,
    user_id: userId,
    pid,
    union_account_id: t.accountId,
    platform: 'pdd',
    filed_at: at,
  };
}

/** Seeds a filing row written earlier (as couli_app may: SELECT / INSERT only). */
export async function file(t: Tenant, userId: string, pid: string): Promise<void> {
  await t.db
    .insertInto('union_pdd_pid_filings')
    .values({
      id: randomUUID(),
      app_id: t.appId,
      user_id: userId,
      pid,
      union_account_id: t.accountId,
      filed_at: EARLIER,
    })
    .execute();
}

/** Moves the user's stored pdd binding to `status` (the console / risk / activation end state). */
export async function setBinding(
  t: Tenant,
  userId: string,
  status: 'active' | 'blocked' | 'invalid',
): Promise<void> {
  await t.db
    .updateTable('union_bindings')
    .set({ status, blocked_reason: status === 'blocked' ? 'admin_disable' : null })
    .where('app_id', '=', t.appId)
    .where('user_id', '=', userId)
    .where('platform', '=', 'pdd')
    .execute();
}

/**
 * An open fixture whose own binding is active with no filing row at all. Built as pending_auth and
 * then moved to active, so it holds whether or not the frozen open kit seeds the current slots'
 * filing rows for `binding: 'active'` (B1-06zj): couli_app cannot DELETE seeded rows.
 */
export async function activeUnfiled(db: Kysely<DB>, setup: Omit<Setup, 'binding'>) {
  const f = await fixture(db, { ...setup, binding: 'pending_auth' });
  await setBinding(f, f.a.userId, 'active');
  return f;
}

/** BR-ID-31: the user is banned (a session still reaching the open asks to log in). */
export async function ban(t: Tenant, userId: string, at: Date): Promise<void> {
  await t.db
    .updateTable('user_risk_state')
    .set({ state: 'banned', reason_category: 'other', changed_at: at })
    .where('app_id', '=', t.appId)
    .where('user_id', '=', userId)
    .execute();
}

/**
 * A meeting point for `parties` concurrent callers: each waits until all arrived, or `waitMs`
 * at most (an implementation serializing the callers before this point must not deadlock here).
 */
export function rendezvous(parties: number, waitMs: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => undefined;
  const all = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) release();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    });
    await Promise.race([all, deadline]);
    clearTimeout(timer);
  };
}
