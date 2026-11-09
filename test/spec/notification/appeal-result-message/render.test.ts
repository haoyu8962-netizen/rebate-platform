import { expect, it } from 'vitest';
import { renderAppealResultMessage } from '../../../../apps/api/src/modules/notification/application/appeal-result-message.ts';
import { payload, variants } from './fixtures.ts';

it.each(variants)(
  '[AC-B1-12p#1] $target_type / $status 使用逐字默认文案、服务类别、仅站内与空路由',
  (row) => {
    const input = payload(row);
    expect(renderAppealResultMessage(input, null)).toStrictEqual({
      code: 'APPEAL_RESULT',
      variant: row.variant,
      category: 'service',
      channels: ['inbox'],
      title: '申诉结果',
      body: row.body,
      // B1-12ze (D10-1183): an order appeal lands on its order; an account appeal has no route.
      route:
        row.target_type === 'order'
          ? { route: 'OrderDetail', params: { order_id: input.target_id } }
          : null,
    });
  },
);

it.each([
  [true, '你的申诉已通过，相关限制已解除。购物前需重新完成淘宝授权。'],
  [false, '你的申诉已通过，相关限制已解除。'],
] as const)('[AC-B1-12p#2] 账户撤销 need_reauth=%s 时紧接正文附提示或不附', (need_reauth, body) => {
  expect(renderAppealResultMessage(payload({ need_reauth }), null)?.body).toBe(body);
});

it.each(variants.slice(1))(
  '[AC-B1-12p#3] $target_type / $status 即使 need_reauth=true 也不附淘宝提示',
  (row) => {
    expect(renderAppealResultMessage(payload({ ...row, need_reauth: true }), null)?.body).toBe(
      row.body,
    );
  },
);

it.each(['revoked', 'upheld'] as const)(
  '[AC-B1-12p#4] blocked_request / %s 无论是否有用户、是否需授权均无消息',
  (status) => {
    for (const user_id of [null, 'fixture-user']) {
      for (const need_reauth of [true, false]) {
        expect(
          renderAppealResultMessage(
            payload({ target_type: 'blocked_request', status, user_id, need_reauth }),
            { title_override: '已配置标题', body_override: '已配置正文' },
          ),
        ).toBeNull();
      }
    }
  },
);

it.each([
  {
    title_override: null,
    body_override: null,
    title: '申诉结果',
    body: '你的申诉已通过，相关限制已解除。',
  },
  {
    title_override: '申诉处理结果',
    body_override: null,
    title: '申诉处理结果',
    body: '你的申诉已通过，相关限制已解除。',
  },
  {
    title_override: null,
    body_override: '申诉已经处理。',
    title: '申诉结果',
    body: '申诉已经处理。',
  },
  {
    title_override: '申诉处理结果',
    body_override: '申诉已经处理。',
    title: '申诉处理结果',
    body: '申诉已经处理。',
  },
])('[AC-B1-12p#5] 标题与正文分别覆盖、分别回退：$title / $body', (row) => {
  expect(renderAppealResultMessage(payload(), row)).toMatchObject({
    title: row.title,
    body: row.body,
  });
});

it.each([true, false])(
  '[AC-B1-12p#6] 覆盖正文同样按 need_reauth=%s 追加固定提示',
  (need_reauth) => {
    expect(
      renderAppealResultMessage(payload({ need_reauth }), {
        title_override: '账户申诉结果',
        body_override: '限制已经解除。',
      }),
    ).toMatchObject({
      title: '账户申诉结果',
      body: need_reauth ? '限制已经解除。购物前需重新完成淘宝授权。' : '限制已经解除。',
    });
  },
);
