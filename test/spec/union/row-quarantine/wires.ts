// B1-04zv: the three real order adapters over fake transports, one shape for the rule tests. Rows
// come from the merged kits, every value synthetic. `rowErrors` and `rejected` are not declared
// before the implementation: `collecting` is a cast and CollectPage an intersection, so the missing
// option stays a red on a result, not a type error. Every listOrders call goes through `resolved`
// or `refused`: before the implementation a bad row escapes as a UnionError, and that has to be an
// assertion failure here.
import { expect } from 'vitest';
import {
  UnionError,
  type CallCtx,
  type Page,
  type TimeWindow,
  type UnionAdapter,
  type UnionOrder,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  ctx as jdCtx,
  inner,
  num as jdNum,
  reply as jdReply,
  row as jdRow,
  rowId,
  win as jdWin,
  wire,
} from '../jd-orders/kit.ts';
import { pdd, reply as pddReply } from '../orders-shape/kit.ts';
import { ctx as pddCtx, row as pddRow, win as pddWin } from '../pdd-orders/kit.ts';
import {
  ctx as taobaoCtx,
  pageData,
  reply as taobaoReply,
  row as taobaoRow,
  rowOf,
  setup as taobaoSetup,
  TRADE_PARENT_ID,
  win as taobaoWin,
} from '../taobao-orders/kit.ts';

/**
 * The call context orders' fetchWindow passes: the switch is CallCtx.rowErrors, listOrders' third
 * argument, and the query options stay as they are (frozen jd-live/narrow.test.ts pins them).
 */
function collecting(ctx: CallCtx): CallCtx {
  return { ...ctx, rowErrors: 'collect' } as CallCtx;
}

/** One row refused while the rest of the page goes on (task brief). */
export interface RejectedRow {
  readonly sub_order_id: string | null;
  readonly raw_status: string | null;
  readonly raw_payload_id: string | null;
  readonly detail: string;
}

export type CollectPage = Page<UnionOrder> & { readonly rejected?: readonly RejectedRow[] };

/** A value no mapper can read as an amount, and that must never reach `detail`. */
export const BAD_AMOUNT = 'rq-bad-amount-2718';

/**
 * `field` as a whole name in a text. A plain substring is not enough: jd's `id` is inside "invalid",
 * and taobao's pub_share_fee must not pass on pub_share_pre_fee.
 */
export function fieldNamed(field: string): RegExp {
  return new RegExp(`\\b${field}\\b`);
}

export interface PageShape {
  /** What the archiving transport leaves on the response. */
  readonly payloadId?: string;
  /** Another upstream page follows this one. */
  readonly more?: boolean;
}

export interface Wire {
  readonly name: 'jd' | 'pdd' | 'taobao';
  readonly win: TimeWindow;
  readonly ctx: CallCtx;
  /** `ctx` with rowErrors switched on. */
  readonly collect: CallCtx;
  /** raw_status of `good` and `bad` rows, as the mapper would give it. */
  readonly rawStatus: string;
  /** The field `bad` breaks and the field `nameless` leaves out. */
  readonly brokenField: string;
  readonly idField: string;
  /** Texts of a default row that must not appear in `detail`: amounts and other order numbers. */
  readonly privateValues: readonly string[];
  idOf(index: number): string;
  good(index: number): Record<string, unknown>;
  bad(index: number): Record<string, unknown>;
  nameless(): Record<string, unknown>;
  adapter(rows: readonly unknown[], page?: PageShape): Pick<UnionAdapter, 'listOrders'>;
}

const jdIdOf = (index: number): string => rowId(7, index);

/** A finished jd row (17): the mapper reads actualFee and actualCosPrice, not the estimates. */
export function jdFinished(index: number): Record<string, unknown> {
  return jdRow({
    id: jdIdOf(index),
    validCode: jdNum('17'),
    actualFee: jdNum('1.23'),
    actualCosPrice: jdNum('45.60'),
  });
}

export const JD: Wire = {
  name: 'jd',
  win: jdWin,
  ctx: jdCtx,
  collect: collecting(jdCtx),
  rawStatus: '16',
  brokenField: 'estimateFee',
  idField: 'id',
  privateValues: ['3123456789012345', '45.60', '1.23'],
  idOf: jdIdOf,
  good: (index) => jdRow({ id: jdIdOf(index) }),
  bad: (index) => jdRow({ id: jdIdOf(index), estimateFee: BAD_AMOUNT }),
  nameless: () => jdRow({ id: undefined }),
  adapter: (rows, page = {}) =>
    wire(() => jdReply(inner(rows, page.more ?? false), page.payloadId)).adapter,
};

const pddIdOf = (index: number): string => `rq-pdd-order-${index}`;
const PDD_PAGE_SIZE = 50;
const pddFiller = Array.from({ length: PDD_PAGE_SIZE }, (_, i) =>
  pddRow({ order_sn: `rq-pdd-filler-${i}` }),
);

/** `more`: a full first page before `rows`, so `rows` is the tail page the first call returns. */
function pddAdapter(rows: readonly unknown[], page: PageShape = {}) {
  const dataset = page.more === true ? [...pddFiller, ...rows] : [...rows];
  return pdd(async (request) => {
    const parameters = JSON.parse(request.body!) as { page?: number };
    const index = parameters.page ?? 1;
    const order_list = dataset.slice((index - 1) * PDD_PAGE_SIZE, index * PDD_PAGE_SIZE);
    return pddReply({ order_list_get_response: { order_list } }, page.payloadId);
  });
}

export const PDD: Wire = {
  name: 'pdd',
  win: pddWin,
  ctx: pddCtx,
  collect: collecting(pddCtx),
  rawStatus: '4',
  brokenField: 'order_amount',
  idField: 'order_sn',
  privateValues: ['8765432', '76543', '000000000000000000000000099999-SYN'],
  idOf: pddIdOf,
  good: (index) => pddRow({ order_sn: pddIdOf(index) }),
  bad: (index) => pddRow({ order_sn: pddIdOf(index), order_amount: BAD_AMOUNT }),
  nameless: () => pddRow({ order_sn: undefined }),
  adapter: pddAdapter,
};

export const TAOBAO: Wire = {
  name: 'taobao',
  win: taobaoWin,
  ctx: taobaoCtx,
  collect: collecting(taobaoCtx),
  rawStatus: '3',
  brokenField: 'alipay_total_price',
  idField: 'trade_id',
  privateValues: ['88.80', '7.99', TRADE_PARENT_ID],
  idOf: (index) => String(rowOf(index).trade_id),
  // B1-04zz：已结算行的结算额读 pub_share_fee_for_commission，kit 的默认行没有；7.66 − 结算服务费 1.00 = 666。
  good: (index) => ({ ...rowOf(index), pub_share_fee_for_commission: '7.66' }),
  bad: (index) => ({ ...rowOf(index), alipay_total_price: BAD_AMOUNT }),
  nameless: () => taobaoRow({ trade_id: undefined }),
  adapter: (rows, page = {}) =>
    taobaoSetup(() =>
      taobaoReply(
        pageData(rows, { hasNext: page.more ?? false, position: 'rq-position-1' }),
        page.payloadId,
      ),
    ).adapter,
};

export const WIRES: readonly Wire[] = [JD, PDD, TAOBAO];

type Outcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

async function outcome<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** The page a call resolves to; a rejection fails the test as an assertion. */
export async function resolved(run: () => Promise<Page<UnionOrder>>): Promise<CollectPage> {
  const result = await outcome(run);
  expect(result, 'listOrders must resolve').toMatchObject({ ok: true });
  if (!result.ok) throw result.error;
  return result.value as CollectPage;
}

/** The UnionError a call rejects with; resolving fails the test as an assertion. */
export async function refused(run: () => Promise<unknown>): Promise<UnionError> {
  const result = await outcome(run);
  expect(result.ok, 'listOrders must reject').toBe(false);
  const error = result.ok ? undefined : result.error;
  expect(error).toBeInstanceOf(UnionError);
  return error as UnionError;
}

export function rejectedOf(page: CollectPage): readonly RejectedRow[] {
  return page.rejected ?? [];
}

/** A row-level failure is really isolated on this wire: what the "still throws" cases stand on. */
export async function expectCollecting(w: Wire): Promise<void> {
  const page = await resolved(() =>
    w.adapter([w.good(1), w.bad(2), w.good(3)]).listOrders(w.win, {}, w.collect),
  );
  expect(page.items).toHaveLength(2);
  expect(rejectedOf(page)).toHaveLength(1);
}
