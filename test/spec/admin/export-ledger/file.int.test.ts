// CT-24zzm · 余额流水导出的文件（规划/08 BR-ID-42、BR-FUND-16；04 §11.1；契约 adminCreateExport /
// adminListLedgerEntries；D10-1742：导出列 = 列表 items 字段逐个，金额只用整数分、用户视角带符号，
// 没有一列属于 pii，所以有无 pii.* 内容相同）。文件出自真实 worker 入口；对照是同一 admin 入口、同一
// 创建人、同一筛选的 GET /admin/v1/ledger，另有几处手写的期望值，免得两边同错。
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ok, text, type View } from '../exports/kit.ts';
import {
  AT_1,
  AT_4,
  books,
  colleague,
  COLUMN,
  DAY_MS,
  EARLY,
  EXPORT,
  expectSameAsList,
  exported,
  fileOf,
  harness,
  INTERNAL_TEXT,
  LAST_SECOND,
  type LedgerFile,
  ledgerBody,
  LOOKUP,
  MIDNIGHT,
  openConsole,
  PII_POINTS,
  type Posted,
  rowsOf,
  seedStory,
  setMaxRows,
  VIEW,
} from './kit.ts';

/** The voucher ids of a file, top to bottom. */
const vouchersOf = (file: LedgerFile) => file.rows.map((cells) => cells[COLUMN.voucherId]);
/** Newest first: the reverse of posting order (booked_at, then entry_id, both ascending). */
const newestFirst = (posted: readonly Posted[]) => [...posted].reverse().map((v) => v.voucherId);

const h = harness(createTestDatabase, acquireTestRedis);

it('[AC-CT-24zzm#13] 只给 user_id：文件 = 该用户全部流水，与列表同行同序同值，邻居的分录不进文件', async () => {
  const f = await openConsole(h, [EXPORT, VIEW]);
  const story = await seedStory(books(h, f.appId));
  const filters = { user_id: story.a.userId };
  const { view, row } = await exported(f, filters);
  expect(row).toMatchObject({ status: 'done', row_count: 6, masked: true, resource: 'ledger' });
  expect(row.object_key).toBe(`${f.appId}/${view.id}.csv`);
  expect(row.expires_at!.getTime() - row.generated_at!.getTime()).toBe(DAY_MS);
  const file = await expectSameAsList(f, view.id, filters);
  expect(file.rows).toHaveLength(6);
  // booked_at descending, then entry_id descending (the list's order), checked by hand as well.
  const order = file.rows.map((cells): [number, bigint] => [
    Date.parse(cells[COLUMN.bookedAt]!),
    BigInt(cells[COLUMN.entryId]!),
  ]);
  for (let i = 1; i < order.length; i++) {
    const [at, id] = order[i]!;
    const [prevAt, prevId] = order[i - 1]!;
    expect(prevAt > at || (prevAt === at && prevId > id), JSON.stringify(file.rows)).toBe(true);
  }
  expect(rowsOf(file, story.vb)).toEqual([]);
  expect(text(file)).not.toContain(story.b.userId);
  expect(text(file)).not.toContain(story.vb.uniqKey);
});

it('[AC-CT-24zzm#14] 每列取值：金额是整数分、用户视角带符号（负数不加前缀），可空列写空，凭证号与关联单号照列表', async () => {
  const f = await openConsole(h, [EXPORT, VIEW]);
  const story = await seedStory(books(h, f.appId));
  const { view } = await exported(f, { user_id: story.a.userId });
  const file = await fileOf(f, view.id);
  const [v1] = rowsOf(file, story.v1);
  expect(v1).toBeDefined();
  expect(v1![COLUMN.ledgerType]).toBe('REBATE_CREDIT');
  expect(v1![COLUMN.subType]).toBe('');
  expect(v1![COLUMN.subAccount]).toBe('available');
  expect(v1![COLUMN.amount]).toBe('1000');
  expect(v1![COLUMN.balanceAfter]).toBe('1000');
  expect(v1![COLUMN.accountingDate]).toBe('2026-10-07');
  expect(v1![COLUMN.uniqKey]).toBe(story.v1.uniqKey);
  expect(v1![COLUMN.bizType]).toBe('FIXTURE');
  expect([v1![COLUMN.linkType], v1![COLUMN.linkId]]).toEqual(['', '']);
  // The freeze: one voucher, two user entries, opposite signs in the user's view.
  const freeze = rowsOf(file, story.v3);
  expect(freeze.map((cells) => [cells[COLUMN.subAccount], cells[COLUMN.amount]]).sort()).toEqual(
    [
      ['available', '-500'],
      ['frozen', '500'],
    ].sort(),
  );
  for (const cells of freeze) {
    expect(cells[COLUMN.uniqKey]).toBe(story.v3.uniqKey);
    expect([cells[COLUMN.linkType], cells[COLUMN.linkId]]).toEqual(['withdrawal', story.v3.bizId]);
  }
  const [clawback] = rowsOf(file, story.v5);
  expect(clawback![COLUMN.amount]).toBe('-100');
  expect(clawback![COLUMN.subType]).toBe('FULL');
  expect(clawback![COLUMN.accountingDate]).toBe('2026-10-09');
  const [adjust] = rowsOf(file, story.v4);
  expect(adjust![COLUMN.amount]).toBe('200');
  expect([adjust![COLUMN.linkType], adjust![COLUMN.linkId]]).toEqual([
    'adjustment',
    story.v4.bizId,
  ]);
  for (const cells of file.rows) {
    expect(cells[COLUMN.amount]).toMatch(/^-?[1-9]\d*$/);
    expect(cells[COLUMN.balanceAfter]).toMatch(/^(-?(0|[1-9]\d*))?$/);
    expect(cells[COLUMN.entryId]).toMatch(/^\d+$/);
  }
});

it('[AC-CT-24zzm#15] 不含内部备注：凭证 memo、operator 不进文件', async () => {
  const f = await openConsole(h, [EXPORT, VIEW]);
  const story = await seedStory(books(h, f.appId));
  const { view } = await exported(f, { user_id: story.a.userId });
  const raw = await f.stored(view.id);
  expect(raw).not.toContain(INTERNAL_TEXT);
  expect(rowsOf(await fileOf(f, view.id), story.v4)).toHaveLength(1);
});

it('[AC-CT-24zzm#16] 每个筛选都与列表同义：ledger_type、sub_type、sub_account、会计日起止（含两端）、ref 与组合', async () => {
  const f = await openConsole(h, [EXPORT, VIEW]);
  const story = await seedStory(books(h, f.appId));
  const user_id = story.a.userId;
  const cases: [Record<string, string>, number][] = [
    [{ user_id, ledger_type: 'WITHDRAW_FREEZE' }, 2],
    [{ user_id, sub_type: 'DIRECT' }, 1],
    [{ user_id, sub_account: 'frozen' }, 1],
    [{ user_id, accounting_date_from: '2026-10-08', accounting_date_to: '2026-10-08' }, 3],
    [{ user_id, accounting_date_from: '2026-10-09' }, 2],
    [{ user_id, accounting_date_to: '2026-10-07' }, 1],
    [{ user_id, ref: story.v4.bizId }, 1],
    [{ user_id, ref: story.v3.bizId, sub_account: 'available' }, 1],
    [{ user_id, ledger_type: 'TAX_WITHHOLD' }, 0],
  ];
  for (const [filters, count] of cases) {
    const { view, row } = await exported(f, filters);
    expect(row, JSON.stringify(filters)).toMatchObject({ status: 'done', row_count: count });
    const file = await expectSameAsList(f, view.id, filters);
    expect(file.rows, JSON.stringify(filters)).toHaveLength(count);
  }
});

it('[AC-CT-24zzm#17] 有无 pii.*、凭 fund.view 还是 user.lookup：同一筛选导出的文件逐字节相同，任务都是 masked，无 export_unmasked', async () => {
  const f = await openConsole(h, [EXPORT, VIEW]);
  const story = await seedStory(books(h, f.appId));
  const filters = { user_id: story.a.userId };
  const plain = await exported(f, filters);
  const other = await colleague(h, f, [EXPORT, LOOKUP, ...PII_POINTS]);
  const wide = await exported(f, filters, other.token);
  expect(wide.row).toMatchObject({ status: 'done', masked: true, row_count: 6 });
  expect(wide.row.created_by).toBe(other.who.id);
  expect(await f.stored(wide.view.id)).toBe(await f.stored(plain.view.id));
  await expectSameAsList(f, wide.view.id, filters, other.token);
  expect((await f.audits()).map((audit) => audit.action)).not.toContain('export_unmasked');
});

it('[AC-CT-24zzm#18] 行数上限 admin.export.max_rows 按实际导出的行数：超出则 failed 且不留文件，筛窄后可完成', async () => {
  const f = await openConsole(h, [EXPORT, VIEW]);
  await setMaxRows(h, f.appId, 5);
  const story = await seedStory(books(h, f.appId));
  const all = await exported(f, { user_id: story.a.userId });
  expect(all.row).toMatchObject({ status: 'failed', object_key: null, row_count: null });
  expect(all.row.failure_reason).toContain('5');
  const { store } = await f.entry();
  expect(store.get(`${f.appId}/${all.view.id}.csv`)).toBeUndefined();
  const narrowed = { user_id: story.a.userId, accounting_date_from: '2026-10-08' };
  const some = await exported(f, narrowed);
  expect(some.row).toMatchObject({ status: 'done', row_count: 5 });
  await expectSameAsList(f, some.view.id, narrowed);
});

it('[AC-CT-24zzm#19] 用户不属于本 App 或不存在：不导出任何分录（建时 20001，或任务 failed），外 App 的流水不出现', async () => {
  const f = await openConsole(h, [EXPORT, VIEW]);
  const foreignApp = `x_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const foreign = books(h, foreignApp);
  const stranger = await foreign.member();
  const posted = await foreign.credit(stranger, '2026-10-08T03:00:00.000Z', 900n);
  for (const userId of [stranger.userId, randomUUID()]) {
    const response = await f.create(ledgerBody({ user_id: userId }));
    if (response.statusCode === 400) {
      expect(response.json()).toMatchObject({ code: 20001 });
      continue;
    }
    const view = await ok<View>(response);
    const row = await f.generate(view.id);
    expect(row.status, `user ${userId}`).toBe('failed');
    expect(row.object_key).toBeNull();
  }
  const { store } = await f.entry();
  for (const task of await f.tasks()) {
    expect(store.get(`${f.appId}/${task.public_id}.csv`)).toBeUndefined();
  }
  // A user of the console's app still exports, and nothing of the other app is in it.
  const story = await seedStory(books(h, f.appId));
  const { view } = await exported(f, { user_id: story.a.userId });
  const raw = await f.stored(view.id);
  expect(raw).not.toContain(posted.uniqKey);
  expect(raw).not.toContain(stranger.userId);
});

it('[AC-CT-24zzm#27] 会计日按 00:00 +08:00 日切：23:59:59 记的属当天，00:00 与 07:30 记的属次日（UTC 日期仍是前一天），accounting_date 列与会计日起止都按它', async () => {
  const f = await openConsole(h, [EXPORT, VIEW]);
  const b = books(h, f.appId);
  const a = await b.member();
  // Posted in time order; the UTC date of e2, e3 and e4 is 2026-10-08 alike.
  const e1 = await b.credit(a, AT_1, 1_000n);
  const e2 = await b.credit(a, LAST_SECOND, 300n);
  const e3 = await b.credit(a, MIDNIGHT, 200n);
  const e4 = await b.credit(a, EARLY, 50n);
  const e5 = await b.credit(a, AT_4, 20n);
  const user_id = a.userId;

  const all = await exported(f, { user_id });
  expect(all.row).toMatchObject({ status: 'done', row_count: 5 });
  const file = await expectSameAsList(f, all.view.id, { user_id });
  expect(vouchersOf(file)).toEqual(newestFirst([e1, e2, e3, e4, e5]));
  const expected: [Posted, string, string, string, string][] = [
    [e1, AT_1, '2026-10-07', '1000', '1000'],
    [e2, LAST_SECOND, '2026-10-08', '300', '1300'],
    [e3, MIDNIGHT, '2026-10-09', '200', '1500'],
    [e4, EARLY, '2026-10-09', '50', '1550'],
    [e5, AT_4, '2026-10-09', '20', '1570'],
  ];
  for (const [voucher, at, day, amount, after] of expected) {
    const [cells] = rowsOf(file, voucher);
    expect(cells, `${at} 的分录须在文件里`).toBeDefined();
    expect(Date.parse(cells![COLUMN.bookedAt]!), `${at} 的 booked_at`).toBe(Date.parse(at));
    expect(cells![COLUMN.accountingDate], `${at} 的会计日`).toBe(day);
    expect(cells![COLUMN.amount]).toBe(amount);
    expect(cells![COLUMN.balanceAfter]).toBe(after);
  }

  const cases: [Record<string, string>, Posted[]][] = [
    [{ user_id, accounting_date_from: '2026-10-08', accounting_date_to: '2026-10-08' }, [e2]],
    [{ user_id, accounting_date_to: '2026-10-08' }, [e1, e2]],
    [{ user_id, accounting_date_from: '2026-10-09' }, [e3, e4, e5]],
    [
      { user_id, accounting_date_from: '2026-10-09', accounting_date_to: '2026-10-09' },
      [e3, e4, e5],
    ],
    [{ user_id, accounting_date_to: '2026-10-07' }, [e1]],
    [{ user_id, ref: e3.bizId, accounting_date_to: '2026-10-08' }, []],
    [{ user_id, ref: e4.bizId, accounting_date_from: '2026-10-09' }, [e4]],
  ];
  for (const [filters, vouchers] of cases) {
    const { view, row } = await exported(f, filters);
    expect(row, JSON.stringify(filters)).toMatchObject({
      status: 'done',
      row_count: vouchers.length,
    });
    const narrowed = await expectSameAsList(f, view.id, filters);
    expect(vouchersOf(narrowed), JSON.stringify(filters)).toEqual(newestFirst(vouchers));
  }
});

/** Bursts of PER_INSTANT vouchers, one minute apart from 2026-10-05 23:00 +08:00 on. */
const BURSTS = 150;
const PER_INSTANT = 7;
const two = (n: number) => String(n).padStart(2, '0');
/** The burst g: 15:00Z + g minutes (g < 180, so within 15:00–17:59Z of 2026-10-05). */
const burstAt = (g: number) => `2026-10-05T${two(15 + Math.floor(g / 60))}:${two(g % 60)}:00.000Z`;
/** The first burst at or after 00:00 +08:00 of 2026-10-06 (16:00Z). */
const FIRST_OF_06 = 60;

it('[AC-CT-24zzm#28] 多页：1050 条流水多于数据源任何一页，每 7 张凭证同一时刻（页界落在同一时刻的凭证之间），文件 = 列表逐页拼起来，不重不漏、同序同值；跨日切的会计日筛选同样', async () => {
  const f = await openConsole(h, [EXPORT, VIEW]);
  const b = books(h, f.appId);
  const a = await b.member();
  const posted: Posted[] = [];
  for (let g = 0; g < BURSTS; g++) {
    const fens = Array.from({ length: PER_INSTANT }, (_, i) =>
      BigInt(1 + ((g * PER_INSTANT + i) % 97)),
    );
    posted.push(...(await b.burst(a, burstAt(g), fens)));
  }
  const user_id = a.userId;
  const cut = FIRST_OF_06 * PER_INSTANT;
  const cases: [Record<string, string>, Posted[]][] = [
    [{ user_id }, posted],
    [{ user_id, accounting_date_from: '2026-10-06' }, posted.slice(cut)],
    [{ user_id, accounting_date_to: '2026-10-05' }, posted.slice(0, cut)],
  ];
  const files: LedgerFile[] = [];
  for (const [filters, vouchers] of cases) {
    const { view, row } = await exported(f, filters);
    expect(row, JSON.stringify(filters)).toMatchObject({
      status: 'done',
      row_count: vouchers.length,
    });
    const file = await expectSameAsList(f, view.id, filters);
    // By hand as well: every voucher once, newest first, ties at one instant by entry_id descending.
    expect(vouchersOf(file), JSON.stringify(filters)).toEqual(newestFirst(vouchers));
    expect(new Set(file.rows.map((cells) => cells[COLUMN.entryId])).size).toBe(vouchers.length);
    files.push(file);
  }
  // The first and the last entry of the whole file by hand: amounts 1 + (n mod 97), running sum.
  const full = files[0]!;
  const total = posted.reduce((sum, _, n) => sum + 1 + (n % 97), 0);
  const top = full.rows[0]!;
  expect(Date.parse(top[COLUMN.bookedAt]!)).toBe(Date.parse(burstAt(BURSTS - 1)));
  expect(top[COLUMN.accountingDate]).toBe('2026-10-06');
  expect(top[COLUMN.amount]).toBe(String(1 + ((BURSTS * PER_INSTANT - 1) % 97)));
  expect(top[COLUMN.balanceAfter]).toBe(String(total));
  const bottom = full.rows[full.rows.length - 1]!;
  expect(Date.parse(bottom[COLUMN.bookedAt]!)).toBe(Date.parse(burstAt(0)));
  expect(bottom[COLUMN.accountingDate]).toBe('2026-10-05');
  expect([bottom[COLUMN.amount], bottom[COLUMN.balanceAfter]]).toEqual(['1', '1']);
}, 300_000);
