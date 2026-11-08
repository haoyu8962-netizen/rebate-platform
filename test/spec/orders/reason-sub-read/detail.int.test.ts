// B1-09y · 用户侧订单详情（GET /v1/orders/{order_id} 背后的共享查询）回填 reason_sub（D10-850 ②；契约
// CT-24zx OrderDetail.reason_sub 可选可空；08 BR-TEXT-05「子原因 reason_sub」）。规则同列表：合法值回填，
// null / 父编码无子原因时不输出键，不属于父编码或不在枚举内时不输出并 warn 一次；reason、reason_action、
// display_status、金额、时间线与可见性都不因子原因改变。每个用例带合法子原因的对照单，现实现上红在断言。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { at, fixture } from '../list-detail/kit.ts';
import { validate } from '../list-detail/schema-kit.ts';
import {
  BAD_PAIRS,
  OTHER_PARENTS,
  VALID_PAIRS,
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

function strip(detail: Record<string, unknown>) {
  const { order_id, order_no, paid_at, timeline, reason_sub, ...rest } = detail;
  void order_id;
  void order_no;
  void paid_at;
  void reason_sub;
  return { ...rest, nodes: (timeline as { node: string }[]).map((node) => node.node) };
}

it('[AC-B1-09y#9] 详情：15 个合法 (父编码, 子原因) 每单回填 reason_sub，与列表项一致，reason / reason_action 不变，过契约', async () => {
  const f = await fixture(db);
  const log = captureLogger();
  const rows = [];
  for (const pair of VALID_PAIRS) {
    rows.push({ pair, row: await f.seed(voided(pair.reason, pair.reason_sub)) });
  }
  const twins = new Map<string, string>();
  for (const reason of ['PUNISH', 'REFUND', 'RIGHTS'] as const) {
    twins.set(reason, (await f.seed(voided(reason, null))).order_id);
  }
  const q = await loggedQueries(f, log);
  const page = await q.list(f.subject, { scope: 'self', limit: 50 });
  for (const { pair, row } of rows) {
    const detail = await q.get(f.subject, row.order_id);
    expect(detail).not.toBeNull();
    expect(detail).toHaveProperty('reason_sub', pair.reason_sub);
    expect(detail!.reason).toBe(pair.reason);
    expect(itemOf(page.items, row.order_id).reason_sub).toBe(detail!.reason_sub);
    const twin = await q.get(f.subject, twins.get(pair.reason) ?? '');
    expect(twin).not.toBeNull();
    expect(detail!.reason_action).toEqual(twin!.reason_action);
    await validate(
      { code: 0, msg: '', trace_id: randomUUID(), data: detail },
      'OrderDetailResponse',
    );
  }
  expect(log.alerts()).toEqual([]);
}, 30_000);

it('[AC-B1-09y#10] 详情：reason_sub 为 null、父编码无子原因（含 null）时不输出该键；同一 App 的合法单照常带', async () => {
  const f = await fixture(db);
  const log = captureLogger();
  const control = await f.seed(voided('PUNISH', 'OVER_LIMIT'));
  const quiet = [
    await f.seed(voided('PUNISH', null)),
    await f.seed(voided('REFUND', null)),
    await f.seed(voided('RIGHTS', null)),
    await f.seed({ reason: null, reason_sub: null }),
    await f.seed({ reason: null, reason_sub: 'AFTER_SALE' }),
  ];
  for (const [index, reason] of OTHER_PARENTS.entries()) {
    quiet.push(await f.seed(voided(reason, index % 2 === 0 ? 'FAKE_TRADE' : 'IN_SALE')));
  }
  const q = await loggedQueries(f, log);
  expect(await q.get(f.subject, control.order_id)).toHaveProperty('reason_sub', 'OVER_LIMIT');
  for (const row of quiet) {
    const detail = await q.get(f.subject, row.order_id);
    expect(detail).not.toBeNull();
    expect(detail).not.toHaveProperty('reason_sub');
    expect(Object.keys(detail!)).not.toContain('reason_sub');
    expect(detail!.reason).toBe(row.reason);
    await validate(
      { code: 0, msg: '', trace_id: randomUUID(), data: detail },
      'OrderDetailResponse',
    );
  }
}, 30_000);

it('[AC-B1-09y#11] 详情：值不属于当前父编码或不在枚举内时不输出，每次详情读 warn 恰一次（alert 码 + 父编码 / 子原因编码），不带订单号 / 用户 / 金额', async () => {
  const f = await fixture(db);
  const log = captureLogger();
  const control = await f.seed(voided('RIGHTS', 'AFTER_SALE'));
  const bad = [];
  for (const pair of BAD_PAIRS) {
    bad.push({ pair, row: await f.seed(voided(pair.reason, pair.reason_sub)) });
  }
  const q = await loggedQueries(f, log);
  expect(await q.get(f.subject, control.order_id)).toHaveProperty('reason_sub', 'AFTER_SALE');
  expect(log.alerts()).toEqual([]);
  for (const { pair, row } of bad) {
    const label = `${pair.reason}/${pair.reason_sub}`;
    const before = log.alerts().length;
    const detail = await q.get(f.subject, row.order_id);
    expect(detail, label).not.toBeNull();
    expect(detail, label).not.toHaveProperty('reason_sub');
    expect(detail!.reason).toBe(pair.reason);
    expect(log.alerts().length - before, label).toBe(1);
    expect(alertsFor(log, pair.reason, pair.reason_sub), label).toHaveLength(1);
  }
  expect(log.alerts()).toHaveLength(BAD_PAIRS.length);
  expectAlertsPrivate(log, [control, ...bad.map(({ row }) => row)]);
}, 30_000);

it('[AC-B1-09y#12] 详情只回填：其余字段（金额、display_status、reason_action、时间线节点）与 reason_sub=null 的孪生单相同', async () => {
  const f = await fixture(db);
  const log = captureLogger();
  const figures = {
    est_rebate_fen: 260n,
    actual_fen: 260n,
    clawback_fen: 260n,
    b_est: 260n,
    expected_credit_period: '2028-02',
  };
  for (const [reason, sub, status] of [
    ['PUNISH', 'SINGLE_TRADE_ABNORMAL', 'VOID'],
    ['REFUND', 'AFTER_SETTLE', 'CLAWED_BACK'],
    ['RIGHTS', 'AFTER_SALE', 'CLAWED_BACK'],
  ] as const) {
    const patch = {
      rebate_status: status,
      platform_status: status === 'VOID' ? 'INVALID' : 'SETTLED',
      reason,
      quantity: 3,
      received_at: at('2027-12-20T03:00:00.000Z'),
    } as const;
    const withSub = await f.seed({ ...patch, reason_sub: sub }, figures);
    const without = await f.seed({ ...patch, reason_sub: null }, figures);
    const q = await loggedQueries(f, log);
    const a = await q.get(f.subject, withSub.order_id);
    const b = await q.get(f.subject, without.order_id);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).toHaveProperty('reason_sub', sub);
    expect(b).not.toHaveProperty('reason_sub');
    expect(strip(a as Record<string, unknown>)).toEqual(strip(b as Record<string, unknown>));
    expect(a).toMatchObject({ reason, quantity: 3, est_rebate_fen: 260 });
  }
  expect(log.alerts()).toEqual([]);
}, 30_000);

it('[AC-B1-09y#13] 详情可见性不变：他人、别的 App、未归因、超出可查月份的单带子原因也是 null；本人可见单照常回填', async () => {
  const f = await fixture(db);
  const log = captureLogger();
  f.settings.set('order.user_query_months', 12);
  const otherUser = await f.user();
  const otherAppUser = await f.user('foreign-app');
  const mine = await f.seed(voided('REFUND', 'AFTER_SETTLE'));
  const hidden = [
    await f.seed({ ...voided('PUNISH', 'FAKE_TRADE'), user_id: otherUser }),
    await f.seed({ ...voided('PUNISH', 'SHOP_TK'), app_id: 'foreign-app', user_id: otherAppUser }),
    await f.seed({ reason: 'RIGHTS', reason_sub: 'AFTER_SALE', rebate_status: 'UNATTRIBUTED' }),
    await f.seed({ ...voided('REFUND', 'IN_SALE'), paid_at: at('2026-12-31T15:59:59.999Z') }),
  ];
  const q = await loggedQueries(f, log);
  expect(await q.get(f.subject, mine.order_id)).toHaveProperty('reason_sub', 'AFTER_SETTLE');
  for (const row of hidden) expect(await q.get(f.subject, row.order_id)).toBeNull();
  expect(log.alerts()).toEqual([]);
}, 30_000);
