// B1-06zo (C-31 第一步, D10-1469 / D10-1470 / D10-1471): the use case behind POST /v1/events.
// - Every event is checked on its own by prepareEvents (specs/events.yaml); the non-conforming
//   ones are dropped and counted, the batch is accepted as a whole.
// - link_jump (BR-ATTR-21 细则「待跟单卡按实际外跳选」): a purchase step whose result is
//   requested or unknown, sent with the user's own token, writes jump_reported_at once on that
//   user's attempt of that link in that app (UPDATE … WHERE jump_reported_at IS NULL; the column
//   also has a write-once trigger). failed does not count. No token, no / unknown / foreign
//   attempt_id, a link_id other than the attempt's: analytics only, nothing written, no error.
// - CT-13h: the whole validated batch (link_jump included, dropped events never) is stored by
//   analytics' recordEvents with the server-injected app / user / device and the injected Clock;
//   repeats are deduplicated there and are neither errors nor counted as dropped.
// linking is the only writer of link_open_attempts (规划/02 §4.1).
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { recordEvents, type AnalyticsEvent } from '../../analytics/index.ts';
import type { Clock } from '../../platform/index.ts';
import { prepareEvents, type EventBatchContext, type PreparedEventBatch } from './ingest-events.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** BR-ATTR-21 「至少一步执行成功」 since 2026-10-10: requested and unknown count, failed does not. */
const JUMPED: ReadonlySet<unknown> = new Set(['requested', 'unknown']);

export interface JumpReport {
  readonly appId: string;
  readonly userId: string;
  readonly attemptId: string;
  readonly linkId: string;
}

export interface JumpReportStore {
  /** Writes jump_reported_at = at once; anything outside the scope or already written: nothing. */
  record(report: JumpReport, at: Date): Promise<void>;
}

export function createJumpReportStore(db: Kysely<DB> | undefined): JumpReportStore {
  return {
    async record({ appId, userId, attemptId, linkId }, at) {
      if (db === undefined) throw new Error('linking: no database handle for jump reports');
      await db
        .withSchema('app')
        .updateTable('link_open_attempts')
        .set({ jump_reported_at: at, updated_at: at, row_version: sql<number>`row_version + 1` })
        .where('attempt_id', '=', attemptId)
        .where('user_id', '=', userId)
        .where('link_id', '=', linkId)
        .where('app_id', '=', appId)
        .where('jump_reported_at', 'is', null)
        .execute();
    },
  };
}

export interface EventStore {
  /** Stores the validated events of a non-empty batch; repeats are deduplicated, not errors. */
  record(batch: PreparedEventBatch, clock: Clock): Promise<void>;
}

export function createEventStore(db: Kysely<DB> | undefined): EventStore {
  return {
    async record({ appId, userId, deviceId, events }, clock) {
      if (db === undefined) throw new Error('linking: no database handle for analytics events');
      // props hold JSON values only: they are fields of the parsed request body.
      await recordEvents(db, {
        appId,
        userId,
        deviceId,
        events: events as readonly AnalyticsEvent[],
        clock,
      });
    },
  };
}

/** The own-token link_jump reports of a prepared batch that may mark an attempt (once each). */
export function jumpReportsOf(batch: PreparedEventBatch): JumpReport[] {
  const userId = batch.userId;
  if (userId === null || !UUID.test(userId)) return [];
  const reports = new Map<string, JumpReport>();
  for (const event of batch.events) {
    if (event.eventType !== 'link_jump') continue;
    const { phase, result, attempt_id: attemptId, link_id: linkId } = event.props;
    if (phase !== 'purchase' || !JUMPED.has(result)) continue;
    // Ids that are not UUIDs name no attempt (and must not reach PostgreSQL as 22P02).
    if (typeof attemptId !== 'string' || !UUID.test(attemptId)) continue;
    if (typeof linkId !== 'string' || !UUID.test(linkId)) continue;
    const key = `${attemptId.toLowerCase()}\u0000${linkId.toLowerCase()}`;
    if (!reports.has(key)) reports.set(key, { appId: batch.appId, userId, attemptId, linkId });
  }
  return [...reports.values()];
}

export interface IngestEventsResult {
  readonly droppedCount: number;
}

export class EventIntakeService {
  readonly #jumps: JumpReportStore;
  readonly #events: EventStore;
  readonly #clock: Clock;

  constructor(jumps: JumpReportStore, events: EventStore, clock: Clock) {
    this.#jumps = jumps;
    this.#events = events;
    this.#clock = clock;
  }

  async ingest(
    context: EventBatchContext,
    events: readonly unknown[],
  ): Promise<IngestEventsResult> {
    const { droppedCount, batch } = prepareEvents(context, events);
    const reports = jumpReportsOf(batch);
    if (reports.length > 0) {
      // One instant for the whole batch, from the injected Clock (never now() or client_at).
      const at = this.#clock.now();
      for (const report of reports) await this.#jumps.record(report, at);
    }
    // CT-13h: identity comes from the batch context (server-injected), server_at from the Clock.
    if (batch.events.length > 0) await this.#events.record(batch, this.#clock);
    return { droppedCount };
  }
}
