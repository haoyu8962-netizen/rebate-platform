// B2-04m: settlement's BeneficiaryGate port (S2 option A, D10-93). The credit transaction locks the
// beneficiaries' users rows and re-reads their state only through this port; the implementation
// uses identity's and risk's exported ports only (lockUsersForUpdate, the deletion-status and
// realname-status batch readers, the risk-state batch reader) and never SELECTs users itself.
//
// BR-FUND-16 细则「加锁流程」step 2 and 4; BR-CALC-13 (deleted / banned / minor → forfeited,
// frozen / appealing → held). A frozen_until in the past is not treated as normal here: whether a
// freeze has ended is risk's call (待编排裁定), so the stored state is kept (held, never paid early).
import type { DB } from '@couli/db';
import type { CreditBeneficiaryState } from '@couli/domain';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { RiskStateBatchReader } from '../../risk/index.ts';

// identity's ports, declared structurally (same shapes as identity/index.ts LockUsersInput,
// UserDeletionStatusReader and RealnameStatusBatchReader): identity/index.ts re-exports its Nest
// modules, whose parameter decorators the erasable-syntax `test` project cannot compile, so even
// a type-only import of it from here would pull them into every test that imports this file.
// The assembly passes identity's real exports, which satisfy these shapes.
export interface LockUsersInput {
  readonly appId: string;
  readonly userIds: readonly string[];
}

export interface UserDeletionStatusReader {
  read(
    executor: Transaction<DB>,
    input: { app_id: string; user_ids: readonly string[] },
  ): Promise<ReadonlyMap<string, 'none' | 'processing' | 'done'>>;
}

export interface RealnameStatusBatchReader {
  read(
    executor: Transaction<DB>,
    input: { readonly appId: string; readonly userIds: readonly string[] },
  ): Promise<ReadonlyMap<string, 'none' | 'verified' | 'failed'>>;
}

export interface BeneficiarySelection {
  readonly appId: string;
  readonly userIds: readonly string[];
}

export interface BeneficiaryGate {
  /**
   * Step 2 of the lock flow: the users rows of every given beneficiary, in ascending user_id order,
   * on the caller's transaction (identity lockUsersForUpdate). Returns the ids that were locked.
   */
  lockUsers(trx: Transaction<DB>, input: BeneficiarySelection): Promise<ReadonlySet<string>>;
  /**
   * Step 4: each beneficiary's state re-read on the caller's transaction after the locks were
   * taken (deletion status, risk state, identified as under 18). Users that are not in app.users
   * for this app are absent from the map.
   */
  readStates(
    trx: Transaction<DB>,
    input: BeneficiarySelection,
  ): Promise<ReadonlyMap<string, CreditBeneficiaryState>>;
}

export interface MinorSelection extends BeneficiarySelection {
  /** The instant of the check, from the gate's Clock. */
  readonly at: Date;
}

/**
 * Users identified as under 18 at `at` (BR-ID-26; birth date of a verified realname). The assembly
 * supplies it (identity createMinorStatusBatchReader).
 */
export interface MinorStatusReader {
  read(trx: Transaction<DB>, input: MinorSelection): Promise<ReadonlySet<string>>;
}

export interface BeneficiaryGateOptions {
  readonly clock: Clock;
  /** identity lockUsersForUpdate. */
  lockUsers(trx: Transaction<DB>, input: LockUsersInput): Promise<ReadonlySet<string>>;
  /** identity createUserDeletionStatusReader: none → null, processing, done. */
  readonly deletionStatus: UserDeletionStatusReader;
  /** identity createRealnameStatusBatchReader: only a verified realname can identify a minor. */
  readonly realnameStatus: RealnameStatusBatchReader;
  /** risk createRiskStateBatchReader. */
  readonly riskState: RiskStateBatchReader;
  readonly minors: MinorStatusReader;
}

/** Deduplicated ids in ascending order (the lock order of BR-FUND-16 细则「加锁流程」). */
function ascending(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

function toDeletionStatus(
  status: 'none' | 'processing' | 'done',
): CreditBeneficiaryState['deletion_status'] {
  if (status === 'processing' || status === 'done') return status;
  // users.status only: a request still in its cooling-off window is not a loss (BR-CALC-13).
  return null;
}

export function createBeneficiaryGate(options: BeneficiaryGateOptions): BeneficiaryGate {
  const { clock, deletionStatus, realnameStatus, riskState, minors } = options;
  return Object.freeze({
    async lockUsers(trx: Transaction<DB>, input: BeneficiarySelection) {
      const userIds = ascending(input.userIds);
      if (userIds.length === 0) return new Set<string>();
      return options.lockUsers(trx, { appId: input.appId, userIds });
    },

    async readStates(trx: Transaction<DB>, input: BeneficiarySelection) {
      const userIds = ascending(input.userIds);
      const states = new Map<string, CreditBeneficiaryState>();
      if (userIds.length === 0) return states;
      const appId = input.appId;
      // Only users that exist in app.users for this app come back from the readers.
      const deletion = await deletionStatus.read(trx, { app_id: appId, user_ids: userIds });
      const risk = await riskState.read(trx, { appId, userIds });
      const realname = await realnameStatus.read(trx, { appId, userIds });
      const verified = userIds.filter((id) => realname.get(id) === 'verified');
      const minorIds = await minors.read(trx, { appId, userIds: verified, at: clock.now() });
      for (const id of userIds) {
        const deleted = deletion.get(id);
        if (deleted === undefined) continue;
        const riskValue = risk.get(id);
        if (riskValue === undefined) {
          // Both readers answer from the same locked users row; a gap is a broken read.
          throw new Error('settlement credit: risk state missing for a locked beneficiary');
        }
        states.set(id, {
          risk_state: riskValue.state,
          deletion_status: toDeletionStatus(deleted),
          // BR-ID-26: only a verified realname can identify a minor.
          is_minor: realname.get(id) === 'verified' && minorIds.has(id),
        });
      }
      return states;
    },
  });
}
