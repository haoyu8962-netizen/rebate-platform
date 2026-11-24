// Hour alert nodes of the site authorization (B1-22zd; BR-ID-24 ② and 细则「授权时长与续期」;
// 编排裁定 D10-2585, D10-2587, D10-2758, D10-2771).
//
// Every hour node (union.auth_alert_hours, default [6, 1]) of an authorization that is not skipped
// (./schedule.ts) gets one delayed job `hour_alert` on queue union-auth, due at the node instant
// (auth_expires_at − N hours), instead of waiting for the daily check. Planned by whoever writes a
// new authorization: the re-authorization callback (./reauth.ts), the manual credential entry
// (../application/admin-accounts.ts), a successful refresh, and as a backfill by each daily check
// for the nodes falling before the next check (a lost job is found again).
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

/**
 * Sends the hour jobs of the live nodes whose instant is after `nowMs` (and at or before `untilMs`
 * when given), skipping keys already in `sent` (one run never sends a key twice); returns nothing.
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
  },
): Promise<void> {
  const { target } = input;
  const expiresMs = target.expiresAt.getTime();
  const total = authTotalMs(expiresMs, target.renewedAt?.getTime() ?? null);
  for (const node of liveHourNodes(input.hours, total)) {
    const dueMs = hourNodeAt(expiresMs, node);
    if (dueMs <= input.nowMs) continue;
    if (input.untilMs !== undefined && dueMs > input.untilMs) continue;
    const singletonKey = hourAlertKey(target, node);
    if (input.sent?.has(singletonKey) === true) continue;
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
      { trx: input.trx, singletonKey, delaySeconds: Math.ceil((dueMs - input.nowMs) / 1000) },
    );
    input.sent?.add(singletonKey);
  }
}
