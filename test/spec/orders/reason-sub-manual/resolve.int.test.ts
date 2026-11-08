// B1-09v round 3 (money r1 S2 ②, D10-957): a stored order_rights record keeps its sub-reason chosen
// by hand when a later input closes it. 08 BR-TEXT-05 子原因 写入来源 ②「人工选择覆盖自动映射」,
// 「人工选过的不被自动覆盖」; contract CT-24zw (adminCreateRightsImport reason_sub: it "replaces the
// automatic mapping for the orders this import marks PUNISH and counts as chosen by hand").
// Settlement's rights command resolves a stored PROCESSING row in place when the result arrives
// (rights-command.ts step 2; BR-FUND-06 「维权结果」), and only then marks the order PUNISH (R6
// before credit, R8 clawback after), so the order's sub-reason is decided when the row is closed:
//   (a) a punish import's row 「处理中」 carrying a choice by hand, closed by the Taobao sync reporting
//       the same 违规单号 as successful with 「订单虚假交易」 (or by a later import of the same number
//       without reason_sub) → the row and the order carry the choice by hand, not FAKE_TRADE;
//   (b) the sync's row 「处理中」 (not by hand), closed by a punish import of the same number with
//       reason_sub → the row is written back with the choice, the order gets it;
//   (c) both by hand → the later one wins.
// No platform or template on main delivers a PUNISH 「处理中」 yet (BR-FUND-06 待验证: which
// platforms send a 处理中 signal), so the stored row is seeded as rights.record would have left it
// (and orders.rights_pending with it); everything after is real: the worker's order-sync handler
// for 'punish.window' (./sync-kit.ts, synthetic Taobao adapter only) and for rights_import (real job,
// synthetic templates ../rights-mounts/templates.ts), settlement's rights command, rebate port and
// clawback. Top-level it() only (规划/11 §4.3). Only the container runner executes it.
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import type { RightsImportJob } from '../rights-mounts/templates.ts';
import {
  CLAIM,
  NONE,
  OCCURRED,
  creditedOrder,
  importPunish,
  orderNow,
  rightsOfOrder,
  seedUnionAccount,
  setup,
  shareImportStore,
  type Order,
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

/** The 违规单号 of the stored record and of the input that closes it (the K-2 key). */
const NUMBER = 'TB-PROCESSING-1';

/**
 * A PUNISH record 「处理中」 of `order` under NUMBER, as rights.record would have stored it (and
 * orders.rights_pending with it): `byHand` is the sub-reason chosen by hand (one of the twelve), null
 * when nothing was chosen by hand (migration 0131: reason_sub NULL while reason_sub_manual is false).
 * The order itself is not changed by the choice yet. Returns the row's id.
 */
async function storedProcessing(
  s: Scenario,
  order: Order,
  source: 'API' | 'IMPORT',
  byHand: string | null,
): Promise<string> {
  const id = randomUUID();
  const at = new Date(OCCURRED);
  await s.h.db
    .insertInto('order_rights')
    .values({
      id,
      app_id: s.appId,
      order_id: order.order_id,
      source,
      type: 'PUNISH',
      status: 'PROCESSING',
      amount_fen: null,
      deduction_commission_fen: null,
      occurred_at: at,
      platform_rights_no: NUMBER,
      created_at: at,
      updated_at: at,
      reason_sub: byHand,
      reason_sub_manual: byHand !== null,
    })
    .execute();
  await s.h.db
    .updateTable('orders')
    .set({ rights_pending: true })
    .where('app_id', '=', s.appId)
    .where('order_id', '=', order.order_id)
    .execute();
  return id;
}

/** The order's order_rights rows; `chosen` is the choice by hand (`none`: no sub-reason). */
async function rowsOf(s: Scenario, orderId: string) {
  const rows = await rightsOfOrder(s, orderId);
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    reason_sub_manual: row.reason_sub_manual,
    // 「无」: no sub-reason on the row (NULL, or `none` as 0131's CHECK allows).
    chosen: row.reason_sub === null || row.reason_sub === NONE ? NONE : row.reason_sub,
  }));
}

/** The stored record closed in place: same id, SUCCEEDED, still carrying the choice by hand. */
function closedWith(id: string, value: string) {
  return [{ id, type: 'PUNISH', status: 'SUCCEEDED', reason_sub_manual: true, chosen: value }];
}

/** The order's sub-reason columns next to the status the closing record moved it to. */
async function expectPunished(
  s: Scenario,
  orderId: string,
  rebateStatus: 'VOID' | 'CLAWED_BACK',
  value: string,
): Promise<void> {
  const row = await orderNow(s, orderId);
  expect({
    rebate_status: row.rebate_status,
    reason: row.reason,
    reason_sub: row.reason_sub,
    reason_sub_manual: row.reason_sub_manual,
  }).toEqual({
    rebate_status: rebateStatus,
    reason: 'PUNISH',
    reason_sub: value === NONE ? null : value,
    reason_sub_manual: true,
  });
}

it.each(['SHOP_TK', 'PUNISH_ORDER', 'RISK_ORDER'] as const)(
  '[AC-B1-09v#9] 违规单导入人工选 %s 的违规记录「处理中」入库（订单未变）后，淘宝同步（真实 punish.window）报同一违规单号成功、violation_type「订单虚假交易」：该行原地结案、仍带人工值且 reason_sub_manual=true；订单经真实 rebate 落 VOID PUNISH 时 orders.reason_sub 为人工值（不是 FAKE_TRADE）、reason_sub_manual=true',
  async (value) => {
    const s = await setup(h, { grants: CLAIM });
    const w = await punishWorker(h);
    const account = await seedUnionAccount(s, 'taobao');
    const order = await taobaoOrder(s);
    const id = await storedProcessing(s, order, 'IMPORT', value);

    await w.punish(s, account, [punishmentOf(order, NUMBER, FAKE_TRADE_TEXT)]);

    expect(w.listPunishments).toHaveBeenCalledTimes(1);
    expect(await rowsOf(s, order.order_id)).toEqual(closedWith(id, value));
    await expectPunished(s, order.order_id, 'VOID', value);
  },
  120_000,
);

it('[AC-B1-09v#9] 已入账淘宝订单上违规单导入人工选 SHOP_TK 的「处理中」记录，被淘宝同步报同一违规单号成功（「订单虚假交易」）结案：经真实扣回落 CLAWED_BACK、原因 PUNISH 时 orders.reason_sub=SHOP_TK、reason_sub_manual=true；该行仍带 SHOP_TK', async () => {
  const s = await setup(h, { grants: CLAIM });
  const w = await punishWorker(h);
  const account = await seedUnionAccount(s, 'taobao');
  const c = await creditedOrder(s, w);
  const id = await storedProcessing(s, c.order, 'IMPORT', 'SHOP_TK');

  await w.punish(s, account, [punishmentOf(c.order, NUMBER, FAKE_TRADE_TEXT)]);

  expect(await rowsOf(s, c.order.order_id)).toEqual(closedWith(id, 'SHOP_TK'));
  await expectPunished(s, c.order.order_id, 'CLAWED_BACK', 'SHOP_TK');
}, 120_000);

it.each(['SHOP_TK', 'PUNISH_ORDER'] as const)(
  '[AC-B1-09v#9] 违规单导入人工选 %s 的「处理中」记录，之后同一违规单号的违规单导入（不传 reason_sub）把它结案：该行原地结案、仍带人工值且 reason_sub_manual=true；订单落 VOID PUNISH 时 orders.reason_sub 为人工值、reason_sub_manual=true',
  async (value) => {
    shareImportStore();
    const s = await setup(h, { grants: CLAIM });
    const w = await punishWorker(h);
    const order = await taobaoOrder(s);
    const id = await storedProcessing(s, order, 'IMPORT', value);

    await importPunish(s, w, 'taobao', [order.sub_order_id], undefined, [NUMBER]);

    expect(await rowsOf(s, order.order_id)).toEqual(closedWith(id, value));
    await expectPunished(s, order.order_id, 'VOID', value);
  },
  120_000,
);

it.each(['FAKE_TRADE', 'MARKET_DISRUPT', NONE] as const)(
  '[AC-B1-09v#9] 淘宝同步先存一条「处理中」违规记录（reason_sub_manual=false），之后同一违规单号的违规单导入带 reason_sub=%s 把它结案：该行原地写回人工值（none 不写子原因）、reason_sub_manual=true；订单落 VOID PUNISH 时 orders.reason_sub 为人工值（none → NULL）、reason_sub_manual=true',
  async (value) => {
    shareImportStore();
    const s = await setup(h, { grants: CLAIM });
    const w = await punishWorker(h);
    const order = await taobaoOrder(s);
    const id = await storedProcessing(s, order, 'API', null);

    await importPunish(s, w, 'taobao', [order.sub_order_id], value, [NUMBER]);

    expect(await rowsOf(s, order.order_id)).toEqual(closedWith(id, value));
    await expectPunished(s, order.order_id, 'VOID', value);
  },
  120_000,
);

it('[AC-B1-09v#9] 已入账淘宝订单上同步存的「处理中」违规记录（manual=false），被同一违规单号的违规单导入带 reason_sub=INSITE_PROMO 结案：该行写回 INSITE_PROMO、manual=true；经真实扣回落 CLAWED_BACK 时 orders.reason_sub=INSITE_PROMO、reason_sub_manual=true', async () => {
  shareImportStore();
  const s = await setup(h, { grants: CLAIM });
  const w = await punishWorker(h);
  const c = await creditedOrder(s, w);
  const id = await storedProcessing(s, c.order, 'API', null);

  await importPunish(s, w, 'taobao', [c.order.sub_order_id], 'INSITE_PROMO', [NUMBER]);

  expect(await rowsOf(s, c.order.order_id)).toEqual(closedWith(id, 'INSITE_PROMO'));
  await expectPunished(s, c.order.order_id, 'CLAWED_BACK', 'INSITE_PROMO');
}, 120_000);

it.each(['RISK_ORDER', NONE] as const)(
  '[AC-B1-09v#9] 两边都带人工值：违规单导入人工选 SHOP_TK 的「处理中」记录，之后同一违规单号的违规单导入带 reason_sub=%s 把它结案：以后到的为准，该行与 orders.reason_sub 都是后到的值（none → NULL）、reason_sub_manual=true',
  async (value) => {
    shareImportStore();
    const s = await setup(h, { grants: CLAIM });
    const w = await punishWorker(h);
    const order = await taobaoOrder(s);
    const id = await storedProcessing(s, order, 'IMPORT', 'SHOP_TK');

    await importPunish(s, w, 'taobao', [order.sub_order_id], value, [NUMBER]);

    expect(await rowsOf(s, order.order_id)).toEqual(closedWith(id, value));
    await expectPunished(s, order.order_id, 'VOID', value);
  },
  120_000,
);
