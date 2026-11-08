// B1-09v round 2 (rule-test review r1, S1 ①): 「人工选过的不被自动覆盖」 against a real automatic
// source. 08 BR-TEXT-05 子原因: 写入来源 ① a Taobao (大淘客) punishment's violation_type text maps
// by its desc (「订单虚假交易」→ FAKE_TRADE), and a later sync with a more specific sub-reason may
// overwrite PUNISH_ORDER; 写入来源 ② a value chosen by hand (the punish import's reason_sub, or
// 改子原因; `none` included) is never overwritten automatically. Contract CT-24zw: the import's
// choice "counts as chosen by hand, so a later sync does not overwrite it"; adminSetOrderReasonSub
// sets reason_sub_manual "so later automatic mapping from a sync does not overwrite it".
// Each case runs one 'punish.window' through the worker's real order-sync handler (./sync-kit.ts)
// whose one page carries a punishment of the hand-chosen order and of a control order holding the
// automatic PUNISH_ORDER (reason_sub_manual false): the control turning FAKE_TRADE shows the
// automatic path is live in that very run, and the hand-chosen order keeps its value and its flag.
// The rows the sync records (source API) are its own, never chosen by hand. The import templates
// are synthetic (../rights-mounts/templates.ts), injected over the real job. Top-level it() only
// (规划/11 §4.3).
import { afterEach, expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import type { RightsImportJob } from '../rights-mounts/templates.ts';
import {
  CLAIM,
  NONE,
  creditedOrder,
  detailAnswer,
  expectManual,
  importPunish,
  orderNow,
  rightsOfOrder,
  seedUnionAccount,
  setReasonSub,
  setup,
  shareImportStore,
  type Order,
  type OrderPatch,
  type Scenario,
} from './kit.ts';
import { FAKE_TRADE_TEXT, punishWorker, punishmentOf, taobaoOrder } from './sync-kit.ts';

vi.mock('../../../../apps/api/src/modules/orders/jobs/rights-import.ts', async (importOriginal) =>
  (await import('../rights-mounts/templates.ts')).withTemplates(
    await importOriginal<RightsImportJob>(),
  ),
);

const h = useHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

/** A VOID PUNISH Taobao order whose sub-reason the automatic mapping wrote (not by hand). */
function automaticOrder(s: Scenario, patch: OrderPatch = {}) {
  return taobaoOrder(s, {
    rebate_status: 'VOID',
    reason: 'PUNISH',
    reason_sub: 'PUNISH_ORDER',
    reason_sub_manual: false,
    ...patch,
  });
}

/** The one row the sync recorded on `order` under `punishmentId`: source API, not by hand. */
async function expectSynced(s: Scenario, order: Order, punishmentId: string): Promise<void> {
  const rows = await rightsOfOrder(s, order.order_id);
  const synced = rows.filter((row) => row.platform_rights_no === punishmentId);
  expect(
    synced.map((row) => ({
      type: row.type,
      source: row.source,
      status: row.status,
      reason_sub: row.reason_sub,
      reason_sub_manual: row.reason_sub_manual,
    })),
  ).toEqual([
    {
      type: 'PUNISH',
      source: 'API',
      status: 'SUCCEEDED',
      reason_sub: null,
      reason_sub_manual: false,
    },
  ]);
}

/** 改子原因 to `value` with the order's current row_version; the answer must be 200. */
async function setByHand(s: Scenario, order: Order, value: string): Promise<void> {
  const now = await orderNow(s, order.order_id);
  await detailAnswer(
    await setReasonSub(s, order.order_id, {
      reason_sub: value,
      expected_row_version: now.row_version,
    }),
  );
}

const MANUAL: readonly (readonly ['import' | 'set', string])[] = [
  ['import', 'PUNISH_ORDER'],
  ['import', NONE],
  ['set', 'PUNISH_ORDER'],
  ['set', NONE],
];

it.each(MANUAL)(
  '[AC-B1-09v#4] 经 %s 人工选 %s（reason_sub_manual=true）之后，淘宝违规同步（真实 punish.window，violation_type「订单虚假交易」）到来：该单 orders.reason_sub 不变、reason_sub_manual 仍 true；同一页的自动对照单（PUNISH_ORDER、manual=false）改为 FAKE_TRADE',
  async (via, value) => {
    shareImportStore();
    const s = await setup(h, { grants: CLAIM });
    const w = await punishWorker(h);
    const account = await seedUnionAccount(s, 'taobao');
    const kept = value === NONE ? null : value;

    let order: Order;
    if (via === 'import') {
      order = await taobaoOrder(s);
      await importPunish(s, w, 'taobao', [order.sub_order_id], value, ['PN-MANUAL']);
    } else {
      order = await automaticOrder(s);
      await setByHand(s, order, value);
    }
    await expectManual(s, order.order_id, kept, true);
    const control = await automaticOrder(s);

    await w.punish(s, account, [
      punishmentOf(order, 'TB-MANUAL', FAKE_TRADE_TEXT),
      punishmentOf(control, 'TB-CONTROL', FAKE_TRADE_TEXT),
    ]);

    expect(w.listPunishments).toHaveBeenCalledTimes(1);
    await expectSynced(s, order, 'TB-MANUAL');
    await expectSynced(s, control, 'TB-CONTROL');
    await expectManual(s, control.order_id, 'FAKE_TRADE', false);
    await expectManual(s, order.order_id, kept, true);
    expect(await orderNow(s, order.order_id)).toMatchObject({
      rebate_status: 'VOID',
      reason: 'PUNISH',
    });
  },
  120_000,
);

it.each(['PUNISH_ORDER', NONE] as const)(
  '[AC-B1-09v#4] 已入账淘宝订单经违规单导入人工选 %s 扣回（CLAWED_BACK）之后，真实 punish.window 带「订单虚假交易」：该单 orders.reason_sub 不变、reason_sub_manual 仍 true，不再扣回；同一页已扣回的自动对照单（PUNISH_ORDER）改为 FAKE_TRADE',
  async (value) => {
    shareImportStore();
    const s = await setup(h, { grants: CLAIM });
    const w = await punishWorker(h);
    const account = await seedUnionAccount(s, 'taobao');
    const kept = value === NONE ? null : value;
    const c = await creditedOrder(s, w);

    await importPunish(s, w, 'taobao', [c.order.sub_order_id], value, ['PN-MANUAL']);
    await expectManual(s, c.order.order_id, kept, true);
    const clawed = await orderNow(s, c.order.order_id);
    expect(clawed).toMatchObject({ rebate_status: 'CLAWED_BACK', reason: 'PUNISH' });
    const control = await automaticOrder(s, {
      rebate_status: 'CLAWED_BACK',
      platform_status: 'SETTLED',
    });

    await w.punish(s, account, [
      punishmentOf(c.order, 'TB-MANUAL', FAKE_TRADE_TEXT),
      punishmentOf(control, 'TB-CONTROL', FAKE_TRADE_TEXT),
    ]);

    await expectSynced(s, c.order, 'TB-MANUAL');
    await expectSynced(s, control, 'TB-CONTROL');
    await expectManual(s, control.order_id, 'FAKE_TRADE', false);
    await expectManual(s, c.order.order_id, kept, true);
    expect(await orderNow(s, c.order.order_id)).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      reason: 'PUNISH',
      booked_base_fen: clawed.booked_base_fen,
      booked_n_fen: clawed.booked_n_fen,
    });
  },
  120_000,
);
