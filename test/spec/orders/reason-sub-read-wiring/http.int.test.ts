// B1-09zc · 生产装配（api 入口）：真实 AppModule 组出的 OrderQueries，真实令牌、真实 PG 与 Redis，
// HTTP 经 inject；日志只从传给 createHttpApp 的根 logger（ROOT_LOGGER）取，测试里不构造
// createOrderQueries、不替换任何端口。现状：orders.module 的 OrderQueries 工厂不把 ROOT_LOGGER 传给
// createOrderQueries，不合法的 reason_sub 在生产上不出键却不告警，所以这里红在 warn 断言。
// 依据：B1-09y（#2752）的 money 评审 S2；契约 CT-24zx（OrderSummary / OrderDetail 可选可空 reason_sub）；
// 告警形状同 B1-09y：warn，alert order_reason_sub_invalid，平铺字段 reason、reason_sub，
// 整条日志不含订单号、子单号、用户 id、金额。合法值照常出键、不告警；null 不出键、不告警。
// 夹具只读复用 ../figures/kit.ts 与 ../../identity/me/http-kit.ts（openSuite → @couli/db/testing）。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { Response } from '../../identity/sms-codes/http-kit.ts';
import {
  closeKit,
  consentAll,
  fixture as member,
  openKit,
  type Kit,
} from '../../identity/me/http-kit.ts';
import { fixture } from '../figures/kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 120_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

const TIMEOUT = 60_000;
const LIST = '/v1/orders';
const DETAIL = '/v1/orders/{order_id}';
/** member() sets the Clock to 2031-05-06T08:08:09Z; paid a month before, inside the query window. */
const PAID_AT = '2031-04-02T02:00:00.000Z';
/** A pay amount no log field may carry. */
const PAY_FEN = 987_654_321n;
const ALERT = 'order_reason_sub_invalid';

type LogLine = Record<string, unknown>;

interface Seeded {
  readonly orderId: string;
  readonly subOrderId: string;
  readonly parentOrderId: string;
  readonly reason: string;
  readonly reasonSub: string | null;
}

function data<T>(response: Response, path: string): T {
  expect(response.statusCode).toBe(200);
  const body = response.json<{ code: number; data: T }>();
  expect(body).toMatchObject({ code: 0 });
  const schema =
    kit.document.paths[path]!['get']!.responses['200']!.content['application/json']!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body.data;
}

/** The pino lines the root logger wrote from index `from` on, one JSON object each. */
function linesFrom(from: number): LogLine[] {
  return kit.lines
    .slice(from)
    .join('')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LogLine);
}

/** The order_reason_sub_invalid lines among them. */
function alertsFrom(from: number): LogLine[] {
  return linesFrom(from).filter((line) => line['alert'] === ALERT);
}

function pairOf(line: LogLine): [unknown, unknown] {
  return [line['reason'], line['reason_sub']];
}

function sortedPairs(pairs: readonly (readonly [unknown, unknown])[]): string[] {
  return pairs.map((pair) => JSON.stringify(pair)).sort();
}

/** A warn line of flat fields only, carrying none of the given values anywhere. */
function expectPrivateWarn(line: LogLine, secrets: readonly string[]) {
  expect(line['level']).toBe(40);
  for (const [key, value] of Object.entries(line)) {
    expect(key).not.toMatch(/order_id|order_no|sub_order|parent_order|user|uid|fen|amount|buyer/i);
    expect(value === null || typeof value !== 'object', `${key} is flat`).toBe(true);
  }
  const text = JSON.stringify(line);
  for (const secret of secrets) expect(text).not.toContain(secret);
}

async function memberFixture() {
  const m = await member(kit);
  await consentAll(kit, m);
  const f = await fixture(kit.suite.db, {
    now: kit.clock.now().toISOString(),
    subject: { app_id: m.appId, user_id: m.uid },
  });
  const session = await m.session();
  /** A terminal order (VOID → INVALID) of `reason` with the stored reason_sub, as a row. */
  async function voided(reason: string, reasonSub: string | null, share = false): Promise<Seeded> {
    const parentOrderId = `parent-${randomUUID()}`;
    const o = await f.order({
      patch: {
        rebate_status: 'VOID',
        platform_status: 'INVALID',
        reason,
        reason_sub: reasonSub,
        paid_at: PAID_AT,
        parent_order_id: parentOrderId,
        pay_amount_fen: PAY_FEN,
        ...(share ? { buy_type: 'share' } : {}),
      },
      ...(share
        ? { people: [{ userId: f.subject.user_id, role: 'share' as const, ratioBp: 4000 }] }
        : {}),
    });
    return { orderId: o.orderId, subOrderId: o.subOrderId, parentOrderId, reason, reasonSub };
  }
  return {
    uid: m.uid,
    voided,
    list: async (scope: 'self' | 'share') =>
      data<Schema<'OrderListData'>>(await session.request(`${LIST}?scope=${scope}&limit=50`), LIST),
    get: async (orderId: string) =>
      data<Schema<'OrderDetail'>>(await session.request(`${LIST}/${orderId}`), DETAIL),
  };
}

type Member = Awaited<ReturnType<typeof memberFixture>>;

/** Order id, sub-order id, parent order id, the user, the order number shown and the amount. */
function secretsOf(m: Member, rows: readonly Seeded[], orderNos: readonly unknown[]): string[] {
  const secrets = [m.uid, String(PAY_FEN)];
  for (const row of rows) secrets.push(row.orderId, row.subOrderId, row.parentOrderId);
  for (const no of orderNos) if (typeof no === 'string' && no !== '') secrets.push(no);
  return secrets;
}

function itemOf<T extends { order_id: string }>(items: readonly T[], orderId: string): T {
  const found = items.find((item) => item.order_id === orderId);
  expect(found, `list item ${orderId}`).toBeDefined();
  return found as T;
}

it(
  '[AC-B1-09zc#1] 生产 GET /v1/orders?scope=self：不合法子原因不出键且根 logger 每单一条 warn（order_reason_sub_invalid、reason、reason_sub，不含单号 / 用户 / 金额）；合法值出键、null 不出键，都不告警',
  async () => {
    const m = await memberFixture();
    const valid = await m.voided('PUNISH', 'FAKE_TRADE');
    const none = await m.voided('PUNISH', null);
    const foreign = await m.voided('REFUND', 'FAKE_TRADE');
    const unknown = await m.voided('PUNISH', 'BOGUS_SUB');
    const crossed = await m.voided('RIGHTS', 'IN_SALE');
    const bad = [foreign, unknown, crossed];

    const from = kit.lines.length;
    const page = await m.list('self');
    const alerts = alertsFrom(from);

    expect(itemOf(page.items, valid.orderId)).toHaveProperty('reason_sub', 'FAKE_TRADE');
    for (const row of [none, ...bad]) {
      expect(itemOf(page.items, row.orderId), row.orderId).not.toHaveProperty('reason_sub');
    }
    // Exactly one alert per bad row, none for the valid or the null one.
    expect(sortedPairs(alerts.map(pairOf))).toEqual(
      sortedPairs(bad.map((row) => [row.reason, row.reasonSub] as const)),
    );
    const secrets = secretsOf(
      m,
      [valid, none, ...bad],
      page.items.map((item) => item.order_no),
    );
    for (const line of alerts) expectPrivateWarn(line, secrets);
  },
  TIMEOUT,
);

it(
  '[AC-B1-09zc#2] 生产 GET /v1/orders/{order_id}：不合法子原因的详情不出键且根 logger 收到一条 warn；合法值与 null 的详情不告警',
  async () => {
    const m = await memberFixture();
    const valid = await m.voided('PUNISH', 'FAKE_TRADE');
    const none = await m.voided('REFUND', null);
    const foreign = await m.voided('REFUND', 'FAKE_TRADE');
    const unknown = await m.voided('PUNISH', 'BOGUS_SUB');
    const rows = [valid, none, foreign, unknown];
    const badIds = new Set([foreign.orderId, unknown.orderId]);

    const orderNos: unknown[] = [];
    const seen: { row: Seeded; alerts: LogLine[] }[] = [];
    for (const row of rows) {
      const from = kit.lines.length;
      const detail = await m.get(row.orderId);
      seen.push({ row, alerts: alertsFrom(from) });
      orderNos.push(detail.order_no);
      if (row === valid) expect(detail).toHaveProperty('reason_sub', 'FAKE_TRADE');
      else expect(detail, row.orderId).not.toHaveProperty('reason_sub');
    }
    const secrets = secretsOf(m, rows, orderNos);
    for (const { row, alerts } of seen) {
      if (badIds.has(row.orderId)) {
        expect(alerts.map(pairOf), row.orderId).toEqual([[row.reason, row.reasonSub]]);
      } else {
        expect(alerts, row.orderId).toEqual([]);
      }
      for (const line of alerts) expectPrivateWarn(line, secrets);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-09zc#3] 生产分享单（scope=share 列表与详情）：父编码外与枚举外的子原因不出键、经根 logger 告警且不带单号 / 用户 / 金额；合法分享单出键、不告警',
  async () => {
    const m = await memberFixture();
    const valid = await m.voided('PUNISH', 'VIOLATION_PROMO', true);
    const foreign = await m.voided('REFUND', 'AFTER_SALE', true);
    const unknown = await m.voided('REFUND', 'none', true);
    const bad = [foreign, unknown];

    const listFrom = kit.lines.length;
    const page = await m.list('share');
    const listAlerts = alertsFrom(listFrom);
    expect(itemOf(page.items, valid.orderId)).toHaveProperty('reason_sub', 'VIOLATION_PROMO');
    for (const row of bad) {
      expect(itemOf(page.items, row.orderId), row.orderId).not.toHaveProperty('reason_sub');
    }
    expect(sortedPairs(listAlerts.map(pairOf))).toEqual(
      sortedPairs(bad.map((row) => [row.reason, row.reasonSub] as const)),
    );

    const detailFrom = kit.lines.length;
    const details: Schema<'OrderDetail'>[] = [];
    for (const row of [valid, ...bad]) details.push(await m.get(row.orderId));
    const detailAlerts = alertsFrom(detailFrom);
    expect(details[0]).toHaveProperty('reason_sub', 'VIOLATION_PROMO');
    expect(details[1]).not.toHaveProperty('reason_sub');
    expect(details[2]).not.toHaveProperty('reason_sub');
    expect(sortedPairs(detailAlerts.map(pairOf))).toEqual(
      sortedPairs(bad.map((row) => [row.reason, row.reasonSub] as const)),
    );

    const secrets = secretsOf(
      m,
      [valid, ...bad],
      [...page.items.map((item) => item.order_no), ...details.map((detail) => detail.order_no)],
    );
    for (const line of [...listAlerts, ...detailAlerts]) expectPrivateWarn(line, secrets);
  },
  TIMEOUT,
);
