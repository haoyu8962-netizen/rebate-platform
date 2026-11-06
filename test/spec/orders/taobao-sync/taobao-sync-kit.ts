// B1-04zzb rule-test kit: Taobao in the order sync (CAP-TB-07 code part, D10-588 ③④, D10-741).
// Values pinned by the brief: tk_status 12 / 14 / 3 / 13 in specs/order-status-map/taobao.csv
// (source doc, verified false; 11 is only a request value), increment window ≤ 20 minutes
// (02 §7.1), order query look-back 90 days (CAP-TB-07), rescan one tier of 30 days (rescanDefaults,
// no order_sync.rescan.taobao.* key registered). Orders come from the real TaobaoUnionAdapter over a
// fake transport (test/spec/union/taobao-orders/kit.ts): every row is synthetic, no network.
import { expect } from 'vitest';
import type { OrderSyncSchedulerDeps } from '../../../../apps/api/src/modules/orders/application/sync-scheduler.ts';
import type {
  OrderRescanWindow,
  OrderSyncWindow,
  RescanStream,
  SyncAccount,
  SyncStream,
} from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';
import {
  loadStatusMap,
  type StatusMap,
} from '../../../../apps/api/src/modules/orders/domain/status-map.ts';
import type {
  RegisteredPlatform,
  UnionOrder,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import { readStatusCsv } from '../status-map/fixtures.ts';
import {
  ACCOUNT,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  NOW_MS,
  PDD_ACCOUNT,
  TAOBAO_ACCOUNT,
  account,
  fixture,
  iso,
  pddAccount,
  stream,
} from '../rescan/kit.ts';
import { ctx, listed, num, onePage, row, setup } from '../../union/taobao-orders/kit.ts';

export { DAY_MS, HOUR_MS, MINUTE_MS, NOW_MS, iso };

/** 02 §7.1: Taobao increment windows are at most 20 minutes (大促上限). */
export const TAOBAO_CAP_MS = 20 * MINUTE_MS;
/** CAP-TB-07: a query start must lie within the last 90 days. */
export const TAOBAO_LOOKBACK_MS = 90 * DAY_MS;
export const JD_CAP_MS = HOUR_MS;
export const PDD_CAP_MS = 30 * MINUTE_MS;

/** The four rows D10-741 ① pins: raw code → internal event. */
export const TAOBAO_ROWS = [
  ['12', 'PLATFORM_PAID'],
  ['14', 'PLATFORM_RECEIVED'],
  ['3', 'PLATFORM_SETTLED'],
  ['13', 'PLATFORM_INVALID'],
] as const;

export const TAOBAO_ENABLED = 'order_sync.rescan.taobao.enabled';
export const TAOBAO_DAYS = 'order_sync.rescan.taobao.days';

/** The real taobao.csv; a missing file is an assertion failure, never an ENOENT red. */
export function requiredTaobaoCsv(): string {
  const text = readStatusCsv('taobao');
  expect(text, 'specs/order-status-map/taobao.csv 必须存在').not.toBeNull();
  return text!;
}

/** The real taobao.csv through the real loader. */
export function taobaoMap(): StatusMap {
  return loadStatusMap('taobao', requiredTaobaoCsv());
}

export const taobaoAccount: SyncAccount = {
  ...account,
  platform: 'taobao',
  union_account_id: TAOBAO_ACCOUNT,
};

export const jdAccount: SyncAccount = account;
export { pddAccount };

export const taobaoIncrement: SyncStream = {
  app_id: account.app_id,
  platform: 'taobao',
  union_account_id: TAOBAO_ACCOUNT,
  query_kind: 'increment',
  scene: '-',
};

export const taobaoRescan: RescanStream = {
  ...stream,
  platform: 'taobao',
  union_account_id: TAOBAO_ACCOUNT,
};

const OWNERS: Readonly<Record<RegisteredPlatform, string>> = {
  jd: ACCOUNT,
  pdd: PDD_ACCOUNT,
  taobao: TAOBAO_ACCOUNT,
};

/** The increment window the scheduler sends for `platform`'s fixture account. */
export function incrementWindow(
  platform: RegisteredPlatform,
  startMs: number,
  spanMs: number,
): OrderSyncWindow {
  return {
    app_id: account.app_id,
    platform,
    union_account_id: OWNERS[platform],
    query_kind: 'increment',
    scene: '-',
    window_start: iso(startMs),
    window_end: iso(startMs + spanMs),
  };
}

/** The rescan window of the taobao fixture account. */
export function taobaoRescanWindow(start: string, capMs = TAOBAO_CAP_MS): OrderRescanWindow {
  return { ...taobaoRescan, window_start: start, window_end: iso(Date.parse(start) + capMs) };
}

/** The rescan fixture (test/spec/orders/rescan/kit.ts) with the order-source gate of D10-741 ③. */
export function gatedFixture(
  options: Parameters<typeof fixture>[0],
  orderSources?: (platform: RegisteredPlatform) => boolean,
) {
  const f = fixture(options);
  const deps: OrderSyncSchedulerDeps = {
    ...f.ruleTableCaps,
    ...(orderSources === undefined ? {} : { orderSources }),
  };
  return { f, deps };
}

/** Calls of a vi.fn logger whose first argument names `platform`. */
export function aboutPlatform(
  fn: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } },
  platform: string,
): (readonly unknown[])[] {
  return fn.mock.calls.filter((call) => {
    const fields = call[0];
    if (typeof fields !== 'object' || fields === null) return false;
    return Reflect.get(fields, 'platform') === platform;
  });
}

/** An unsettled row: the settlement time is absent (「--」). */
const UNSETTLED = { tk_earning_time: '--', pub_share_fee_for_commission: '0.00' };

/**
 * One synthetic Taobao order row with this tk_status, mapped by the real adapter (one page, our
 * slot). Only status 3 carries a settlement time and a settled commission.
 */
export async function taobaoOrder(
  tkStatus: string,
  overrides: Record<string, unknown> = {},
): Promise<UnionOrder> {
  const settled = tkStatus === '3';
  const s = setup(
    onePage([
      row({
        tk_status: num(tkStatus),
        ...(settled ? { pub_share_fee_for_commission: '6.50' } : UNSETTLED),
        ...overrides,
      }),
    ]),
  );
  const window = { from: '2026-10-30T02:00:00.000Z', to: '2026-10-30T02:20:00.000Z' };
  const page = await listed(s.adapter.listOrders(window, {}, ctx));
  expect(page.items).toHaveLength(1);
  return page.items[0]!;
}

/** Beijing 2026-10-30 10:40:00, the synthetic row's tk_earning_time. */
export const EARNING_AT = new Date('2026-10-30T02:40:00.000Z');
/** The adapter fixture's injected clock: the sync time, never a received time. */
export const SYNC_AT = new Date('2026-10-31T08:00:00.000Z');
