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
  void db;
  void input;
  throw new Error('NotImplemented: recordEvents');
}

/** CT-13g / D10-1489: clear only user_id, restricted to the supplied app and user. */
export async function detachUserEvents(
  db: Kysely<DB>,
  input: { readonly appId: string; readonly userId: string },
): Promise<number> {
  void db;
  void input;
  throw new Error('NotImplemented: detachUserEvents');
}
