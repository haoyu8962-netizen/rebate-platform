// F1-08dc (D10-1402, CT-24zzj): the 「待确认」 filter of the bill list. listAdminSettleBills takes
// the optional query parameter awaiting_confirm (boolean): true = only the bills whose latest round
// has a DRAFT batch waiting for confirmation (AdminSettleBillAwaitingConfirm); false or absent = no
// such filter; it intersects with status and bill_from / bill_to; a value that is not a boolean is
// 20001 with data.fields=[awaiting_confirm]. The frozen fake server of F1-08d (CT-24z) does not
// know the parameter: the server here is that one, answering the list reads that carry it from
// its own state (every request is still logged and counted by the frozen server).
import {
  BILL,
  LIST,
  LIST_PARAMS,
  bills,
  createServer,
  denied,
  failure,
  ok,
  rejected,
  withFillerBills,
  type Batch,
  type Bill,
  type BillRow,
  type RequestLog,
  type Server,
} from '../admin-settle-bills/fixtures.ts';

export const AWAITING = 'awaiting_confirm';
/** Every query parameter listAdminSettleBills takes after CT-24zzj. */
export const AWAITING_PARAMS: readonly string[] = [...LIST_PARAMS, AWAITING];

/**
 * An issued bill whose latest round has a CANCELLED batch only (no DRAFT): issued, but not
 * waiting for confirmation (the contract's "not every issued bill").
 */
export const ISSUED_NOT_WAITING = '2026-05';
/** Older issued bills, each with one DRAFT batch in the latest round (2026-04 back to 2024-06). */
const WAITING_FILLERS = 23;
/** The bills waiting for confirmation: 2026-08 and the 23 older ones (24, two pages of 20). */
export const WAITING_TOTAL = 24;
/** The second page of the awaiting_confirm=true list (bill_id descending, rows 21–24). */
export const WAITING_SECOND_PAGE: readonly string[] = ['2024-09', '2024-08', '2024-07', '2024-06'];

/** The contract's set: the latest round has a DRAFT batch (the derived status is issued). */
export function waitingForConfirm(bill: Bill): boolean {
  return (
    bill.status === 'issued' &&
    bill.batches.some((batch) => batch.in_current_round && batch.status === 'DRAFT')
  );
}

/**
 * The four samples of F1-08d, then 2026-05 (issued, its only batch CANCELLED) and 23 older issued
 * bills with one DRAFT batch each: 28 bills, 24 of them waiting for confirmation.
 */
export function awaitingBills(): Bill[] {
  const all = withFillerBills(WAITING_FILLERS + 1);
  const sample = bills().find((bill) => bill.bill_id === BILL.issued)!.batches[0]!;
  return all.map((bill, index): Bill => {
    if (index < 4) return bill;
    const n = index - 3;
    const waiting = bill.bill_id !== ISSUED_NOT_WAITING;
    const batch: Batch = {
      ...structuredClone(sample),
      batch_id: `b${String(n).padStart(7, '0')}-1111-4000-8000-000000000000`,
      status: waiting ? 'DRAFT' : 'CANCELLED',
      platform: 'taobao',
      order_count: 10,
      created_at: '2026-01-24T02:05:00+08:00',
    };
    return {
      ...bill,
      status: 'issued',
      batch_count: 1,
      draft_batch_count: waiting ? 1 : 0,
      batches: [batch],
    };
  });
}

const MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const POSITIVE = /^[1-9][0-9]*$/;
const BILL_STATUSES: readonly string[] = [
  'generating',
  'issued',
  'scheduled',
  'settling',
  'settled',
];

function listRow(bill: Bill): BillRow {
  return {
    bill_id: bill.bill_id,
    status: bill.status,
    generation_started_at: bill.generation_started_at,
    generated_at: bill.generated_at,
    platform_order_counts: bill.platform_order_counts,
    platform_settle_commission_totals: bill.platform_settle_commission_totals,
    beneficiary_total_fen: bill.beneficiary_total_fen,
    platform_retained_fen: bill.platform_retained_fen,
    error_count: bill.error_count,
    held_count: bill.held_count,
    batch_count: bill.batch_count,
    draft_batch_count: bill.draft_batch_count,
    created_at: bill.created_at,
  };
}

/** listAdminSettleBills with awaiting_confirm, in the order the contract's description gives. */
function awaitingList(server: Server, request: RequestLog): Response {
  if (request.headers.get('Authorization') !== 'Bearer example-admin-token') {
    return failure(10001, undefined, '未登录');
  }
  if (!server.permissions.includes('settle.bill') && !server.permissions.includes('fund.view')) {
    return denied();
  }
  const query = request.query;
  const from = query['bill_from'];
  const to = query['bill_to'];
  const status = query['status'];
  const page = query['page'];
  const size = query['page_size'];
  const flag = query[AWAITING];
  const invalid = [
    ...(page === undefined || POSITIVE.test(page) ? [] : ['page']),
    ...(size === undefined || (POSITIVE.test(size) && Number(size) <= 200) ? [] : ['page_size']),
    ...(from === undefined || MONTH.test(from) ? [] : ['bill_from']),
    ...(to === undefined || MONTH.test(to) ? [] : ['bill_to']),
    ...(status === undefined || BILL_STATUSES.includes(status) ? [] : ['status']),
    ...(flag === 'true' || flag === 'false' ? [] : [AWAITING]),
  ];
  if (invalid.length > 0) return rejected(invalid);
  if (from !== undefined && to !== undefined && from > to) {
    return rejected(['bill_from', 'bill_to']);
  }
  const matching = server.state
    .filter(
      (bill) =>
        (from === undefined || bill.bill_id >= from) &&
        (to === undefined || bill.bill_id <= to) &&
        (status === undefined || bill.status === status) &&
        (flag !== 'true' || waitingForConfirm(bill)),
    )
    .sort((a, b) => (a.bill_id < b.bill_id ? 1 : a.bill_id > b.bill_id ? -1 : 0))
    .map(listRow);
  const pageNo = page === undefined ? 1 : Number(page);
  const pageSize = size === undefined ? 20 : Number(size);
  return ok({
    items: matching.slice((pageNo - 1) * pageSize, pageNo * pageSize),
    page: pageNo,
    page_size: pageSize,
    total: matching.length,
  });
}

/**
 * The frozen fake server of F1-08d over `initial` (default awaitingBills()), answering the list
 * reads that carry awaiting_confirm as CT-24zzj says. Its log, reads(), pending and overrides are
 * the frozen server's own.
 */
export function createAwaitingServer(initial: Bill[] = awaitingBills()): Server {
  const server = createServer(initial);
  const inner = server.fetch;
  server.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (method === 'GET' && url.pathname === LIST && url.searchParams.has(AWAITING)) {
      server.once(
        'GET',
        LIST,
        (request) => awaitingList(server, request),
        (request) => request.query[AWAITING] !== undefined,
      );
    }
    return inner(input, init);
  };
  return server;
}
