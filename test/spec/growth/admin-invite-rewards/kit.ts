// B2-16d rule-test kit: GET /admin/v1/invite-rewards and GET /admin/v1/invite-rewards/{invitee_id} on
// the real admin entry and a real database (contracts adminListInviteRewards / adminGetInviteReward,
// CT-25a; 08 BR-INV-24 细则「资格记录与状态」④, BR-ID-33; task §10). No port is replaced and no
// skeleton is imported. Before the implementation neither route is mounted, so setup() fails on its
// assertion and every integration case is red there, negative cases included.
//
// The admin login, the admin accounts and the users come from the existing kits (admin/auth,
// admin/accounts, identity/admin-profile: users.phone_cipher under the harness's field keys, the same
// keys the admin entry is configured with). The invite_rewards and invite_reward_budgets rows are
// written straight into app.* as growth's payout would have left them; trigger orders are bare
// order_keys rows and vouchers bare ledger_vouchers rows, only so that the foreign keys hold and
// their ids can be looked for in the answer.
//
// Not pinned on purpose, because the contract and §10 do not say: which answer wins when a request has
// no permission and also a bad parameter; the order of records with the same qualified_at, beyond one
// stable partition into pages; the zone a time is written in (instants are compared); whether a
// non-UUID invitee_id within the Id schema is 20001 or 30701 (either, in the contract's error shape).
import { randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { grant, seed } from '../../admin/accounts/kit.ts';
import {
  fixture,
  signedIn,
  type Harness,
  type HttpApp,
  type Response,
} from '../../admin/auth/kit.ts';
import { masked, user } from '../../identity/admin-profile/kit.ts';
import { DETAIL, LIST, validate, type Path } from './schema.ts';

export const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
/** specs/permissions.yaml: the read point of the fund console, step-up null. */
export const VIEW = 'fund.view';
/** 2026-11-25 10:00 +08:00: the console's clock unless a case sets its own. */
export const AT = '2026-11-25T02:00:00.000Z';
/** 2026-10-20 10:00 +08:00: when a seeded invitee qualified unless a case says otherwise. */
export const QUALIFIED = '2026-10-20T02:00:00.000Z';
/** 2026-11-25 09:00 +08:00: when a seeded trigger happened. */
export const TRIGGERED = '2026-11-25T01:00:00.000Z';
/** 2026-11-25 09:00:05 +08:00: when a seeded grant was posted. */
export const GRANTED = '2026-11-25T01:00:05.000Z';
export const DENIED = { reason: 'admin_permission_denied' };
const DETAIL_ROUTE = DETAIL.replace('{invitee_id}', ':invitee_id');

export type Item = Schema<'AdminInviteReward'>;
export type Page = Schema<'AdminInviteRewardPage'>;
export type Status = Item['status'];
export type SkipReason = NonNullable<Item['inviter_skip_reason']>;
export type VoidReason = NonNullable<Item['void_reason']>;
export type BindSource = Item['bind_source'];

export function mounted(app: HttpApp): boolean {
  const server = app.getHttpAdapter().getInstance();
  return (
    server.hasRoute({ method: 'GET', url: LIST }) &&
    server.hasRoute({ method: 'GET', url: DETAIL_ROUTE })
  );
}

/** The admin entry with a signed-in super admin of a fresh app; the console's clock is at `at`. */
export async function setup(h: Harness, at = AT) {
  const f = await fixture(h);
  // Every integration case is red before the routes exist, negative cases included.
  expect(
    mounted(f.app),
    'admin 入口必须挂载 GET /admin/v1/invite-rewards 与 GET /admin/v1/invite-rewards/{invitee_id}',
  ).toBe(true);
  f.clock.set(at);
  const appId = `b2-16d-${randomUUID()}`;
  const actor = await seed(h, appId, { isSuper: true });
  const session = await signedIn(f, actor);
  f.overrides.logger.info({ event: 'admin_invite_rewards_test_capture_ready' }, 'capture ready');
  return { ...f, h, appId, actor, token: session.admin_token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

/** A non-super admin of `appId` (default: the app of setup) holding exactly `permissions`. */
export async function member(s: Setup, permissions: readonly string[], appId = s.appId) {
  const who = await seed(s.h, appId);
  // admin_permissions.granted_by is an admin of the same app: self-granted in another app.
  if (permissions.length !== 0) {
    await grant(s.h, who, appId === s.appId ? s.actor : who, permissions);
  }
  const session = await signedIn(s, who);
  return { who, token: session.admin_token };
}
export type Member = Awaited<ReturnType<typeof member>>;

export interface CallOptions {
  /** The admin doing it (default: the super admin of setup). */
  as?: Member;
  /** null: no admin_token at all. */
  token?: string | null;
  headers?: Record<string, string>;
}

function call(s: Setup, url: string, options: CallOptions) {
  const token = options.token === undefined ? (options.as?.token ?? s.token) : options.token;
  return s.app.inject({
    method: 'GET',
    url,
    headers: {
      'x-trace-id': TRACE,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...options.headers,
    },
    remoteAddress: '127.0.0.1',
  });
}

/** GET /admin/v1/invite-rewards?query; never sends an X-Step-Up-Token unless `headers` does. */
export function list(s: Setup, query: Record<string, string> = {}, options: CallOptions = {}) {
  const search = new URLSearchParams(query).toString();
  return call(s, search === '' ? LIST : `${LIST}?${search}`, options);
}

/** GET /admin/v1/invite-rewards/{invitee_id}. */
export function detail(s: Setup, inviteeId: string, options: CallOptions = {}) {
  return call(s, DETAIL.replace('{invitee_id}', encodeURIComponent(inviteeId)), options);
}

/** A 200 of the list: the contract envelope and its 200 schema; returns data. */
export async function listed(response: Response): Promise<Page> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, msg: '', trace_id: TRACE });
  await validate(LIST, response);
  return response.json<{ data: Page }>().data;
}

/** A 200 of the detail: the contract envelope and its 200 schema; returns data. */
export async function shown(response: Response): Promise<Item> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, msg: '', trace_id: TRACE });
  await validate(DETAIL, response);
  return response.json<{ data: Item }>().data;
}

export const pageOf = async (
  s: Setup,
  query: Record<string, string> = {},
  options: CallOptions = {},
) => listed(await list(s, query, options));

/** contracts/error-codes.yaml statuses of the codes these operations answer. */
const STATUS: Readonly<Record<number, number>> = {
  10001: 401,
  10403: 403,
  20001: 400,
  30701: 404,
};

/** A refusal: code, HTTP status, the contract 4XX shape and, when given, the exact data. */
export async function rejected(path: Path, response: Response, code: number, data?: object) {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(STATUS[code]);
  expect(response.json()).toMatchObject({ code, trace_id: TRACE });
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(path, response);
}

// ---------------------------------------------------------------- seeds

export interface Person {
  id: string;
  appId: string;
  phone: string | null;
}

/** A user of `appId` (default: the app of setup), with a fresh 199 0000 test phone unless given. */
export async function person(
  s: Setup,
  options: { appId?: string; phone?: string | null } = {},
): Promise<Person> {
  const appId = options.appId ?? s.appId;
  const made = await user(s.h, appId, options.phone === undefined ? {} : { phone: options.phone });
  return { id: made.id, appId, phone: made.phone };
}

async function order(s: Setup, appId: string): Promise<string> {
  const id = randomUUID();
  await s.h.db
    .insertInto('order_keys')
    .values({
      app_id: appId,
      order_id: id,
      platform: 'taobao',
      sub_order_id: `b2-16d-${randomUUID()}`,
      attr_at: new Date('2026-10-22T02:00:00.000Z'),
    })
    .execute();
  return id;
}

async function voucher(
  s: Setup,
  appId: string,
  beneficiary: Person,
  invitee: Person,
  party: 'inviter' | 'invitee',
) {
  const id = randomUUID();
  await s.h.db
    .insertInto('ledger_vouchers')
    .values({
      id,
      app_id: appId,
      biz_type: 'REWARD',
      biz_id: `${invitee.id}:${party}`,
      uniq_key: `invite:${invitee.id}:${party}`,
      accounting_date: '2026-11-25',
      operator: 'b2-16d fixture',
      beneficiary_user_id: beneficiary.id,
      voucher_kind: 'REWARD',
      memo: 'invite',
      created_at: new Date(GRANTED),
    })
    .execute();
  return id;
}

export interface RewardSeed {
  appId?: string;
  inviter?: Person;
  invitee?: Person;
  status?: Status;
  qualifiedAt?: Date | string;
  amountFen?: bigint;
  eligibilityDays?: number;
  bindSource?: BindSource;
  /** processed only: the inviter is not paid for this reason (default: paid). */
  inviterSkip?: SkipReason;
  /** processed only: the invitee is not paid for this reason (default: paid). */
  inviteeSkip?: SkipReason;
  /** voided only (default order_clawed_back). */
  voidReason?: VoidReason;
}

export interface Seeded {
  appId: string;
  inviter: Person;
  invitee: Person;
  status: Status;
  qualifiedAt: Date;
  amountFen: bigint;
  eligibilityDays: number;
  bindSource: BindSource;
  triggerOrderId: string | null;
  triggeredAt: Date | null;
  inviterResult: 'granted' | 'skipped' | null;
  inviteeResult: 'granted' | 'skipped' | null;
  inviterSkip: SkipReason | null;
  inviteeSkip: SkipReason | null;
  voidReason: VoidReason | null;
  grantedAt: Date | null;
  bindIpHmac: string;
  voucherIds: string[];
}

/**
 * One invite_rewards row as growth's qualification and payout leave it in `status`: deferred,
 * processed and voided records carry a trigger order; processed ones the two results, the vouchers
 * of the parties paid and granted_at when one was paid; voided ones their reason.
 */
export async function reward(s: Setup, input: RewardSeed = {}): Promise<Seeded> {
  const appId = input.appId ?? s.appId;
  const inviter = input.inviter ?? (await person(s, { appId }));
  const invitee = input.invitee ?? (await person(s, { appId }));
  const status = input.status ?? 'qualified';
  const triggered = status === 'deferred' || status === 'processed' || status === 'voided';
  const processed = status === 'processed';
  const inviterSkip = processed ? (input.inviterSkip ?? null) : null;
  const inviteeSkip = processed ? (input.inviteeSkip ?? null) : null;
  const inviterResult = processed ? (inviterSkip === null ? 'granted' : 'skipped') : null;
  const inviteeResult = processed ? (inviteeSkip === null ? 'granted' : 'skipped') : null;
  const voucherIds: string[] = [];
  let inviterVoucher: string | null = null;
  let inviteeVoucher: string | null = null;
  if (inviterResult === 'granted') {
    inviterVoucher = await voucher(s, appId, inviter, invitee, 'inviter');
    voucherIds.push(inviterVoucher);
  }
  if (inviteeResult === 'granted') {
    inviteeVoucher = await voucher(s, appId, invitee, invitee, 'invitee');
    voucherIds.push(inviteeVoucher);
  }
  const seeded: Seeded = {
    appId,
    inviter,
    invitee,
    status,
    qualifiedAt: new Date(input.qualifiedAt ?? QUALIFIED),
    amountFen: input.amountFen ?? 1000n,
    eligibilityDays: input.eligibilityDays ?? 30,
    bindSource: input.bindSource ?? 'register',
    triggerOrderId: triggered ? await order(s, appId) : null,
    triggeredAt: triggered ? new Date(TRIGGERED) : null,
    inviterResult,
    inviteeResult,
    inviterSkip,
    inviteeSkip,
    voidReason: status === 'voided' ? (input.voidReason ?? 'order_clawed_back') : null,
    grantedAt: voucherIds.length > 0 ? new Date(GRANTED) : null,
    bindIpHmac: randomBytes(32).toString('hex'),
    voucherIds,
  };
  await s.h.db
    .insertInto('invite_rewards')
    .values({
      app_id: appId,
      invitee_id: invitee.id,
      inviter_id: inviter.id,
      amount_fen: seeded.amountFen,
      eligibility_days: seeded.eligibilityDays,
      qualified_at: seeded.qualifiedAt,
      bind_source: seeded.bindSource,
      bind_ip_hmac: seeded.bindIpHmac,
      trigger_order_id: seeded.triggerOrderId,
      triggered_at: seeded.triggeredAt,
      status,
      inviter_result: inviterResult,
      invitee_result: inviteeResult,
      inviter_skip_reason: inviterSkip,
      invitee_skip_reason: inviteeSkip,
      void_reason: seeded.voidReason,
      inviter_voucher_id: inviterVoucher,
      invitee_voucher_id: inviteeVoucher,
      granted_at: seeded.grantedAt,
      row_version: 0,
    })
    .execute();
  return seeded;
}

/** `count` qualified records of one inviter, all qualified at the same instant. */
export async function crowd(s: Setup, count: number, at: Date | string = QUALIFIED) {
  const inviter = await person(s);
  const seeded: Seeded[] = [];
  for (let i = 0; i < count; i += 1) {
    seeded.push(await reward(s, { inviter, qualifiedAt: at }));
  }
  return seeded;
}

/** One invite_reward_budgets row: period 'total' or a +08:00 day YYYY-MM-DD (reserved 0 for a day). */
export async function budget(
  s: Setup,
  period: string,
  fen: { reserved?: bigint; granted: bigint },
  appId = s.appId,
) {
  await s.h.db
    .insertInto('invite_reward_budgets')
    .values({
      app_id: appId,
      period,
      reserved_fen: fen.reserved ?? 0n,
      granted_fen: fen.granted,
      updated_at: s.clock.now(),
    })
    .execute();
}

// ---------------------------------------------------------------- reads

const instant = (value: string | null) => (value === null ? null : new Date(value).getTime());

/** A record of the answer with its times as instants: the zone a time is written in is not pinned. */
export const normal = (item: Item) => ({
  ...item,
  qualified_at: instant(item.qualified_at),
  triggered_at: instant(item.triggered_at),
  granted_at: instant(item.granted_at),
});

/** The exact record of `seeded`, to compare with normal(item). */
export const view = (seeded: Seeded) => ({
  invitee_id: seeded.invitee.id,
  inviter_id: seeded.inviter.id,
  invitee_phone_masked: seeded.invitee.phone === null ? null : masked(seeded.invitee.phone),
  inviter_phone_masked: seeded.inviter.phone === null ? null : masked(seeded.inviter.phone),
  amount_fen: Number(seeded.amountFen),
  eligibility_days: seeded.eligibilityDays,
  bind_source: seeded.bindSource,
  qualified_at: seeded.qualifiedAt.getTime(),
  trigger_order_id: seeded.triggerOrderId,
  triggered_at: seeded.triggeredAt === null ? null : seeded.triggeredAt.getTime(),
  status: seeded.status,
  inviter_result: seeded.inviterResult,
  invitee_result: seeded.inviteeResult,
  inviter_skip_reason: seeded.inviterSkip,
  invitee_skip_reason: seeded.inviteeSkip,
  void_reason: seeded.voidReason,
  granted_at: seeded.grantedAt === null ? null : seeded.grantedAt.getTime(),
});

export const ids = (page: Page) => page.items.map((item) => item.invitee_id);

/** Invitee ids of `seeded`, latest qualified_at first (distinct instants only). */
export const latestFirst = (seeded: readonly Seeded[]) =>
  [...seeded]
    .sort((a, b) => b.qualifiedAt.getTime() - a.qualifiedAt.getTime())
    .map((entry) => entry.invitee.id);

/** Every page of the list for `query` at `size`, concatenated in order. */
export async function allPages(
  s: Setup,
  query: Record<string, string>,
  size: number,
  options: CallOptions = {},
) {
  const first = await pageOf(s, { ...query, page: '1', page_size: String(size) }, options);
  const all = [...ids(first)];
  const pages = Math.ceil(first.total / size);
  for (let page = 2; page <= pages; page += 1) {
    const next = await pageOf(
      s,
      { ...query, page: String(page), page_size: String(size) },
      options,
    );
    all.push(...ids(next));
  }
  return { total: first.total, all };
}

/** Rows as sorted JSON text (bigint and bytes included), so the order rows come back in is moot. */
const sorted = (rows: readonly object[]) =>
  rows
    .map((row) =>
      JSON.stringify(row, (_key, value: unknown) =>
        typeof value === 'bigint' ? `${value}n` : value,
      ),
    )
    .sort();

async function snapshot(s: Setup) {
  const db = s.h.db;
  return {
    rewards: sorted(
      await db.selectFrom('invite_rewards').selectAll().where('app_id', '=', s.appId).execute(),
    ),
    budgets: sorted(
      await db
        .selectFrom('invite_reward_budgets')
        .selectAll()
        .where('app_id', '=', s.appId)
        .execute(),
    ),
    users: sorted(await db.selectFrom('users').selectAll().where('app_id', '=', s.appId).execute()),
    vouchers: sorted(
      await db.selectFrom('ledger_vouchers').selectAll().where('app_id', '=', s.appId).execute(),
    ),
    audits: sorted(await db.selectFrom('audit_logs').selectAll().execute()),
  };
}

/**
 * Call the answer once the requests are over: no reward, budget, user or voucher row of the app
 * changed, and audit_logs has no new row under any name, of any app (a read writes nothing, §10 #6).
 * Take it after every setup(), member() and seed of the case: a login writes its own audit row.
 */
export async function readOnly(s: Setup) {
  const before = await snapshot(s);
  return async () => {
    expect(await snapshot(s)).toEqual(before);
  };
}

/**
 * Nothing the contract forbids in the answer, by name or by value: no client IP or its HMAC, no
 * voucher id, no full phone number (BR-ID-33), no row internals.
 */
export function noSecrets(response: Response, seeded: readonly Seeded[]) {
  const text = JSON.stringify(response.json());
  for (const name of ['bind_ip', 'hmac', 'voucher', 'row_version', 'app_id', 'phone_cipher']) {
    expect(text).not.toContain(name);
  }
  for (const entry of seeded) {
    expect(text).not.toContain(entry.bindIpHmac);
    for (const id of entry.voucherIds) expect(text).not.toContain(id);
    for (const phone of [entry.inviter.phone, entry.invitee.phone]) {
      if (phone !== null) expect(text).not.toContain(phone);
    }
  }
}

/** No full phone number and no bind IP HMAC in any log line of the test. */
export function quietLogs(s: Setup, seeded: readonly Seeded[]) {
  expect(s.lines.length, '日志捕获器必须启用').toBeGreaterThan(0);
  const logs = s.lines.join('\n');
  for (const entry of seeded) {
    expect(logs).not.toContain(entry.bindIpHmac);
    for (const phone of [entry.inviter.phone, entry.invitee.phone]) {
      if (phone !== null) expect(logs).not.toContain(phone);
    }
  }
}
