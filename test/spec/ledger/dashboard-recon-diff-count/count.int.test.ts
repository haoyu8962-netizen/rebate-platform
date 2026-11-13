// B2-02w rule tests (claude-independent, SPEC_REF 62b5c993): the dashboard card recon_diff_open's
// per-app count, a read-only export of the ledger (contracts/openapi.yaml adminGetDashboard,
// AdminDashboardTodo.count "equal to the pending count of the card's list page"; the card's route
// filters status=open; 编排 D10-1401). The count equals the total of listAdminReconDiffs
// (GET /admin/v1/recon-diffs?status=open as fund.recon, the card's point) of the same app — one
// judgement, no rule of its own: only source R1–R3 (R4 stays with payment's pay-recon-diffs), only
// status open (processing, adjusted, written_off and closed never count), never another app's rows
// (08 BR-FUND-22 差错单). No dashboard route is involved.
// Real pieces: the admin entry and PostgreSQL through ../admin-recon-diffs/kit.ts. Synthetic: the
// recon_diffs rows written directly and their status changes (fixture writes, not console actions);
// no real user or merchant data. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Insertable, Kysely } from 'kysely';
import { expect, it } from 'vitest';
import {
  ago,
  allAudits,
  allDiffs,
  fixture,
  page,
  seedDiff,
  suite,
  withReconAdmin,
  type DiffRow,
  type DiffSeed,
  type Fixture,
  type ReconAdmin,
} from '../admin-recon-diffs/kit.ts';

type CountOpen = (db: Kysely<DB>, appId: string) => Promise<number>;

async function counter(): Promise<CountOpen> {
  // Assert inside each test: a missing export must be an assertion failure on main,
  // not a module-load failure or a TypeError before the test can run.
  const ledger = (await import(
    new URL('../../../../apps/api/src/modules/ledger/index.ts', import.meta.url).href
  )) as { countReconDiffOpen?: CountOpen };
  expect(ledger.countReconDiffOpen, 'ledger exports the counter').toBeTypeOf('function');
  return ledger.countReconDiffOpen!;
}

const s = suite();

/** Every R1–R3 type of the contract's AdminReconDiffType, open: each one counts. */
const COUNTED: readonly DiffSeed[] = [
  { type: 'union_mismatch', source: 'R1', ref_type: 'order' },
  { type: 'settle_amount_mismatch', source: 'R1', ref_type: 'order' },
  { type: 'settle_missing', source: 'R1', ref_type: 'order' },
  { type: 'platform_restore', source: 'R1', ref_type: 'order' },
  { type: 'estimate_changed_after_credit', source: 'R1', ref_type: 'order' },
  { type: 'blacklist_after_credit', source: 'R1', ref_type: 'order' },
  { type: 'channel_mismatch', source: 'R2', ref_type: 'withdrawal' },
  { type: 'ledger_mismatch', source: 'R3', ref_type: 'account' },
  { type: 'month_end_unbalanced', source: 'R3', ref_type: 'ledger', period: '2026-09' },
  { type: 'appeal_restore', source: 'R3', ref_type: 'order' },
].map((seed) => ({ ...seed, status: 'open' }));

/** Rows the open list never shows: other statuses of R1–R3, and R4 even when open. */
const NOT_COUNTED: readonly DiffSeed[] = [
  { type: 'union_mismatch', source: 'R1', ref_type: 'order', status: 'processing' },
  { type: 'channel_mismatch', source: 'R2', ref_type: 'withdrawal', status: 'processing' },
  { type: 'platform_restore', source: 'R1', ref_type: 'order', status: 'adjusted' },
  { type: 'ledger_mismatch', source: 'R3', ref_type: 'account', status: 'written_off' },
  { type: 'appeal_restore', source: 'R3', ref_type: 'order', status: 'closed' },
  { type: 'settle_amount_mismatch', source: 'R1', ref_type: 'order', status: 'closed' },
  { type: 'pay_mismatch', source: 'R4', ref_type: 'pay_order', status: 'open' },
  { type: 'pay_anomaly', source: 'R4', ref_type: 'pay_order', status: 'open' },
];

const TERMINAL = new Set(['adjusted', 'written_off', 'closed']);

/** The seeds as rows of the fixture's app, each at its own created_at (oldest first). */
async function seedAll(f: Fixture, seeds: readonly DiffSeed[]): Promise<DiffRow[]> {
  const rows: DiffRow[] = [];
  for (const [i, seed] of seeds.entries()) {
    const at = ago(f, 500 - i);
    rows.push(
      await seedDiff(f, {
        ...seed,
        created_at: at,
        updated_at: at,
        closed_at: TERMINAL.has(String(seed.status)) ? ago(f, 1) : null,
      }),
    );
  }
  return rows;
}

/** COUNTED and NOT_COUNTED interleaved, so neither order nor position decides. */
function mixed(): DiffSeed[] {
  const out: DiffSeed[] = [];
  const n = Math.max(COUNTED.length, NOT_COUNTED.length);
  for (let i = 0; i < n; i += 1) {
    if (i < NOT_COUNTED.length) out.push(NOT_COUNTED[i]!);
    if (i < COUNTED.length) out.push(COUNTED[i]!);
  }
  return out;
}

/** A status change of one row, as a fixture write (closed_at set for the terminal statuses). */
async function setStatus(f: Fixture, row: DiffRow, status: string): Promise<void> {
  await f.db
    .withSchema('app')
    .updateTable('recon_diffs')
    .set({
      status,
      closed_at: TERMINAL.has(status) ? f.clock.now() : null,
      updated_at: f.clock.now(),
    })
    .where('app_id', '=', f.appId)
    .where('id', '=', row.id)
    .execute();
}

async function expectCount(
  count: CountOpen,
  f: Fixture,
  h: ReconAdmin,
  expected: number,
): Promise<void> {
  const actual = await count(f.db, f.appId);
  // A one-row page distinguishes total from the number of returned rows.
  const listed = await page(await h.list({ status: 'open', page_size: '1' }));
  expect(typeof actual, String(actual)).toBe('number');
  expect(actual).toBe(expected);
  expect(listed.total).toBe(expected);
  expect(actual).toBe(listed.total);
  expect(listed.items).toHaveLength(Math.min(1, expected));
}

it('[AC-B2-02w#1] 各类型各状态混合：只数本应用 source R1–R3 且 status=open 的差错单（十种 R1–R3 类型都算），processing / adjusted / written_off / closed 与 R4 收款差错（即使 open）都不算；计数等于差错单列表 status=open 的 total，且只读', async () => {
  const count = await counter();
  const f = fixture(s);
  await withReconAdmin(f, async (h) => {
    await seedAll(f, mixed());
    const diffs = await allDiffs(f);
    const audits = await allAudits(f);
    await expectCount(count, f, h, COUNTED.length);
    // Counting writes nothing: rows and audit records as they were.
    expect(await allDiffs(f)).toEqual(diffs);
    expect(await allAudits(f)).toEqual(audits);
  });
}, 60_000);

it('[AC-B2-02w#2] 只有 processing、已结案与 R4 open 的差错单时计数为 0，等于列表 status=open 的空 total；其中一张 processing 改回 open 后计数与列表 total 一起变为 1', async () => {
  const count = await counter();
  const f = fixture(s);
  await withReconAdmin(f, async (h) => {
    const rows = await seedAll(f, NOT_COUNTED);
    await expectCount(count, f, h, 0);
    const processing = rows.find((row) => row.status === 'processing');
    expect(processing, 'a processing row was seeded').toBeDefined();
    await setStatus(f, processing!, 'open');
    await expectCount(count, f, h, 1);
  });
}, 60_000);

it('[AC-B2-02w#3] 按 app 隔离：另一应用新增同批差错单（并多两张 open）不改变本应用计数，两应用各自等于本应用列表 status=open 的 total', async () => {
  const count = await counter();
  const a = fixture(s);
  const b = fixture(s);
  await withReconAdmin(a, async (ha) => {
    await seedAll(a, mixed());
    await expectCount(count, a, ha, COUNTED.length);
    await withReconAdmin(b, async (hb) => {
      await seedAll(b, mixed());
      // Unequal totals also catch counting another app's rows or a shared cached count.
      await seedDiff(b, { type: 'ledger_mismatch', source: 'R3', status: 'open' });
      await seedDiff(b, { type: 'union_mismatch', source: 'R1', status: 'open' });
      await expectCount(count, a, ha, COUNTED.length);
      await expectCount(count, b, hb, COUNTED.length + 2);
    });
  });
}, 60_000);

it('[AC-B2-02w#4] 新应用没有差错单时计数为数字 0，等于空列表 total，即使别的应用有未关闭差错单', async () => {
  const count = await counter();
  const populated = fixture(s);
  await seedAll(populated, mixed());
  const empty = fixture(s);
  await withReconAdmin(empty, async (h) => {
    await expectCount(count, empty, h, 0);
  });
}, 60_000);

it('[AC-B2-02w#5] 数据变化立即反映：open 依次改为 processing、closed、written_off、adjusted，计数与列表 total 逐次一起下降；新增 R4 open 不变；新增 R1–R3 open 一起上升', async () => {
  const count = await counter();
  const f = fixture(s);
  await withReconAdmin(f, async (h) => {
    const rows = await seedAll(f, [
      { type: 'union_mismatch', source: 'R1', ref_type: 'order', status: 'open' },
      { type: 'channel_mismatch', source: 'R2', ref_type: 'withdrawal', status: 'open' },
      { type: 'ledger_mismatch', source: 'R3', ref_type: 'account', status: 'open' },
      { type: 'platform_restore', source: 'R1', ref_type: 'order', status: 'open' },
    ]);
    await expectCount(count, f, h, 4);
    await setStatus(f, rows[0]!, 'processing');
    await expectCount(count, f, h, 3);
    await setStatus(f, rows[1]!, 'closed');
    await expectCount(count, f, h, 2);
    await setStatus(f, rows[2]!, 'written_off');
    await expectCount(count, f, h, 1);
    await setStatus(f, rows[3]!, 'adjusted');
    await expectCount(count, f, h, 0);
    await seedDiff(f, {
      type: 'pay_mismatch',
      source: 'R4',
      ref_type: 'pay_order',
      status: 'open',
    });
    await expectCount(count, f, h, 0);
    await seedDiff(f, { type: 'appeal_restore', source: 'R3', ref_type: 'order', status: 'open' });
    await expectCount(count, f, h, 1);
  });
}, 60_000);

it('[AC-B2-02w#6] 超过一页：205 张 open（多于默认 20 与上限 200 的每页条数）加 processing 与 R4 open 若干，计数为 205，等于列表 status=open 的 total，不受分页限制', async () => {
  const count = await counter();
  const f = fixture(s);
  await withReconAdmin(f, async (h) => {
    const SOURCES = ['R1', 'R2', 'R3'] as const;
    const TYPES = { R1: 'union_mismatch', R2: 'channel_mismatch', R3: 'ledger_mismatch' } as const;
    const row = (
      i: number,
      source: 'R1' | 'R2' | 'R3' | 'R4',
      type: string,
      status: string,
    ): Insertable<DB['recon_diffs']> => {
      const at = ago(f, 1_000 - i);
      return {
        id: randomUUID(),
        app_id: f.appId,
        type,
        source,
        period: '2026-10-28',
        ref_type: 'order',
        ref_id: randomUUID(),
        expected_fen: 1_000n,
        actual_fen: 900n,
        diff_fen: 100n,
        status,
        handler_id: null,
        closed_at: null,
        dedupe_key: null,
        resolution: null,
        created_at: at,
        updated_at: at,
      };
    };
    const rows: Insertable<DB['recon_diffs']>[] = [];
    for (let i = 0; i < 205; i += 1) {
      const source = SOURCES[i % SOURCES.length]!;
      rows.push(row(i, source, TYPES[source], 'open'));
    }
    rows.push(row(205, 'R1', 'union_mismatch', 'processing'));
    rows.push(row(206, 'R2', 'channel_mismatch', 'processing'));
    rows.push(row(207, 'R3', 'ledger_mismatch', 'processing'));
    rows.push(row(208, 'R4', 'pay_mismatch', 'open'));
    rows.push(row(209, 'R4', 'pay_anomaly', 'open'));
    await f.db.withSchema('app').insertInto('recon_diffs').values(rows).execute();
    await expectCount(count, f, h, 205);
  });
}, 60_000);
