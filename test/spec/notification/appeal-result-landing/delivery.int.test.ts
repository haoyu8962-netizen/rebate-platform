import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture, openSuite, type Suite } from '../appeal-result-message/db-kit.ts';
import { orderDetail } from './routes.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
});
afterAll(async () => {
  await suite?.close();
});

it.each(['revoked', 'upheld'] as const)(
  '[AC-B1-12ze#4] 订单申诉 %s 写入的站内信 route 恰为 OrderDetail{order_id: target_id}，仍只发站内',
  async (status) => {
    const f = await fixture(suite);
    const orderId = randomUUID();
    await f.deliver(f.event({ target_type: 'order', target_id: orderId, status }));
    const { inbox, logs } = await f.rows();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.route).toEqual(orderDetail(orderId));
    expect(logs.map(({ channel, status: sent }) => ({ channel, status: sent }))).toEqual([
      { channel: 'inbox', status: 'success' },
    ]);
  },
);

it.each(['order_revoked', 'upheld'] as const)(
  '[AC-B1-12ze#5] 模板 %s 配了 Wallet 路由与推送渠道，订单申诉仍落地本单且只发站内',
  async (variant) => {
    const f = await fixture(suite);
    await f.template(variant, {
      channels: ['inbox', 'push', 'sms'],
      route: JSON.stringify({ route: 'Wallet', params: {} }),
    });
    const orderId = randomUUID();
    await f.deliver(
      f.event({
        target_type: 'order',
        target_id: orderId,
        status: variant === 'upheld' ? 'upheld' : 'revoked',
      }),
    );
    const { inbox, logs } = await f.rows();
    expect(inbox.map((message) => message.route)).toEqual([orderDetail(orderId)]);
    expect(logs.map(({ channel }) => channel)).toEqual(['inbox']);
  },
);

it('[AC-B1-12ze#6] 同一用户的账户申诉与订单申诉结果：订单信落到本单，账户信无落地', async () => {
  const f = await fixture(suite);
  const orderId = randomUUID();
  await f.deliver(f.event({ target_type: 'account', status: 'upheld' }));
  await f.deliver(f.event({ target_type: 'order', target_id: orderId, status: 'revoked' }));
  const { inbox } = await f.rows();
  expect(inbox).toHaveLength(2);
  expect(inbox.map(({ body, route }) => ({ body, route }))).toEqual(
    expect.arrayContaining([
      { body: '你的申诉已处理，维持原处理结果。如有疑问请联系客服。', route: null },
      { body: '你对一笔订单的申诉已通过，返利将在复核后恢复。', route: orderDetail(orderId) },
    ]),
  );
});
