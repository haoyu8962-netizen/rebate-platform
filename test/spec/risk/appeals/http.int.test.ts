import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { banned, SEARCH } from '../risk-state/http-kit.ts';
import { publicAppeal } from './service-kit.ts';
import {
  accepted,
  appeals,
  client,
  events,
  listed,
  openHttp,
  PATH,
  rejected,
  states,
  type Fixture,
} from './http-kit.ts';

let f: Fixture;
beforeAll(async () => {
  f = await openHttp();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

for (const state of ['banned', 'frozen'] as const) {
  it(`[AC-B1-03i#15][AC-S1-60 ⑤] 真 AppModule ${state} 申诉白名单受理、重复返回原单，响应符合契约`, async () => {
    const c = await client(f, state);
    const before = await events(f, c);
    const first = await accepted(
      await c.send('POST', PATH, {
        target_type: 'account',
        target_id: randomUUID(),
        content: '  原文\n请复核🙂 ',
      }),
    );
    publicAppeal(first);
    expect(first).toMatchObject({
      target_id: c.uid,
      content: '  原文\n请复核🙂 ',
      target_type: 'account',
      status: 'processing',
      closed_at: null,
      // BR-ID-36 细则: the first appeal on the account → attempt_no 1; processing → no resubmit.
      attempt_no: 1,
      can_resubmit: false,
    });
    expect(
      await accepted(await c.send('POST', PATH, { target_type: 'account', content: '再次申请' })),
    ).toEqual(first);
    expect(await appeals(f, c)).toMatchObject([{ id: first.appeal_id, prev_risk_state: state }]);
    expect(await states(f, c)).toMatchObject([{ state: 'appealing', changed_by: `user:${c.uid}` }]);
    expect(await events(f, c)).toHaveLength(before.length + 1);
    expect(await listed(await c.send('GET', PATH))).toEqual({ items: [first], next_cursor: null });
    if (state === 'banned') await banned(await c.send('GET', SEARCH));
  });
}

it('[AC-B1-03i#16] 同幂等键同请求回放原响应、不同请求 20901，原单与状态不变', async () => {
  const c = await client(f);
  const key = randomUUID();
  const body = { target_type: 'account', content: '原始申诉' };
  const headers = { 'idempotency-key': key, 'x-trace-id': randomUUID() };
  const first = await c.send('POST', PATH, body, headers);
  await accepted(first);
  const before = {
    appeals: await appeals(f, c),
    states: await states(f, c),
    events: await events(f, c),
  };
  const replay = await c.send('POST', PATH, body, headers);
  await accepted(replay);
  expect(replay.json()).toEqual(first.json());
  await rejected(await c.send('POST', PATH, { ...body, content: '被篡改' }, headers), 409, 20901);
  expect(await appeals(f, c)).toEqual(before.appeals);
  expect(await states(f, c)).toEqual(before.states);
  expect(await events(f, c)).toEqual(before.events);
  const claims = await f.db
    .selectFrom('idempotency_keys')
    .selectAll()
    .where('app_id', '=', c.appId)
    .where('key', '=', key)
    .execute();
  expect(claims).toHaveLength(1);
});

for (const sameKey of [false, true]) {
  it(`[AC-B1-03i#17] 并发 HTTP ${sameKey ? '相同' : '不同'} 幂等键只产生一单一次状态变更`, async () => {
    const c = await client(f);
    const before = await events(f, c);
    const keys = [randomUUID(), randomUUID()];
    const responses = await Promise.all(
      keys.map((key) =>
        c.send(
          'POST',
          PATH,
          { target_type: 'account', content: '并发申诉' },
          { 'idempotency-key': sameKey ? keys[0]! : key },
        ),
      ),
    );
    const completed = [];
    for (const response of responses) {
      // Platform idempotency may report a live claim as 40901; different keys must both succeed.
      if (sameKey && response.statusCode === 409) await rejected(response, 409, 40901);
      else completed.push(await accepted(response));
    }
    expect(completed.length).toBeGreaterThan(0);
    for (const data of completed) expect(data).toEqual(completed[0]);
    if (sameKey) {
      const replayTraceId = randomUUID();
      const replay = await c.send(
        'POST',
        PATH,
        { target_type: 'account', content: '并发申诉' },
        { 'idempotency-key': keys[0]!, 'x-trace-id': replayTraceId },
      );
      // 回放体保留首次请求的 trace_id，响应头使用本次请求的追踪号。
      expect(replay.statusCode).toBe(200);
      expect(replay.headers['x-trace-id']).toBe(replayTraceId);
      expect(replay.json()).toEqual(
        responses.find((response) => response.statusCode === 200)!.json(),
      );
      expect(replay.json<{ data: unknown }>().data).toEqual(completed[0]);
    } else expect(completed).toHaveLength(2);
    expect(await appeals(f, c)).toHaveLength(1);
    expect(await events(f, c)).toHaveLength(before.length + 1);
    expect(await states(f, c)).toMatchObject([{ state: 'appealing', row_version: 1 }]);
  });
}

for (const content of [' ', '长'.repeat(5000)]) {
  it(`[AC-B1-03i#18] 契约非空原文不 trim、不擅加长度上限（长度 ${content.length}）`, async () => {
    const c = await client(f);
    expect(
      (await accepted(await c.send('POST', PATH, { target_type: 'account', content }))).content,
    ).toBe(content);
    expect(await appeals(f, c)).toMatchObject([{ content }]);
  });
}

for (const body of [
  { target_type: 'account', content: '' },
  { target_type: 'account' },
  { target_type: 'blocked_request', content: '后台专用' },
  { target_type: 'account', content: '伪造身份', user_id: randomUUID() },
  { target_type: 'account', content: '伪造品牌', app_id: 'another_app' },
  { target_type: 'order', content: '无订单 id' },
]) {
  it(`[AC-B1-03i#19] 非法或未支持请求 ${JSON.stringify(body)} 返回 20001 且无业务写入`, async () => {
    const c = await client(f);
    expect(await listed(await c.send('GET', PATH))).toEqual({ items: [], next_cursor: null });
    const before = { states: await states(f, c), events: await events(f, c) };
    await rejected(await c.send('POST', PATH, body), 400, 20001);
    expect(await appeals(f, c)).toEqual([]);
    expect(await states(f, c)).toEqual(before.states);
    expect(await events(f, c)).toEqual(before.events);
  });
}

it('[AC-B1-03i#20] 两条路由必须登录，不接受请求传入身份代替令牌', async () => {
  const c = await client(f);
  expect(await listed(await c.send('GET', PATH))).toEqual({ items: [], next_cursor: null });
  await rejected(await c.send('GET', PATH, undefined, {}, false), 401, 10001);
  await rejected(
    await c.send('POST', PATH, { target_type: 'account', content: '匿名' }, {}, false),
    401,
    10001,
  );
  expect(await appeals(f, c)).toEqual([]);
});

it('[AC-B1-03i#27] 相同幂等键在不同本人账户与 app 下互不串单', async () => {
  const clients = [await client(f), await client(f)];
  const key = randomUUID();
  const data = [];
  for (const c of clients) {
    const result = await accepted(
      await c.send(
        'POST',
        PATH,
        { target_type: 'account', content: '相同正文' },
        { 'idempotency-key': key },
      ),
    );
    expect(result.target_id).toBe(c.uid);
    expect(await listed(await c.send('GET', PATH))).toEqual({ items: [result], next_cursor: null });
    expect(await appeals(f, c)).toHaveLength(1);
    data.push(result);
  }
  expect(data[0]!.appeal_id).not.toBe(data[1]!.appeal_id);
});

it('[AC-B1-03i#21] 低版本 POST 10405 不落幂等键；GET 白名单仍可读取', async () => {
  const c = await client(f);
  await sql`INSERT INTO app.app_versions (id, app_id, platform, channel, latest_version, min_supported_version, update_title, update_notes, store_url, default_store, store_listings)
    VALUES (${randomUUID()}, ${c.appId}, 'ios', 'appstore', '9.0.0', '8.0.0', 'fixture', 'fixture', 'https://example.test/store', 'appstore', '[]'::jsonb)`.execute(
    f.db,
  );
  expect(await listed(await c.send('GET', PATH))).toEqual({ items: [], next_cursor: null });
  const key = randomUUID();
  await rejected(
    await c.send(
      'POST',
      PATH,
      { target_type: 'account', content: '低版本' },
      { 'idempotency-key': key },
    ),
    403,
    10405,
  );
  expect(await appeals(f, c)).toEqual([]);
  expect(
    await f.db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('app_id', '=', c.appId)
      .where('key', '=', key)
      .execute(),
  ).toEqual([]);
});

it('[AC-B1-03i#25] 业务失败回滚幂等占位、申诉、状态及事件，同键可再次提交成功', async () => {
  const c = await client(f);
  expect(await listed(await c.send('GET', PATH))).toEqual({ items: [], next_cursor: null });
  const before = { states: await states(f, c), events: await events(f, c) };
  const key = randomUUID();
  const body = { target_type: 'account', content: '故障后重试' };
  const original = c.risk.setRiskState.bind(c.risk);
  const spy = vi.spyOn(c.risk, 'setRiskState').mockImplementationOnce(async (trx, command) => {
    await original(trx, command);
    throw new Error('fixture-after-state-write');
  });
  try {
    const failed = await c.send('POST', PATH, body, { 'idempotency-key': key });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ code: 50001 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await appeals(f, c)).toEqual([]);
    expect(await states(f, c)).toEqual(before.states);
    expect(await events(f, c)).toEqual(before.events);
    expect(
      await f.db
        .selectFrom('idempotency_keys')
        .selectAll()
        .where('app_id', '=', c.appId)
        .where('key', '=', key)
        .execute(),
    ).toEqual([]);
  } finally {
    spy.mockRestore();
  }
  await accepted(await c.send('POST', PATH, body, { 'idempotency-key': key }));
  expect(await appeals(f, c)).toHaveLength(1);
  expect(await events(f, c)).toHaveLength(before.events.length + 1);
});

it('[AC-B1-03i#26] 原单结案且用户恢复 normal 后同键仍回放提交结果，不重新执行业务', async () => {
  const c = await client(f);
  const body = { target_type: 'account', content: '原始请求' };
  const headers = { 'idempotency-key': randomUUID(), 'x-trace-id': randomUUID() };
  const first = await c.send('POST', PATH, body, headers);
  const data = await accepted(first);
  await f.db
    .updateTable('appeals')
    .set({ status: 'revoked', closed_at: f.clock.now(), handler_id: 'fixture-handler' })
    .where('id', '=', data.appeal_id)
    .execute();
  await c.set('normal');
  const before = {
    appeals: await appeals(f, c),
    states: await states(f, c),
    events: await events(f, c),
  };
  const replay = await c.send('POST', PATH, body, headers);
  await accepted(replay);
  expect(replay.json()).toEqual(first.json());
  expect(await appeals(f, c)).toEqual(before.appeals);
  expect(await states(f, c)).toEqual(before.states);
  expect(await events(f, c)).toEqual(before.events);
});
