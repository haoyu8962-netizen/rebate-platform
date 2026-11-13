import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../platform/index.ts';

export type EventJson = null | boolean | number | string | EventJson[] | EventProps;
export interface EventProps {
  readonly [key: string]: EventJson;
}

/** Already validated by the receiving endpoint; eventType is stored as both name and event_type. */
export interface AnalyticsEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly props: EventProps;
  readonly clientAt: Date | string;
}

export interface RecordEventsInput {
  readonly appId: string;
  readonly userId: string | null;
  readonly deviceId: string | null;
  readonly events: readonly AnalyticsEvent[];
  /** Server dependency, never supplied by the event payload. */
  readonly clock: Clock;
}

export interface RecordEventsResult {
  readonly accepted: number;
  readonly duplicates: number;
}

/** CT-13g: one transaction, dedup INSERT first, events INSERT only for newly acquired keys. */
export async function recordEvents(
  db: Kysely<DB>,
  input: RecordEventsInput,
): Promise<RecordEventsResult> {
  const { appId, userId, deviceId, events, clock } = input;
  if (events.length === 0) return { accepted: 0, duplicates: 0 };
  return db.transaction().execute(async (trx) => {
    const app = trx.withSchema('app');
    const serverAt = clock.now();
    let accepted = 0;
    let duplicates = 0;
    for (const item of events) {
      // Idempotency rests on event_dedup_pkey (AGENTS §4 rule 4): no read-then-write. A key held
      // by a concurrent uncommitted transaction makes this INSERT wait, then return no row.
      const acquired = await app
        .insertInto('event_dedup')
        .values({ app_id: appId, event_type: item.eventType, event_id: item.eventId })
        .onConflict((oc) => oc.columns(['event_type', 'event_id']).doNothing())
        .returning('event_id')
        .executeTakeFirst();
      if (acquired === undefined) {
        duplicates += 1;
        continue;
      }
      await app
        .insertInto('events')
        .values({
          app_id: appId,
          event_id: item.eventId,
          event_type: item.eventType,
          name: item.eventType,
          // Serialised explicitly: node-postgres would send a JS array as a PG array literal.
          // A non-object value is refused by events_props_object_check and rolls back the batch.
          props: JSON.stringify(item.props),
          user_id: userId,
          device_id: deviceId,
          client_at: item.clientAt,
          server_at: serverAt,
        })
        .execute();
      accepted += 1;
    }
    return { accepted, duplicates };
  });
}

/** CT-13g / D10-1489: clear only user_id, restricted to the supplied app and user. */
export async function detachUserEvents(
  db: Kysely<DB>,
  input: { readonly appId: string; readonly userId: string },
): Promise<number> {
  const result = await db
    .withSchema('app')
    .updateTable('events')
    .set({ user_id: null })
    .where('app_id', '=', input.appId)
    .where('user_id', '=', input.userId)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}
