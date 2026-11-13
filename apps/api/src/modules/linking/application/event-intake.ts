// B1-06zo (C-31 第一步, D10-1469 / D10-1470 / D10-1471): the use case behind POST /v1/events.
// - Every event is checked on its own by prepareEvents (specs/events.yaml); the non-conforming
//   ones are dropped and counted, the batch is accepted as a whole.
// - link_jump (BR-ATTR-21 细则「待跟单卡按实际外跳选」): a purchase step whose result is
//   requested or unknown, sent with the user's own token, writes jump_reported_at once on that
//   user's attempt of that link in that app (UPDATE … WHERE jump_reported_at IS NULL; the column
//   also has a write-once trigger). failed does not count. No token, no / unknown / foreign
//   attempt_id, a link_id other than the attempt's: analytics only, nothing written, no error.
// - Every other event is accepted and not stored (the events table is CT-13e…h); the prepared
//   batch is the connection point for the future recordEvents (CT-13h).
// linking is the only writer of link_open_attempts (规划/02 §4.1).
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
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
  readonly #clock: Clock;

  constructor(jumps: JumpReportStore, clock: Clock) {
    this.#jumps = jumps;
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
    // Connection point for CT-13h: `batch` goes to recordEvents once it exists (not in this step).
    return { droppedCount };
  }
}
