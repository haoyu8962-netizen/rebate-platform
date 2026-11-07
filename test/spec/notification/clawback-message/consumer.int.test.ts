// B1-12zc order.clawed_back through the real worker assembly (AppModule worker entry, in-memory
// queue, no polling): the registered evt.notification-clawback handler, processed_events, the push
// dispatched after the commit (B1-12o), no other job (D10-773 ①). Top-level it() only.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createEventBus } from '../../../../apps/api/src/modules/platform/events/index.ts';
import type { JobQueue } from '../../../../apps/api/src/modules/platform/index.ts';
import { assembled } from '../risk-state-message/worker-kit.ts';
import { failInsert } from '../risk-state-message/db-kit.ts';
import {
  CLAWED_BACK,
  CONSUMER,
  NOW,
  QUEUE,
  REASON_TITLES,
  TITLES,
  clawbackBody,
  clawbackKey,
  expectedLogs,
  fixture,
  job,
  openSuite,
  type Fixture,
  type Suite,
} from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await suite?.close();
});

async function processed(f: Fixture, eventId: string) {
  return f.db
    .selectFrom('processed_events')
    .select(['event_id', 'consumer'])
    .where('event_id', '=', eventId)
    .execute();
}

/** The recipient switched the service category's push off (BR-TEXT-09 例 5). */
const SERVICE_OFF = { service_push: false, subscription_push: true, marketing_push: true };

/** [code, title, body] of one user's inbox messages. */
async function textsOf(f: Fixture, userId: string) {
  const messages = await f.messagesOf(userId);
  return messages.map((message) => [message.code, message.title, message.body]);
}

it('[AC-B1-12zc#23] 真实发布 order.clawed_back 路由到唯一 worker 消费者 evt.notification-clawback；两次投递每人只一条站内信，推送在提交后发起（无可用推送登记 → failed），只确认一次，不排其他任务', async () => {
  const f = await fixture(suite);
  const { self, direct } = f.users;
  const app = await assembled('worker', f.db, f.clock);
  try {
    const matches = app.registrations.filter((r) => r.name === QUEUE);
    expect(matches).toHaveLength(1);
    const send = vi.fn<JobQueue['send']>(
      async (_queue, _name, _payload, options) => options.id ?? null,
    );
    const bus = createEventBus({ queue: { send }, clock: f.clock });
    const event = f.clawedBack({
      rights_event_id: 'R8001',
      reason: 'REFUND',
      beneficiaries: [
        { user_id: self, role: 'self', clawback_fen: '320' },
        { user_id: direct, role: 'direct', clawback_fen: '64' },
      ],
    });
    await f.db.transaction().execute((trx) =>
      bus.publish(trx, {
        appId: event.appId,
        eventId: event.eventId,
        name: CLAWED_BACK,
        payload: event.payload,
      }),
    );
    const ours = send.mock.calls.filter((call) => call[0] === QUEUE);
    expect(ours).toHaveLength(1);
    expect(ours[0]?.slice(0, 3)).toEqual([
      QUEUE,
      CLAWED_BACK,
      { app_id: f.appId, v: 1, occurred_at: NOW, data: event.payload },
    ]);
    const [queue, name, payload, options] = ours[0]!;
    for (const attempt of [1, 2]) {
      await matches[0]!.handler({ id: options.id!, queue, name, payload, attempt });
    }
    expect(await textsOf(f, self)).toEqual([
      ['CLAWBACK', TITLES.CLAWBACK.self, clawbackBody.self('-¥3.2', REASON_TITLES.REFUND)],
    ]);
    expect(await textsOf(f, direct)).toEqual([
      ['CLAWBACK', TITLES.CLAWBACK.invite, clawbackBody.invite('-¥0.64')],
    ]);
    const keys = [
      clawbackKey(f.order, self, 'self', 'R8001'),
      clawbackKey(f.order, direct, 'direct', 'R8001'),
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

it('[AC-B1-12zc#24] worker 上关闭服务类推送的受益人只写站内信，推送日志 suppressed(push_disabled)；其他受益人照常尝试推送（无可用推送登记 → failed，不是 suppressed）', async () => {
  const f = await fixture(suite);
  const { share, indirect } = f.users;
  await f.settings(share, SERVICE_OFF);
  const event = f.clawedBack({
    rights_event_id: 'R8002',
    reason: 'RIGHTS',
    beneficiaries: [
      { user_id: share, role: 'share', clawback_fen: '500' },
      { user_id: indirect, role: 'indirect', clawback_fen: '50' },
    ],
  });
  const app = await assembled('worker', f.db, f.clock);
  try {
    const matches = app.registrations.filter((r) => r.name === QUEUE);
    expect(matches).toHaveLength(1);
    await matches[0]!.handler(job(event));
    expect(await textsOf(f, share)).toEqual([
      ['CLAWBACK', TITLES.CLAWBACK.share, clawbackBody.share('-¥5', REASON_TITLES.RIGHTS)],
    ]);
    expect(await textsOf(f, indirect)).toEqual([
      ['CLAWBACK', TITLES.CLAWBACK.invite, clawbackBody.invite('-¥0.5')],
    ]);
    expect(await f.logsOf(share)).toEqual([
      ['inbox', 'success', null],
      ['push', 'suppressed', 'push_disabled'],
    ]);
    expect(await f.logsOf(indirect)).toEqual([
      ['inbox', 'success', null],
      ['push', 'failed', null],
    ]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('[AC-B1-12zc#25] worker 写入失败时 processed_events 一起回滚，重投成功后只确认一次、每人只一条站内信', async () => {
  const f = await fixture(suite);
  const { self, indirect } = f.users;
  const event = f.clawedBack({
    rights_event_id: 'R8003',
    reason: 'COMMISSION_ZERO',
    beneficiaries: [
      { user_id: self, role: 'self', clawback_fen: '999' },
      { user_id: indirect, role: 'indirect', clawback_fen: '1' },
    ],
  });
  const fault = failInsert('inbox_messages');
  const app = await assembled('worker', f.db.withPlugin(fault.plugin), f.clock);
  try {
    const matches = app.registrations.filter((r) => r.name === QUEUE);
    expect(matches).toHaveLength(1);
    await expect(matches[0]!.handler(job(event))).rejects.toMatchObject({ code: '22012' });
    expect(fault.fired()).toBe(true);
    expect(await f.rows()).toEqual({ inbox: [], logs: [] });
    expect(await processed(f, event.eventId)).toEqual([]);
  } finally {
    await app.close();
  }
  const recovered = await assembled('worker', f.db, f.clock);
  try {
    const matches = recovered.registrations.filter((r) => r.name === QUEUE);
    expect(matches).toHaveLength(1);
    await matches[0]!.handler(job({ ...event, attempt: 2 }));
    const reason = REASON_TITLES.COMMISSION_ZERO;
    expect(await textsOf(f, self)).toEqual([
      ['CLAWBACK', TITLES.CLAWBACK.self, clawbackBody.self('-¥9.99', reason)],
    ]);
    expect(await textsOf(f, indirect)).toEqual([
      ['CLAWBACK', TITLES.CLAWBACK.invite, clawbackBody.invite('-¥0.01')],
    ]);
    expect(await processed(f, event.eventId)).toEqual([
      { event_id: event.eventId, consumer: CONSUMER },
    ]);
    expect(recovered.sends).not.toHaveBeenCalled();
  } finally {
    await recovered.close();
  }
});
