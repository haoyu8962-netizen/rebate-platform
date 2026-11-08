import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  EVENT_SUBSCRIPTIONS,
  createEventBus,
} from '../../../../apps/api/src/modules/platform/events/index.ts';
import type {
  JobQueue,
  ReceivedEvent,
  ReceivedJob,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { failInsert, fixture, openSuite, type Suite } from './db-kit.ts';
import { CONSUMER, NOW, QUEUE } from './fixtures.ts';
import { assembled } from '../risk-state-message/worker-kit.ts';
import { event as riskEvent, payload as riskPayload } from '../risk-state-message/fixtures.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
});
afterAll(async () => {
  await suite?.close();
});

function job(event: ReceivedEvent): ReceivedJob {
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

it('[AC-B1-12p#28] 直接发布结案与 appealing→normal 事件，生产路由只生成一条申诉通知；关闭推送不影响站内信', async () => {
  const f = await fixture(suite);
  await f.db
    .insertInto('notification_settings')
    .values({
      app_id: f.appId,
      user_id: f.userId,
      service_push: false,
      subscription_push: false,
      marketing_push: false,
    })
    .execute();
  const app = await assembled('worker', f.db, f.clock);
  try {
    expect(app.registrations.filter((registration) => registration.name === QUEUE)).toHaveLength(1);
    const send = vi.fn<JobQueue['send']>(
      async (_queue, _name, _payload, options) => options.id ?? null,
    );
    const bus = createEventBus({ queue: { send }, clock: f.clock });
    const resolved = f.event({ need_reauth: true });
    const restored = riskEvent(
      riskPayload({
        app_id: f.appId,
        user_id: f.userId,
        from: 'appealing',
        to: 'normal',
        reason_category: null,
      }),
    );
    // Drive both consumers directly; the identity appeal-resolution service is out of scope.
    await f.db.transaction().execute(async (trx) => {
      for (const received of [resolved, restored]) {
        await bus.publish(trx, {
          appId: received.appId,
          name: received.name,
          eventId: received.eventId,
          payload: received.payload,
        });
      }
    });
    // bus.publish sends one job per subscription in EVENT_SUBSCRIPTIONS order, and that table lists
    // notification-appeal-result before risk-appeal-restore.
    expect(send.mock.calls.map(([queue, name]) => ({ queue, name }))).toEqual([
      { queue: QUEUE, name: 'appeal.resolved' },
      { queue: 'evt.risk-appeal-restore', name: 'appeal.resolved' },
      // B2-09gc（B2-09gd 前置）：settlement 的申诉恢复消费者有则钉死，紧跟 risk-appeal-restore；无则清单原样。
      ...(EVENT_SUBSCRIPTIONS.some(
        (subscription) => subscription.consumer === 'settlement-order-appeal-restore',
      )
        ? [{ queue: 'evt.settlement-order-appeal-restore', name: 'appeal.resolved' }]
        : []),
      { queue: 'evt.notification-risk-state', name: 'risk.state_changed' },
    ]);
    // Risk's restore handler looks up the app.appeals row, which this notification fixture never
    // writes, so delivering that job would fail; only the two notification jobs are delivered.
    // B2-09gc: settlement's restore consumer, when present, is left undelivered for the same reason.
    const notificationCalls = send.mock.calls.filter(
      ([queue]) =>
        queue !== 'evt.risk-appeal-restore' && queue !== 'evt.settlement-order-appeal-restore',
    );
    // Deliver in reverse order, then repeat both jobs: neither ordering nor retries may double-notify.
    for (const attempt of [1, 2]) {
      for (const [queue, name, payload, options] of [...notificationCalls].reverse()) {
        const matches = app.registrations.filter((registration) => registration.name === queue);
        expect(matches).toHaveLength(1);
        await matches[0]!.handler({ id: options.id!, queue, name, payload, attempt });
      }
    }
    const rows = await f.rows();
    expect(rows.inbox).toMatchObject([
      {
        user_id: f.userId,
        code: 'APPEAL_RESULT',
        body: '你的申诉已通过，相关限制已解除。购物前需重新完成淘宝授权。',
        route: null,
      },
    ]);
    expect(rows.logs).toMatchObject([
      {
        code: 'APPEAL_RESULT',
        channel: 'inbox',
        status: 'success',
        dedupe_key: `appeal.resolved:${resolved.eventId}`,
      },
    ]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it.each(['revoked', 'upheld'] as const)(
  '[AC-B1-12p#29] 真实 worker 确认 blocked_request / %s 且不发信、不写通知日志、不发推送短信',
  async (status) => {
    const f = await fixture(suite);
    const app = await assembled('worker', f.db, f.clock);
    try {
      const matches = app.registrations.filter((registration) => registration.name === QUEUE);
      expect(matches).toHaveLength(1);
      const received = f.event({ target_type: 'blocked_request', status, user_id: null });
      await matches[0]!.handler(job(received));
      await matches[0]!.handler(job({ ...received, attempt: 2 }));
      expect(await f.rows()).toEqual({ inbox: [], logs: [] });
      expect(
        await f.db
          .selectFrom('processed_events')
          .select('event_id')
          .where('consumer', '=', CONSUMER)
          .where('event_id', '=', received.eventId)
          .execute(),
      ).toEqual([{ event_id: received.eventId }]);
      expect(app.sends).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);

it('[AC-B1-12p#24] 实际注册的队列 handler 消费事件并完成通知，两次投递成功且无推送短信任务', async () => {
  const f = await fixture(suite);
  const app = await assembled('worker', f.db, f.clock);
  try {
    const matches = app.registrations.filter((registration) => registration.name === QUEUE);
    expect(matches).toHaveLength(1);
    const handler = matches[0]!.handler;
    const received = f.event({ need_reauth: true });
    await handler(job(received));
    await handler(job({ ...received, attempt: 2 }));
    const rows = await f.rows();
    expect(rows.inbox).toMatchObject([
      {
        app_id: f.appId,
        user_id: f.userId,
        code: 'APPEAL_RESULT',
        title: '申诉结果',
        route: null,
        body: '你的申诉已通过，相关限制已解除。购物前需重新完成淘宝授权。',
      },
    ]);
    expect(rows.logs).toMatchObject([
      {
        channel: 'inbox',
        status: 'success',
        dedupe_key: `appeal.resolved:${received.eventId}`,
        planned_at: new Date(NOW),
        sent_at: new Date(NOW),
      },
    ]);
    expect(
      await f.db
        .selectFrom('processed_events')
        .select(['consumer', 'event_id'])
        .where('event_id', '=', received.eventId)
        .execute(),
    ).toEqual([{ consumer: CONSUMER, event_id: received.eventId }]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('[AC-B1-12p#25] notify_logs 已存在但 processed_events 未写时，真实消费者确认成功且不补发', async () => {
  const f = await fixture(suite);
  const received = f.event();
  await f.log(received);
  const before = await f.rows();
  const app = await assembled('worker', f.db, f.clock);
  try {
    const matches = app.registrations.filter((registration) => registration.name === QUEUE);
    expect(matches).toHaveLength(1);
    await matches[0]!.handler(job(received));
    expect(await f.rows()).toEqual(before);
    expect(
      await f.db
        .selectFrom('processed_events')
        .select('event_id')
        .where('consumer', '=', CONSUMER)
        .where('event_id', '=', received.eventId)
        .execute(),
    ).toEqual([{ event_id: received.eventId }]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('[AC-B1-12p#26] 消费写入失败时 processed_events 与两张通知表一起回滚，队列重投仍能成功', async () => {
  const f = await fixture(suite);
  const received = f.event();
  const fault = failInsert('notify_logs');
  const failedApp = await assembled('worker', f.db.withPlugin(fault.plugin), f.clock);
  try {
    const matches = failedApp.registrations.filter((registration) => registration.name === QUEUE);
    expect(matches).toHaveLength(1);
    await expect(matches[0]!.handler(job(received))).rejects.toMatchObject({ code: '22012' });
    expect(fault.fired()).toBe(true);
    expect(await f.rows()).toEqual({ inbox: [], logs: [] });
    expect(
      await f.db
        .selectFrom('processed_events')
        .select('event_id')
        .where('event_id', '=', received.eventId)
        .execute(),
    ).toEqual([]);
    expect(failedApp.sends).not.toHaveBeenCalled();
  } finally {
    await failedApp.close();
  }
  const recoveredApp = await assembled('worker', f.db, f.clock);
  try {
    const matches = recoveredApp.registrations.filter(
      (registration) => registration.name === QUEUE,
    );
    expect(matches).toHaveLength(1);
    await matches[0]!.handler(job({ ...received, attempt: 2 }));
    const rows = await f.rows();
    expect(rows.inbox).toHaveLength(1);
    expect(rows.logs).toHaveLength(1);
    expect(
      await f.db
        .selectFrom('processed_events')
        .select('event_id')
        .where('consumer', '=', CONSUMER)
        .where('event_id', '=', received.eventId)
        .execute(),
    ).toEqual([{ event_id: received.eventId }]);
    expect(recoveredApp.sends).not.toHaveBeenCalled();
  } finally {
    await recoveredApp.close();
  }
});
