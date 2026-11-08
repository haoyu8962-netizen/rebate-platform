// B1-10i: the console's order reads (GET /admin/v1/orders, GET /admin/v1/orders/{order_id}; 04
// §11.2 order.view / user.lookup; contract adminListOrders / adminGetOrder, CT-24m, CT-24n). The
// permission check (order.view, or user.lookup together with user_id) is the controller's,
// through platform's AdminOperationGuard; appId is always the guard's actor, never a header or
// query field. Reads only: nothing is written or audited, and the raw union payload is never
// returned. Other modules' data come in as ports assembled by app.module: identity's masked
// phones, admin's latest manual hold audit and display names, commission's snapshot, linking's
// link_logs of the order's link, content's credit.enabled.<platform>, settlement's order figures.
//
// display_status is BR-FUND-17 through the user-side deriveDisplayStatus over the order's own
// columns and the same figures reader as the user side (B1-09p), with the order's owner as viewer.
// Only the detail carries display_status, and it carries none of the amounts (contract).
import { enums, type Schema } from '@couli/contracts-ts';
import { fenToJsonNumber } from '@couli/money';
import {
  adminOrderFlags,
  lastManualHold,
  normalizeOrderQuery,
  unmappedPendingOpen,
  type AdminOrderHoldAudit,
} from '../domain/admin-order-view.ts';
import { isUuid } from '../domain/admin-claim-view.ts';
import { deriveDisplayStatus, type DisplayStatusInput } from '../domain/query-rules.ts';
import type { OrderFigures, OrderFiguresReader } from './order-queries.ts';
import type {
  AdminOrderDetailRow,
  AdminOrderFilter,
  AdminOrderReads,
  AdminOrderRow,
} from '../infra/admin-order-reads.ts';

export interface AdminOrderListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly platform?: string;
  readonly platform_status?: string;
  readonly rebate_status?: string;
  readonly flag?: string;
  readonly user_id?: string;
  readonly q?: string;
  readonly paid_from?: string;
  readonly paid_to?: string;
}

/** One commission snapshot as commission stores it (commission_splits). */
export interface AdminOrderSplitRecord {
  readonly rule_version_id: string;
  readonly order_type: string;
  readonly raw_n_fen: bigint;
  readonly subsidy_commission_fen: bigint;
  readonly reserve_bp: number;
  readonly reserve_fen: bigint;
  readonly tlj_deduct_fen: bigint;
  readonly base_fen: bigint;
  readonly platform_retain_fen: bigint;
  /** commission_splits.beneficiaries as stored (a JSON array). */
  readonly beneficiaries: unknown;
  readonly created_at: Date;
}

/** One link_logs record of the order's link: its time, event and scene only. */
export interface AdminOrderLinkRecord {
  readonly at: Date;
  readonly event: string;
  readonly scene: string | null;
}

/** Other modules' read ports (app.module). */
export interface AdminOrderPorts {
  /** identity: user_id → masked phone or null. */
  readonly phones: (
    appId: string,
    userIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string | null>>;
  /** admin: admin_id → display name (display_name, else login_name); unknown ids left out. */
  readonly adminNames: (
    appId: string,
    adminIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
  /** admin: the newest order_hold audit record of the order, or null. */
  readonly latestHold: (appId: string, orderId: string) => Promise<AdminOrderHoldAudit | null>;
  /** commission: the order's snapshot, or null before it is generated. */
  readonly commissionSplit: (
    appId: string,
    orderId: string,
  ) => Promise<AdminOrderSplitRecord | null>;
  /** linking: the newest `limit` records of the link, newest first. */
  readonly linkLogs: (
    appId: string,
    linkId: string,
    limit: number,
  ) => Promise<readonly AdminOrderLinkRecord[]>;
  /** content: whether config credit.enabled.<platform> is true for the app. */
  readonly creditEnabled: (appId: string, platform: string) => Promise<boolean>;
  /**
   * settlement: the user side's order figures, read with the order's owner as viewer. app.module
   * always gives it; without it the figures stay unknown, for module tests only.
   */
  readonly figures?: OrderFiguresReader;
}

export interface AdminOrdersDeps extends AdminOrderPorts {
  readonly reads: AdminOrderReads;
}

/** A 20001 with data.fields (q, the paid range; order_id for a non-UUID, unknown or foreign order). */
export class AdminOrdersFieldsError extends Error {
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super('orders: admin order read refused');
    this.name = 'AdminOrdersFieldsError';
    this.fields = fields;
  }
}

const DEFAULT_PAGE_SIZE = 20;
/** Contract AdminOrderDetail.link_logs maxItems. */
const LINK_LOG_LIMIT = 50;
const LINK_EVENTS: ReadonlySet<string> = new Set(enums.link_event);
const LINK_SCENES: ReadonlySet<string> = new Set(enums.scene);
const ROLES: ReadonlySet<string> = new Set(enums.beneficiary_role);
const FORFEIT_REASONS: ReadonlySet<string> = new Set(enums.forfeit_reason);

type ListItem = Schema<'AdminOrderListItem'>;
type Detail = Schema<'AdminOrderDetail'>;

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function fen(value: bigint | null): number | null {
  return value === null ? null : fenToJsonNumber(value);
}

/**
 * B1-09v: reason_sub when the order has one, or when 「无」 was chosen by hand (null); otherwise the
 * key is left out (the contract's「absent is the same as null」).
 */
function reasonSubOf(row: {
  readonly reason_sub?: string | null;
  readonly reason_sub_manual?: boolean;
}): Pick<Detail, 'reason_sub'> {
  const value = row.reason_sub ?? null;
  if (value === null && row.reason_sub_manual !== true) return {};
  return { reason_sub: value as NonNullable<Detail['reason_sub']> | null };
}

/** hold_reason is set only while hold is true (contract AdminOrderListItem.hold_reason). */
function holdReasonOf(row: AdminOrderRow): string | null {
  return row.hold ? row.hold_reason : null;
}

/** The shared reads; built without a database it fails closed on first use (50001). */
export class AdminOrders {
  readonly #deps: AdminOrdersDeps | null;

  constructor(deps: AdminOrdersDeps | null = null) {
    this.#deps = deps;
  }

  async list(appId: string, query: AdminOrderListQuery): Promise<Schema<'AdminOrderPage'>> {
    let q: string | undefined;
    if (query.q !== undefined) {
      const normalized = normalizeOrderQuery(query.q);
      if (normalized === null) throw new AdminOrdersFieldsError(['q']);
      q = normalized;
    }
    if (query.paid_from !== undefined && query.paid_to !== undefined) {
      const from = Date.parse(query.paid_from);
      const to = Date.parse(query.paid_to);
      if (Number.isNaN(from)) throw new AdminOrdersFieldsError(['paid_from']);
      if (Number.isNaN(to)) throw new AdminOrdersFieldsError(['paid_to']);
      if (from > to) throw new AdminOrdersFieldsError(['paid_from', 'paid_to']);
    }
    const deps = this.available();
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    // A user_id that is not a UUID names no user (orders.user_id is uuid): an empty page.
    if (query.user_id !== undefined && !isUuid(query.user_id)) {
      return { items: [], page, page_size: pageSize, total: 0 };
    }
    const filter: AdminOrderFilter = {
      appId,
      ...(query.platform === undefined ? {} : { platform: query.platform }),
      ...(query.platform_status === undefined ? {} : { platformStatus: query.platform_status }),
      ...(query.rebate_status === undefined ? {} : { rebateStatus: query.rebate_status }),
      ...(query.flag === undefined ? {} : { flag: query.flag }),
      ...(query.user_id === undefined ? {} : { userId: query.user_id.toLowerCase() }),
      ...(q === undefined ? {} : { q }),
      ...(query.paid_from === undefined ? {} : { paidFrom: query.paid_from }),
      ...(query.paid_to === undefined ? {} : { paidTo: query.paid_to }),
    };
    const total = await deps.reads.count(filter);
    const offset = (page - 1) * pageSize;
    const rows = offset >= total ? [] : await deps.reads.page(filter, offset, pageSize);
    const phones = await this.phonesOf(deps, appId, rows);
    return {
      items: rows.map((row) => listItem(row, phones)),
      page,
      page_size: pageSize,
      total,
    };
  }

  /**
   * One order of the app. With userId (any account) an order of another user or of nobody
   * answers like an unknown one: 20001 [order_id].
   */
  async detail(appId: string, orderId: string, userId: string | undefined): Promise<Detail> {
    // A non-UUID order_id names no order: the same answer as an unknown one, before the database.
    if (!isUuid(orderId)) throw new AdminOrdersFieldsError(['order_id']);
    const deps = this.available();
    const row = await deps.reads.order(appId, orderId.toLowerCase());
    if (
      row === undefined ||
      (userId !== undefined &&
        (row.user_id === null || row.user_id.toLowerCase() !== userId.toLowerCase()))
    ) {
      throw new AdminOrdersFieldsError(['order_id']);
    }
    const holdReason = holdReasonOf(row);
    const [phones, history, pending, audit, split, links, creditEnabled, figures] =
      await Promise.all([
        this.phonesOf(deps, appId, [row]),
        deps.reads.history(appId, row.order_id),
        holdReason === 'UNMAPPED_STATUS'
          ? deps.reads.pending(appId, row.platform, row.sub_order_id)
          : Promise.resolve([]),
        deps.latestHold(appId, row.order_id),
        deps.commissionSplit(appId, row.order_id),
        row.link_id === null
          ? Promise.resolve([])
          : deps.linkLogs(appId, row.link_id, LINK_LOG_LIMIT),
        deps.creditEnabled(appId, row.platform),
        row.user_id === null || deps.figures === undefined
          ? Promise.resolve(new Map<string, OrderFigures>())
          : deps.figures.forOrders({ app_id: appId, user_id: row.user_id }, [row.order_id]),
      ]);
    // 方案 K-7: a current system hold shows no manual hold, so its operator is not looked up.
    const shownAudit = holdReason === 'UNMAPPED_STATUS' ? null : audit;
    const names =
      shownAudit === null
        ? new Map<string, string>()
        : await deps.adminNames(appId, [shownAudit.admin_id]);
    return {
      ...listItem(row, phones),
      raw_item_id: row.raw_item_id,
      product_key: row.product_key,
      quantity: row.quantity,
      refunded_quantity: row.refunded_quantity,
      display_status: displayStatus(row, creditEnabled, figures.get(row.order_id)),
      reason: row.reason as Detail['reason'],
      ...reasonSubOf(row),
      buy_type: row.buy_type as Detail['buy_type'],
      scene_basis: row.scene_basis as Detail['scene_basis'],
      user_basis: row.user_basis as Detail['user_basis'],
      is_presale: row.is_presale,
      deposit_paid_at: iso(row.deposit_paid_at),
      received_at: iso(row.received_at),
      settled_at: iso(row.settled_at),
      credited_at: iso(row.credited_at),
      settle_period: row.settle_period,
      commission_rate_bp: row.commission_rate_bp,
      row_version: row.row_version,
      unmapped_pending_open: unmappedPendingOpen(holdReason, pending),
      ...lastManualHold(
        holdReason,
        shownAudit,
        shownAudit === null ? null : (names.get(shownAudit.admin_id) ?? null),
      ),
      status_history: history.map((entry) => ({
        field: entry.field as Schema<'AdminOrderHistoryField'>,
        from: entry.from_status as Schema<'AdminOrderStatusHistoryEntry'>['from'],
        to: entry.to_status as Schema<'AdminOrderStatusHistoryEntry'>['to'],
        event: entry.event,
        source: entry.source as Schema<'AdminOrderHistorySource'>,
        at: entry.at.toISOString(),
      })),
      commission_split: split === null ? null : commissionSplit(split),
      link_logs: links
        .filter(
          (log): log is AdminOrderLinkRecord & { scene: string } =>
            LINK_EVENTS.has(log.event) && log.scene !== null && LINK_SCENES.has(log.scene),
        )
        .slice(0, LINK_LOG_LIMIT)
        .map((log) => ({
          at: log.at.toISOString(),
          event: log.event as Schema<'AdminOrderLinkEvent'>,
          scene: log.scene as Schema<'AdminOrderLinkScene'>,
        })),
    };
  }

  private async phonesOf(
    deps: AdminOrdersDeps,
    appId: string,
    rows: readonly AdminOrderRow[],
  ): Promise<ReadonlyMap<string, string | null>> {
    const userIds = [
      ...new Set(rows.flatMap((row) => (row.user_id === null ? [] : [row.user_id]))),
    ];
    return userIds.length === 0 ? new Map() : deps.phones(appId, userIds);
  }

  private available(): AdminOrdersDeps {
    if (this.#deps === null) throw new Error('orders: admin order reads need the database');
    return this.#deps;
  }
}

function listItem(row: AdminOrderRow, phones: ReadonlyMap<string, string | null>): ListItem {
  return {
    order_id: row.order_id,
    sub_order_id: row.sub_order_id,
    parent_order_id: row.parent_order_id,
    platform: row.platform as Schema<'PlatformCode'>,
    title: row.title,
    image_url: row.image_url,
    user:
      row.user_id === null
        ? null
        : { user_id: row.user_id, phone_masked: phones.get(row.user_id) ?? null },
    paid_at: iso(row.paid_at),
    pay_amount_fen: fen(row.pay_amount_fen),
    est_commission_fen: fen(row.est_commission_fen),
    settle_commission_fen: fen(row.settle_commission_fen),
    platform_status: row.platform_status as Schema<'AdminOrderPlatformStatus'>,
    rebate_status: row.rebate_status as Schema<'AdminOrderRebateStatus'>,
    hold_reason: holdReasonOf(row) as ListItem['hold_reason'],
    flags: adminOrderFlags(row),
  };
}

/** BR-FUND-17 over the order's columns and its owner's figures (none on an ownerless order). */
function displayStatus(
  row: AdminOrderDetailRow,
  creditEnabled: boolean,
  figures: OrderFigures | undefined,
): Detail['display_status'] {
  return deriveDisplayStatus({
    rebate_status: row.rebate_status as DisplayStatusInput['rebate_status'],
    platform_status: row.platform_status as DisplayStatusInput['platform_status'],
    hold: row.hold,
    rights_pending: row.rights_pending,
    booked_base_fen: row.booked_base_fen,
    b_est: figures?.b_est ?? null,
    has_clawback: figures?.has_clawback ?? false,
    viewer_share_held: figures?.viewer_share_held ?? false,
    credit_enabled: creditEnabled,
    credit_overdue: figures?.credit_overdue ?? false,
  });
}

/** The snapshot with its beneficiaries cut to user_id, role, ratio_bp and forfeit_reason. */
function commissionSplit(split: AdminOrderSplitRecord): Schema<'AdminOrderCommissionSplit'> {
  const stored: unknown =
    typeof split.beneficiaries === 'string' ? JSON.parse(split.beneficiaries) : split.beneficiaries;
  if (!Array.isArray(stored)) {
    throw new Error('orders: commission snapshot beneficiaries are not an array');
  }
  const beneficiaries = stored.map((entry: unknown): Schema<'AdminOrderBeneficiary'> => {
    if (entry === null || typeof entry !== 'object') {
      throw new Error('orders: commission snapshot beneficiary is not an object');
    }
    const value = entry as Record<string, unknown>;
    const { user_id: userId, role, ratio_bp: ratio } = value;
    const forfeit = value.forfeit_reason ?? null;
    if (
      typeof userId !== 'string' ||
      typeof role !== 'string' ||
      !ROLES.has(role) ||
      typeof ratio !== 'number' ||
      !Number.isInteger(ratio) ||
      (forfeit !== null && (typeof forfeit !== 'string' || !FORFEIT_REASONS.has(forfeit)))
    ) {
      throw new Error('orders: commission snapshot beneficiary outside the contract');
    }
    return {
      user_id: userId,
      role: role as Schema<'AdminOrderBeneficiaryRole'>,
      ratio_bp: ratio,
      forfeit_reason: forfeit as Schema<'AdminOrderBeneficiary'>['forfeit_reason'],
    };
  });
  return {
    rule_version_id: split.rule_version_id,
    order_type: split.order_type as Schema<'AdminOrderBuyType'>,
    raw_n_fen: fenToJsonNumber(split.raw_n_fen),
    subsidy_commission_fen: fenToJsonNumber(split.subsidy_commission_fen),
    reserve_bp: split.reserve_bp,
    reserve_fen: fenToJsonNumber(split.reserve_fen),
    tlj_deduct_fen: fenToJsonNumber(split.tlj_deduct_fen),
    base_fen: fenToJsonNumber(split.base_fen),
    platform_retain_fen: fenToJsonNumber(split.platform_retain_fen),
    beneficiaries,
    created_at: split.created_at.toISOString(),
  };
}
