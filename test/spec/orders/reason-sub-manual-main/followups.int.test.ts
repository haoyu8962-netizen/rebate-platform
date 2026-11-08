// B1-09zb, split out of B1-09za part B under D10-903 (A) (FU-REASON-SUB-MANUAL-TESTS-R3: the two S2 findings of the B1-09v rule-test review
// r3), behaviour main already has. 08 BR-TEXT-05 子原因 写入来源 ②「人工选过的不被自动覆盖」; contract
// CT-24zw (adminCreateRightsImport reason_sub: it "replaces the automatic mapping for the orders this
// import marks PUNISH"); D10-957.
//   ① the replayed-duplicate route: the automatic refine of B2-04zze only replaces PUNISH_ORDER or
//     an empty sub-reason, so a choice by hand of PUNISH_ORDER is the value it would hit; a
//     duplicate replay of the same punishment with 「订单虚假交易」 must leave that choice by hand
//     alone, while an automatic PUNISH_ORDER on the same page is still refined to FAKE_TRADE (the
//     refine route is live in the same run). `none` is left out: the frozen duplicate.int.test.ts
//     reads D10-957 as an explicit sub-reason (not absent, not `none`) on this route;
//   ② an order already VOID / CLAWED_BACK for a parent without sub-reasons (OTHER, COMMISSION_ZERO;
//     reason_sub NULL) hit by a punish import with reason_sub=FAKE_TRADE: the order is not this
//     import's PUNISH order, so reason, reason_sub and reason_sub_manual all stay. (PLATFORM_INVALID
//     is the R6 event, written as reason REFUND: that parent is covered by the frozen
//     ../reason-sub-manual/terminal.int.test.ts.)
// Real admin entry and PostgreSQL; the worker's real order-sync handler for 'punish.window'
// (synthetic Taobao adapter only, ../reason-sub-manual/sync-kit.ts) and rights_import job (synthetic
// templates, ../rights-mounts/templates.ts), settlement's rights command and rebate port. Top-level
// it() only (规划/11 §4.3). Only the container runner executes it.
import { afterEach, expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  CLAIM,
  SET_AUDIT,
  auditsOf,
  expectManual,
  importPunish,
  orderNow,
  reasonedOrder,
  rightsOfOrder,
  seedUnionAccount,
  setup,
  shareImportStore,
  untouched,
  worker,
  type OrderPatch,
} from '../reason-sub-manual/kit.ts';
import {
  FAKE_TRADE_TEXT,
  punishWorker,
  punishmentOf,
  taobaoOrder,
} from '../reason-sub-manual/sync-kit.ts';
import type { RightsImportJob } from '../rights-mounts/templates.ts';

vi.mock('../../../../apps/api/src/modules/orders/jobs/rights-import.ts', async (importOriginal) =>
  (await import('../rights-mounts/templates.ts')).withTemplates(
    await importOriginal<RightsImportJob>(),
  ),
);

const h = useHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

/** The 违规单号 the sync records on the order and the import repeats. */
const NUMBER = 'TB-R3-REPLAY';
/** The 违规单号 of the automatic control order on the same pages. */
const CONTROL = 'TB-R3-CONTROL';

it('[AC-B1-09zb#1] 同号重放路径：淘宝同步把订单落 VOID PUNISH、自动 FAKE_TRADE → 运营导入同一违规单号显式人工选 PUNISH_ORDER → 同步以同一违规单号重放「订单虚假交易」：订单仍为 PUNISH_ORDER、reason_sub_manual=true，重放不写 order_reason_sub_set 审计、记录仍一条；对照单（同页，首次同步无 violation_type 得自动 PUNISH_ORDER、manual=false，其同号处罚已存）同号重放「订单虚假交易」→ 细化为 FAKE_TRADE、manual=false', async () => {
  shareImportStore();
  const s = await setup(h, { grants: CLAIM });
  const w = await punishWorker(h);
  const account = await seedUnionAccount(s, 'taobao');
  const order = await taobaoOrder(s);
  const control = await taobaoOrder(s);

  await w.punish(s, account, [
    punishmentOf(order, NUMBER, FAKE_TRADE_TEXT),
    { ...punishmentOf(control, CONTROL, FAKE_TRADE_TEXT), violation_type: null },
  ]);
  await expectManual(s, order.order_id, 'FAKE_TRADE', false);
  await expectManual(s, control.order_id, 'PUNISH_ORDER', false);
  expect(await orderNow(s, control.order_id)).toMatchObject({
    rebate_status: 'VOID',
    reason: 'PUNISH',
  });

  await importPunish(s, w, 'taobao', [order.sub_order_id], 'PUNISH_ORDER', [NUMBER]);
  await expectManual(s, order.order_id, 'PUNISH_ORDER', true);
  const before = await orderNow(s, order.order_id);
  const countBefore = (await auditsOf(s, SET_AUDIT)).length;

  await w.punish(s, account, [
    punishmentOf(order, NUMBER, FAKE_TRADE_TEXT),
    punishmentOf(control, CONTROL, FAKE_TRADE_TEXT),
  ]);

  await expectManual(s, control.order_id, 'FAKE_TRADE', false);
  await expectManual(s, order.order_id, 'PUNISH_ORDER', true);
  expect(untouched(await orderNow(s, order.order_id))).toEqual(untouched(before));
  expect(await auditsOf(s, SET_AUDIT)).toHaveLength(countBefore);
  const rows = await rightsOfOrder(s, order.order_id);
  expect(rows.map((row) => [row.type, row.platform_rights_no, row.status])).toEqual([
    ['PUNISH', NUMBER, 'SUCCEEDED'],
  ]);
}, 120_000);

const NO_SUB_PARENT: readonly (readonly [string, string, OrderPatch])[] = [
  ['VOID', 'OTHER', { rebate_status: 'VOID' }],
  ['CLAWED_BACK', 'OTHER', { rebate_status: 'CLAWED_BACK', platform_status: 'SETTLED' }],
  ['VOID', 'COMMISSION_ZERO', { rebate_status: 'VOID' }],
];

it.each(NO_SUB_PARENT)(
  '[AC-B1-09zb#2] 已 %s、原因 %s（reason_sub 为 NULL、manual=false）的淘宝订单被违规单导入（reason_sub=FAKE_TRADE）命中：导入的 order_rights 行带 FAKE_TRADE、manual=true；订单不变——reason、reason_sub（仍 NULL）、reason_sub_manual（仍 false）与状态、金额都不变',
  async (_status, reason, patch) => {
    shareImportStore();
    const s = await setup(h, { grants: CLAIM });
    const w = await worker(h);
    const order = await reasonedOrder(s, reason, {
      platform: 'taobao',
      product_key: 'taobao:fixture',
      ...patch,
      reason_sub: null,
      reason_sub_manual: false,
    });
    const before = await orderNow(s, order.order_id);

    await importPunish(s, w, 'taobao', [order.sub_order_id], 'FAKE_TRADE');

    const rows = await rightsOfOrder(s, order.order_id);
    expect(
      rows.map((row) => [row.type, row.status, row.reason_sub, row.reason_sub_manual]),
    ).toEqual([['PUNISH', 'SUCCEEDED', 'FAKE_TRADE', true]]);
    const after = await orderNow(s, order.order_id);
    expect({
      reason: after.reason,
      reason_sub: after.reason_sub,
      reason_sub_manual: after.reason_sub_manual,
    }).toEqual({ reason, reason_sub: null, reason_sub_manual: false });
    expect(untouched(after)).toEqual(untouched(before));
  },
  120_000,
);
