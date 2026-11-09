// B1-03zl rule-test kit: user order appeals (POST /v1/me/appeals target_type=order; BR-ID-36 ②,
// 拍板第二批 OPS-07, 编排 D10-1181 ②). Real AppModule through the appeals HTTP kit (real device
// signatures, persisted sessions, business-role PG). Orders are real rows seeded with the B1-09p
// order-figures kit (orders, order_keys, commission snapshot), so GET /v1/orders/{order_id} answers
// them through the production readers. "Voided by risk control" is rebate_status VOID with reason
// BLACKLIST (BR-ATTR-26, the voidedOrderOwner rule of B1-03ze). Every execution belongs to the
// isolated container runner.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect } from 'vitest';
import type { RiskState, Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { fixture as orderFixture, type OrderPatch } from '../../orders/figures/kit.ts';
import { client, PATH, type Fixture, type Response } from '../appeals/http-kit.ts';

export {
  accepted,
  appeals,
  events,
  listed,
  openHttp,
  PATH,
  rejected,
  states,
} from '../appeals/http-kit.ts';
export type { Fixture, Response } from '../appeals/http-kit.ts';

/** Inside the default visible range of the fixture clock (2026-10-08). */
export const PAID_AT = '2026-10-01T02:00:00.000Z';

/** A sub-order whose rebate risk control voided (BR-ATTR-26): the order an appeal may target. */
export const VOIDED: OrderPatch = {
  rebate_status: 'VOID',
  reason: 'BLACKLIST',
  platform_status: 'RECEIVED',
  paid_at: PAID_AT,
};

/** The user's own orders that risk control did not void (D10-1181 ②: 20001, not 30701). */
export const NOT_VOIDED: readonly { readonly label: string; readonly patch: OrderPatch }[] = [
  { label: '预估中 ESTIMATED', patch: { rebate_status: 'ESTIMATED', reason: null } },
  { label: '待结算 WAITING', patch: { rebate_status: 'WAITING', reason: null } },
  { label: '已结算 CREDITED', patch: { rebate_status: 'CREDITED', reason: null } },
  { label: '退款作废 VOID + REFUND', patch: { rebate_status: 'VOID', reason: 'REFUND' } },
  { label: '其他作废 VOID + OTHER', patch: { rebate_status: 'VOID', reason: 'OTHER' } },
  { label: '处罚作废 VOID + PUNISH', patch: { rebate_status: 'VOID', reason: 'PUNISH' } },
];

/**
 * A signed-in user of a fresh app (risk state `state`) with an order seeder on that app.
 * `voided` seeds one of the user's own risk-voided orders; `own` one of the user's orders with the
 * given patch; `stranger` a risk-voided order of another user of the same app.
 */
export async function member(f: Fixture, state: RiskState = 'normal') {
  const c = await client(f, state);
  const seeded = await orderFixture(f.db, {
    now: f.clock.now().toISOString(),
    subject: { app_id: c.appId, user_id: c.uid },
  });
  async function own(patch: OrderPatch): Promise<string> {
    return (await seeded.order({ patch: { ...VOIDED, ...patch } })).orderId;
  }
  return {
    ...c,
    own,
    voided: () => own({}),
    async stranger(): Promise<string> {
      const other = randomUUID();
      const o = await seeded.order({
        patch: { ...VOIDED, user_id: other },
        people: [{ userId: other, role: 'self', ratioBp: 5000 }],
      });
      return o.orderId;
    },
  };
}
export type Member = Awaited<ReturnType<typeof member>>;

/** POST /v1/me/appeals on an order (a fresh idempotency key unless `headers` names one). */
export function submitOrder(
  m: Member,
  orderId: string,
  content = '订单返利被作废，请核查。',
  headers: Record<string, string> = {},
): Promise<Response> {
  return m.send('POST', PATH, { target_type: 'order', target_id: orderId, content }, headers);
}

/** POST /v1/me/appeals on the caller's own account. */
export function submitAccount(m: Member, content = '账户申诉'): Promise<Response> {
  return m.send('POST', PATH, { target_type: 'account', content });
}

/**
 * The appeal closer for order appeals (console resolve is B1-03ze's; here a fixture write): closes
 * a processing appeal as `status` one second after the last step. The order stays as it is (an
 * upheld order appeal leaves the order voided).
 */
export async function close(
  f: Fixture,
  appealId: string,
  status: 'upheld' | 'revoked' = 'upheld',
): Promise<void> {
  f.clock.advanceMs(1000);
  const at = f.clock.now();
  const closed = await sql`
    UPDATE app.appeals
    SET status = ${status}, closed_at = ${at}, handler_id = 'fixture_handler',
        updated_at = ${at}, row_version = row_version + 1
    WHERE id = ${appealId} AND status = 'processing'
  `.execute(f.db);
  expect(closed.numAffectedRows, `close ${appealId}`).toBe(1n);
}

/** GET /v1/orders/{order_id} of the member: 200, code 0, the detail. */
export async function orderDetail(m: Member, orderId: string): Promise<Schema<'OrderDetail'>> {
  const response = await m.send('GET', `/v1/orders/${orderId}`);
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  const body = response.json<{ code: number; data: Schema<'OrderDetail'> }>();
  expect(body.code).toBe(0);
  return body.data;
}

/** The app's audit records, as kind of actor and action (what a submission leaves behind). */
export async function audits(f: Fixture, appId: string) {
  const rows = await f.db
    .withSchema('app')
    .selectFrom('audit_logs')
    .select(['id', 'action', 'admin_id', 'system_actor'])
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
  return rows.map((row) => ({
    id: String(row.id),
    action: row.action,
    actor: row.admin_id !== null ? 'admin' : row.system_actor,
  }));
}

/** The app's idempotency claims under `key`. */
export function claims(f: Fixture, appId: string, key: string) {
  return f.db
    .withSchema('app')
    .selectFrom('idempotency_keys')
    .selectAll()
    .where('app_id', '=', appId)
    .where('key', '=', key)
    .execute();
}

/** The appeals rows of the app on one order target. */
export function orderAppeals(f: Fixture, appId: string, orderId: string) {
  return f.db
    .withSchema('app')
    .selectFrom('appeals')
    .selectAll()
    .where('app_id', '=', appId)
    .where('target_type', '=', 'order')
    .where('target_id', '=', orderId)
    .orderBy('created_at')
    .execute();
}
