// B1-10o rule-test kit (claude-independent, SPEC_REF 39756e36; CT-24zzd, D10-1048 ①②): the internal
// fields of the console's user, order and claim details are blanked by the account's permission
// points, and the points never decide who is let in (the guard's check stays as it is).
//
// Built on the frozen kits of F1-07b (identity/admin-users), B1-10i (orders/admin-orders-read) and
// B1-10j (orders/claims-admin-read), which are imported and not changed. Real pieces: the admin
// entry (admin token, session, permission check, route schema), PostgreSQL as couli_app, Redis for
// the sessions. Every expected value comes from what was seeded here or read back by an account
// that is entitled to it; the contract's response schema is checked on every HTTP answer.
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import {
  AdminOperationGuard,
  type AdminActor,
  type AdminOperationInput,
  type AdminOperationResponse,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { account, signedIn, type Fixture, type Harness } from '../auth/kit.ts';
import {
  at,
  binding,
  detail as userView,
  detailUrl,
  get,
  member,
  normalDetail,
  ok,
  rejected as refusedUser,
  riskRow,
  setup as setupUsers,
  url,
  user,
  type Detail as UserDetail,
} from '../../identity/admin-users/kit.ts';
import { DETAIL as DETAIL_PATH, LOOKUP as LOOKUP_PATH } from '../../identity/admin-users/schema.ts';
import {
  PATH as ORDERS_PATH,
  audit,
  detail as orderDetail,
  order,
  setup as setupOrders,
  split,
} from '../../orders/admin-orders-read/kit.ts';
import {
  PATH as CLAIMS_PATH,
  claim,
  detail as claimDetail,
  item,
  log,
  setup as setupClaims,
} from '../../orders/claims-admin-read/kit.ts';

/** specs/permissions.yaml. */
export const LOOKUP_POINT = 'user.lookup';
export const LIST_POINT = 'user.list';
export const ORDER_VIEW = 'order.view';
export const ORDER_CLAIM = 'order.claim';
export const RISK_POINTS = ['risk.freeze', 'risk.ban', 'risk.blocklist', 'risk.appeal'] as const;
/** data of the 10403 of an account without the point (permission-guard.ts). */
export const DENIED = { reason: 'admin_permission_denied' };
/** A case signing in several accounts on one entry takes longer than a one-account case. */
export const SLOW = 60_000;

const RISK_NOTE = '风控内部说明-合成-B1-10o';
const BINDING_NOTE = '绑定说明-合成-B1-10o';
const HOLD_NOTE = '暂停内部备注-合成-B1-10o';
const CLAIM_NOTE = '找回内部说明-合成-B1-10o';
const DECIDED_AT = '2026-10-08T03:00:00.000Z';

const ROOT = new URL('../../../../', import.meta.url);
const source = (path: string) => new URL(path, ROOT).href;

/** A non-super (or super) admin of the app holding exactly `grants`; its admin_token. */
async function tokenOf(
  h: Harness,
  f: Fixture,
  appId: string,
  grants: readonly string[],
  isSuper: boolean,
): Promise<string> {
  const a = await account(h, { app_id: appId, is_super: isSuper });
  await h.db
    .updateTable('admin_users')
    .set({
      totp_secret_cipher: Buffer.from(
        h.fields.encrypt(a.secret, `admin_users.totp_secret:${appId}:${a.id}`),
      ),
    })
    .where('id', '=', a.id)
    .execute();
  if (grants.length > 0) {
    await h.db
      .insertInto('admin_permissions')
      .values(
        grants.map((permission_key) => ({
          app_id: appId,
          admin_id: a.id,
          permission_key,
          granted_by: a.id,
          granted_at: f.clock.now(),
        })),
      )
      .execute();
  }
  return (await signedIn(f, a)).admin_token;
}

/**
 * A user whose risk row carries a real reason. `real` is the detail as the contract shows it to an
 * account holding a risk point, `blanked` the same with only risk.reason null.
 */
export async function userCase(h: Harness) {
  const f = await setupUsers(h);
  const target = await user(h, f.appId, { createdAt: at(2), level: 'L2' });
  const risk = await riskRow(h, target, {
    state: 'frozen',
    reason_category: 'abnormal_trade',
    reason: RISK_NOTE,
    frozen_until: at(60 * 24 * 30),
    row_version: 1,
  });
  const taobao = await binding(h, target, 'taobao', {
    status: 'active',
    createdAt: at(3),
    reason: BINDING_NOTE,
  });
  const real = userView(target, risk, [taobao]);
  expect(real.risk).toMatchObject({
    state: 'frozen',
    reason_category: 'abnormal_trade',
    reason: RISK_NOTE,
  });
  expect(real.union_bindings).toMatchObject([{ reason: BINDING_NOTE }]);
  const blanked: UserDetail = { ...real, risk: { ...real.risk, reason: null } };
  const byUid = url(LOOKUP_PATH, { uid: target.id });
  const byPhone = url(LOOKUP_PATH, { phone: target.phone! });
  return {
    f,
    target,
    real,
    blanked,
    token: (grants: readonly string[]) => member(h, f, grants),
    /** adminGetUser. */
    readDetail: async (token: string) =>
      normalDetail(
        await ok<UserDetail>(await get(f, detailUrl(target.id), { token }), DETAIL_PATH),
      ),
    /** adminLookupUser by uid. */
    lookupUid: async (token: string) =>
      normalDetail(await ok<UserDetail>(await get(f, byUid, { token }), LOOKUP_PATH)),
    /** adminLookupUser by the full phone number. */
    lookupPhone: async (token: string) =>
      normalDetail(await ok<UserDetail>(await get(f, byPhone, { token }), LOOKUP_PATH)),
    refusedDetail: async (token: string) =>
      refusedUser(await get(f, detailUrl(target.id), { token }), DETAIL_PATH, 10403, DENIED),
    refusedLookup: async (token: string) =>
      refusedUser(await get(f, byUid, { token }), LOOKUP_PATH, 10403, DENIED),
  };
}
export type UserCase = Awaited<ReturnType<typeof userCase>>;

/**
 * An order with a manual hold note, a commission rate and a snapshot with a reserve ratio. `real`
 * is the answer of an order.view account, `blanked` the same with only the three fields null.
 */
export async function orderCase(h: Harness) {
  const s = await setupOrders(h, { grants: [ORDER_VIEW] });
  const o = await order(s, {
    commission_rate_bp: 800,
    hold: true,
    hold_reason: 'CS',
    reason: 'OTHER',
    pay_amount_fen: 12_900n,
    est_commission_fen: 1_032n,
  });
  await audit(s, {
    adminId: s.a.id,
    orderId: o.order_id,
    at: '2026-10-07T03:00:00.000Z',
    note: HOLD_NOTE,
  });
  await split(
    s,
    o.order_id,
    [
      {
        user_id: s.userId,
        role: 'share',
        ratio_bp: 5000,
        level: 'L1',
        initial_status: 'active',
        forfeit_reason: null,
      },
    ],
    { order_type: 'share' },
  );
  const real = await orderDetail(await s.get({}, o.order_id));
  expect(real).toMatchObject({
    hold_reason: 'CS',
    reason: 'OTHER',
    pay_amount_fen: 12_900,
    est_commission_fen: 1_032,
    last_hold_note: HOLD_NOTE,
    commission_rate_bp: 800,
    commission_split: { reserve_bp: 1500, reserve_fen: 150, beneficiaries: [{ ratio_bp: 5000 }] },
  });
  const blanked = {
    ...real,
    last_hold_note: null,
    commission_rate_bp: null,
    commission_split: { ...real.commission_split!, reserve_bp: null },
  };
  return {
    s,
    o,
    real,
    blanked,
    token: (grants: readonly string[], isSuper = false) =>
      tokenOf(h, s.f, s.appId, grants, isSuper),
    /** adminGetOrder with the query. */
    read: (token: string, query: Readonly<Record<string, string>>) =>
      s.f.read(token, `${ORDERS_PATH}/${o.order_id}?${new URLSearchParams(query)}`),
  };
}
export type OrderCase = Awaited<ReturnType<typeof orderCase>>;

/**
 * A claim with a reviewer's reason and two items: one with evidence links, one rejected with a
 * reason code. `real` is the answer of an order.claim account, `blanked` the same with only the
 * claim's reason null.
 */
export async function claimCase(h: Harness) {
  const s = await setupClaims(h, { grants: [ORDER_CLAIM] });
  const c = await claim(s, { reason: CLAIM_NOTE });
  const link = await log(s);
  await item(s, c, {
    evidence: 'strong',
    evidence_link_log_ids: [link.id],
    decision: 'approved',
    decided_by: s.a.id,
    decided_at: DECIDED_AT,
    row_version: 2,
  });
  await item(s, c, {
    decision: 'rejected',
    reject_reason: 'NO_EVIDENCE',
    decided_by: s.a.id,
    decided_at: DECIDED_AT,
    row_version: 3,
  });
  const real = await claimDetail(await s.get({}, c.id));
  expect(real.reason).toBe(CLAIM_NOTE);
  expect(real.items.map((row) => row.reject_reason)).toContain('NO_EVIDENCE');
  expect(real.items.map((row) => row.evidence_links).flat()).not.toEqual([]);
  const blanked = { ...real, reason: null };
  return {
    s,
    c,
    real,
    blanked,
    token: (grants: readonly string[], isSuper = false) =>
      tokenOf(h, s.f, s.appId, grants, isSuper),
    /** adminGetClaim with the query. */
    read: (token: string, query: Readonly<Record<string, string>>) =>
      s.f.read(token, `${CLAIMS_PATH}/${c.id}?${new URLSearchParams(query)}`),
  };
}
export type ClaimCase = Awaited<ReturnType<typeof claimCase>>;

/** What differs between the actors handed to a controller; `permissions` may be absent. */
export type Access = Pick<AdminActor, 'isSuper' | 'permissions'>;

/** Lets every call through and hands the actor to the business callback. */
class PassingGuard extends AdminOperationGuard {
  readonly #actor: AdminActor;

  constructor(actor: AdminActor) {
    super();
    this.#actor = actor;
  }

  override run(
    _input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse> {
    return business(this.#actor);
  }
}

function guardFor(appId: string, access: Access): PassingGuard {
  return new PassingGuard({
    adminId: randomUUID(),
    appId,
    loginName: 'synthetic_admin',
    ...access,
  });
}

interface Answer<T> {
  readonly code: number;
  readonly data: T;
}
const REPLY = { header: () => undefined };
const request = () => ({ id: randomUUID() });

/** The entry's real provider of the class `name` exported by the application file `file`. */
async function provider<T>(f: Pick<Fixture, 'app'>, file: string, name: string): Promise<T> {
  const module = (await import(source(file))) as Record<string, unknown>;
  return f.app.get<T>(module[name] as symbol);
}

/** Calls AdminOrdersController.detail directly, with the entry's real AdminOrders. */
export async function orderControllerRead(c: OrderCase) {
  // URL import: the rule-test project compiles erasable syntax only and has no Nest dependency.
  const { AdminOrdersController } = (await import(
    source('apps/api/src/modules/orders/http/admin/orders.controller.ts')
  )) as {
    AdminOrdersController: new (
      guard: AdminOperationGuard,
      orders: unknown,
    ) => {
      detail(
        request: { readonly id: string },
        orderId: string,
        query: { readonly user_id?: string },
        reply: typeof REPLY,
      ): Promise<Answer<unknown>>;
    };
  };
  const orders = await provider<unknown>(
    c.s.f,
    'apps/api/src/modules/orders/application/admin-orders.ts',
    'AdminOrders',
  );
  return async (access: Access) => {
    const controller = new AdminOrdersController(guardFor(c.s.appId, access), orders);
    const response = await controller.detail(
      request(),
      c.o.order_id,
      { user_id: c.s.userId },
      REPLY,
    );
    expect(response.code).toBe(0);
    return response.data;
  };
}

/** Calls AdminClaimsController.detail directly, with the entry's real AdminClaims. */
export async function claimControllerRead(c: ClaimCase) {
  const { AdminClaimsController } = (await import(
    source('apps/api/src/modules/orders/http/admin/claims.controller.ts')
  )) as {
    AdminClaimsController: new (
      guard: AdminOperationGuard,
      claims: unknown,
    ) => {
      detail(
        request: { readonly id: string },
        claimId: string,
        query: { readonly user_id?: string },
        reply: typeof REPLY,
      ): Promise<Answer<unknown>>;
    };
  };
  const claims = await provider<unknown>(
    c.s.f,
    'apps/api/src/modules/orders/application/admin-claims.ts',
    'AdminClaims',
  );
  return async (access: Access) => {
    const controller = new AdminClaimsController(guardFor(c.s.appId, access), claims);
    const response = await controller.detail(request(), c.c.id, { user_id: c.s.userId }, REPLY);
    expect(response.code).toBe(0);
    return response.data;
  };
}

/** Calls AdminUsersController.lookup and .detail directly, with the entry's real AdminUsers. */
export async function userControllerReads(c: UserCase) {
  const { AdminUsersController } = (await import(
    source('apps/api/src/modules/identity/http/admin/users.controller.ts')
  )) as {
    AdminUsersController: new (
      guard: AdminOperationGuard,
      users: unknown,
    ) => {
      lookup(
        request: { readonly id: string },
        query: { readonly uid?: string; readonly phone?: string },
        reply: typeof REPLY,
      ): Promise<Answer<UserDetail>>;
      detail(
        request: { readonly id: string },
        userId: string,
        reply: typeof REPLY,
      ): Promise<Answer<UserDetail>>;
    };
  };
  const users = await provider<unknown>(
    c.f,
    'apps/api/src/modules/identity/application/admin-users.ts',
    'AdminUsers',
  );
  const controllerFor = (access: Access) =>
    new AdminUsersController(guardFor(c.f.appId, access), users);
  return {
    lookup: async (access: Access) => {
      const response = await controllerFor(access).lookup(request(), { uid: c.target.id }, REPLY);
      expect(response.code).toBe(0);
      return normalDetail(response.data);
    },
    detail: async (access: Access) => {
      const response = await controllerFor(access).detail(request(), c.target.id, REPLY);
      expect(response.code).toBe(0);
      return normalDetail(response.data);
    },
  };
}
