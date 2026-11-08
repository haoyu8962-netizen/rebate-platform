// B1-09za rule-test kit (claude-independent, SPEC_REF 29c27a1b): 08 BR-TEXT-05「子原因 reason_sub」
// 写入来源 ②「人工选择覆盖自动映射」「人工选过的不被自动覆盖」, D10-957 and D10-969 (人工对人工以最新为准):
//   - a choice by hand kept on a stored order_rights record 「处理中」 is older than any choice the
//     operator made on the order afterwards (改子原因, adminSetOrderReasonSub); a later input without
//     a choice of its own (the Taobao sync, an import without reason_sub) that closes the record
//     never replaces the order's later choice by hand;
//   - whenever a choice by hand does replace the sub-reason of an order already ended PUNISH, one
//     audit record order_reason_sub_set is written (old → new, no personal information).
// Builds on the frozen ../reason-sub-manual/kit.ts and ./sync-kit.ts (imported, never changed): the
// admin entry, the worker entry's real AppModule (rights_import job, order-sync 'punish.window' with
// a synthetic Taobao adapter only, settlement's rights command, rebate port and clawback),
// PostgreSQL as couli_app. As ../reason-sub-manual/resolve.int.test.ts does, a stored PUNISH record
// 「处理中」 is seeded as rights.record would have left it: no platform or template on main delivers
// a PUNISH 「处理中」 yet (BR-FUND-06 待验证). No real user or merchant data. This kit opens no
// database: the harness comes from the *.int.test.ts file. Only the container runner executes them.
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import {
  NONE,
  OCCURRED,
  SET_AUDIT,
  auditsOf,
  detailAnswer,
  expectManual,
  jsonOf,
  orderNow,
  rightsOfOrder,
  setReasonSub,
  untouched,
  type Order,
  type Scenario,
} from '../reason-sub-manual/kit.ts';
import { FAKE_TRADE_TEXT, punishmentOf, type PunishWorker } from '../reason-sub-manual/sync-kit.ts';

/** The 违规单号 of the stored record 「处理中」 (X) and of the input that later closes it. */
export const STALE = 'TB-STALE-X';
/** The 违规单号 of the punishment (Y) through which the sync ends the order first. */
export const FIRST = 'TB-FIRST-Y';

/**
 * A PUNISH record 「处理中」 of `order` under STALE, as rights.record would have stored it from a
 * punish import whose reason_sub was `byHand` (reason_sub_manual true), with orders.rights_pending
 * set with it; the order's own sub-reason is not changed by it. Returns the row's id.
 */
export async function staleRow(s: Scenario, order: Order, byHand: string): Promise<string> {
  const id = randomUUID();
  const at = new Date(OCCURRED);
  await s.h.db
    .insertInto('order_rights')
    .values({
      id,
      app_id: s.appId,
      order_id: order.order_id,
      source: 'IMPORT',
      type: 'PUNISH',
      status: 'PROCESSING',
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
  await s.h.db
    .updateTable('orders')
    .set({ rights_pending: true })
    .where('app_id', '=', s.appId)
    .where('order_id', '=', order.order_id)
    .execute();
  return id;
}

/**
 * The real Taobao sync ends `order` for PUNISH through punishment FIRST with 「订单虚假交易」: VOID
 * (or CLAWED_BACK when it was credited), automatic FAKE_TRADE, reason_sub_manual false.
 */
export async function endedBySync(
  s: Scenario,
  w: PunishWorker,
  account: string,
  order: Order,
  status: 'VOID' | 'CLAWED_BACK',
): Promise<void> {
  await w.punish(s, account, [punishmentOf(order, FIRST, FAKE_TRADE_TEXT)]);
  expect(await orderNow(s, order.order_id)).toMatchObject({
    rebate_status: status,
    reason: 'PUNISH',
  });
  await expectManual(s, order.order_id, 'FAKE_TRADE', false);
}

/** The operator's 改子原因 through the admin entry (HTTP 200), on the order as it stands. */
export async function chosenOnOrder(s: Scenario, orderId: string, value: string): Promise<void> {
  const now = await orderNow(s, orderId);
  await detailAnswer(
    await setReasonSub(s, orderId, { reason_sub: value, expected_row_version: now.row_version }),
  );
  await expectManual(s, orderId, value === NONE ? null : value, true);
}

/** The stored record STALE of the order, closed in place (same id, SUCCEEDED). */
export async function expectClosed(s: Scenario, orderId: string, id: string): Promise<void> {
  const rows = await rightsOfOrder(s, orderId);
  const row = rows.find((entry) => entry.platform_rights_no === STALE);
  expect({ id: row?.id, status: row?.status }).toEqual({ id, status: 'SUCCEEDED' });
}

/**
 * The order without the columns a sub-reason write may change, nor rights_pending (closing the
 * record 「处理中」 recomputes it): status, reason and amounts must stay.
 */
export function steady(order: Order) {
  const rest = untouched(order);
  delete rest['rights_pending'];
  return rest;
}

/** The number of order_reason_sub_set records of the scenario's app. */
export async function setAudits(s: Scenario): Promise<number> {
  return (await auditsOf(s, SET_AUDIT)).length;
}

/**
 * The one new order_reason_sub_set record written when the stored record's choice by hand replaced
 * the order's sub-reason: target the order, before / after reason_sub old → new, the stored record
 * named (its order_rights id or its 违规单号) so the source of the change can be told, a source
 * given, and no personal information. No source string is pinned: D10-969 names none for a choice
 * carried by a stored record (D10-957's rights_import names the import that made the choice, which
 * the stored record does not keep); neither is the actor (a sync closes it without an admin).
 */
export async function expectStaleRowAudit(
  s: Scenario,
  order: Order,
  expected: {
    readonly rowId: string;
    readonly from: string | null;
    readonly to: string | null;
    readonly countBefore: number;
  },
): Promise<void> {
  const audits = await auditsOf(s, SET_AUDIT);
  expect(audits).toHaveLength(expected.countBefore + 1);
  const audit = audits[audits.length - 1];
  expect(String(audit?.target)).toContain(order.order_id);
  const old = jsonOf(audit?.before);
  const now = jsonOf(audit?.after);
  expect(old).toMatchObject({ reason_sub: expected.from });
  expect(now).toMatchObject({ reason_sub: expected.to });
  const detail = { ...(old ?? {}), ...(now ?? {}) };
  expect(typeof detail['source'] === 'string' && detail['source'] !== '').toBe(true);
  const values = Object.values(detail);
  expect(values.includes(expected.rowId) || values.includes(STALE)).toBe(true);
  const text = JSON.stringify([audit?.before ?? null, audit?.after ?? null]);
  for (const secret of [order.sub_order_id, order.parent_order_id, s.userId]) {
    expect(text).not.toContain(String(secret));
  }
}
