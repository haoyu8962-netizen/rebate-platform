import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture, openSuite, type Suite } from './db-kit.ts';
import { variants } from './fixtures.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
});
afterAll(async () => {
  await suite?.close();
});

it.each(variants)(
  '[AC-B1-12p#18] $target_type / $status 精确匹配同 app、code、variant 的模板',
  async (row) => {
    const f = await fixture(suite);
    const other = await fixture(suite);
    await other.template(row.variant, {
      title_override: '其他应用',
      body_override: '其他应用正文。',
    });
    await f.template(row.variant, { code: 'RISK_STATE_CHANGED', body_override: '其他通知正文。' });
    await f.template('default', { body_override: '默认变体正文。' });
    await f.template(row.variant, {
      title_override: '申诉处理结果',
      body_override: '申诉已经处理。',
    });
    const received = f.event({ target_type: row.target_type, status: row.status });
    await f.deliver(received);
    expect((await f.rows()).inbox).toMatchObject([
      {
        title: '申诉处理结果',
        body: '申诉已经处理。',
        // B1-12ze (D10-1183): order rows land on OrderDetail{order_id: target_id}; account rows null.
        route:
          row.target_type === 'order'
            ? { route: 'OrderDetail', params: { order_id: received.payload.target_id } }
            : null,
      },
    ]);
    expect((await f.rows()).logs).toHaveLength(1);
    expect(await other.rows()).toEqual({ inbox: [], logs: [] });
  },
);

it('[AC-B1-12p#19] 只有其他 app、code、variant 的覆盖时回退包内默认', async () => {
  const f = await fixture(suite);
  const other = await fixture(suite);
  await other.template('account_revoked', { body_override: '其他应用正文。' });
  await f.template('account_revoked', {
    code: 'RISK_STATE_CHANGED',
    body_override: '其他通知正文。',
  });
  await f.template('order_revoked', { body_override: '其他变体正文。' });
  await f.template('default', { body_override: '默认变体正文。' });
  await f.deliver(f.event());
  expect((await f.rows()).inbox).toMatchObject([
    { title: '申诉结果', body: '你的申诉已通过，相关限制已解除。' },
  ]);
});

it.each([
  {
    title_override: '处理结果',
    body_override: null,
    title: '处理结果',
    body: '你的申诉已通过，相关限制已解除。',
  },
  {
    title_override: null,
    body_override: '限制已经解除。',
    title: '申诉结果',
    body: '限制已经解除。',
  },
  {
    title_override: null,
    body_override: null,
    title: '申诉结果',
    body: '你的申诉已通过，相关限制已解除。',
  },
])('[AC-B1-12p#20] 持久化正文与标题分别回退：$title / $body', async (row) => {
  const f = await fixture(suite);
  await f.template('account_revoked', {
    title_override: row.title_override,
    body_override: row.body_override,
  });
  await f.deliver(f.event());
  expect((await f.rows()).inbox).toMatchObject([{ title: row.title, body: row.body }]);
});

it.each(variants.flatMap((row) => [true, false].map((need_reauth) => ({ ...row, need_reauth }))))(
  '[AC-B1-12p#21] $target_type / $status 覆盖正文按载荷 need_reauth=$need_reauth 追加提示，渠道与路由不能被覆盖',
  async (row) => {
    const f = await fixture(suite);
    await f.template(row.variant, {
      category: 'marketing',
      channels: ['push', 'sms'],
      route: JSON.stringify({ route: 'Wallet', params: {} }),
      title_override: '处理结果',
      body_override: '申诉已经处理。',
    });
    const received = f.event({
      target_type: row.target_type,
      status: row.status,
      need_reauth: row.need_reauth,
    });
    await f.deliver(received);
    const rows = await f.rows();
    expect(rows.inbox).toMatchObject([
      {
        title: '处理结果',
        body:
          row.variant === 'account_revoked' && row.need_reauth
            ? '申诉已经处理。购物前需重新完成淘宝授权。'
            : '申诉已经处理。',
        // B1-12ze (D10-1183): the template's Wallet route never applies; order rows land on
        // OrderDetail{order_id: target_id}, account rows stay null.
        route:
          row.target_type === 'order'
            ? { route: 'OrderDetail', params: { order_id: received.payload.target_id } }
            : null,
      },
    ]);
    expect(rows.logs.map(({ channel, status }) => ({ channel, status }))).toEqual([
      { channel: 'inbox', status: 'success' },
    ]);
  },
);
