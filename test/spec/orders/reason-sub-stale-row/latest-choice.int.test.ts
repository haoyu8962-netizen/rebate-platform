// B1-09za round 2 (rule-test review r1, two S2): more of 人工对人工以最新为准 (D10-969). 08 BR-TEXT-05
// 子原因 写入来源 ②「人工选择覆盖自动映射」「人工选过的不被自动覆盖」; D10-957: a replacement by a choice
// made by hand writes order_reason_sub_set.
//   ① the operator's later choice is 「无」 (改子原因 = none: reason_sub NULL, by hand): an older choice
//     kept on a stored record 「处理中」 closed afterwards by the Taobao sync does not fill it;
//   ② the older choice sits on a stored record the sync closed as FAILED (source API, a choice by
//     hand on it), which the sync later reports successful (D10-699 reopen, the audit port wired in
//     the worker): the operator's later MARKET_DISRUPT stays, no replacement audit is written.
// No entry on main writes a choice by hand onto a FAILED API punishment, so ②'s record is seeded as
// rights.record would have stored it (as ../reason-sub-manual/resolve.int.test.ts seeds 「处理中」);
// everything after is real: admin entry (改子原因 over HTTP, permission order.claim), PostgreSQL as
// couli_app, the worker's order-sync handler for 'punish.window' (synthetic Taobao adapter only),
// settlement's rights command and rebate port. Top-level it() only (规划/11 §4.3). Only the
// container runner executes it.
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  CLAIM,
  NONE,
  OCCURRED,
  expectManual,
  orderNow,
  seedUnionAccount,
  setup,
  shareImportStore,
  type Order,
  type Scenario,
} from '../reason-sub-manual/kit.ts';
import {
  FAKE_TRADE_TEXT,
  punishWorker,
  punishmentOf,
  taobaoOrder,
} from '../reason-sub-manual/sync-kit.ts';
import type { RightsImportJob } from '../rights-mounts/templates.ts';
import {
  STALE,
  chosenOnOrder,
  endedBySync,
  expectClosed,
  setAudits,
  staleRow,
  steady,
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

/** One scenario: admin entry, the worker with a Taobao punishment source, a Taobao union account. */
async function arrange() {
  shareImportStore();
  const s = await setup(h, { grants: CLAIM });
  const w = await punishWorker(h);
  const account = await seedUnionAccount(s, 'taobao');
  return { s, w, account };
}

/**
 * A PUNISH record of `order` under STALE that the sync closed as FAILED (source API), carrying the
 * choice by hand `byHand` (reason_sub_manual true), as rights.record would have stored it; not
 * pending, so orders.rights_pending is left alone. Returns the row's id.
 */
async function failedApiRow(s: Scenario, order: Order, byHand: string): Promise<string> {
  const id = randomUUID();
  const at = new Date(OCCURRED);
  await s.h.db
    .insertInto('order_rights')
    .values({
      id,
      app_id: s.appId,
      order_id: order.order_id,
      source: 'API',
      type: 'PUNISH',
      status: 'FAILED',
      amount_fen: null,
      deduction_commission_fen: null,
      occurred_at: at,
      platform_rights_no: STALE,
      created_at: at,
      updated_at: at,
      reason_sub: byHand,
      reason_sub_manual: true,
    })
    .execute();
  return id;
}

it('[AC-B1-09za#1] 运营之后改的是「无」：违规单导入人工选 SHOP_TK 的记录 X「处理中」入库 → 淘宝同步经另一违规 Y 把订单落 VOID PUNISH（自动 FAKE_TRADE）→ 运营改子原因为 none（reason_sub NULL、manual=true）→ 淘宝同步报 X 成功（「订单虚假交易」）：X 原地结案；orders.reason_sub 仍为 NULL、reason_sub_manual=true（X 上的旧人工值不填进运营之后选的「无」），不新增 order_reason_sub_set 审计；状态、原因、金额不变', async () => {
  const { s, w, account } = await arrange();
  const order = await taobaoOrder(s);
  const id = await staleRow(s, order, 'SHOP_TK');
  await endedBySync(s, w, account, order, 'VOID');
  await chosenOnOrder(s, order.order_id, NONE);
  const before = await orderNow(s, order.order_id);
  const countBefore = await setAudits(s);

  await w.punish(s, account, [punishmentOf(order, STALE, FAKE_TRADE_TEXT)]);

  await expectClosed(s, order.order_id, id);
  await expectManual(s, order.order_id, null, true);
  expect(steady(await orderNow(s, order.order_id))).toEqual(steady(before));
  expect(await setAudits(s)).toBe(countBefore);
}, 120_000);

it('[AC-B1-09za#5] 已存同步记录 X 已结案 FAILED（source API、带人工值 SHOP_TK）→ 淘宝同步经另一违规 Y 把订单落 VOID PUNISH（自动 FAKE_TRADE）→ 运营改子原因为 MARKET_DISRUPT → 淘宝同步报 X 成功（「订单虚假交易」，D10-699 重开）：X 原地改为 SUCCEEDED；orders.reason_sub 仍为 MARKET_DISRUPT、reason_sub_manual=true（重开记录上的旧人工值不覆盖运营之后改的值），不新增 order_reason_sub_set 审计；状态、原因、金额不变', async () => {
  const { s, w, account } = await arrange();
  const order = await taobaoOrder(s);
  const id = await failedApiRow(s, order, 'SHOP_TK');
  await endedBySync(s, w, account, order, 'VOID');
  await chosenOnOrder(s, order.order_id, 'MARKET_DISRUPT');
  const before = await orderNow(s, order.order_id);
  const countBefore = await setAudits(s);

  await w.punish(s, account, [punishmentOf(order, STALE, FAKE_TRADE_TEXT)]);

  await expectClosed(s, order.order_id, id);
  await expectManual(s, order.order_id, 'MARKET_DISRUPT', true);
  expect(steady(await orderNow(s, order.order_id))).toEqual(steady(before));
  expect(await setAudits(s)).toBe(countBefore);
}, 120_000);
