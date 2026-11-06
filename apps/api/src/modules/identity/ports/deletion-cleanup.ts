// Identity's ports of the deletion cleanup (task B1-15g §9.2 #4; 08 BR-ID-28, BR-AI-22,
// BR-FUND-24 ⑧; orchestrator rulings D10-137, D10-186). Declared here, implemented by the owning
// modules and handed in by app.module's assembly: identity never imports another module's
// application code for the cleanup.
//
// Cleanup ports (linking / growth / notification / agent / catalog / feedback): called inside identity's
// cleanup transaction (users row already locked), on the caller's transaction, re-entrant, with
// { appId, userId, at } (at = the step's Clock reading). A port whose owner has not shipped yet is
// assembled as a DeletionCleanupUnavailable marker: the rest of the cleanup still commits, but
// cleaned_at stays NULL (the request stays processing) and a daily cleanup_blocked warning names
// the port.
//
// Closing adjustment (D10-137 ①, BR-FUND-24 ⑧): asked inside the completion transaction; anything
// but none_needed / done keeps the request in processing. Until the funds port exists, app.module
// assembles closingAdjustmentFromBalance over DeletionBalanceReader (0 → none_needed, anything
// else → pending).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { DeletionBalanceReader } from './deletion-balance.ts';

export interface DeletionCleanupInput {
  readonly appId: string;
  readonly userId: string;
  readonly at: Date;
}

/** One module's share of the cleanup, on the caller's transaction; its result is ignored. */
export type DeletionCleanupStep = (
  trx: Transaction<DB>,
  input: DeletionCleanupInput,
) => Promise<unknown>;

/** A port not shipped yet: `unavailable` names the task it is blocked on. */
export interface DeletionCleanupUnavailable {
  readonly unavailable: string;
}

export type DeletionCleanupPort = DeletionCleanupStep | DeletionCleanupUnavailable;

export type DeletionCleanupPortName =
  'linking' | 'growth' | 'notification' | 'agent' | 'catalog' | 'feedback';

/**
 * feedback (B1-28p: app.product_feedbacks rows of the user, BR-ID-28 删除清单「商品反馈记录」) is
 * optional in the type only: app.module always assembles it (its wiring test checks that), while
 * port sets built before it existed keep compiling; an absent port runs nothing.
 */
type OptionalCleanupPortName = 'feedback';

export type DeletionCleanupPorts = {
  readonly [name in Exclude<DeletionCleanupPortName, OptionalCleanupPortName>]: DeletionCleanupPort;
} & {
  readonly [name in OptionalCleanupPortName]?: DeletionCleanupPort;
};

export type ClosingAdjustmentState = 'none_needed' | 'pending' | 'done';

export interface ClosingAdjustmentInput {
  readonly appId: string;
  readonly userId: string;
}

export interface DeletionClosingAdjustmentReader {
  closingAdjustmentState(
    trx: Transaction<DB>,
    input: ClosingAdjustmentInput,
  ): Promise<ClosingAdjustmentState>;
}

/**
 * The stand-in until the funds port exists: available_fen on the same transaction, 0 →
 * none_needed, > 0 or < 0 → pending (never lets a balance through to done).
 */
export function closingAdjustmentFromBalance(
  balance: DeletionBalanceReader,
): DeletionClosingAdjustmentReader {
  // TODO(规划/11 §2.3): ACCOUNT_CLOSED 调减单状态读资金模块（BR-FUND-24 ⑧） — blocked on 资金端口 closingAdjustmentState 的属主任务
  return {
    async closingAdjustmentState(trx, input) {
      const available = await balance.availableFen(trx, {
        appId: input.appId,
        userId: input.userId,
      });
      return available === 0n ? 'none_needed' : 'pending';
    },
  };
}
