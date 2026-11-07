import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock, createRootLogger, type ReceivedEvent } from '../../platform/index.ts';
import type { PushSendCore } from './push-send.ts';
import { createOrderDeductionMessageConsumer, renderClawbackMessage } from './clawback-message.ts';

const ORDER_ID = '0192f000-0000-7000-8000-0000000000c1';

function consumer() {
  const push: PushSendCore = { record: vi.fn(), dispatch: vi.fn() };
  const logger = createRootLogger(
    { level: 'silent', entry: 'worker', appEnv: 'test' },
    {
      write() {},
    },
  );
  const sut = createOrderDeductionMessageConsumer({
    clock: new FixedClock('2026-11-07T00:00:00.000Z'),
    logger,
    push,
  });
  return { sut, push };
}

function event(payload: Record<string, unknown>, name: string): ReceivedEvent {
  return {
    eventId: '0192f000-0000-7000-8000-000000000001',
    appId: 'app-unit',
    name,
    version: 1,
    occurredAt: '2026-11-07T00:00:00.000Z',
    consumer: 'notification-clawback',
    attempt: 1,
    payload: payload as ReceivedEvent['payload'],
  };
}

/** A transaction handle that fails any use: the cases below must not read or write. */
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error('the transaction must not be used');
    },
  },
) as Transaction<DB>;

it('[AC-B1-12zc#u1] a settle_adjusted event without a decrease to user_available touches neither the transaction nor the push core', async () => {
  const { sut, push } = consumer();
  const payload = {
    order_id: ORDER_ID,
    order_key: 'jd:child-1',
    settle_seq: 2,
    sub_type: 'SETTLE_DIFF',
    beneficiaries: [
      { user_id: 'u-1', role: 'self', adjust_fen: '320', bucket: 'user_available' },
      { user_id: 'u-2', role: 'direct', adjust_fen: '0', bucket: 'user_available' },
      { user_id: 'u-3', role: 'platform', adjust_fen: '-50', bucket: 'bad_debt' },
    ],
  };
  await expect(
    sut.handle(event(payload, 'order.settle_adjusted'), untouchable),
  ).resolves.toBeUndefined();
  await sut.dispatch(untouchable, event(payload, 'order.settle_adjusted'));
  expect(push.record).not.toHaveBeenCalled();
  expect(push.dispatch).not.toHaveBeenCalled();
});

it('[AC-B1-12zc#u2] a malformed payload, an unknown role or another event name fails the job', async () => {
  const { sut } = consumer();
  const good = {
    order_id: ORDER_ID,
    order_key: 'jd:child-1',
    rights_event_id: 'R1',
    transition: 'R8',
    reason: 'REFUND',
    beneficiaries: [{ user_id: 'u-1', role: 'self', clawback_fen: '320' }],
  };
  const bad = [
    { ...good, order_id: 'not-a-uuid' },
    { ...good, beneficiaries: 'nope' },
    { ...good, beneficiaries: [{ user_id: 'u-1', role: 'self', clawback_fen: '3.2' }] },
    { ...good, beneficiaries: [{ user_id: 'u-1', role: 'buyer', clawback_fen: '320' }] },
  ];
  for (const payload of bad) {
    await expect(sut.handle(event(payload, 'order.clawed_back'), untouchable)).rejects.toThrow();
  }
  await expect(sut.handle(event(good, 'order.credited'), untouchable)).rejects.toThrow(
    'unexpected event',
  );
});

it('[AC-B1-12zc#u3] without a reason the default sentence ends after the amount; an invite override never receives a reason', () => {
  const base = { order_id: ORDER_ID, clawback_fen: 100n };
  expect(renderClawbackMessage({ ...base, role: 'self', reason: null }, null)?.body).toBe(
    '订单返利已扣回 -¥1',
  );
  expect(renderClawbackMessage({ ...base, role: 'self', reason: 'PART_REFUND' }, null)?.body).toBe(
    '订单返利已扣回 -¥1：部分退款',
  );
  const override = { title_override: null, body_override: '扣回 {amount}{reason.title}{reason}' };
  expect(renderClawbackMessage({ ...base, role: 'direct', reason: 'REFUND' }, override)?.body).toBe(
    '扣回 -¥1',
  );
  expect(
    renderClawbackMessage({ ...base, role: 'self', clawback_fen: 0n, reason: null }, null),
  ).toBe(null);
});
