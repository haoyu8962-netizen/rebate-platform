// B2-04zzs rule-test support (claude-independent; FU-CLAWBACK-REASON-CHECK, D10-1126 ①, D10-1133 ④).
// Not named kit.ts. Only synthetic setup and observations; nothing here decides a reason code.
//
// Rules (SPEC_REF deaba4f): 08 BR-TEXT-05 细则「写入来源」① — 淘宝维权：维权时订单已结算（earning_time 有值）→
// REFUND / AFTER_SETTLE，确认收货前 → REFUND / IN_SALE，确认收货后、结算前 → RIGHTS / AFTER_SALE；08 BR-FUND-08 细则
// 「sub_type 与订单原因码」— the full-rights row takes its order reason from BR-TEXT-05 ① (other platforms keep
// RIGHTS), 整单退款 → REFUND, 退一部分、佣金降到 0 → COMMISSION_ZERO; the table changes no amount, idempotency
// key or restore eligibility (BR-FUND-22 looks at the reason only).
//
// The Taobao rights path is the real one, as test/spec/orders/taobao-rights-sync/success-after-closed:
// orders' rights.window handler (handleRightsWindow) with the union adapter's test double (a normalized
// UnionRefund, synthetic values, never a platform recording) → orders' writer (createRightsSyncWriter:
// find → lock → re-read → rights.record, source API) → settlement's real rights command on the B2-04lb
// harness (real credit, real clawback orchestration, real rebate port). earning_at is the adapter's
// parsed Taobao earning_time; the writer's third argument (extras) is passed on as the handler gives it.
//
// Default credited order (credit kit): taobao, platform SETTLED, N 1000, reserve 1500 → B 850,
// self 425 / direct 85 / indirect 42, platform 448, receivable 1000.
//   full rights (deduction ≥ 1000) → N_new 0 → R8: 425 / 85 / 42, platform 448; booked 0 / 0;
//   partial rights 400 → N_new 600 → B 510 → 255 / 51 / 25: R9 170 / 34 / 17, platform 179; booked
//   510 / 600 (same as [AC-B1-04zza#45]).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  createRightsSyncWriter,
  type RightsSyncWriter,
} from '../../../../apps/api/src/modules/orders/application/rights-sync.ts';
import { isPlatformRestoreEligible } from '../../../../apps/api/src/modules/orders/domain/platform-restore.ts';
import { handleRightsWindow } from '../../../../apps/api/src/modules/orders/jobs/rights-sync.ts';
import type { UnionRefund } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  RIGHTS_JOB,
  fixture,
  iso,
  job,
  refund,
  rightsWindow,
} from '../../orders/taobao-rights-sync/kit.ts';
import {
  clawbackKey,
  platformClawbackKey,
  platformDecreaseLines,
  receivable,
  userClawbackLines,
  type Harness,
  type SeededOrder,
} from '../rights-credit/kit.ts';

/** Synthetic Taobao rights number (masked shape). */
export const TB_RIGHTS_NO = '3300000000000009001';

/**
 * Timeline of the synthetic orders (the harness clock is 2032-07-24 10:00 +08:00; the seeded orders
 * were paid / attributed / received 2032-06-20 10:00 +08:00).
 */
export const EARNING_AT = new Date('2032-07-01T10:00:00+08:00');
/** The rights record's own time (tk_refund_time): after the receipt and after EARNING_AT. */
export const REFUND_AT = new Date('2032-07-20T09:00:00+08:00');
const WINDOW_START = iso(Date.parse('2032-07-24T10:00:00+08:00') - 10 * 3_600_000);

export const ROLES = ['self', 'direct', 'indirect'] as const;
export type Role = (typeof ROLES)[number];

/** A successful Taobao rights record (refund_status 13) against the order, as the adapter maps it. */
export interface RightsDelivery {
  /** refund_fen = base_refund_fen (the commission to take back). */
  readonly fen: bigint;
  /** The adapter's earning_at (Taobao earning_time); null: the union reported none. */
  readonly earningAt: Date | null;
}

/** orders' real rights.window handler and writer, the writer on settlement's real rights.record. */
export function taobaoRightsSync(db: Kysely<DB>, h: Harness) {
  const real = createRightsSyncWriter({ db, clock: h.clock, rights: h.recordPort() });
  const results: string[] = [];
  const writer: RightsSyncWriter = {
    async write(target, item, extras) {
      const result = await real.write(target, item, extras);
      results.push(result.kind);
      return result;
    },
  };
  /** One window holding only this record; answers the writer's result for it. */
  async function deliver(o: SeededOrder, spec: RightsDelivery): Promise<string | undefined> {
    const before = results.length;
    const patch: Partial<UnionRefund> = {
      order_id: o.subOrderId,
      refund_id: TB_RIGHTS_NO,
      refund_fen: spec.fen,
      base_refund_fen: spec.fen,
      refund_status: '13',
      rights_status: 'SUCCEEDED',
      refund_created_at: REFUND_AT,
      refund_finished_at: REFUND_AT,
      modified_at: REFUND_AT,
      earning_at: spec.earningAt,
    };
    const f = fixture({ refundPages: [[refund(1, patch)]] });
    const window = { ...rightsWindow(WINDOW_START), app_id: h.appId };
    await handleRightsWindow(job(RIGHTS_JOB, window), { ...f.handler, writer });
    expect(results).toHaveLength(before + 1);
    return results[before];
  }
  return { deliver };
}

/** The stored record is the API one as delivered: still type RIGHTS (never borrowed as another type). */
export async function expectApiRights(h: Harness, o: SeededOrder, fen: bigint) {
  const row = await h.onlyRights(o);
  expect(row).toMatchObject({
    source: 'API',
    type: 'RIGHTS',
    status: 'SUCCEEDED',
    platform_rights_no: TB_RIGHTS_NO,
    deduction_commission_fen: fen,
  });
  return row;
}

interface Published {
  readonly publish: {
    readonly mock: {
      readonly calls: readonly (readonly [
        unknown,
        { readonly name: string; readonly payload: Readonly<Record<string, unknown>> },
      ])[];
    };
  };
}

/** Payloads of the events `name` published for the order (the harness' publish spy). */
export function eventsOf(
  h: Published,
  name: string,
  orderId: string,
): Readonly<Record<string, unknown>>[] {
  return h.publish.mock.calls
    .map(([, event]) => event)
    .filter((event) => event.name === name && event.payload['order_id'] === orderId)
    .map((event) => event.payload);
}

interface Keyed {
  readonly orderKey: string;
  readonly platform: string;
  user(role: Role): string;
}

/** The four CLAWBACK keys of one reverse event on a three-beneficiary order, sorted. */
export function clawbackKeysOf(o: Keyed, eventId: string): string[] {
  return [
    ...ROLES.map((role) => `${o.orderKey}:${o.user(role)}:${role}:CLAWBACK:${eventId}`),
    `${o.orderKey}:PLATFORM:CLAWBACK:${eventId}`,
  ].sort();
}

interface MoneyReads {
  clawbackKeys(o: SeededOrder): Promise<string[]>;
  voucherLines(uniqKey: string): Promise<string[]>;
  voucherTypes(uniqKey: string): Promise<string[]>;
  balance(userId: string): Promise<bigint>;
  orderSubjectNet(o: SeededOrder, subject: string): Promise<bigint>;
}

/**
 * The default order fully clawed back on `eventId` (R8, amounts unchanged by this task): 425 / 85 /
 * 42, platform 448, every voucher CLAWBACK with `subType`, balances 0, receivable 0.
 */
export async function expectFullClawback(
  h: MoneyReads,
  o: SeededOrder,
  eventId: string,
  subType: 'RIGHTS' | 'FULL',
): Promise<void> {
  expect(await h.clawbackKeys(o)).toEqual(clawbackKeysOf(o, eventId));
  const shares: Readonly<Record<Role, bigint>> = { self: 425n, direct: 85n, indirect: 42n };
  for (const role of ROLES) {
    expect(await h.voucherLines(clawbackKey(o, role, eventId)), role).toEqual(
      userClawbackLines(o, role, shares[role]),
    );
    expect(await h.balance(o.user(role)), role).toBe(0n);
  }
  expect(await h.voucherLines(platformClawbackKey(o, eventId))).toEqual(
    platformDecreaseLines(o, 448n),
  );
  for (const key of clawbackKeysOf(o, eventId)) {
    expect(await h.voucherTypes(key), key).toEqual([`CLAWBACK|${subType}`]);
  }
  expect(await h.orderSubjectNet(o, receivable(o))).toBe(0n);
}

/** The default order partly clawed back on `eventId` by a rights deduction of 400 (R9, sub_type RIGHTS). */
export async function expectPartialClawback(
  h: MoneyReads,
  o: SeededOrder,
  eventId: string,
): Promise<void> {
  expect(await h.clawbackKeys(o)).toEqual(clawbackKeysOf(o, eventId));
  const clawed: Readonly<Record<Role, bigint>> = { self: 170n, direct: 34n, indirect: 17n };
  const left: Readonly<Record<Role, bigint>> = { self: 255n, direct: 51n, indirect: 25n };
  for (const role of ROLES) {
    expect(await h.voucherLines(clawbackKey(o, role, eventId)), role).toEqual(
      userClawbackLines(o, role, clawed[role]),
    );
    expect(await h.balance(o.user(role)), role).toBe(left[role]);
  }
  expect(await h.voucherLines(platformClawbackKey(o, eventId))).toEqual(
    platformDecreaseLines(o, 179n),
  );
  for (const key of clawbackKeysOf(o, eventId)) {
    expect(await h.voucherTypes(key), key).toEqual(['CLAWBACK|RIGHTS']);
  }
  expect(await h.orderSubjectNet(o, receivable(o))).toBe(600n);
}

interface OrderReads {
  read(o: SeededOrder): Promise<{
    readonly rebate_status: string;
    readonly reason: string | null;
  }>;
  history(o: SeededOrder): Promise<
    readonly {
      readonly field: string;
      readonly event: string | null;
    }[]
  >;
}

/**
 * BR-FUND-22 restore eligibility is unchanged: the ended order (VOID / CLAWED_BACK) with the reason
 * it now carries and the rebate history event that ended it is still eligible.
 */
export async function expectRestorable(h: OrderReads, o: SeededOrder): Promise<void> {
  const row = await h.read(o);
  const entry = (await h.history(o)).filter((r) => r.field === 'rebate').at(-1);
  expect(
    isPlatformRestoreEligible({
      rebateStatus: row.rebate_status,
      reason: row.reason,
      entryEvent: entry?.event ?? null,
    }),
    `${row.rebate_status} / ${String(row.reason)} / ${String(entry?.event)}`,
  ).toBe(true);
}
