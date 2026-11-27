// B2-05d: the withdrawal application use case (POST /v1/withdrawals, 规划/08 BR-WDR-07 正文 ①–⑧ with
// BR-WDR-09 W1 and BR-WDR-03). The caller owns the transaction (production: the idempotency
// module's executeInTransaction, so the key's result commits with the withdrawal, BR-WDR-07 ⑧).
// Order inside apply():
//   first pass   the full BR-WDR-03 chain over fresh reads (B2-05c's validator, no locks taken);
//   risk flags   BR-WDR-03 ⑭ / BR-WDR-29 (B2-11a): with riskFlags wired, the snapshot at t (the
//                Clock's now taken for this application before the first pass) under the id the
//                insert uses, still before any lock; a refused first pass computes nothing. The
//                labels go into the row (risk_flags, risk_flags_at = t) and are never recomputed;
//                a refusal under the locks rolls back to a savepoint taken before it (③'s rows);
//   locks        ① identity's users row lock → ② ledger.lockBalances (the member's balance row) →
//                ③ pg_advisory_xact_lock(hashtext(app_id || ':' || payee_hmac)::bigint) on the
//                payee HMAC of the snapshot (BR-WDR-07 ③);
//   re-check     ④ BR-WDR-03 ⑤⑥⑦⑧⑩⑪⑫ again over reads made under the locks
//                (validateLockedWithdrawal; B2-05u's closed method and B2-05v's real name / payee
//                name are its ⑤ and ⑥).
// B2-05v (BR-WDR-07 ④, D10-3590): one pass is first pass → risk flags → locks → snapshot. When
// the snapshot's account (payee_hmac and payout_method) is not the account the first pass judged
// (the member rebound in between), the pass is rolled back to its savepoint — the risk rows and
// every lock taken since — and the whole pass runs again, at most PASSES times in all; a last
// pass still changed answers 50001 (no withdrawal, no freeze; a warn without payee data).
//   amounts      ⑤ fee_fen / tax_fen from the FeeTaxCalculator (fee_rule_id / tax_rule_version
//                fixed with them), net_fen = amount − fee − tax (@couli/money);
//   insert       ⑥ PENDING_REVIEW with the payee snapshot, income_type SERVICE_FEE, out_biz_no
//                (W + 20 [A-Z0-9]; a unique-key collision regenerates at most three times, in a
//                savepoint so the transaction stays usable), review_mode / review_deadline
//                (D-W03: auto_payout off → manual + 24 working hours, BR-WDR-26; on → null);
//   voucher      ⑦ WITHDRAW_FREEZE `wd:{id}:FREEZE` through ledger.post (template WITHDRAW:FREEZE,
//                available −amount / frozen +amount); the idempotency result is the caller's ⑧.
//   events       wallet.withdrawal_changed and withdrawal.created on the same transaction (ids,
//                status and an integer amount only; no payee data), when a bus is wired.
// Answers (not exceptions) for the chain's refusals, so the caller stores 3xxxx with the key;
// infrastructure failures throw and roll everything back. Nothing of the payee (name, account,
// cipher, HMAC) is logged.
// B2-05q (BR-ID-36 细则「被拦截请求申诉」提现提交类): a first-pass 44001 (③a) whose reader named the
// hit carries `recordBlocked` beside code / data — the hit record of this refused application
// (member, applied amount, dimension, value digest, rule code) through the blockedHits port. It is
// not written here: the caller runs it after this transaction has ended and released its
// connection (the refusal rolls back; the record is risk's own short transaction, as bind-phone's),
// and only for the answer this call produced. Without the port, or without a named hit, the
// result is the plain refusal.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { buildVouchers } from '@couli/domain';
import { fenToJsonNumber, subFen } from '@couli/money';
import { sql, type InsertObject, type Kysely, type Transaction } from 'kysely';
import type { Ledger, PostingEntry } from '../../ledger/index.ts';
import { newUuidV7, type EventBus } from '../../platform/index.ts';
import { maskPayeeAccount, payoutChannelName } from '../domain/mask-payee.ts';
import {
  civilYearOfDay,
  reviewDeadline,
  reviewDeadlineDays,
  type WorkdayCalendarYear,
} from '../domain/review-deadline.ts';
import { validateLockedWithdrawal } from '../domain/withdraw-locked.ts';
import type { WithdrawRiskFlag } from '../domain/risk-flags.ts';
import {
  validateWithdrawal,
  type WithdrawBlock,
  type WithdrawBlocklistHit,
} from '../domain/withdraw-rules.ts';
import { chinaIso } from './withdrawal-reads.ts';
import type { WithdrawApplyRiskOptions } from './withdraw-risk-flags.ts';
import {
  readWithdrawInput,
  type WithdrawActor,
  type WithdrawRulesOptions,
} from './withdraw-rules.ts';

/** Identity supplies the current, encrypted payee snapshot on the caller's handle. */
export interface WithdrawPayeeSnapshot {
  payout_method: 'alipay' | 'bank_card';
  payee_name: string;
  payee_account_cipher: Buffer;
  payee_hmac: string;
  bank_name: string | null;
  /** Transient cleartext for masking; never returned, logged or put in an event. */
  account: string;
}

/**
 * B2-05q (BR-ID-36): risk's hit record of an application refused with 44001, assembled by
 * app.module (risk's blocklist service with the member's current phone as identity stores it).
 * Called outside any transaction of the application; a failure rejects.
 */
export interface WithdrawBlockedHits {
  record(input: {
    appId: string;
    userId: string;
    /** The amount applied for, whole fen. */
    amountFen: bigint;
    hit: WithdrawBlocklistHit;
  }): Promise<void>;
}

export interface WithdrawApplyOptions extends WithdrawApplyRiskOptions {
  /** Reuse B2-05c's validator and readers for the first pass and locked subset ⑦⑧⑩⑪⑫. */
  rules: WithdrawRulesOptions;
  ledger: Ledger;
  lockUsersForUpdate(
    trx: Transaction<DB>,
    input: { appId: string; userIds: readonly string[] },
  ): Promise<ReadonlySet<string>>;
  snapshot: {
    read(handle: Kysely<DB>, actor: WithdrawActor): Promise<WithdrawPayeeSnapshot | null>;
  };
  /** New candidate for each insert attempt; at most three retries after a collision. */
  outBizNo(): string;
  eventBus?: EventBus;
  /** B2-05q: without it a 44001 refusal carries no hit record (nothing is written). */
  blockedHits?: WithdrawBlockedHits;
}

export interface WithdrawApplyCommand extends WithdrawActor {
  amountFen: bigint;
  stepUpValid: boolean;
}

export interface WithdrawAccepted {
  code: 0;
  data: Schema<'Withdrawal'>;
}

/** A refusal of the chain; a 44001 with a named hit also carries its record (B2-05q). */
export interface WithdrawRefused extends WithdrawBlock {
  /**
   * Writes the risk_hits row of this refused application. For the caller to run once, after the
   * transaction given to apply() has ended; never part of the response.
   */
  recordBlocked?: () => Promise<void>;
}

export type WithdrawApplyResult = WithdrawAccepted | WithdrawRefused;

/** Narrows the result: code 0 carries the contract's Withdrawal, anything else a refusal. */
export function isWithdrawAccepted(result: WithdrawApplyResult): result is WithdrawAccepted {
  return result.code === 0;
}

export interface WithdrawApplyService {
  /** Caller owns the transaction (production: idempotency.executeInTransaction). */
  apply(trx: Transaction<DB>, command: WithdrawApplyCommand): Promise<WithdrawApplyResult>;
}

/** BR-WDR-30 总开关 (default off): decides review_mode at creation (D-W03). */
export const AUTO_PAYOUT_KEY = 'withdraw.auto_payout.enabled';
/** The console's working-day calendar, per +08:00 civil year (as risk's appeal calendar). */
export const CALENDAR_KEYS = {
  holidays: (year: number) => `calendar.cn_holidays.${year}`,
  makeupWorkdays: (year: number) => `calendar.cn_makeup_workdays.${year}`,
} as const;
const UNIQUE_VIOLATION = '23505';
const OUT_BIZ_NO_KEY = 'withdrawals_out_biz_no_key';
/** The initial candidate plus at most three regenerated ones (BR-WDR-07 out_biz_no). */
const OUT_BIZ_NO_ATTEMPTS = 4;
const SAVEPOINT = sql.raw('payout_withdrawal_insert');
/**
 * Taken once the first pass of a pass has passed, before the risk-flag snapshot and the locks: a
 * refusal under the locks, or a payee account changed since the first pass, rolls back to it —
 * ③'s judgement rows, and the row and advisory locks taken after it (PostgreSQL releases the locks
 * a rolled-back subtransaction acquired).
 */
const PASS_SAVEPOINT = sql.raw('payout_withdrawal_pass');
/** B2-05v (D10-3590): the first pass plus at most two re-runs after a changed payee account. */
const PASSES = 3;
/** The answer once every pass saw the payee account change (public code, not stored by idempotency). */
const PAYEE_CHANGED_CODE = 50001;
/** A pass whose snapshot account is not the first pass's: rolled back, to be run again. */
const PAYEE_CHANGED: unique symbol = Symbol('payee_changed');

type FirstPassPayee = Awaited<ReturnType<WithdrawRulesOptions['subject']['read']>>;

/** BR-WDR-07 ④ (B2-05v): both the HMAC and the method must be the ones the first pass judged. */
function samePayeeAccount(
  first: FirstPassPayee,
  snapshot: Pick<WithdrawPayeeSnapshot, 'payee_hmac' | 'payout_method'>,
): boolean {
  return (
    first !== null &&
    first.payee_hmac === snapshot.payee_hmac &&
    first.payout_method === snapshot.payout_method
  );
}
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isOutBizNoCollision(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION &&
    (error as { constraint?: unknown }).constraint === OUT_BIZ_NO_KEY
  );
}

function switchOn(value: unknown): boolean {
  return value === true || value === 'on' || value === 'true';
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** An array of real `YYYY-MM-DD` dates of `year`; anything else is null (invalid). */
function datesOf(value: unknown, year: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const dates: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string') return null;
    const match = DATE.exec(entry);
    if (match === null || Number(match[1]) !== year) return null;
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    dates.push(entry);
  }
  return dates;
}

/**
 * The calendar years a deadline from `from` may reach (BR-WDR-26), read through `config` on
 * `handle`; an unreadable year counts weekends only (warned `workday_calendar_unconfigured`).
 * Shared by W1 (switch off) and the automatic decision (B2-11c). B1-34s (D10-3001 / D10-3115):
 * with the port's `configValues` the keys of every year the deadline may reach come from one
 * statement and are taken as one saved state (a key it does not return is unconfigured, never
 * read again on its own); without it each key is read once.
 */
export async function readReviewCalendars(
  options: {
    config: WithdrawRulesOptions['config'] & {
      /** Same shape as AutoPayoutConfigPort.configValues (declared here: no import cycle). */
      configValues?(
        appId: string,
        keys: readonly string[],
        handle: Kysely<DB>,
      ): Promise<ReadonlyMap<string, { value: unknown }>>;
    };
    logger: { warn(fields: Record<string, unknown>, message: string): void };
  },
  handle: Kysely<DB>,
  appId: string,
  from: Date,
): Promise<Record<number, WorkdayCalendarYear>> {
  const { first, last } = reviewDeadlineDays(from);
  const years = [...new Set<number>([civilYearOfDay(from, first), civilYearOfDay(from, last)])];
  const keysOf = (year: number) => [
    CALENDAR_KEYS.holidays(year),
    CALENDAR_KEYS.makeupWorkdays(year),
  ];
  // B1-34s (D10-3115): with a batch read every year's keys come from one statement, so a batch
  // save committing during the computation is seen whole or not at all (never an old year paired
  // with a new one); a failed batch read leaves every year unconfigured.
  let batch: ReadonlyMap<string, { value: unknown }> | null | undefined;
  if (options.config.configValues !== undefined) {
    try {
      batch = await options.config.configValues(appId, years.flatMap(keysOf), handle);
    } catch {
      // The error may carry configuration values or driver details: never logged.
      batch = null;
    }
  }
  const result: Record<number, WorkdayCalendarYear> = {};
  for (const year of years) {
    let read: WorkdayCalendarYear | null = null;
    try {
      const [holidaysKey, makeupKey] = keysOf(year) as [string, string];
      let holidays: { value: unknown } | null;
      let makeup: { value: unknown } | null;
      if (batch !== undefined) {
        // A key the batch read does not return is unconfigured (never read again on its own).
        holidays = batch?.get(holidaysKey) ?? null;
        makeup = batch?.get(makeupKey) ?? null;
      } else {
        holidays = await options.config.configValue(appId, holidaysKey, handle);
        makeup = await options.config.configValue(appId, makeupKey, handle);
      }
      const holidayDates = holidays === null ? null : datesOf(holidays.value, year);
      const makeupDates = makeup === null ? null : datesOf(makeup.value, year);
      if (holidayDates !== null && makeupDates !== null) {
        read = { holidays: holidayDates, makeupWorkdays: makeupDates };
      }
    } catch {
      // The error may carry configuration values or driver details: never logged.
      read = null;
    }
    if (read === null) {
      options.logger.warn({ app_id: appId, year }, 'workday_calendar_unconfigured');
      continue;
    }
    result[year] = read;
  }
  return result;
}

export function createWithdrawApply(options: WithdrawApplyOptions): WithdrawApplyService {
  const { rules, ledger } = options;
  const { clock } = rules;

  /** The calendar years a deadline from `from` may reach; an unreadable year counts weekends only. */
  function calendars(
    handle: Kysely<DB>,
    appId: string,
    from: Date,
  ): Promise<Record<number, WorkdayCalendarYear>> {
    return readReviewCalendars(rules, handle, appId, from);
  }

  async function reviewFields(
    trx: Transaction<DB>,
    appId: string,
    now: Date,
  ): Promise<{ review_mode: 'manual' | null; review_deadline: Date | null }> {
    const row = await rules.config.configValue(appId, AUTO_PAYOUT_KEY, trx);
    if (row !== null && switchOn(row.value)) return { review_mode: null, review_deadline: null };
    return {
      review_mode: 'manual',
      review_deadline: reviewDeadline(now, await calendars(trx, appId, now)),
    };
  }

  /** INSERT in a savepoint: an out_biz_no collision regenerates, anything else propagates. */
  async function insertWithdrawal(
    trx: Transaction<DB>,
    row: Omit<InsertObject<DB, 'withdrawals'>, 'out_biz_no'>,
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const outBizNo = options.outBizNo();
      await sql`SAVEPOINT ${SAVEPOINT}`.execute(trx);
      try {
        await trx
          .withSchema('app')
          .insertInto('withdrawals')
          .values({ ...row, out_biz_no: outBizNo })
          .execute();
        await sql`RELEASE SAVEPOINT ${SAVEPOINT}`.execute(trx);
        return;
      } catch (error) {
        await sql`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`.execute(trx);
        if (!isOutBizNoCollision(error) || attempt >= OUT_BIZ_NO_ATTEMPTS) throw error;
      }
    }
  }

  /**
   * One pass (B2-05v): first pass → risk flags → locks → snapshot → advisory lock → locked
   * re-check → row and voucher. PAYEE_CHANGED when the snapshot's account is not the first pass's
   * (the pass is already rolled back to its savepoint).
   */
  async function runPass(
    trx: Transaction<DB>,
    command: WithdrawApplyCommand,
    actor: WithdrawActor,
    t: Date,
    id: string,
  ): Promise<WithdrawApplyResult | typeof PAYEE_CHANGED> {
    const amount = command.amountFen;
    // First pass: the whole chain, no locks (a refusal here never touches a row). B2-05v: the
    // account identity returned to it (the real one — the rule chain's method is null for a closed
    // method) is kept, to be compared with the snapshot under the locks.
    // A holder, not a `let`: an assignment made inside the reader is invisible to narrowing.
    const seen: { payee: FirstPassPayee } = { payee: null };
    const first = await readWithdrawInput(trx, actor, command.stepUpValid, {
      ...rules,
      subject: {
        async read(handle, subject): ReturnType<WithdrawRulesOptions['subject']['read']> {
          const row = await rules.subject.read(handle, subject);
          seen.payee = row;
          return row;
        },
      },
    });
    // B2-08c: the first-pass quote only serves this validation; the row stores the quote taken
    // again under the member's locks (a cumulative tax depends on the in-flight withdrawals).
    let quote = await rules.feeTax.calculate(trx, {
      ...actor,
      amountFen: amount,
      now: t,
    });
    let fee = quote.fee_fen;
    let tax = quote.tax_fen;
    let net = subFen(subFen(amount, fee), tax);
    const refused = validateWithdrawal(first, amount, net);
    if (refused !== null) {
      // ③a with a named hit (B2-05q): the record leaves with the answer, to be written by the
      // caller once this transaction is over; ③a is judged in this pass only.
      const hit = first.blocklist_hit ?? null;
      const { blockedHits } = options;
      if (refused.code !== 44001 || hit === null || blockedHits === undefined) return refused;
      return {
        ...refused,
        recordBlocked: () =>
          blockedHits.record({
            appId: actor.appId,
            userId: actor.userId,
            amountFen: amount,
            hit,
          }),
      };
    }
    // Everything of this pass from here on (③'s rows, every lock) can be taken back.
    await sql`SAVEPOINT ${PASS_SAVEPOINT}`.execute(trx);
    /** Rolls this pass back to its savepoint and drops it (the next pass takes its own). */
    async function undoPass(): Promise<void> {
      await sql`ROLLBACK TO SAVEPOINT ${PASS_SAVEPOINT}`.execute(trx);
      await sql`RELEASE SAVEPOINT ${PASS_SAVEPOINT}`.execute(trx);
    }
    // BR-WDR-03 ⑭: the risk-flag snapshot, before the locks; ③ is judged under this id, on the
    // account this pass's first pass judged (a changed account re-runs the pass, B2-05v).
    const { payee } = seen;
    let riskFlags: readonly WithdrawRiskFlag[] | null = null;
    if (options.riskFlags !== undefined) {
      riskFlags = await options.riskFlags.compute(trx, {
        appId: actor.appId,
        userId: actor.userId,
        withdrawalId: id,
        amountFen: amount,
        // The first pass refused a member without a current account (BR-WDR-03 ⑤).
        payeeHmac: payee === null ? '' : payee.payee_hmac,
        now: t,
      });
    }
    /** A refusal under the locks: no withdrawal, so nothing of the snapshot (③'s rows) stays. */
    async function refuse(block: WithdrawBlock): Promise<WithdrawBlock> {
      await undoPass();
      return block;
    }
    // Locks in the fixed order (BR-WDR-07 ①②③), then the snapshot and the locked re-check ④.
    await options.lockUsersForUpdate(trx, { appId: actor.appId, userIds: [actor.userId] });
    const balances = await ledger.lockBalances(trx, {
      appId: actor.appId,
      userIds: [actor.userId],
    });
    const balance = balances.find((row) => row.user_id === actor.userId);
    // No ledger account means no balance: the first pass already refused (available 0 < amount).
    if (balance === undefined) return refuse({ code: 30301, data: {} });
    const snapshot = await options.snapshot.read(trx, actor);
    if (snapshot === null) return refuse({ code: 30305, data: {} });
    // B2-05v (BR-WDR-07 ④): the account to be locked and stored is not the one the first pass
    // judged (③a, ⑨'s method cap, the risk flags): take the whole pass back and run it again.
    if (!samePayeeAccount(payee, snapshot)) {
      await undoPass();
      return PAYEE_CHANGED;
    }
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`${actor.appId}:${snapshot.payee_hmac}`})::bigint)`.execute(
      trx,
    );
    const locked = await readWithdrawInput(trx, actor, command.stepUpValid, rules);
    // ④ re-runs ⑤ ⑥ before ⑦: ⑤ refuses an open-method set read under the locks that no longer
    // holds the bound method (B2-05u, BR-WDR-02 细则); ⑥ the real name / payee name (B2-05v).
    const again = validateLockedWithdrawal(locked, amount);
    if (again !== null) return refuse(again);
    // Build the row. One clock reading serves the locked quote and the row's created_at, so the
    // tax year the quote used is the year the row is created in (money review r1 S0).
    const now = clock.now();
    // B2-08c (BR-WDR-20 累计方法, BR-WDR-07 lock order): the quote that the row stores is taken
    // under the users row lock, so a concurrent application of the member that committed since
    // the first pass counts as in flight.
    quote = await rules.feeTax.calculate(trx, { ...actor, amountFen: amount, now });
    fee = quote.fee_fen;
    tax = quote.tax_fen;
    net = subFen(subFen(amount, fee), tax);
    const review = await reviewFields(trx, actor.appId, now);
    await insertWithdrawal(trx, {
      id,
      app_id: actor.appId,
      user_id: actor.userId,
      amount_fen: amount,
      fee_fen: fee,
      tax_fen: tax,
      net_fen: net,
      income_type: 'SERVICE_FEE',
      fee_rule_id: quote.fee_rule_id ?? null,
      tax_rule_version: quote.tax_rule_version ?? null,
      payout_method: snapshot.payout_method,
      payee_name: snapshot.payee_name,
      payee_account_cipher: snapshot.payee_account_cipher,
      payee_hmac: snapshot.payee_hmac,
      bank_name: snapshot.bank_name,
      status: 'PENDING_REVIEW',
      review_mode: review.review_mode,
      review_deadline: review.review_deadline,
      payout_channel: snapshot.payout_method,
      risk_flags:
        riskFlags === null
          ? null
          : sql<DB['withdrawals']['risk_flags']>`CAST(${JSON.stringify(riskFlags)} AS jsonb)`,
      risk_flags_at: riskFlags === null ? null : t,
      created_at: now,
      updated_at: now,
    });
    // W1: the freeze voucher (BR-WDR-09), same transaction, under this transaction's balance lock.
    const [voucher] = buildVouchers('WITHDRAW:FREEZE', {
      withdrawal_id: id,
      user_id: actor.userId,
      withdraw_fen: amount,
    });
    if (voucher === undefined) throw new Error('payout: WITHDRAW:FREEZE built no voucher');
    const entries: PostingEntry[] = voucher.entries.map((entry) => ({
      account: { ownerType: 'user', accountId: balance.account_id },
      sub_account: entry.sub_account === 'frozen' ? 'frozen' : 'available',
      amount_fen: entry.amount_fen,
      ledger_type: entry.ledger_type,
      sub_type: entry.sub_type,
      income_type: null,
    }));
    await ledger.post(trx, {
      appId: actor.appId,
      uniqKey: voucher.uniq_key,
      bizType: 'withdrawal',
      bizId: id,
      operator: `user:${actor.userId}`,
      memo: null,
      orderKey: null,
      beneficiaryUserId: null,
      role: null,
      voucherKind: null,
      entries,
    });
    if (options.eventBus !== undefined) {
      await options.eventBus.publish(trx, {
        appId: actor.appId,
        name: 'wallet.withdrawal_changed',
        payload: { withdrawal_id: id, user_id: actor.userId, status: 'PENDING_REVIEW' },
      });
      await options.eventBus.publish(trx, {
        appId: actor.appId,
        name: 'withdrawal.created',
        payload: {
          withdrawal_id: id,
          user_id: actor.userId,
          amount_fen: fenToJsonNumber(amount),
          review_mode: review.review_mode,
        },
      });
    }
    return {
      code: 0,
      data: {
        withdrawal_id: id,
        status: 'PENDING_REVIEW',
        review_mode: review.review_mode,
        amount_fen: fenToJsonNumber(amount),
        fee_fen: fenToJsonNumber(fee),
        tax_fen: fenToJsonNumber(tax),
        net_fen: fenToJsonNumber(net),
        payout_channel: snapshot.payout_method,
        payout_channel_name: payoutChannelName(snapshot.payout_method),
        masked_account: maskPayeeAccount(snapshot.payout_method, snapshot.account),
        reason_code: null,
        fail_action: null,
        created_at: chinaIso(now),
        // CT-20b (D10-207): a fresh PENDING_REVIEW has no time points yet; the automatic
        // judgement (BR-WDR-30) has not run, so the BR-WDR-25 branch is「处理中」(processing).
        review_deadline: review.review_deadline === null ? null : chinaIso(review.review_deadline),
        executed_at: null,
        first_attempt_at: null,
        paid_at: null,
        channel_state: null,
        confirm_deadline: null,
        sub_text_branch: 'processing',
        hold_days: null,
        channel_order_id: null,
      },
    };
  }

  return {
    async apply(trx, command) {
      const actor: WithdrawActor = {
        appId: command.appId,
        userId: command.userId,
        deviceId: command.deviceId,
      };
      // t of this application (BR-WDR-29 计算时点), and the id the risk flags and the row use: one
      // application, whichever pass creates it (a re-run pass's rows were rolled back).
      const t = clock.now();
      const id = newUuidV7(t);
      for (let pass = 1; ; pass += 1) {
        const result = await runPass(trx, command, actor, t, id);
        if (result !== PAYEE_CHANGED) return result;
        if (pass >= PASSES) {
          // No payee data (account, HMAC, name) in the log: the member and the passes only.
          rules.logger.warn(
            { user_id: actor.userId, passes: pass },
            'withdraw_payee_changed_retry_exhausted',
          );
          return { code: PAYEE_CHANGED_CODE, data: {} };
        }
      }
    },
  };
}
