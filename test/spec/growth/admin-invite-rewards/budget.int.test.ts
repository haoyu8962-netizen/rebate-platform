// B2-16d §10 #4 · the used budget on the list (contract AdminInviteRewardBudget; 08 BR-INV-24 ④):
// today = the current +08:00 day of the injected clock and its invite_reward_budgets row's
// granted_fen (0 without a row); total = the 'total' row's reserved_fen and granted_fen (0 without a
// row); only the console's app; the same whatever the filters and the page, an empty page included.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { VIEW, budget, member, pageOf, reward, setup } from './kit.ts';

const h = useHarness();

it('[AC-B2-16d#26] 没有预算行时：today 为当日（+08:00）、granted_fen 0；total 两项都是 0', async () => {
  const s = await setup(h, '2026-11-25T02:00:00.000Z');
  // Rows of other days only: they do not count for today.
  await budget(s, '2026-11-24', { granted: 4000n });
  await budget(s, '2026-11-26', { granted: 2000n });
  const page = await pageOf(s);
  expect(page.budget).toEqual({
    today: { date: '2026-11-25', granted_fen: 0 },
    total: { reserved_fen: 0, granted_fen: 0 },
  });
});

it('[AC-B2-16d#27] today 取 +08:00 当日行、total 取 total 行，金额按分原样（超过 int32 也不截断）', async () => {
  const s = await setup(h, '2026-11-25T02:00:00.000Z');
  await budget(s, 'total', { reserved: 6000n, granted: 9_000_000_000n });
  await budget(s, '2026-11-25', { granted: 3000n });
  await budget(s, '2026-11-24', { granted: 7000n });
  const page = await pageOf(s);
  expect(page.budget).toEqual({
    today: { date: '2026-11-25', granted_fen: 3000 },
    total: { reserved_fen: 6000, granted_fen: 9_000_000_000 },
  });
});

it.each([
  { at: '2026-11-24T15:59:59.999Z', date: '2026-11-24', granted: 7000 },
  { at: '2026-11-24T16:00:00.000Z', date: '2026-11-25', granted: 3000 },
])(
  '[AC-B2-16d#28] 当日按 +08:00 自然日：时钟 $at 时 today.date=$date',
  async ({ at, date, granted }) => {
    const s = await setup(h, at);
    await budget(s, '2026-11-25', { granted: 3000n });
    await budget(s, '2026-11-24', { granted: 7000n });
    await budget(s, 'total', { reserved: 2000n, granted: 10000n });
    const page = await pageOf(s);
    expect(page.budget.today).toEqual({ date, granted_fen: granted });
  },
);

it('[AC-B2-16d#29] 预算只计本 App：别的 App 的当日行与 total 行不计入', async () => {
  const s = await setup(h, '2026-11-25T02:00:00.000Z');
  const other = `b2-16d-other-${randomUUID()}`;
  await budget(s, 'total', { reserved: 50_000n, granted: 70_000n }, other);
  await budget(s, '2026-11-25', { granted: 9000n }, other);
  await budget(s, 'total', { reserved: 2000n, granted: 1000n });
  await budget(s, '2026-11-25', { granted: 1000n });
  const admin = await member(s, [VIEW]);
  expect((await pageOf(s, {}, { as: admin })).budget).toEqual({
    today: { date: '2026-11-25', granted_fen: 1000 },
    total: { reserved_fen: 2000, granted_fen: 1000 },
  });
  const theirAdmin = await member(s, [VIEW], other);
  expect((await pageOf(s, {}, { as: theirAdmin })).budget).toEqual({
    today: { date: '2026-11-25', granted_fen: 9000 },
    total: { reserved_fen: 50_000, granted_fen: 70_000 },
  });
});

it('[AC-B2-16d#30] 预算不受任何筛选与分页影响：按受邀人、邀请人、状态、资格日筛选或空页时都一样', async () => {
  const s = await setup(h, '2026-11-25T02:00:00.000Z');
  const seeded = await reward(s, { status: 'processed', qualifiedAt: '2026-10-20T02:00:00.000Z' });
  await reward(s, { status: 'qualified', qualifiedAt: '2026-10-21T02:00:00.000Z' });
  await budget(s, 'total', { reserved: 2000n, granted: 2000n });
  await budget(s, '2026-11-25', { granted: 2000n });
  const expected = {
    today: { date: '2026-11-25', granted_fen: 2000 },
    total: { reserved_fen: 2000, granted_fen: 2000 },
  };
  const queries: Record<string, string>[] = [
    {},
    { invitee_id: seeded.invitee.id },
    { invitee_id: randomUUID() },
    { inviter_id: seeded.inviter.id },
    { status: 'expired' },
    { status: 'qualified' },
    { qualified_from: '2026-10-21', qualified_to: '2026-10-21' },
    { qualified_from: '2027-01-01' },
    { page: '9', page_size: '1' },
  ];
  for (const query of queries) {
    expect((await pageOf(s, query)).budget, JSON.stringify(query)).toEqual(expected);
  }
});
