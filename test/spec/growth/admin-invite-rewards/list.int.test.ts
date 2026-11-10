// B2-16d §10 #2 · the list (contract adminListInviteRewards): only the console's app, latest
// qualified_at first with one stable order for equal instants, page / page_size (≤ 200, default 20),
// filters invitee_id, inviter_id, status and the +08:00 calendar days of qualified_at (both ends
// inclusive; qualified_from later than qualified_to → 20001 fields [qualified_from, qualified_to]).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { LIST } from './schema.ts';
import {
  VIEW,
  allPages,
  crowd,
  ids,
  latestFirst,
  list,
  member,
  pageOf,
  person,
  rejected,
  reward,
  setup,
  type Seeded,
  type Status,
} from './kit.ts';

const h = useHarness();

it('[AC-B2-16d#11] 只列本 App 的记录：别的 App 的记录（含同一时刻、更晚取得资格的）不出现、不计入 total', async () => {
  const s = await setup(h);
  const other = `b2-16d-other-${randomUUID()}`;
  const mine = [
    await reward(s, { qualifiedAt: '2026-10-20T02:00:00.000Z' }),
    await reward(s, { qualifiedAt: '2026-10-21T02:00:00.000Z', status: 'processed' }),
  ];
  const theirs = [
    await reward(s, { appId: other, qualifiedAt: '2026-10-20T02:00:00.000Z' }),
    await reward(s, { appId: other, qualifiedAt: '2026-10-22T02:00:00.000Z', status: 'expired' }),
  ];
  const admin = await member(s, [VIEW]);
  const page = await pageOf(s, {}, { as: admin });
  expect(page.total).toBe(2);
  expect(ids(page)).toEqual(latestFirst(mine));
  const text = JSON.stringify(page);
  for (const entry of theirs) {
    expect(text).not.toContain(entry.invitee.id);
    expect(text).not.toContain(entry.inviter.id);
  }
  // A filter naming the other app's invitee or inviter finds nothing either.
  const foreign: Record<string, string>[] = [
    { invitee_id: theirs[0]!.invitee.id },
    { inviter_id: theirs[1]!.inviter.id },
  ];
  for (const query of foreign) {
    const filtered = await pageOf(s, query, { as: admin });
    expect(filtered.items).toEqual([]);
    expect(filtered.total).toBe(0);
  }
  // The other app's own console sees only its own records.
  const theirAdmin = await member(s, [VIEW], other);
  expect(ids(await pageOf(s, {}, { as: theirAdmin }))).toEqual(latestFirst(theirs));
});

it('[AC-B2-16d#12] 最新取得资格的在前（与写入先后无关），默认第 1 页、每页 20 条', async () => {
  const s = await setup(h);
  const times = [
    '2026-10-20T02:00:00.000Z',
    '2026-11-01T09:30:00.000Z',
    '2026-10-19T12:30:00.000Z',
    '2026-11-24T23:59:59.999Z',
    '2026-10-20T02:00:00.001Z',
  ];
  const seeded: Seeded[] = [];
  for (const at of times) seeded.push(await reward(s, { qualifiedAt: at }));
  const page = await pageOf(s);
  expect(ids(page)).toEqual(latestFirst(seeded));
  expect(page).toMatchObject({ page: 1, page_size: 20, total: 5 });
});

it('[AC-B2-16d#13] 分页：total 为全部匹配数，各页首尾相接不重不漏；超出末页为空页、total 不变', async () => {
  const s = await setup(h);
  const seeded: Seeded[] = [];
  for (let day = 0; day < 7; day += 1) {
    const at = new Date(Date.UTC(2026, 9, 10 + day, 2, 0, 0));
    seeded.push(await reward(s, { qualifiedAt: at }));
  }
  const expected = latestFirst(seeded);
  const first = await pageOf(s, { page: '1', page_size: '3' });
  expect(first).toMatchObject({ page: 1, page_size: 3, total: 7 });
  expect(ids(first)).toEqual(expected.slice(0, 3));
  const second = await pageOf(s, { page: '2', page_size: '3' });
  expect(ids(second)).toEqual(expected.slice(3, 6));
  const third = await pageOf(s, { page: '3', page_size: '3' });
  expect(ids(third)).toEqual(expected.slice(6));
  const beyond = await pageOf(s, { page: '4', page_size: '3' });
  expect(beyond).toMatchObject({ items: [], page: 4, page_size: 3, total: 7 });
  const all = await pageOf(s, { page_size: '200' });
  expect(ids(all)).toEqual(expected);
  expect(all.page_size).toBe(200);
});

it('[AC-B2-16d#14] 同一时刻取得资格的记录次序确定：分页切分不重不漏，重复请求次序不变', async () => {
  const s = await setup(h);
  const same = await crowd(s, 7, '2026-10-20T02:00:00.000Z');
  const later = await reward(s, { qualifiedAt: '2026-10-21T02:00:00.000Z' });
  const earlier = await reward(s, { qualifiedAt: '2026-10-19T02:00:00.000Z' });
  const whole = await allPages(s, {}, 200);
  expect(whole.total).toBe(9);
  expect(whole.all[0]).toBe(later.invitee.id);
  expect(whole.all[8]).toBe(earlier.invitee.id);
  expect([...whole.all.slice(1, 8)].sort()).toEqual(same.map((e) => e.invitee.id).sort());
  for (const size of [2, 3, 4]) {
    const paged = await allPages(s, {}, size);
    expect(paged.all, `page_size ${size}`).toEqual(whole.all);
  }
  expect((await allPages(s, {}, 200)).all).toEqual(whole.all);
});

it.each<{ query: Record<string, string>; fields: string[] }>([
  { query: { page_size: '201' }, fields: ['page_size'] },
  { query: { page_size: '0' }, fields: ['page_size'] },
  { query: { page: '0' }, fields: ['page'] },
  { query: { status: 'budget_exhausted' }, fields: ['status'] },
  { query: { qualified_from: '2026/10/20' }, fields: ['qualified_from'] },
  { query: { qualified_to: '20261020' }, fields: ['qualified_to'] },
  { query: { invitee_id: 'a'.repeat(65) }, fields: ['invitee_id'] },
])(
  '[AC-B2-16d#15] 参数不合契约（$query）→ 400 / 20001，data.fields=$fields',
  async ({ query, fields }) => {
    const s = await setup(h);
    await reward(s);
    await rejected(LIST, await list(s, query), 20001, { fields });
  },
);

it('[AC-B2-16d#16] 按受邀人筛选：只有该受邀人的那一条；没有记录的受邀人为空页（不是 30701）', async () => {
  const s = await setup(h);
  const inviter = await person(s);
  const target = await reward(s, { inviter, status: 'processed' });
  await reward(s, { inviter });
  await reward(s);
  const page = await pageOf(s, { invitee_id: target.invitee.id });
  expect(ids(page)).toEqual([target.invitee.id]);
  expect(page.total).toBe(1);
  // The inviter has no record as an invitee.
  for (const id of [inviter.id, randomUUID()]) {
    const empty = await pageOf(s, { invitee_id: id });
    expect(empty).toMatchObject({ items: [], total: 0 });
  }
});

it('[AC-B2-16d#17] 按邀请人筛选：只列该邀请人的记录，按取得资格时刻倒序', async () => {
  const s = await setup(h);
  const inviter = await person(s);
  const own = [
    await reward(s, { inviter, qualifiedAt: '2026-10-20T02:00:00.000Z' }),
    await reward(s, { inviter, qualifiedAt: '2026-10-25T02:00:00.000Z', status: 'voided' }),
    await reward(s, { inviter, qualifiedAt: '2026-10-22T02:00:00.000Z', status: 'processed' }),
  ];
  // Another inviter, and a record whose invitee is this inviter (it is not this inviter's record).
  await reward(s, { qualifiedAt: '2026-10-23T02:00:00.000Z' });
  await reward(s, { invitee: inviter, qualifiedAt: '2026-10-24T02:00:00.000Z' });
  const page = await pageOf(s, { inviter_id: inviter.id });
  expect(ids(page)).toEqual(latestFirst(own));
  expect(page.total).toBe(3);
  expect(await pageOf(s, { inviter_id: randomUUID() })).toMatchObject({ items: [], total: 0 });
});

it('[AC-B2-16d#18] 按状态筛选：五个状态各只列本状态的记录；筛选可与邀请人、分页叠加', async () => {
  const s = await setup(h);
  const inviter = await person(s);
  const statuses: Status[] = ['qualified', 'deferred', 'processed', 'voided', 'expired'];
  const byStatus = new Map<Status, Seeded[]>();
  let hour = 0;
  for (const status of statuses) {
    const entries: Seeded[] = [];
    for (let i = 0; i < 2; i += 1) {
      hour += 1;
      const at = new Date(Date.UTC(2026, 9, 20, hour, 0, 0));
      entries.push(await reward(s, { status, qualifiedAt: at, ...(i === 0 ? { inviter } : {}) }));
    }
    byStatus.set(status, entries);
  }
  for (const status of statuses) {
    const page = await pageOf(s, { status });
    expect(ids(page), status).toEqual(latestFirst(byStatus.get(status)!));
    expect(
      page.items.every((item) => item.status === status),
      status,
    ).toBe(true);
    expect(page.total, status).toBe(2);
  }
  const combined = await pageOf(s, { status: 'processed', inviter_id: inviter.id });
  expect(ids(combined)).toEqual([byStatus.get('processed')![0]!.invitee.id]);
  const second = await pageOf(s, { status: 'voided', page: '2', page_size: '1' });
  expect(ids(second)).toEqual(latestFirst(byStatus.get('voided')!).slice(1));
  expect(second.total).toBe(2);
});

it('[AC-B2-16d#19] 资格日按 +08:00 日历日含两端：当日 00:00 与 23:59:59.999 都算入，前一日 16:00Z 之前与次日 00:00 不算', async () => {
  const s = await setup(h);
  const before = await reward(s, { qualifiedAt: '2026-10-19T15:59:59.999Z' }); // 10-19 23:59:59.999
  const start = await reward(s, { qualifiedAt: '2026-10-19T16:00:00.000Z' }); // 10-20 00:00
  const middle = await reward(s, { qualifiedAt: '2026-10-20T04:00:00.000Z' }); // 10-20 12:00
  const end = await reward(s, { qualifiedAt: '2026-10-20T15:59:59.999Z' }); // 10-20 23:59:59.999
  const after = await reward(s, { qualifiedAt: '2026-10-20T16:00:00.000Z' }); // 10-21 00:00
  const day = await pageOf(s, { qualified_from: '2026-10-20', qualified_to: '2026-10-20' });
  expect(ids(day)).toEqual(latestFirst([start, middle, end]));
  expect(day.total).toBe(3);
  const from = await pageOf(s, { qualified_from: '2026-10-20' });
  expect(ids(from)).toEqual(latestFirst([start, middle, end, after]));
  const to = await pageOf(s, { qualified_to: '2026-10-20' });
  expect(ids(to)).toEqual(latestFirst([before, start, middle, end]));
  const span = await pageOf(s, { qualified_from: '2026-10-19', qualified_to: '2026-10-21' });
  expect(ids(span)).toEqual(latestFirst([before, start, middle, end, after]));
  const none = await pageOf(s, { qualified_from: '2026-10-22', qualified_to: '2026-10-30' });
  expect(none).toMatchObject({ items: [], total: 0 });
  // Combined with the other filters.
  const combined = await pageOf(s, {
    qualified_from: '2026-10-20',
    qualified_to: '2026-10-20',
    inviter_id: middle.inviter.id,
  });
  expect(ids(combined)).toEqual([middle.invitee.id]);
});

it('[AC-B2-16d#20] qualified_from 晚于 qualified_to → 400 / 20001，data.fields=[qualified_from, qualified_to]；相等不算', async () => {
  const s = await setup(h);
  const seeded = await reward(s, { qualifiedAt: '2026-10-20T04:00:00.000Z' });
  const response = await list(s, { qualified_from: '2026-10-21', qualified_to: '2026-10-20' });
  await rejected(LIST, response, 20001, { fields: ['qualified_from', 'qualified_to'] });
  expect(JSON.stringify(response.json())).not.toContain(seeded.invitee.id);
  const same = await pageOf(s, { qualified_from: '2026-10-20', qualified_to: '2026-10-20' });
  expect(ids(same)).toEqual([seeded.invitee.id]);
});
