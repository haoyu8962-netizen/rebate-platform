// B1-09v rule-test kit (claude-independent, SPEC_REF 7666a46e): the manual sub-reason of an order
// (08 12_TEXT BR-TEXT-05「子原因 reason_sub」写入来源 ② 后台人工; D10-818, D10-819 ①③, D10-944).
//   - adminCreateRightsImport takes an optional `reason_sub` part (punish only: one of the 12 PUNISH
//     sub-reasons or `none`); rights_imports.reason_sub keeps it, the detail and the list echo it,
//     the import audit carries it; every order_rights row the import writes carries it with
//     reason_sub_manual = true (migration 0131: reason_sub NULL while manual is false), and the order
//     the import marks PUNISH gets it with orders.reason_sub_manual = true (`none` → NULL);
//   - adminSetOrderReasonSub (POST /admin/v1/orders/{order_id}/reason-sub, permission order.claim):
//     only a sub-reason of the order's current reason, or `none`; only reason_sub (and the manual
//     flag) change; one audit record order_reason_sub_set with the old and new value and the reason;
//   - a value chosen by hand is never overwritten by a later automatic write.
// Real pieces: everything ../rights-mounts/kit.ts starts — the admin entry (createHttpApp('admin'):
// admin token, session, permission check, step-up gate over Redis, contract validation, multipart,
// the started JOB_QUEUE), the worker entry's AppModule with its order-sync and settle handlers
// (settlement's rights command, rebate port and clawback over the real ledger), PostgreSQL as
// couli_app. Synthetic: orders, snapshots and members seeded as the sync would have left them, the
// column templates (../rights-mounts/templates.ts, K-3), one memory import store shared by both
// entries. No real user or merchant data. Nothing here imports the implementation's internals: the
// automatic mapping (B2-04zze) is only reached through the same real entries.
// Only the container runner executes the integration tests.
import type { DB } from '@couli/db';
import type { Insertable } from 'kysely';
import { expect } from 'vitest';
import type { Response } from '../../admin/auth/kit.ts';
import { seedOrder, type Order, type Send } from '../admin-mounts/kit.ts';
import {
  ANSWER,
  IMPORTS,
  OCCURRED,
  TEMPLATES,
  accepted,
  attributedOrder,
  imported,
  orderNow,
  rightsOf,
  type Scenario,
  type Worker,
} from '../rights-mounts/kit.ts';
import { form, xlsx } from '../rights-import-task/kit.ts';

export {
  ANSWER,
  IMPORTS,
  OCCURRED,
  TEMPLATES,
  accepted,
  attributedOrder,
  imported,
  orderNow,
  rightsOf,
  seedOrder,
};
export {
  DENIED,
  available,
  creditedOrder,
  detailOf,
  queued,
  refused,
  seedUnionAccount,
  setup,
  shareImportStore,
  voucherKeys,
  worker,
} from '../rights-mounts/kit.ts';
export type { Order, Scenario, Send, Worker };

/** specs/permissions.yaml: the import and the 改子原因 action both need order.claim only. */
export const CLAIM = ['order.claim'] as const;
/** A channel import also needs risk.blocklist (totp step-up). */
export const CHANNEL_GRANTS = ['order.claim', 'risk.blocklist'] as const;

/** enum order_reason_sub, by parent reason (contracts/enums/order.yaml; CT-24zw). */
export const PUNISH_SUBS = [
  'VIOLATION_PROMO',
  'SHOP_TK',
  'INSITE_PROMO',
  'PROXY_BUY',
  'FAKE_TRADE',
  'INSITE_RESALE',
  'OVER_LIMIT',
  'MARKET_DISRUPT',
  'MULTI_TRADE_ABNORMAL',
  'SINGLE_TRADE_ABNORMAL',
  'RISK_ORDER',
  'PUNISH_ORDER',
] as const;
export const REFUND_SUBS = ['IN_SALE', 'AFTER_SETTLE'] as const;
export const RIGHTS_SUBS = ['AFTER_SALE'] as const;
/** 「无」: no sub-reason is written, the choice still counts as made by hand. */
export const NONE = 'none';

export const IMPORT_AUDIT = 'rights_import_create';
export const SET_AUDIT = 'order_reason_sub_set';

export const reasonSubPath = (orderId: string) => `/admin/v1/orders/${orderId}/reason-sub`;
export const fieldsError = (...fields: string[]) => ({ fields });

/** Columns a seeded order may set. */
export type OrderPatch = Partial<Insertable<DB['orders']>>;

// ---------------------------------------------------------------------------------------------
// Imports through the admin entry, run by the worker's real rights_import job.

/** The punish file: one row per sub-order, 违规单号 PN-<n> (or as given). */
export function punishRows(subOrderIds: readonly string[], numbers?: readonly string[]) {
  return [
    Object.values(TEMPLATES.punish.columns),
    ...subOrderIds.map((sub, i) => [sub, numbers?.[i] ?? `PN-${i + 1}`, '3.00', null, OCCURRED]),
  ];
}

/** The rights file: one SUCCEEDED row per sub-order with the given deduction (yuan). */
export function rightsRows(subOrderIds: readonly string[], deduction: string | null) {
  return [
    Object.values(TEMPLATES.rights.columns),
    ...subOrderIds.map((sub, i) => [sub, `RN-${i + 1}`, 'SUCCEEDED', '29.90', deduction, OCCURRED]),
  ];
}

/** The text parts of a punish import; `reasonSub` undefined sends no reason_sub part at all. */
export function punishFields(platform: string, reasonSub?: string): Record<string, string> {
  return reasonSub === undefined
    ? { kind: 'punish', platform }
    : { kind: 'punish', platform, reason_sub: reasonSub };
}

/** A punish import of `subOrderIds` uploaded and run; its import_id. */
export function importPunish(
  s: Scenario,
  w: Worker,
  platform: string,
  subOrderIds: readonly string[],
  reasonSub?: string,
  numbers?: readonly string[],
): Promise<string> {
  return imported(s, w, punishFields(platform, reasonSub), punishRows(subOrderIds, numbers));
}

/** An upload of the given text parts over a one-row punish file, without checking the answer. */
export function upload(
  s: Scenario,
  fields: Readonly<Record<string, string>>,
  subOrderId: string,
  options: Send = {},
): Promise<Response> {
  return s.upload(form(fields, xlsx(punishRows([subOrderId]))), options);
}

/** The stored task row of `importId` (rights_imports), or undefined. */
export async function importRow(s: Scenario, importId: string) {
  return (await s.state()).imports.find((row) => row.id === importId);
}

/** The list item of `importId` on the first page of the admin list. */
export async function listItem(s: Scenario, importId: string) {
  const page = await accepted<{ items: readonly Record<string, unknown>[] }>(
    await s.get(`${IMPORTS}?page=1&page_size=20`),
    ANSWER.list,
  );
  return page.items.find((item) => item['import_id'] === importId);
}

/** The order_rights rows of one order, by 违规 / 维权 number. */
export async function rightsOfOrder(s: Scenario, orderId: string) {
  const rows = await rightsOf(s);
  return rows
    .filter((row) => row.order_id === orderId)
    .sort((a, b) => String(a.platform_rights_no).localeCompare(String(b.platform_rights_no)));
}

/** The manual columns of an order_rights row. */
export const manualOf = (row: { reason_sub: string | null; reason_sub_manual: boolean }) => ({
  reason_sub: row.reason_sub,
  reason_sub_manual: row.reason_sub_manual,
});

/** The app's audit records of one action. */
export async function auditsOf(s: Scenario, action: string) {
  return (await s.state()).audits.filter((row) => row.action === action);
}

/** An audit's stored before / after as plain objects (jsonb, or a JSON text). */
export function jsonOf(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

// ---------------------------------------------------------------------------------------------
// 改子原因 through the admin entry.

export interface SetBody {
  readonly reason_sub: unknown;
  readonly expected_row_version: unknown;
}

export function setReasonSub(
  s: Scenario,
  orderId: string,
  body: SetBody,
  options: Send = {},
): Promise<Response> {
  return s.post(reasonSubPath(orderId), body, options);
}

/** A sub-order attributed to the scenario's user with the given reason (VOID unless patched). */
export function reasonedOrder(
  s: Scenario,
  reason: string | null,
  patch: OrderPatch = {},
): Promise<Order> {
  return attributedOrder(s, {
    rebate_status: reason === null ? 'ESTIMATED' : 'VOID',
    reason,
    ...patch,
  });
}

/** An order row without the columns 改子原因 may change (reason_sub, its flag, CAS version, time). */
export function untouched(order: Order) {
  const rest: Record<string, unknown> = { ...order };
  for (const key of ['reason_sub', 'reason_sub_manual', 'row_version', 'updated_at']) {
    delete rest[key];
  }
  return rest;
}

/** What a refused 改子原因 must leave exactly as it was. */
export async function frozen(s: Scenario) {
  const state = await s.state();
  return {
    orders: state.orders,
    history: state.history,
    audits: state.audits,
    events: state.events,
  };
}

/** HTTP 200 with the admin order detail; the data. */
export async function detailAnswer(response: Response) {
  return accepted<Record<string, unknown>>(response, 'AdminOrderDetailResponse');
}

/** Asserts the order's manual sub-reason columns. */
export async function expectManual(
  s: Scenario,
  orderId: string,
  reasonSub: string | null,
  manual: boolean,
): Promise<void> {
  const row = await orderNow(s, orderId);
  expect({ reason_sub: row.reason_sub, reason_sub_manual: row.reason_sub_manual }).toEqual({
    reason_sub: reasonSub,
    reason_sub_manual: manual,
  });
}
