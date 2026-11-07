// B2-04ze (D10-443): what app.module hands to SettlementModule.forWorker on the worker entry.
// Each field is another module's export, passed as is (a function reference) or as a factory over
// the runtime handles the worker module resolves (database, clock, field cipher). settlement never
// imports identity's barrel (its Nest controllers); the identity shapes are the structural ones of
// credit/beneficiary-gate.ts.
//
// Fixed assignments (app.module, worker entry only):
// - readAttribution = commission readCommissionAttribution (required: without it R5 / R5a fall back
//   to the version-asserting snapshot read and a version bump rolls a whole order back; HANDOFF
//   10-27); used by createCreditOrder and createBeneficiaryCredit alike;
// - readSnapshot = commission readCommissionSnapshot; readTljDeductFen = commission readTljDeductFen;
// - appendBeneficiaryEvent = commission appendBeneficiaryEvent ((trx, input, { clock }); the worker
//   adapts it to the (trx, input) port of credit-order / beneficiary-credit);
// - readUnionAuthoritative = ledger readUnionAuthoritativeOrderKeys; snapshotStatus = ledger
//   getAssetSnapshotStatus; registerDiff = ledger registerReconDiff; readOrderNets = ledger
//   getOrderNets; ledger = ledger createLedger;
// - lockUsers = identity lockUsersForUpdate; deletionStatus / realnameStatus = identity's batch
//   readers; minors = identity createMinorStatusBatchReader (B1-03zc); riskState = risk
//   createRiskStateBatchReader;
// - config = content's configuration reader (value of the item, undefined / null when unset);
// - platforms = union REGISTERED_PLATFORMS (the bill is seeded daily for every app × platform);
// - inviteRewardTrigger (B2-04zzc, D10-805 ②) = growth createInviteRewardTrigger over the runtime
//   handles below, orders' createInviteRewardOrderFacts and content's configuration reader on the
//   caller's transaction (optional for SettlementModule, always given by app.module on the worker);
//   the order facts it reads carry the credit's booked base as base_fen (D10-810).
// - systemAudit = admin's system audit writer (B2-09zb: the audit of a candidate superseded by a
//   newer commission_version, in the generating transaction). Optional for the worker pieces that
//   never supersede; a run that has to supersede without it fails that order (nothing written).
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Ledger, OrderNetSelection, OrderNets } from '../../ledger/index.ts';
import type { Clock, EventBus, FieldCrypto, RootLogger } from '../../platform/index.ts';
import type { RiskStateBatchReader } from '../../risk/index.ts';
import type { BillSourceDependencies } from '../bill/infra/bill-source.ts';
import type { BillJobDependencies } from '../bill/job.ts';
import type {
  LockUsersInput,
  MinorStatusReader,
  RealnameStatusBatchReader,
  UserDeletionStatusReader,
} from '../credit/beneficiary-gate.ts';
import type { SettleAdjustAudit } from '../adjust/generate.ts';
import type {
  BeneficiaryEventInput,
  CreditInviteTrigger,
  CreditOrderDependencies,
} from '../credit/credit-order.ts';

/** B2-04zzc: the worker's own handles the invite trigger factory is built over. */
export interface SettlementInviteTriggerRuntime {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** The worker's logger: the trigger logs its failures here (app id and error class only). */
  readonly logger: RootLogger;
}

/** content's switch / setting reader: the stored value, undefined or null when unset. */
export interface SettlementConfigReader {
  get(appId: string, key: string): Promise<unknown>;
}

export interface SettlementWorkerPorts {
  /** union REGISTERED_PLATFORMS: the platforms of the daily bill seed. */
  readonly platforms: readonly string[];
  /** commission readCommissionAttribution (required). */
  readonly readAttribution: NonNullable<CreditOrderDependencies['readAttribution']>;
  /** commission readCommissionSnapshot (the bill job; credit only without readAttribution). */
  readonly readSnapshot: BillJobDependencies['readSnapshot'];
  /** commission readTljDeductFen. */
  readonly readTljDeductFen: BillJobDependencies['readTljDeductFen'];
  /** commission appendBeneficiaryEvent. */
  readonly appendBeneficiaryEvent: (
    trx: Transaction<DB>,
    input: BeneficiaryEventInput,
    dependencies: { readonly clock: Clock },
  ) => Promise<void>;
  /** ledger readUnionAuthoritativeOrderKeys (the bill source). */
  readonly readUnionAuthoritative: BillSourceDependencies['readUnionAuthoritative'];
  /** ledger getAssetSnapshotStatus. */
  readonly snapshotStatus: BillJobDependencies['snapshotStatus'];
  /** ledger registerReconDiff. */
  readonly registerDiff: BillJobDependencies['registerDiff'];
  /** ledger getOrderNets (the beneficiary supplement credit). */
  readonly readOrderNets: (trx: Transaction<DB>, input: OrderNetSelection) => Promise<OrderNets>;
  /**
   * ledger createLedger over the worker's clock and EVENT_BUS, with payout's recovery hook
   * (account.went_negative, BR-WDR-05 (a); D10-587). The worker always passes events; a caller
   * outside the settle handler may omit them and then publishes nothing.
   */
  readonly ledger: (
    clock: Clock,
    events?: EventBus,
  ) => Pick<Ledger, 'openUserAccount' | 'lockBalances' | 'post'>;
  /** identity lockUsersForUpdate. */
  readonly lockUsers: (trx: Transaction<DB>, input: LockUsersInput) => Promise<ReadonlySet<string>>;
  /** identity createUserDeletionStatusReader. */
  readonly deletionStatus: (db: Kysely<DB>) => UserDeletionStatusReader;
  /** identity createRealnameStatusBatchReader. */
  readonly realnameStatus: (db: Kysely<DB>) => RealnameStatusBatchReader;
  /** risk createRiskStateBatchReader. */
  readonly riskState: (db: Kysely<DB>) => RiskStateBatchReader;
  /** identity createMinorStatusBatchReader (B1-03zc) over the process field cipher. */
  readonly minors: (crypto: FieldCrypto) => MinorStatusReader;
  /** content's configuration reader on the worker's database. */
  readonly config: (db: Kysely<DB>, clock: Clock) => SettlementConfigReader;
  /**
   * B2-04zzc (D10-805 ②, D10-810; BR-INV-24 ②): growth createInviteRewardTrigger, built once per
   * settle handler over the worker's handles and handed to createCreditOrder as its inviteTrigger.
   * Optional: without it the credit triggers nothing.
   */
  readonly inviteRewardTrigger?: (runtime: SettlementInviteTriggerRuntime) => CreditInviteTrigger;
  /** admin's createSystemAuditWriter over the worker's clock (optional, see the header). */
  readonly systemAudit?: (clock: Clock) => SettleAdjustAudit;
}
