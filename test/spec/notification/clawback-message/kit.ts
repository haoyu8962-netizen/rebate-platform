// B1-12zc rule-test kit, shared by clawback-message/** and settle-adjusted-message/** (BR-TEXT-09,
// BR-TEXT-05, BR-TEXT-10; D10-773 方案 C). Expected texts are written out by hand from the task brief
// §9 and 08 at SPEC_REF, never read from the implementation. Only *.int.test.ts imports the test
// database factory and passes it in here. Events are synthetic and handed straight to the consumer
// (the order.settle_adjusted producer is booked separately). Every value is synthetic.
import { createHash, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Insertable, Kysely } from 'kysely';
import { vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import type {
  JobPayload,
  ReceivedEvent,
  ReceivedJob,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createPushSendCore } from '../../../../apps/api/src/modules/notification/application/push-send.ts';
import type { PushDeliveryChannel } from '../../../../apps/api/src/modules/notification/ports/push-delivery.ts';
import { createOrderDeductionMessageConsumer } from '../../../../apps/api/src/modules/notification/application/clawback-message.ts';

export { isLedger, orderDetail } from './routes.ts';

export const NOW = '2026-11-07T09:08:07.006Z';
/** One consumer for both events (D10-773 ①); its queue is evt.<consumer>. */
export const CONSUMER = 'notification-clawback';
export const QUEUE = 'evt.notification-clawback';
export const CLAWED_BACK = 'order.clawed_back';
export const SETTLE_ADJUSTED = 'order.settle_adjusted';
/** bucket of a SETTLE_ADJUSTED row booked to the user's available balance. */
export const AVAILABLE = 'user_available';

/**
 * inbox.title.<code>.<key> (contracts/texts.default.json; task brief §9.1, D10-773 ④): CLAWBACK share
 * and invite both read the .promo key.
 */
export const TITLES = {
  CLAWBACK: { self: '返利扣回', share: '推广收益扣回', invite: '推广收益扣回' },
  SETTLE_ADJUSTED: { self: '返利已调整', share: '推广收益已调整', invite: '邀请奖励已调整' },
} as const;

/** BR-TEXT-05 原因码字典 order_reason.<CODE>.title, verbatim (08 l.443–456). */
export const REASON_TITLES = {
  REFUND: '订单已退款或取消',
  RIGHTS: '发起售后维权，返利取消',
  PUNISH: '订单被联盟判定违规',
  COMMISSION_ZERO: '返利已取消',
  PRICE_COMPARE: '比价订单',
  PRICE_PROTECT: '商家价保退差',
  SETTLE_DIFF: '结算金额调整',
} as const;

/** BR-TEXT-09 CLAWBACK rows (08 l.600–602); {amount} already formatted (negative, BR-TEXT-10). */
export const clawbackBody = {
  self: (amount: string, reason: string) => `订单返利已扣回 ${amount}：${reason}`,
  share: (amount: string, reason: string) => `一笔分享订单的推广收益已扣回 ${amount}：${reason}`,
  invite: (amount: string) => `一笔邀请订单的推广收益已扣回 ${amount}`,
} as const;

/** D10-773 ④ SETTLE_ADJUSTED rows; {amount} the decrease's absolute value (BR-TEXT-10). */
export const settleBody = {
  self: (amount: string, reason: string) => `订单返利已按结算金额调整，减少 ${amount}：${reason}`,
  share: (amount: string, reason: string) =>
    `一笔分享订单的推广收益已按结算金额调整，减少 ${amount}：${reason}`,
  invite: (amount: string) => `一笔邀请奖励已按结算金额调整，减少 ${amount}`,
} as const;

/** The order's product title and the buyer's nickname: never in an upline's message (J7). */
export const ORDER_TITLE = '合成测试商品标题不应出现在上级通知里';
export const BUYER_NICKNAME = '合成下级昵称不应出现在上级通知里';

/** Low-entropy synthetic device secret. */
const PLAIN = 'plain-plain-plain-plain';
const AT = new Date('2026-10-20T03:04:05.000Z');

// Structural type instead of importing @couli/db/testing (int tests only).
interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export async function openSuite(createTestDatabase: () => Promise<TestDatabase>) {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
  return {
    db,
    async close() {
      try {
        await destroyDb(db);
      } finally {
        await database.drop();
      }
    },
  };
}
export type Suite = Awaited<ReturnType<typeof openSuite>>;

export async function seedUser(
  db: Kysely<DB>,
  appId: string,
  nickname = 'fixture',
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname,
      avatar: 'fixture',
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'L1',
      register_method: 'sms',
    })
    .execute();
  return id;
}

/** A sub-order (order_keys + orders); order_key = `{platform}:{sub_order_id}` (BR-FUND-05). */
export async function seedOrder(db: Kysely<DB>, appId: string) {
  const order_id = randomUUID();
  const sub_order_id = `child-${order_id}`;
  const key = { app_id: appId, order_id, platform: 'jd', sub_order_id, attr_at: AT };
  await db.insertInto('order_keys').values(key).execute();
  await db
    .insertInto('orders')
    .values({
      ...key,
      raw_item_id: 'synthetic-product',
      user_id: null,
      buy_type: null,
      title: ORDER_TITLE,
      platform_status: 'PAID',
      commission_version: 2,
      est_commission_fen: 1234n,
      base_fen: 850n,
      settle_commission_fen: 987n,
      row_version: 7,
      created_at: AT,
      updated_at: AT,
    })
    .execute();
  return { order_id, sub_order_id, order_key: `jd:${sub_order_id}` };
}
export type SeededOrder = Awaited<ReturnType<typeof seedOrder>>;

export interface ClawbackRow {
  readonly user_id: string;
  readonly role: string;
  /** Positive integer fen as a decimal string, as clawback-order.ts publishes it. */
  readonly clawback_fen: string;
}

export interface SettleRow {
  readonly user_id: string;
  readonly role: string;
  /** Signed integer fen as a decimal string (negative = decrease). */
  readonly adjust_fen: string;
  readonly bucket: string;
}

function received(
  appId: string,
  name: string,
  payload: JobPayload,
  attempt: number,
): ReceivedEvent {
  return {
    eventId: randomUUID(),
    appId,
    name,
    version: 1,
    occurredAt: '2026-11-07T09:00:00.000Z',
    consumer: CONSUMER,
    attempt,
    payload,
  };
}

/** order.clawed_back as clawback-order.ts publishes it (reason only on R8). */
export function clawedBackPayload(data: {
  order: SeededOrder;
  rights_event_id: string;
  transition: 'R8' | 'R9';
  reason?: string;
  beneficiaries: readonly ClawbackRow[];
}): JobPayload {
  return {
    order_id: data.order.order_id,
    order_key: data.order.order_key,
    rights_event_id: data.rights_event_id,
    transition: data.transition,
    ...(data.reason === undefined ? {} : { reason: data.reason }),
    beneficiaries: data.beneficiaries.map((row) => ({
      user_id: row.user_id,
      role: row.role,
      clawback_fen: row.clawback_fen,
    })),
  };
}

/** order.settle_adjusted as D10-773 ④ fixes it. */
export function settleAdjustedPayload(data: {
  order: SeededOrder;
  settle_seq: number;
  sub_type: string;
  beneficiaries: readonly SettleRow[];
}): JobPayload {
  return {
    order_id: data.order.order_id,
    order_key: data.order.order_key,
    settle_seq: data.settle_seq,
    sub_type: data.sub_type,
    beneficiaries: data.beneficiaries.map((row) => ({
      user_id: row.user_id,
      role: row.role,
      adjust_fen: row.adjust_fen,
      bucket: row.bucket,
    })),
  };
}

/** The queue job of an event, as the bus enqueues it (envelope app_id, v, occurred_at, data). */
export function job(event: ReceivedEvent): ReceivedJob {
  return {
    id: event.eventId,
    queue: QUEUE,
    name: event.name,
    attempt: event.attempt,
    payload: {
      app_id: event.appId,
      v: event.version,
      occurred_at: event.occurredAt,
      data: event.payload,
    },
  };
}

/** The push payload of a stored message (B1-12o: exactly message_id, title and body). */
export function pushPayload(message: { message_id: string; title: string; body: string }) {
  return { message_id: message.message_id, title: message.title, body: message.body };
}

/** Orders [channel, dedupe_key, status] rows by dedupe_key in UTF-16 code units (no collation). */
export function byKey(a: readonly string[], b: readonly string[]): number {
  const left = a[1] ?? '';
  const right = b[1] ?? '';
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Sorted [channel, dedupe_key, status] rows: an inbox log and a push log per key. */
export function expectedLogs(keys: readonly string[], pushStatus = 'success'): string[][] {
  return keys
    .flatMap((key) => [
      ['inbox', key, 'success'],
      ['push', `${key}:push`, pushStatus],
    ])
    .sort(byKey);
}

/** notify_logs dedupe key of a CLAWBACK message (D10-773 ③). */
export function clawbackKey(order: SeededOrder, userId: string, role: string, eventId: string) {
  return `${order.order_key}:${userId}:${role}:CLAWBACK:${eventId}`;
}

/** notify_logs dedupe key of a SETTLE_ADJUSTED message (D10-773 ④). */
export function settleKey(order: SeededOrder, userId: string, role: string, settleSeq: number) {
  return `${order.order_key}:${userId}:${role}:SETTLE_ADJ:${String(settleSeq)}`;
}

export async function fixture(suite: Suite, appId = `deduct-msg-${randomUUID()}`) {
  const db = suite.db;
  // The buyer (self), a sharer, and the two uplines; every one a real user of the app.
  const users = {
    self: await seedUser(db, appId, BUYER_NICKNAME),
    share: await seedUser(db, appId),
    direct: await seedUser(db, appId),
    indirect: await seedUser(db, appId),
  };
  const order = await seedOrder(db, appId);
  const clock = new FixedClock(NOW);
  const channel = {
    send: vi.fn<PushDeliveryChannel['send']>().mockResolvedValue({ status: 'accepted' }),
  };
  // Every bound session is valid: the pre-send check is B1-12o's, not this task's.
  const sessionValidity = vi.fn(
    async (_executor: unknown, query: { readonly sids: readonly string[] }) =>
      new Set<string>(query.sids),
  );
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  // SUT construction belongs in each test body (through these helpers), so the skeleton's
  // NotImplemented is an individual red result.
  function consumer() {
    return createOrderDeductionMessageConsumer({
      clock,
      logger,
      push: createPushSendCore({ clock, channel, sessionValidity }),
    });
  }
  return {
    db,
    appId,
    users,
    order,
    clock,
    channel,
    lines,
    consumer,
    /** Another sub-order of this app. */
    async newOrder() {
      return seedOrder(db, appId);
    },
    clawedBack(
      data: {
        order?: SeededOrder;
        rights_event_id?: string;
        transition?: 'R8' | 'R9';
        reason?: string;
        beneficiaries: readonly ClawbackRow[];
      },
      attempt = 1,
    ): ReceivedEvent {
      const payload = clawedBackPayload({
        order: data.order ?? order,
        rights_event_id: data.rights_event_id ?? 'R1001',
        transition: data.transition ?? 'R8',
        ...(data.reason === undefined ? {} : { reason: data.reason }),
        beneficiaries: data.beneficiaries,
      });
      return received(appId, CLAWED_BACK, payload, attempt);
    },
    settleAdjusted(
      data: {
        order?: SeededOrder;
        settle_seq?: number;
        sub_type?: string;
        beneficiaries: readonly SettleRow[];
      },
      attempt = 1,
    ): ReceivedEvent {
      const payload = settleAdjustedPayload({
        order: data.order ?? order,
        settle_seq: data.settle_seq ?? 3,
        sub_type: data.sub_type ?? 'SETTLE_DIFF',
        beneficiaries: data.beneficiaries,
      });
      return received(appId, SETTLE_ADJUSTED, payload, attempt);
    },
    /** The production sequence: handle() in the event transaction, then dispatch() after it. */
    async deliver(event: ReceivedEvent) {
      const sut = consumer();
      await db.transaction().execute((trx) => sut.handle(event, trx));
      await sut.dispatch(db, event);
    },
    /** handle() only, on `connection`'s transaction (a fault plugin, or a caller's transaction). */
    async handle(event: ReceivedEvent, connection: Kysely<DB> = db) {
      const sut = consumer();
      await connection.transaction().execute((trx) => sut.handle(event, trx));
    },
    /** A live push registration of `userId`, bound to a session the fake reports valid. */
    async token(userId: string) {
      const id = randomUUID();
      const deviceId = randomUUID();
      await db
        .insertInto('devices')
        .values({
          id: deviceId,
          app_id: appId,
          device_hash: createHash('sha256').update(deviceId).digest('hex'),
          id_source: 'idfv',
          platform: 'ios',
          app_version: '1.0.0',
          install_secret_cipher: Buffer.from(PLAIN),
          last_seen_at: new Date(NOW),
        })
        .execute();
      await db
        .insertInto('push_tokens')
        .values({
          id,
          app_id: appId,
          user_id: userId,
          device_id: deviceId,
          bound_sid: `session-${id}`,
          provider: 'mobpush',
          token: `device-reg-${id}`,
          token_set_at: new Date(NOW),
          frozen_until: null,
          revoked_at: null,
        })
        .execute();
      return { provider: 'mobpush', token: `device-reg-${id}` };
    },
    async settings(
      userId: string,
      values: { service_push: boolean; subscription_push: boolean; marketing_push: boolean },
    ) {
      await db
        .insertInto('notification_settings')
        .values({ app_id: appId, user_id: userId, ...values })
        .execute();
    },
    async template(
      code: 'CLAWBACK' | 'SETTLE_ADJUSTED',
      variant: string,
      overrides: Partial<Insertable<DB['notify_templates']>> = {},
      app = appId,
    ) {
      await db
        .insertInto('notify_templates')
        .values({
          app_id: app,
          code,
          variant,
          category: 'service',
          channels: ['inbox', 'push'],
          route: null,
          title_override: null,
          body_override: null,
          ...overrides,
        })
        .execute();
    },
    async rows(app = appId) {
      return {
        inbox: await db
          .selectFrom('inbox_messages')
          .selectAll()
          .where('app_id', '=', app)
          .orderBy('created_at')
          .orderBy('message_id')
          .execute(),
        logs: await db
          .selectFrom('notify_logs')
          .selectAll()
          .where('app_id', '=', app)
          .orderBy('dedupe_key')
          .execute(),
      };
    },
    /** The inbox messages of one user of this app. */
    async messagesOf(userId: string) {
      return db
        .selectFrom('inbox_messages')
        .selectAll()
        .where('app_id', '=', appId)
        .where('user_id', '=', userId)
        .orderBy('message_id')
        .execute();
    },
    /** notify_logs of this app as [channel, dedupe_key, status], sorted by key in code units. */
    async logKeys(): Promise<string[][]> {
      const logs = await db
        .selectFrom('notify_logs')
        .select(['channel', 'dedupe_key', 'status'])
        .where('app_id', '=', appId)
        .execute();
      return logs.map((log) => [log.channel, log.dedupe_key, log.status]).sort(byKey);
    },
    /** The dedupe keys of this app's inbox logs, sorted in code units. */
    async inboxKeys(): Promise<string[]> {
      const logs = await db
        .selectFrom('notify_logs')
        .select('dedupe_key')
        .where('app_id', '=', appId)
        .where('channel', '=', 'inbox')
        .execute();
      return logs.map((log) => log.dedupe_key).sort();
    },
    /** [channel, status, suppress_reason] of one user's logs, sorted. */
    async logsOf(userId: string) {
      const logs = await db
        .selectFrom('notify_logs')
        .select(['channel', 'status', 'suppress_reason'])
        .where('app_id', '=', appId)
        .where('user_id', '=', userId)
        .execute();
      return logs.map((log) => [log.channel, log.status, log.suppress_reason]).sort();
    },
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
