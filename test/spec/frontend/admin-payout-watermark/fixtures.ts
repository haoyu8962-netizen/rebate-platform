import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  CHANNEL_NAME,
  CODE,
  CANCEL,
  STEP_FIELD,
  STEP_SUBMIT,
  STEP_TITLE,
  VERIFY,
  failed,
  ok,
  passOf,
  postOf,
  verified,
  yuan,
  type Grants,
  type Overview,
  type OverviewChannel,
  type RequestLog,
} from '../admin-payout-execute/fixtures.ts';
import {
  ENTERED_BY,
  OVERVIEW,
  allowedHere,
  getOf,
  overview,
} from '../admin-payouts-readonly/fixtures.ts';

// Contract-shaped fixtures of 【录入企业支付宝余额】 / 【录入运营账户余额】 on the 打款队列 tab (F1-08bc;
// contracts/openapi.yaml adminCreatePayoutWatermark POST /admin/v1/payout-watermarks: permission
// point fund.cash_entry, totp step-up, body AdminPayoutWatermarkCreateRequest {channel alipay |
// wechat, available_fen integer ≥ 0, measured_at date-time, note optional 1–500 and not blank},
// Idempotency-Key required, answer AdminPayoutWatermarkCreateResponse {watermark}). The frozen
// payout server (F1-08ba) answers the reads; the dynamic-code verification and the watermark POST
// are scripted per test. Ids are obvious fake UUIDs; amounts and admins are samples.
export { CANCEL, CHANNEL_NAME, CODE, STEP_FIELD, STEP_SUBMIT, STEP_TITLE, VERIFY };
export { failed, getOf, ok, overview, passOf, postOf, verified, yuan, OVERVIEW };
export type { Grants, Overview, OverviewChannel, RequestLog };

export const WATERMARKS = '/admin/v1/payout-watermarks';

export type WatermarkRequest = Schema<'AdminPayoutWatermarkCreateRequest'>;
export type Watermark = Schema<'AdminPayoutWatermark'>;
export type WatermarkChannel = Schema<'AdminPayoutWatermarkChannel'>;

/** The row id the server answers a new entry with. */
export const NEW_WATERMARK = 'c3000001-0000-4000-8000-0000000000c1';

// ---- accounts --------------------------------------------------------------------------------

/** fund.view (the page and the overview) + fund.cash_entry (the entries; totp tier, BR-ID-34). */
export const CASHIER_GRANTS: Grants = ['fund.view', 'fund.cash_entry'];
export const CASHIER: PermissionSnapshot = {
  isSuper: false,
  permissions: CASHIER_GRANTS,
  stepUp: {
    'fund.view': { tier: null, operations: {} },
    'fund.cash_entry': { tier: 'totp', operations: {} },
  },
};
/** fund.view only: reads, no entry. */
export const VIEWER: PermissionSnapshot = {
  isSuper: false,
  permissions: ['fund.view'],
  stepUp: { 'fund.view': { tier: null, operations: {} } },
};
/** fund.view + payout.execute: executes batches, still no entry. */
export const EXECUTOR: PermissionSnapshot = {
  isSuper: false,
  permissions: ['fund.view', 'payout.execute'],
  stepUp: {
    'fund.view': { tier: null, operations: {} },
    'payout.execute': { tier: 'totp', operations: {} },
  },
};

// ---- overviews -------------------------------------------------------------------------------

/** The sample overview with the watermark of `channel` replaced. */
export function overviewWithW(
  channel: 'alipay' | 'wechat',
  watermark: OverviewChannel['watermark'],
): Overview {
  const sample = overview();
  const replace = (item: OverviewChannel): OverviewChannel =>
    item.channel === channel ? { ...item, watermark } : item;
  return { ...sample, channels: sample.channels.map(replace) };
}

/** The overview the page reads after an entry of `row` (that channel's W is the new row). */
export function overviewAfter(row: Watermark): Overview {
  return overviewWithW(row.channel, {
    available_fen: row.available_fen,
    measured_at: row.measured_at,
    entered_by: row.entered_by,
    entered_by_name: row.entered_by_name,
  });
}

/** The row the server answers for `body`. */
export function rowOf(body: WatermarkRequest): Watermark {
  return {
    watermark_id: NEW_WATERMARK,
    channel: body.channel,
    available_fen: body.available_fen,
    measured_at: body.measured_at,
    entered_by: ENTERED_BY,
    entered_by_name: 'ops01',
    created_at: '2026-11-14T10:01:00+08:00',
  };
}

// ---- requests --------------------------------------------------------------------------------

/** The requests of this page: the read-only tab's reads, the verification and the watermark POST. */
export function allowedHereToo(request: RequestLog): boolean {
  return (
    allowedHere(request) ||
    (request.method === 'POST' && (request.path === VERIFY || request.path === WATERMARKS))
  );
}

// ---- what the page shows (independent full-copy expectations, not imports of its texts) -----

/** The two entries (exact accessible names, spaces ignored). */
export const ENTRY = {
  alipay: '录入企业支付宝余额',
  wechat: '录入运营账户余额',
} as const;
/** The confirm button of the entry dialog (opens the totp StepUpModal). */
export const SUBMIT = '确认录入';

/** The read-only and input fields of the dialog (whole labels, an optional 「（元）」 and colon). */
export const DIALOG_FIELD = {
  /** The account: the channel title (企业支付宝 / 微信零钱). */
  account: '账户',
  /** The current W of that channel (overview channels[].watermark.available_fen), or 未录入. */
  current: '当前余额W|当前W',
  /** Its t_W in Beijing time YYYY-MM-DD HH:mm:ss, or — without a row. */
  currentAt: '当前取数时间',
} as const;
/** Labels of the inputs (the label text starts with these). */
export const INPUT = {
  available: /^可用余额/,
  measuredAt: /^取数时间/,
  note: /^备注/,
} as const;

export const UNENTERED = '未录入';
export const DASH = '—';

/**
 * Field messages. Local checks (no request): the amount and the time are required, the amount is
 * yuan ≥ 0 with at most two decimals, the time is Beijing time YYYY-MM-DD HH:mm:ss, a filled note
 * is not blank after trimming and at most 500 characters. Server 20001 by data.fields.
 */
export const FIELD_TEXT = {
  amountRequired: '请输入可用余额',
  amountInvalid: '请输入不小于 0 的金额，最多两位小数',
  timeRequired: '请输入取数时间',
  timeInvalid: '取数时间格式为 YYYY-MM-DD HH:mm:ss（北京时间）',
  noteBlank: '备注去掉首尾空白后不能为空',
  noteLong: '备注不能超过 500 字',
  /** 20001 data.fields=[measured_at]: too far ahead, too old, or before the channel's latest. */
  serverTime:
    '取数时间不符合要求（不能晚于当前时间、不能超过时效、不能早于该账户上次录入的取数时间），请核对后修改',
  /** 20001 data.fields=[available_fen]. */
  serverAmount: '可用余额不符合要求，请核对后修改',
  /** 20001 data.fields=[note]. */
  serverNote: '备注不符合要求（去掉首尾空白后 1–500 字），请修改后再提交',
} as const;

/** Notices (the same wording as the other payout writes of this console). */
export const NOTICE = {
  done: '余额已录入',
  again: '动态码凭证已失效，请重新输入动态码',
  forbidden: '无权限执行此操作（需要 fund.cash_entry 权限点）',
  invalid: '提交内容有误，请检查后重试',
  failed: '提交失败，请稍后重试',
  network: '网络错误，请检查网络后重试；未确认前不会重复提交',
} as const;
