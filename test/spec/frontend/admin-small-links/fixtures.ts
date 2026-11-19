// F1-08fe fixtures: the small navigation links of the fund pages (BR-FUND-16 vouchers and their
// biz_id, BR-FUND-12 write-off interception). Only navigation is added; no write is added or
// changed, and no amount is shown differently.
//
// What the tests pin (task 范围 ①–③; ④ see the note at the end of this file):
// ① 余额流水 (/ledger): the 业务单号 cell of a row whose AdminLedgerEntry.link is set is a link
//   (button or anchor) whose text stays the voucher biz_id (the frozen F1-08fa cell texts stay as
//   they are); a row with link null keeps plain text. Following it opens the existing console
//   page of the document: withdrawal → /withdrawals/{id} (that withdrawal's detail is read);
//   adjustment → /adjustments with that adjustment's detail read (GET /admin/v1/adjustments/{id});
//   writeoff → /adjustments on the 坏账核销 tab (its list is read); order → the 订单 pages
//   (/orders…; how the order is found there is the implementer's choice). The 资金摘要 card has
//   【查看用户详情】: it opens the user detail on /users (GET /admin/v1/users/{user_id}).
// ② 调账与核销: the success prompts of 新建调账, 红冲 and an APPROVED 批准核销 offer 【查看凭证】; it
//   opens 余额流水 for the form's user narrowed to the voucher biz_id (the adjust_id of the new form
//   or reversal, the candidate id of the write-off: ledger_vouchers.biz_id), i.e. the ledger page
//   reads GET /admin/v1/ledger with exactly user_id, ref, page=1, page_size=20 and shows both in its
//   UID input and 业务单号 filter. A CANCELLED write-off wrote no voucher: no 【查看凭证】.
//   The ledger page takes the prefill from its address /ledger?user_id=…&ref=… (the list's own
//   parameter names; apps/admin/src/pages/ledger/prefill.ts).
// ③ 批准核销 refused with 20001 data.reason=writeoff_frozen_pending: the dialog's interception
//   notice offers 【去处理提现单】; the refusal names no withdrawal, so it opens the 提现审核 list
//   filtered to the candidate's user (/withdrawals?user_id=…, apps/admin/src/pages/withdrawals/
//   prefill.ts): the list's first read is exactly {page: 1, page_size: 20, user_id} and its
//   「用户 ID」 filter shows the user.
import type { Entry } from '../admin-ledger-readonly/fixtures.ts';

/** Visible copy of this task (each compared as a whole string, spaces ignored for controls). */
export const COPY = {
  /** In the 资金摘要 card of 余额流水. */
  viewUser: '查看用户详情',
  /** In the success prompt of 新建调账 / 红冲 / 批准核销 (APPROVED). */
  viewVoucher: '查看凭证',
  /** In the interception notice of 批准核销 (writeoff_frozen_pending). */
  toWithdrawals: '去处理提现单',
} as const;

/** Page titles (the first h4 of the main area) and labels of the target pages. */
export const PAGE = {
  ledgerTitle: '余额流水',
  withdrawalsTitle: '提现审核',
  adjustmentsTitle: '调账与核销',
  writeoffsTab: '坏账核销',
  /** 余额流水 UID input and 业务单号 filter (frozen F1-08fa labels). */
  uidLabel: '用户 UID',
  refLabel: '业务单号',
  /** The 资金摘要 card title and one of its labels (frozen F1-08fa). */
  summaryTitle: '资金摘要',
  availableLabel: '可用余额',
  /** 提现审核 filter (texts/withdrawals.ts filter.userId). */
  withdrawalUserLabel: '用户 ID',
} as const;

export const LEDGER = '/admin/v1/ledger';
export const WITHDRAWALS = '/admin/v1/withdrawals';
export const ADJUSTMENTS = '/admin/v1/adjustments';
export const WRITEOFFS = '/admin/v1/bad-debt-writeoffs';
export const PAGE_SIZE = '20';
export const userPath = (userId: string): string => `/admin/v1/users/${userId}`;

/** Base for reading console addresses (relative paths) with URL. */
export const CONSOLE = 'https://console.example.test';

// ---- ledger entries linking an adjustment and a write-off ----------------------------------

/** An adjustment (biz_type admin_adjustment, biz_id = adjust_id, uniq_key ADJ:{adjust_id}). */
export const LINKED_ADJUSTMENT = 'ad100004-0000-4000-8000-000000000004';
/** A write-off candidate (biz_type bad_debt_writeoff, biz_id = candidate id). */
export const LINKED_WRITEOFF = 'bd000003-0000-4000-8000-000000000003';

/** ADMIN_ADJUST credit of the user's available sub-account, linking its adjustment. */
export const ADJUSTED: Entry = {
  entry_id: '1201',
  booked_at: '2026-11-08T10:00:00+08:00',
  accounting_date: '2026-11-08',
  ledger_type: 'ADMIN_ADJUST',
  sub_type: 'RECON_FIX',
  sub_account: 'available',
  amount_fen: 1234,
  balance_after_fen: 34,
  voucher: {
    voucher_id: 'f1000003-0000-4000-8000-000000000003',
    uniq_key: `ADJ:${LINKED_ADJUSTMENT}`,
    biz_type: 'admin_adjustment',
    biz_id: LINKED_ADJUSTMENT,
  },
  link: { type: 'adjustment', id: LINKED_ADJUSTMENT },
};

/** BAD_DEBT_WRITEOFF credit bringing available back to 0, linking its candidate. */
export const WRITTEN_OFF: Entry = {
  entry_id: '1200',
  booked_at: '2026-11-07T10:00:00+08:00',
  accounting_date: '2026-11-07',
  ledger_type: 'BAD_DEBT_WRITEOFF',
  sub_type: null,
  sub_account: 'available',
  amount_fen: 1200,
  balance_after_fen: 0,
  voucher: {
    voucher_id: 'f2000001-0000-4000-8000-000000000001',
    uniq_key: `BADDEBT:ac000003-0000-4000-8000-000000000003:${LINKED_WRITEOFF}`,
    biz_type: 'bad_debt_writeoff',
    biz_id: LINKED_WRITEOFF,
  },
  link: { type: 'writeoff', id: LINKED_WRITEOFF },
};

/** The two entries above, latest first (row 0 links the adjustment, row 1 the write-off). */
export const LINKED_ENTRIES: readonly Entry[] = [ADJUSTED, WRITTEN_OFF];

// ④ 坏账核销 tab badge (only the total of a list read the page makes anyway): the page's only read
// of the 坏账核销 list is unfiltered ({page, page_size}, pinned by F1-08ca WRITEOFF#1) and starts
// only when that tab is opened, so its total is not the number of PENDING candidates and no read
// on entering the page gives it; the task says not to add a read for the badge. No test pins a
// badge here (the right behaviour — no badge and no extra read — is what the page does already).
