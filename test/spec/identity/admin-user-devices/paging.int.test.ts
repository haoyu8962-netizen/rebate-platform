// B1-02zz §9 #5 · order and pages (contract adminListUserDevices; 04 §5 后台分页): last_seen_at
// descending (then the server's internal order, which is pinned only as one stable partition into
// pages), page / page_size ≤ 200, one row and one count per device however many sessions it has.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  REVOKED,
  fleet,
  ids,
  instant,
  list,
  minutesAgo,
  normal,
  owned,
  pageOf,
  rejected,
  row,
  sessionOn,
  setup,
  user,
  type Page,
  type SeededDevice,
  type Setup,
  type Target,
} from './kit.ts';

const h = useHarness();

const MINUTES_SEEN = [30, 5, 50, 20, 40];
const DAYS_REGISTERED = [3, 4, 1, 5, 2];

/**
 * Five devices whose last_seen_at order is not their insertion, created_at or session order, in
 * either direction; returns their rows most recently seen first.
 */
async function shuffled(s: Setup, target: Target) {
  const seeded: SeededDevice[] = [];
  for (const [index, minutes] of MINUTES_SEEN.entries()) {
    s.clock.advanceMs(1000);
    seeded.push(
      await owned(s, target, {
        lastSeenAt: minutesAgo(s, minutes),
        createdAt: minutesAgo(s, DAYS_REGISTERED[index]! * 1440),
      }),
    );
  }
  return seeded
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
    .map((entry) => row(entry));
}

it('[AC-B1-02zz#18] last_seen_at 降序，不是入库、注册或会话的先后；默认 page=1、page_size=20，total 为总数', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const expected = await shuffled(s, target);
  const page = await pageOf(s, target);
  expect(page.items.map(normal)).toEqual(expected);
  expect(page).toMatchObject({ page: 1, page_size: 20, total: 5 });
});

it('[AC-B1-02zz#19] 页码分页：排序跨页，各页衔接不重不漏，total 不随页变化', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const expected = await shuffled(s, target);
  const pages = [];
  for (const page of [1, 2, 3]) {
    const data = await pageOf(s, target, {
      query: { page: String(page), page_size: '2' },
    });
    expect(data).toMatchObject({ page, page_size: 2, total: 5 });
    pages.push(data.items.map(normal));
  }
  expect(pages).toEqual([expected.slice(0, 2), expected.slice(2, 4), expected.slice(4)]);
});

it('[AC-B1-02zz#20] 同一 last_seen_at 的设备：顺序由服务端定，但各页不重不漏，重复读结果不变', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const same = minutesAgo(s, 10);
  const seeded = [
    await owned(s, target, { lastSeenAt: same }),
    await owned(s, target, { lastSeenAt: minutesAgo(s, 20) }),
    await owned(s, target, { lastSeenAt: same }),
    await owned(s, target, { lastSeenAt: same }),
    await owned(s, target, { lastSeenAt: minutesAgo(s, 5) }),
    await owned(s, target, { lastSeenAt: same }),
    await owned(s, target, { lastSeenAt: same }),
  ];
  const read = async () => {
    const pages: Page[] = [];
    for (const page of ['1', '2', '3', '4']) {
      pages.push(await pageOf(s, target, { query: { page, page_size: '2' } }));
    }
    return pages.flatMap((page) => page.items);
  };
  const first = await read();
  expect(first.map((item) => item.device_id).sort()).toEqual(
    seeded.map((entry) => entry.id).sort(),
  );
  const seen = first.map((item) => instant(item.last_seen_at));
  expect(seen).toEqual([...seen].sort((a, b) => b - a));
  expect(await read()).toEqual(first);
});

it('[AC-B1-02zz#21] 同一设备多条会话只算一行：total 是设备数，分页按设备，别的账号的会话也不加行', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const someone = await user(h, s.appId);
  const busy = await owned(s, target, { lastSeenAt: minutesAgo(s, 1) });
  await sessionOn(s, target, busy, REVOKED);
  await sessionOn(s, target, busy, REVOKED);
  await sessionOn(s, someone, busy);
  const quiet = await owned(s, target, { lastSeenAt: minutesAgo(s, 2) }, REVOKED);
  await sessionOn(s, target, quiet);

  const whole = await pageOf(s, target);
  expect(whole.items.map(normal)).toEqual([row(busy), row(quiet)]);
  expect(whole.total).toBe(2);

  const expected = [[busy.id], [quiet.id], []];
  for (const [index, want] of expected.entries()) {
    const page = index + 1;
    const data = await pageOf(s, target, { query: { page: String(page), page_size: '1' } });
    expect(ids(data), `page ${page}`).toEqual(want);
    expect(data).toMatchObject({ page, page_size: 1, total: 2 });
  }
});

it('[AC-B1-02zz#22] 默认每页 20；page_size=200 是合法上限，真的取 200 条，不被压到更小', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const seeded = await fleet(s, target, 201);
  const byDefault = await pageOf(s, target);
  expect(byDefault.items).toHaveLength(20);
  expect(byDefault).toMatchObject({ page: 1, page_size: 20, total: 201 });
  const wide = await pageOf(s, target, { query: { page_size: '200' } });
  expect(wide.items).toHaveLength(200);
  expect(wide).toMatchObject({ page: 1, page_size: 200, total: 201 });
  const rest = await pageOf(s, target, { query: { page: '2', page_size: '200' } });
  expect(rest.items).toHaveLength(1);
  expect(rest).toMatchObject({ page: 2, page_size: 200, total: 201 });
  expect([...ids(wide), ...ids(rest)].sort()).toEqual(seeded.map((entry) => entry.id).sort());
});

const INVALID: readonly { query: Record<string, string>; fields: string[] }[] = [
  { query: { page_size: '201' }, fields: ['page_size'] },
  { query: { page_size: '0' }, fields: ['page_size'] },
  { query: { page_size: '-1' }, fields: ['page_size'] },
  { query: { page_size: '1.5' }, fields: ['page_size'] },
  { query: { page_size: 'all' }, fields: ['page_size'] },
  { query: { page: '0' }, fields: ['page'] },
  { query: { page: '-1' }, fields: ['page'] },
  { query: { page: '1.5' }, fields: ['page'] },
  { query: { page: 'next' }, fields: ['page'] },
];

it.each(INVALID)(
  '[AC-B1-02zz#23] 分页参数不合格 $query → 20001 data.fields=$fields',
  async ({ query, fields }) => {
    const s = await setup(h);
    const target = await user(h, s.appId);
    await owned(s, target);
    await rejected(await list(s, target.id, { query }), 20001, { fields });
  },
);

it('[AC-B1-02zz#24] 页码超过末页：200 空列表，total 不变；页码取到 int32 上限也不是 5XX', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await owned(s, target);
  await owned(s, target);
  const past = await pageOf(s, target, { query: { page: '3', page_size: '2' } });
  expect(past).toEqual({ items: [], page: 3, page_size: 2, total: 2 });
  const far = await pageOf(s, target, { query: { page: '2147483647', page_size: '200' } });
  expect(far).toEqual({ items: [], page: 2147483647, page_size: 200, total: 2 });
});
