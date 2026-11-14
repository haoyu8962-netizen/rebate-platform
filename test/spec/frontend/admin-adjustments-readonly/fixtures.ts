import { formatYuanAdmin, parseFen } from '@couli/money';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import dictionary from '../../../../contracts/texts.admin.default.json' with { type: 'json' };
import type {
  KnownPermission,
  PermissionSnapshot,
  StepUpAnnotation,
} from '../../../../apps/admin/src/providers/access-control/index.ts';

// Contract-shaped fixtures for the three reads of the 调账与核销 page (contracts/openapi.yaml, tag
// admin-adjustments): adminListAdjustments GET /admin/v1/adjustments (fund.adjust or fund.view),
// adminGetAdjustment GET /admin/v1/adjustments/{adjust_id} (fund.adjust or fund.view; an unknown
// id is 20001 with data.fields=[adjust_id], no 404) and adminListBadDebtWriteoffs GET
// /admin/v1/bad-debt-writeoffs (fund.writeoff or fund.view). The fake server checks in the order
// the descriptions give. Ids are obvious fake UUIDs whose first 8 characters differ; amounts and
// admins are samples. Status and reason names come from the console dictionary
// (contracts/texts.admin.default.json, BR-TEXT-25 admin_dict.admin_adjustments.status.*,
// admin_dict.admin_adjustments.sub_type.*, admin_dict.bad_debt_writeoff.status.*) when the test
// runs: a code with a row shows its name, a code without one shows the code itself.
export const BASE_URL = 'https://admin-api.example.test';
export const TRACE_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
/** The menu already in apps/admin/src/resources (fund.adjust or fund.writeoff shows it). */
export const MENU_ID = 'adjustments';
export const ADJUSTMENTS = '/admin/v1/adjustments';
export const WRITEOFFS = '/admin/v1/bad-debt-writeoffs';
export const VERIFY = '/admin/v1/auth/step-up';
export const adjustmentPath = (adjustId: string): string => `${ADJUSTMENTS}/${adjustId}`;
/** The page size of both lists (contract default, ≤ 200). */
export const PAGE_SIZE = '20';

export type Adjustment = Schema<'AdminAdjustment'>;
export type AdjustmentDetail = Schema<'AdminAdjustmentDetail'>;
export type Writeoff = Schema<'AdminBadDebtWriteoff'>;
export type AdjustmentStatus = Schema<'AdminAdjustmentStatus'>;
export type ReasonCode = Schema<'AdminAdjustmentReasonCode'>;
export type WriteoffStatus = Schema<'AdminBadDebtWriteoffStatus'>;

// ---- what the page shows (fixed texts this task decides; texts/adjustments.ts holds them) ---

/** Fixed texts of the page, compared as whole strings (whitespace collapsed and trimmed). */
export const TEXT = {
  menu: '调账与核销',
  adjustmentsTab: '调账单',
  writeoffsTab: '坏账核销',
  /** No read point (fund.adjust / fund.writeoff / fund.view), or a list read answered 10403. */
  forbidden: '无权限查看调账与核销',
  adjustmentsFailed: '调账单加载失败',
  writeoffsFailed: '核销候选单加载失败',
  adjustmentsEmpty: '暂无调账单',
  writeoffsEmpty: '暂无核销候选单',
  retry: '重试',
  query: '查询',
  reset: '重置',
  detailEntry: '详情',
  /** Title of the detail drawer. */
  detailTitle: '调账单详情',
  /** adminGetAdjustment answered 20001 with data.fields=[adjust_id]. */
  detailMissing: '调账单不存在或已不可见',
  detailFailed: '调账单读取失败',
  /** A form without linked documents (a reversal, or an OTHER form whose note stands in). */
  noRefs: '无关联单据',
  /** The mark of a form that has been reversed (reversed_by_adjust_id set; not a status). */
  reversed: '已红冲',
  /** created_by null: a form the system prefilled. */
  system: '系统',
  /** Any value the contract gives as null. */
  dash: '—',
} as const;

/** Column titles of the 调账单 table. */
export const COLUMN = {
  id: '调账单号',
  user: '用户',
  direction: '方向',
  amount: '金额',
  reason: '原因',
  status: '状态',
  reversal: '红冲',
  creator: '创建人',
  created: '创建时间',
} as const;
export const LIST_TITLES: readonly string[] = Object.values(COLUMN);

/** Column titles of the 坏账核销 table. */
export const WRITEOFF_COLUMN = {
  id: '候选单号',
  user: '用户',
  since: '负余额起始日',
  days: '负余额天数',
  candidate: '生成时金额',
  available: '当前可用余额',
  frozen: '冻结',
  status: '状态',
  created: '生成时间',
} as const;
export const WRITEOFF_TITLES: readonly string[] = Object.values(WRITEOFF_COLUMN);

/** Labels of the detail drawer's items (each label followed by its value). */
export const FIELD = {
  id: '调账单号',
  user: '用户',
  direction: '方向',
  amount: '金额',
  reason: '原因',
  status: '状态',
  subject: '对方科目',
  note: '说明',
  voucher: '凭证',
  reverses: '原调账单',
  reversedBy: '红冲单',
  creator: '创建人',
  created: '创建时间',
  reviewer: '审核人',
  reviewed: '审核时间',
  rejectNote: '驳回原因',
} as const;
export const FIELD_LABELS: readonly string[] = Object.values(FIELD);

/** Column titles of the detail's linked documents table. */
export const REF_COLUMN = { type: '单据类型', id: '单据号' } as const;

/** Labels of the 调账单 filter (antd Form.Item label, aria-label or placeholder). */
export const FILTER_LABEL = { status: '状态', reason: '原因', user: '用户 ID' } as const;

/** contracts/enums/fund.yaml admin_adjustment_direction. */
export const DIRECTION_NAME = { increase: '调增', decrease: '调减' } as const;
/** contracts/enums/fund.yaml admin_adjustment_ref_type. */
export const REF_TYPE_NAME = {
  recon_diff: '差错单',
  withdrawal: '提现单',
  order: '子订单',
  account_deletion: '注销单',
} as const;
/** contracts/enums/fund.yaml admin_adjustment_contra_subject. */
export const SUBJECT_NAME = {
  COMMISSION_REVENUE: '佣金收入',
  UNION_RECEIVABLE: '联盟应收',
  BAD_DEBT: '坏账',
  MKT_EXPENSE: '营销费用',
  CASH_ALIPAY: '支付宝现金',
  CASH_WECHAT: '微信现金',
  CASH_BANK: '银行现金',
} as const;

/** Contract order of the filter options. */
export const STATUSES: readonly AdjustmentStatus[] = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
];
export const REASONS: readonly ReasonCode[] = [
  'RESTORE',
  'RECON_FIX',
  'PAYOUT_RECOVERY',
  'ACCOUNT_CLOSED',
  'OTHER',
];
export const WRITEOFF_STATUSES: readonly WriteoffStatus[] = ['PENDING', 'APPROVED', 'CANCELLED'];
const STATUS_CODES: readonly string[] = STATUSES;
const REASON_CODES: readonly string[] = REASONS;
const WRITEOFF_CODES: readonly string[] = WRITEOFF_STATUSES;

// ---- console dictionary (BR-TEXT-25 admin_dict) --------------------------------------------

function dictionaryTexts(): Readonly<Record<string, string>> {
  return (dictionary as { texts?: Record<string, string> }).texts ?? {};
}
/** The dictionary's name of `code` under `prefix`, else the code. */
export function dictName(prefix: string, code: string): string {
  const texts = dictionaryTexts();
  const name = `${prefix}.${code}`;
  const value = Object.hasOwn(texts, name) ? texts[name] : undefined;
  return typeof value === 'string' && value !== '' ? value : code;
}
export const statusName = (code: string): string =>
  dictName('admin_dict.admin_adjustments.status', code);
export const reasonName = (code: string): string =>
  dictName('admin_dict.admin_adjustments.sub_type', code);
export const writeoffStatusName = (code: string): string =>
  dictName('admin_dict.bad_debt_writeoff.status', code);

/** An admin amount as shown (BR-TEXT-10, only through @couli/money). */
export const yuan = (fen: number): string => formatYuanAdmin(parseFen(fen));

// ---- samples -------------------------------------------------------------------------------

export const ADJ = {
  /** PENDING ACCOUNT_CLOSED decrease the system prefilled: amount_fen and created_by null. */
  prefilled: 'ad100001-0000-4000-8000-000000000001',
  /** The whole-form reversal of `recovery` (an increase, refs empty). */
  reversal: 'ad100002-0000-4000-8000-000000000002',
  /** APPROVED PAYOUT_RECOVERY decrease of 10000 fen, reversed by `reversal`. */
  recovery: 'ad100003-0000-4000-8000-000000000003',
  /** APPROVED RECON_FIX increase of 123456789 fen, created at 16:05Z (00:05 the next day). */
  reconFix: 'ad100004-0000-4000-8000-000000000004',
  /** REJECTED ACCOUNT_CLOSED (prefilled, then rejected with a reason). */
  rejected: 'ad100005-0000-4000-8000-000000000005',
  /** APPROVED OTHER increase of 5 fen whose note stands in for a document (refs empty). */
  otherNote: 'ad100006-0000-4000-8000-000000000006',
  /** APPROVED RESTORE increase of 2000 fen (a sub-order and a difference). */
  restore: 'ad100007-0000-4000-8000-000000000007',
  /** CANCELLED ACCOUNT_CLOSED (prefilled; the deletion was withdrawn). */
  cancelled: 'ad100008-0000-4000-8000-000000000008',
} as const;
/** The list order (created_at descending). */
export const ADJUSTMENT_ORDER: readonly string[] = [
  ADJ.prefilled,
  ADJ.reversal,
  ADJ.recovery,
  ADJ.reconFix,
  ADJ.rejected,
  ADJ.otherNote,
  ADJ.restore,
  ADJ.cancelled,
];

export const USER = {
  deleting: 'c1000001-0000-4000-8000-000000000001',
  payee: 'c1000002-0000-4000-8000-000000000002',
  recon: 'c1000003-0000-4000-8000-000000000003',
  retracted: 'c1000004-0000-4000-8000-000000000004',
  service: 'c1000005-0000-4000-8000-000000000005',
  restored: 'c1000006-0000-4000-8000-000000000006',
  filler: 'c1000099-0000-4000-8000-000000000099',
  negative: 'c2000001-0000-4000-8000-000000000001',
  frozen: 'c2000002-0000-4000-8000-000000000002',
  writtenOff: 'c2000003-0000-4000-8000-000000000003',
  recovered: 'c2000004-0000-4000-8000-000000000004',
  /** Names nothing: a filter on it is an empty page. */
  unknown: 'c9999999-0000-4000-8000-000000000999',
} as const;
export const ADMIN = {
  first: 'e1000001-0000-4000-8000-0000000000e1',
  second: 'e1000002-0000-4000-8000-0000000000e2',
} as const;
export const VOUCHER = {
  recovery: 'f1000001-0000-4000-8000-000000000001',
  reversal: 'f1000002-0000-4000-8000-000000000002',
  reconFix: 'f1000003-0000-4000-8000-000000000003',
  otherNote: 'f1000004-0000-4000-8000-000000000004',
  restore: 'f1000005-0000-4000-8000-000000000005',
  writtenOff: 'f2000001-0000-4000-8000-000000000001',
} as const;
export const DOC = {
  withdrawal: 'b1000001-0000-4000-8000-000000000001',
  payoutDiff: 'd1000001-0000-4000-8000-000000000001',
  reconDiff: 'd1000002-0000-4000-8000-000000000002',
  restoreDiff: 'd1000003-0000-4000-8000-000000000003',
  order: 'tb-3891234567890-01',
  deletionPending: 'de100001-0000-4000-8000-000000000001',
  deletionRejected: 'de100002-0000-4000-8000-000000000002',
  deletionCancelled: 'de100003-0000-4000-8000-000000000003',
} as const;
export const NOTE = {
  recovery: '迟到成功重复出款，追回',
  reversal: '差错单核对有误，整笔冲回',
  reconFix: 'R2 差错单更正：联盟补结算佣金',
  otherNote: '客服核实：企业微信沟通，补发活动奖励',
  restore: '订单申诉恢复',
  rejectNote: '用户已撤回注销申请',
} as const;

type Fields = Pick<
  Adjustment,
  'adjust_id' | 'user_id' | 'direction' | 'amount_fen' | 'reason_code' | 'status' | 'created_at'
> &
  Partial<Adjustment>;

function adjustment(fields: Fields): Adjustment {
  return {
    refs: [],
    contra_subject: 'COMMISSION_REVENUE',
    contra_platform: null,
    note: null,
    reverses_adjust_id: null,
    reversed_by_adjust_id: null,
    created_by: null,
    reviewed_by: null,
    reviewed_at: null,
    reject_note: null,
    voucher_id: null,
    ...fields,
  };
}

/** The eight samples in list order (created_at descending). */
export function adjustments(): Adjustment[] {
  return [
    adjustment({
      adjust_id: ADJ.prefilled,
      user_id: USER.deleting,
      direction: 'decrease',
      amount_fen: null,
      reason_code: 'ACCOUNT_CLOSED',
      status: 'PENDING',
      refs: [{ ref_type: 'account_deletion', ref_id: DOC.deletionPending }],
      created_at: '2026-12-01T02:00:00+08:00',
    }),
    adjustment({
      adjust_id: ADJ.reversal,
      user_id: USER.payee,
      direction: 'increase',
      amount_fen: 10000,
      reason_code: 'PAYOUT_RECOVERY',
      status: 'APPROVED',
      contra_subject: 'CASH_ALIPAY',
      note: NOTE.reversal,
      reverses_adjust_id: ADJ.recovery,
      created_by: ADMIN.second,
      created_at: '2026-11-30T08:45:10Z',
      reviewed_by: ADMIN.second,
      reviewed_at: '2026-11-30T08:45:10Z',
      voucher_id: VOUCHER.reversal,
    }),
    adjustment({
      adjust_id: ADJ.recovery,
      user_id: USER.payee,
      direction: 'decrease',
      amount_fen: 10000,
      reason_code: 'PAYOUT_RECOVERY',
      status: 'APPROVED',
      refs: [
        { ref_type: 'withdrawal', ref_id: DOC.withdrawal },
        { ref_type: 'recon_diff', ref_id: DOC.payoutDiff },
      ],
      contra_subject: 'CASH_ALIPAY',
      note: NOTE.recovery,
      reversed_by_adjust_id: ADJ.reversal,
      created_by: ADMIN.first,
      created_at: '2026-11-30T10:30:00+08:00',
      reviewed_by: ADMIN.first,
      reviewed_at: '2026-11-30T10:30:00+08:00',
      voucher_id: VOUCHER.recovery,
    }),
    adjustment({
      adjust_id: ADJ.reconFix,
      user_id: USER.recon,
      direction: 'increase',
      amount_fen: 123456789,
      reason_code: 'RECON_FIX',
      status: 'APPROVED',
      refs: [{ ref_type: 'recon_diff', ref_id: DOC.reconDiff }],
      contra_subject: 'COMMISSION_REVENUE',
      note: NOTE.reconFix,
      created_by: ADMIN.second,
      created_at: '2026-11-28T16:05:00Z',
      reviewed_by: ADMIN.second,
      reviewed_at: '2026-11-28T16:05:00Z',
      voucher_id: VOUCHER.reconFix,
    }),
    adjustment({
      adjust_id: ADJ.rejected,
      user_id: USER.retracted,
      direction: 'decrease',
      amount_fen: null,
      reason_code: 'ACCOUNT_CLOSED',
      status: 'REJECTED',
      refs: [{ ref_type: 'account_deletion', ref_id: DOC.deletionRejected }],
      created_at: '2026-11-20T02:00:00+08:00',
      reviewed_by: ADMIN.first,
      reviewed_at: '2026-11-21T09:15:00+08:00',
      reject_note: NOTE.rejectNote,
    }),
    adjustment({
      adjust_id: ADJ.otherNote,
      user_id: USER.service,
      direction: 'increase',
      amount_fen: 5,
      reason_code: 'OTHER',
      status: 'APPROVED',
      contra_subject: 'MKT_EXPENSE',
      note: NOTE.otherNote,
      created_by: ADMIN.first,
      created_at: '2026-11-15T09:00:00+08:00',
      reviewed_by: ADMIN.first,
      reviewed_at: '2026-11-15T09:00:00+08:00',
      voucher_id: VOUCHER.otherNote,
    }),
    adjustment({
      adjust_id: ADJ.restore,
      user_id: USER.restored,
      direction: 'increase',
      amount_fen: 2000,
      reason_code: 'RESTORE',
      status: 'APPROVED',
      refs: [
        { ref_type: 'order', ref_id: DOC.order },
        { ref_type: 'recon_diff', ref_id: DOC.restoreDiff },
      ],
      note: NOTE.restore,
      created_by: ADMIN.second,
      created_at: '2026-11-10T12:00:00+08:00',
      reviewed_by: ADMIN.second,
      reviewed_at: '2026-11-10T12:00:00+08:00',
      voucher_id: VOUCHER.restore,
    }),
    adjustment({
      adjust_id: ADJ.cancelled,
      user_id: USER.retracted,
      direction: 'decrease',
      amount_fen: null,
      reason_code: 'ACCOUNT_CLOSED',
      status: 'CANCELLED',
      refs: [{ ref_type: 'account_deletion', ref_id: DOC.deletionCancelled }],
      created_at: '2026-11-05T02:00:00+08:00',
    }),
  ];
}

/** The adjust_id of filler form `n` (1-based): ad900001-…, ad900002-… */
export function fillerId(n: number): string {
  return `ad9${String(n).padStart(5, '0')}-0000-4000-8000-000000000000`;
}
/** Filler ids `from` down to `to` (the list order of fillers: one created_at, id descending). */
export function fillerIds(from: number, to: number): string[] {
  return Array.from({ length: from - to + 1 }, (_, index) => fillerId(from - index));
}
/** The eight samples, then `count` older APPROVED OTHER forms (one created_at). */
export function withFiller(count: number): Adjustment[] {
  const filler = Array.from({ length: count }, (_, index): Adjustment => {
    return adjustment({
      adjust_id: fillerId(index + 1),
      user_id: USER.filler,
      direction: 'increase',
      amount_fen: 100,
      reason_code: 'OTHER',
      status: 'APPROVED',
      contra_subject: 'MKT_EXPENSE',
      note: '客服补偿',
      created_by: ADMIN.first,
      created_at: '2026-10-01T09:00:00+08:00',
      reviewed_by: ADMIN.first,
      reviewed_at: '2026-10-01T09:00:00+08:00',
    });
  });
  return [...adjustments(), ...filler];
}

export const WO = {
  /** PENDING, available −300 fen, nothing frozen. */
  recent: 'bd000001-0000-4000-8000-000000000001',
  /** PENDING with frozen money (approve_blocked). */
  blocked: 'bd000002-0000-4000-8000-000000000002',
  /** APPROVED (written off). */
  writtenOff: 'bd000003-0000-4000-8000-000000000003',
  /** CANCELLED (the balance came back above 0), created at 18:00Z (02:00 the next day). */
  cancelled: 'bd000004-0000-4000-8000-000000000004',
} as const;
export const WRITEOFF_ORDER: readonly string[] = [
  WO.recent,
  WO.blocked,
  WO.writtenOff,
  WO.cancelled,
];

/** The four candidates in list order (created_at descending). */
export function writeoffs(): Writeoff[] {
  const base = {
    initiator_id: null,
    approver_id: null,
    approved_at: null,
    voucher_id: null,
    approve_blocked: false,
  } as const;
  return [
    {
      ...base,
      id: WO.recent,
      account_id: 'ac000001-0000-4000-8000-000000000001',
      user_id: USER.negative,
      negative_since: '2026-11-20',
      negative_days: 90,
      candidate_fen: 800,
      available_fen: -300,
      frozen_fen: 0,
      status: 'PENDING',
      created_at: '2027-02-18T02:00:00+08:00',
    },
    {
      ...base,
      id: WO.blocked,
      account_id: 'ac000002-0000-4000-8000-000000000002',
      user_id: USER.frozen,
      negative_since: '2026-11-01',
      negative_days: 109,
      candidate_fen: 12000,
      available_fen: -12345,
      frozen_fen: 5000,
      status: 'PENDING',
      approve_blocked: true,
      created_at: '2027-02-17T02:00:00+08:00',
    },
    {
      ...base,
      id: WO.writtenOff,
      account_id: 'ac000003-0000-4000-8000-000000000003',
      user_id: USER.writtenOff,
      negative_since: '2026-10-01',
      negative_days: 93,
      candidate_fen: 600,
      available_fen: 0,
      frozen_fen: 0,
      status: 'APPROVED',
      approver_id: ADMIN.first,
      approved_at: '2027-01-12T10:00:00+08:00',
      voucher_id: VOUCHER.writtenOff,
      created_at: '2027-01-10T02:00:00+08:00',
    },
    {
      ...base,
      id: WO.cancelled,
      account_id: 'ac000004-0000-4000-8000-000000000004',
      user_id: USER.recovered,
      negative_since: '2026-09-25',
      negative_days: 98,
      candidate_fen: 400,
      available_fen: 1500,
      frozen_fen: 0,
      status: 'CANCELLED',
      created_at: '2026-12-31T18:00:00Z',
    },
  ];
}

// ---- permissions ---------------------------------------------------------------------------

/** Permission points an account holds. */
export type Grants = readonly KnownPermission[];
/** fund.adjust: the menu and the 调账单 tab (the writes of F1-08cb/cc are not offered here). */
export const ADJUST_GRANTS: Grants = ['fund.adjust'];
/** fund.writeoff: the menu and the 坏账核销 tab only. */
export const WRITEOFF_GRANTS: Grants = ['fund.writeoff'];
/** fund.view: reads both tabs; the menu stays hidden (not one of the menu's points). */
export const VIEW_GRANTS: Grants = ['fund.view'];
/** A point that reads neither list. */
export const OTHER_GRANTS: Grants = ['withdraw.review'];

/** Permission snapshot; nothing this page does needs a step-up. */
export function snapshot(permissions: Grants): PermissionSnapshot {
  const stepUp: Partial<Record<KnownPermission, StepUpAnnotation>> = {};
  for (const point of permissions) stepUp[point] = { tier: null, operations: {} };
  return { isSuper: false, permissions, stepUp };
}
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };

// ---- envelopes -----------------------------------------------------------------------------

export function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE_ID });
}
// HTTP statuses as in contracts/error-codes.yaml.
const HTTP_STATUS: Readonly<Record<number, number>> = {
  10001: 401,
  10403: 403,
  20001: 400,
  50001: 500,
};
/** An error envelope; `data` is left out when undefined. */
export function failure(code: number, data?: unknown, msg = '参数错误'): Response {
  const envelope: Record<string, unknown> = { code, msg, trace_id: TRACE_ID };
  if (data !== undefined) envelope['data'] = data;
  return Response.json(envelope, { status: HTTP_STATUS[code] ?? 400 });
}
export function rejected(fields: readonly string[]): Response {
  return failure(20001, { fields });
}
export function denied(): Response {
  return failure(10403, { reason: 'admin_permission_denied' }, '无权限');
}
export function unavailable(): Response {
  return failure(50001, undefined, '服务暂时不可用');
}

// ---- fake server ---------------------------------------------------------------------------

export interface RequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Headers;
  body: unknown;
}
type Reply = (request: RequestLog) => Response | Promise<Response>;
/** Which requests an override answers (all of its method and path when left out). */
export type When = (request: RequestLog) => boolean;

export interface ServerOptions {
  /** Permission points of the account (the server checks them; 10403 otherwise). */
  readonly permissions?: Grants;
  readonly adjustments?: readonly Adjustment[];
  readonly writeoffs?: readonly Writeoff[];
}

const POSITIVE = /^[1-9][0-9]*$/;
const DETAIL = /^\/admin\/v1\/adjustments\/([^/]+)$/;

/** A table read of `path`: a GET of the list that is not a count read (page_size=1). */
export function isTableRead(request: RequestLog, path: string): boolean {
  return request.method === 'GET' && request.path === path && request.query['page_size'] !== '1';
}
export function tableRead(path: string): When {
  return (request) => isTableRead(request, path);
}

function pageInvalid(page: string | undefined, size: string | undefined): string[] {
  return [
    ...(page === undefined || POSITIVE.test(page) ? [] : ['page']),
    ...(size === undefined || (POSITIVE.test(size) && Number(size) <= 200) ? [] : ['page_size']),
  ];
}
function pageOf<T>(rows: readonly T[], page: string | undefined, size: string | undefined) {
  const pageNo = page === undefined ? 1 : Number(page);
  const pageSize = size === undefined ? 20 : Number(size);
  const items = rows.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  return { items, page: pageNo, page_size: pageSize, total: rows.length };
}
function idInvalid(value: string | undefined): boolean {
  return value !== undefined && (value.length < 1 || value.length > 64);
}
/** created_at descending, then the id descending. */
function newestFirst(a: string, b: string, aId: string, bId: string): number {
  const diff = Date.parse(b) - Date.parse(a);
  if (diff !== 0) return diff;
  return aId < bId ? 1 : aId > bId ? -1 : 0;
}
/** balance_preview as adminGetAdjustment describes it (the page of this task does not show it). */
function previewOf(form: Adjustment): AdjustmentDetail['balance_preview'] {
  if (form.status === 'PENDING')
    return {
      direction: 'decrease',
      amount_fen: 2000,
      available_before_fen: 2000,
      available_after_fen: 0,
    };
  if (
    form.status === 'APPROVED' &&
    form.reverses_adjust_id === null &&
    form.reversed_by_adjust_id === null &&
    form.amount_fen !== null
  ) {
    const before = 50000;
    const opposite = form.direction === 'increase' ? 'decrease' : 'increase';
    const after = opposite === 'increase' ? before + form.amount_fen : before - form.amount_fen;
    return {
      direction: opposite,
      amount_fen: form.amount_fen,
      available_before_fen: before,
      available_after_fen: after,
    };
  }
  return null;
}

/** Fake /admin/v1 server with the checks of the three reads. */
export function createServer(options: ServerOptions = {}) {
  const forms = structuredClone([...(options.adjustments ?? adjustments())]);
  const candidates = structuredClone([...(options.writeoffs ?? writeoffs())]);
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; when: When | undefined; reply: Reply }[] = [];
  const permissions = options.permissions ?? VIEW_GRANTS;
  let inFlight = 0;

  const holds = (point: KnownPermission): boolean => permissions.includes(point);
  const readsAdjustments = (): boolean => holds('fund.adjust') || holds('fund.view');
  const readsWriteoffs = (): boolean => holds('fund.writeoff') || holds('fund.view');

  function listAdjustments(query: Record<string, string>): Response {
    if (!readsAdjustments()) return denied();
    const { page, page_size: size, reason_code: reason, status, user_id: user } = query;
    const invalid = [
      ...pageInvalid(page, size),
      ...(reason === undefined || REASON_CODES.includes(reason) ? [] : ['reason_code']),
      ...(status === undefined || STATUS_CODES.includes(status) ? [] : ['status']),
      ...(idInvalid(user) ? ['user_id'] : []),
    ];
    if (invalid.length > 0) return rejected(invalid);
    const matching = forms
      .filter(
        (form) =>
          (reason === undefined || form.reason_code === reason) &&
          (status === undefined || form.status === status) &&
          (user === undefined || form.user_id === user),
      )
      .sort((a, b) => newestFirst(a.created_at, b.created_at, a.adjust_id, b.adjust_id));
    return ok(pageOf(matching, page, size));
  }

  function getAdjustment(adjustId: string): Response {
    if (!readsAdjustments()) return denied();
    const found = forms.find((form) => form.adjust_id === adjustId);
    if (found === undefined) return rejected(['adjust_id']);
    const detail: AdjustmentDetail = { adjustment: found, balance_preview: previewOf(found) };
    return ok(detail);
  }

  function listWriteoffs(query: Record<string, string>): Response {
    if (!readsWriteoffs()) return denied();
    const { page, page_size: size, status, user_id: user } = query;
    const invalid = [
      ...pageInvalid(page, size),
      ...(status === undefined || WRITEOFF_CODES.includes(status) ? [] : ['status']),
      ...(idInvalid(user) ? ['user_id'] : []),
    ];
    if (invalid.length > 0) return rejected(invalid);
    const matching = candidates
      .filter(
        (row) =>
          (status === undefined || row.status === status) &&
          (user === undefined || row.user_id === user),
      )
      .sort((a, b) => newestFirst(a.created_at, b.created_at, a.id, b.id));
    return ok(pageOf(matching, page, size));
  }

  function normal(request: RequestLog): Response {
    const { method, path } = request;
    if (request.headers.get('Authorization') !== 'Bearer example-admin-token') {
      return failure(10001, undefined, '未登录');
    }
    if (method === 'GET' && path === ADJUSTMENTS) return listAdjustments(request.query);
    const one = DETAIL.exec(path);
    if (method === 'GET' && one !== null) return getAdjustment(decodeURIComponent(one[1]!));
    if (method === 'GET' && path === WRITEOFFS) return listWriteoffs(request.query);
    return rejected(['path']);
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const raw = init?.body;
    const request: RequestLog = {
      method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: new Headers(init?.headers),
      body: typeof raw === 'string' && raw !== '' ? (JSON.parse(raw) as unknown) : undefined,
    };
    log.push(request);
    inFlight += 1;
    try {
      const index = overrides.findIndex(
        (entry) =>
          entry.method === request.method &&
          entry.path === request.path &&
          (entry.when === undefined || entry.when(request)),
      );
      return await (index < 0 ? normal(request) : overrides.splice(index, 1)[0]!.reply(request));
    } finally {
      inFlight -= 1;
    }
  };

  return {
    log,
    fetch,
    permissions,
    get pending() {
      return inFlight;
    },
    requests(method: string, path?: string) {
      return log.filter((r) => r.method === method && (path === undefined || r.path === path));
    },
    /** Every request (any method) to `path` or below it. */
    requestsUnder(path: string) {
      return log.filter((r) => r.path === path || r.path.startsWith(`${path}/`));
    },
    /** The table reads of the list at `path` (count reads with page_size=1 aside). */
    tableReads(path: string) {
      return log.filter((r) => isTableRead(r, path));
    },
    /** GET /admin/v1/adjustments/{adjust_id}. */
    detailReads(adjustId: string) {
      return log.filter((r) => r.method === 'GET' && r.path === adjustmentPath(adjustId));
    },
    /** Requests that are not one of the three GETs of this page. */
    others() {
      return log.filter(
        (r) =>
          r.method !== 'GET' ||
          !(r.path === ADJUSTMENTS || DETAIL.test(r.path) || r.path === WRITEOFFS),
      );
    },
    /** Answers the next request of `method` `path` (matching `when`) with `reply`. */
    once(method: string, path: string, reply: Reply, when?: When) {
      overrides.push({ method, path, when, reply });
    },
    /** Holds the next request of `method` `path` (matching `when`) until the returned call. */
    hold(method: string, path: string, when?: When) {
      const gate = Promise.withResolvers<void>();
      overrides.push({
        method,
        path,
        when,
        reply: async (request) => {
          await gate.promise;
          return normal(request);
        },
      });
      return gate.resolve;
    },
  };
}
export type Server = ReturnType<typeof createServer>;
