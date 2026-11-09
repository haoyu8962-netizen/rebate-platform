import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { renderAppealResultMessage } from '../../../../apps/api/src/modules/notification/application/appeal-result-message.ts';
import { payload } from '../appeal-result-message/fixtures.ts';
import { orderDetail } from './routes.ts';

it.each(
  (['revoked', 'upheld'] as const).flatMap((status) =>
    [true, false].map((need_reauth) => ({ status, need_reauth })),
  ),
)(
  '[AC-B1-12ze#1] 订单申诉 $status（need_reauth=$need_reauth）落地 OrderDetail，order_id 恰是载荷 target_id',
  ({ status, need_reauth }) => {
    const orderId = randomUUID();
    const input = payload({ target_type: 'order', target_id: orderId, status, need_reauth });
    const message = renderAppealResultMessage(input, null);
    expect(message?.route).toStrictEqual(orderDetail(orderId));
    // The landing carries the order only: never the user, the appeal or anything else.
    expect(JSON.stringify(message?.route)).not.toContain(String(input.user_id));
    expect(JSON.stringify(message?.route)).not.toContain(input.appeal_id);
  },
);

it.each(['revoked', 'upheld'] as const)(
  '[AC-B1-12ze#2] 订单申诉 %s 有标题与正文覆盖时仍落地本单',
  (status) => {
    const orderId = randomUUID();
    const message = renderAppealResultMessage(
      payload({ target_type: 'order', target_id: orderId, status }),
      { title_override: '订单申诉结果', body_override: '你的订单申诉已处理。' },
    );
    expect(message).toMatchObject({
      title: '订单申诉结果',
      body: '你的订单申诉已处理。',
      channels: ['inbox'],
      route: orderDetail(orderId),
    });
  },
);

it('[AC-B1-12ze#3] 同一用户两笔订单的申诉结果各自落到自己的订单，账户申诉仍无落地', () => {
  const first = payload({ target_type: 'order', target_id: randomUUID(), status: 'revoked' });
  const second = payload({
    user_id: first.user_id,
    target_type: 'order',
    target_id: randomUUID(),
    status: 'upheld',
  });
  const account = payload({
    user_id: first.user_id,
    target_type: 'account',
    target_id: first.user_id ?? '',
    status: 'upheld',
  });
  expect(
    [first, second, account].map((input) => renderAppealResultMessage(input, null)?.route),
  ).toStrictEqual([orderDetail(first.target_id), orderDetail(second.target_id), null]);
});
