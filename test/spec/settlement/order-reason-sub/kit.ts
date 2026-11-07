// Shared harness of the B2-04zze integration rule tests (orders.reason_sub written by settlement in
// the same place and transaction as orders.reason; 08 BR-TEXT-05「子原因 reason_sub」; orchestrator
// D10-818 ②, D10-862). Built read-only on the B2-04l rights harness, itself on the B2-04s clawback
// and B2-04m credit harnesses: CREDITED orders are credited by the real credit service, rights
// records go through settlement's real rights command, the rebate port (R6 / R7) and the clawback
// (R8 / R9) are the real ones. A record is delivered the way orders' writer delivers it: one
// transaction, lockOrderKey, the order re-read FOR UPDATE, then rights.record with source API and
// the union's violation text passed through (never stored).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  lockOrderKey,
  type RightsRecordInput,
  type RightsRecordResult,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { OCCURRED_AT, harness as rightsHarness, type SeededOrder } from '../rights/kit.ts';

export { NOW, TIMEOUT, databaseFixture } from '../rights/kit.ts';
export type { OrderSpec, SeededOrder } from '../rights/kit.ts';

/** The alert of a violation text the table does not know (D10-862 ①). */
export const UNMAPPED_ALERT = 'order_reason_sub_unmapped';
/** pino's warn level. */
export const WARN = 40;
/** settle_month of the synthetic Taobao punishments (the month of OCCURRED_AT). */
export const SETTLE_MONTH = '203207';

/**
 * platform_rights_no of a Taobao punishment in production shape: `<tb_trade_id>:<settle_month>`
 * (union/infra/taobao/punishments.ts), i.e. it carries the full sub-order number.
 */
export function punishRightsNo(o: SeededOrder, settleMonth: string = SETTLE_MONTH): string {
  return `${o.subOrderId}:${settleMonth}`;
}

/** A synthetic parent order number, for orders.parent_order_id of the alert fixtures. */
export function parentOrderNo(): string {
  return `parent-${randomUUID()}`;
}

export interface SubRecordSpec {
  readonly type: RightsRecordInput['type'];
  readonly deductionFen?: bigint | null;
  /** The union's violation text; omitted → the field is left out of the input. */
  readonly violationType?: string | null;
  /**
   * platform_rights_no; default: PUNISH → punishRightsNo(o) (production shape, carries the
   * sub-order number), any other type → a fresh synthetic one.
   */
  readonly rightsNo?: string;
}

/** What an alert line must not carry beyond the seeded order's own identifiers. */
export interface RedactionSecrets {
  /** Further identifiers (parent order number, platform_rights_no). */
  readonly secrets: readonly string[];
  /** Amounts in fen of the order and its records. */
  readonly amounts: readonly bigint[];
  /** The raw violation text the alert is meant to carry (exempt from the amount check). */
  readonly raw?: string | null;
}

/** The display columns this task writes, plus the columns it must never move. */
export interface SubColumns {
  readonly rebate_status: string;
  readonly reason: string | null;
  readonly reason_sub: string | null;
  readonly reason_sub_manual: boolean;
}

export async function harness(db: Kysely<DB>) {
  const h = await rightsHarness(db);
  const appId = h.appId;
  /** Per order: every platform_rights_no handed to rights.record, and every amount it saw. */
  const handed = new Map<string, { rightsNos: string[]; amounts: bigint[] }>();

  function handedOf(o: SeededOrder): { rightsNos: string[]; amounts: bigint[] } {
    let entry = handed.get(o.orderId);
    if (entry === undefined) {
      entry = { rightsNos: [], amounts: [] };
      handed.set(o.orderId, entry);
    }
    return entry;
  }

  /** Every nonzero *_fen value of an orders row. */
  function amountsOf(row: Record<string, unknown>): bigint[] {
    return Object.entries(row)
      .filter(([key, value]) => key.endsWith('_fen') && typeof value === 'bigint' && value !== 0n)
      .map(([, value]) => value as bigint);
  }

  /** One successful rights.record (source API) in its own transaction, as orders' writer runs it. */
  async function record(o: SeededOrder, spec: SubRecordSpec): Promise<RightsRecordResult> {
    return db.transaction().execute(async (trx) => {
      await lockOrderKey(trx, o.platform, o.subOrderId);
      const before = await trx
        .selectFrom('orders')
        .selectAll()
        .where('app_id', '=', appId)
        .where('order_id', '=', o.orderId)
        .where('attr_at', '=', o.attrAt)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const rightsNo =
        spec.rightsNo ??
        (spec.type === 'PUNISH' ? punishRightsNo(o) : `synthetic-rights-${randomUUID()}`);
      const seen = handedOf(o);
      seen.rightsNos.push(rightsNo);
      seen.amounts.push(...amountsOf(before));
      if (spec.deductionFen !== undefined && spec.deductionFen !== null) {
        seen.amounts.push(spec.deductionFen);
      }
      const input: RightsRecordInput = {
        before,
        order_id: o.orderId,
        source: 'API',
        type: spec.type,
        status: 'SUCCEEDED',
        amount_fen: null,
        deduction_commission_fen: spec.deductionFen ?? null,
        occurred_at: new Date(OCCURRED_AT),
        platform_rights_no: rightsNo,
        now: h.clock.now(),
        ...(spec.violationType === undefined ? {} : { violation_type: spec.violationType }),
      };
      return h.recordPort().record(trx, input);
    });
  }

  /**
   * expectRedacted with everything this order exposes: its parent order number, every
   * platform_rights_no handed for it, and every amount of its row (before each record and now).
   */
  async function expectAlertRedacted(
    line: Record<string, unknown>,
    o: SeededOrder,
    raw: string | null,
  ): Promise<void> {
    const row = await h.read(o);
    const seen = handedOf(o);
    expect(seen.rightsNos.length, 'no rights record handed for this order').toBeGreaterThan(0);
    const secrets = [...seen.rightsNos];
    if (row.parent_order_id !== null) secrets.push(row.parent_order_id);
    expectRedacted(line, o, {
      secrets,
      amounts: [...seen.amounts, ...amountsOf(row), o.settleFen],
      raw,
    });
  }

  async function columns(o: SeededOrder): Promise<SubColumns> {
    const row = await h.read(o);
    return {
      rebate_status: row.rebate_status,
      reason: row.reason,
      reason_sub: row.reason_sub,
      reason_sub_manual: row.reason_sub_manual,
    };
  }

  /** Every log line of settlement's rights command, rebate port, clawback and credit service. */
  function allLogs(): Record<string, unknown>[] {
    return [...h.rightsLogs, ...h.logs, ...h.creditLogs];
  }

  function unmappedAlerts(): Record<string, unknown>[] {
    return allLogs().filter((line) => line['alert'] === UNMAPPED_ALERT);
  }

  return { ...h, record, columns, allLogs, unmappedAlerts, expectAlertRedacted };
}

export type SubHarness = Awaited<ReturnType<typeof harness>>;

/** pino's own fields (level, ISO time, process id) and the logger's base bindings. */
const LOGGER_FIELDS = new Set(['level', 'time', 'pid', 'entry', 'env', 'deployVersion']);

/** A field value as text (nested values serialized whole). */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The alert line carries the platform and the raw value only: no order number, sub-order number,
 * parent order number, order key, platform_rights_no (a Taobao punishment's carries the full
 * sub-order number), user or amount (orders AGENTS.md rule 10; D10-862 ①「不带单号 / 金额」).
 * Checked on every field value and on the whole serialized line; amounts are checked as whole
 * numbers on every field except pino's own (single-digit values are left out: rule codes such as
 * R8 carry digits).
 */
export function expectRedacted(
  line: Record<string, unknown>,
  o: SeededOrder,
  extra: RedactionSecrets = { secrets: [], amounts: [] },
): void {
  const text = JSON.stringify(line);
  const secrets = [
    o.orderId,
    o.subOrderId,
    o.orderKey,
    ...o.people.map((p) => p.userId),
    ...extra.secrets,
  ];
  for (const secret of secrets) {
    expect(text.includes(secret), 'alert carries an order, rights or user identifier').toBe(false);
    for (const [key, value] of Object.entries(line)) {
      const carries = textOf(value).includes(secret);
      expect(carries, `alert field ${key} carries an identifier`).toBe(false);
    }
  }
  const magnitudes = extra.amounts.map((a) => (a < 0n ? -a : a)).filter((a) => a >= 10n);
  const amounts = [...new Set(magnitudes.map((a) => a.toString()))];
  for (const [key, value] of Object.entries(line)) {
    if (LOGGER_FIELDS.has(key) || value === extra.raw) continue;
    const field = textOf(value);
    for (const amount of amounts) {
      expect(
        new RegExp(`(^|\\D)${amount}(\\D|$)`).test(field),
        `alert field ${key} carries an amount`,
      ).toBe(false);
    }
  }
  expect(
    Object.keys(line).filter((key) =>
      /order_id|order_key|sub_order|order_no|parent|rights_no|user_id|fen|amount/i.test(key),
    ),
  ).toEqual([]);
}
