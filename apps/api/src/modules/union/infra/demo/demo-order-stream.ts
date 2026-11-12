// QA-03a: the demo adapter's synthetic order stream (规划/11 §4.5 没有真实录制时). Every row is the
// unified domain DTO of domain/types.ts built from explicit in-process DemoOrderSeed inputs; no
// upstream field name, signature, payload or error code is imitated, and nothing here is AC-ORD
// or capability evidence. Only DemoUnionAdapter (non-prod by construction) reads it; the registry
// never passes a stream, so production wiring and assembled demo endpoints keep listOrders
// adapter_unimplemented (D10-1417).
import { createHash } from 'node:crypto';
import { mulDivFloor } from '@couli/money';
import {
  UnionError,
  type ItemRef,
  type OrderPage,
  type OrderQueryOpt,
  type RegisteredPlatform,
  type TimeWindow,
  type UnionOrder,
  type UnionOrderAttrParams,
} from '../../domain/types.ts';

/** Synthetic domain inputs only; never platform payloads or production configuration. */
export interface DemoOrderSeed {
  readonly key: string;
  readonly appId: string;
  readonly item: ItemRef;
  readonly promotionSlot: string;
  readonly attrParams: UnionOrderAttrParams;
  readonly paidAt: string;
  readonly receivedAt: string;
  readonly refundedAt: string | null;
}

/**
 * Optional demo constructor input. IDs and integer-fen amounts derive from seed + app + key.
 * listOrders emits immutable event versions in [from,to), gated by the injected Clock, sorted
 * by modified_at then key. Repeating a window, including after restart, reproduces its DTOs.
 * Synthetic raw_status labels: demo:paid, demo:received, demo:refunded. Refund means full
 * invalidation; no API settlement is asserted. received_at stays the supplied receivedAt;
 * settle_commission_fen / settled_at remain null. An omitted stream keeps adapter_unimplemented;
 * an explicitly empty stream returns an empty page, with one outer quota charge per call.
 * This is an explicit in-process demo fixture, never a new environment variable or HTTP input.
 */
export interface DemoOrderStreamOptions {
  readonly orderStream: readonly DemoOrderSeed[];
}

/** Synthetic event labels (never a platform status code); the status map is the caller's. */
export const DEMO_ORDER_STATUSES = Object.freeze({
  paid: 'demo:paid',
  received: 'demo:received',
  refunded: 'demo:refunded',
} as const);

export const DEMO_ORDER_PAGE_SIZE = 20;

const BP = 10_000n;
/** Synthetic paid amounts are PAID_CEILING_FEN scaled by a seeded 1 000–10 000 bp ratio. */
const PAID_CEILING_FEN = 49_900n;
/** Explicit offset required (Z or ±hh:mm): a seed or window never depends on the host zone. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const ITEM_FIELDS = ['item_id', 'itemId', 'skuId', 'goods_id', 'goods_sign'] as const;
const ATTR_FIELDS = ['relation_id', 'custom_parameters', 'sub_union_id'] as const;
const CURSOR = /^demo-orders-([1-9][0-9]{0,5})-([0-9a-f]{12})$/;

interface DemoOrderEvent {
  readonly status: string;
  readonly atMs: number;
}

/** One validated seed with its derived identifiers and amounts. */
interface DemoOrderEntry {
  readonly key: string;
  readonly appId: string;
  readonly subOrderId: string;
  readonly item: ItemRef;
  readonly promotionSlot: string;
  readonly attrParams: UnionOrderAttrParams;
  readonly paidMs: number;
  readonly receivedMs: number;
  readonly paidFen: bigint;
  readonly commissionFen: bigint;
  /** paid, received and (when refundedAt is set) refunded, strictly increasing in time. */
  readonly events: readonly DemoOrderEvent[];
}

type StreamBasis = 'modified' | 'paid' | 'none';

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');
}

function seededBp(hex: string, lowBp: bigint, span: bigint): bigint {
  return lowBp + (BigInt(`0x${hex}`) % span);
}

function filled(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** A Date at `ms`, cloned from the injected clock's reading (no Date construction here). */
function at(like: Date, ms: number): Date {
  const result = structuredClone(like);
  result.setTime(ms);
  return result;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class DemoOrderStream {
  readonly #platform: RegisteredPlatform;
  readonly #seed: string;
  readonly #entries: readonly DemoOrderEntry[];

  constructor(platform: RegisteredPlatform, seed: string, inputs: readonly DemoOrderSeed[]) {
    this.#platform = platform;
    this.#seed = seed;
    if (!Array.isArray(inputs)) throw this.#invalid('orderStream must be an array');
    const seen = new Set<string>();
    this.#entries = Object.freeze(
      inputs.map((input) => {
        const entry = this.#entry(input);
        const unique = `${entry.appId}\u0000${entry.key}`;
        if (seen.has(unique)) throw this.#invalid('order keys must be unique within an app');
        seen.add(unique);
        return entry;
      }),
    );
  }

  /**
   * One page of the app's synthetic rows. Increment (default): every event version whose time is
   * in [from, to) and not after `nowMs`. PDD pay_time and Taobao pay / create: the latest visible
   * version of each order paid in [from, to). Taobao settle: none (the stream never settles).
   * `now` is the injected Clock's reading.
   */
  list(win: TimeWindow, opt: OrderQueryOpt, appId: string, now: Date): OrderPage {
    if (typeof win !== 'object' || win === null) throw this.#invalid('window missing');
    const fromMs = this.#instant(win.from, 'window from');
    const toMs = this.#instant(win.to, 'window to');
    if (toMs <= fromMs) throw this.#invalid('window must end after it starts');
    const options: OrderQueryOpt = typeof opt === 'object' && opt !== null ? opt : {};
    const basis = this.#basis(options);
    const rows =
      filled(appId) && basis !== 'none' ? this.#rows(basis, appId, fromMs, toMs, now) : [];
    const tag = digest([
      'demo-order-cursor',
      this.#platform,
      this.#seed,
      appId,
      String(fromMs),
      String(toMs),
      basis,
    ]).slice(0, 12);
    let offset = 0;
    if (options.cursor !== undefined) {
      const match = typeof options.cursor === 'string' ? CURSOR.exec(options.cursor) : null;
      offset = match === null || match[2] !== tag ? -1 : Number(match[1]);
      if (offset <= 0 || offset >= rows.length) throw this.#invalid('unknown cursor');
    }
    const next = offset + DEMO_ORDER_PAGE_SIZE;
    return Object.freeze({
      items: Object.freeze(rows.slice(offset, next)),
      nextCursor: next < rows.length ? `demo-orders-${String(next)}-${tag}` : null,
    });
  }

  #basis(opt: OrderQueryOpt): StreamBasis {
    if (this.#platform === 'pdd' && opt.queryMode === 'pay_time') return 'paid';
    if (this.#platform === 'taobao') {
      if (opt.timeBasis === 'settle') return 'none';
      if (opt.timeBasis === 'pay' || opt.timeBasis === 'create') return 'paid';
    }
    return 'modified';
  }

  #rows(
    basis: Exclude<StreamBasis, 'none'>,
    appId: string,
    fromMs: number,
    toMs: number,
    now: Date,
  ): readonly UnionOrder[] {
    const nowMs = now.getTime();
    const picked: { entry: DemoOrderEntry; event: DemoOrderEvent; rank: number }[] = [];
    for (const entry of this.#entries) {
      if (entry.appId !== appId) continue;
      if (basis === 'modified') {
        entry.events.forEach((event, rank) => {
          if (event.atMs >= fromMs && event.atMs < toMs && event.atMs <= nowMs) {
            picked.push({ entry, event, rank });
          }
        });
        continue;
      }
      if (entry.paidMs < fromMs || entry.paidMs >= toMs || entry.paidMs > nowMs) continue;
      const visible = entry.events.filter((event) => event.atMs <= nowMs);
      const rank = visible.length - 1;
      picked.push({ entry, event: visible[rank]!, rank });
    }
    const sortMs = (row: (typeof picked)[number]) =>
      basis === 'modified' ? row.event.atMs : row.entry.paidMs;
    picked.sort(
      (a, b) => sortMs(a) - sortMs(b) || compareText(a.entry.key, b.entry.key) || a.rank - b.rank,
    );
    return picked.map(({ entry, event }) => this.#row(entry, event, now));
  }

  #row(entry: DemoOrderEntry, event: DemoOrderEvent, now: Date): UnionOrder {
    return Object.freeze({
      ...entry.item,
      order_id: entry.subOrderId,
      paid_fen: entry.paidFen,
      commission_fen: entry.commissionFen,
      // Synthetic PDD rows state a known zero software service fee (never a guessed fee).
      ...(this.#platform === 'pdd' ? { service_fee_fen: 0n } : {}),
      sub_order_id: entry.subOrderId,
      parent_order_id: null,
      promotion_slot: entry.promotionSlot,
      attr_params: entry.attrParams,
      raw_status: event.status,
      deposit_paid_at: null,
      paid_at: at(now, entry.paidMs),
      // BR-FUND-02: the receipt time is the supplied event time, from the receipt version on.
      received_at: event.atMs >= entry.receivedMs ? at(now, entry.receivedMs) : null,
      settled_at: null,
      modified_at: at(now, event.atMs),
      // Same amounts on every version: full invalidation is carried by the status alone.
      est_commission_fen: entry.commissionFen,
      settle_commission_fen: null,
      raw_payload_id: null,
    });
  }

  #entry(input: DemoOrderSeed): DemoOrderEntry {
    if (typeof input !== 'object' || input === null) throw this.#invalid('order seed missing');
    if (!filled(input.key)) throw this.#invalid('order key must be a non-empty string');
    if (!filled(input.appId)) throw this.#invalid('order appId must be a non-empty string');
    if (!filled(input.promotionSlot)) throw this.#invalid('promotionSlot must be non-empty');
    const item = this.#item(input.item);
    const attrParams = this.#attrParams(input.attrParams);
    const paidMs = this.#instant(input.paidAt, 'paidAt');
    const receivedMs = this.#instant(input.receivedAt, 'receivedAt');
    if (receivedMs <= paidMs) throw this.#invalid('receivedAt must be after paidAt');
    const events: DemoOrderEvent[] = [
      { status: DEMO_ORDER_STATUSES.paid, atMs: paidMs },
      { status: DEMO_ORDER_STATUSES.received, atMs: receivedMs },
    ];
    if (input.refundedAt !== null) {
      const refundedMs = this.#instant(input.refundedAt, 'refundedAt');
      if (refundedMs <= receivedMs) throw this.#invalid('refundedAt must be after receivedAt');
      events.push({ status: DEMO_ORDER_STATUSES.refunded, atMs: refundedMs });
    }
    const hash = digest(['demo-order', this.#platform, this.#seed, input.appId, input.key]);
    // Amounts only through @couli/money; the seed picks ratios. Commission 5%–30% of paid.
    const paidFen = mulDivFloor(PAID_CEILING_FEN, seededBp(hash.slice(24, 32), 1_000n, 9_001n), BP);
    const commissionFen = mulDivFloor(paidFen, seededBp(hash.slice(32, 40), 500n, 2_501n), BP);
    return Object.freeze({
      key: input.key,
      appId: input.appId,
      subOrderId: `demo-order-${hash.slice(0, 24)}`,
      item,
      promotionSlot: input.promotionSlot,
      attrParams,
      paidMs,
      receivedMs,
      paidFen,
      commissionFen,
      events: Object.freeze(events.map((event) => Object.freeze(event))),
    });
  }

  /** The seed's item identifiers only (no other keys), on this adapter's platform. */
  #item(ref: ItemRef): ItemRef {
    if (typeof ref !== 'object' || ref === null || ref.platform !== this.#platform) {
      throw this.#invalid('order item must be an item of this platform');
    }
    const item: Record<string, string> = {};
    for (const field of ITEM_FIELDS) {
      const value = ref[field];
      if (value === undefined || value === null) continue;
      if (!filled(value)) throw this.#invalid(`order item ${field} must be a non-empty string`);
      item[field] = value;
    }
    if (Object.keys(item).length === 0) throw this.#invalid('order item has no identifier');
    return Object.freeze({ platform: this.#platform, ...item });
  }

  #attrParams(params: UnionOrderAttrParams): UnionOrderAttrParams {
    if (typeof params !== 'object' || params === null) throw this.#invalid('attrParams missing');
    for (const field of ATTR_FIELDS) {
      const value: unknown = params[field];
      if (value !== null && typeof value !== 'string') {
        throw this.#invalid(`attrParams.${field} must be a string or null`);
      }
    }
    return Object.freeze({
      relation_id: params.relation_id,
      custom_parameters: params.custom_parameters,
      sub_union_id: params.sub_union_id,
    });
  }

  #instant(value: unknown, name: string): number {
    const ms = typeof value === 'string' && INSTANT.test(value) ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(ms)) {
      throw this.#invalid(`${name} must be an ISO instant with an explicit offset`);
    }
    return ms;
  }

  #invalid(message: string): UnionError {
    return new UnionError('invalid_dto', `Demo ${this.#platform}: ${message}`, this.#platform);
  }
}
