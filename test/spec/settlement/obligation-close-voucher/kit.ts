// Shared harness of the B2-04zzb rule tests (FU-OBLIGATION-CLOSE-VOUCHER-REF, D10-797; claude-independent,
// SPEC_REF b79958d). BR-FUND-04 ⑫「其他事务处置了义务的份额时同一事务关闭义务……都关联实际履约的凭证（该事务
// 的平台凭证或该受益人的凭证；平台差额为 0、没写平台凭证的，记该事务的结算记录 seq 或 rights_event_id）」,
// for the clawback's R9 (forfeited, closed_by R9) and R10 (forfeited, closed_by R10) only:
//   - the closed row's beneficiary_credits.voucher_id is the id of the platform voucher this same
//     transaction wrote (R9 `{order_key}:PLATFORM:CLAWBACK:{rights_event_id}`, R10
//     `{order_key}:PLATFORM:ADJ:{seq}`), same app, same order;
//   - platform difference 0 (no platform voucher): voucher_id null, closed_ref is the fallback;
//   - R8 voids with no voucher (beneficiary_credits_voucher_check); an obligation kept or opened by
//     R10 stays open with no voucher.
//
// Built on the B2-04zza harness (real credit, real clawback service, real ledger, the simulated order
// sync that answers a waiting rights record) and the B2-04s clawback harness under it. Expected amounts
// are written by hand in the tests or derived in a property body from the BR-CALC-02 / BR-CALC-04
// formulas, never obtained from the adjustment planner.
//
// Default order (credit kit): N 1000, reserve_bp 1500 → B 850; self 5000 / direct 1000 / indirect 500
// → 425 / 85 / 42; PLATFORM:CREDIT 448 (retain 298 + reserve 150). A beneficiary held at credit
// (frozen) has an open first_credit obligation (pending = its share) and no credit voucher.
import type { DB } from '@couli/db';
import { PostgresQueryCompiler, sql, type Kysely, type Selectable } from 'kysely';
import { expect } from 'vitest';
import type { ClawbackResult } from '../../../../apps/api/src/modules/settlement/clawback/index.ts';
import {
  harness as obligationHarness,
  people,
  type LaterState,
  type Role,
  type SeededOrder,
} from '../rights-wait-adj-obligation/kit.ts';

export {
  LATER,
  NOW,
  TIMEOUT,
  databaseFixture,
  people,
  platformAdjKey,
  platformIncreaseLines,
  receivable,
} from '../rights-wait-adj-obligation/kit.ts';
export type { LaterState, Role, SeededOrder } from '../rights-wait-adj-obligation/kit.ts';
export { baseOf, platformClawbackKey, platformDecreaseLines, shareOf } from '../clawback/kit.ts';
export { failAfter } from '../credit/kit.ts';

export type ObligationRow = Selectable<DB['beneficiary_credits']>;

export interface R9Outcome {
  readonly result: ClawbackResult;
  /** rights_event_id `R{order_rights.id}` (BR-FUND-08). */
  readonly eventId: string;
  readonly rightsId: string;
}

/** The later states that forfeit an unfinished obligation (BR-CALC-09), with the forfeit reason. */
export const FORFEITING: readonly (readonly [LaterState, 'banned' | 'deleted'])[] = [
  ['banned', 'banned'],
  ['deleting', 'deleted'],
  ['deleted', 'deleted'],
];

/** Every UPDATE of beneficiary_credits matches no row in PostgreSQL (WHERE false): the CAS misses. */
export function obligationCasMisses(db: Kysely<DB>) {
  let misses = 0;
  const conflicted = db.withPlugin({
    transformQuery(args) {
      if (args.node.kind === 'UpdateQueryNode') {
        const compiled = new PostgresQueryCompiler().compileQuery(args.node, args.queryId);
        if (updatesObligations(compiled)) {
          misses += 1;
          return {
            ...args.node,
            where: { kind: 'WhereNode', where: sql<boolean>`false`.toOperationNode() },
          };
        }
      }
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  return { db: conflicted, misses: () => misses };
}

/** Whether a statement is an UPDATE of beneficiary_credits (for failAfter). */
export function updatesObligations(query: { readonly sql: string }): boolean {
  return /^update\s+(?:"app"\.)?"beneficiary_credits"/i.test(query.sql);
}

export async function harness(db: Kysely<DB>) {
  const h = await obligationHarness(db);
  const appId = h.appId;

  /**
   * A CREDITED default order with the given roles held at credit (frozen → open first_credit
   * obligation each), then moved to the given later states before anything else happens.
   */
  async function heldThen(
    later: Partial<Record<Role, LaterState>>,
    held: readonly Role[] = Object.keys(later) as Role[],
  ): Promise<SeededOrder> {
    const states: Partial<Record<Role, 'frozen'>> = {};
    for (const role of held) states[role] = 'frozen';
    const o = await h.credited({ people: people(states) });
    for (const [role, state] of Object.entries(later) as [Role, LaterState][]) {
      await h.setState(o, role, state);
    }
    return o;
  }

  /** A successful rights record bringing the union's new commission, applied as R9 (BR-FUND-08 ①). */
  async function rightsR9(o: SeededOrder, newCommissionFen: bigint): Promise<R9Outcome> {
    const rightsId = await h.rights(o);
    const result = await h.apply(o, {
      cause: 'RIGHTS',
      ref: { kind: 'rights', orderRightsId: rightsId },
      newCommissionFen,
    });
    return { result, eventId: `R${rightsId}`, rightsId };
  }

  /** The order's only obligation of `role` (fails the test when there is not exactly one). */
  async function obligationOf(o: SeededOrder, role: Role): Promise<ObligationRow> {
    const rows = (await h.orderObligations(o)).filter((r) => r.role === role);
    expect(rows, `${role} obligations`).toHaveLength(1);
    return rows[0]!;
  }

  /**
   * The platform voucher `uniqKey` of this app: written for the order, of the given kind, with no
   * beneficiary (the transaction's platform voucher, not a beneficiary's). Returns its id.
   */
  async function platformVoucherId(
    o: SeededOrder,
    uniqKey: string,
    kind: 'CLAWBACK' | 'SETTLE_ADJUST',
  ): Promise<string> {
    const rows = await db
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', appId)
      .where('uniq_key', '=', uniqKey)
      .execute();
    expect(rows, uniqKey).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      order_key: o.orderKey,
      voucher_kind: kind,
      beneficiary_user_id: null,
      role: null,
    });
    return rows[0]!.id;
  }

  /** The voucher a closed obligation references, read through (app_id, voucher_id); null if none. */
  async function referencedVoucher(row: ObligationRow) {
    if (row.voucher_id === null) return null;
    const found = await db
      .selectFrom('ledger_vouchers')
      .select(['id', 'app_id', 'uniq_key', 'order_key', 'voucher_kind'])
      .where('app_id', '=', row.app_id)
      .where('id', '=', row.voucher_id)
      .executeTakeFirst();
    return found ?? null;
  }

  /**
   * The obligation of `role` is closed as `status` by `closedBy` with `closedRef`, and its voucher_id
   * is the platform voucher `uniqKey` of this transaction (same app, same order).
   */
  async function expectLinked(
    o: SeededOrder,
    role: Role,
    close: {
      readonly closedBy: 'R9' | 'R10';
      readonly closedRef: string;
      readonly uniqKey: string;
      readonly kind: 'CLAWBACK' | 'SETTLE_ADJUST';
    },
  ): Promise<ObligationRow> {
    const voucherId = await platformVoucherId(o, close.uniqKey, close.kind);
    const row = await obligationOf(o, role);
    expect(row).toMatchObject({
      status: 'forfeited',
      closed_by: close.closedBy,
      closed_ref: close.closedRef,
    });
    expect(row.voucher_id, `${role} voucher_id`).toBe(voucherId);
    expect(await referencedVoucher(row)).toEqual({
      id: voucherId,
      app_id: appId,
      uniq_key: close.uniqKey,
      order_key: o.orderKey,
      voucher_kind: close.kind,
    });
    return row;
  }

  /** The order's voucher keys carrying `:PLATFORM:` (platform vouchers of any kind). */
  async function platformKeys(o: SeededOrder): Promise<string[]> {
    return (await h.orderVoucherKeys(o)).filter((k) => k.includes(':PLATFORM:'));
  }

  return {
    ...h,
    heldThen,
    rightsR9,
    obligationOf,
    platformVoucherId,
    referencedVoucher,
    expectLinked,
    platformKeys,
  };
}

export type Harness = Awaited<ReturnType<typeof harness>>;
