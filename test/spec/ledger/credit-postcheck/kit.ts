// B2-02t rule-test kit (claude-independent, SPEC_REF 39756e36): the post-credit confirmation of
// BR-FUND-19 正文末句 (每张入账凭证提交后 5 分钟内做证实核对，不一致告警并按账户级冻结该用户提现),
// BR-CALC-04 / BR-CALC-13, BR-FUND-04 ⑫; conventions from the task brief §9 (D10-1035, D10-1038).
// Real pieces: PostgreSQL through @couli/db/testing as couli_app, the real ledger, the real credit
// entries (createCreditOrder, createBeneficiaryCredit, over the seeded orders of the two settlement
// kits), commission's readCommissionAttribution and payout's createWithdrawHolds. Synthetic: the job
// queue (records what was sent and the transaction it was given), the config port and a one-shot
// failure of the hold port. A wrong voucher is a real one: the `post` port the credit entry gets
// moves one voucher by a fen on both sides before the real ledger books it, so it stays balanced
// and the check sees what a faulty credit would have left. No real user data.
import type { DB } from '@couli/db';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { expect } from 'vitest';
import {
  createCreditPostcheck,
  type CreditPostcheckAttributionReader,
  type CreditPostcheckPayload,
  type CreditPostcheckVoucher,
  type Ledger,
  type LedgerMismatchHolds,
  type PostingVoucher,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { createWithdrawHolds } from '../../../../apps/api/src/modules/payout/application/withdraw-holds.ts';
import {
  createRootLogger,
  type FixedClock,
  type JobQueue,
  type SendOptions,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createBeneficiaryCredit } from '../../../../apps/api/src/modules/settlement/credit/beneficiary/index.ts';
import {
  createCreditOrder,
  type CreditRole,
} from '../../../../apps/api/src/modules/settlement/credit/index.ts';
import {
  harness as beneficiaryHarness,
  type SeededOrder as BeneficiaryOrder,
} from '../../settlement/beneficiary-credit/kit.ts';
import { harness as creditHarness, type SeededOrder } from '../../settlement/credit/kit.ts';

// Loaded at run time, as the settlement kits do: the URL import keeps Nest decorators out of the
// test TS project.
const { lockUsersForUpdate } = (await import(
  new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
)) as typeof import('../../../../apps/api/src/modules/identity/ports/lock-users.ts');

const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as { readCommissionAttribution: CreditPostcheckAttributionReader };

export const QUEUE = 'ledger-credit-postcheck';
export const SWITCH_KEY = 'ledger.credit_postcheck.enabled';
export const ALERT = 'credit_postcheck_mismatch';

export type DiffRow = Selectable<DB['recon_diffs']>;
export type HoldRow = Selectable<DB['withdraw_holds']>;

export interface Sent {
  readonly queue: string;
  readonly name: string;
  readonly payload: CreditPostcheckPayload;
  readonly options: SendOptions;
}

type AttributionBeneficiary = Awaited<
  ReturnType<CreditPostcheckAttributionReader>
>['beneficiaries'][number];

/**
 * The check and its ports on one app. The check is built first, so that a missing implementation is
 * red with its own NotImplemented before any fixture.
 */
function sideOf(db: Kysely<DB>, appId: string, clock: FixedClock) {
  const logs: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    {
      write(line: string) {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  const state: {
    holdFails: boolean;
    attributionFails: boolean;
    keepBeneficiary: ((b: AttributionBeneficiary) => boolean) | null;
  } = { holdFails: false, attributionFails: false, keepBeneficiary: null };

  const audit = { append: () => Promise.resolve() };
  const withdrawHoldOptions = { clock, lockUsersForUpdate, audit };
  const realHolds = createWithdrawHolds(withdrawHoldOptions);
  const holds: LedgerMismatchHolds = {
    add(trx, input) {
      if (state.holdFails) {
        state.holdFails = false;
        return Promise.reject(new Error('synthetic hold failure'));
      }
      return realHolds.add(trx, input);
    },
  };
  const readAttribution: CreditPostcheckAttributionReader = async (trx, input) => {
    if (state.attributionFails) throw new Error('synthetic attribution failure');
    const attribution = await commission.readCommissionAttribution(trx, input);
    const keep = state.keepBeneficiary;
    return keep === null
      ? attribution
      : { ...attribution, beneficiaries: attribution.beneficiaries.filter(keep) };
  };
  const check = createCreditPostcheck({ db, clock, logger, readAttribution, holds });

  const sends: Sent[] = [];
  const queue: Pick<JobQueue, 'send'> = {
    send(name, jobName, payload, options) {
      // The real queue takes JSON only: a bigint in the payload fails here as it would there.
      JSON.stringify(payload);
      sends.push({
        queue: name,
        name: jobName,
        payload: payload as unknown as CreditPostcheckPayload,
        options,
      });
      return Promise.resolve(`job-${String(sends.length)}`);
    },
  };
  const values = new Map<string, unknown>();
  const config = {
    get: (app: string, key: string): Promise<unknown> =>
      Promise.resolve(app === appId ? values.get(key) : undefined),
  };
  const transactions: Transaction<DB>[] = [];

  return {
    db,
    appId,
    clock,
    logger,
    logs,
    sends,
    transactions,
    enqueue: { queue, config },
    /** Sets the switch; undefined leaves it unset. */
    setSwitch(value: unknown): void {
      if (value === undefined) values.delete(SWITCH_KEY);
      else values.set(SWITCH_KEY, value);
    },
    /** Options of payout's real writers, for the close of a diff. */
    withdrawHoldOptions,
    failNextHold(): void {
      state.holdFails = true;
    },
    failAttribution(fails: boolean): void {
      state.attributionFails = fails;
    },
    keepBeneficiaries(keep: ((b: AttributionBeneficiary) => boolean) | null): void {
      state.keepBeneficiary = keep;
    },
    handle: (payload: CreditPostcheckPayload): Promise<void> => check.handle(payload),
  };
}

export type Side = ReturnType<typeof sideOf>;

/** The voucher of `uniqKey` moved by `delta` fen on both sides (its magnitude grows by `delta`). */
function skewed(voucher: PostingVoucher, skews: ReadonlyMap<string, bigint>): PostingVoucher {
  const delta = skews.get(voucher.uniqKey);
  if (delta === undefined) return voucher;
  return {
    ...voucher,
    entries: voucher.entries.map((entry) => ({
      ...entry,
      amount_fen: entry.amount_fen > 0n ? entry.amount_fen + delta : entry.amount_fen - delta,
    })),
  };
}

/** R5: the real createCreditOrder over a seeded app, with the check and the enqueue wired. */
export async function r5Side(db: Kysely<DB>) {
  const h = await creditHarness(db);
  const side = sideOf(db, h.appId, h.clock);
  const skews = new Map<string, bigint>();
  const post: Ledger['post'] = (trx, voucher) => h.post(trx, skewed(voucher, skews));
  const service = createCreditOrder({
    clock: h.clock,
    logger: side.logger,
    ledger: { openUserAccount: h.openUserAccount, lockBalances: h.lockBalances, post },
    gate: h.gate(),
    readSnapshot: h.readSnapshot,
    readTljDeductFen: h.readTljDeductFen,
    appendBeneficiaryEvent: h.appendBeneficiaryEvent,
    events: { publish: h.publish },
    postcheck: side.enqueue,
  });
  return {
    h,
    side,
    /** The voucher of this uniq_key will be booked `delta` fen off. */
    skew(uniqKey: string, delta: bigint): void {
      skews.set(uniqKey, delta);
    },
    /** One credit in its own transaction; it must end credited. */
    async credit(o: SeededOrder): Promise<void> {
      const result = await db.transaction().execute((trx) => {
        side.transactions.push(trx);
        return service.credit(trx, h.input(o));
      });
      expect(result.outcome, 'R5 outcome').toBe('credited');
    },
  };
}

/** R5a: the real createBeneficiaryCredit over a seeded app, with the check and the enqueue wired. */
export async function r5aSide(db: Kysely<DB>) {
  const h = await beneficiaryHarness(db);
  const side = sideOf(db, h.appId, h.clock);
  h.boot();
  const skews = new Map<string, bigint>();
  const post: Ledger['post'] = (trx, voucher) => h.post(trx, skewed(voucher, skews));
  const service = createBeneficiaryCredit({
    clock: h.clock,
    logger: side.logger,
    ledger: { openUserAccount: h.openUserAccount, lockBalances: h.lockBalances, post },
    gate: { lockUsers: h.lockUsers, readStates: h.readStates },
    readSnapshot: h.readSnapshot,
    readOrderNets: h.readOrderNets,
    appendBeneficiaryEvent: h.appendBeneficiaryEvent,
    postcheck: side.enqueue,
  });
  return {
    h,
    side,
    skew(uniqKey: string, delta: bigint): void {
      skews.set(uniqKey, delta);
    },
    /** One item of the order's only obligation (or `role`'s) in its own transaction. */
    execute(o: BeneficiaryOrder, role?: CreditRole) {
      return db.transaction().execute((trx) => {
        side.transactions.push(trx);
        return service.execute(trx, h.input(o, role));
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Reading back.

export function diffsOf(side: Side): Promise<DiffRow[]> {
  return side.db
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', side.appId)
    .orderBy('ref_id')
    .execute();
}

export function holdsOf(side: Side): Promise<HoldRow[]> {
  return side.db
    .selectFrom('withdraw_holds')
    .selectAll()
    .where('app_id', '=', side.appId)
    .orderBy('user_id')
    .execute();
}

export function alertsOf(side: Side): Record<string, unknown>[] {
  return side.logs.filter((line) => line['alert'] === ALERT);
}

/** Nothing registered, held or alerted on this app. */
export async function expectQuiet(side: Side): Promise<void> {
  expect(await diffsOf(side), 'recon_diffs').toEqual([]);
  expect(await holdsOf(side), 'withdraw_holds').toEqual([]);
  expect(alertsOf(side), 'alerts').toEqual([]);
}

/** The id of the voucher with this uniq_key. */
export async function voucherIdOf(
  h: { vouchers(): Promise<{ readonly id: string; readonly uniq_key: string }[]> },
  uniqKey: string,
): Promise<string> {
  const found = (await h.vouchers()).filter((v) => v.uniq_key === uniqKey);
  expect(found, `voucher ${uniqKey}`).toHaveLength(1);
  return found[0]!.id;
}

function byBeneficiary(a: CreditPostcheckVoucher, b: CreditPostcheckVoucher): number {
  return `${a.user_id}:${a.role}`.localeCompare(`${b.user_id}:${b.role}`);
}

/** The only job sent so far on this app, its queue and payload (vouchers in any order). */
export function expectOneJob(
  side: Side,
  orderId: string,
  vouchers: readonly CreditPostcheckVoucher[],
): Sent {
  expect(side.sends, 'jobs sent').toHaveLength(1);
  const sent = side.sends[0]!;
  expect(sent.queue).toBe(QUEUE);
  expect(sent.name.length, 'job name').toBeGreaterThan(0);
  expect(sent.payload.app_id).toBe(side.appId);
  expect(sent.payload.order_id).toBe(orderId);
  expect([...sent.payload.vouchers].sort(byBeneficiary)).toEqual([...vouchers].sort(byBeneficiary));
  return sent;
}

/** The job sent last on this app. */
export function lastJob(side: Side): CreditPostcheckPayload {
  const sent = side.sends[side.sends.length - 1];
  expect(sent, 'a job was sent').toBeDefined();
  return sent!.payload;
}

export interface ExpectedDiff {
  readonly voucherId: string;
  readonly expectedFen: bigint;
  readonly actualFen: bigint;
  readonly orderKey: string;
  readonly userId: string;
  readonly role: CreditRole;
  readonly baseFen: string;
  readonly ratioBp: string;
}

/** The one recon diff of this voucher, with every registration column of the brief. */
export async function expectDiff(side: Side, e: ExpectedDiff): Promise<DiffRow> {
  const refId = `credit_postcheck:${e.voucherId}`;
  const rows = (await diffsOf(side)).filter((row) => row.ref_id === refId);
  expect(rows, `recon_diffs ${refId}`).toHaveLength(1);
  const row = rows[0]!;
  expect(row).toMatchObject({
    app_id: side.appId,
    type: 'ledger_mismatch',
    source: 'R3',
    ref_type: 'voucher',
    ref_id: refId,
    dedupe_key: `R3:credit_postcheck:${e.voucherId}`,
    expected_fen: e.expectedFen,
    actual_fen: e.actualFen,
    diff_fen: e.expectedFen - e.actualFen,
    status: 'open',
    handler_id: null,
    closed_at: null,
  });
  expect(row.period, 'period').toMatch(/^[0-9]{4}-[0-9]{2}(-[0-9]{2})?$/u);
  const resolution = row.resolution as Record<string, unknown>;
  expect(resolution).toMatchObject({
    order_key: e.orderKey,
    user_id: e.userId,
    role: e.role,
  });
  // A JSON document holds these as numbers or decimal strings; the value is what counts.
  expect(String(resolution['base_fen']), 'resolution.base_fen').toBe(e.baseFen);
  expect(String(resolution['ratio_bp']), 'resolution.ratio_bp').toBe(e.ratioBp);
  return row;
}

/** The hold a diff added for a user: in effect, no expiry, created by system at the clock. */
export function expectHold(side: Side, row: HoldRow | undefined, diffId: string, userId: string) {
  expect(row, `hold of ${userId}`).toBeDefined();
  expect(row).toMatchObject({
    app_id: side.appId,
    user_id: userId,
    reason: 'ledger_mismatch',
    source_ref: `recon_diff:${diffId}`,
    created_by: 'system',
    hold_until: null,
    released_at: null,
    released_by: null,
  });
}

/** One alert in all, and no beneficiary's id anywhere in it (no personal information). */
export function expectOneAlert(side: Side, userIds: readonly string[]): void {
  const alerts = alertsOf(side);
  expect(alerts, 'alerts').toHaveLength(1);
  const text = JSON.stringify(alerts[0]);
  for (const userId of userIds) expect(text, 'the alert names no user').not.toContain(userId);
}
