// B2-03q rule-test kit (D10-540, D10-565, D10-568). Real rows and the real rebate, clawback and
// ledger code; the estimates under test always come from commission's public entry, never a double.
// Expected amounts are written by hand in the tests; the seeds only derive the v1 rows of a snapshot
// from the BR-CALC-02 / BR-CALC-04 formulas (baseOf, shareOf). Integration tests pass the database
// in: this file never imports @couli/db/testing.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { addFen, subFen } from '@couli/money';
import type { Insertable, Kysely, Transaction } from 'kysely';
import { vi } from 'vitest';
import type { CommissionEstimatesDependencies } from '../../../../apps/api/src/modules/commission/ports/estimates.ts';
import { findPlatformRules } from '../../../../apps/api/src/modules/orders/domain/platform-rules/index.ts';
import {
  lockOrderKey,
  type OrderStatusSource,
  type OrderUpdateChange,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { FixedClock, createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createRebatePort,
  type RebateDependencies,
  type RebatePort,
} from '../../../../apps/api/src/modules/settlement/index.ts';
import { readRebateOrder } from '../../../../apps/api/src/modules/settlement/rebate/infra/rebate-store.ts';
import { baseOf, harness as clawbackHarness, shareOf } from '../../settlement/clawback/kit.ts';
import { seedVersion, version as ruleVersion } from '../snapshot/fixtures.ts';

// Through commission's public entry, loaded at run time like the other rule tests: the test
// project's tsc stays out of the Nest decorator graph. The type queries are erased.
export const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as {
  createCommissionEstimates: typeof import('../../../../apps/api/src/modules/commission/ports/estimates.ts').createCommissionEstimates;
  createCommissionSnapshotPort: typeof import('../../../../apps/api/src/modules/commission/ports/estimates.ts').createCommissionSnapshotPort;
  createInMemoryBeneficiaryResolver: typeof import('../../../../apps/api/src/modules/commission/infra/in-memory-beneficiary-resolver.ts').createInMemoryBeneficiaryResolver;
  readCommissionSnapshot: typeof import('../../../../apps/api/src/modules/commission/application/read-snapshot.ts').readCommissionSnapshot;
};

export { TIMEOUT, databaseFixture, tracing } from '../../settlement/clawback/kit.ts';
export {
  clawbackKey,
  platformClawbackKey,
  platformDecreaseLines,
  receivable,
  userClawbackLines,
} from '../../settlement/clawback/kit.ts';

export const SNAPSHOT_AT = new Date('2026-10-20T01:00:00.000Z');
export const NOW = '2027-01-02T03:04:05.000Z';
export const LATER = '2027-02-03T04:05:06.000Z';

type Role = 'self' | 'share' | 'direct' | 'indirect';
type ShareEventStatus = 'active' | 'held' | 'forfeited';
type OrderPatch = Partial<Insertable<DB['orders']>>;

export interface PersonInput {
  readonly role: Role;
  readonly ratioBp: number;
  readonly userId?: string;
  readonly initialStatus?: 'active' | 'forfeited';
}

export interface OrderInput {
  /** taobao by default; a pdd order takes service_fee_fen through patch. */
  readonly platform?: 'taobao' | 'jd' | 'pdd';
  readonly rebateStatus?: string;
  readonly platformStatus?: string;
  readonly estFen?: bigint | null;
  readonly settleFen?: bigint | null;
  /** orders.commission_version; 1 by default, the snapshot writes amount rows of version 1. */
  readonly commissionVersion?: number;
  readonly people?: readonly PersonInput[];
  /** false: an order without a snapshot. */
  readonly snapshot?: boolean;
  /** The N of the snapshot: an estimate older than the order's current columns. */
  readonly snapshotNFen?: bigint;
  readonly reserveBp?: number;
  readonly tljDeductFen?: bigint;
  readonly subsidyFen?: bigint;
  /** commission_split_totals.tlj_redpacket_fen of version 1; null with an unmatched red packet. */
  readonly redpacketFen?: bigint | null;
  readonly rebateMode?: 'none' | 'normal' | null;
  readonly patch?: OrderPatch;
}

export interface VersionInput {
  readonly version: number;
  readonly nTotalFen: bigint;
  readonly baseFen: bigint;
  readonly amounts: readonly bigint[];
  readonly redpacketFen?: bigint | null;
  readonly createdAt?: Date;
}

export interface PortOrder {
  readonly appId: string;
  readonly orderId: string;
  readonly platform: string;
  readonly subOrderId: string;
  readonly attrAt: Date;
}

export interface SeededPortOrder extends PortOrder {
  readonly people: readonly (PersonInput & {
    readonly userId: string;
    readonly initialStatus: 'active' | 'forfeited';
  })[];
  user(role: Role): string;
}

export interface SyncSpec {
  /** New est_commission_fen; a different value moves commission_version like orders' sync. */
  readonly estAfter?: bigint;
  readonly refundedQuantityAfter?: number;
  readonly event?: OrderStatusSource['event'];
  readonly attributedNow?: boolean;
}

export const DEFAULT_PEOPLE: readonly PersonInput[] = [
  { role: 'self', ratioBp: 5000 },
  { role: 'direct', ratioBp: 1000 },
  { role: 'indirect', ratioBp: 500 },
];

const ROLE_ORDER = ['self', 'share', 'direct', 'indirect'];

/** Sorted by commission_version, then owner, direct, indirect. */
function bySnapshotOrder<T extends { commission_version: number; role: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (a, b) =>
      a.commission_version - b.commission_version ||
      ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role),
  );
}

/** The columns come through settlement's read of the row, the fee rule from orders' rule table. */
function estimatesDependencies(clock: FixedClock): CommissionEstimatesDependencies {
  return {
    clock,
    readOrder: readRebateOrder,
    serviceFeeDeducted: (platform) => findPlatformRules(platform)?.serviceFeeDeducted === true,
  };
}

/** The port as settlement takes it: assigning it here checks the shape against rebate.ts. */
export function estimatesOf(clock: FixedClock): RebateDependencies['estimates'] {
  return commission.createCommissionEstimates(estimatesDependencies(clock));
}

/** Commission's port for orders' snapshot step, over one owner at level L1 with no inviter. */
export function snapshotPortOf(clock: FixedClock, appId: string, ownerUserId: string) {
  const owner = {
    userId: ownerUserId,
    level: 'L1',
    status: 'active',
    forfeitReason: null,
  } as const;
  return commission.createCommissionSnapshotPort({
    ...estimatesDependencies(clock),
    logger: { warn: vi.fn() },
    beneficiaries: commission.createInMemoryBeneficiaryResolver([
      { appId, beneficiaries: { owner, direct: null, indirect: null, warnings: [] } },
    ]),
  });
}

/** A published rule version for real snapshots: reserve 1500, own 5000 on all three platforms. */
export async function snapshotRules(
  db: Kysely<DB>,
  appId: string,
  options: { readonly effectiveFrom?: Date; readonly reserves?: boolean } = {},
): Promise<void> {
  const platforms = ['taobao', 'jd', 'pdd'] as const;
  await seedVersion(
    db,
    appId,
    ruleVersion({
      ...(options.effectiveFrom === undefined ? {} : { effective_from: options.effectiveFrom }),
      reserves:
        options.reserves === false
          ? []
          : platforms.map((platform) => ({ platform, reserve_bp: 1500 })),
    }),
  );
}

/** The columns of the orders row: the version the snapshot step moved. */
export async function orderRow(db: Kysely<DB>, order: Pick<PortOrder, 'appId' | 'orderId'>) {
  return db
    .selectFrom('orders')
    .selectAll()
    .where('app_id', '=', order.appId)
    .where('order_id', '=', order.orderId)
    .executeTakeFirstOrThrow();
}

/** The port's reference of a row read back from the orders table. */
export function portOrderOf(row: {
  app_id: string;
  order_id: string;
  platform: string;
  sub_order_id: string;
  attr_at: Date;
}): PortOrder {
  return {
    appId: row.app_id,
    orderId: row.order_id,
    platform: row.platform,
    subOrderId: row.sub_order_id,
    attrAt: row.attr_at,
  };
}

/** Transactional event marker, like the platform outbox: rolls back with the caller. */
function publishing(clock: FixedClock): RebateDependencies['events'] {
  return {
    publish: async (trx, event) => {
      const eventId = event.eventId ?? randomUUID();
      await trx
        .insertInto('event_log')
        .values({
          app_id: event.appId,
          event_id: eventId,
          name: event.name,
          payload: JSON.stringify(event.payload),
          occurred_at: clock.now(),
          created_at: clock.now(),
        })
        .execute();
      return { eventId, duplicate: false };
    },
  };
}

/** The real rebate port over the given estimates; a hold audit is outside these tests. */
export function rebateOf(
  clock: FixedClock,
  estimates: RebateDependencies['estimates'],
  events: RebateDependencies['events'] = publishing(clock),
): RebatePort {
  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    { write: () => undefined },
  );
  return createRebatePort({
    clock,
    logger,
    events,
    config: { get: async () => undefined },
    estimates,
    audit: {
      append: async () => {
        throw new Error('estimate-port kit: no hold audit expected');
      },
    },
  });
}

/**
 * What orders' sync writes before it calls settlement (planOrderSyncColumns, update-step): the
 * order lock, est_commission_fen with commission_version + 1 when the estimate changed, and
 * row_version + 1. It writes no commission row: that is the gap refresh closes (D10-565).
 */
export async function syncColumns(
  trx: Transaction<DB>,
  order: PortOrder,
  spec: SyncSpec,
): Promise<{ readonly change: OrderUpdateChange; readonly source: OrderStatusSource }> {
  await lockOrderKey(trx, order.platform, order.subOrderId);
  const before = await trx
    .selectFrom('orders')
    .selectAll()
    .where('app_id', '=', order.appId)
    .where('order_id', '=', order.orderId)
    .executeTakeFirstOrThrow();
  const estAfter = spec.estAfter ?? before.est_commission_fen;
  const moved = estAfter !== before.est_commission_fen;
  await trx
    .updateTable('orders')
    .set({
      est_commission_fen: estAfter,
      commission_version: moved ? before.commission_version + 1 : before.commission_version,
      refunded_quantity: spec.refundedQuantityAfter ?? before.refunded_quantity,
      row_version: before.row_version + 1,
    })
    .where('app_id', '=', order.appId)
    .where('order_id', '=', order.orderId)
    .execute();
  return {
    change: {
      app_id: order.appId,
      order_id: order.orderId,
      attr_at: before.attr_at,
      from_status: before.platform_status,
      to_status: before.platform_status,
      rule: null,
      received_at: before.received_at,
      est_before: before.est_commission_fen,
      est_after: estAfter,
      settle_commission_fen: before.settle_commission_fen,
      attributed_now: spec.attributedNow ?? false,
    },
    source: { event: spec.event ?? 'PLATFORM_PAID', raw_status: 'synthetic' },
  };
}

/** Every amount row of the order, oldest version first, in the snapshot's beneficiary order. */
export async function amountRows(db: Kysely<DB>, order: PortOrder) {
  return bySnapshotOrder(
    await db
      .selectFrom('commission_split_amounts')
      .selectAll()
      .where('app_id', '=', order.appId)
      .where('order_id', '=', order.orderId)
      .execute(),
  );
}

export async function totalsRows(db: Kysely<DB>, order: PortOrder) {
  return db
    .selectFrom('commission_split_totals')
    .selectAll()
    .where('app_id', '=', order.appId)
    .where('order_id', '=', order.orderId)
    .orderBy('commission_version')
    .execute();
}

/** The amounts of one version as [role, base_fen, amount_fen], in the snapshot's order. */
export async function amountsAt(db: Kysely<DB>, order: PortOrder, version: number) {
  return (await amountRows(db, order))
    .filter((r) => r.commission_version === version)
    .map((r) => [r.role, r.base_fen, r.amount_fen] as const);
}

export async function totalsAt(db: Kysely<DB>, order: PortOrder, version: number) {
  const row = (await totalsRows(db, order)).find((t) => t.commission_version === version);
  if (row === undefined) return undefined;
  return {
    n_total_fen: row.n_total_fen,
    pre_base_deduct_fen: row.pre_base_deduct_fen,
    base_fen: row.base_fen,
    user_share_total_fen: row.user_share_total_fen,
    tlj_redpacket_fen: row.tlj_redpacket_fen,
    platform_est_profit_fen: row.platform_est_profit_fen,
  };
}

export async function storedVersions(db: Kysely<DB>, order: PortOrder) {
  const amounts = (await amountRows(db, order)).map((r) => r.commission_version);
  return {
    amounts: [...new Set(amounts)],
    totals: (await totalsRows(db, order)).map((t) => t.commission_version),
  };
}

/** Whatever money rows the app holds: refresh must leave all of them alone. */
export async function moneyRows(db: Kysely<DB>, appId: string) {
  const rowsOf = (table: 'ledger_vouchers' | 'ledger_entries' | 'account_balances') =>
    db.selectFrom(table).selectAll().where('app_id', '=', appId).execute();
  return {
    vouchers: await rowsOf('ledger_vouchers'),
    entries: await rowsOf('ledger_entries'),
    balances: await rowsOf('account_balances'),
  };
}

/** The orders row, the snapshot row and the beneficiary events: refresh writes none of them. */
export async function frozenRows(db: Kysely<DB>, order: PortOrder) {
  return {
    order: await db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', order.appId)
      .where('order_id', '=', order.orderId)
      .executeTakeFirstOrThrow(),
    split: await db
      .selectFrom('commission_splits')
      .selectAll()
      .where('app_id', '=', order.appId)
      .where('order_id', '=', order.orderId)
      .execute(),
    events: await db
      .selectFrom('commission_split_beneficiary_events')
      .selectAll()
      .where('app_id', '=', order.appId)
      .where('order_id', '=', order.orderId)
      .orderBy('event_seq')
      .execute(),
  };
}

/** A new app with one published rule version, the clock and the estimates under test. */
export async function fixture(db: Kysely<DB>, appId: string = `estimate-${randomUUID()}`) {
  const clock = new FixedClock(NOW);
  const ruleVersionId = randomUUID();
  await db
    .insertInto('commission_rule_versions')
    .values({
      app_id: appId,
      rule_version_id: ruleVersionId,
      status: 'published',
      effective_from: SNAPSHOT_AT,
      indirect_enabled: true,
      created_at: SNAPSHOT_AT,
    })
    .execute();
  const estimates = estimatesOf(clock);

  async function user(userId: string = randomUUID()): Promise<string> {
    await db
      .insertInto('users')
      .values({
        id: userId,
        app_id: appId,
        nickname: 'synthetic',
        avatar: '',
        invite_code: randomUUID(),
        attr_code: randomUUID(),
        level: 'L1',
        register_method: 'phone',
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    return userId;
  }

  async function order(input: OrderInput = {}): Promise<SeededPortOrder> {
    const orderId = randomUUID();
    const platform = input.platform ?? 'taobao';
    const subOrderId = `sub-${randomUUID()}`;
    const attrAt = SNAPSHOT_AT;
    const reserveBp = input.reserveBp ?? 1500;
    const tlj = input.tljDeductFen ?? 0n;
    const subsidy = input.subsidyFen ?? 0n;
    const redpacket = input.redpacketFen === undefined ? 0n : input.redpacketFen;
    const n = input.snapshotNFen ?? 1000n;
    const people = await Promise.all(
      (input.people ?? DEFAULT_PEOPLE).map(async (p) => ({
        ...p,
        userId: p.userId ?? (await user()),
        initialStatus: p.initialStatus ?? ('active' as const),
      })),
    );
    const owner = people.find((p) => p.role === 'self' || p.role === 'share');
    const orderType = people.some((p) => p.role === 'share') ? 'share' : 'self';
    await db
      .insertInto('order_keys')
      .values({
        app_id: appId,
        order_id: orderId,
        platform,
        sub_order_id: subOrderId,
        attr_at: attrAt,
        created_at: attrAt,
      })
      .execute();
    await db
      .insertInto('orders')
      .values({
        app_id: appId,
        order_id: orderId,
        platform,
        sub_order_id: subOrderId,
        attr_at: attrAt,
        raw_item_id: 'synthetic',
        user_id: owner?.userId ?? null,
        user_basis: 'param',
        buy_type: orderType,
        platform_status: input.platformStatus ?? 'PAID',
        rebate_status: input.rebateStatus ?? 'ESTIMATED',
        est_commission_fen: input.estFen === undefined ? n : input.estFen,
        settle_commission_fen: input.settleFen ?? null,
        commission_version: input.commissionVersion ?? 1,
        quantity: 2,
        refunded_quantity: 0,
        created_at: attrAt,
        updated_at: attrAt,
        ...input.patch,
      })
      .execute();
    const seeded: SeededPortOrder = {
      appId,
      orderId,
      platform,
      subOrderId,
      attrAt,
      people,
      user(role) {
        const found = people.find((p) => p.role === role);
        if (found === undefined) throw new Error(`estimate-port kit: no ${role} beneficiary`);
        return found.userId;
      },
    };
    if (input.snapshot === false) return seeded;

    const { base, reserve } = baseOf(n, reserveBp, tlj);
    const amounts = people.map((p) =>
      p.initialStatus === 'active' ? shareOf(base, p.ratioBp) : 0n,
    );
    const userTotal = amounts.reduce((sum, a) => addFen(sum, a), 0n);
    const nTotal = addFen(n, subsidy);
    await db
      .insertInto('commission_splits')
      .values({
        app_id: appId,
        order_id: orderId,
        rule_version_id: ruleVersionId,
        order_type: orderType,
        activity_type: (input.rebateMode ?? null) === null ? null : 'tlj',
        rebate_mode: input.rebateMode ?? null,
        paid_at: attrAt,
        paid_at_source: 'platform',
        raw_n_fen: n,
        subsidy_commission_fen: subsidy,
        reserve_bp: reserveBp,
        reserve_fen: reserve,
        tlj_deduct_fen: tlj,
        base_fen: base,
        platform_retain_fen: subFen(base, userTotal),
        beneficiaries: JSON.stringify(
          people.map((p) => ({
            user_id: p.userId,
            role: p.role,
            ratio_bp: p.ratioBp,
            level: 'L1',
            initial_status: p.initialStatus,
            forfeit_reason: p.initialStatus === 'forfeited' ? 'deleted' : null,
          })),
        ),
        created_at: attrAt,
      })
      .execute();
    await version(seeded, {
      version: 1,
      nTotalFen: nTotal,
      baseFen: base,
      amounts,
      redpacketFen: redpacket,
    });
    for (const p of people) {
      const reason = p.initialStatus === 'forfeited' ? 'deleted' : null;
      await event(seeded, p.role, p.initialStatus, reason);
    }
    return seeded;
  }

  /** One stored version of the amounts and totals, written straight into the tables. */
  async function version(o: SeededPortOrder, input: VersionInput): Promise<void> {
    const at = input.createdAt ?? SNAPSHOT_AT;
    const redpacket = input.redpacketFen === undefined ? 0n : input.redpacketFen;
    const userTotal = input.amounts.reduce((sum, a) => addFen(sum, a), 0n);
    await db
      .insertInto('commission_split_totals')
      .values({
        app_id: appId,
        order_id: o.orderId,
        commission_version: input.version,
        n_total_fen: input.nTotalFen,
        pre_base_deduct_fen: subFen(input.nTotalFen, input.baseFen),
        base_fen: input.baseFen,
        user_share_total_fen: userTotal,
        tlj_redpacket_fen: redpacket,
        platform_est_profit_fen:
          redpacket === null ? null : subFen(subFen(input.nTotalFen, userTotal), redpacket),
        created_at: at,
      })
      .execute();
    await db
      .insertInto('commission_split_amounts')
      .values(
        o.people.map((p, i) => ({
          app_id: appId,
          order_id: o.orderId,
          commission_version: input.version,
          user_id: p.userId,
          role: p.role,
          base_fen: input.baseFen,
          amount_fen: input.amounts[i] ?? 0n,
          created_at: at,
        })),
      )
      .execute();
  }

  async function event(
    o: SeededPortOrder,
    role: Role,
    status: ShareEventStatus,
    reason: string | null,
  ): Promise<void> {
    await db
      .insertInto('commission_split_beneficiary_events')
      .values({
        app_id: appId,
        order_id: o.orderId,
        user_id: o.user(role),
        role,
        status,
        reason,
        created_at: SNAPSHOT_AT,
      })
      .execute();
  }

  /** A later published rule version: nothing of it may reach an order that has its snapshot. */
  async function newerRules(): Promise<void> {
    const id = randomUUID();
    const effective = new Date('2026-11-01T00:00:00.000Z');
    await db
      .insertInto('commission_rule_versions')
      .values({
        app_id: appId,
        rule_version_id: id,
        status: 'published',
        effective_from: effective,
        indirect_enabled: false,
        created_at: effective,
      })
      .execute();
    await db
      .insertInto('commission_rule_reserves')
      .values({ app_id: appId, rule_version_id: id, platform: 'taobao', reserve_bp: 9000 })
      .execute();
    await db
      .insertInto('commission_rules')
      .values(
        (['L1', 'L2', 'L3'] as const).flatMap((level) =>
          (['self', 'share'] as const).map((order_type) => ({
            app_id: appId,
            rule_version_id: id,
            platform: 'taobao',
            level,
            order_type,
            r_own_bp: 1000,
            r_direct_bp: 100,
            r_indirect_bp: 100,
          })),
        ),
      )
      .execute();
  }

  /** Moves the order's columns as orders' sync does; no commission row, no settlement call. */
  async function move(o: PortOrder, spec: SyncSpec): Promise<void> {
    await db.transaction().execute(async (trx) => {
      await syncColumns(trx, o, spec);
    });
  }

  /** One refresh on a transaction of its own that holds the order lock. */
  async function refresh(o: PortOrder): Promise<void> {
    await db.transaction().execute(async (trx) => {
      await lockOrderKey(trx, o.platform, o.subOrderId);
      await estimates.refresh(trx, { appId: o.appId, orderId: o.orderId, attrAt: o.attrAt });
    });
  }

  async function bases(
    o: PortOrder,
    input: {
      readonly estBefore?: bigint | null;
      readonly estAfter: bigint | null;
      readonly settleCommissionFen: bigint | null;
    },
  ) {
    return db.transaction().execute((trx) =>
      estimates.bases(trx, {
        appId: o.appId,
        orderId: o.orderId,
        attrAt: o.attrAt,
        estBefore: input.estBefore ?? null,
        estAfter: input.estAfter,
        settleCommissionFen: input.settleCommissionFen,
      }),
    );
  }

  return {
    appId,
    clock,
    db,
    estimates,
    ruleVersionId,
    user,
    order,
    version,
    event,
    newerRules,
    move,
    refresh,
    bases,
  };
}

/** The B2-04s clawback harness over a really credited order, plus the real estimates. */
export async function creditedFixture(db: Kysely<DB>) {
  const h = await clawbackHarness(db);
  const estimates = estimatesOf(h.clock);
  const refresh = vi.fn<RebateDependencies['estimates']['refresh']>((trx, input) =>
    estimates.refresh(trx, input),
  );
  const rebate = rebateOf(
    h.clock,
    { bases: (trx, input) => estimates.bases(trx, input), refresh },
    { publish: h.publish },
  );

  function target(o: { orderId: string; platform: string; subOrderId: string; attrAt: Date }) {
    return { ...o, appId: h.appId };
  }

  /** Only orders' columns: the version moves ahead of the commission rows, nothing else runs. */
  async function move(
    o: { orderId: string; platform: string; subOrderId: string; attrAt: Date },
    spec: SyncSpec,
  ): Promise<void> {
    await db.transaction().execute(async (trx) => {
      await syncColumns(trx, target(o), spec);
    });
  }

  /** One sync: orders' columns, then settlement's rebate, then the clawback, on one transaction. */
  async function syncOrder(
    o: { orderId: string; platform: string; subOrderId: string; attrAt: Date },
    spec: SyncSpec,
  ) {
    const clawback = h.boot();
    return db.transaction().execute(async (trx) => {
      const { change, source } = await syncColumns(trx, target(o), {
        event: 'PLATFORM_SETTLED',
        ...spec,
      });
      await rebate.onUpdated(trx, change, source);
      return clawback.onUpdated(trx, change, source);
    });
  }

  /** A partial refund on one transaction: the sync, then the clawback with the union's new N. */
  async function partialRefund(
    o: { orderId: string; platform: string; subOrderId: string; attrAt: Date },
    spec: SyncSpec & { readonly newCommissionFen: bigint },
  ) {
    const clawback = h.boot();
    return db.transaction().execute(async (trx) => {
      const { change, source } = await syncColumns(trx, target(o), {
        event: 'PLATFORM_SETTLED',
        ...spec,
      });
      await rebate.onUpdated(trx, change, source);
      return clawback.apply(trx, {
        appId: h.appId,
        orderId: o.orderId,
        cause: 'PARTIAL_REFUND',
        ref: { kind: 'commission' },
        newCommissionFen: spec.newCommissionFen,
        rightsDeductFen: null,
      });
    });
  }

  return { ...h, estimates, refresh, rebate, target, move, syncOrder, partialRefund };
}
