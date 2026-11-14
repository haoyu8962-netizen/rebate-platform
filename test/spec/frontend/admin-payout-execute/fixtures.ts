import { addFen, formatYuanAdmin, parseFen, subFen } from '@couli/money';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  PHONE,
  TRACE_ID,
  USER,
  ok,
  type Grants,
  type RequestLog,
  type RequestMatch,
  type Withdrawal,
} from '../admin-withdrawals/fixtures.ts';
import {
  QID,
  QNO,
  VIEW,
  VIEW_EXECUTE,
  allowedHere,
  approvedFiller,
  fillerNo,
  overview,
  pausedOverview,
  queueSamples,
  type Overview,
  type OverviewChannel,
} from '../admin-payouts-readonly/fixtures.ts';

// Contract-shaped fixtures of 【执行所选】 on the 打款队列 tab (F1-08bb; contracts/openapi.yaml
// adminCreatePayoutBatch POST /admin/v1/payout-batches: payout.execute, totp step-up, body
// AdminPayoutBatchCreateRequest {withdrawal_ids}, Idempotency-Key required, answer
// AdminPayoutBatchResult). The frozen read-only fixtures (F1-08ba) are reused underneath; the
// dynamic-code verification POST /admin/v1/auth/step-up and the batch POST are scripted per test.
// Ids are obvious fake UUIDs; amounts and admins are samples.
export { QID, QNO, VIEW, VIEW_EXECUTE, approvedFiller, fillerNo, ok, overview, pausedOverview };
export type { Grants, Overview, OverviewChannel, RequestLog, RequestMatch, Withdrawal };

export const BATCHES = '/admin/v1/payout-batches';
export const VERIFY = '/admin/v1/auth/step-up';

export type BatchRequest = Schema<'AdminPayoutBatchCreateRequest'>;
export type BatchResult = Schema<'AdminPayoutBatchResult'>;
export type LeftItem = Schema<'AdminPayoutBatchLeftItem'>;
export type LeftReason = LeftItem['reason'];
export type RefusedReason = NonNullable<BatchResult['reason']>;
export type PayoutChannel = NonNullable<BatchResult['channel']>;

/** One more APPROVED alipay withdrawal (待执行) besides the frozen queue samples. */
export const CID = 'e2000009-0000-4000-8000-000000000009';
export const CNO = 'W20261113000209';
/** The batch the server answers an executed batch with. */
export const NEW_BATCH = 'b2000009-0000-4000-8000-000000000009';

/**
 * The queue samples (F1-08ba) with the extra alipay row C (applied 2026-11-13 09:30, between A and
 * the PAYING sample) and `fillers` older APPROVED alipay rows (approvedFiller).
 */
export function executeSamples(fillers = 0): Withdrawal[] {
  const rows = queueSamples();
  const a = rows.find((row) => row.withdrawal_id === QID.approvedA)!;
  const c: Withdrawal = {
    ...structuredClone(a),
    withdrawal_id: CID,
    out_biz_no: CNO,
    user: { user_id: USER.b, phone_masked: PHONE.b },
    amount_fen: 9999,
    fee_fen: 11,
    tax_fen: 0,
    net_fen: 9988,
    reviewed_at: '2026-11-13T09:45:00+08:00',
    created_at: '2026-11-13T09:30:00+08:00',
    updated_at: '2026-11-13T09:45:00+08:00',
  };
  return [...rows, c, ...approvedFiller(fillers)];
}

/** The rows of 全部 for executeSamples(fillers), newest applied first. */
export function allRows(fillers = 0): string[] {
  return [
    QNO.approvedA,
    CNO,
    QNO.paying,
    QNO.approvedB,
    QNO.stuck,
    QNO.untried,
    ...Array.from({ length: fillers }, (_, index) => fillerNo(index + 1)),
  ];
}

/** The ids of approvedFiller rows (1-based). */
export const fillerId = (n: number): string =>
  `e2f00000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

/** fund.view + payout.execute; payout.execute asks for the totp tier (BR-ID-34). */
export const EXECUTOR: PermissionSnapshot = {
  isSuper: false,
  permissions: VIEW_EXECUTE,
  stepUp: {
    'fund.view': { tier: null, operations: {} },
    'payout.execute': { tier: 'totp', operations: {} },
  },
};
/** fund.view only: reads, no execution. */
export const VIEWER: PermissionSnapshot = {
  isSuper: false,
  permissions: VIEW,
  stepUp: { 'fund.view': { tier: null, operations: {} } },
};
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };

// ---- overviews -------------------------------------------------------------------------------

/** The sample overview with only the switches changed. */
export function switchedOverview(payoutEnabled: boolean, queuePaused: boolean): Overview {
  return { ...overview(), payout_enabled: payoutEnabled, queue_paused: queuePaused };
}

/** The sample overview with the alipay channel and the daily figures replaced. */
export function alipayOverview(
  channel: Partial<OverviewChannel>,
  daily: Partial<Pick<Overview, 'daily_cap_fen' | 'daily_sent_fen' | 'as_of'>> = {},
): Overview {
  const sample = overview();
  return {
    ...sample,
    ...daily,
    channels: [{ ...sample.channels[0]!, ...channel }, sample.channels[1]!, sample.channels[2]!],
  };
}

// ---- answers ---------------------------------------------------------------------------------

export function executed(paying: readonly string[], left: readonly LeftItem[]): BatchResult {
  return {
    outcome: 'executed',
    batch_id: NEW_BATCH,
    reason: null,
    channel: null,
    paying: [...paying],
    left: [...left],
  };
}

export function refused(reason: RefusedReason, channel: PayoutChannel | null = null): BatchResult {
  return { outcome: 'rejected', batch_id: null, reason, channel, paying: [], left: [] };
}

// HTTP statuses as in contracts/error-codes.yaml.
const STATUS: Readonly<Record<number, number>> = {
  10003: 403,
  10403: 403,
  20001: 400,
  20901: 409,
  40901: 409,
  50001: 500,
};
/** An error envelope with its contract HTTP status. */
export function failed(code: number, data: unknown = {}): Response {
  return Response.json(
    { code, msg: '', data, trace_id: TRACE_ID },
    { status: STATUS[code] ?? 400 },
  );
}

/** A verified dynamic code: the pass `n` (1-based) the server issues. */
export const passOf = (n: number): string => `execute-pass-${n}`;
export function verified(n: number): Response {
  return ok({ ['step_up_token']: passOf(n), tier: 'totp', expire_at: '2099-01-01T00:00:00Z' });
}

export const postOf =
  (path: string): RequestMatch =>
  (request) =>
    request.method === 'POST' && request.path === path;

/** The requests of this page: the read-only tab's reads, the verification and the batch POST. */
export function allowedHereToo(request: RequestLog): boolean {
  return (
    allowedHere(request) ||
    (request.method === 'POST' && (request.path === VERIFY || request.path === BATCHES))
  );
}

// ---- what the page shows (independent full-copy expectations, not imports of its texts) -----

/** An amount in fen as the console shows it (only through @couli/money). */
export function yuan(fen: number): string {
  return formatYuanAdmin(parseFen(fen));
}
/** The sum of the net amounts of `rows`, shown. */
export function netSum(rows: readonly Withdrawal[]): string {
  let total = parseFen(0);
  for (const row of rows) total = addFen(total, parseFen(row.net_fen));
  return formatYuanAdmin(total);
}
/** daily_cap_fen − daily_sent_fen of `view`, shown. */
export function dailyLeft(view: Overview): string {
  return formatYuanAdmin(subFen(parseFen(view.daily_cap_fen), parseFen(view.daily_sent_fen)));
}

export const ENTRY = '执行所选';
export const SUBMIT = '确认执行';
export const CANCEL = '取消';
export const STEP_TITLE = '二次验证 · 动态码';
export const STEP_FIELD = '动态码';
export const STEP_SUBMIT = '验证并继续';
export const CODE = '123456';

/** The heading of the pre-check list in the confirmation dialog. */
export const CHECK_TITLE = '执行前检查';
/** Headers of the execution list in the confirmation dialog. */
export const PREVIEW_HEADERS = ['提现单号', '用户', '实付金额'] as const;
/** The selection bar (aria-live): count and net sum. */
export const selectedText = (count: number, sum: string): string =>
  `已选 ${count} 张，合计实付 ${sum}`;
/** The note under the checks; `time` is as_of in Beijing time. */
export const recheckNote = (time: string): string =>
  `以上按打款概览（数据时间 ${time}）预检；提交后服务端会再检查一次，以服务端结果为准。`;

/** Why 【执行所选】 is not offered (shown in the queue tab once rows are selected). */
export const OFF_NOTE = {
  payout: '打款开关已关闭：不能执行打款',
  queue: '打款队列已暂停：不能执行打款',
} as const;

/** The channel names of the checks and the reasons (the payout channel titles). */
export const CHANNEL_NAME: Readonly<Record<PayoutChannel, string>> = {
  alipay: '企业支付宝',
  bank_card: '银行卡',
  wechat: '微信零钱',
};

/**
 * One pre-check item: `label：value（满足）` or `（未满足）`. Items are compared with every space
 * removed, so the spaces written here only read better.
 */
export const check = (label: string, value: string, met: boolean): string =>
  `${label}：${value}（${met ? '满足' : '未满足'}）`;
export const CHECK = {
  payoutOn: check('打款开关', '已开启', true),
  payoutOff: check('打款开关', '已关闭', false),
  queueRunning: check('队列运行状态', '运行中', true),
  queuePaused: check('队列运行状态', '已暂停', false),
  /** W fresh (the overview has a water level). */
  fresh: (channel: PayoutChannel, w: string, time: string): string =>
    check(`${CHANNEL_NAME[channel]}余额 W`, `${w}，取数时间 ${time}`, true),
  /** W entered but past its limit (no water level). */
  stale: (channel: PayoutChannel, w: string, time: string): string =>
    check(`${CHANNEL_NAME[channel]}余额 W`, `${w}，取数时间 ${time}，已过期`, false),
  /** No W row. */
  unentered: (channel: PayoutChannel): string =>
    check(`${CHANNEL_NAME[channel]}余额 W`, '未录入', false),
  /** W against P with the overview's conclusion; met when W is not below P. */
  level: (channel: PayoutChannel, w: string, p: string, level: string, met: boolean): string =>
    check(`${CHANNEL_NAME[channel]}水位`, `W ${w}，预计提现 P ${p}，${level}`, met),
  /** No water level (no W, or W past its limit). */
  noLevel: (channel: PayoutChannel): string =>
    check(`${CHANNEL_NAME[channel]}水位`, '无结论', false),
  /** daily_cap − daily_sent against the selected net sum; met when the sum fits. */
  daily: (left: string, sum: string, met: boolean): string =>
    check('单日限额余量', `${left}，本次合计 ${sum}`, met),
} as const;

/** The result of a paying withdrawal (admin itemResults.paying). */
export const PAYING_TEXT = '已发起打款';
/** The texts of the withdrawals listed in `left`, by reason. */
export const LEFT_TEXT: Readonly<Record<LeftReason, string>> = {
  not_approved: '单据已不是待执行状态（已被处理或状态已变化），本次未执行',
  member_blocked: '会员有提现阻断，本次未执行',
  has_transfer_attempt: '已有转账记录，只能手动成功或驳回，本次未执行',
  channel_disabled: '该单的打款通道未开通或已暂停，本次未执行',
  watermark_stale: '所在通道的余额 W 未录入或已过期，本次未执行',
  watermark_below_forecast: '所在通道的余额 W 低于预计提现 P，本次未执行',
  watermark_usable_exceeded: '所在通道在途与本批合计超过可用余额，本次未执行',
};
/** The notice of a whole batch refused (`channel` named for a watermark reason). */
export function refusedText(reason: RefusedReason, channel: PayoutChannel | null = null): string {
  const name = channel === null ? '' : CHANNEL_NAME[channel];
  const texts: Readonly<Record<RefusedReason, string>> = {
    payout_disabled: '整批未执行：打款开关已关闭',
    queue_paused: '整批未执行：打款队列已暂停',
    watermark_stale: `整批未执行：${name}余额 W 未录入或已过期，请录入最新余额后重新提交`,
    watermark_below_forecast: `整批未执行：${name}余额 W 低于预计提现 P`,
    watermark_usable_exceeded: `整批未执行：${name}在途与本批合计超过可用余额（W × 可用比例），请拆分批次`,
  };
  return texts[reason];
}

/** Error notices (the same wording as the other payout writes of this console). */
export const NOTICE = {
  again: '动态码凭证已失效，请重新输入动态码',
  forbidden: '无权限执行此操作（需要 payout.execute 权限点）',
  ids: '提现单编号有误，请刷新页面后重试',
  invalid: '提交内容有误，请检查后重试',
  failed: '提交失败，请稍后重试',
  network: '网络错误，请检查网络后重试；未确认前不会重复提交',
} as const;
