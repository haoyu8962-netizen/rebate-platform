// B2-09zj: payout's read-only port behind the worker's payout failure gauges (BR-WDR-24 前两项;
// D10-1157, D10-1170, D10-1186 ①, D10-1203). Per app_id: today's W6 count and W5 + W6 count (the
// +08:00 day of the injected clock, by transition time), and the W6 streak (D10-1203): the app's W5 /
// W6 ordered by (transition time, id) and cut into runs of consecutive W6 (a W5 ends a run); the
// length of the longest run whose last W6 has its transition time in (now − 24h, now] of the injected
// clock, counted whole (a run may reach back before the window); 0 without such a run. Not cut at the
// day, not persisted.
//
// What counts:
// - W6 = status FAILED with manual_resolution empty (W10 judged FAILED carries 'failed').
// - W5 = status PAID_API with manual_resolution empty (W10 judged paid carries 'paid') and no
//   transfer attempt with result fail (that one is W11, D10-1170).
// - The transition time of both is withdrawals.updated_at (D10-1186), never paid_at nor any attempt's
//   at.
// - W8 (PAID_MANUAL), W9 (back to APPROVED), W10 and W11 are neither counted nor do they break the
//   run; withdrawals still in flight are not transitions yet.
// An app appears once it has a W5 or W6 in the day or in the 24 hours (a run counted by the streak
// ends inside the 24 hours, so its app is among them); any other app has no key (0 and no sample
// alike).
//
// One statement, so the three values come from one snapshot of both tables. Reads on the handle
// it is given and with the injected Clock only: the day's bounds and the clock's instant are passed
// in, the database's own clock is never read. No cache here and no transaction of its own. A failed
// read rejects with its own error and a malformed count rejects too; neither is turned into 0 or
// into a partial result (the scrape fails visibly).
import type { DB } from '@couli/db';
import { accountingDate, chinaDayRange } from '@couli/domain';
import { sql, type Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface PayoutWithdrawalFail {
  /** app_id → W6 transitions in the current +08:00 day. */
  readonly w6Today: Readonly<Record<string, number>>;
  /** app_id → W5 plus W6 transitions in the current +08:00 day. */
  readonly w5w6Today: Readonly<Record<string, number>>;
  /**
   * app_id → the longest run of consecutive W6 (W5 / W6 ordered by (updated_at, id)) whose last W6
   * lies in (now − 24h, now], counted whole; 0 without one (D10-1203).
   */
  readonly w6Streak: Readonly<Record<string, number>>;
}

interface Row {
  readonly app_id: unknown;
  readonly w6_today: unknown;
  readonly w5w6_today: unknown;
  readonly w6_streak: unknown;
}

/** A count column read strictly: anything but a non-negative integer rejects the read. */
function countOf(value: unknown, column: string, appId: string): number {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`withdrawal fail read: ${column} of ${appId} is not a count`);
  }
  return n;
}

export async function readPayoutWithdrawalFail(
  db: Kysely<DB>,
  clock: Clock,
): Promise<PayoutWithdrawalFail> {
  const instant = clock.now();
  const day = chinaDayRange(accountingDate(instant));
  const now = sql`${instant.toISOString()}::timestamptz`;
  const windowStart = sql`(${now} - interval '24 hours')`;
  const dayStart = sql`${day.start}::timestamptz`;
  const dayEnd = sql`${day.end}::timestamptz`;
  // The day [dayStart, dayEnd) starts within the 24 hours before now and ends after now. A run counted
  // by the streak ends inside the window (now − 24h, now] and starts right after a W5 inside the
  // window or after the app's latest W5 at or before the window's start, so the sequence is read from
  // that W5 on (all of it when there is none), not the whole history (see `ordered` below).
  const result = await sql<Row>`
    WITH transition AS (
      -- The transition instant is updated_at (D10-1186). This relies on 「PAID_API / FAILED 落地后
      -- withdrawals 不再被更新」: payout-landing writes updated_at with the injected clock in the
      -- transition's own transaction, and every updateTable of withdrawals is limited to non-terminal
      -- statuses; revisit if a write ever updates a terminal row.
      SELECT w.id, w.app_id, w.status = 'FAILED' AS w6, w.updated_at AS at
      FROM app.withdrawals w
      WHERE w.manual_resolution IS NULL
        AND w.updated_at < ${dayEnd}
        AND (
          w.status = 'FAILED'
          OR (
            w.status = 'PAID_API'
            -- W11 is no W5 (D10-1170): a W5 has no transfer attempt with result fail. This relies on
            -- 「一单最多一条转账尝试」 (W4's guard, BR-WDR-14, payout_attempts_transfer_once_key);
            -- revisit if BR-WDR-22 ④ (resubmission) is ever approved by the owner.
            AND NOT EXISTS (
              SELECT 1
              FROM app.payout_attempts f
              WHERE f.withdrawal_id = w.id
                AND f.app_id = w.app_id
                AND f.kind = 'transfer'
                AND f.result = 'fail'
            )
          )
        )
    ),
    last_w5 AS (
      -- Each app's latest W5 at or before the window's start: whatever lies before it ends in a run
      -- whose last W6 is at or before that W5, outside the window.
      SELECT app_id, max(at) AS at
      FROM transition
      WHERE NOT w6 AND at <= ${windowStart}
      GROUP BY app_id
    ),
    ordered AS (
      -- The app's W5 / W6 up to now from that W5 on (rows at its very instant included, so the order
      -- among them still decides), numbered into segments: a W6's segment is the number of W5 before
      -- it, so a run of consecutive W6 is the W6 sharing one segment.
      SELECT t.app_id, t.w6, t.at,
        count(*) FILTER (WHERE NOT t.w6) OVER (
          PARTITION BY t.app_id
          -- 并列规则 (D10-1203): rows with the same updated_at are ordered by id ascending (the smaller
          -- id first); with ROWS framing the count stops exactly at the current row, never at its peers.
          ORDER BY t.at ASC, t.id ASC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS segment
      FROM transition t
      LEFT JOIN last_w5 l ON l.app_id = t.app_id
      WHERE t.at <= ${now}
        AND (l.at IS NULL OR t.at >= l.at)
    ),
    runs AS (
      -- The streak (D10-1203): the longest run whose last W6 lies in (now − 24h, now], counted whole,
      -- however far back before the window it reaches.
      SELECT app_id, max(n) AS n
      FROM (
        SELECT app_id, segment, count(*) AS n, max(at) AS last_at
        FROM ordered
        WHERE w6
        GROUP BY app_id, segment
      ) segments
      WHERE last_at > ${windowStart}
      GROUP BY app_id
    ),
    today AS (
      SELECT app_id,
        count(*) FILTER (WHERE w6 AND at >= ${dayStart}) AS w6_today,
        count(*) FILTER (WHERE at >= ${dayStart}) AS w5w6_today
      FROM transition
      WHERE at > ${windowStart}
      GROUP BY app_id
    ),
    apps AS (
      SELECT app_id FROM today
      UNION
      SELECT app_id FROM runs
    )
    SELECT a.app_id,
      coalesce(d.w6_today, 0)::integer AS w6_today,
      coalesce(d.w5w6_today, 0)::integer AS w5w6_today,
      coalesce(r.n, 0)::integer AS w6_streak
    FROM apps a
    LEFT JOIN today d ON d.app_id = a.app_id
    LEFT JOIN runs r ON r.app_id = a.app_id
  `.execute(db);

  const w6Today: Record<string, number> = {};
  const w5w6Today: Record<string, number> = {};
  const w6Streak: Record<string, number> = {};
  for (const row of result.rows) {
    if (typeof row.app_id !== 'string') {
      throw new Error('withdrawal fail read: a row without app_id');
    }
    const appId = row.app_id;
    w6Today[appId] = countOf(row.w6_today, 'w6_today', appId);
    w5w6Today[appId] = countOf(row.w5w6_today, 'w5w6_today', appId);
    w6Streak[appId] = countOf(row.w6_streak, 'w6_streak', appId);
  }
  return { w6Today, w5w6Today, w6Streak };
}
