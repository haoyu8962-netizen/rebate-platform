// B2-09zl: BR-WDR-08 admin pending_review mapping and AdminDashboardTodo.count.
// Real PostgreSQL and GET /admin/v1/withdrawals via B2-09c's frozen admin-entry fixture.
// The reviewer has withdraw.review only. No dashboard route or worker metric is involved.
// State changes below are fixture writes, not withdrawal commands or financial operations.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import {
  allAudits,
  fixture,
  footprint,
  page,
  seedMember,
  seedWithdrawal,
  suite,
  withAdmin,
  type Fixture,
  type WithdrawalSeed,
  type WithdrawalsAdmin,
} from '../admin-withdrawals/kit.ts';

type CountPending = (db: Kysely<DB>, appId: string) => Promise<number>;

async function counter(): Promise<CountPending> {
  // Assert inside each test: a missing export must be an assertion failure on main,
  // not a module-load failure or a TypeError before the test can run.
  const payout = (await import(
    new URL('../../../../apps/api/src/modules/payout/index.ts', import.meta.url).href
  )) as { countWithdrawReviewPending?: CountPending };
  expect(
    payout.countWithdrawReviewPending,
    'payout index exports the app-scoped counter',
  ).toBeTypeOf('function');
  return payout.countWithdrawReviewPending!;
}

const s = suite();

async function seedStates(f: Fixture, h: WithdrawalsAdmin) {
  const member = await seedMember(f, h);
  const states: readonly WithdrawalSeed[] = [
    { status: 'PENDING_REVIEW', review_mode: 'manual' },
    { status: 'PENDING_REVIEW', blocked_reason: 'NEGATIVE_BALANCE' },
    { status: 'APPROVED', hold_reason: null, review_mode: 'auto' },
    { status: 'APPROVED', hold_reason: 'member_blocked', review_mode: 'manual' },
    { status: 'APPROVED', hold_reason: 'payer_side_after_transfer' },
    { status: 'PAYING' },
    { status: 'PAID_API', review_mode: 'auto' },
    { status: 'PAID_API', review_mode: 'manual' },
    { status: 'PAID_MANUAL' },
    { status: 'REJECTED' },
    { status: 'FAILED' },
  ];
  for (const state of states) await seedWithdrawal(f, h, member, state);
  return member;
}

async function expectCount(
  count: CountPending,
  f: Fixture,
  h: WithdrawalsAdmin,
  expected: number,
): Promise<void> {
  const actual = await count(f.db, f.appId);
  // A small page distinguishes total from the number of returned rows.
  const listed = await page(
    await h.list({ display_status: 'pending_review', page_size: '1' }, h.reviewer),
  );
  expect(actual).toBe(expected);
  expect(listed.total).toBe(expected);
  expect(actual).toBe(listed.total);
  expect(listed.items).toHaveLength(Math.min(1, expected));
}

it('[AC-B2-09zl#1] 各状态混合：待审含受阻单和普通退回 APPROVED，排除转账后异常及其他状态；计数等于列表 total 且只读', async () => {
  const count = await counter();
  const f = fixture(s);
  await withAdmin(f, async (h) => {
    await seedStates(f, h);
    const before = await footprint(f);
    const audits = await allAudits(f);
    // Two PENDING_REVIEW + two APPROVED without payer_side_after_transfer = 4.
    await expectCount(count, f, h, 4);
    expect(await footprint(f)).toEqual(before);
    expect(await allAudits(f)).toEqual(audits);
  });
}, 60_000);

it('[AC-B2-09zl#2] 按 app 隔离：另一应用新增同批状态不改变本应用计数，两应用各自等于本应用列表 total', async () => {
  const count = await counter();
  const a = fixture(s);
  const b = fixture(s);
  await withAdmin(a, async (ha) => {
    await seedStates(a, ha);
    await expectCount(count, a, ha, 4);
    await withAdmin(b, async (hb) => {
      const member = await seedStates(b, hb);
      // Unequal totals also catch accidentally reusing another app's cached count.
      await seedWithdrawal(b, hb, member, { status: 'PENDING_REVIEW' });
      await expectCount(count, a, ha, 4);
      await expectCount(count, b, hb, 5);
    });
  });
}, 60_000);

it('[AC-B2-09zl#3] 新应用无提现数据时为数字 0，等于空列表 total，即使别的应用有待审单', async () => {
  const count = await counter();
  const populated = fixture(s);
  await withAdmin(populated, async (h) => {
    await seedStates(populated, h);
  });
  const empty = fixture(s);
  await withAdmin(empty, async (h) => {
    await expectCount(count, empty, h, 0);
  });
}, 60_000);

it('[AC-B2-09zl#4] 数据变化立即反映：待审改为驳回、APPROVED 改为转账后异常，计数与列表 total 逐次一起下降', async () => {
  const count = await counter();
  const f = fixture(s);
  await withAdmin(f, async (h) => {
    const member = await seedMember(f, h);
    const pending = await seedWithdrawal(f, h, member, { status: 'PENDING_REVIEW' });
    const approved = await seedWithdrawal(f, h, member, { status: 'APPROVED' });
    await expectCount(count, f, h, 2);

    await f.db
      .withSchema('app')
      .updateTable('withdrawals')
      .set({ status: 'REJECTED', reject_reason_code: 'OTHER', updated_at: f.clock.now() })
      .where('app_id', '=', f.appId)
      .where('id', '=', pending.id)
      .execute();
    await expectCount(count, f, h, 1);

    await f.db
      .withSchema('app')
      .updateTable('withdrawals')
      .set({
        hold_reason: 'payer_side_after_transfer',
        hold_at: f.clock.now(),
        updated_at: f.clock.now(),
      })
      .where('app_id', '=', f.appId)
      .where('id', '=', approved.id)
      .execute();
    await expectCount(count, f, h, 0);
  });
}, 60_000);
