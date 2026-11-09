// B1-10p rule-test kit (claude-independent, SPEC_REF d5713bf4; FU-ADMIN-WRITE-READBACK-BLANK,
// D10-1042, D10-1048 ①②): the detail a console write answers with is blanked by the account's
// permission points exactly as the matching read is, and the points never decide who is let in.
//
//   adminHoldOrder / adminUnholdOrder  order.hold         no order.view → last_hold_note,
//   adminReassignOrder                 order.assign       commission_rate_bp and
//   adminSetOrderReasonSub             order.claim        commission_split.reserve_bp null
//   adminEditUserProfile               user.phone_change  no risk.* point → risk.reason null
//
// Built on the frozen kits of B1-10m (orders/admin-mounts), B1-10i (orders/admin-orders-read), B1-27b
// (identity/admin-profile), F1-07b (identity/admin-users) and B1-10o (lookup-blank-fields), which are
// imported and not changed. Real pieces: the admin entry (admin token, session, permission check,
// step-up gate, route schema), settlement's ports, PostgreSQL as couli_app, Redis. Every expected
// value comes from what was seeded here or from the read a super admin gets after the write; the
// contract's response schema is checked on every answer.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Insertable } from 'kysely';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { Harness, Response } from '../auth/kit.ts';
import {
  DENIED,
  NOTE,
  PAID_AT,
  REASON as ASSIGN_REASON,
  attributedOrder,
  orderNow,
  orderPath,
  refused,
  seedOrder,
  setup,
  type Caller,
  type Order,
  type Send,
} from '../../orders/admin-mounts/kit.ts';
import { PATH, detail as orderDetail } from '../../orders/admin-orders-read/kit.ts';
import {
  audits,
  detail as superUserRead,
  type Setup as ProfileSetup,
} from '../../identity/admin-profile/kit.ts';
import {
  at,
  binding,
  normalDetail,
  riskRow,
  user,
  type Detail as UserDetail,
} from '../../identity/admin-users/kit.ts';

export { ORDER_VIEW, RISK_POINTS } from '../lookup-blank-fields/kit.ts';

/** The write's own permission point and an account's step-up refusal (specs/permissions.yaml). */
export const USER_POINT = 'user.phone_change';
export const STEP_UP_NEEDED = { tier: 'totp' };
/** Points that are neither order.view nor a write's own; none of them shows an internal field. */
export const OTHER_POINTS = ['user.lookup', 'order.claim', 'risk.freeze', 'fund.view'] as const;
/** A case signing in several accounts and writing several orders. */
export const SLOW = 120_000;

const HOLD_NOTE = '暂停内部备注-合成-B1-10p';
const RISK_NOTE = '风控内部说明-合成-B1-10p';
const BINDING_NOTE = '绑定说明-合成-B1-10p';
const HELD_AT = '2026-10-07T03:00:00.000Z';
const REASON_SUB = 'FAKE_TRADE';

export type OrderDetail = Schema<'AdminOrderDetail'>;
type OrderPatch = Partial<Insertable<DB['orders']>>;

export type Action = 'hold' | 'unhold' | 'assign' | 'reasonSub';
export const ACTIONS: readonly Action[] = ['hold', 'unhold', 'assign', 'reasonSub'];

/** The table of the task: each write's permission point and the audit action it records. */
export const WRITE_POINT: Readonly<Record<Action, string>> = {
  hold: 'order.hold',
  unhold: 'order.hold',
  assign: 'order.assign',
  reasonSub: 'order.claim',
};
const AUDIT_ACTION: Readonly<Record<Action, string>> = {
  hold: 'order_hold',
  unhold: 'order_unhold',
  assign: 'order_assign',
  reasonSub: 'order_reason_sub_set',
};

const FIGURES = {
  commission_rate_bp: 800,
  pay_amount_fen: 12_900n,
  est_commission_fen: 1_032n,
} satisfies OrderPatch;

// The assignment takes a VOID order (R3b): no snapshot is generated, so the seeded one stays.
const START: Readonly<Record<Action, OrderPatch>> = {
  hold: FIGURES,
  unhold: { ...FIGURES, hold: true, hold_reason: 'CS' },
  assign: { ...FIGURES, platform_status: 'INVALID', rebate_status: 'VOID', reason: 'REFUND' },
  reasonSub: { ...FIGURES, rebate_status: 'VOID', reason: 'PUNISH' },
};

/** Real admin entry, a super admin for the read-back, and one published rule version per app. */
export async function orderScene(h: Harness) {
  const s = await setup(h);
  const superAdmin = await s.caller([], { isSuper: true });
  const ruleVersionId = randomUUID();
  await h.db
    .insertInto('commission_rule_versions')
    .values({
      app_id: s.appId,
      rule_version_id: ruleVersionId,
      status: 'published',
      effective_from: '2026-10-01T00:00:00.000Z',
      indirect_enabled: true,
      created_at: '2026-09-30T00:00:00.000Z',
    })
    .execute();
  return { s, superAdmin, ruleVersionId };
}
export type OrderScene = Awaited<ReturnType<typeof orderScene>>;

/**
 * An order the write can act on, with a commission rate, a snapshot with a reserve ratio and, except
 * for a first hold (which writes its own), an earlier manual hold record with a note.
 */
export async function arrange(c: OrderScene, action: Action): Promise<Order> {
  const seed = action === 'assign' ? seedOrder : attributedOrder;
  const order = await seed(c.s, START[action]);
  await c.s.h.db
    .insertInto('commission_splits')
    .values({
      app_id: c.s.appId,
      order_id: order.order_id,
      rule_version_id: c.ruleVersionId,
      order_type: 'self',
      paid_at: PAID_AT,
      paid_at_source: 'platform',
      raw_n_fen: 1000n,
      subsidy_commission_fen: 20n,
      reserve_bp: 1500,
      reserve_fen: 150n,
      tlj_deduct_fen: 30n,
      base_fen: 840n,
      platform_retain_fen: 298n,
      beneficiaries: JSON.stringify([
        {
          user_id: c.s.userId,
          role: 'share',
          ratio_bp: 5000,
          level: 'L1',
          initial_status: 'active',
          forfeit_reason: null,
        },
      ]),
      created_at: PAID_AT,
    })
    .execute();
  if (action !== 'hold') {
    await c.s.h.db
      .insertInto('audit_logs')
      .values({
        app_id: c.s.appId,
        admin_id: c.superAdmin.id,
        action: AUDIT_ACTION.hold,
        target: `orders:${order.order_id}`,
        before: JSON.stringify({ hold: false, hold_reason: null }),
        after: JSON.stringify({ hold: true, hold_reason: 'CS', note: HOLD_NOTE }),
        at: HELD_AT,
      })
      .execute();
  }
  return order;
}

function pathOf(action: Action, orderId: string): string {
  if (action === 'reasonSub') return `${PATH}/${orderId}/reason-sub`;
  return orderPath(orderId, action === 'assign' ? 'reassign' : action);
}

function bodyOf(c: OrderScene, action: Action, order: Order) {
  switch (action) {
    case 'hold':
    case 'unhold':
      return { reason_code: 'CS', note: NOTE, expected_row_version: order.row_version };
    case 'assign':
      return {
        user_id: c.s.userId,
        expected_user_id: null,
        expected_locked: order.locked,
        reason: ASSIGN_REASON,
      };
    case 'reasonSub':
      return { reason_sub: REASON_SUB, expected_row_version: order.row_version };
  }
}

/** The write as sent with exactly these options. */
export function send(
  c: OrderScene,
  action: Action,
  order: Order,
  options: Send,
): Promise<Response> {
  return c.s.post(pathOf(action, order.order_id), bodyOf(c, action, order), options);
}

/** The write as the caller sends it: the assignment with a fresh totp step-up token. */
export async function act(
  c: OrderScene,
  action: Action,
  order: Order,
  caller: Caller,
): Promise<Response> {
  const stepped: Send =
    action === 'assign' ? { caller, stepUp: await c.s.stepUp(caller) } : { caller };
  return send(c, action, order, stepped);
}

/** HTTP 200, code 0, no-store and the contract's AdminOrderDetailResponse; the data. */
export async function answered(response: Response): Promise<OrderDetail> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  return orderDetail(response);
}

function realFields(action: Action, userId: string) {
  const shared = {
    pay_amount_fen: 12_900,
    est_commission_fen: 1_032,
    commission_rate_bp: 800,
    commission_split: { reserve_bp: 1500, reserve_fen: 150, beneficiaries: [{ ratio_bp: 5000 }] },
  };
  switch (action) {
    case 'hold':
      return {
        ...shared,
        last_hold_note: NOTE,
        hold_reason: 'CS',
        rebate_status: 'ESTIMATED',
        flags: { hold: true },
      };
    case 'unhold':
      return {
        ...shared,
        last_hold_note: HOLD_NOTE,
        hold_reason: null,
        rebate_status: 'ESTIMATED',
        flags: { hold: false },
      };
    case 'assign':
      return {
        ...shared,
        last_hold_note: HOLD_NOTE,
        user: { user_id: userId },
        user_basis: 'admin',
        reason: 'REFUND',
        rebate_status: 'VOID',
        flags: { locked: true },
      };
    case 'reasonSub':
      return {
        ...shared,
        last_hold_note: HOLD_NOTE,
        reason: 'PUNISH',
        reason_sub: REASON_SUB,
        rebate_status: 'VOID',
      };
  }
}

/** adminGetOrder as a super admin after the write: the stored values, checked against the seed. */
export async function realAfter(c: OrderScene, action: Action, order: Order): Promise<OrderDetail> {
  const read = await c.s.f.read(c.superAdmin.token, `${PATH}/${order.order_id}`);
  const real = await orderDetail(read);
  expect(real).toMatchObject(realFields(action, c.s.userId));
  return real;
}

/** The same detail with only the three internal fields null. */
export function blankOrder(real: OrderDetail): OrderDetail {
  return {
    ...real,
    last_hold_note: null,
    commission_rate_bp: null,
    commission_split: { ...real.commission_split!, reserve_bp: null },
  };
}

function effectOf(c: OrderScene, action: Action, order: Order) {
  const version = order.row_version + 1;
  switch (action) {
    case 'hold':
      return { hold: true, hold_reason: 'CS', rebate_status: 'ESTIMATED', row_version: version };
    case 'unhold':
      return { hold: false, hold_reason: null, rebate_status: 'ESTIMATED', row_version: version };
    case 'assign':
      return { user_id: c.s.userId, user_basis: 'admin', locked: true, rebate_status: 'VOID' };
    case 'reasonSub':
      return { reason: 'PUNISH', reason_sub: REASON_SUB, reason_sub_manual: true };
  }
}

/** The write took effect in the database and left exactly one audit record by the caller. */
export async function expectWritten(
  c: OrderScene,
  action: Action,
  order: Order,
  caller: Caller,
): Promise<void> {
  expect(await orderNow(c.s, order.order_id)).toMatchObject(effectOf(c, action, order));
  const recorded = (await c.s.state()).audits.filter(
    (row) => row.target === `orders:${order.order_id}` && row.action === AUDIT_ACTION[action],
  );
  expect(recorded).toEqual([expect.objectContaining({ admin_id: caller.id })]);
}

/** A caller entitled to the fields writes a fresh order and gets the true values back. */
export async function expectEntitled(c: OrderScene, action: Action, caller: Caller): Promise<void> {
  const order = await arrange(c, action);
  const data = await answered(await act(c, action, order, caller));
  expect(data).toEqual(await realAfter(c, action, order));
  await expectWritten(c, action, order, caller);
}

/** An account without the write's point: 10403 even with a valid step-up, nothing written. */
export async function expectRefused(
  c: OrderScene,
  action: Action,
  grants: readonly string[],
): Promise<void> {
  const caller = await c.s.caller(grants);
  const order = await arrange(c, action);
  const before = await c.s.state();
  await refused(await act(c, action, order, caller), 10403, DENIED);
  expect(await c.s.state()).toEqual(before);
}

/** A frozen user with an internal risk reason and a union binding with its own reason. */
export async function riskyUser(s: ProfileSetup) {
  const target = await user(s.h, s.appId, { createdAt: at(2), level: 'L2' });
  await riskRow(s.h, target, {
    state: 'frozen',
    reason_category: 'abnormal_trade',
    reason: RISK_NOTE,
    frozen_until: at(60 * 24 * 60),
    row_version: 1,
  });
  await binding(s.h, target, 'taobao', {
    status: 'active',
    createdAt: at(3),
    reason: BINDING_NOTE,
  });
  return target;
}

/** adminGetUser as the super admin after the write: the stored values, checked against the seed. */
export async function realUser(s: ProfileSetup, userId: string): Promise<UserDetail> {
  const real = normalDetail(await superUserRead(s, userId));
  expect(real).toMatchObject({
    risk: { state: 'frozen', reason_category: 'abnormal_trade', reason: RISK_NOTE },
    union_bindings: [{ reason: BINDING_NOTE }],
  });
  return real;
}

/** The same detail with only risk.reason null. */
export function blankUser(real: UserDetail): UserDetail {
  return { ...real, risk: { ...real.risk, reason: null } };
}

/** The user_profile_edit audit records of one user. */
export async function editAudits(s: ProfileSetup, userId: string) {
  return (await audits(s.h, s.appId)).filter((row) => row.target === userId);
}
