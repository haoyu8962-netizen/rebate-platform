// B1-09v round 3 (D10-957, money r1 S2 ①): a punish import of the same 违规单号 the sync already
// recorded. The Taobao sync (real punish.window, ./sync-kit.ts) ended the order VOID / CLAWED_BACK
// for PUNISH with the automatic sub-reason (「订单虚假交易」→ FAKE_TRADE, reason_sub_manual false);
// settlement's rights command takes the import's row of that number as a duplicate of the stored
// record (K-2 key; no second row, no second clawback). D10-957:
//   - the import carries an explicit sub-reason by hand (not absent, not `none`) → orders.reason_sub
//     becomes it with reason_sub_manual true (08 BR-TEXT-05 写入来源 ②「人工选择覆盖自动映射」),
//     and one audit record order_reason_sub_set is written: source `rights_import`, that import's
//     id, the old and the new value, the order's reason; the actor is the admin who created the
//     import; no personal information. Amounts, rebate_status, platform_status and reason stay;
//   - by hand over by hand: the latest import wins, with its own audit record;
//   - a duplicate row without a choice by hand only does what it did before (the automatic refine
//     of B2-04zze) and never touches a value chosen by hand; no audit record.
// Real admin entry, permissions and PostgreSQL; the worker's real rights_import job (synthetic
// templates, ../rights-mounts/templates.ts) and order-sync handler, settlement's rights command,
// rebate port and clawback. Top-level it() only (规划/11 §4.3). Only the container runner executes it.
import { afterEach, expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import type { RightsImportJob } from '../rights-mounts/templates.ts';
import {
  CLAIM,
  SET_AUDIT,
  auditsOf,
  available,
  creditedOrder,
  detailAnswer,
  expectManual,
  importPunish,
  imported,
  jsonOf,
  orderNow,
  punishFields,
  punishRows,
  rightsOfOrder,
  seedUnionAccount,
  setReasonSub,
  setup,
  shareImportStore,
  untouched,
  type Order,
  type Scenario,
} from './kit.ts';
import {
  FAKE_TRADE_TEXT,
  punishWorker,
  punishmentOf,
  taobaoOrder,
  type PunishWorker,
} from './sync-kit.ts';

vi.mock('../../../../apps/api/src/modules/orders/jobs/rights-import.ts', async (importOriginal) =>
  (await import('../rights-mounts/templates.ts')).withTemplates(
    await importOriginal<RightsImportJob>(),
  ),
);

const h = useHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

/** The 违规单号 the sync recorded and the imports repeat. */
const NUMBER = 'TB-DUPLICATE-1';

/** One scenario: admin entry, the worker with a Taobao punishment source, a Taobao union account. */
async function arrange() {
  shareImportStore();
  const s = await setup(h, { grants: CLAIM });
  const w = await punishWorker(h);
  const account = await seedUnionAccount(s, 'taobao');
  return { s, w, account };
}

/**
 * `order` punished by the real sync under NUMBER with 「订单虚假交易」: it ends `status` for PUNISH
 * with the automatic FAKE_TRADE (reason_sub_manual false).
 */
async function punishedBySync(
  s: Scenario,
  w: PunishWorker,
  account: string,
  order: Order,
  status: 'VOID' | 'CLAWED_BACK',
): Promise<void> {
  await w.punish(s, account, [punishmentOf(order, NUMBER, FAKE_TRADE_TEXT)]);
  expect(await orderNow(s, order.order_id)).toMatchObject({
    rebate_status: status,
    reason: 'PUNISH',
  });
  await expectManual(s, order.order_id, 'FAKE_TRADE', false);
}

/** The order still has the one record of NUMBER: the import's row was a duplicate. */
async function expectOneRecord(s: Scenario, orderId: string): Promise<void> {
  const rows = await rightsOfOrder(s, orderId);
  expect(rows.map((row) => [row.type, row.platform_rights_no, row.status])).toEqual([
    ['PUNISH', NUMBER, 'SUCCEEDED'],
  ]);
}

/** Asserts the one new order_reason_sub_set record an import's choice by hand wrote. */
async function expectImportAudit(
  s: Scenario,
  order: Order,
  expected: {
    readonly importId: string;
    readonly adminId: string;
    readonly from: string | null;
    readonly to: string | null;
    readonly countBefore: number;
  },
): Promise<void> {
  const audits = await auditsOf(s, SET_AUDIT);
  expect(audits).toHaveLength(expected.countBefore + 1);
  const audit = audits[audits.length - 1];
  expect(audit).toMatchObject({ admin_id: expected.adminId });
  expect(String(audit?.target)).toContain(order.order_id);
  const old = jsonOf(audit?.before);
  const now = jsonOf(audit?.after);
  expect(old).toMatchObject({ reason_sub: expected.from });
  expect(now).toMatchObject({ reason_sub: expected.to });
  expect(now?.['reason'] ?? old?.['reason']).toBe('PUNISH');
  const detail = { ...(old ?? {}), ...(now ?? {}) };
  expect(detail['source']).toBe('rights_import');
  expect(Object.values(detail)).toContain(expected.importId);
  const text = JSON.stringify([audit?.before ?? null, audit?.after ?? null]);
  for (const secret of [order.sub_order_id, order.parent_order_id, s.userId]) {
    expect(text).not.toContain(String(secret));
  }
}

it.each(['SHOP_TK', 'RISK_ORDER', 'PUNISH_ORDER'] as const)(
  '[AC-B1-09v#10] 同步已把淘宝订单落 VOID PUNISH、自动值 FAKE_TRADE（manual=false）后，运营导入同一违规单号且显式带 reason_sub=%s：orders.reason_sub 覆盖为人工值、reason_sub_manual=true；审计 order_reason_sub_set 一条（source=rights_import、该导入 id、前值 FAKE_TRADE → 新值、原因 PUNISH，操作人为导入创建人，无个人信息）；金额、状态、原因不变，记录仍一条',
  async (value) => {
    const { s, w, account } = await arrange();
    const order = await taobaoOrder(s);
    await punishedBySync(s, w, account, order, 'VOID');
    const before = await orderNow(s, order.order_id);
    const countBefore = (await auditsOf(s, SET_AUDIT)).length;

    const importId = await importPunish(s, w, 'taobao', [order.sub_order_id], value, [NUMBER]);

    await expectManual(s, order.order_id, value, true);
    expect(untouched(await orderNow(s, order.order_id))).toEqual(untouched(before));
    await expectOneRecord(s, order.order_id);
    await expectImportAudit(s, order, {
      importId,
      adminId: s.admin.id,
      from: 'FAKE_TRADE',
      to: value,
      countBefore,
    });
  },
  120_000,
);

it('[AC-B1-09v#10] 已入账淘宝订单经同步扣回落 CLAWED_BACK、自动值 FAKE_TRADE 后，导入同一违规单号带 reason_sub=SHOP_TK：orders.reason_sub=SHOP_TK、reason_sub_manual=true，审计一条（source=rights_import）；不再扣回，余额、金额、状态不变', async () => {
  const { s, w, account } = await arrange();
  const c = await creditedOrder(s, w);
  await punishedBySync(s, w, account, c.order, 'CLAWED_BACK');
  const before = await orderNow(s, c.order.order_id);
  const balances = [
    await available(s, c.self),
    await available(s, c.direct),
    await available(s, c.indirect),
  ];
  const countBefore = (await auditsOf(s, SET_AUDIT)).length;

  const importId = await importPunish(s, w, 'taobao', [c.order.sub_order_id], 'SHOP_TK', [NUMBER]);

  await expectManual(s, c.order.order_id, 'SHOP_TK', true);
  expect(untouched(await orderNow(s, c.order.order_id))).toEqual(untouched(before));
  expect([
    await available(s, c.self),
    await available(s, c.direct),
    await available(s, c.indirect),
  ]).toEqual(balances);
  await expectOneRecord(s, c.order.order_id);
  await expectImportAudit(s, c.order, {
    importId,
    adminId: s.admin.id,
    from: 'FAKE_TRADE',
    to: 'SHOP_TK',
    countBefore,
  });
}, 120_000);

it('[AC-B1-09v#11] 人工对人工：同一违规单号先由一次导入人工选 SHOP_TK 覆盖自动值，再由另一位运营的导入人工选 RISK_ORDER：以最新一次导入为准（RISK_ORDER、manual=true），各留一条审计，第二条前值 SHOP_TK、后值 RISK_ORDER、导入 id 与操作人是第二次导入的', async () => {
  const { s, w, account } = await arrange();
  const order = await taobaoOrder(s);
  await punishedBySync(s, w, account, order, 'VOID');
  const before = await orderNow(s, order.order_id);
  const countBefore = (await auditsOf(s, SET_AUDIT)).length;

  const first = await importPunish(s, w, 'taobao', [order.sub_order_id], 'SHOP_TK', [NUMBER]);
  await expectImportAudit(s, order, {
    importId: first,
    adminId: s.admin.id,
    from: 'FAKE_TRADE',
    to: 'SHOP_TK',
    countBefore,
  });

  const other = await s.caller(CLAIM);
  const second = await imported(
    s,
    w,
    punishFields('taobao', 'RISK_ORDER'),
    punishRows([order.sub_order_id], [NUMBER]),
    { caller: other },
  );

  await expectManual(s, order.order_id, 'RISK_ORDER', true);
  expect(untouched(await orderNow(s, order.order_id))).toEqual(untouched(before));
  await expectOneRecord(s, order.order_id);
  await expectImportAudit(s, order, {
    importId: second,
    adminId: other.id,
    from: 'SHOP_TK',
    to: 'RISK_ORDER',
    countBefore: countBefore + 1,
  });
}, 120_000);

it('[AC-B1-09v#11] 人工对人工：同步落 VOID PUNISH 后运营先在订单详情改子原因为 MARKET_DISRUPT，再导入同一违规单号显式带 reason_sub=SHOP_TK：以最新一次人工选择为准（SHOP_TK、manual=true），导入另留一条审计（source=rights_import、前值 MARKET_DISRUPT）', async () => {
  const { s, w, account } = await arrange();
  const order = await taobaoOrder(s);
  await punishedBySync(s, w, account, order, 'VOID');
  const now = await orderNow(s, order.order_id);
  await detailAnswer(
    await setReasonSub(s, order.order_id, {
      reason_sub: 'MARKET_DISRUPT',
      expected_row_version: now.row_version,
    }),
  );
  await expectManual(s, order.order_id, 'MARKET_DISRUPT', true);
  const before = await orderNow(s, order.order_id);
  const countBefore = (await auditsOf(s, SET_AUDIT)).length;

  const importId = await importPunish(s, w, 'taobao', [order.sub_order_id], 'SHOP_TK', [NUMBER]);

  await expectManual(s, order.order_id, 'SHOP_TK', true);
  expect(untouched(await orderNow(s, order.order_id))).toEqual(untouched(before));
  await expectImportAudit(s, order, {
    importId,
    adminId: s.admin.id,
    from: 'MARKET_DISRUPT',
    to: 'SHOP_TK',
    countBefore,
  });
}, 120_000);

it('[AC-B1-09v#12] 导入同一违规单号人工选 SHOP_TK 覆盖自动值之后，重复行没带人工值：再导入同一违规单号（不传 reason_sub）与同步重放同一违规（「订单虚假交易」）都不碰人工值（SHOP_TK、manual=true）、不写审计；同一页的自动对照单（PUNISH_ORDER、manual=false）照现状细化为 FAKE_TRADE', async () => {
  const { s, w, account } = await arrange();
  const order = await taobaoOrder(s);
  await punishedBySync(s, w, account, order, 'VOID');
  const countBefore = (await auditsOf(s, SET_AUDIT)).length;
  const importId = await importPunish(s, w, 'taobao', [order.sub_order_id], 'SHOP_TK', [NUMBER]);
  await expectImportAudit(s, order, {
    importId,
    adminId: s.admin.id,
    from: 'FAKE_TRADE',
    to: 'SHOP_TK',
    countBefore,
  });
  const before = await orderNow(s, order.order_id);

  await importPunish(s, w, 'taobao', [order.sub_order_id], undefined, [NUMBER]);

  await expectManual(s, order.order_id, 'SHOP_TK', true);
  expect(await auditsOf(s, SET_AUDIT)).toHaveLength(countBefore + 1);

  const control = await taobaoOrder(s, {
    rebate_status: 'VOID',
    reason: 'PUNISH',
    reason_sub: 'PUNISH_ORDER',
    reason_sub_manual: false,
  });
  await w.punish(s, account, [
    punishmentOf(order, NUMBER, FAKE_TRADE_TEXT),
    punishmentOf(control, 'TB-CONTROL', FAKE_TRADE_TEXT),
  ]);

  await expectManual(s, control.order_id, 'FAKE_TRADE', false);
  await expectManual(s, order.order_id, 'SHOP_TK', true);
  expect(untouched(await orderNow(s, order.order_id))).toEqual(untouched(before));
  await expectOneRecord(s, order.order_id);
  expect(await auditsOf(s, SET_AUDIT)).toHaveLength(countBefore + 1);
}, 120_000);
