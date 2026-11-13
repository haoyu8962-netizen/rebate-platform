// B1-03zo / BR-ID-36, D10-1401: appeal_pending = this app's processing list total.
// Real GET /admin/v1/appeals, with only risk.appeal and no step-up. Database/Redis
// come from the existing kit; run only in the isolated runner.
// The exported count is deliberately called in every case: its NotImplemented is
// the red signal, never a missing export or a setup-hook failure.
import { expect, it } from 'vitest';
import { countProcessingAppeals } from '../../../../apps/api/src/modules/risk/index.ts';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  DAY,
  HOUR,
  accountAppeal,
  at,
  blocked,
  blockedAppeal,
  ids,
  member,
  order,
  orderAppeal,
  page,
  setup,
  snapshot,
  type Scenario,
} from '../admin-appeals-read/kit.ts';

const h = useHarness();
type Target = Schema<'AdminAppealTargetType'>;
type Status = Schema<'AppealStatus'>;
const TARGETS: readonly Target[] = ['account', 'order', 'blocked_request'];

/** Valid independent appeal objects; deadline straddles the injected clock. */
async function seed(s: Scenario, target: Target, status: Status, deadline: Date) {
  const patch = { status, created_at: at(-10 * DAY), deadline_at: deadline };
  if (target === 'blocked_request') {
    const request = await blocked(s, {
      request_type: 'register',
      blocked_at: at(-11 * DAY),
    });
    return blockedAppeal(s, request, patch);
  }
  const user = await member(s, {
    state: target === 'account' && status === 'processing' ? 'appealing' : 'normal',
  });
  if (target === 'account') return accountAppeal(s, user, 'frozen', patch);
  return orderAppeal(s, user, await order(s, user), patch);
}

/** Expected cardinality comes from the fixture, not from either production reader. */
async function equalCounts(s: Scenario, expected: number, query: Record<string, string> = {}) {
  const count = await countProcessingAppeals(h.db, s.appId);
  expect(count).toBe(expected);
  const p = await page(await s.list({ ...query, status: 'processing' }));
  expect(p.total).toBe(expected);
  expect(p.counts.processing).toBe(expected);
  expect(count).toBe(p.total);
  expect(count).toBe(p.counts.processing);
  return p;
}

it.each<{ label: string; targets: readonly Target[]; repeats: number }>([
  { label: '仅账户', targets: ['account'], repeats: 1 },
  { label: '仅订单', targets: ['order'], repeats: 1 },
  { label: '仅无账号被拦请求', targets: ['blocked_request'], repeats: 1 },
  { label: '三类混合', targets: TARGETS, repeats: 1 },
  { label: '超过默认一页', targets: TARGETS, repeats: 3 },
])(
  '[AC-B1-03zo#1] $label：逾期、到期时刻、未到期都计入，已结案都排除',
  async ({ targets, repeats }) => {
    const s = await setup(h);
    const pending: string[] = [];
    for (const target of targets) {
      for (let n = 0; n < repeats; n += 1) {
        for (const deadline of [at(-HOUR), at(0), at(HOUR)]) {
          pending.push((await seed(s, target, 'processing', deadline)).id);
        }
      }
    }
    for (const target of TARGETS) {
      for (const status of ['upheld', 'revoked'] as const) {
        await seed(s, target, status, status === 'upheld' ? at(-HOUR) : at(HOUR));
      }
    }
    const p = await equalCounts(s, pending.length);
    expect(p.items).toHaveLength(Math.min(20, pending.length));
    expect(p.counts).toMatchObject({ closed: 6, all: pending.length + 6 });
    const full = await equalCounts(s, pending.length, { page_size: '200' });
    expect(ids(full).sort()).toEqual(pending.sort());
    const beyond = await equalCounts(s, pending.length, { page: '100', page_size: '1' });
    expect(beyond.items).toEqual([]);
  },
);

it('[AC-B1-03zo#2] 同一数据库交替读取两个 App，只计各自的 processing', async () => {
  const mine = await setup(h);
  const other = await setup(h);
  await seed(mine, 'order', 'processing', at(-DAY));
  for (const target of TARGETS) await seed(other, target, 'processing', at(DAY));
  await seed(mine, 'account', 'upheld', at(-DAY));
  expect((await equalCounts(mine, 1)).total).toBe(1);
  expect((await equalCounts(other, 3)).total).toBe(3);
  expect((await equalCounts(mine, 1)).total).toBe(1);
});

it('[AC-B1-03zo#3] 本 App 没有申诉时为数字 0，其他 App 的 processing 不影响', async () => {
  const empty = await setup(h);
  const other = await setup(h);
  await seed(other, 'blocked_request', 'processing', at(-DAY));
  expect(await equalCounts(empty, 0)).toMatchObject({
    items: [],
    counts: { processing: 0, overdue: 0, closed: 0, all: 0 },
  });
});

it('[AC-B1-03zo#4] 本 App 只有已维持、已撤销申诉时也为 0', async () => {
  const s = await setup(h);
  for (const target of TARGETS) {
    await seed(s, target, 'upheld', at(-DAY));
    await seed(s, target, 'revoked', at(DAY));
  }
  expect(await equalCounts(s, 0)).toMatchObject({ items: [], counts: { closed: 6, all: 6 } });
});

it.each(['upheld', 'revoked'] as const)(
  '[AC-B1-03zo#5] processing → %s 每结案一条就少 1，三类对象同口径且重复读取不漂移',
  async (status) => {
    const s = await setup(h);
    const rows = [];
    for (const target of TARGETS) rows.push(await seed(s, target, 'processing', at(-DAY)));
    expect((await equalCounts(s, 3)).total).toBe(3);
    let remaining = rows.length;
    for (const row of rows) {
      // Fixture mutation represents an already committed resolution by risk's writer;
      // this task tests the read port, not resolution side effects in other modules.
      await h.db
        .updateTable('appeals')
        .set({
          status,
          handler_id: s.a.id,
          closed_at: s.f.clock.now(),
          updated_at: s.f.clock.now(),
          row_version: row.row_version + 1,
        })
        .where('app_id', '=', s.appId)
        .where('id', '=', row.id)
        .executeTakeFirstOrThrow();
      remaining -= 1;
      expect((await equalCounts(s, remaining)).total).toBe(remaining);
      expect(await countProcessingAppeals(h.db, s.appId)).toBe(remaining);
    }
  },
);

it('[AC-B1-03zo#6] 按申诉行计数：同一用户多个对象都算，无账号注册与四种被拦请求都算', async () => {
  const s = await setup(h);
  const user = await member(s, { state: 'appealing' });
  await accountAppeal(s, user, 'banned');
  for (let n = 0; n < 2; n += 1) await orderAppeal(s, user, await order(s, user));
  for (const request_type of ['register', 'withdraw', 'phone_change', 'payout_account'] as const) {
    await blockedAppeal(s, await blocked(s, { request_type, user, blocked_at: at(-DAY) }));
  }
  expect((await equalCounts(s, 7)).items).toHaveLength(7);
});

it('[AC-B1-03zo#7] 模块入口导出的计数可在 PG 只读事务内重复调用，申诉、状态、命中、订单与审计不变', async () => {
  const s = await setup(h);
  for (const target of TARGETS) await seed(s, target, 'processing', at(-DAY));
  const before = await snapshot(s);
  await h.db
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      expect(await countProcessingAppeals(trx, s.appId)).toBe(3);
      expect(await countProcessingAppeals(trx, s.appId)).toBe(3);
    });
  expect(await snapshot(s)).toEqual(before);
  expect((await equalCounts(s, 3)).total).toBe(3);
});

it('[AC-B1-03zo#8] 越过 deadline 后只增加 overdue，卡片计数与 processing 总数不变', async () => {
  const s = await setup(h);
  await seed(s, 'blocked_request', 'processing', at(60_000));
  expect((await equalCounts(s, 1)).counts.overdue).toBe(0);
  s.f.clock.advanceMs(60_001);
  expect((await equalCounts(s, 1)).counts.overdue).toBe(1);
});
