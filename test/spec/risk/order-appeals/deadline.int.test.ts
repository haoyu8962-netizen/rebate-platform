// B1-03zl (BR-ID-36「处理时限：自提交时刻起第 3 个工作日 24:00（+08:00）前必须结案（提交当日不计，按
// 国家法定工作日历含调休，同 BR-ID-27）」; 编排 D10-1192 ①): an order appeal stores deadline_at by the
// same working-day calendar as an account appeal (calendar.cn_holidays / cn_makeup_workdays of the
// app; an unconfigured year counts weekends only), never "submission + 24 hours". The expected
// instants are the ones the account-appeal calendar tests pin (test/spec/risk/appeals/calendar.test.ts,
// service.int.test.ts [AC-B1-03i#28]). Real AppModule over HTTP; the clock is set before the member
// is created (fresh session and signature at that instant), in increasing order across the file.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  accepted,
  appeals,
  member,
  openHttp,
  orderAppeals,
  submitAccount,
  submitOrder,
  type Fixture,
  type Member,
} from './kit.ts';

let f: Fixture;
beforeAll(async () => {
  f = await openHttp();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

const HOUR_MS = 3600_000;

/** The working-day calendar of `year` for the member's app (the configuration the deadline reads). */
async function calendar(
  m: Member,
  year: number,
  holidays: readonly string[],
  makeupWorkdays: readonly string[],
): Promise<void> {
  const at = f.clock.now();
  await f.db
    .withSchema('app')
    .insertInto('config_items')
    .values([
      {
        app_id: m.appId,
        key: `calendar.cn_holidays.${year}`,
        value: JSON.stringify(holidays),
        updated_by: 'b1-03zl-fixture',
        created_at: at,
        updated_at: at,
      },
      {
        app_id: m.appId,
        key: `calendar.cn_makeup_workdays.${year}`,
        value: JSON.stringify(makeupWorkdays),
        updated_by: 'b1-03zl-fixture',
        created_at: at,
        updated_at: at,
      },
    ])
    .execute();
}

/** Submits an order appeal on a fresh risk-voided order at the clock; returns the stored row. */
async function submitAt(m: Member) {
  const orderId = await m.voided();
  const data = await accepted(await submitOrder(m, orderId));
  expect(data).toMatchObject({ target_type: 'order', target_id: orderId, status: 'processing' });
  const rows = await orderAppeals(f, m.appId, orderId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.created_at.getTime()).toBe(f.clock.now().getTime());
  return rows[0]!;
}

// Weekends only (no calendar configured for the app). Listed in increasing submission order.
for (const { label, at, deadline } of [
  {
    label: '周日 23:59:59.999（+08:00）提交：周一、二、三 → 周三 24:00',
    at: '2026-11-01T15:59:59.999Z',
    deadline: '2026-11-04T16:00:00.000Z',
  },
  {
    label: '周一 00:00（+08:00）提交：提交当日（按 +08:00 日期）不计 → 周四 24:00',
    at: '2026-11-01T16:00:00.000Z',
    deadline: '2026-11-05T16:00:00.000Z',
  },
  {
    label: '周一 15:00（+08:00）提交 → 周四 24:00（2026-11-05 +08:00），不是提交时刻 + 24 小时',
    at: '2026-11-02T07:00:00.000Z',
    deadline: '2026-11-05T16:00:00.000Z',
  },
  {
    label: '周五 15:00（+08:00）提交跨周末：下周一、二、三 → 周三 24:00',
    at: '2026-11-06T07:00:00.000Z',
    deadline: '2026-11-11T16:00:00.000Z',
  },
] as const) {
  it(`[AC-B1-03zl#18] 订单申诉 deadline_at 按工作日历第 3 个工作日 24:00（+08:00）：${label}`, async () => {
    f.clock.set(at);
    const m = await member(f, 'normal');
    const row = await submitAt(m);
    expect(row.deadline_at.toISOString()).toBe(deadline);
    expect(row.deadline_at.getTime()).not.toBe(Date.parse(at) + 24 * HOUR_MS);
  });
}

it('[AC-B1-03zl#19] 配置节假日与调休（11-17 至 11-20 放假、11-21 周六调休上班）：周一 15:00（+08:00）提交 → 2026-11-24 24:00；同一时刻同一用户的账户申诉截止时间相同', async () => {
  f.clock.set('2026-11-16T07:00:00.000Z');
  const m = await member(f, 'frozen');
  await calendar(m, 2026, ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'], ['2026-11-21']);
  const expected = '2026-11-24T16:00:00.000Z';
  // Weekends only would give 2026-11-19 24:00; the configured calendar must be read.
  const order = await submitAt(m);
  expect(order.deadline_at.toISOString()).toBe(expected);
  // The account appeal at the same instant reads the same calendar (one calendar for both kinds).
  const account = await accepted(await submitAccount(m));
  expect(account).toMatchObject({ target_type: 'account', target_id: m.uid });
  const accountRow = (await appeals(f, m)).find((row) => row.id === account.appeal_id);
  expect(accountRow?.deadline_at.toISOString()).toBe(expected);
});
