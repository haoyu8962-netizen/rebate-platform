// B2-09zb rule-test harness (claude-independent, SPEC_REF 18f0015): R1's positive-difference
// candidate run (FU-SETTLE-ADJ-POSITIVE; 08 BR-FUND-09 ②, BR-CALC-02, BR-CALC-09; D10-769, D10-770,
// D10-780). Built on the B2-04s clawback harness (../clawback/kit.ts, itself on the B2-04m credit
// harness): every order is credited by the real credit service, so the generator starts from real
// CREDIT / FORFEIT vouchers, balances and booked pair; a later settlement record (seq + 1, written
// the way orders writes it: order_settlements row plus orders.settle_commission_fen) raises the
// union's settlement amount. Real pieces: PostgreSQL as couli_app, ledger getOrderNets, the
// beneficiary gate over identity / risk, commission's snapshot read, admin's system audit writer
// (through admin's public entry). Synthetic: every row, the configuration map.
// Expected amounts are written by hand in the tests from the BR-CALC-02 / BR-CALC-04 / BR-CALC-09
// formulas, never by calling the planner.
// Nothing here imports the test-database base statically: createDatabase loads it at run time.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely, Selectable } from 'kysely';
import { expect } from 'vitest';
import { getOrderNets } from '../../../../apps/api/src/modules/ledger/index.ts';
import { createRootLogger, type Clock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createSettleAdjustGenerator,
  type SettleAdjustAudit,
  type SettleAdjustRunResult,
} from '../../../../apps/api/src/modules/settlement/adjust/generate.ts';
import type { CreditRole } from '../../../../apps/api/src/modules/settlement/credit/index.ts';
import { harness as clawbackHarness, type OrderSpec, type SeededOrder } from '../clawback/kit.ts';

export { NOW, TIMEOUT, databaseFixture } from '../clawback/kit.ts';
export { failAfter } from '../credit/kit.ts';
export type { OrderSpec, SeededOrder } from '../clawback/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);

/** 决-10 A switch (default on). */
export const VOID_ON_CLAWBACK = 'settle.adjust.void_on_clawback.enabled';
/** D10-780: the audit action of a candidate set superseded by a new commission_version. */
export const SUPERSEDED_ACTION = 'settle_adjust_candidate_superseded';
export const SUPERSEDED_REASON = 'superseded_by_version';
/** The run's day (the harness clock NOW is 2032-07-24 10:00 +08:00, the default bill day). */
export const DAY = '2032-07-24';

/**
 * 08 BR-FUND-09 example: reserve 0, self 5000 bp and direct 1000 bp; credited at N = B = 1234
 * (617 / 123, platform 494); a settlement of 1300 gives 650 / 130 / 520, so +33 / +7 / +26.
 */
export const EXAMPLE: OrderSpec = {
  settleFen: 1234n,
  reserveBp: 0,
  people: [
    { role: 'self', ratioBp: 5000 },
    { role: 'direct', ratioBp: 1000 },
  ],
};

interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

/** The test database of one file (the testing base loaded at run time). */
export async function createDatabase(): Promise<TestDatabase> {
  const testing = (await import(new URL('packages/db/src/testing/index.ts', ROOT).href)) as {
    createTestDatabase(): Promise<TestDatabase>;
  };
  return testing.createTestDatabase();
}

interface AdminSystemAudit {
  createSystemAuditWriter(deps: { readonly clock: Clock }): SettleAdjustAudit;
}

/** admin's real system audit writer, through admin's public entry (as app.module injects it). */
async function adminAuditWriter(clock: Clock): Promise<SettleAdjustAudit> {
  // Loaded at run time: admin's entry carries Nest decorators the rule-test project does not check.
  const admin = (await import(
    new URL('apps/api/src/modules/admin/index.ts', ROOT).href
  )) as AdminSystemAudit;
  return admin.createSystemAuditWriter({ clock });
}

export type CandidateRow = Selectable<DB['settle_adjustments']>;

/** What a candidate row is compared by (role null: the platform row). */
export interface CandidateView {
  readonly role: string | null;
  readonly user_id: string | null;
  readonly diff_fen: bigint;
  readonly status: string;
  readonly settle_seq: number;
  readonly commission_version: number;
}

export function view(row: CandidateRow): CandidateView {
  return {
    role: row.role,
    user_id: row.user_id,
    diff_fen: row.diff_fen,
    status: row.status,
    settle_seq: row.settle_seq,
    commission_version: row.commission_version,
  };
}

const ROLE_ORDER = ['self', 'share', 'direct', 'indirect'];

/** Views ordered self, share, direct, indirect, then the platform row. */
export function ordered(rows: readonly CandidateRow[]): CandidateView[] {
  const rank = (role: string | null) => (role === null ? 99 : ROLE_ORDER.indexOf(role));
  return rows.map(view).sort((a, b) => rank(a.role) - rank(b.role));
}

export interface RunOptions {
  /** The executor the generator opens its transactions on (default: the shared pool). */
  readonly db?: Kysely<DB>;
  readonly platform?: string;
  readonly accountingDate?: string;
}

export interface SettleSpec {
  /** order_settlements.created_at (default: the clock). */
  readonly createdAt?: string;
}

export async function adjustHarness(db: Kysely<DB>) {
  const h = await clawbackHarness(db);
  const appId = h.appId;
  const audit = await adminAuditWriter(h.clock);
  const logs: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    {
      write(line: string) {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );

  /** A generator on the harness' collaborators (each call builds a new one). */
  function generator(executor: Kysely<DB> = db) {
    h.boot();
    return createSettleAdjustGenerator({
      db: executor,
      clock: h.clock,
      logger,
      gate: { lockUsers: h.lockUsers, readStates: h.readStates },
      readSnapshot: h.readSnapshot,
      readOrderNets: getOrderNets,
      config: { get: h.configGet },
      audit,
    });
  }

  async function run(options: RunOptions = {}): Promise<SettleAdjustRunResult> {
    return generator(options.db).run({
      appId,
      platform: options.platform ?? 'taobao',
      accountingDate: options.accountingDate ?? DAY,
    });
  }

  /** The greatest order_settlements seq of the order (0 when there is none). */
  async function currentSeq(o: SeededOrder): Promise<number> {
    const row = await db
      .selectFrom('order_settlements')
      .select((eb) => eb.fn.max('seq').as('seq'))
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .executeTakeFirst();
    return row?.seq ?? 0;
  }

  /**
   * A new STATEMENT settlement record of `fen` (seq + 1) and orders.settle_commission_fen = fen,
   * the way orders writes a statement row; returns the new seq.
   */
  async function settle(o: SeededOrder, fen: bigint, spec: SettleSpec = {}): Promise<number> {
    const seq = (await currentSeq(o)) + 1;
    const at = spec.createdAt === undefined ? h.clock.now() : new Date(spec.createdAt);
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('order_settlements')
        .values({
          app_id: appId,
          order_id: o.orderId,
          seq,
          source: 'STATEMENT',
          settle_commission_fen: fen,
          settled_at: at,
          content_hash: randomUUID(),
          created_at: at,
        })
        .execute();
      await trx
        .updateTable('orders')
        .set({ settle_commission_fen: fen })
        .where('app_id', '=', appId)
        .where('order_id', '=', o.orderId)
        .execute();
    });
    return seq;
  }

  /** Credits the order (real B2-04m service) and raises its settlement to `fen` (a new seq). */
  async function raised(
    spec: OrderSpec,
    fen: bigint,
  ): Promise<{ readonly o: SeededOrder; readonly seq: number }> {
    const o = await h.credited(spec);
    const seq = await settle(o, fen);
    return { o, seq };
  }

  /** users.status deleted (deletion done, BR-ID-28). */
  async function markDeleted(userId: string): Promise<void> {
    await db
      .updateTable('users')
      .set({ status: 'deleted' })
      .where('app_id', '=', appId)
      .where('id', '=', userId)
      .execute();
  }

  async function risk(userId: string, state: 'frozen' | 'appealing' | 'banned'): Promise<void> {
    await h.setRisk(db, userId, state);
  }

  /** Every settle_adjustments row of the app. */
  function allRows(): Promise<CandidateRow[]> {
    return db
      .selectFrom('settle_adjustments')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  /** The order's settle_adjustments rows. */
  async function rowsOf(o: SeededOrder): Promise<CandidateRow[]> {
    return (await allRows()).filter((r) => r.order_id === o.orderId);
  }

  function batches() {
    return db
      .selectFrom('settle_adjust_batches')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('created_at')
      .orderBy('batch_id')
      .execute();
  }

  /** Every batch of the app holds at least one candidate (no empty batch is ever written). */
  async function expectNoEmptyBatch(): Promise<void> {
    const rows = await allRows();
    for (const batch of await batches()) {
      expect(
        rows.some((r) => r.batch_id === batch.batch_id),
        `settle_adjust_batches ${batch.batch_id} has no candidate`,
      ).toBe(true);
    }
  }

  function audits(action?: string) {
    let query = db.selectFrom('audit_logs').selectAll().where('app_id', '=', appId);
    if (action !== undefined) query = query.where('action', '=', action);
    return query.orderBy('id').execute();
  }

  /** An admin account of the app (approver of a decided candidate). */
  async function admin(): Promise<string> {
    const id = randomUUID();
    await db
      .insertInto('admin_users')
      .values({
        id,
        app_id: appId,
        login_name: `adj-${id}`,
        password_hash: 'test-only',
        is_super: true,
        status: 'active',
      })
      .execute();
    return id;
  }

  /** Simulates B2-09zc's decision on the order's pending rows (no voucher is written here). */
  async function decide(
    o: SeededOrder,
    status: 'approved' | 'rejected',
    approver: string,
    at: string,
  ): Promise<void> {
    await db
      .updateTable('settle_adjustments')
      .set({
        status,
        approver,
        decided_at: new Date(at),
        reason: status === 'rejected' ? '测试拒绝' : null,
      })
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .where('status', '=', 'pending')
      .execute();
  }

  return {
    ...h,
    adjustLogs: logs,
    generator,
    run,
    currentSeq,
    settle,
    raised,
    markDeleted,
    risk,
    allRows,
    rowsOf,
    batches,
    expectNoEmptyBatch,
    audits,
    admin,
    decide,
  };
}

export type AdjustHarness = Awaited<ReturnType<typeof adjustHarness>>;

/** The expected view of a beneficiary row. */
export function beneficiaryRow(
  o: SeededOrder,
  role: CreditRole,
  diff: bigint,
  seq: number,
  version = 1,
): CandidateView {
  return {
    role,
    user_id: o.user(role),
    diff_fen: diff,
    status: 'pending',
    settle_seq: seq,
    commission_version: version,
  };
}

/** The expected view of the platform row. */
export function platformRow(diff: bigint, seq: number, version = 1): CandidateView {
  return {
    role: null,
    user_id: null,
    diff_fen: diff,
    status: 'pending',
    settle_seq: seq,
    commission_version: version,
  };
}

/** The values of an audit snapshot as text (bigint as digits). */
export function valuesOf(snapshot: unknown): string[] {
  if (typeof snapshot !== 'object' || snapshot === null) return [];
  return Object.values(snapshot as Record<string, unknown>).map((v) => String(v));
}

/** A whole value as text (bigint as digits). */
export function text(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown) =>
    typeof member === 'bigint' ? member.toString() : member,
  );
}
