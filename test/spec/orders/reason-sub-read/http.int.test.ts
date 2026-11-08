// B1-09y · 走真实 HTTP（生产 Nest 装配 + Fastify inject，只替换读端口与令牌依赖，同 ../list-detail/http-kit.ts）：
// GET /v1/orders 与 GET /v1/orders/{order_id} 的 data 带回填的 reason_sub、过契约（send 内逐个校验
// OrderListResponse / OrderDetailResponse）；null 与不合法的存量值不输出该键，响应其余键集与改动前一致
// （既有冻结用例以 toEqual 比对整条响应）。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withHttp } from '../list-detail/http-kit.ts';
import { fixture } from '../list-detail/kit.ts';
import {
  alertsFor,
  captureLogger,
  expectAlertsPrivate,
  itemOf,
  loggedQueries,
  voided,
} from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

type Body = { code: number; data: Record<string, unknown> };
type ListItem = Record<string, unknown> & { order_id: string };
type ListBody = { code: number; data: { items: ListItem[] } };

it('[AC-B1-09y#14] HTTP 列表与详情：合法子原因原样回填并过契约；null、父编码无子原因、不合法存量值都不输出该键；data 与直调一致', async () => {
  const f = await fixture(db);
  const log = captureLogger();
  const link = await f.link('jd:i_12345');
  const punish = await f.seed(voided('PUNISH', 'FAKE_TRADE'));
  const refund = await f.seed(voided('REFUND', 'IN_SALE'));
  const rights = await f.seed(voided('RIGHTS', 'AFTER_SALE'));
  const none = await f.seed(voided('PUNISH', null));
  const otherParent = await f.seed(voided('BLACKLIST', 'FAKE_TRADE'));
  const foreign = await f.seed(voided('REFUND', 'FAKE_TRADE'));
  const unknown = await f.seed(voided('PUNISH', 'BOGUS_SUB'));
  const share = await f.seed({
    ...voided('PUNISH', 'VIOLATION_PROMO'),
    buy_type: 'share',
    link_id: link,
  });
  const expected = new Map<string, string | null>([
    [punish.order_id, 'FAKE_TRADE'],
    [refund.order_id, 'IN_SALE'],
    [rights.order_id, 'AFTER_SALE'],
    [none.order_id, null],
    [otherParent.order_id, null],
    [foreign.order_id, null],
    [unknown.order_id, null],
  ]);
  const q = await loggedQueries(f, log);
  await withHttp(q, f.subject, async (send) => {
    const listed = await send('/v1/orders?scope=self&limit=50');
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as ListBody;
    expect(body.code).toBe(0);
    expect(body.data.items).toHaveLength(expected.size);
    for (const [orderId, sub] of expected) {
      const item = itemOf(body.data.items, orderId);
      if (sub === null) expect(item, orderId).not.toHaveProperty('reason_sub');
      else expect(item, orderId).toHaveProperty('reason_sub', sub);
    }
    expect(body.data).toEqual(await q.list(f.subject, { scope: 'self', limit: 50 }));

    const shared = (await send('/v1/orders?scope=share')).json() as ListBody;
    expect(itemOf(shared.data.items, share.order_id)).toHaveProperty(
      'reason_sub',
      'VIOLATION_PROMO',
    );

    for (const [orderId, sub] of [...expected, [share.order_id, 'VIOLATION_PROMO'] as const]) {
      const response = await send(`/v1/orders/${orderId}`);
      expect(response.statusCode, orderId).toBe(200);
      const detail = response.json() as Body;
      expect(detail.code).toBe(0);
      if (sub === null) expect(detail.data, orderId).not.toHaveProperty('reason_sub');
      else expect(detail.data, orderId).toHaveProperty('reason_sub', sub);
      expect(detail.data).toEqual(await q.get(f.subject, orderId));
    }
  });
  // The bad stored values were seen and alerted through the queries' logger, privately.
  expect(alertsFor(log, 'REFUND', 'FAKE_TRADE').length).toBeGreaterThan(0);
  expect(alertsFor(log, 'PUNISH', 'BOGUS_SUB').length).toBeGreaterThan(0);
  expectAlertsPrivate(log, [punish, refund, rights, none, otherParent, foreign, unknown, share]);
}, 60_000);

it('[AC-B1-09y#15] 无子原因的单响应键集与改动前相同（不出现 reason_sub 键）；带子原因的孪生单只多 reason_sub 一个键', async () => {
  const f = await fixture(db);
  const log = captureLogger();
  const withSub = await f.seed(voided('PUNISH', 'INSITE_RESALE'));
  const without = await f.seed(voided('PUNISH', null));
  const q = await loggedQueries(f, log);
  await withHttp(q, f.subject, async (send) => {
    const list = (await send('/v1/orders?scope=self')).json() as ListBody;
    const a = itemOf(list.data.items, withSub.order_id);
    const b = itemOf(list.data.items, without.order_id);
    expect(a).toHaveProperty('reason_sub', 'INSITE_RESALE');
    expect(Object.keys(a).sort()).toEqual([...Object.keys(b), 'reason_sub'].sort());
    const detailA = ((await send(`/v1/orders/${withSub.order_id}`)).json() as Body).data;
    const detailB = ((await send(`/v1/orders/${without.order_id}`)).json() as Body).data;
    expect(detailA).toHaveProperty('reason_sub', 'INSITE_RESALE');
    expect(Object.keys(detailA).sort()).toEqual([...Object.keys(detailB), 'reason_sub'].sort());
    expect(Object.keys(detailB)).not.toContain('reason_sub');
  });
  expect(log.alerts()).toEqual([]);
}, 60_000);
