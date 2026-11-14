// B1-10w rule-test kit (claude-independent, SPEC_REF 00959234): contracts/openapi.yaml
// adminGetDashboard (GET /admin/v1/dashboard), AdminDashboard* schemas, enum
// admin_dashboard_todo_key; 编排 D10-1401 (every card counts through the owning module's exported
// count function), D10-1402 (beneficiary_held_overdue is not returned in this task), D10-1403 ③
// (yesterday nullable), task brief §9 items 1–8.
// Real pieces: the admin entry (createHttpApp('admin') through ../auth/kit.ts useHarness: admin
// token, session and permission checks, contract validation), PostgreSQL as couli_app, Redis for the
// admin sessions. Synthetic: every business row, written by the existing rule-test kits of the
// owning modules (reused unchanged, only their exports), the admin accounts and the config rows.
// No real user data. Expected counts are the count functions' own results on the same database and
// app; routes and keys are written out here from the contract. Missing routes fail as assertions:
// the HTTP status is always checked before the body is parsed.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import { REDIS, type RedisHandle } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  reportSession,
  seedReport,
  type Fixture as AgentFixture,
} from '../../agent/report-overdue/kit.ts';
import { seedDiff, type Fixture as ReconFixture } from '../../ledger/admin-recon-diffs/kit.ts';
import { evidenceFor } from '../../orders/claim-review-count/kit.ts';
import { seed as seedClaim, setup as claimScenario } from '../../orders/claims-admin-read/kit.ts';
import {
  seedMember as seedPayee,
  seedWithdrawal,
  type Fixture as PayoutFixture,
} from '../../payout/admin-withdrawals/kit.ts';
import {
  accountAppeal,
  member as appealMember,
  type Scenario as AppealScenario,
} from '../../risk/admin-appeals-read/kit.ts';
import {
  seedBatch,
  seedBill,
  type Fixture as SettleFixture,
} from '../../settlement/admin-settle-bills/kit.ts';
import { seedAccount } from '../../union/admin-accounts/kit.ts';
import {
  account,
  apiRequire,
  fixture,
  type Fixture as AuthFixture,
  type Harness,
  type Response,
} from '../auth/kit.ts';

export { useHarness, type Harness } from '../auth/kit.ts';

export const PATH = '/admin/v1/dashboard';
export const VIEW = 'dashboard.view';
export const FUND_VIEW = 'fund.view';
/** The point of beneficiary_held_overdue, a card this task never returns (D10-1402). */
export const HELD_POINT = 'risk.freeze';
export const HELD_KEY = 'beneficiary_held_overdue';
export const TIMEOUT = 180_000;
const HOUR_MS = 3_600_000;

export type CardKey =
  | 'withdraw_review_pending'
  | 'claim_review_pending'
  | 'settle_bill_pending'
  | 'recon_diff_open'
  | 'appeal_pending'
  | 'agent_report_overdue'
  | 'union_auth_expiring';

/**
 * The seven cards of this task, in the order of enum admin_dashboard_todo_key with
 * beneficiary_held_overdue left out, and each card's permission point (contract description).
 */
export const CARDS: readonly (readonly [CardKey, string])[] = [
  ['withdraw_review_pending', 'withdraw.review'],
  ['claim_review_pending', 'order.claim'],
  ['settle_bill_pending', 'settle.bill'],
  ['recon_diff_open', 'fund.recon'],
  ['appeal_pending', 'risk.appeal'],
  ['agent_report_overdue', 'agent.report'],
  ['union_auth_expiring', 'union.account_auth'],
];
export const CARD_KEYS: readonly CardKey[] = CARDS.map(([key]) => key);
export const CARD_POINTS: readonly string[] = CARDS.map(([, point]) => point);

/**
 * The routes the contract writes out (the description for settle_bill_pending, the superAdmin
 * example for the others). withdraw_review_pending and recon_diff_open have no route in the
 * contract; for them only the schema (a path starting with "/") is checked.
 */
export const ROUTES: Readonly<Partial<Record<CardKey, string>>> = {
  claim_review_pending: '/claims?status=manual_review',
  settle_bill_pending: '/settle-bills?awaiting_confirm=true',
  appeal_pending: '/risk/appeals?status=processing',
  agent_report_overdue: '/agent/reports?overdue=true',
  union_auth_expiring: '/union/accounts?auth=expiring',
};

/** The config keys of the status object (contract AdminDashboardStatus descriptions). */
export const QUEUE_PAUSED = 'payout.queue_paused';
export const CHANNEL_PAUSED = (channel: string): string => `payout.channel_paused.${channel}`;
export const SETTLE_AUTO = 'settle.auto.enabled';
export const CHANNELS = ['alipay', 'bank_card', 'wechat'] as const;

type Row = Record<string, unknown>;

/** A fresh app id. */
export function newApp(label: string): string {
  return `dash_${label}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

// ---------------------------------------------------------------------------------------------
// The count functions and the yesterday read, as other modules get them (each module's index.ts).
// Imported at run time (computed URL) so the rule-test build never type-checks Nest decorators.

export interface ClaimReviewCount {
  readonly count: number;
  readonly breakdown: { readonly auto_matched: number; readonly manual_review: number };
}
export interface YesterdayRow {
  readonly date: string;
  readonly links: bigint;
  readonly orders: bigint;
  readonly est_rebate_fen: bigint;
  readonly new_users: bigint;
  readonly as_of: Date;
}
type Count = (db: Kysely<DB>, appId: string) => Promise<number>;

export interface Sources {
  countWithdrawReviewPending: Count;
  countClaimsPendingReview: (db: Kysely<DB>, appId: string) => Promise<ClaimReviewCount>;
  countSettleBillPending: Count;
  countReconDiffOpen: Count;
  countProcessingAppeals: Count;
  countOverdueAgentReports: (db: Kysely<DB>, appId: string, now: Date) => Promise<number>;
  countUnionAuthPending: Count;
  readDashboardYesterday: (
    db: Kysely<DB>,
    input: { readonly appId: string; readonly now: Date },
  ) => Promise<YesterdayRow | null>;
}

const ROOT = new URL('../../../../', import.meta.url);
const SOURCES: readonly (readonly [string, keyof Sources])[] = [
  ['payout', 'countWithdrawReviewPending'],
  ['orders', 'countClaimsPendingReview'],
  ['settlement', 'countSettleBillPending'],
  ['ledger', 'countReconDiffOpen'],
  ['risk', 'countProcessingAppeals'],
  ['agent', 'countOverdueAgentReports'],
  ['union', 'countUnionAuthPending'],
  ['admin', 'readDashboardYesterday'],
];

export async function sources(): Promise<Sources> {
  const out: Record<string, unknown> = {};
  for (const [module, name] of SOURCES) {
    const surface = (await import(
      new URL(`apps/api/src/modules/${module}/index.ts`, ROOT).href
    )) as Record<string, unknown>;
    expect(typeof surface[name], `${module}/index.ts exports ${name}`).toBe('function');
    out[name] = surface[name];
  }
  return out as unknown as Sources;
}

/** The expected count of each card for `appId` at `now`, straight from the count functions. */
export async function expectedCounts(
  h: Harness,
  appId: string,
  now: Date,
): Promise<{ counts: Record<CardKey, number>; claims: ClaimReviewCount }> {
  const src = await sources();
  const claims = await src.countClaimsPendingReview(h.db, appId);
  return {
    claims,
    counts: {
      withdraw_review_pending: await src.countWithdrawReviewPending(h.db, appId),
      claim_review_pending: claims.count,
      settle_bill_pending: await src.countSettleBillPending(h.db, appId),
      recon_diff_open: await src.countReconDiffOpen(h.db, appId),
      appeal_pending: await src.countProcessingAppeals(h.db, appId),
      agent_report_overdue: await src.countOverdueAgentReports(h.db, appId, now),
      union_auth_expiring: await src.countUnionAuthPending(h.db, appId),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export interface Caller {
  readonly id: string;
  readonly appId: string;
  readonly token: string;
}

export interface Sent {
  readonly statusCode: number;
  readonly body: string;
  json(): Row;
}

export interface Desk {
  /** The started admin entry and its clock (ADMIN NOW of ../auth/kit.ts). */
  readonly f: AuthFixture;
  /** An admin account of `appId` with these points (or a super admin), signed in. */
  caller(
    appId: string,
    points: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<Caller>;
  /** GET /admin/v1/dashboard as `who` (null: no token). */
  get(who: Caller | null): Promise<Sent>;
}

/** Starts an admin entry on the harness database and Redis (closed by the harness afterEach). */
export async function desk(h: Harness): Promise<Desk> {
  const f = await fixture(h);
  const redis = f.app.get<RedisHandle>(REDIS);
  const signing = h.env['ADMIN_TOKEN_SIGNING_KEY'];
  expect(signing, 'harness admin token key').toBeTypeOf('string');
  const key = Buffer.from(signing ?? '', 'base64url');
  const caller: Desk['caller'] = async (appId, points, options = {}) => {
    const a = await account(h, { app_id: appId, is_super: options.superAdmin === true });
    for (const permission_key of points) {
      await h.db
        .insertInto('admin_permissions')
        .values({
          app_id: appId,
          admin_id: a.id,
          permission_key,
          granted_by: a.id,
          granted_at: f.clock.now(),
        })
        .execute();
    }
    const { token, claims } = await createAdminTokens({ key, clock: f.clock }).issue({
      adminId: a.id,
      appId,
    });
    await createAdminSessions({ redis: redis.namespace('admin-auth'), clock: f.clock }).create(
      claims.sessionId,
      {
        adminId: a.id,
        appId,
        expiresAtMs: claims.expiresAt * 1000,
        lastSeenMs: f.clock.now().getTime(),
      },
    );
    return { id: a.id, appId, token };
  };
  const get: Desk['get'] = async (who) => {
    const headers: Record<string, string> = { 'x-trace-id': randomUUID() };
    if (who !== null) headers['authorization'] = `Bearer ${who.token}`;
    const response = (await f.app.inject({
      method: 'GET',
      url: PATH,
      headers,
      remoteAddress: '127.0.0.1',
    })) as Response & { readonly body?: string };
    const body = response.body ?? '';
    return {
      statusCode: response.statusCode,
      body,
      json: () => JSON.parse(body) as Row,
    };
  };
  return { f, caller, get };
}

// ---------------------------------------------------------------------------------------------
// The contract and the answers.

interface ContractOperation {
  readonly responses: Record<
    string,
    { readonly content?: Record<string, { readonly schema: JsonSchema }> }
  >;
}
let contractPromise: Promise<Record<string, Record<string, ContractOperation>>> | undefined;

function contractPaths(): Promise<Record<string, Record<string, ContractOperation>>> {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{ paths: Record<string, Record<string, ContractOperation>> }>;
  };
  contractPromise ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    })
    .then((document) => document.paths);
  return contractPromise;
}

/** The body conforms to adminGetDashboard's schema of its status class. */
export async function conforms(sent: Sent): Promise<void> {
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const operation = (await contractPaths())[PATH]?.['get'];
  const schema = operation?.responses[status]?.content?.['application/json']?.schema;
  expect(schema, `get ${PATH} ${status}`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(sent.body) as unknown;
  } catch {
    parsed = sent.body;
  }
  expect(check(parsed), `${sent.body} ${JSON.stringify(check.errors)}`).toBe(true);
}

const HTTP_STATUS: Record<number, number> = { 0: 200, 10001: 401, 10403: 403 };

/** Status first, then code and (when given) exact data, then the contract schema. */
export async function answer(sent: Sent, code: number, data?: unknown): Promise<Row> {
  expect(sent.statusCode, `GET ${PATH} ${sent.body}`).toBe(HTTP_STATUS[code]);
  const body = sent.json();
  expect(body['code'], sent.body).toBe(code);
  if (data !== undefined) expect(body['data'], sent.body).toEqual(data);
  await conforms(sent);
  return body;
}

/** 10403 data.reason=admin_permission_denied. */
export function denied(sent: Sent): Promise<Row> {
  return answer(sent, 10403, { reason: 'admin_permission_denied' });
}

export interface Card {
  readonly key: string;
  readonly count: number;
  readonly route: string;
  readonly oldest_at?: string | null;
  readonly breakdown?: readonly { readonly key: string; readonly count: number }[];
}

export interface Dashboard {
  /** data.todo: the to-do cards, in response order. */
  readonly cards: readonly Card[];
  readonly yesterday: Row | null;
  /** Absent (undefined) when the account has no fund.view. */
  readonly status?: Row;
  /** The sorted keys of data. */
  readonly keys: readonly string[];
}

/** The key of data's card list (kept in a constant: the test lint reserves the member name). */
const CARD_LIST = 'todo';

/** The data of a successful dashboard (code 0, contract schema). */
export async function dashboard(sent: Sent): Promise<Dashboard> {
  const body = await answer(sent, 0);
  const data = body['data'];
  expect(typeof data === 'object' && data !== null && !Array.isArray(data), sent.body).toBe(true);
  const record = data as Row;
  const cards = record[CARD_LIST];
  expect(Array.isArray(cards), sent.body).toBe(true);
  return {
    cards: cards as Card[],
    yesterday: (record['yesterday'] ?? null) as Row | null,
    ...(record['status'] === undefined ? {} : { status: record['status'] as Row }),
    keys: Object.keys(record).sort(),
  };
}

export function keysOf(d: Dashboard): string[] {
  return d.cards.map((card) => card.key);
}

export function cardOf(d: Dashboard, key: CardKey): Card {
  const card = d.cards.find((entry) => entry.key === key);
  expect(card, `card ${key}`).toBeDefined();
  return card!;
}

/** The breakdown of a card as { sub-key: count } (each sub-key once). */
export function breakdownOf(card: Card): Record<string, number> {
  expect(Array.isArray(card.breakdown), `${card.key} breakdown`).toBe(true);
  const out: Record<string, number> = {};
  for (const entry of card.breakdown ?? []) {
    expect(out[entry.key], `${card.key} breakdown ${entry.key} once`).toBeUndefined();
    out[entry.key] = entry.count;
  }
  return out;
}

/** A yesterday row as the response carries it (numbers, as_of as epoch ms). */
export function yesterdayView(row: YesterdayRow): Row {
  return {
    date: row.date,
    links: Number(row.links),
    orders: Number(row.orders),
    est_rebate_fen: Number(row.est_rebate_fen),
    new_users: Number(row.new_users),
    as_of: row.as_of.getTime(),
  };
}

/** The response's yesterday with as_of as epoch ms. */
export function normalizeYesterday(value: Row): Row {
  const asOf = value['as_of'];
  return { ...value, as_of: typeof asOf === 'string' ? Date.parse(asOf) : asOf };
}

// ---------------------------------------------------------------------------------------------
// Rows of one app (all synthetic; the owning modules' kits write them).

/** One admin_dashboard_days row (the table admin's aggregation writes). */
export async function seedDay(
  h: Harness,
  appId: string,
  day: string,
  figures: { links: number; orders: number; est: number; users: number; asOf: Date },
): Promise<void> {
  await h.db
    .insertInto('admin_dashboard_days')
    .values({
      app_id: appId,
      stat_date: day,
      links: BigInt(figures.links),
      orders: BigInt(figures.orders),
      est_rebate_fen: BigInt(figures.est),
      new_users: BigInt(figures.users),
      as_of: figures.asOf,
      created_at: figures.asOf,
      updated_at: figures.asOf,
    })
    .execute();
}

/** Sets a config item of `appId` (insert, or overwrite and bump the version). */
export async function setConfig(
  h: Harness,
  appId: string,
  key: string,
  value: boolean,
): Promise<void> {
  const json = JSON.stringify(value);
  await h.db
    .insertInto('config_items')
    .values({ app_id: appId, key, value: json, updated_by: 'synthetic-b1-10w' })
    .onConflict((oc) =>
      oc
        .columns(['app_id', 'key'])
        .doUpdateSet({ value: json, version: sql<number>`app.config_items.version + 1` }),
    )
    .execute();
}

/** How many rows of each card to write (0: none). */
export type Amounts = Readonly<Record<CardKey, number>>;

/**
 * Writes card rows of `appId` through the module kits: n waiting items per card, plus rows that
 * never count (a rejected withdrawal, a pending report not yet due, an active union account).
 */
export async function seedCards(
  h: Harness,
  f: AuthFixture,
  appId: string,
  n: Amounts,
): Promise<void> {
  const now = f.clock.now();
  const base = { s: undefined as never, db: h.db, clock: f.clock, appId };
  // withdraw_review_pending
  const payout: PayoutFixture = { ...base, payout: undefined as never };
  const payee = await seedPayee(payout, { crypto: h.fields });
  for (let i = 0; i < n.withdraw_review_pending; i += 1)
    await seedWithdrawal(payout, { crypto: h.fields }, payee, { status: 'PENDING_REVIEW' });
  await seedWithdrawal(payout, { crypto: h.fields }, payee, { status: 'REJECTED' });
  // claim_review_pending: auto_matched gets ceil(n/2), manual_review the rest.
  if (n.claim_review_pending > 0) {
    const s = await claimScenario(h, { appId, grants: [] });
    for (let i = 0; i < n.claim_review_pending; i += 1) {
      const status = i % 2 === 0 ? 'auto_matched' : 'manual_review';
      await seedClaim(s, { status, ...evidenceFor(status) });
    }
  }
  // settle_bill_pending: one generated bill per item, each with a DRAFT batch.
  const settle: SettleFixture = base;
  for (let i = 0; i < n.settle_bill_pending; i += 1) {
    const bill = await seedBill(settle, `2026-0${1 + i}`);
    await seedBatch(settle, bill);
  }
  // recon_diff_open
  const recon: ReconFixture = base;
  for (let i = 0; i < n.recon_diff_open; i += 1) await seedDiff(recon, { status: 'open' });
  // appeal_pending: account appeals still processing (appeals kit rows; scope of one app).
  const appeals = { h, f, appId } as unknown as AppealScenario;
  for (let i = 0; i < n.appeal_pending; i += 1) {
    const user = await appealMember(appeals, { state: 'appealing' });
    await accountAppeal(appeals, user, 'frozen', { status: 'processing' });
  }
  // agent_report_overdue: pending reports 72 h old, plus one pending report 1 h old.
  const agent: AgentFixture = base;
  const session = await reportSession(agent);
  for (let i = 0; i < n.agent_report_overdue; i += 1) {
    await seedReport(agent, session, {
      label: `overdue-${i}`,
      status: 'pending',
      reportedAt: new Date(now.getTime() - 72 * HOUR_MS),
    });
  }
  await seedReport(agent, session, {
    label: 'not-yet-due',
    status: 'pending',
    reportedAt: new Date(now.getTime() - HOUR_MS),
  });
  // union_auth_expiring: expiring and expired accounts, plus an active one.
  const union = { h, f, appId };
  for (let i = 0; i < n.union_auth_expiring; i += 1) {
    await seedAccount(
      union,
      i % 2 === 0
        ? { auth_status: 'expiring', alert_stage: 'd14' }
        : { auth_status: 'expired', alert_stage: 'expired' },
    );
  }
  await seedAccount(union, {});
}
