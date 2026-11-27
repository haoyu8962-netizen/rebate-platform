import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { BASE_URL, failure, ok } from '../admin-claims/claims-fixtures.ts';
import type { RequestLog } from '../admin-kill-switches/fixtures.ts';

export { BASE_URL, failure, ok };
export type Row = Schema<'AdminOrderListItem'>;
export type Detail = Schema<'AdminOrderDetail'>;
export const LIST = '/admin/v1/orders';
export const OID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a01';
export const UID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';
export const BENEFICIARY = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c09';
export const RULE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5d01';
export const NUMBER = '231006-1234567891';
export const PARENT = '231006-1234567890';
export const DETAIL = `${LIST}/${OID}`;
export const ROUTE = `/orders/${OID}`;
/** The list page's sync status bar reads the latest record here (F1-07edb; CT-11bvc, D10-3642). */
export const SYNCS_LATEST = '/admin/v1/order-syncs';

/** One finished sync record (values as the admin-orders-sync samples), so the bar shows its normal state. */
function latestSync(): Schema<'AdminOrderSyncPage'> {
  return {
    items: [
      {
        sync_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6b03',
        platform: 'pdd',
        mode: 'order_nos',
        from: null,
        to: null,
        status_filter: null,
        order_nos: ['231012-4440000001'],
        status: 'done',
        requested_by: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a0a',
        requested_by_name: '运营甲',
        fetched_count: 1,
        stored_count: 1,
        created_at: '2026-10-22T10:05:00+08:00',
        finished_at: '2026-10-22T10:05:09+08:00',
      },
    ],
    page: 1,
    page_size: 1,
    total: 1,
  };
}

/** Synthetic contract fixtures, never a real union recording. Already in server payment order. */
export function rows(): Row[] {
  return [
    {
      order_id: OID,
      sub_order_id: NUMBER,
      parent_order_id: PARENT,
      platform: 'pdd',
      title: '抽纸 3 层 120 抽 24 包',
      image_url: null,
      user: { user_id: UID, phone_masked: '138****5678' },
      paid_at: '2026-10-06T17:05:12Z',
      pay_amount_fen: 1234567,
      est_commission_fen: 123456,
      settle_commission_fen: 112345,
      platform_status: 'SETTLED',
      rebate_status: 'CREDITED',
      hold_reason: null,
      flags: { locked: true, status_locked: true, rights_pending: false, hold: false },
    },
    {
      order_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a02',
      sub_order_id: '231005-0987654322',
      parent_order_id: null,
      platform: 'taobao',
      title: null,
      image_url: null,
      user: null,
      paid_at: '2026-10-05T21:12:03+08:00',
      pay_amount_fen: 0,
      est_commission_fen: 0,
      settle_commission_fen: null,
      platform_status: 'RECEIVED',
      rebate_status: 'UNATTRIBUTED',
      hold_reason: null,
      flags: { locked: false, status_locked: false, rights_pending: false, hold: false },
    },
    {
      order_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a03',
      sub_order_id: '231004-2234567891',
      parent_order_id: null,
      platform: 'jd',
      title: '保温杯',
      image_url: null,
      user: { user_id: UID, phone_masked: null },
      paid_at: null,
      pay_amount_fen: null,
      est_commission_fen: null,
      settle_commission_fen: null,
      platform_status: 'PAID',
      rebate_status: 'ESTIMATED',
      hold_reason: 'CS',
      flags: { locked: false, status_locked: false, rights_pending: true, hold: true },
    },
  ];
}
/**
 * Detail fields added by CT-24n (unmapped hold still pending, latest manual hold). Kept in a
 * constant and spread so the fixture type-checks both before and after those fields exist.
 */
const ORDER_HOLD_DEFAULTS = {
  unmapped_pending_open: false,
  last_hold_by: null,
  last_hold_by_name: null,
  last_hold_note: null,
  last_hold_at: null,
};
export function detail(patch: Partial<Detail> = {}): Detail {
  return {
    ...rows()[0]!,
    ...ORDER_HOLD_DEFAULTS,
    raw_item_id: '61234',
    product_key: null,
    quantity: 3,
    refunded_quantity: 1,
    display_status: 'CREDITED',
    reason: null,
    buy_type: 'self',
    scene_basis: 'param',
    user_basis: 'claim',
    is_presale: false,
    deposit_paid_at: null,
    received_at: '2026-10-09T02:15:00Z',
    settled_at: '2026-10-12T03:15:00Z',
    credited_at: '2026-10-15T04:15:00Z',
    settle_period: '2026-11',
    commission_rate_bp: 1250,
    row_version: 7,
    status_history: [
      {
        field: 'platform',
        from: null,
        to: 'PAID',
        event: 'P2',
        source: 'sync',
        at: '2026-10-07T01:06:00+08:00',
      },
      {
        field: 'rebate',
        from: 'UNATTRIBUTED',
        to: 'ESTIMATED',
        event: 'R3',
        source: 'claim',
        at: '2026-10-08T09:30:00+08:00',
      },
      {
        field: 'rebate',
        from: 'WAITING',
        to: 'CREDITED',
        event: 'R5',
        source: 'system',
        at: '2026-10-15T12:15:00+08:00',
      },
    ],
    commission_split: {
      rule_version_id: RULE,
      order_type: 'self',
      raw_n_fen: 123456,
      subsidy_commission_fen: 101,
      reserve_bp: 1234,
      reserve_fen: 15234,
      tlj_deduct_fen: 102,
      base_fen: 108221,
      platform_retain_fen: 32467,
      beneficiaries: [
        { user_id: UID, role: 'self', ratio_bp: 6000, forfeit_reason: null },
        { user_id: BENEFICIARY, role: 'direct', ratio_bp: 1000, forfeit_reason: 'banned' },
      ],
      created_at: '2026-10-08T09:30:00+08:00',
    },
    link_logs: [
      { at: '2026-10-07T01:04:02+08:00', event: 'open', scene: 'detail' },
      { at: '2026-10-07T01:03:48+08:00', event: 'convert', scene: 'search' },
    ],
    ...patch,
  };
}
export function manyRows(): Row[] {
  return Array.from({ length: 205 }, (_, index) => ({
    ...rows()[0]!,
    order_id:
      index === 0 ? OID : `0199a3b4-5c6d-7e8f-9a0b-${String(index + 100).padStart(12, '0')}`,
    sub_order_id: index === 0 ? NUMBER : `231006-${9000000000 + index}`,
  }));
}
type Reply = (request: RequestLog) => Response | Promise<Response>;
export function createServer(initial = rows(), initialDetail = detail()) {
  const state = { items: structuredClone(initial), detail: structuredClone(initialDetail) };
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  let pending = 0;
  function normal(request: RequestLog): Response {
    const { method, path, query } = request;
    if (method === 'GET' && path === LIST) {
      const page = Number(query['page']);
      const size = Number(query['page_size']);
      if (
        !Number.isInteger(page) ||
        page < 1 ||
        !Number.isInteger(size) ||
        size < 1 ||
        size > 200 ||
        Object.keys(query).some(
          (key) =>
            ![
              'page',
              'page_size',
              'platform',
              'platform_status',
              'rebate_status',
              'flag',
              'q',
              'user_id',
              'paid_from',
              'paid_to',
            ].includes(key),
        )
      )
        return failure(20001, { fields: ['page_size'] });
      const q = query['q']?.replace(/\s/g, '');
      const items = state.items.filter(
        (row) =>
          (!query['platform'] || row.platform === query['platform']) &&
          (!query['platform_status'] || row.platform_status === query['platform_status']) &&
          (!query['rebate_status'] || row.rebate_status === query['rebate_status']) &&
          (!query['flag'] || row.flags[query['flag'] as keyof Row['flags']]) &&
          (!query['user_id'] || row.user?.user_id === query['user_id']) &&
          (!q || row.sub_order_id === q || row.parent_order_id === q) &&
          (!query['paid_from'] ||
            (row.paid_at !== null && Date.parse(row.paid_at) >= Date.parse(query['paid_from']))) &&
          (!query['paid_to'] ||
            (row.paid_at !== null && Date.parse(row.paid_at) < Date.parse(query['paid_to']))),
      );
      return ok({
        items: items.slice((page - 1) * size, page * size),
        page,
        page_size: size,
        total: items.length,
      } satisfies Schema<'AdminOrderPage'>);
    }
    if (method === 'GET' && path === DETAIL) return ok(state.detail);
    if (method === 'GET' && path === SYNCS_LATEST) return ok(latestSync());
    return failure(20001, { fields: [method === 'GET' ? 'order_id' : 'unexpected_write'] });
  }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const request: RequestLog = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    log.push(request);
    pending += 1;
    try {
      const index = overrides.findIndex(
        (entry) => entry.method === request.method && entry.path === request.path,
      );
      return await (index < 0 ? normal(request) : overrides.splice(index, 1)[0]!.reply(request));
    } finally {
      pending -= 1;
    }
  };
  return {
    state,
    log,
    fetch,
    get pending() {
      return pending;
    },
    requests(method: string, path?: string) {
      return log.filter(
        (request) => request.method === method && (path === undefined || request.path === path),
      );
    },
    once(method: string, path: string, reply: Reply) {
      overrides.push({ method, path, reply });
    },
    hold(method: string, path: string, reply: Reply = normal) {
      const gate = Promise.withResolvers<void>();
      overrides.push({
        method,
        path,
        reply: async (request) => {
          await gate.promise;
          return reply(request);
        },
      });
      return gate.resolve;
    },
  };
}
export type Server = ReturnType<typeof createServer>;
