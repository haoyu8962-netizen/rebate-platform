// B1-09za (D10-969, FU-REASON-SUB-STALE-ROW-MANUAL; B1-09v money r2 S2): 人工对人工以最新为准.
// 08 BR-TEXT-05 子原因 写入来源 ②「人工选择覆盖自动映射」「人工选过的不被自动覆盖」; D10-957: every
// replacement of a sub-reason by a choice made by hand writes order_reason_sub_set.
//   (1) a punish import's choice SHOP_TK is kept on a stored record X 「处理中」 (the order unchanged);
//   (2) the Taobao sync ends the order VOID / CLAWED_BACK PUNISH through another punishment Y
//       (automatic FAKE_TRADE, reason_sub_manual false);
//   (3) the operator's 改子原因 sets MARKET_DISRUPT (by hand, with its own audit);
//   (4) a later input without a choice of its own closes X: the Taobao sync reporting X successful
//       with 「订单虚假交易」, or a punish import of X without reason_sub.
// The choice on X is older than (3): the order keeps MARKET_DISRUPT by hand, no replacement audit
// is written; status, reason and amounts stay. Without (3) the order's automatic FAKE_TRADE gives
// way to X's choice SHOP_TK (by hand), and that replacement writes one order_reason_sub_set record
// (old → new, the stored record named, no personal information).
// Real admin entry (改子原因 over HTTP, permission order.claim), PostgreSQL, the worker's real
// order-sync handler for 'punish.window' (synthetic Taobao adapter only) and rights_import job
// (synthetic templates, ../rights-mounts/templates.ts), settlement's rights command, rebate port and
// clawback; X is seeded as rights.record would have stored it (./kit.ts). Top-level it() only
// (规划/11 §4.3). Only the container runner executes it.
import { afterEach, expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  CLAIM,
  creditedOrder,
  expectManual,
  importPunish,
  orderNow,
  seedUnionAccount,
  setup,
  shareImportStore,
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
  expectStaleRowAudit,
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

it('[AC-B1-09za#1] 违规单导入人工选 SHOP_TK 的记录 X「处理中」入库（订单未变）→ 淘宝同步经另一违规 Y 把订单落 VOID PUNISH（自动 FAKE_TRADE）→ 运营改子原因为 MARKET_DISRUPT → 淘宝同步（真实 punish.window）报 X 成功、「订单虚假交易」：X 原地结案；orders.reason_sub 仍为 MARKET_DISRUPT、reason_sub_manual=true（X 上的旧人工值不覆盖运营之后改的值），不新增 order_reason_sub_set 审计；状态、原因、金额不变', async () => {
  const { s, w, account } = await arrange();
  const order = await taobaoOrder(s);
  const id = await staleRow(s, order, 'SHOP_TK');
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

it('[AC-B1-09za#1] 同上 (1)–(3) 后，结案输入换成同一违规单号 X 的违规单导入（不传 reason_sub）：X 原地结案；orders.reason_sub 仍为 MARKET_DISRUPT、reason_sub_manual=true，不新增 order_reason_sub_set 审计；状态、原因、金额不变', async () => {
  const { s, w, account } = await arrange();
  const order = await taobaoOrder(s);
  const id = await staleRow(s, order, 'SHOP_TK');
  await endedBySync(s, w, account, order, 'VOID');
  await chosenOnOrder(s, order.order_id, 'MARKET_DISRUPT');
  const before = await orderNow(s, order.order_id);
  const countBefore = await setAudits(s);

  await importPunish(s, w, 'taobao', [order.sub_order_id], undefined, [STALE]);

  await expectClosed(s, order.order_id, id);
  await expectManual(s, order.order_id, 'MARKET_DISRUPT', true);
  expect(steady(await orderNow(s, order.order_id))).toEqual(steady(before));
  expect(await setAudits(s)).toBe(countBefore);
}, 120_000);

it('[AC-B1-09za#1] 已入账淘宝订单：违规单导入人工选 SHOP_TK 的记录 X「处理中」入库 → 同步经违规 Y 真实扣回落 CLAWED_BACK PUNISH（自动 FAKE_TRADE）→ 运营改子原因为 RISK_ORDER → 淘宝同步报 X 成功（「订单虚假交易」）：X 原地结案；orders.reason_sub 仍为 RISK_ORDER、reason_sub_manual=true，不新增 order_reason_sub_set 审计；不再扣回，状态、原因、金额不变', async () => {
  const { s, w, account } = await arrange();
  const c = await creditedOrder(s, w);
  const id = await staleRow(s, c.order, 'SHOP_TK');
  await endedBySync(s, w, account, c.order, 'CLAWED_BACK');
  await chosenOnOrder(s, c.order.order_id, 'RISK_ORDER');
  const before = await orderNow(s, c.order.order_id);
  const countBefore = await setAudits(s);

  await w.punish(s, account, [punishmentOf(c.order, STALE, FAKE_TRADE_TEXT)]);

  await expectClosed(s, c.order.order_id, id);
  await expectManual(s, c.order.order_id, 'RISK_ORDER', true);
  expect(steady(await orderNow(s, c.order.order_id))).toEqual(steady(before));
  expect(await setAudits(s)).toBe(countBefore);
}, 120_000);

it('[AC-B1-09za#2] 无改子原因的对照：违规单导入人工选 SHOP_TK 的记录 X「处理中」入库 → 同步经违规 Y 把订单落 VOID PUNISH（自动 FAKE_TRADE、manual=false）→ 淘宝同步报 X 成功（「订单虚假交易」）：X 原地结案；自动值让位于人工值，orders.reason_sub=SHOP_TK、reason_sub_manual=true；写且只写一条 order_reason_sub_set 审计（前值 FAKE_TRADE → 新值 SHOP_TK，指明 X 这条已存记录，无个人信息）；状态、原因、金额不变', async () => {
  const { s, w, account } = await arrange();
  const order = await taobaoOrder(s);
  const id = await staleRow(s, order, 'SHOP_TK');
  await endedBySync(s, w, account, order, 'VOID');
  const before = await orderNow(s, order.order_id);
  const countBefore = await setAudits(s);

  await w.punish(s, account, [punishmentOf(order, STALE, FAKE_TRADE_TEXT)]);

  await expectClosed(s, order.order_id, id);
  await expectManual(s, order.order_id, 'SHOP_TK', true);
  expect(steady(await orderNow(s, order.order_id))).toEqual(steady(before));
  await expectStaleRowAudit(s, order, {
    rowId: id,
    from: 'FAKE_TRADE',
    to: 'SHOP_TK',
    countBefore,
  });
}, 120_000);

it('[AC-B1-09za#2] 无改子原因的对照，结案输入换成同一违规单号 X 的违规单导入（不传 reason_sub）：orders.reason_sub 由自动 FAKE_TRADE 换为 X 上的人工值 SHOP_TK、reason_sub_manual=true；写且只写一条 order_reason_sub_set 审计（前值 FAKE_TRADE → 新值 SHOP_TK，指明 X，无个人信息）；状态、原因、金额不变', async () => {
  const { s, w, account } = await arrange();
  const order = await taobaoOrder(s);
  const id = await staleRow(s, order, 'SHOP_TK');
  await endedBySync(s, w, account, order, 'VOID');
  const before = await orderNow(s, order.order_id);
  const countBefore = await setAudits(s);

  await importPunish(s, w, 'taobao', [order.sub_order_id], undefined, [STALE]);

  await expectClosed(s, order.order_id, id);
  await expectManual(s, order.order_id, 'SHOP_TK', true);
  expect(steady(await orderNow(s, order.order_id))).toEqual(steady(before));
  await expectStaleRowAudit(s, order, {
    rowId: id,
    from: 'FAKE_TRADE',
    to: 'SHOP_TK',
    countBefore,
  });
}, 120_000);
