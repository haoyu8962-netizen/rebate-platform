import { fenToJsonNumber, yuanStrToFen } from '@couli/money';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type {
  KnownPermission,
  PermissionSnapshot,
  StepUpAnnotation,
} from '../../../../apps/admin/src/providers/access-control/index.ts';
import {
  ADJ,
  ADJUSTMENTS,
  ADMIN,
  DOC,
  TRACE_ID,
  USER,
  WRITEOFFS,
  adjustments,
  ok,
  writeoffs,
  type Adjustment,
  type AdjustmentDetail,
  type Grants,
  type RequestLog,
  type When,
} from '../admin-adjustments-readonly/fixtures.ts';

// Contract of the two writes of this task (contracts/openapi.yaml POST /admin/v1/adjustments,
// adminCreateAdjustment): one submission saves and approves at once (提交并生效); permission point
// fund.adjust; sms-tier step-up (BR-ID-34): POST /admin/v1/auth/step-up/sms-codes sends the code,
// POST /admin/v1/auth/step-up {tier: sms, code} returns the step-up pass, which the write carries
// as the X-Step-Up-Token header; Idempotency-Key is required. The body is one of two closed
// shapes: AdminAdjustmentCreateNew (user_id, direction, amount_fen, reason_code ∈ RECON_FIX /
// PAYOUT_RECOVERY / OTHER, refs, note, contra_subject, contra_platform) or
// AdminAdjustmentCreateReversal (reverses_adjust_id and note only). The fake server below checks
// in the contract's order and keeps the forms it writes, so the list and the detail read them back.
export { ADJ, ADJUSTMENTS, ADMIN, DOC, TRACE_ID, USER, WRITEOFFS, ok, type RequestLog };
export {
  ADJUSTMENT_ORDER,
  COLUMN,
  DIRECTION_NAME,
  FIELD,
  REF_TYPE_NAME,
  TEXT as READ_TEXT,
  reasonName,
  statusName,
  yuan,
} from '../admin-adjustments-readonly/fixtures.ts';

export const SMS_CODES = '/admin/v1/auth/step-up/sms-codes';
export const VERIFY = '/admin/v1/auth/step-up';
/** The SMS code the operator types (contract example). */
export const OTP = '654321';
/** The step-up pass the fake server returns for the `n`-th verification (1-based). */
export const passOf = (n: number): string => `sms-pass-${n}`;

export type CreateNew = Schema<'AdminAdjustmentCreateNew'>;
export type CreateReversal = Schema<'AdminAdjustmentCreateReversal'>;
export type Executed = Schema<'AdminAdjustmentExecuted'>;

/** Integer fen of a yuan string, only through @couli/money (BR-CALC-26). */
export const fenOf = (text: string): number => fenToJsonNumber(yuanStrToFen(text));

// ---- what the page shows (fixed texts this task decides; texts/adjustments.ts holds them) ---

/**
 * Fixed texts of the two writes, compared as whole strings (whitespace collapsed and trimmed).
 * Field labels are antd Form.Item labels (or aria-label) of the control; buttons are matched by
 * their text without spaces.
 */
export const TEXT = {
  /** Entry of the 调账单 page (title row) and the title of the new-adjustment drawer. */
  createEntry: '新建调账',
  createTitle: '新建调账',
  /** The one-step notice at the top of the drawer. */
  oneStep:
    '一步提交并生效：短信验证通过后立即记账，不保存待批、不可撤回；已生效的调账只能整笔红冲后另开新单。',
  /** The submit button of the drawer and of the reversal dialog (fund.adjust is sms tier). */
  submit: '提交并短信验证',
  cancel: '取消',
  /** Row and detail entry of a reversal. */
  reverseEntry: '红冲',
  /** Title of the reversal dialog. */
  reverseTitle: '红冲调账单',
  /** Adds the document typed in 单据类型 / 单据号 to the linked documents. */
  addRef: '添加单据',
  /** The preview line of the drawer once user, direction, a valid amount and a reason are set. */
  preview: (user: string, direction: string, amount: string, reason: string): string =>
    `预览：用户 ${user} ${direction} ${amount}，原因：${reason}`,
  /** Success prompts (the new adjust_id of the response). */
  created: (adjustId: string): string => `调账已生效，调账单号 ${adjustId}`,
  reversed: (adjustId: string): string => `红冲已生效，红冲单号 ${adjustId}`,
} as const;

/** Labels of the drawer's controls (direction is a radio group of 调增 / 调减). */
export const LABEL = {
  user: '用户 ID',
  amount: '金额（元）',
  reason: '原因码',
  refType: '单据类型',
  refId: '单据号',
  note: '原因说明',
  subject: '对方科目',
  platform: '平台',
  /** The reversal dialog's only input. */
  reverseNote: '红冲原因',
} as const;

/** Labels of the reversal dialog's read-only items (each label followed by its value). */
export const SUMMARY = {
  id: '原调账单',
  user: '用户',
  direction: '方向',
  amount: '金额',
  reason: '原因',
  newDirection: '红冲方向',
  newAmount: '红冲金额',
} as const;
export const SUMMARY_LABELS: readonly string[] = Object.values(SUMMARY);
/**
 * The reversal dialog's balance lines (BR-FUND-24 ④, adminGetAdjustment balance_preview): the
 * dialog is where the reversal is approved and executed at once, so it shows `available` before
 * and after, each through @couli/money (a negative after is shown as the negative it is).
 */
export const BALANCE = {
  before: '红冲前可用余额',
  after: '红冲后可用余额',
} as const;

/** Local checks (nothing is sent while one fails) and the contract's refusals, as shown. */
export const ERROR = {
  userRequired: '请输入用户 ID',
  directionRequired: '请选择方向',
  amountInvalid: '请输入大于 0、最多两位小数的金额',
  reasonRequired: '请选择原因码',
  subjectRequired: '请选择对方科目',
  platformRequired: '请选择平台',
  noteRequired: '请填写原因说明',
  noteTooLong: '原因说明最多 500 字',
  reconFixRefs: '对账修正须关联至少 1 张差错单',
  payoutRefs: '打款追回须关联恰好 1 张提现单和至少 1 张差错单',
  refDuplicate: '该单据已添加',
  refLimit: '关联单据最多 10 张',
  reverseNoteRequired: '请填写红冲原因',
  /** 20001 data.fields=[user_id] without a reason. */
  userUnknown: '用户不存在，请核对用户 ID',
  /** 20001 data.reason=adjust_ref_invalid. */
  refInvalid: '关联单据不存在、不属于该用户或不能用于调账，请核对',
  /** 20001 data.reason=adjust_user_deleted (new form or reversal). */
  userDeleted: '该用户已注销或正在注销，不能调账',
  /** 20001 data.reason=reverse_not_allowed. */
  reverseNotAllowed: '该调账单不能红冲：未生效或本身是红冲单',
  /** 20902 data.resource=admin_adjustment on a reversal. */
  alreadyReversed: '该调账单已被红冲，已刷新',
  /** 10403. */
  forbidden: '无权限执行调账',
  /** 20901, 40901, a network failure or a 5xx: nothing is resent by itself. */
  failed: '提交失败，请稍后重试',
  /** BR-TEXT-14 table B error.10003.verify_phone_missing (texts/step-up.ts verifyPhoneMissing). */
  verifyPhoneMissing: '这项操作需要短信验证，请先登记验证手机号',
} as const;

/** contracts/enums/fund.yaml admin_adjustment_contra_subject choosable for RECON_FIX / OTHER. */
export const CHOOSABLE_SUBJECTS: readonly string[] = ['佣金收入', '联盟应收', '坏账', '营销费用'];
/** contracts/enums/platform.yaml platform in contract order, by the console's platform names. */
export const PLATFORM_NAMES: readonly string[] = [
  '淘宝',
  '京东',
  '拼多多',
  '美团',
  '唯品会',
  '抖音',
  '饿了么',
  '快手',
  '苏宁',
];
export type ContraSubject = NonNullable<CreateNew['contra_subject']>;
export type ContraPlatform = NonNullable<CreateNew['contra_platform']>;
/** Each choosable 对方科目 by its name, with the code the body must carry. */
export const SUBJECT_CHOICES: readonly (readonly [string, ContraSubject])[] = [
  ['佣金收入', 'COMMISSION_REVENUE'],
  ['联盟应收', 'UNION_RECEIVABLE'],
  ['坏账', 'BAD_DEBT'],
  ['营销费用', 'MKT_EXPENSE'],
];
/** Each platform (contracts/enums/platform.yaml order) by its name, with the code of the body. */
export const PLATFORM_CHOICES: readonly (readonly [string, ContraPlatform])[] = [
  ['淘宝', 'taobao'],
  ['京东', 'jd'],
  ['拼多多', 'pdd'],
  ['美团', 'meituan'],
  ['唯品会', 'vip'],
  ['抖音', 'douyin'],
  ['饿了么', 'eleme'],
  ['快手', 'kuaishou'],
  ['苏宁', 'suning'],
];
/** The reason codes a person may choose (RESTORE and ACCOUNT_CLOSED never offered). */
export const CHOOSABLE_REASONS = ['RECON_FIX', 'PAYOUT_RECOVERY', 'OTHER'] as const;

/** Write entries of the later tasks (F1-08cc / cd) and the dropped 保存待批 / 撤回. */
export const LATER_ENTRIES: readonly string[] = [
  '批准',
  '批准并短信验证',
  '驳回',
  '批准核销',
  '核销',
  '撤回',
  '保存待批',
];

// ---- permissions ---------------------------------------------------------------------------

function annotated(points: Grants, tier: StepUpAnnotation['tier']): PermissionSnapshot {
  const stepUp: Partial<Record<KnownPermission, StepUpAnnotation>> = {};
  for (const point of points)
    stepUp[point] = { tier: point === 'fund.adjust' ? tier : null, operations: {} };
  return { isSuper: false, permissions: points, stepUp };
}
/** fund.adjust with its sms tier (04 §11; the contract example of GET /admin/v1/me/permissions). */
export const ADJUSTER: PermissionSnapshot = annotated(['fund.adjust'], 'sms');
/** fund.view and fund.writeoff: reads both tabs, writes nothing of this task. */
export const READER: PermissionSnapshot = annotated(['fund.view', 'fund.writeoff'], null);
export const WRITEOFF_ONLY: PermissionSnapshot = annotated(['fund.writeoff'], null);
export const SUPER_ADMIN: PermissionSnapshot = {
  isSuper: true,
  permissions: [],
  stepUp: { 'fund.adjust': { tier: 'sms', operations: {} } },
};
export const ALL_FUND: Grants = ['fund.adjust', 'fund.view', 'fund.writeoff'];

// ---- samples of this task ------------------------------------------------------------------

/** adjust_id of the `n`-th form the fake server writes (1-based, ≤ 8); newer than every sample. */
export const createdId = (n: number): string => `ad20000${n}-0000-4000-8000-00000000000${n}`;
/** A UID the server does not know (20001 data.fields=[user_id]). */
export const UNKNOWN_USER = USER.unknown;
/** A document id that names nothing of the app (20001 adjust_ref_invalid). */
export const UNKNOWN_DOC = 'd9999999-0000-4000-8000-000000000999';
/** Further differences the app knows (for the limit of 10 linked documents). */
export const extraDiff = (n: number): string =>
  `d30000${String(n).padStart(2, '0')}-0000-4000-8000-000000000000`;
export const NOTE = {
  reconFix: 'R2 差错单更正：联盟补结算佣金',
  service: '客服核实：企业微信沟通，补发活动奖励',
  reversal: '差错单核对有误，整笔冲回',
} as const;
/** available before every write of the fake server. */
export const AVAILABLE_BEFORE = 50000;

/** An APPROVED PAYOUT_RECOVERY decrease of 3000 fen, not reversed (older than every sample). */
export const OPEN_DECREASE = 'ad100009-0000-4000-8000-000000000009';
export const OPEN_DECREASE_FEN = 3000;
/** The sample behind OPEN_DECREASE (pass it as `extra`; it lists after ADJUSTMENT_ORDER). */
export function openDecrease(): Adjustment {
  return {
    adjust_id: OPEN_DECREASE,
    user_id: USER.payee,
    direction: 'decrease',
    amount_fen: OPEN_DECREASE_FEN,
    reason_code: 'PAYOUT_RECOVERY',
    status: 'APPROVED',
    refs: [
      { ref_type: 'withdrawal', ref_id: DOC.withdrawal },
      { ref_type: 'recon_diff', ref_id: DOC.payoutDiff },
    ],
    contra_subject: 'CASH_ALIPAY',
    contra_platform: null,
    note: '重复打款，追回',
    reverses_adjust_id: null,
    reversed_by_adjust_id: null,
    created_by: ADMIN.first,
    created_at: '2026-11-01T10:00:00+08:00',
    reviewed_by: ADMIN.first,
    reviewed_at: '2026-11-01T10:00:00+08:00',
    reject_note: null,
    voucher_id: 'f1000009-0000-4000-8000-000000000009',
  };
}

// ---- envelopes -----------------------------------------------------------------------------

// HTTP statuses as in contracts/error-codes.yaml.
const HTTP_STATUS: Readonly<Record<number, number>> = {
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20002: 400,
  20901: 409,
  20902: 409,
  40901: 409,
  50001: 500,
};
/** An error envelope; `data` is left out when undefined. */
export function failure(code: number, data?: unknown, msg = '参数错误'): Response {
  const envelope: Record<string, unknown> = { code, msg, trace_id: TRACE_ID };
  if (data !== undefined) envelope['data'] = data;
  return Response.json(envelope, { status: HTTP_STATUS[code] ?? 400 });
}
export function rejected(fields: readonly string[], reason?: string): Response {
  return failure(20001, reason === undefined ? { fields } : { fields, reason });
}
export function denied(): Response {
  return failure(10403, { reason: 'admin_permission_denied' }, '无权限');
}
export function stepUpRequired(): Response {
  return failure(10003, { tier: 'sms' }, '这项操作需要短信验证');
}
export function phoneMissing(): Response {
  return failure(10003, { tier: 'sms', reason: 'verify_phone_missing' }, ERROR.verifyPhoneMissing);
}
export function alreadyReversed(): Response {
  return failure(20902, { resource: 'admin_adjustment' }, '状态已变化，请刷新后重试');
}
export function unavailable(): Response {
  return failure(50001, undefined, '服务暂时不可用');
}
export function stillRunning(): Response {
  return failure(40901, undefined, '请求正在处理');
}
export function conflict(): Response {
  return failure(20901, undefined, '幂等键冲突');
}

// ---- fake server ---------------------------------------------------------------------------

type Reply = (request: RequestLog) => Response | Promise<Response>;

export interface WriteServerOptions {
  /** Permission points of the account (the server checks them; 10403 otherwise). */
  readonly permissions?: Grants;
  /** false: the account has no registered verify phone (10003 verify_phone_missing). */
  readonly verifyPhone?: boolean;
  /** Further forms after the eight samples (e.g. openDecrease()). */
  readonly extra?: readonly Adjustment[];
}

const POSITIVE = /^[1-9][0-9]*$/;
const DETAIL = /^\/admin\/v1\/adjustments\/([^/]+)$/;
const NEW_FIELDS: ReadonlySet<string> = new Set([
  'user_id',
  'direction',
  'amount_fen',
  'reason_code',
  'refs',
  'note',
  'contra_subject',
  'contra_platform',
]);
const REVERSAL_FIELDS: ReadonlySet<string> = new Set(['reverses_adjust_id', 'note']);
const DIRECTIONS: ReadonlySet<unknown> = new Set(['increase', 'decrease']);
const REASONS: ReadonlySet<unknown> = new Set(CHOOSABLE_REASONS);
const REF_TYPES: ReadonlySet<unknown> = new Set([
  'recon_diff',
  'withdrawal',
  'order',
  'account_deletion',
]);
const SUBJECTS: ReadonlySet<unknown> = new Set([
  'COMMISSION_REVENUE',
  'UNION_RECEIVABLE',
  'BAD_DEBT',
  'MKT_EXPENSE',
]);
const PLATFORMS: ReadonlySet<unknown> = new Set([
  'taobao',
  'jd',
  'pdd',
  'meituan',
  'vip',
  'douyin',
  'eleme',
  'kuaishou',
  'suning',
]);
const KNOWN_USERS: ReadonlySet<string> = new Set(
  Object.values(USER).filter((id) => id !== USER.unknown),
);

/** Documents the app knows, by type. */
function knownDocs(): Record<string, Set<string>> {
  const extra = Array.from({ length: 12 }, (_, index) => extraDiff(index + 1));
  return {
    recon_diff: new Set([DOC.payoutDiff, DOC.reconDiff, DOC.restoreDiff, ...extra]),
    withdrawal: new Set([DOC.withdrawal]),
    order: new Set([DOC.order]),
    account_deletion: new Set(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Own property names of a request object. */
function namesOf(value: Record<string, unknown>): string[] {
  return Object.getOwnPropertyNames(value);
}
function validNote(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 500;
}
function validRef(ref: unknown): boolean {
  if (!isRecord(ref)) return false;
  const id = ref['ref_id'];
  return (
    namesOf(ref).every((name) => name === 'ref_type' || name === 'ref_id') &&
    REF_TYPES.has(ref['ref_type']) &&
    typeof id === 'string' &&
    id !== '' &&
    id.length <= 128
  );
}
function validRefs(refs: unknown): boolean {
  return refs === undefined || (Array.isArray(refs) && refs.length <= 10 && refs.every(validRef));
}
function fitsNew(body: Record<string, unknown>): boolean {
  const amount = body['amount_fen'];
  return (
    namesOf(body).every((name) => NEW_FIELDS.has(name)) &&
    typeof body['user_id'] === 'string' &&
    DIRECTIONS.has(body['direction']) &&
    typeof amount === 'number' &&
    Number.isSafeInteger(amount) &&
    amount >= 1 &&
    REASONS.has(body['reason_code']) &&
    validRefs(body['refs']) &&
    (body['note'] === undefined || validNote(body['note'])) &&
    (body['contra_subject'] === undefined || SUBJECTS.has(body['contra_subject'])) &&
    (body['contra_platform'] === undefined || PLATFORMS.has(body['contra_platform']))
  );
}
function fitsReversal(body: Record<string, unknown>): boolean {
  return (
    namesOf(body).every((name) => REVERSAL_FIELDS.has(name)) &&
    typeof body['reverses_adjust_id'] === 'string' &&
    validNote(body['note'])
  );
}
/** The two closed shapes of AdminAdjustmentCreateRequest (schema level only). */
function fitsSchema(body: unknown): 'new' | 'reversal' | undefined {
  if (!isRecord(body)) return undefined;
  if (fitsReversal(body)) return 'reversal';
  return fitsNew(body) ? 'new' : undefined;
}

/** created_at descending, then the id descending. */
function newestFirst(a: Adjustment, b: Adjustment): number {
  const diff = Date.parse(b.created_at) - Date.parse(a.created_at);
  if (diff !== 0) return diff;
  return a.adjust_id < b.adjust_id ? 1 : a.adjust_id > b.adjust_id ? -1 : 0;
}
function pageOf<T>(rows: readonly T[], page: string | undefined, size: string | undefined) {
  const pageNo = page !== undefined && POSITIVE.test(page) ? Number(page) : 1;
  const pageSize = size !== undefined && POSITIVE.test(size) ? Math.min(Number(size), 200) : 20;
  const items = rows.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  return { items, page: pageNo, page_size: pageSize, total: rows.length };
}
function opposite(direction: Adjustment['direction']): Adjustment['direction'] {
  return direction === 'increase' ? 'decrease' : 'increase';
}
function after(direction: Adjustment['direction'], amount: number): number {
  return direction === 'increase' ? AVAILABLE_BEFORE + amount : AVAILABLE_BEFORE - amount;
}
function isTableRead(request: RequestLog, path: string): boolean {
  return request.method === 'GET' && request.path === path && request.query['page_size'] !== '1';
}
/** One of the three reads of the page. */
function isRead(request: RequestLog): boolean {
  if (request.method !== 'GET') return false;
  const { path } = request;
  return path === ADJUSTMENTS || DETAIL.test(path) || path === WRITEOFFS;
}
/** The sms step-up pair or adminCreateAdjustment. */
function isWriteFlow(request: RequestLog): boolean {
  return request.method === 'POST' && [SMS_CODES, VERIFY, ADJUSTMENTS].includes(request.path);
}

type Draft = Omit<Adjustment, 'adjust_id' | 'created_at' | 'reviewed_at' | 'voucher_id'>;

/**
 * Fake /admin/v1 server: the three reads of F1-08ca over a mutable set of forms, the sms step-up
 * pair, and adminCreateAdjustment. Its shape is a superset of the frozen read-only server, so the
 * frozen mount / openDetail / settled helpers take it.
 */
export function createWriteServer(options: WriteServerOptions = {}) {
  const forms: Adjustment[] = structuredClone([...adjustments(), ...(options.extra ?? [])]);
  const candidates = structuredClone(writeoffs());
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; when: When | undefined; reply: Reply }[] = [];
  const permissions: Grants = options.permissions ?? ['fund.adjust'];
  const verifyPhone = options.verifyPhone ?? true;
  const docs = knownDocs();
  /** Step-up passes issued and not used yet (a pass serves one write). */
  const passes = new Set<string>();
  const results = new Map<string, { body: string; response: Response }>();
  let verified = 0;
  let written = 0;
  let inFlight = 0;

  const holds = (point: KnownPermission): boolean => permissions.includes(point);
  const readsAdjustments = (): boolean => holds('fund.adjust') || holds('fund.view');
  const readsWriteoffs = (): boolean => holds('fund.writeoff') || holds('fund.view');

  function listAdjustments(query: Record<string, string>): Response {
    if (!readsAdjustments()) return denied();
    const { page, page_size: size, reason_code: reason, status, user_id: user } = query;
    const matching = forms
      .filter(
        (form) =>
          (reason === undefined || form.reason_code === reason) &&
          (status === undefined || form.status === status) &&
          (user === undefined || form.user_id === user),
      )
      .sort(newestFirst);
    return ok(pageOf(matching, page, size));
  }

  function getAdjustment(adjustId: string): Response {
    if (!readsAdjustments()) return denied();
    const found = forms.find((form) => form.adjust_id === adjustId);
    if (found === undefined) return rejected(['adjust_id']);
    const amount = found.amount_fen;
    const open =
      found.status === 'APPROVED' &&
      found.reverses_adjust_id === null &&
      found.reversed_by_adjust_id === null;
    let preview: AdjustmentDetail['balance_preview'] = null;
    if (open && amount !== null) {
      const direction = opposite(found.direction);
      preview = {
        direction,
        amount_fen: amount,
        available_before_fen: AVAILABLE_BEFORE,
        available_after_fen: after(direction, amount),
      };
    }
    const detail: AdjustmentDetail = { adjustment: found, balance_preview: preview };
    return ok(detail);
  }

  function listWriteoffs(query: Record<string, string>): Response {
    if (!readsWriteoffs()) return denied();
    return ok(pageOf(candidates, query['page'], query['page_size']));
  }

  function sendCode(): Response {
    if (!verifyPhone) return phoneMissing();
    return ok({ resend_after_sec: 60, expires_in_sec: 300 });
  }

  function verify(body: unknown): Response {
    if (!isRecord(body) || body['tier'] !== 'sms' || typeof body['code'] !== 'string')
      return rejected(['tier']);
    if (!verifyPhone) return phoneMissing();
    if (body['code'] !== OTP) return failure(20002, undefined, '验证码错误');
    verified += 1;
    const pass = passOf(verified);
    passes.add(pass);
    return ok({ ['step_up_token']: pass, tier: 'sms', expire_at: '2099-01-01T00:00:00Z' });
  }

  /** Writes a form in effect (status APPROVED, reviewed by its creator). */
  function execute(draft: Draft): Executed {
    written += 1;
    const at = `2026-12-0${String(1 + written)}T10:00:00+08:00`;
    const adjustment: Adjustment = {
      ...draft,
      adjust_id: createdId(written),
      created_at: at,
      reviewed_at: at,
      voucher_id: `f900000${written}-0000-4000-8000-000000000000`,
    };
    forms.push(adjustment);
    return {
      adjustment,
      available_before_fen: AVAILABLE_BEFORE,
      available_after_fen: after(adjustment.direction, adjustment.amount_fen ?? 0),
    };
  }

  /** The reversal of `original` written by `admin` (the original is marked reversed). */
  function reverse(original: Adjustment, note: string, admin: string): Executed {
    const executed = execute({
      user_id: original.user_id,
      direction: opposite(original.direction),
      amount_fen: original.amount_fen,
      reason_code: original.reason_code,
      refs: [],
      contra_subject: original.contra_subject,
      contra_platform: original.contra_platform,
      note,
      status: 'APPROVED',
      reverses_adjust_id: original.adjust_id,
      reversed_by_adjust_id: null,
      created_by: admin,
      reviewed_by: admin,
      reject_note: null,
    });
    original.reversed_by_adjust_id = executed.adjustment.adjust_id;
    return executed;
  }

  function createNew(body: CreateNew): Response {
    const refs = body.refs ?? [];
    const count = (type: string): number => refs.filter((ref) => ref.ref_type === type).length;
    const seen = new Set(refs.map((ref) => `${ref.ref_type}:${ref.ref_id}`));
    if (seen.size !== refs.length) return rejected(['refs']);
    if (body.reason_code === 'RECON_FIX' && count('recon_diff') < 1) return rejected(['refs']);
    if (
      body.reason_code === 'PAYOUT_RECOVERY' &&
      (count('recon_diff') < 1 || count('withdrawal') !== 1)
    )
      return rejected(['refs']);
    if (body.reason_code === 'OTHER' && body.note === undefined) return rejected(['note']);
    if (body.reason_code === 'PAYOUT_RECOVERY') {
      if (body.contra_subject !== undefined) return rejected(['contra_subject']);
      if (body.contra_platform !== undefined) return rejected(['contra_platform']);
    } else {
      if (body.contra_subject === undefined) return rejected(['contra_subject']);
      if ((body.contra_subject === 'UNION_RECEIVABLE') !== (body.contra_platform !== undefined))
        return rejected(['contra_platform']);
    }
    if (!KNOWN_USERS.has(body.user_id)) return rejected(['user_id']);
    if (refs.some((ref) => docs[ref.ref_type]?.has(ref.ref_id) !== true))
      return rejected(['refs'], 'adjust_ref_invalid');
    const executed = execute({
      user_id: body.user_id,
      direction: body.direction,
      amount_fen: body.amount_fen,
      reason_code: body.reason_code,
      refs,
      contra_subject: body.contra_subject ?? 'CASH_ALIPAY',
      contra_platform: body.contra_platform ?? null,
      note: body.note ?? null,
      status: 'APPROVED',
      reverses_adjust_id: null,
      reversed_by_adjust_id: null,
      created_by: ADMIN.first,
      reviewed_by: ADMIN.first,
      reject_note: null,
    });
    return ok(executed);
  }

  function createReversal(body: CreateReversal): Response {
    const original = forms.find((form) => form.adjust_id === body.reverses_adjust_id);
    if (original === undefined) return rejected(['reverses_adjust_id']);
    if (original.reversed_by_adjust_id !== null) return alreadyReversed();
    if (original.status !== 'APPROVED' || original.reverses_adjust_id !== null)
      return rejected(['reverses_adjust_id'], 'reverse_not_allowed');
    return ok(reverse(original, body.note, ADMIN.first));
  }

  function create(request: RequestLog): Response {
    if (!holds('fund.adjust')) return denied();
    if (!verifyPhone) return phoneMissing();
    const pass = request.headers.get('X-Step-Up-Token');
    if (pass === null || !passes.has(pass)) return stepUpRequired();
    passes.delete(pass);
    const idem = request.headers.get('Idempotency-Key') ?? '';
    if (idem === '') return rejected(['Idempotency-Key']);
    const text = JSON.stringify(request.body);
    const first = results.get(idem);
    if (first !== undefined) return first.body === text ? first.response.clone() : conflict();
    const shape = fitsSchema(request.body);
    let response: Response;
    if (shape === 'new') response = createNew(request.body as CreateNew);
    else if (shape === 'reversal') response = createReversal(request.body as CreateReversal);
    else response = rejected(['body']);
    results.set(idem, { body: text, response: response.clone() });
    return response;
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
    if (method === 'POST' && path === SMS_CODES) return sendCode();
    if (method === 'POST' && path === VERIFY) return verify(request.body);
    if (method === 'POST' && path === ADJUSTMENTS) return create(request);
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
    /** The forms as the server holds them now. */
    forms,
    get pending() {
      return inFlight;
    },
    requests(method: string, path?: string) {
      return log.filter((r) => r.method === method && (path === undefined || r.path === path));
    },
    requestsUnder(path: string) {
      return log.filter((r) => r.path === path || r.path.startsWith(`${path}/`));
    },
    tableReads(path: string) {
      return log.filter((r) => isTableRead(r, path));
    },
    detailReads(adjustId: string) {
      return log.filter((r) => r.method === 'GET' && r.path === `${ADJUSTMENTS}/${adjustId}`);
    },
    others() {
      return log.filter((r) => !isRead(r));
    },
    /** POST /admin/v1/adjustments (adminCreateAdjustment). */
    writes() {
      return log.filter((r) => r.method === 'POST' && r.path === ADJUSTMENTS);
    },
    /** POST /admin/v1/auth/step-up/sms-codes. */
    codeSends() {
      return log.filter((r) => r.method === 'POST' && r.path === SMS_CODES);
    },
    /** POST /admin/v1/auth/step-up. */
    verifications() {
      return log.filter((r) => r.method === 'POST' && r.path === VERIFY);
    },
    /** Requests other than the reads of the page, the step-up pair and adminCreateAdjustment. */
    unexpected() {
      return log.filter((r) => !isRead(r) && !isWriteFlow(r));
    },
    /** Someone else reverses `adjustId` meanwhile (the race behind 20902). */
    reverseElsewhere(adjustId: string): void {
      const original = forms.find((form) => form.adjust_id === adjustId);
      if (original !== undefined) reverse(original, NOTE.reversal, ADMIN.second);
    },
    once(method: string, path: string, reply: Reply, when?: When) {
      overrides.push({ method, path, when, reply });
    },
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
export type WriteServer = ReturnType<typeof createWriteServer>;
