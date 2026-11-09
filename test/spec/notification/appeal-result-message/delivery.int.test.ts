import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAppealResultMessageHandler } from '../../../../apps/api/src/modules/notification/application/appeal-result-message.ts';
import { failInsert, fixture, openSuite, type Suite } from './db-kit.ts';
import { NOW, variants } from './fixtures.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
});
afterAll(async () => {
  await suite?.close();
});

it.each(['revoked', 'upheld'] as const)(
  '[AC-B1-12p#16] blocked_request / %s 不写站内信与日志，包括未建号和已配置模板',
  async (status) => {
    const f = await fixture(suite);
    for (const variant of ['account_revoked', 'order_revoked', 'upheld', 'default']) {
      await f.template(variant, { title_override: '处理结果', body_override: '已经处理。' });
    }
    for (const user_id of [f.userId, null]) {
      for (const need_reauth of [true, false]) {
        const received = f.event({ target_type: 'blocked_request', status, user_id, need_reauth });
        await f.deliver(received);
        await f.deliver({ ...received, attempt: 2 });
        expect(await f.rows()).toEqual({ inbox: [], logs: [] });
      }
    }
  },
);

it.each([true, false])(
  '[AC-B1-12p#17] 无淘宝绑定也按事件 need_reauth=%s 生成提示；时间仅取消费时钟',
  async (need_reauth) => {
    const f = await fixture(suite);
    const received = f.event({ need_reauth });
    f.clock.set('2027-02-03T16:07:08.009Z');
    const start = suite.queries.length;
    await f.deliver(received);
    expect(
      suite.queries
        .slice(start)
        .some((query) => /union_bindings|user_risk_state|appeals/.test(query)),
    ).toBe(false);
    const rows = await f.rows();
    expect(rows.inbox).toMatchObject([
      {
        body: need_reauth
          ? '你的申诉已通过，相关限制已解除。购物前需重新完成淘宝授权。'
          : '你的申诉已通过，相关限制已解除。',
        created_at: new Date('2027-02-03T16:07:08.009Z'),
        updated_at: new Date('2027-02-03T16:07:08.009Z'),
      },
    ]);
    expect(rows.logs).toMatchObject([
      {
        planned_at: new Date('2027-02-03T16:07:08.009Z'),
        sent_at: new Date('2027-02-03T16:07:08.009Z'),
        created_at: new Date('2027-02-03T16:07:08.009Z'),
        updated_at: new Date('2027-02-03T16:07:08.009Z'),
      },
    ]);
  },
);

it('[AC-B1-12p#27] 信封 app_id 与载荷不一致时拒绝投递，两应用均无通知', async () => {
  const a = await fixture(suite);
  const b = await fixture(suite);
  const handler = createAppealResultMessageHandler({ clock: a.clock });
  const received = { ...a.event(), appId: b.appId };
  await expect(a.db.transaction().execute((trx) => handler(received, trx))).rejects.toThrow();
  expect(await a.rows()).toEqual({ inbox: [], logs: [] });
  expect(await b.rows()).toEqual({ inbox: [], logs: [] });
});

it.each(variants)(
  '[AC-B1-12p#8] $variant 从事件快照写一条信与成功日志，无模板仍可发',
  async (row) => {
    const f = await fixture(suite);
    const received = f.event({
      target_type: row.target_type,
      status: row.status,
    });
    const start = suite.queries.length;
    await f.deliver(received);
    expect(
      suite.queries
        .slice(start)
        .some((query) => /user_risk_state|union_bindings|appeals/.test(query)),
    ).toBe(false);
    const { inbox, logs } = await f.rows();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      app_id: f.appId,
      user_id: f.userId,
      code: 'APPEAL_RESULT',
      title: '申诉结果',
      body: row.body,
      // B1-12ze (D10-1183): order rows land on OrderDetail{order_id: target_id}; account rows null.
      route:
        row.target_type === 'order'
          ? { route: 'OrderDetail', params: { order_id: received.payload.target_id } }
          : null,
      read_at: null,
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      app_id: f.appId,
      user_id: f.userId,
      code: 'APPEAL_RESULT',
      channel: 'inbox',
      status: 'success',
      dedupe_key: `appeal.resolved:${received.eventId}`,
      planned_at: new Date(NOW),
      sent_at: new Date(NOW),
    });
  },
);

it('[AC-B1-12p#9] 同事件顺序重复投递不加信、不改原文案与时间，事务可提交', async () => {
  const f = await fixture(suite);
  const received = f.event();
  await f.deliver(received);
  const before = await f.rows();
  f.clock.advanceMs(90_000);
  await f.template('account_revoked', {
    title_override: '更新后的标题',
    body_override: '更新后的正文',
  });
  await f.deliver({ ...received, attempt: 2 });
  expect(await f.rows()).toEqual(before);
  expect(before.inbox).toHaveLength(1);
  expect(before.logs).toHaveLength(1);
});

it('[AC-B1-12p#10] 并发事务投递同事件，PG 唯一约束最终只留一信一日志，所有投递成功', async () => {
  const f = await fixture(suite);
  const received = f.event();
  const handler = createAppealResultMessageHandler({
    clock: f.clock,
  });
  // Bypass processed_events on purpose: notify_logs must be a second, independent boundary.
  const outcomes = await Promise.allSettled(
    Array.from({ length: 6 }, () => f.db.transaction().execute((trx) => handler(received, trx))),
  );
  expect(outcomes.map((result) => result.status)).toEqual(
    Array.from({ length: 6 }, () => 'fulfilled'),
  );
  const rows = await f.rows();
  expect(rows.inbox).toHaveLength(1);
  expect(rows.logs).toHaveLength(1);
});

it('[AC-B1-12p#11] 已存在 notify_logs 去重键时不新增站内信，不依赖 processed_events', async () => {
  const f = await fixture(suite);
  const received = f.event();
  await f.log(received);
  const before = await f.rows();
  const handler = createAppealResultMessageHandler({
    clock: f.clock,
  });
  await f.db.transaction().execute(async (trx) => {
    await handler(received, trx);
    // A swallowed 23505 must not leave an aborted transaction that silently rolls back.
    expect((await sql<{ n: number }>`select 1 as n`.execute(trx)).rows).toEqual([{ n: 1 }]);
  });
  expect(await f.rows()).toEqual(before);
  expect(before.inbox).toEqual([]);
});

it('[AC-B1-12p#12] 同用户相同内容的不同事件分别发信，不能按用户或文案去重', async () => {
  const f = await fixture(suite);
  const first = f.event();
  const second = { ...first, eventId: randomUUID() };
  await f.deliver(first);
  await f.deliver(second);
  const rows = await f.rows();
  expect(rows.inbox).toHaveLength(2);
  expect(rows.logs.map((row) => row.dedupe_key).sort()).toEqual(
    [`appeal.resolved:${first.eventId}`, `appeal.resolved:${second.eventId}`].sort(),
  );
});

it('[AC-B1-12p#13] 相同事件编号在不同 app_id 各自去重与投递', async () => {
  const a = await fixture(suite);
  const b = await fixture(suite);
  const first = a.event();
  await a.deliver(first);
  await b.deliver({ ...b.event(), eventId: first.eventId });
  expect((await a.rows()).inbox).toMatchObject([{ app_id: a.appId, user_id: a.userId }]);
  expect((await b.rows()).inbox).toMatchObject([{ app_id: b.appId, user_id: b.userId }]);
  expect((await b.rows()).logs).toMatchObject([{ dedupe_key: `appeal.resolved:${first.eventId}` }]);
});

it('[AC-B1-12p#14] 两表使用调用方事务：提交前对外不可见，外层失败后两表皆空，可重投', async () => {
  const f = await fixture(suite);
  const received = f.event();
  const handler = createAppealResultMessageHandler({
    clock: f.clock,
  });
  const abort = new Error('fixture-rollback');
  await expect(
    f.db.transaction().execute(async (trx) => {
      await handler(received, trx);
      const inside = await f.rows(trx);
      expect(inside.inbox).toHaveLength(1);
      expect(inside.logs).toHaveLength(1);
      expect(await f.rows()).toEqual({ inbox: [], logs: [] });
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await f.rows()).toEqual({ inbox: [], logs: [] });
  await f.deliver(received);
  const committed = await f.rows();
  expect(committed.inbox).toHaveLength(1);
  expect(committed.logs).toHaveLength(1);
});

it.each(['inbox_messages', 'notify_logs'] as const)(
  '[AC-B1-12p#15] %s 写入失败不吞错，两表回滚，重投成功',
  async (table) => {
    const f = await fixture(suite);
    const received = f.event();
    const handler = createAppealResultMessageHandler({
      clock: f.clock,
    });
    const fault = failInsert(table);
    await expect(
      f.db.transaction().execute((trx) => handler(received, trx.withPlugin(fault.plugin))),
    ).rejects.toMatchObject({ code: '22012' });
    expect(fault.fired()).toBe(true);
    expect(await f.rows()).toEqual({ inbox: [], logs: [] });
    await f.deliver(received);
    const rows = await f.rows();
    expect(rows.inbox).toHaveLength(1);
    expect(rows.logs).toHaveLength(1);
  },
);
