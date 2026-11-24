// Hour alert nodes of the site authorization (B1-22zd; BR-ID-24 ② and 细则「授权时长与续期」;
// 编排裁定 D10-2585, D10-2587, D10-2758, D10-2771).
//
// Every hour node (union.auth_alert_hours, default [6, 1]) of an authorization that is not skipped
// (./schedule.ts) gets one delayed job `hour_alert` on queue union-auth, due at the node instant
// (auth_expires_at − N hours), instead of waiting for the daily check. Planned by whoever writes a
// new authorization: the re-authorization callback (./reauth.ts), the manual credential entry
// (../application/admin-accounts.ts) and a successful refresh, each after its commit and best
// effort; then as a backfill by each daily check and each heal (every five minutes) for the nodes
// falling before the next check, plus the smallest node already due whose job was lost (the
// account's hour_alert_key shows neither it nor a smaller node handled), sent at once.
//
// The job is tied to one authorization: its payload carries the expiry and the renewal instant as
// epoch milliseconds (never an ISO string: the expiry_due job is told apart by its ISO expiry) and
// the singletonKey both, so a renewal plans fresh jobs and the old ones find a changed row and do
// nothing (./service.ts handles them). No token, phone or credential is ever in a job.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import type { JobQueue } from '../../platform/index.ts';
import { authTotalMs, hourNodeAt, liveHourNodes, parseAlertHours } from './schedule.ts';

/** The queue of the chain (platform/queue/catalog.ts: exclusive, worker only, concurrency 1). */
export const UNION_AUTH_QUEUE = 'union-auth';
export const JOB_HOUR_ALERT = 'hour_alert';
export const KEY_ALERT_HOURS = 'union.auth_alert_hours';

/** The App's hour nodes (default when missing or invalid, [] when switched off). */
export async function alertHoursOf(
  config: Pick<ContentReader, 'configValue'>,
  appId: string,
): Promise<readonly number[]> {
  const item = await config.configValue(appId, KEY_ALERT_HOURS);
  return parseAlertHours(item?.value ?? null);
}

export interface HourAlertTarget {
  readonly appId: string;
  readonly unionAccountId: string;
  readonly expiresAt: Date;
  readonly renewedAt: Date | null;
}

/** The singletonKey of one hour node of one authorization. */
export function hourAlertKey(target: HourAlertTarget, hours: number): string {
  const renewed = target.renewedAt === null ? 'none' : String(target.renewedAt.getTime());
  return `union-auth:hour:${target.unionAccountId}:${target.expiresAt.getTime()}:${renewed}:h${hours}`;
}

/** The queue's largest delay (platform/queue: delaySeconds 0..2 592 000, 30 days). */
export const HOUR_JOB_MAX_DELAY_SECONDS = 2_592_000;

/**
 * The value of union_accounts.hour_alert_key once the hour node `hours` of the authorization
 * expiring at `expiresMs` is handled (written by the hour job only, ./service.ts).
 */
export function hourAlertMark(expiresMs: number, hours: number): string {
  return `${expiresMs}:h${hours}`;
}

/**
 * Whether the account's hour_alert_key says the node `hours` of the authorization expiring at
 * `expiresMs` needs no more sending: a node of that authorization with the same or a smaller lead
 * was handled (once a smaller node went out, a larger one is never sent late, even when the
 * configured nodes changed meanwhile). A mark of another expiry, or not of this format, says nothing.
 */
export function hourNodeHandled(mark: string | null, expiresMs: number, hours: number): boolean {
  if (mark === null) return false;
  const prefix = `${expiresMs}:h`;
  if (!mark.startsWith(prefix)) return false;
  const rest = mark.slice(prefix.length);
  if (!/^[1-9]\d*$/.test(rest)) return false;
  return Number(rest) <= hours;
}

/**
 * Sends the hour jobs of the live nodes whose instant is after `nowMs` (and at or before `untilMs`
 * when given, and within the queue's largest delay: a later node is left to the daily backfill),
 * skipping keys already in `sent` (one run never sends a key twice). With `catchUp` (the daily
 * backfill and heal) the smallest live node already due before the expiry is sent at once unless
 * the account's hour_alert_key shows it or a smaller node handled (hourNodeHandled); larger due
 * nodes never are.
 */
export async function sendHourAlerts(
  queue: Pick<JobQueue, 'send'>,
  input: {
    readonly trx: Transaction<DB> | null;
    readonly target: HourAlertTarget;
    readonly hours: readonly number[];
    readonly nowMs: number;
    readonly untilMs?: number;
    readonly sent?: Set<string>;
    readonly catchUp?: { readonly doneMark: string | null };
  },
): Promise<void> {
  const { target } = input;
  const expiresMs = target.expiresAt.getTime();
  const total = authTotalMs(expiresMs, target.renewedAt?.getTime() ?? null);
  const live = liveHourNodes(input.hours, total);
  const send = async (node: number, delaySeconds: number | null): Promise<void> => {
    const singletonKey = hourAlertKey(target, node);
    if (input.sent?.has(singletonKey) === true) return;
    await queue.send(
      UNION_AUTH_QUEUE,
      JOB_HOUR_ALERT,
      {
        app_id: target.appId,
        union_account_id: target.unionAccountId,
        hours: node,
        expires_ms: expiresMs,
        renewed_ms: target.renewedAt === null ? null : target.renewedAt.getTime(),
      },
      delaySeconds === null
        ? { trx: input.trx, singletonKey }
        : { trx: input.trx, singletonKey, delaySeconds },
    );
    input.sent?.add(singletonKey);
  };
  if (input.catchUp !== undefined && input.nowMs < expiresMs) {
    const due = live.filter((node) => hourNodeAt(expiresMs, node) <= input.nowMs);
    if (due.length > 0) {
      const node = Math.min(...due);
      if (!hourNodeHandled(input.catchUp.doneMark, expiresMs, node)) await send(node, null);
    }
  }
  for (const node of live) {
    const dueMs = hourNodeAt(expiresMs, node);
    if (dueMs <= input.nowMs) continue;
    if (input.untilMs !== undefined && dueMs > input.untilMs) continue;
    const delaySeconds = Math.ceil((dueMs - input.nowMs) / 1000);
    if (delaySeconds > HOUR_JOB_MAX_DELAY_SECONDS) continue;
    await send(node, delaySeconds);
  }
}
