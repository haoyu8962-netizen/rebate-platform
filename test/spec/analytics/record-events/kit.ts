import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type {
  AnalyticsEvent,
  RecordEventsInput,
} from '../../../../apps/api/src/modules/analytics/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';

export const TIMEOUT = 120_000;
export const SERVER_AT = '2032-06-15T16:00:00.123Z';
export const CLIENT_AT = '2026-11-13T23:59:59.456+08:00';

// Only *.int.test.ts imports @couli/db/testing; the factory is passed in by each test file.
interface Database {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export async function open(create: () => Promise<Database>) {
  const database = await create();
  const connectionString = database.urlFor('couli_app');
  return {
    database,
    db: createDb({ connectionString, max: 3 }),
    other: createDb({ connectionString, max: 2 }),
  };
}

export type Harness = Awaited<ReturnType<typeof open>>;

export async function close(h: Harness | undefined) {
  if (!h) return;
  await Promise.all([destroyDb(h.db), destroyDb(h.other)]);
  await h.database.drop();
}

export function event(overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return {
    eventId: randomUUID(),
    eventType: 'page_view',
    props: {},
    clientAt: CLIENT_AT,
    ...overrides,
  };
}

export function batch(events: readonly AnalyticsEvent[]): RecordEventsInput {
  return {
    appId: `analytics-${randomUUID()}`,
    userId: null,
    deviceId: null,
    events,
    clock: new FixedClock(SERVER_AT),
  };
}

export function rows(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('events')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('event_type')
    .orderBy('event_id')
    .execute();
}

export function keys(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('event_dedup')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('event_type')
    .orderBy('event_id')
    .execute();
}

export async function user(db: Kysely<DB>, appId: string): Promise<string> {
  const id = randomUUID();
  await db
    .withSchema('app')
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname: 'analytics fixture',
      avatar: '',
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'normal',
      register_method: 'sms',
    })
    .execute();
  return id;
}

/** Independent detachment fixtures: no dependency on recordEvents being implemented first. */
export async function seed(
  db: Kysely<DB>,
  appId: string,
  userId: string | null,
  deviceId: string | null,
) {
  const item = event({ props: { keep: ['original', 1, null] } });
  await db.transaction().execute(async (trx) => {
    await trx
      .withSchema('app')
      .insertInto('event_dedup')
      .values({
        app_id: appId,
        event_id: item.eventId,
        event_type: item.eventType,
      })
      .execute();
    await trx
      .withSchema('app')
      .insertInto('events')
      .values({
        app_id: appId,
        event_id: item.eventId,
        event_type: item.eventType,
        name: item.eventType,
        props: JSON.stringify(item.props),
        client_at: item.clientAt,
        server_at: SERVER_AT,
        user_id: userId,
        device_id: deviceId,
      })
      .execute();
  });
  return item;
}
