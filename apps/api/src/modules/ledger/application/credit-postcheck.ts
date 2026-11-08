// B2-02t: the post-credit confirmation of BR-FUND-19 正文末句 (FU-CREDIT-POSTCHECK-5MIN; D10-1035,
// D10-1038). Queue `ledger-credit-postcheck`.
//
// expectedShareFen({ base_fen, ratio_bp, net_before_fen }) = max(0, floor(base × ratio_bp / 10000) −
// net_before), amounts only through @couli/money. It is an independent recomputation: the credit
// planner of packages/domain is not used here.
//
// createCreditPostcheck(deps).handle(payload) checks each voucher of one job:
//   - actual amount from app.ledger_entries of that voucher, as a positive number: kind credit the
//     USER_BALANCE entry, kind forfeit the COMMISSION_REVENUE entry;
//   - ratio from deps.readAttribution by (user_id, role), the immutable attribution; base_fen and
//     net_before_fen from the payload (the values when the voucher was written), never re-read;
//   - equal: nothing is written;
//   - different: registerReconDiffOnce with type ledger_mismatch, source R3, ref_type voucher, ref_id
//     `credit_postcheck:<voucher_id>`, dedupe_key `R3:credit_postcheck:<voucher_id>`, expected = the
//     recomputed share, actual = the voucher amount, diff = expected − actual, resolution with
//     order_key / user_id / role / base_fen / ratio_bp. Only when that call inserted the diff and only
//     for kind credit: one hold through deps.holds on the same transaction (reason ledger_mismatch,
//     source_ref `recon_diff:<id>`, created_by system, holdUntil null). Kind forfeit is registered and
//     alerted, never held. Only when inserted, as the last step of that transaction's callback (after
//     the diff and the hold were written, before it returns): one alert line with
//     alert = 'credit_postcheck_mismatch', carrying no personal information. A commit whose response
//     is lost has therefore already alerted, a failed write in the callback has not, and a commit that
//     fails and rolls back is replayed with at most one repeated alert: never a lost one (D10-1065:
//     deduplicate by voucher_id; a recon_diff_id that cannot be found means look at the retry's row);
//   - anything unreadable (attribution, the beneficiary in it, the voucher or its entry, a malformed
//     payload) throws so the queue retries and finally dead-letters; it is never taken as consistent.
// Each voucher commits on its own: one that cannot be read does not delay the hold of another, and
// the job still fails afterwards so the unread one is retried (a replay changes nothing else).
//
// R5 (credit-order.ts) and R5a first_credit (beneficiary-credit.ts) enqueue on the transaction that
// wrote the vouchers, through the optional `postcheck` dependency: enqueueCreditPostcheck sends
// `queue.send('ledger-credit-postcheck', <job name>, payload, { trx })`, once per credit with at least
// one checked voucher, unless config `ledger.credit_postcheck.enabled` is false (value !== false;
// unset is on). Checked vouchers are the beneficiary `:CREDIT` (kind credit) and `:PLATFORM:FORFEIT`
// (kind forfeit) ones; CREDIT:PLATFORM, ADJ:DEFERRED:* and FORFEIT:DEFERRED are not.
import type { DB } from '@couli/db';
import { accountingDate } from '@couli/domain';
import { mulDivFloor, parseFen, subFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, JobQueue, RootLogger } from '../../platform/index.ts';
import { readCreditPostcheckEntries } from '../infra/credit-postcheck-store.ts';
import type { LedgerMismatchHolds } from './daily-check-execute.ts';
import { LedgerError } from './errors.ts';
import { registerReconDiffOnce } from './recon-diffs.ts';

export interface ExpectedShareInput {
  readonly base_fen: bigint;
  readonly ratio_bp: bigint;
  /** The beneficiary's net on the order before the voucher was written; 0 for R5. */
  readonly net_before_fen: bigint;
}

export type CreditPostcheckRole = 'self' | 'share' | 'direct' | 'indirect';

export type CreditPostcheckKind = 'credit' | 'forfeit';

/** One checked voucher of a job. Amounts are decimal strings: a job payload is JSON. */
export type CreditPostcheckVoucher = {
  readonly voucher_id: string;
  readonly user_id: string;
  readonly role: CreditPostcheckRole;
  readonly kind: CreditPostcheckKind;
  readonly base_fen: string;
  readonly net_before_fen: string;
};

export type CreditPostcheckPayload = {
  readonly app_id: string;
  readonly order_id: string;
  readonly vouchers: readonly CreditPostcheckVoucher[];
};

/** The part of commission's readCommissionAttribution result the check reads. */
export interface CreditPostcheckAttribution {
  readonly beneficiaries: readonly {
    readonly userId: string;
    readonly role: string;
    readonly ratioBp: number;
  }[];
}

/** commission's readCommissionAttribution: throws when the order has no attribution. */
export type CreditPostcheckAttributionReader = (
  trx: Transaction<DB>,
  input: { readonly appId: string; readonly orderId: string },
) => Promise<CreditPostcheckAttribution>;

export interface CreditPostcheckDependencies {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  readonly readAttribution: CreditPostcheckAttributionReader;
  /** payout's createWithdrawHolds (same port as the daily check's). */
  readonly holds: LedgerMismatchHolds;
}

export interface CreditPostcheck {
  /** Rejects when anything could not be read; a replay of the same job changes nothing. */
  handle(payload: CreditPostcheckPayload): Promise<void>;
}

/** What R5 and R5a need to enqueue the job (see the file header). */
export interface CreditPostcheckEnqueue {
  readonly queue: Pick<JobQueue, 'send'>;
  readonly config: { get(appId: string, key: string): Promise<unknown> };
}

export const CREDIT_POSTCHECK_QUEUE = 'ledger-credit-postcheck';

const JOB_NAME = 'credit_postcheck';
const SWITCH_KEY = 'ledger.credit_postcheck.enabled';
const ALERT = 'credit_postcheck_mismatch';
const BP_DENOMINATOR = 10000n;
const ROLES: readonly string[] = ['self', 'share', 'direct', 'indirect'];
const SUBJECT_OF: Readonly<Record<CreditPostcheckKind, string>> = {
  credit: 'USER_BALANCE',
  forfeit: 'COMMISSION_REVENUE',
};

export function expectedShareFen(input: ExpectedShareInput): bigint {
  const due = mulDivFloor(input.base_fen, input.ratio_bp, BP_DENOMINATOR);
  const gap = subFen(due, input.net_before_fen);
  return gap > 0n ? gap : 0n;
}

/** The kind of check a voucher template gets; null for a template that is not checked. */
export function creditPostcheckKindOf(templateId: string): CreditPostcheckKind | null {
  if (templateId === 'FORFEIT') return 'forfeit';
  if (templateId.startsWith('CREDIT:') && templateId !== 'CREDIT:PLATFORM') return 'credit';
  return null;
}

/** Sends the job on the credit's transaction; nothing without a port, a voucher or with the switch off. */
export async function enqueueCreditPostcheck(
  postcheck: CreditPostcheckEnqueue | undefined,
  trx: Transaction<DB>,
  payload: CreditPostcheckPayload,
): Promise<void> {
  if (postcheck === undefined || payload.vouchers.length === 0) return;
  if ((await postcheck.config.get(payload.app_id, SWITCH_KEY)) === false) return;
  await postcheck.queue.send(CREDIT_POSTCHECK_QUEUE, JOB_NAME, payload, { trx });
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new LedgerError('INVALID_INPUT', `credit postcheck: ${name} must be a nonempty string`);
  }
  return value;
}

function amount(value: unknown, name: string): bigint {
  if (typeof value !== 'string') {
    throw new LedgerError('INVALID_INPUT', `credit postcheck: ${name} must be a decimal string`);
  }
  return parseFen(value);
}

interface CheckedVoucher {
  readonly voucherId: string;
  readonly userId: string;
  readonly role: CreditPostcheckRole;
  readonly kind: CreditPostcheckKind;
  readonly baseFen: bigint;
  readonly netBeforeFen: bigint;
}

function parseVoucher(voucher: CreditPostcheckVoucher): CheckedVoucher {
  if (typeof voucher !== 'object' || voucher === null) {
    throw new LedgerError('INVALID_INPUT', 'credit postcheck: a voucher must be an object');
  }
  if (!ROLES.includes(voucher.role)) {
    throw new LedgerError('INVALID_INPUT', 'credit postcheck: unknown role');
  }
  if (voucher.kind !== 'credit' && voucher.kind !== 'forfeit') {
    throw new LedgerError('INVALID_INPUT', 'credit postcheck: unknown kind');
  }
  return {
    voucherId: text(voucher.voucher_id, 'voucher_id'),
    userId: text(voucher.user_id, 'user_id'),
    role: voucher.role,
    kind: voucher.kind,
    baseFen: amount(voucher.base_fen, 'base_fen'),
    netBeforeFen: amount(voucher.net_before_fen, 'net_before_fen'),
  };
}

function parsePayload(payload: CreditPostcheckPayload): {
  readonly appId: string;
  readonly orderId: string;
  readonly vouchers: readonly CheckedVoucher[];
} {
  if (typeof payload !== 'object' || payload === null || !Array.isArray(payload.vouchers)) {
    throw new LedgerError('INVALID_INPUT', 'credit postcheck: malformed payload');
  }
  if (payload.vouchers.length === 0) {
    throw new LedgerError('INVALID_INPUT', 'credit postcheck: a job needs at least one voucher');
  }
  return {
    appId: text(payload.app_id, 'app_id'),
    orderId: text(payload.order_id, 'order_id'),
    vouchers: payload.vouchers.map(parseVoucher),
  };
}

function ratioOf(attribution: CreditPostcheckAttribution, voucher: CheckedVoucher): bigint {
  const found = attribution.beneficiaries.filter(
    (b) => b.userId === voucher.userId && b.role === voucher.role,
  );
  if (found.length !== 1) {
    throw new Error(
      `credit postcheck: voucher ${voucher.voucherId} has no single beneficiary in the attribution`,
    );
  }
  return BigInt(found[0]!.ratioBp);
}

export function createCreditPostcheck(deps: CreditPostcheckDependencies): CreditPostcheck {
  const { db, clock, logger, readAttribution, holds } = deps;

  /** One voucher in its own transaction; the alert is that transaction callback's last step. */
  async function checkVoucher(
    appId: string,
    orderId: string,
    attribution: CreditPostcheckAttribution,
    voucher: CheckedVoucher,
  ): Promise<void> {
    const { voucherId, kind } = voucher;
    const ratioBp = ratioOf(attribution, voucher);
    await db.transaction().execute(async (trx) => {
      const entries = await readCreditPostcheckEntries(trx, appId, voucherId, SUBJECT_OF[kind]);
      const entry = entries[0];
      if (entry === undefined || entries.length !== 1) {
        throw new Error(`credit postcheck: voucher ${voucherId} has no single ${kind} entry`);
      }
      const orderKey = entry.order_key;
      if (orderKey === null) {
        throw new Error(`credit postcheck: voucher ${voucherId} has no order key`);
      }
      const expectedFen = expectedShareFen({
        base_fen: voucher.baseFen,
        ratio_bp: ratioBp,
        net_before_fen: voucher.netBeforeFen,
      });
      // Both entries are the credit side of their voucher, stored negative.
      const actualFen = subFen(0n, entry.amount_fen);
      if (expectedFen === actualFen) return;

      const diffFen = subFen(expectedFen, actualFen);
      const refId = `credit_postcheck:${voucherId}`;
      const registration = await registerReconDiffOnce(
        trx,
        {
          appId,
          type: 'ledger_mismatch',
          source: 'R3',
          period: accountingDate(clock.now()),
          refType: 'voucher',
          refId,
          expectedFen,
          actualFen,
          diffFen,
          dedupeKey: `R3:${refId}`,
          resolution: {
            source: 'credit_postcheck',
            voucher_id: voucherId,
            kind,
            order_key: orderKey,
            user_id: voucher.userId,
            role: voucher.role,
            base_fen: voucher.baseFen.toString(),
            ratio_bp: ratioBp.toString(),
            net_before_fen: voucher.netBeforeFen.toString(),
          },
        },
        { clock },
      );
      if (!registration.inserted) return;
      if (kind === 'credit') {
        await holds.add(trx, {
          appId,
          userId: voucher.userId,
          reason: 'ledger_mismatch',
          sourceRef: `recon_diff:${registration.row.id}`,
          createdBy: 'system',
          holdUntil: null,
        });
      }
      logger.warn(
        {
          alert: ALERT,
          app_id: appId,
          order_id: orderId,
          voucher_id: voucherId,
          recon_diff_id: registration.row.id,
          kind,
          expected_fen: expectedFen.toString(),
          actual_fen: actualFen.toString(),
          diff_fen: diffFen.toString(),
        },
        'credit postcheck found a voucher that differs from its recomputed share',
      );
    });
  }

  return {
    async handle(payload) {
      const { appId, orderId, vouchers } = parsePayload(payload);
      const attribution = await db
        .transaction()
        .execute((trx) => readAttribution(trx, { appId, orderId }));
      const failures: unknown[] = [];
      for (const voucher of vouchers) {
        try {
          await checkVoucher(appId, orderId, attribution, voucher);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, `credit postcheck: ${failures.length} vouchers failed`);
      }
    },
  };
}
