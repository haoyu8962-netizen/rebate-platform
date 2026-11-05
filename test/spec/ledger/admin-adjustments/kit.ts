// B2-12c rule-test kit (claude-independent, SPEC_REF ea202ff6): contracts/openapi.yaml
// adminListAdjustments (GET /admin/v1/adjustments), adminGetAdjustment
// (GET /admin/v1/adjustments/{adjust_id}) and adminCreateAdjustment (POST /admin/v1/adjustments,
// fund.adjust, step-up sms, Idempotency-Key; CT-24zg, CT-26n) with 08 BR-FUND-24 (人工调账; 细则
// 「红冲只按原单整笔」「后台入口」「注销调减单被驳回与注销中的调账」D10-590 ④), BR-FUND-10, BR-FUND-16
// and BR-TEXT-19 (站内信 BALANCE_ADJUSTED), specs/ledger-templates.csv (ADMIN_ADJUST:*).
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// the step-up gate over Redis, contract validation, PostgreSQL idempotency, admin's audit writer,
// the entry's ledger with its event bus and payout's recovery hook), PostgreSQL through
// @couli/db/testing (couli_app), Redis for the admin sessions and step-up tokens. The sms-tier
// token is issued the way POST /admin/v1/auth/step-up issues it after a correct SMS code
// (createAdminStepUpTokens on the entry's Redis namespace admin-step-up).
// Synthetic (fixtures, never on the path under test): members, their balances (a plain ledger with
// no bus and no hook), withdrawals, differences, deletion requests, orders, already-filed forms
// with their vouchers, admin accounts, and a one-shot fault in the entry's database handle.
// A fixture that cannot be built throws a plain Error, never an assertion. Missing pieces fail as
// assertions (an unregistered admin route answers 404). No real user, payee or merchant data.
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { buildVouchers } from '@couli/domain';
import {
  PostgresQueryCompiler,
  sql,
  type Kysely,
  type KyselyPlugin,
  type Selectable,
  type Transaction,
} from 'kysely';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import {
  createLedger,
  type AccountBalance,
  type Ledger,
  type PostingEntry,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  FixedClock,
  REDIS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createValidatorCompiler } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import type { Suite } from '../../payment/orders/kit.ts';
import { contractPaths, seedDiff, type DiffRow, type DiffSeed } from '../admin-recon-diffs/kit.ts';

export { suite } from '../../payment/orders/kit.ts';
export { track, waiting, type Tracked } from '../admin-recon-close/kit.ts';

/** 2026-11-30 10:30 +08:00, the instant of the contract examples. */
export const NOW = '2026-11-30T02:30:00.000Z';
/** The +08:00 accounting day of NOW. */
export const DAY = '2026-11-30';
export const DAY_MS = 86_400_000;
export const LIST_PATH = '/admin/v1/adjustments';
export const DETAIL_PATH = '/admin/v1/adjustments/{adjust_id}';
/** specs/permissions.yaml: fund.adjust (step-up sms) files; fund.view only reads. */
export const ADJUST = 'fund.adjust';
export const VIEW = 'fund.view';
/** The audit actions of the contract (adminCreateAdjustment). */
export const CREATE_ACTION = 'adjustment_create';
export const REVERSE_ACTION = 'adjustment_reverse';
export const DENIED_ACTION = 'adjustment_denied';
/** The ledger's event when available crosses below zero (BR-WDR-05 (a)). */
export const WENT_NEGATIVE = 'account.went_negative';
/** BR-TEXT-19 站内信 BALANCE_ADJUSTED; title inbox.title.BALANCE_ADJUSTED (contracts/texts.default.json). */
export const MESSAGE_CODE = 'BALANCE_ADJUSTED';
export const MESSAGE_TITLE = '余额调整';
/** BR-TEXT-19「ADMIN_ADJUST 原因码文案」名称列 ({adjust_reason}). */
export const REASON_NAMES: Readonly<Record<string, string>> = Object.freeze({
  RESTORE: '订单恢复补发',
  RECON_FIX: '结算核对更正',
  PAYOUT_RECOVERY: '重复到账追回',
  ACCOUNT_CLOSED: '注销放弃余额',
  OTHER: '人工调账',
});
/** The four subjects RECON_FIX and OTHER may choose (specs/ledger-rules.md §6 方案 A). */
export const CHOOSABLE_SUBJECTS = [
  'COMMISSION_REVENUE',
  'UNION_RECEIVABLE',
  'BAD_DEBT',
  'MKT_EXPENSE',
] as const;
/** payout channel → cash subject of PAYOUT_RECOVERY (BR-FUND-24 ⑥, BR-WDR-33 ⑨). */
export const CASH_SUBJECTS = [
  ['alipay', 'CASH_ALIPAY'],
  ['wechat', 'CASH_WECHAT'],
  ['bank_card', 'CASH_BANK'],
] as const;

/** BR-TEXT-19: 「你的余额调减 {amount}，原因：{adjust_reason}。如有疑问，请联系客服。」 */
export function messageBody(amountText: string, reason: string): string {
  const name = REASON_NAMES[reason];
  if (name === undefined) throw new Error(`kit: no BR-TEXT-19 name for ${reason}`);
  return `你的余额调减 ${amountText}，原因：${name}。如有疑问，请联系客服。`;
}

const ROOT = new URL('../../../../', import.meta.url);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------------------------
// One app on the suite's database.

export type Direction = 'increase' | 'decrease';
export type RefType = 'recon_diff' | 'withdrawal' | 'order' | 'account_deletion';
export interface Ref {
  readonly ref_type: RefType;
  readonly ref_id: string;
}
export type FormRow = Selectable<DB['admin_adjustments']>;
export type AuditRow = Selectable<DB['audit_logs']>;

export interface AdjustFixture {
  readonly s: Suite;
  readonly db: Kysely<DB>;
  readonly clock: FixedClock;
  readonly appId: string;
  /** The ledger of the seeds: no event bus, no recovery hook (never on the path under test). */
  readonly ledger: Ledger;
}

export function newAppId(): string {
  return `adj_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

export function fixture(s: Suite, instant = NOW): AdjustFixture {
  const clock = new FixedClock(instant);
  return { s, db: s.db(), clock, appId: newAppId(), ledger: createLedger({ clock }) };
}

/** An instant `minutes` before the fixture's clock. */
export function ago(f: AdjustFixture, minutes: number): Date {
  return new Date(f.clock.now().getTime() - minutes * 60_000);
}

export type MemberStatus = 'normal' | 'deleting' | 'deleted';

/**
 * A synthetic member (users.status as given, default normal) with a ledger account whose available
 * is `available` (default 0); in `appId` when given.
 */
export async function member(
  f: AdjustFixture,
  options: {
    readonly available?: bigint;
    readonly status?: MemberStatus;
    readonly appId?: string;
  } = {},
): Promise<string> {
  const appId = options.appId ?? f.appId;
  const userId = randomUUID();
  const at = ago(f, 60 * 24 * 30);
  await sql`INSERT INTO app.users
    (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, status,
     created_at, updated_at)
    VALUES (${userId}, ${appId}, 'synthetic', 'synthetic', ${randomUUID()}, ${randomUUID()}, 'L1',
      'sms', ${options.status ?? 'normal'}, ${at}, ${at})`.execute(f.db);
  await f.db.transaction().execute(async (trx) => {
    await lockUsersForUpdate(trx, { appId, userIds: [userId] });
    await f.ledger.openUserAccount(trx, { appId, userId });
  });
  const available = options.available ?? 0n;
  if (available !== 0n) await shift(f, userId, available, appId);
  return userId;
}

async function lockMember(
  f: AdjustFixture,
  trx: Transaction<DB>,
  appId: string,
  userId: string,
): Promise<AccountBalance> {
  await lockUsersForUpdate(trx, { appId, userIds: [userId] });
  const [balance] = await f.ledger.lockBalances(trx, { appId, userIds: [userId] });
  if (balance === undefined) throw new Error(`kit: ${userId} has no ledger account`);
  return balance;
}

/**
 * Moves the member's available by `delta` as other flows would have left it: a credit is a plain
 * REBATE_CREDIT, a debit an ADMIN_ADJUST (sub_type OTHER) that may end below zero (BR-FUND-10).
 */
export async function shift(
  f: AdjustFixture,
  userId: string,
  delta: bigint,
  appId = f.appId,
): Promise<void> {
  await f.db.transaction().execute(async (trx) => {
    const balance = await lockMember(f, trx, appId, userId);
    const credit = delta > 0n;
    const line = (
      account: PostingEntry['account'],
      amount: bigint,
      user: boolean,
    ): PostingEntry => ({
      account,
      sub_account: 'available',
      amount_fen: amount,
      ledger_type: credit ? 'REBATE_CREDIT' : 'ADMIN_ADJUST',
      sub_type: credit ? null : 'OTHER',
      income_type: credit && user ? 'SERVICE_FEE' : null,
    });
    await f.ledger.post(trx, {
      appId,
      uniqKey: `SEED:${randomUUID()}`,
      bizType: 'TEST_SEED',
      bizId: randomUUID(),
      operator: 'system',
      memo: null,
      orderKey: null,
      beneficiaryUserId: null,
      role: null,
      voucherKind: null,
      entries: [
        line({ ownerType: 'user', accountId: balance.account_id }, -delta, true),
        line(
          {
            ownerType: 'platform',
            subject: credit ? 'UNION_RECEIVABLE:taobao' : 'COMMISSION_REVENUE',
          },
          delta,
          false,
        ),
      ],
    });
  });
}

/** WITHDRAW:FREEZE of `amount` (available → frozen), as W1 leaves it, on a locked transaction. */
export async function postFreeze(
  f: AdjustFixture,
  trx: Transaction<DB>,
  balance: AccountBalance,
  amount: bigint,
  withdrawalId: string = randomUUID(),
): Promise<void> {
  const [built] = buildVouchers('WITHDRAW:FREEZE', {
    withdrawal_id: withdrawalId,
    user_id: balance.user_id,
    withdraw_fen: amount,
  });
  if (built === undefined) throw new Error('kit: WITHDRAW:FREEZE built no voucher');
  await f.ledger.post(trx, {
    appId: balance.app_id,
    uniqKey: built.uniq_key,
    bizType: 'withdrawal',
    bizId: withdrawalId,
    operator: 'system',
    memo: null,
    orderKey: null,
    beneficiaryUserId: null,
    role: null,
    voucherKind: null,
    entries: built.entries.map((entry) => ({
      account: { ownerType: 'user', accountId: balance.account_id },
      sub_account: entry.sub_account === 'frozen' ? 'frozen' : 'available',
      amount_fen: entry.amount_fen,
      ledger_type: entry.ledger_type,
      sub_type: entry.sub_type,
      income_type: null,
    })),
  });
}

/** Freezes `amount` of the member's available, with no withdrawal row. */
export async function freeze(f: AdjustFixture, userId: string, amount: bigint): Promise<void> {
  await f.db.transaction().execute(async (trx) => {
    const balance = await lockMember(f, trx, f.appId, userId);
    await postFreeze(f, trx, balance, amount);
  });
}

export type Channel = 'alipay' | 'bank_card' | 'wechat';

/**
 * A withdrawal of the member: PAID_API one day ago by default (no freeze); APPROVED freezes its
 * amount with the real WITHDRAW:FREEZE and may carry the NEGATIVE_BALANCE block.
 */
export async function seedWithdrawal(
  f: AdjustFixture,
  userId: string,
  options: {
    readonly channel?: Channel;
    readonly status?: 'PAID_API' | 'APPROVED';
    readonly amount?: bigint;
    readonly blocked?: boolean;
    readonly appId?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const appId = options.appId ?? f.appId;
  const channel = options.channel ?? 'alipay';
  const status = options.status ?? 'PAID_API';
  const amount = options.amount ?? 10_000n;
  const at = ago(f, 60 * 24);
  const paid = status === 'PAID_API';
  await f.db.transaction().execute(async (trx) => {
    await sql`INSERT INTO app.withdrawals
      (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
       payee_name, payee_account_cipher, payee_hmac, bank_name, wechat_app_id, status, out_biz_no,
       payout_channel, review_mode, blocked_reason, paid_at, channel_order_id, created_at,
       updated_at)
      VALUES (${id}, ${appId}, ${userId}, ${amount}, 0, 0, ${amount}, 'SERVICE_FEE', ${channel},
       '合成姓名', ${Buffer.from('synthetic-encrypted-account')}, ${randomBytes(32).toString('hex')},
       ${channel === 'bank_card' ? '合成银行' : null}, ${channel === 'wechat' ? 'wx_synthetic' : null},
       ${status}, ${randomBytes(16).toString('hex')}, ${channel}, 'manual',
       ${options.blocked === true ? 'NEGATIVE_BALANCE' : null}, ${paid ? at : null},
       ${paid ? `SEED${randomBytes(8).toString('hex')}` : null}, ${at}, ${at})`.execute(trx);
    if (paid) return;
    const balance = await lockMember(f, trx, appId, userId);
    await postFreeze(f, trx, balance, amount, id);
  });
  return id;
}

/** One withdrawals row as it is now. */
export async function withdrawalNow(f: AdjustFixture, id: string) {
  const row = await f.db
    .selectFrom('withdrawals')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (row === undefined) throw new Error(`kit: withdrawal ${id} is missing`);
  return row;
}

/** A deletion request of the member in processing (BR-ID-28), in `appId` when given. */
export async function seedDeletion(
  f: AdjustFixture,
  userId: string,
  appId = f.appId,
): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO app.deletion_requests
    (id, app_id, user_id, status, apply_at, cooling_until, balance_snapshot_fen, created_at,
     updated_at)
    VALUES (${id}, ${appId}, ${userId}, 'processing', ${ago(f, 8 * 24 * 60)},
      ${ago(f, 24 * 60)}, 0, ${ago(f, 8 * 24 * 60)}, ${ago(f, 24 * 60)})`.execute(f.db);
  return id;
}

/** A sub-order of the member (order_keys + orders); returns its order_key `taobao:{sub_order_id}`. */
export async function seedOrder(f: AdjustFixture, userId: string): Promise<string> {
  const orderId = randomUUID();
  const subOrderId = `adj-${orderId}`;
  const at = ago(f, 10 * 24 * 60);
  await sql`INSERT INTO app.order_keys (platform, sub_order_id, order_id, app_id, attr_at, created_at)
    VALUES ('taobao', ${subOrderId}, ${orderId}, ${f.appId}, ${at}, ${at})`.execute(f.db);
  await sql`INSERT INTO app.orders
    (order_id, app_id, platform, sub_order_id, raw_item_id, user_id, user_basis, buy_type,
     platform_status, rebate_status, attr_at, created_at, updated_at)
    VALUES (${orderId}, ${f.appId}, 'taobao', ${subOrderId}, 'synthetic', ${userId}, 'param', 'self',
      'RECEIVED', 'WAITING', ${at}, ${at}, ${at})`.execute(f.db);
  return `taobao:${subOrderId}`;
}

/** A difference of the fixture's app (default R3 ledger_mismatch, open). */
export function seedReconDiff(f: AdjustFixture, patch: DiffSeed = {}): Promise<DiffRow> {
  return seedDiff(f, { source: 'R3', type: 'ledger_mismatch', ...patch });
}

/** A 收款对账 (R4) difference, which never leads to a balance adjustment (BR-PAY-07). */
export function seedR4Diff(f: AdjustFixture): Promise<DiffRow> {
  return seedDiff(f, {
    source: 'R4',
    type: 'pay_mismatch',
    ref_type: 'pay_order',
    ref_id: randomUUID(),
  });
}

/** An admin account of `appId` without a session (the filer of a seeded form). */
export async function seedAdmin(f: AdjustFixture, appId = f.appId): Promise<string> {
  const id = randomUUID();
  await f.db
    .insertInto('admin_users')
    .values({
      id,
      app_id: appId,
      login_name: `adj_seed_${id}`,
      password_hash: 'unused-test-login',
      is_super: false,
      status: 'active',
    })
    .execute();
  return id;
}

export interface FormSeed {
  readonly userId: string;
  readonly direction?: Direction;
  readonly amount?: bigint | null;
  readonly reason?: string;
  readonly refs?: readonly Ref[];
  readonly contra?: string;
  readonly platform?: string | null;
  readonly note?: string | null;
  readonly status?: 'PENDING' | 'APPROVED' | 'REJECTED';
  /** The original of a reversal: direction, amount, reason and subject are taken from it. */
  readonly reverses?: FormRow;
  readonly createdBy?: string | null;
  readonly createdAt?: Date;
  readonly appId?: string;
}

/**
 * A form as an earlier filing left it, written directly. An APPROVED one carries its real
 * ADMIN_ADJUST voucher (`ADJ:{adjust_id}`, or `ADJ:{original}:REVERSE` for a reversal) posted on
 * the plain ledger, so the member's balance moved with it.
 */
export async function seedForm(f: AdjustFixture, seed: FormSeed): Promise<FormRow> {
  const appId = seed.appId ?? f.appId;
  const adjustId = randomUUID();
  const original = seed.reverses;
  const status = seed.status ?? 'APPROVED';
  const reason = seed.reason ?? original?.reason_code ?? 'RECON_FIX';
  const opposite: Direction = original?.direction === 'increase' ? 'decrease' : 'increase';
  const direction: Direction = seed.direction ?? opposite;
  const amount =
    seed.amount !== undefined ? seed.amount : original !== undefined ? original.amount_fen : 500n;
  const contra =
    seed.contra ??
    original?.contra_subject ??
    (reason === 'PAYOUT_RECOVERY' ? 'CASH_ALIPAY' : 'COMMISSION_REVENUE');
  const platform =
    seed.platform !== undefined ? seed.platform : (original?.contra_platform ?? null);
  const defaultRefs: readonly Ref[] =
    original !== undefined ? [] : [{ ref_type: 'recon_diff', ref_id: randomUUID() }];
  const refs: readonly Ref[] = seed.refs ?? defaultRefs;
  const createdBy =
    seed.createdBy !== undefined
      ? seed.createdBy
      : reason === 'ACCOUNT_CLOSED' && original === undefined
        ? null
        : await seedAdmin(f, appId);
  const reviewed = status !== 'PENDING';
  const reviewedBy = reviewed ? (createdBy ?? (await seedAdmin(f, appId))) : null;
  const createdAt = seed.createdAt ?? ago(f, 60);
  let voucherId: string | null = null;
  if (status === 'APPROVED') {
    if (amount === null) throw new Error('kit: an APPROVED form needs an amount');
    const fen: bigint = amount;
    voucherId = await f.db.transaction().execute(async (trx) => {
      const balance = await lockMember(f, trx, appId, seed.userId);
      const userAmount = direction === 'increase' ? -fen : fen;
      const subject = contra === 'UNION_RECEIVABLE' ? `UNION_RECEIVABLE:${platform ?? ''}` : contra;
      const line = (account: PostingEntry['account'], amountFen: bigint): PostingEntry => ({
        account,
        sub_account: 'available',
        amount_fen: amountFen,
        ledger_type: 'ADMIN_ADJUST',
        sub_type: reason,
        income_type: null,
      });
      const posted = await f.ledger.post(trx, {
        appId,
        uniqKey: original === undefined ? `ADJ:${adjustId}` : `ADJ:${original.adjust_id}:REVERSE`,
        bizType: 'admin_adjustment',
        bizId: adjustId,
        operator: `admin:${reviewedBy ?? 'unknown'}`,
        memo: null,
        orderKey: null,
        beneficiaryUserId: null,
        role: null,
        voucherKind: original === undefined ? 'ADMIN_ADJUST' : 'ADMIN_ADJUST_REV',
        entries: [
          line({ ownerType: 'user', accountId: balance.account_id }, userAmount),
          line({ ownerType: 'platform', subject }, -userAmount),
        ],
      });
      return posted.voucherId;
    });
  }
  await f.db
    .insertInto('admin_adjustments')
    .values({
      adjust_id: adjustId,
      app_id: appId,
      user_id: seed.userId,
      direction,
      amount_fen: amount,
      reason_code: reason,
      refs: JSON.stringify(refs),
      contra_subject: contra,
      contra_platform: platform,
      note: seed.note !== undefined ? seed.note : '既有调账单',
      status,
      reverses_adjust_id: original?.adjust_id ?? null,
      created_by: createdBy,
      created_at: createdAt,
      reviewed_by: reviewedBy,
      reviewed_at: reviewed ? createdAt : null,
      reject_note: status === 'REJECTED' ? '核对后不需要调整' : null,
      voucher_id: voucherId,
    })
    .execute();
  const row = await formNow(f, adjustId, appId);
  if (row === undefined) throw new Error(`kit: form ${adjustId} was not written`);
  return row;
}

/** A system-prefilled ACCOUNT_CLOSED form (BR-FUND-24 ⑧): PENDING, no amount, no filer. */
export async function seedPrefill(
  f: AdjustFixture,
  userId: string,
  patch: Partial<FormSeed> = {},
): Promise<FormRow> {
  return seedForm(f, {
    userId,
    direction: 'decrease',
    amount: null,
    reason: 'ACCOUNT_CLOSED',
    refs: [{ ref_type: 'account_deletion', ref_id: randomUUID() }],
    contra: 'COMMISSION_REVENUE',
    platform: null,
    note: null,
    status: 'PENDING',
    createdBy: null,
    ...patch,
  });
}

/** One admin_adjustments row as it is now (undefined when there is none). */
export async function formNow(
  f: AdjustFixture,
  adjustId: string,
  appId = f.appId,
): Promise<FormRow | undefined> {
  return f.db
    .selectFrom('admin_adjustments')
    .selectAll()
    .where('app_id', '=', appId)
    .where('adjust_id', '=', adjustId)
    .executeTakeFirst();
}

/** Every form of the app, by adjust_id. */
export function allForms(f: AdjustFixture): Promise<FormRow[]> {
  return f.db
    .selectFrom('admin_adjustments')
    .selectAll()
    .where('app_id', '=', f.appId)
    .orderBy('adjust_id')
    .execute();
}

/** The AdminAdjustment a row must be shown as (instants as epoch milliseconds). */
export function formView(row: FormRow, reversedBy: string | null = null): Record<string, unknown> {
  return {
    adjust_id: row.adjust_id,
    user_id: row.user_id,
    direction: row.direction,
    amount_fen: row.amount_fen === null ? null : Number(row.amount_fen),
    reason_code: row.reason_code,
    refs: row.refs,
    contra_subject: row.contra_subject,
    contra_platform: row.contra_platform,
    note: row.note,
    status: row.status,
    reverses_adjust_id: row.reverses_adjust_id,
    reversed_by_adjust_id: reversedBy,
    created_by: row.created_by,
    created_at: row.created_at.getTime(),
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at === null ? null : row.reviewed_at.getTime(),
    reject_note: row.reject_note,
    voucher_id: row.voucher_id,
  };
}

/** A response AdminAdjustment with its date-time strings as epoch milliseconds. */
export function normalizeForm(item: unknown): Record<string, unknown> {
  expect(typeof item === 'object' && item !== null, JSON.stringify(item)).toBe(true);
  const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const key of ['created_at', 'reviewed_at']) {
    const value = out[key];
    if (typeof value === 'string') out[key] = Date.parse(value);
  }
  return out;
}

/** Forms newest first: created_at descending, then adjust_id descending. */
export function newestFirst(rows: readonly FormRow[]): string[] {
  return [...rows]
    .sort((a, b) => {
      const at = b.created_at.getTime() - a.created_at.getTime();
      if (at !== 0) return at;
      return a.adjust_id < b.adjust_id ? 1 : a.adjust_id > b.adjust_id ? -1 : 0;
    })
    .map((row) => row.adjust_id);
}

// ---------------------------------------------------------------------------------------------
// Ledger reads.

export async function balanceOf(
  f: AdjustFixture,
  userId: string,
): Promise<AccountBalance | undefined> {
  const [row] = await f.ledger.getBalances(f.db, { appId: f.appId, userIds: [userId] });
  return row;
}

export interface VoucherRow {
  readonly id: string;
  readonly uniq_key: string;
  readonly biz_type: string;
  readonly biz_id: string;
  readonly operator: string;
  readonly accounting_date: string;
  readonly order_key: string | null;
  readonly beneficiary_user_id: string | null;
  readonly role: string | null;
  readonly voucher_kind: string | null;
}

/** The app's voucher with this uniq_key (undefined when there is none). */
export async function voucherByKey(
  f: AdjustFixture,
  uniqKey: string,
): Promise<VoucherRow | undefined> {
  const result = await sql<VoucherRow>`
    SELECT id, uniq_key, biz_type, biz_id, operator, accounting_date::text AS accounting_date,
      order_key, beneficiary_user_id, role, voucher_kind
    FROM app.ledger_vouchers WHERE app_id = ${f.appId} AND uniq_key = ${uniqKey}`.execute(f.db);
  return result.rows[0];
}

/** Every voucher of the app whose uniq_key starts with ADJ:, by uniq_key. */
export async function adjustVouchers(f: AdjustFixture): Promise<VoucherRow[]> {
  const result = await sql<VoucherRow>`
    SELECT id, uniq_key, biz_type, biz_id, operator, accounting_date::text AS accounting_date,
      order_key, beneficiary_user_id, role, voucher_kind
    FROM app.ledger_vouchers WHERE app_id = ${f.appId} AND uniq_key LIKE 'ADJ:%'
    ORDER BY uniq_key`.execute(f.db);
  return result.rows;
}

export interface EntryView {
  readonly owner_type: string;
  readonly owner_id: string;
  readonly subject: string;
  readonly sub_account: string;
  readonly amount_fen: bigint;
  readonly ledger_type: string;
  readonly sub_type: string | null;
}

function sortEntries(entries: readonly EntryView[]): EntryView[] {
  const key = (e: EntryView) =>
    `${e.owner_type}|${e.subject}|${e.sub_account}|${e.amount_fen.toString()}`;
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** The entries of the app's voucher `uniqKey`, with their accounts. */
export async function entriesOf(f: AdjustFixture, uniqKey: string): Promise<EntryView[]> {
  const result = await sql<EntryView>`
    SELECT a.owner_type, a.owner_id, a.subject, e.sub_account, e.amount_fen, e.ledger_type,
      e.sub_type
    FROM app.ledger_entries e
    JOIN app.ledger_vouchers v ON v.app_id = e.app_id AND v.id = e.voucher_id
    JOIN app.ledger_accounts a ON a.app_id = e.app_id AND a.id = e.account_id
    WHERE v.app_id = ${f.appId} AND v.uniq_key = ${uniqKey}`.execute(f.db);
  return sortEntries(result.rows);
}

interface TemplateLine {
  readonly id: string;
  readonly ledgerType: string;
  readonly subType: string;
  readonly owner: string;
  readonly subject: string;
  readonly subAccount: string;
  readonly sign: string;
}

let templateCache: TemplateLine[] | undefined;

/** specs/ledger-templates.csv (no cell before the note column holds a comma). */
function templateLines(): TemplateLine[] {
  templateCache ??= readFileSync(new URL('specs/ledger-templates.csv', ROOT), 'utf8')
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const cells = line.split(',');
      return {
        id: cells[0] ?? '',
        ledgerType: cells[1] ?? '',
        subType: cells[2] ?? '',
        owner: cells[5] ?? '',
        subject: cells[6] ?? '',
        subAccount: cells[7] ?? '',
        sign: cells[8] ?? '',
      };
    });
  return templateCache;
}

/** The entries specs/ledger-templates.csv writes for `templateId` on this member and amount. */
export function templateEntries(
  templateId: string,
  input: { readonly userId: string; readonly platform: string | null; readonly amount: bigint },
): EntryView[] {
  const lines = templateLines().filter((line) => line.id === templateId);
  if (lines.length < 2) throw new Error(`kit: template ${templateId} is not in the CSV`);
  return sortEntries(
    lines.map((line) => ({
      owner_type: line.owner,
      owner_id: line.owner === 'user' ? input.userId : 'platform',
      subject: line.subject.replace('{platform}', input.platform ?? ''),
      sub_account: line.subAccount,
      amount_fen: line.sign === 'debit' ? input.amount : -input.amount,
      ledger_type: line.ledgerType,
      sub_type: line.subType === '' ? null : line.subType,
    })),
  );
}

/** The template of a form: ADMIN_ADJUST:{reason}:{subject}:{INCREASE|DECREASE}[:REVERSE]. */
export function templateOf(input: {
  readonly reason: string;
  readonly contra: string;
  /** The direction of the original form (of the form itself when not a reversal). */
  readonly originalDirection: Direction;
  readonly reversal: boolean;
}): string {
  const base =
    input.reason === 'ACCOUNT_CLOSED'
      ? 'ADMIN_ADJUST:ACCOUNT_CLOSED'
      : `ADMIN_ADJUST:${input.reason}:${input.contra}:${input.originalDirection.toUpperCase()}`;
  return input.reversal ? `${base}:REVERSE` : base;
}

/** The app's account.went_negative events naming the member. */
export async function wentNegative(f: AdjustFixture, userId: string) {
  const result = await sql<{ name: string; payload: unknown }>`
    SELECT name, payload FROM app.event_log
    WHERE app_id = ${f.appId} AND name = ${WENT_NEGATIVE}
      AND payload->'data'->>'user_id' = ${userId}
    ORDER BY id`.execute(f.db);
  return result.rows;
}

/** The member's inbox messages (code, title, body), oldest first. */
export async function inboxOf(f: AdjustFixture, userId: string) {
  return f.db
    .selectFrom('inbox_messages')
    .select(['code', 'title', 'body'])
    .where('app_id', '=', f.appId)
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('message_id')
    .execute();
}

/** The audit records of the app, in insertion order; only `action` when given. */
export function audits(f: AdjustFixture, action?: string): Promise<AuditRow[]> {
  let query = f.db.selectFrom('audit_logs').selectAll().where('app_id', '=', f.appId);
  if (action !== undefined) query = query.where('action', '=', action);
  return query.orderBy('id').execute();
}

function leaves(value: unknown, out: string[]): string[] {
  if (value === null || value === undefined) return out;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    out.push(String(value));
  } else if (typeof value === 'boolean') {
    out.push(String(value));
  } else if (Array.isArray(value)) {
    for (const item of value) leaves(item, out);
  } else if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) leaves(item, out);
  }
  return out;
}

/**
 * The audit record carries every id (as a whole value or inside one) and every value (as a whole
 * JSON value, number or string), anywhere in target, before or after.
 */
export function expectMentions(
  row: AuditRow,
  expected: { readonly ids: readonly string[]; readonly values: readonly (string | bigint)[] },
): void {
  const found = leaves([row.target, row.before, row.after], []);
  for (const id of expected.ids) {
    expect(
      found.some((leaf) => leaf.includes(id)),
      `${id} in ${JSON.stringify(found)}`,
    ).toBe(true);
  }
  for (const value of expected.values) {
    expect(found, `${String(value)} in ${JSON.stringify(found)}`).toContain(String(value));
  }
}

/**
 * Everything a refused or rolled-back request must leave as it was: forms, vouchers, entries,
 * balances, events, inbox messages and notify_logs of the app (audit records separately).
 */
export async function trace(f: AdjustFixture) {
  const entries = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.ledger_entries WHERE app_id = ${f.appId}`.execute(f.db);
  return {
    forms: await allForms(f),
    vouchers: await f.db
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    entries: entries.rows[0]?.n ?? '0',
    balances: await f.db
      .selectFrom('account_balances')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('account_id')
      .execute(),
    events: await f.db
      .selectFrom('event_log')
      .select(['name', 'payload'])
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    inbox: await f.db
      .selectFrom('inbox_messages')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('message_id')
      .execute(),
    notifyLogs: await f.db
      .selectFrom('notify_logs')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
  };
}

// ---------------------------------------------------------------------------------------------
// Row locks held from the suite's one-connection pool.

export interface HeldLock {
  release(): Promise<void>;
}

/**
 * Holds the member's users row and balance row (identity's lock, then ledger.lockBalances, the
 * order every funds writer takes) from the suite's second pool; `beforeCommit` runs on that
 * transaction after release() and before it commits.
 */
export async function holdMember(
  f: AdjustFixture,
  userId: string,
  beforeCommit?: (trx: Transaction<DB>, balance: AccountBalance) => Promise<void>,
): Promise<HeldLock> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = f.s
    .holder()
    .transaction()
    .execute(async (trx) => {
      const balance = await lockMember(f, trx, f.appId, userId);
      locked();
      await gate;
      if (beforeCommit !== undefined) await beforeCommit(trx, balance);
    });
  await Promise.race([ready, done]);
  return {
    async release() {
      open();
      await done;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// A one-shot fault in the entry's database handle.

/** The INSERT of the adjustment_create / adjustment_reverse audit record, or of the inbox message. */
export type FaultPoint = 'audit' | 'inbox';

export interface Fault {
  /** One-shot: set it, the next matching statement fails and it goes back to null. */
  point: FaultPoint | null;
  tripped: number;
}

function faultPlugin(fault: Fault): KyselyPlugin {
  const compiler = new PostgresQueryCompiler();
  return {
    transformQuery({ node, queryId }) {
      const point = fault.point;
      if (point === null) return node;
      const compiled = compiler.compileQuery(node, queryId);
      const text = compiled.sql;
      const params = JSON.stringify(compiled.parameters, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      const hit =
        point === 'audit'
          ? /insert\s+into\s+(?:"?app"?\s*\.\s*)?"?audit_logs\b/i.test(text) &&
            [CREATE_ACTION, REVERSE_ACTION].some(
              (action) => text.includes(action) || params.includes(action),
            )
          : /insert\s+into\s+(?:"?app"?\s*\.\s*)?"?inbox_messages\b/i.test(text);
      if (hit) {
        fault.point = null;
        fault.tripped += 1;
        throw new Error(`synthetic failure at ${point}`);
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export type Operation = 'list' | 'detail' | 'create';

export interface Envelope {
  code: number;
  msg: string;
  data?: unknown;
  trace_id: string;
}

export interface AdminSent {
  readonly op: Operation;
  readonly statusCode: number;
  readonly body: string;
  json(): Envelope;
}

export interface AdminCaller {
  readonly id: string;
  readonly token: string;
  readonly sessionId: string;
}

export interface CallerOptions {
  readonly superAdmin?: boolean;
  /** A registered verify phone (sms tier); default true. */
  readonly phone?: boolean;
}

export interface CreateOptions {
  /** Idempotency-Key: a fresh one by default; null sends none. */
  readonly key?: string | null;
  /** The caller: `maker` by default; null sends no token. */
  readonly caller?: AdminCaller | null;
  /** X-Step-Up-Token: a fresh sms-tier token of the caller by default; null sends none. */
  readonly stepUp?: string | null;
}

export interface AdjustAdmin {
  readonly fault: Fault;
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(permissions: readonly string[], options?: CallerOptions): Promise<AdminCaller>;
  /** A step-up token of the caller's account and admin session (tier sms by default). */
  stepUp(caller: AdminCaller, tier?: 'totp' | 'sms'): Promise<string>;
  /** POST /admin/v1/adjustments with the JSON body. */
  create(body: unknown, options?: CreateOptions): Promise<AdminSent>;
  /** GET /admin/v1/adjustments with the query, as `viewer` unless given (null: no token). */
  list(query?: Record<string, string>, caller?: AdminCaller | null): Promise<AdminSent>;
  /** GET /admin/v1/adjustments/{adjust_id}, as `viewer` unless given (null: no token). */
  detail(adjustId: string, caller?: AdminCaller | null): Promise<AdminSent>;
  /** An account with fund.adjust only and a registered verify phone. */
  readonly maker: AdminCaller;
  /** An account with fund.view only. */
  readonly viewer: AdminCaller;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}

/** A fresh Idempotency-Key of the contract format (8–64 of [A-Za-z0-9_-]). */
export function newKey(): string {
  return `adj_${randomBytes(12).toString('hex')}`;
}

/**
 * Runs `run` against a started admin entry on the fixture's database (through the fault plugin),
 * clock and Redis.
 */
export async function withAdjustAdmin(
  f: AdjustFixture,
  run: (h: AdjustAdmin) => Promise<void>,
): Promise<void> {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'admin',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: RootLogger;
        dbHandles: DbHandles;
        redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b2-12c-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
  const fault: Fault = { point: null, tripped: 0 };
  const store = f.db.withPlugin(faultPlugin(fault));
  let app: HttpApp | undefined;
  try {
    app = await createHttpApp('admin', {
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
        FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
        ADMIN_TOKEN_SIGNING_KEY: tokenKey.toString('base64url'),
        ADMIN_IP_ALLOWLIST: '127.0.0.1,::1',
        ADMIN_CORS_ORIGIN: 'https://admin.example.invalid',
        JWT_KEY_ID: 'b2_12c_test',
        JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock: f.clock,
      logger: createRootLogger(
        { entry: 'admin', appEnv: 'test', level: 'silent' },
        { write: () => undefined },
      ),
      dbHandles: { db: store, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('admin', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        DATABASE_READ_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: f.s.redisUrl(),
      }).redisUrl,
    });
    await app.init();
    const server = app;
    const redis = server.get<RedisHandle>(REDIS);
    const caller: AdjustAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `adj_${id}`,
          password_hash: 'unused-test-login',
          is_super: options.superAdmin === true,
          status: 'active',
          password_must_change: false,
          totp_bound_at: f.clock.now(),
          verify_phone_cipher:
            options.phone === false ? null : Buffer.from('synthetic-verify-phone-cipher'),
          created_at: f.clock.now(),
          updated_at: f.clock.now(),
        })
        .execute();
      if (permissions.length > 0) {
        await f.db
          .insertInto('admin_permissions')
          .values(
            permissions.map((permission_key) => ({
              app_id: f.appId,
              admin_id: id,
              permission_key,
              granted_by: id,
              granted_at: f.clock.now(),
            })),
          )
          .execute();
      }
      const { token, claims } = await createAdminTokens({ key: tokenKey, clock: f.clock }).issue({
        adminId: id,
        appId: f.appId,
      });
      await createAdminSessions({ redis: redis.namespace('admin-auth'), clock: f.clock }).create(
        claims.sessionId,
        {
          adminId: id,
          appId: f.appId,
          expiresAtMs: claims.expiresAt * 1000,
          lastSeenMs: f.clock.now().getTime(),
        },
      );
      return { id, token, sessionId: claims.sessionId };
    };
    const stepUp: AdjustAdmin['stepUp'] = async (who, tier = 'sms') => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const maker = await caller([ADJUST]);
    const viewer = await caller([VIEW]);
    const sent = (op: Operation, response: { statusCode: number; body: string }): AdminSent => ({
      op,
      statusCode: response.statusCode,
      body: response.body,
      json: () => JSON.parse(response.body) as Envelope,
    });
    const read = async (
      op: Operation,
      url: string,
      who: AdminCaller | null | undefined,
    ): Promise<AdminSent> => {
      const actor = who === undefined ? viewer : who;
      const headers: Record<string, string> = { 'x-trace-id': randomUUID() };
      if (actor !== null) headers['authorization'] = `Bearer ${actor.token}`;
      return sent(
        op,
        await server.inject({ method: 'GET', url, headers, remoteAddress: '127.0.0.1' }),
      );
    };
    await run({
      fault,
      caller,
      stepUp,
      maker,
      viewer,
      async create(body, options = {}) {
        const who = options.caller === undefined ? maker : options.caller;
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-trace-id': randomUUID(),
        };
        if (who !== null) headers['authorization'] = `Bearer ${who.token}`;
        if (options.key !== null) headers['idempotency-key'] = options.key ?? newKey();
        const token =
          options.stepUp !== undefined ? options.stepUp : who === null ? null : await stepUp(who);
        if (token !== null) headers['x-step-up-token'] = token;
        const response = await server.inject({
          method: 'POST',
          url: LIST_PATH,
          headers,
          payload: JSON.stringify(body),
          remoteAddress: '127.0.0.1',
        });
        return sent('create', response);
      },
      list(query, who) {
        const text = new URLSearchParams(query ?? {}).toString();
        return read('list', text === '' ? LIST_PATH : `${LIST_PATH}?${text}`, who);
      },
      detail(adjustId, who) {
        return read('detail', `${LIST_PATH}/${encodeURIComponent(adjustId)}`, who);
      },
    });
  } finally {
    try {
      await app?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The contract.

const PATHS: Record<Operation, { path: string; method: 'get' | 'post' }> = {
  list: { path: LIST_PATH, method: 'get' },
  detail: { path: DETAIL_PATH, method: 'get' },
  create: { path: LIST_PATH, method: 'post' },
};

const HTTP_STATUS: Record<number, number> = {
  0: 200,
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20901: 409,
  20902: 409,
  40901: 409,
  50001: 500,
};

/** The response body conforms to its operation's schema of its status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const { path, method } = PATHS[sent.op];
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[path]?.[method]?.responses[status]?.content?.[
    'application/json'
  ]?.schema;
  expect(schema, `${method} ${path} ${status}`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(sent.body) as unknown;
  } catch {
    parsed = sent.body;
  }
  expect(check(parsed), `${sent.body} ${JSON.stringify(check.errors)}`).toBe(true);
}

/** Status, code and (when given) exact data, then the contract schema. */
export async function answer(sent: AdminSent, code: number, data?: unknown): Promise<Envelope> {
  expect(sent.statusCode, sent.body).toBe(HTTP_STATUS[code]);
  const body = sent.json();
  expect(body.code, sent.body).toBe(code);
  if (data !== undefined) expect(body.data, sent.body).toEqual(data);
  await conforms(sent);
  return body;
}

/** 20001 with exactly these data.fields (and data.reason when given). */
export function invalid(
  sent: AdminSent,
  fields: readonly string[],
  reason?: string,
): Promise<Envelope> {
  return answer(sent, 20001, reason === undefined ? { fields } : { fields, reason });
}

/** 20001 at the route schema: data.fields lists what fails in both shapes, plus `body`. */
export async function schemaRefused(sent: AdminSent): Promise<void> {
  const body = await answer(sent, 20001);
  const fields = (body.data as { fields?: unknown } | undefined)?.fields;
  expect(Array.isArray(fields), sent.body).toBe(true);
  expect(fields as unknown[], sent.body).toContain('body');
}

/** 10403 of an account without the permission point. */
export function denied(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 10403, { reason: 'admin_permission_denied' });
}

/** 10003 of the sms tier (verify_phone_missing for an account without a verify phone). */
export function stepUpRequired(sent: AdminSent, phoneMissing = false): Promise<Envelope> {
  return answer(
    sent,
    10003,
    phoneMissing ? { tier: 'sms', reason: 'verify_phone_missing' } : { tier: 'sms' },
  );
}

/** 20902 of an original that is already reversed. */
export function conflict(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20902, { resource: 'admin_adjustment' });
}

export interface Executed {
  /** data.adjustment, its instants as epoch milliseconds. */
  readonly adjustment: Record<string, unknown>;
  readonly before: unknown;
  readonly after: unknown;
}

/** The data of a successful submission: exactly adjustment and the available before and after. */
export async function executed(sent: AdminSent): Promise<Executed> {
  const body = await answer(sent, 0);
  const data = body.data as Record<string, unknown>;
  expect(Object.keys(data).sort(), sent.body).toEqual([
    'adjustment',
    'available_after_fen',
    'available_before_fen',
  ]);
  return {
    adjustment: normalizeForm(data['adjustment']),
    before: data['available_before_fen'],
    after: data['available_after_fen'],
  };
}

export interface Expectation {
  readonly caller: AdminCaller;
  readonly userId: string;
  readonly direction: Direction;
  readonly amount: bigint;
  readonly reason: string;
  readonly contra: string;
  readonly platform?: string | null;
  readonly refs: readonly Ref[];
  readonly note: string | null;
  /** The original form of a reversal. */
  readonly reverses?: FormRow;
  /** The member's available and frozen before the request. */
  readonly before: { readonly available: bigint; readonly frozen: bigint };
}

export interface Adjusted {
  readonly row: FormRow;
  readonly voucher: VoucherRow;
  readonly after: bigint;
}

/**
 * A submission in effect (BR-FUND-24 ①⑥, 细则「后台入口」「红冲只按原单整笔」, BR-FUND-16): the
 * form born APPROVED with the caller as filer and reviewer at the clock, the response showing it
 * and the available before and after, its one voucher `ADJ:{adjust_id}` (a reversal
 * `ADJ:{original}:REVERSE` and no `ADJ:{adjust_id}`) by `admin:{caller}` on the clock's accounting
 * day, without order_key or role, whose entries are exactly the template's of
 * specs/ledger-templates.csv, and the balance moved on available only.
 */
export async function expectAdjusted(
  f: AdjustFixture,
  sent: AdminSent,
  e: Expectation,
): Promise<Adjusted> {
  const done = await executed(sent);
  const adjustId = done.adjustment['adjust_id'];
  expect(typeof adjustId === 'string' && UUID.test(adjustId), sent.body).toBe(true);
  const id = adjustId as string;
  const row = await formNow(f, id);
  expect(row, `admin_adjustments ${id}`).toBeDefined();
  const now = f.clock.now();
  const platform = e.platform ?? null;
  expect(row!.voucher_id, `voucher of ${id}`).not.toBeNull();
  expect(row).toEqual({
    adjust_id: id,
    app_id: f.appId,
    user_id: e.userId,
    direction: e.direction,
    amount_fen: e.amount,
    reason_code: e.reason,
    refs: e.refs.map((ref) => ({ ref_type: ref.ref_type, ref_id: ref.ref_id })),
    contra_subject: e.contra,
    contra_platform: platform,
    note: e.note,
    status: 'APPROVED',
    reverses_adjust_id: e.reverses?.adjust_id ?? null,
    created_by: e.caller.id,
    created_at: now,
    reviewed_by: e.caller.id,
    reviewed_at: now,
    reject_note: null,
    voucher_id: row!.voucher_id,
    row_version: row!.row_version,
  });
  expect(done.adjustment).toEqual(formView(row!, null));
  const delta = e.direction === 'increase' ? e.amount : -e.amount;
  const after = e.before.available + delta;
  expect(done.before, sent.body).toBe(Number(e.before.available));
  expect(done.after, sent.body).toBe(Number(after));

  const reversal = e.reverses !== undefined;
  const uniq = reversal ? `ADJ:${e.reverses!.adjust_id}:REVERSE` : `ADJ:${id}`;
  const voucher = await voucherByKey(f, uniq);
  expect(voucher, uniq).toBeDefined();
  expect(voucher).toMatchObject({
    id: row!.voucher_id,
    operator: `admin:${e.caller.id}`,
    accounting_date: DAY,
    order_key: null,
    role: null,
  });
  if (reversal) {
    expect(voucher!.voucher_kind, 'the trusted reversal kind (B2-12b)').toBe('ADMIN_ADJUST_REV');
    expect(await voucherByKey(f, `ADJ:${id}`), `no ADJ:${id} for a reversal`).toBeUndefined();
  }
  const entries = await entriesOf(f, uniq);
  const template = templateOf({
    reason: e.reason,
    contra: e.contra,
    originalDirection: reversal ? (e.reverses!.direction as Direction) : e.direction,
    reversal,
  });
  expect(entries, template).toEqual(
    templateEntries(template, { userId: e.userId, platform, amount: e.amount }),
  );
  expect(
    entries.reduce((sum, entry) => sum + entry.amount_fen, 0n),
    'Σ amount_fen',
  ).toBe(0n);
  expect(
    entries.filter((entry) => entry.sub_account === 'frozen'),
    'frozen untouched',
  ).toEqual([]);

  const balance = await balanceOf(f, e.userId);
  expect(balance).toMatchObject({ available_fen: after, frozen_fen: e.before.frozen });
  return { row: row!, voucher: voucher!, after };
}

/** The member's available and frozen now. */
export async function moneyOf(
  f: AdjustFixture,
  userId: string,
): Promise<{ available: bigint; frozen: bigint }> {
  const balance = await balanceOf(f, userId);
  if (balance === undefined) throw new Error(`kit: ${userId} has no balance row`);
  return { available: balance.available_fen, frozen: balance.frozen_fen };
}

/** The body of a new form (amount as a JSON number). */
export function newForm(input: {
  readonly userId: string;
  readonly direction: Direction;
  readonly amount: bigint;
  readonly reason: string;
  readonly refs?: readonly Ref[];
  readonly note?: string;
  readonly contra?: string;
  readonly platform?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    user_id: input.userId,
    direction: input.direction,
    amount_fen: Number(input.amount),
    reason_code: input.reason,
  };
  if (input.refs !== undefined) body['refs'] = input.refs;
  if (input.note !== undefined) body['note'] = input.note;
  if (input.contra !== undefined) body['contra_subject'] = input.contra;
  if (input.platform !== undefined) body['contra_platform'] = input.platform;
  return body;
}
