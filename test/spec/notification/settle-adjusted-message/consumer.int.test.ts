// B1-12zc order.settle_adjusted through the real worker assembly (AppModule worker entry, in-memory
// queue, no polling): the same evt.notification-clawback handler as order.clawed_back (D10-773 ①),
// processed_events, the push dispatched after the commit, no other job. Top-level it() only.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createEventBus } from '../../../../apps/api/src/modules/platform/events/index.ts';
import type { JobQueue } from '../../../../apps/api/src/modules/platform/index.ts';
import { assembled } from '../risk-state-message/worker-kit.ts';
import {
  AVAILABLE,
  CONSUMER,
  NOW,
  QUEUE,
  REASON_TITLES,
  SETTLE_ADJUSTED,
  TITLES,
  expectedLogs,
  fixture,
  job,
  openSuite,
  settleBody,
  settleKey,
  type Fixture,
  type Suite,
} from '../clawback-message/kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await suite?.close();
});

/** The recipient switched the service category's push off (BR-TEXT-09 例 5). */
const SERVICE_OFF = { service_push: false, subscription_push: true, marketing_push: true };

async function processed(f: Fixture, eventId: string) {
  return f.db
    .selectFrom('processed_events')
    .select(['event_id', 'consumer'])
    .where('event_id', '=', eventId)
    .execute();
}

/** [code, title, body] of one user's inbox messages. */
async function textsOf(f: Fixture, userId: string) {
  const messages = await f.messagesOf(userId);
  return messages.map((message) => [message.code, message.title, message.body]);
}

it('[AC-B1-12zc#53] 真实发布 order.settle_adjusted 路由到同一个 worker 消费者 evt.notification-clawback；两次投递每人只一条站内信，推送在提交后发起（无可用推送登记 → failed），只确认一次，不排其他任务', async () => {
  const f = await fixture(suite);
  const { self, indirect } = f.users;
  const app = await assembled('worker', f.db, f.clock);
  try {
    const matches = app.registrations.filter((r) => r.name === QUEUE);
    expect(matches).toHaveLength(1);
    const send = vi.fn<JobQueue['send']>(
      async (_queue, _name, _payload, options) => options.id ?? null,
    );
    const bus = createEventBus({ queue: { send }, clock: f.clock });
    const event = f.settleAdjusted({
      settle_seq: 12,
      sub_type: 'PRICE_PROTECT',
      beneficiaries: [
        { user_id: self, role: 'self', adjust_fen: '-320', bucket: AVAILABLE },
        { user_id: indirect, role: 'indirect', adjust_fen: '-32', bucket: AVAILABLE },
      ],
    });
    await f.db.transaction().execute((trx) =>
      bus.publish(trx, {
        appId: event.appId,
        eventId: event.eventId,
        name: SETTLE_ADJUSTED,
        payload: event.payload,
      }),
    );
    const ours = send.mock.calls.filter((call) => call[0] === QUEUE);
    expect(ours).toHaveLength(1);
    expect(ours[0]?.slice(0, 3)).toEqual([
      QUEUE,
      SETTLE_ADJUSTED,
      { app_id: f.appId, v: 1, occurred_at: NOW, data: event.payload },
    ]);
    const [queue, name, payload, options] = ours[0]!;
    for (const attempt of [1, 2]) {
      await matches[0]!.handler({ id: options.id!, queue, name, payload, attempt });
    }
    const reason = REASON_TITLES.PRICE_PROTECT;
    expect(await textsOf(f, self)).toEqual([
      ['SETTLE_ADJUSTED', TITLES.SETTLE_ADJUSTED.self, settleBody.self('¥3.2', reason)],
    ]);
    expect(await textsOf(f, indirect)).toEqual([
      ['SETTLE_ADJUSTED', TITLES.SETTLE_ADJUSTED.invite, settleBody.invite('¥0.32')],
    ]);
    const keys = [
      settleKey(f.order, self, 'self', 12),
      settleKey(f.order, indirect, 'indirect', 12),
    ];
    expect(await f.logKeys()).toEqual(expectedLogs(keys, 'failed'));
    expect(await processed(f, event.eventId)).toEqual([
      { event_id: event.eventId, consumer: CONSUMER },
    ]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('[AC-B1-12zc#54] worker 收到只有正向补差与坏账行的 order.settle_adjusted：确认事件（processed_events 一行），不写站内信与日志、不排其他任务', async () => {
  const f = await fixture(suite);
  const { self, direct } = f.users;
  const event = f.settleAdjusted({
    settle_seq: 3,
    beneficiaries: [
      { user_id: self, role: 'self', adjust_fen: '320', bucket: AVAILABLE },
      { user_id: direct, role: 'direct', adjust_fen: '-64', bucket: 'bad_debt' },
    ],
  });
  const app = await assembled('worker', f.db, f.clock);
  try {
    const matches = app.registrations.filter((r) => r.name === QUEUE);
    expect(matches).toHaveLength(1);
    await matches[0]!.handler(job(event));
    expect(await f.rows()).toEqual({ inbox: [], logs: [] });
    expect(await processed(f, event.eventId)).toEqual([
      { event_id: event.eventId, consumer: CONSUMER },
    ]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('[AC-B1-12zc#55] worker 上关闭服务类推送的受益人只写站内信，推送日志 suppressed(push_disabled)', async () => {
  const f = await fixture(suite);
  const { share } = f.users;
  await f.settings(share, SERVICE_OFF);
  const event = f.settleAdjusted({
    settle_seq: 4,
    sub_type: 'PRICE_COMPARE',
    beneficiaries: [{ user_id: share, role: 'share', adjust_fen: '-500', bucket: AVAILABLE }],
  });
  const app = await assembled('worker', f.db, f.clock);
  try {
    const matches = app.registrations.filter((r) => r.name === QUEUE);
    expect(matches).toHaveLength(1);
    await matches[0]!.handler(job(event));
    const reason = REASON_TITLES.PRICE_COMPARE;
    expect(await textsOf(f, share)).toEqual([
      ['SETTLE_ADJUSTED', TITLES.SETTLE_ADJUSTED.share, settleBody.share('¥5', reason)],
    ]);
    expect(await f.logsOf(share)).toEqual([
      ['inbox', 'success', null],
      ['push', 'suppressed', 'push_disabled'],
    ]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
