// B1-09v round 2 (rule-test review r1, S1 ②): which orders a punish import's manual reason_sub
// reaches. Contract CT-24zw (adminCreateRightsImport, reason_sub): "it replaces the automatic
// mapping for the orders this import marks PUNISH"; 08 BR-TEXT-05 子原因: a sub-reason belongs to
// its parent reason (PUNISH's twelve; REFUND IN_SALE / AFTER_SETTLE; RIGHTS AFTER_SALE), only
// changes what the user reads, never amounts, the parent reason or a status transition; 写入来源 ②
// 「人工选择覆盖自动映射」. Settlement's rights command only records a row on a terminal order
// (VOID / CLAWED_BACK; BR-FUND-01 细则「订单锁定」), so:
//   - the order_rights row the import writes always carries the choice (reason_sub_manual true);
//   - an order already ended for another reason (REFUND, RIGHTS) keeps its reason, its
//     sub-reason and its flag: a PUNISH sub-reason is never paired with another parent;
//   - an order already VOID / CLAWED_BACK for PUNISH whose sub-reason the automatic mapping wrote
//     (reason_sub_manual false) is an order of this punish import whose parent is PUNISH: the
//     choice made by hand replaces the automatic value (`none` → NULL) and the order counts as
//     chosen by hand; rebate_status, reason and amounts stay as they are.
// Real admin entry, permissions, PostgreSQL, the worker's real rights_import job and settlement's
// rights command; the templates are synthetic (../rights-mounts/templates.ts), injected over the
// real job. Top-level it() only (规划/11 §4.3).
import { afterEach, expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import type { RightsImportJob } from '../rights-mounts/templates.ts';
import {
  CLAIM,
  NONE,
  detailOf,
  importPunish,
  orderNow,
  reasonedOrder,
  rightsOfOrder,
  setup,
  shareImportStore,
  untouched,
  worker,
  type OrderPatch,
  type Scenario,
} from './kit.ts';

vi.mock('../../../../apps/api/src/modules/orders/jobs/rights-import.ts', async (importOriginal) =>
  (await import('../rights-mounts/templates.ts')).withTemplates(
    await importOriginal<RightsImportJob>(),
  ),
);

const h = useHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

/** The import's row on the order: one PUNISH / SUCCEEDED row carrying the choice by hand. */
function expectedRow(value: string) {
  return { type: 'PUNISH', status: 'SUCCEEDED', reason_sub_manual: true, chosen: value };
}

async function rowsOf(s: Scenario, orderId: string) {
  const rows = await rightsOfOrder(s, orderId);
  return rows.map((row) => ({
    type: row.type,
    status: row.status,
    reason_sub_manual: row.reason_sub_manual,
    // 「无」: no sub-reason on the row (NULL, or `none` as 0131's CHECK allows).
    chosen: row.reason_sub === null ? NONE : row.reason_sub,
  }));
}

const OTHER_PARENT: readonly (readonly [string, string, OrderPatch])[] = [
  ['VOID', 'REFUND', { rebate_status: 'VOID', reason_sub: 'IN_SALE' }],
  ['VOID', 'REFUND', { rebate_status: 'VOID', reason_sub: null }],
  [
    'VOID',
    'REFUND',
    { rebate_status: 'VOID', reason_sub: 'AFTER_SETTLE', platform_status: 'SETTLED' },
  ],
  [
    'CLAWED_BACK',
    'RIGHTS',
    { rebate_status: 'CLAWED_BACK', reason_sub: 'AFTER_SALE', platform_status: 'SETTLED' },
  ],
];

it.each(OTHER_PARENT)(
  '[AC-B1-09v#1] 已 %s、原因 %s 的订单再被违规单导入（reason_sub=FAKE_TRADE）：导入成功、order_rights 行带 FAKE_TRADE 且 reason_sub_manual=true；订单不由本导入落 PUNISH，orders.reason / reason_sub / reason_sub_manual 与金额、状态都不变',
  async (_status, reason, patch) => {
    shareImportStore();
    const s = await setup(h, { grants: CLAIM });
    const w = await worker(h);
    const order = await reasonedOrder(s, reason, patch);
    const before = await orderNow(s, order.order_id);

    const importId = await importPunish(s, w, order.platform, [order.sub_order_id], 'FAKE_TRADE');

    expect(await detailOf(s, importId)).toMatchObject({
      status: 'done',
      succeeded_rows: 1,
      failed_rows: 0,
      reason_sub: 'FAKE_TRADE',
    });
    expect(await rowsOf(s, order.order_id)).toEqual([expectedRow('FAKE_TRADE')]);
    const after = await orderNow(s, order.order_id);
    expect({
      reason: after.reason,
      reason_sub: after.reason_sub,
      reason_sub_manual: after.reason_sub_manual,
    }).toEqual({
      reason: before.reason,
      reason_sub: before.reason_sub,
      reason_sub_manual: false,
    });
    expect(untouched(after)).toEqual(untouched(before));
  },
  120_000,
);

const PUNISHED: readonly (readonly [string, string | null, string, OrderPatch])[] = [
  ['VOID', 'PUNISH_ORDER', 'FAKE_TRADE', { rebate_status: 'VOID' }],
  ['VOID', 'SHOP_TK', 'FAKE_TRADE', { rebate_status: 'VOID' }],
  ['VOID', null, 'FAKE_TRADE', { rebate_status: 'VOID' }],
  ['VOID', 'SHOP_TK', NONE, { rebate_status: 'VOID' }],
  [
    'CLAWED_BACK',
    'PUNISH_ORDER',
    'RISK_ORDER',
    { rebate_status: 'CLAWED_BACK', platform_status: 'SETTLED' },
  ],
];

it.each(PUNISHED)(
  '[AC-B1-09v#1] 已 %s、原因 PUNISH、子原因为自动值 %s（reason_sub_manual=false）的订单再被违规单导入（reason_sub=%s）：order_rights 行带该选择、manual=true；人工选择覆盖自动值（none 写 NULL）、orders.reason_sub_manual=true；rebate_status、reason 与金额不变',
  async (_status, automatic, value, patch) => {
    shareImportStore();
    const s = await setup(h, { grants: CLAIM });
    const w = await worker(h);
    // A Taobao order: the automatic mapping writes sub-reasons from Taobao's violation_type text.
    const order = await reasonedOrder(s, 'PUNISH', {
      platform: 'taobao',
      product_key: 'taobao:fixture',
      ...patch,
      reason_sub: automatic,
      reason_sub_manual: false,
    });
    const before = await orderNow(s, order.order_id);

    await importPunish(s, w, order.platform, [order.sub_order_id], value);

    expect(await rowsOf(s, order.order_id)).toEqual([expectedRow(value)]);
    const after = await orderNow(s, order.order_id);
    expect({
      reason: after.reason,
      reason_sub: after.reason_sub,
      reason_sub_manual: after.reason_sub_manual,
    }).toEqual({
      reason: 'PUNISH',
      reason_sub: value === NONE ? null : value,
      reason_sub_manual: true,
    });
    expect(untouched(after)).toEqual(untouched(before));
  },
  120_000,
);
