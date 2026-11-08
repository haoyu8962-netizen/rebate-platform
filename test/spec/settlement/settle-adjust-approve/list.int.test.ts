// B2-09zc rule tests (claude-independent, SPEC_REF b79958d): the 补差批次 list
// (contracts/openapi.yaml adminListSettleAdjustments, CT-24zv; 08 BR-FUND-09 ②; D10-770 ④ 子订单有等待
// 联盟回应的维权而出现正差的…候选上标出「有等待中的维权」供批准人查看): read only, no step-up; fund.settle_adjust
// or fund.view; one row per candidate (AdminSettleAdjustment; a platform row has `user` and `role`
// null; the member as AdminWithdrawalUser, phone masked 3 + 4); filters status and batch_id with
// AND, a value outside the enum / pattern is 20001 data.fields naming the parameter, a batch_id
// naming nothing of the app is an empty page; created_at descending then id descending; AdminPage
// (page_size ≤ 200), total the count of the filter set; only the caller's app; no audit record.
// `rights_waiting` is true when the order has a rights case still waiting for the union
// (order_rights PROCESSING / WAIT_COMMISSION, orders.rights_pending, 04 §3 维权枚举).
import { expect, it } from 'vitest';
import type { CandidateRow } from '../settle-adjust-generate/harness.ts';
import {
  EXAMPLE,
  TIMEOUT,
  answer,
  approveHarness,
  approveSuite,
  instant,
  withAdmin,
  type AdjustAdmin,
  type ApproveHarness,
  type OrderSpec,
  type Sent,
} from './kit.ts';

const s = approveSuite();

const PLATFORM_ONLY: OrderSpec = {
  settleFen: 1000n,
  reserveBp: 5000,
  people: [
    { role: 'self', ratioBp: 5000 },
    { role: 'direct', ratioBp: 1000 },
  ],
};

interface Page {
  readonly items: Record<string, unknown>[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
}

/**
 * Two batches of one app and one of another app:
 *   batch 1 (generated first): o1 (EXAMPLE 1234 → 1300: three rows) and o2 (reserve 5000,
 *   1000 → 1001: one platform row), pending;
 *   batch 2 (ten minutes later): o3 (EXAMPLE: three rows), rejected;
 *   rights: o1 PROCESSING, o3 WAIT_COMMISSION (both waiting), o2 SUCCEEDED (not waiting).
 */
async function seed() {
  const h = await approveHarness(s);
  const o1 = (await h.raised(EXAMPLE, 1300n)).o;
  const o2 = (await h.raised(PLATFORM_ONLY, 1001n)).o;
  const batch1 = await h.generate();
  h.clock.advanceMs(10 * 60_000);
  const o3 = (await h.raised(EXAMPLE, 1300n)).o;
  const batch2 = await h.generate();
  h.clock.advanceMs(60_000);
  await h.decide(o3, 'rejected', await h.admin(), '2032-07-24T10:11:00+08:00');
  await h.rightsCase(o1, 'PROCESSING');
  await h.rightsCase(o2, 'SUCCEEDED');
  await h.rightsCase(o3, 'WAIT_COMMISSION');
  const other = await approveHarness(s);
  await other.raised(EXAMPLE, 1300n);
  const otherBatch = await other.generate();
  h.clock.advanceMs(60_000);
  const rows = await h.allRows();
  expect(rows).toHaveLength(7);
  return {
    h,
    o1,
    o2,
    o3,
    batch1,
    batch2,
    otherBatch,
    waiting: new Set([o1.orderId, o3.orderId]),
  };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

/** Newest first: created_at descending, then id descending. */
function newestFirst(rows: readonly CandidateRow[]): CandidateRow[] {
  return [...rows].sort((a, b) => {
    const at = b.created_at.getTime() - a.created_at.getTime();
    if (at !== 0) return at;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/** The AdminSettleAdjustment a stored row must be shown as (instants as epoch milliseconds). */
function view(
  row: CandidateRow,
  waiting: ReadonlySet<string>,
  phones: ReadonlyMap<string, string>,
): Record<string, unknown> {
  return {
    id: row.id,
    batch_id: row.batch_id,
    order_id: row.order_id,
    user:
      row.user_id === null
        ? null
        : { user_id: row.user_id, phone_masked: phones.get(row.user_id) ?? null },
    role: row.role,
    settle_seq: row.settle_seq,
    diff_fen: Number(row.diff_fen),
    status: row.status,
    rights_waiting: waiting.has(row.order_id),
    reason: row.reason,
    approver_id: row.approver,
    decided_at: row.decided_at === null ? null : row.decided_at.getTime(),
    created_at: row.created_at.getTime(),
  };
}

/** A successful page, its rows' instants as epoch milliseconds. */
async function pageOf(sent: Sent): Promise<Page> {
  const body = await answer(sent, 0);
  const data = body.data as Page;
  expect(Array.isArray(data.items), sent.body).toBe(true);
  return {
    ...data,
    items: data.items.map((item) => ({
      ...item,
      decided_at: instant(item['decided_at']),
      created_at: instant(item['created_at']),
    })),
  };
}

async function expected(
  x: Seeded,
  phones: ReadonlyMap<string, string>,
  keep: (row: CandidateRow) => boolean = () => true,
): Promise<Record<string, unknown>[]> {
  return newestFirst((await x.h.allRows()).filter(keep)).map((r) => view(r, x.waiting, phones));
}

async function phonesOf(a: AdjustAdmin, x: Seeded): Promise<Map<string, string>> {
  const self = x.o1.user('self');
  return new Map([[self, await a.setPhone(self)]]);
}

it(
  '[AC-B2-09zc#6] fund.settle_adjust 与 fund.view 都可读（无 step-up）：本 app 的 7 行按 created_at 降序、同则 id 降序；平台行 user / role 为 null，成员手机号脱敏；diff_fen 为生成时金额；rights_waiting 按等待中的维权；不含别 app 的行；不写审计、不改数据',
  async () => {
    const x = await seed();
    await withAdmin(s, x.h, async (a) => {
      const phones = await phonesOf(a, x);
      const before = await x.h.footprint();
      const all = await expected(x, phones);
      for (const who of [a.adjuster, a.viewer]) {
        const page = await pageOf(await a.list({}, who));
        expect(page.items).toEqual(all);
        expect(page.total).toBe(7);
        expect(page.page).toBe(1);
      }
      expect(all.slice(0, 3).every((r) => r['batch_id'] === x.batch2)).toBe(true);
      expect(all.filter((r) => r['user'] === null).map((r) => r['role'])).toEqual([
        null,
        null,
        null,
      ]);
      expect(all.filter((r) => r['rights_waiting'] === true)).toHaveLength(6);
      expect(await x.h.footprint()).toEqual(before);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#6] 过滤按 AND：status、batch_id 各自与组合；别 app 的批次、不存在的批次 → 空页 total 0',
  async () => {
    const x = await seed();
    await withAdmin(s, x.h, async (a) => {
      const phones = await phonesOf(a, x);
      const cases: [Record<string, string>, (r: CandidateRow) => boolean][] = [
        [{ status: 'pending' }, (r) => r.status === 'pending'],
        [{ status: 'rejected' }, (r) => r.status === 'rejected'],
        [{ status: 'approved' }, () => false],
        [{ batch_id: x.batch1 }, (r) => r.batch_id === x.batch1],
        [{ batch_id: x.batch2, status: 'rejected' }, (r) => r.batch_id === x.batch2],
        [{ batch_id: x.batch2, status: 'pending' }, () => false],
        [{ batch_id: x.otherBatch }, () => false],
        [{ batch_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4fb999' }, () => false],
      ];
      for (const [query, keep] of cases) {
        const want = await expected(x, phones, keep);
        const page = await pageOf(await a.list(query));
        expect(page.items, JSON.stringify(query)).toEqual(want);
        expect(page.total, JSON.stringify(query)).toBe(want.length);
      }
      expect((await expected(x, phones, (r) => r.batch_id === x.batch1)).length).toBe(4);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#6] 分页：page_size 3 的第 2、3 页依次接上，total 为过滤集计数 7；page_size 200 可以',
  async () => {
    const x = await seed();
    await withAdmin(s, x.h, async (a) => {
      const phones = await phonesOf(a, x);
      const all = await expected(x, phones);
      const second = await pageOf(await a.list({ page: '2', page_size: '3' }));
      expect(second).toEqual({ items: all.slice(3, 6), page: 2, page_size: 3, total: 7 });
      const third = await pageOf(await a.list({ page: '3', page_size: '3' }));
      expect(third).toEqual({ items: all.slice(6), page: 3, page_size: 3, total: 7 });
      const filtered = await pageOf(await a.list({ status: 'pending', page: '2', page_size: '3' }));
      expect(filtered).toEqual({
        items: (await expected(x, phones, (r) => r.status === 'pending')).slice(3),
        page: 2,
        page_size: 3,
        total: 4,
      });
      const wide = await pageOf(await a.list({ page_size: '200' }));
      expect(wide.items).toEqual(all);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#6] 非法参数 → 20001 data.fields 指名参数：status 不在枚举、batch_id 不是 Id、page_size 201、page 0',
  async () => {
    const x = await seed();
    await withAdmin(s, x.h, async (a) => {
      await answer(await a.list({ status: 'approved_zero' }), 20001, { fields: ['status'] });
      await answer(await a.list({ batch_id: 'batch-1' }), 20001, { fields: ['batch_id'] });
      await answer(await a.list({ page_size: '201' }), 20001, { fields: ['page_size'] });
      await answer(await a.list({ page: '0' }), 20001, { fields: ['page'] });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#6] 两个权限点都没有 → 10403 data.reason=admin_permission_denied；无令牌 → 10001；有权限的同一请求可读',
  async () => {
    const x = await seed();
    await withAdmin(s, x.h, async (a) => {
      const nobody = await a.caller([]);
      await answer(await a.list({}, nobody), 10403, { reason: 'admin_permission_denied' });
      await answer(await a.list({}, null), 10001);
      expect((await pageOf(await a.list({}, a.viewer))).total).toBe(7);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#6] 批准之后列表反映结果：已批准行带 approver_id 与 decided_at',
  async () => {
    const h: ApproveHarness = await approveHarness(s);
    const { o } = await h.raised(EXAMPLE, 1300n);
    const batchId = await h.generate();
    h.clock.advanceMs(60_000);
    await withAdmin(s, h, async (a) => {
      await answer(await a.approve(batchId), 0);
      const page = await pageOf(await a.list({ batch_id: batchId }));
      expect(page.total).toBe(3);
      for (const item of page.items) {
        expect(item).toMatchObject({
          order_id: o.orderId,
          status: 'approved',
          approver_id: a.adjuster.id,
          decided_at: h.clock.now().getTime(),
          rights_waiting: false,
          reason: null,
        });
      }
    });
  },
  TIMEOUT,
);
