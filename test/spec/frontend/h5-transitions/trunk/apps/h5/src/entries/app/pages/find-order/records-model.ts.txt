import { findOrderText, findOrderTexts } from '../../../../texts/find-order.ts';
import type { PlatformKey } from '../../../../components/platform/index.ts';
import type { Claim, ClaimItem, LocateTarget, RecordPlatform } from './model.ts';

// 找回记录的显示数据与定位步骤（只由记录块使用）。

export type BadgePlatform = PlatformKey;
const BADGE_PLATFORMS: ReadonlySet<string> = new Set<PlatformKey>([
  'taobao',
  'tmall',
  'jd',
  'pdd',
  'wechat',
  'wechat_pay',
  'alipay',
  'wecom',
]);

function badgePlatform(platform: RecordPlatform): BadgePlatform | null {
  return BADGE_PLATFORMS.has(platform) ? (platform as BadgePlatform) : null;
}

// ---- 记录 ----

export type RecordState = 'pending' | 'auto_tracked' | 'approved' | 'rejected';

/** 整单状态到记录标签（BR-ATTR-30、BR-ATTR-16）：submitted、auto_matched、manual_review 都是审核中。 */
export function claimState(status: Claim['status']): RecordState {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'cancelled':
      return 'auto_tracked';
    default:
      return 'pending';
  }
}

/** 子订单决定到记录标签；未决定（null）是审核中。 */
export function itemState(decision: ClaimItem['decision']): RecordState {
  switch (decision) {
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'cancelled':
      return 'auto_tracked';
    default:
      return 'pending';
  }
}

export function stateLabel(state: RecordState): string {
  return findOrderText(`claim.records.status.${state}`);
}

/** 驳回原因的用户侧文字；没有起草的原因用通用说明，不露原因码、不留空，也不借用别的原因的文字。 */
export function rejectReasonText(reason: ClaimItem['reject_reason']): string {
  const text = reason === null ? '' : findOrderText(`claim_reject_reason.${reason}.title`);
  return text === '' ? findOrderTexts.rejectGeneric : text;
}

/** 说明句：已找回、未通过用 CLAIM_RESULT 原文（不带返利金额），其余用 08 表 C 的说明句。 */
export function explanation(state: RecordState, reason: ClaimItem['reject_reason']): string {
  switch (state) {
    case 'approved':
      return findOrderText('claim.result.approved');
    case 'rejected':
      return findOrderText('claim.result.rejected', { reason: rejectReasonText(reason) });
    default:
      return findOrderText(`claim.records.desc.${state}`);
  }
}

export interface RecordLine {
  /** 多个子订单时为子订单号；只有一个子订单（或没有）时为 null，说明直接挂在整单上。 */
  subOrderId: string | null;
  state: RecordState;
  text: string;
}

export interface RecordView {
  claimId: string;
  /** 有内置平台标识的平台才显示 PlatformBadge。 */
  platform: BadgePlatform | null;
  orderNo: string;
  state: RecordState;
  paidDate: string;
  createdAt: string;
  lines: RecordLine[];
}

/**
 * 一条申请的显示数据。只有一个子订单时按该子订单的决定显示（未决定时按整单状态）；多个子订单时整单标签按
 * 整单状态，每个子订单单独一行显示自己的决定与说明。只显示本人的申请内容，不显示认领方。
 */
export function recordView(claim: Claim, nowMs: number): RecordView {
  const items = claim.items;
  const base = {
    claimId: claim.claim_id,
    platform: badgePlatform(claim.platform),
    orderNo: claim.order_no,
    paidDate: formatPlainDate(claim.paid_date, nowMs),
    createdAt: formatPastTime(claim.created_at, nowMs),
  };
  if (items.length <= 1) {
    const item = items[0];
    const state =
      item === undefined || item.decision === null
        ? claimState(claim.status)
        : itemState(item.decision);
    const reason = item?.reject_reason ?? null;
    return {
      ...base,
      state,
      lines: [{ subOrderId: null, state, text: explanation(state, reason) }],
    };
  }
  return {
    ...base,
    state: claimState(claim.status),
    lines: items.map((item) => {
      const state = itemState(item.decision);
      return { subOrderId: item.sub_order_id, state, text: explanation(state, item.reject_reason) };
    }),
  };
}

// ---- 日期（BR-TEXT-11，Asia/Shanghai） ----

const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 上海时区的 YYYY-MM-DD 与 HH:mm。与 dates.ts 的同名函数相同：这里不引用它，
 * 免得两个页签共用一个小块（各块连同依赖的体积上限）。
 */
function shanghai(ms: number): { date: string; time: string } {
  const iso = new Date(ms + 8 * 60 * 60 * 1000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** 纯日期：与今天同年 MM-DD，否则 YYYY-MM-DD；不用「今天 / 昨天」。 */
export function formatPlainDate(date: string, nowMs: number): string {
  const match = PLAIN_DATE.exec(date);
  if (match === null) return date;
  return match[1] === shanghai(nowMs).date.slice(0, 4) ? `${match[2]}-${match[3]}` : date;
}

/** 列表中的过去时间：同一天「今天 HH:mm」、前一天「昨天 HH:mm」、同年 MM-DD、其他 YYYY-MM-DD。 */
export function formatPastTime(value: string, nowMs: number): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  const at = shanghai(ms);
  const today = shanghai(nowMs).date;
  const yesterday = shanghai(nowMs - 24 * 60 * 60 * 1000).date;
  if (at.date === today) return `${findOrderTexts.today} ${at.time}`;
  if (at.date === yesterday) return `${findOrderTexts.yesterday} ${at.time}`;
  return at.date.slice(0, 4) === today.slice(0, 4) ? at.date.slice(5) : at.date;
}

// ---- 定位（成功与 30205） ----

/**
 * 订单号的比对值，与服务端 createOrderClaim 一致（契约 CreateOrderClaimRequest.order_no、BR-ATTR-17 ③）：
 * 先去掉空格；拼多多再去掉全部连字符；其余平台原样精确比对。只用于比对，显示仍用原值。
 */
export function claimCompareValue(platform: string, orderNo: string): string {
  const stripped = orderNo.replaceAll(' ', '');
  return platform === 'pdd' ? stripped.replaceAll('-', '') : stripped;
}

/**
 * 这条申请是不是要定位的那条：有 claim_id 时按 claim_id；否则同平台，且规范化后的订单号等于申请的订单号
 * 或其中某个子订单号（服务端先按子订单、再按主订单匹配，30205 可能来自子订单号）。
 */
export function claimMatches(claim: Claim, target: LocateTarget): boolean {
  if ('claimId' in target) return claim.claim_id === target.claimId;
  if (claim.platform !== target.platform) return false;
  const wanted = claimCompareValue(target.platform, target.orderNo);
  if (wanted === '') return false;
  return (
    claimCompareValue(claim.platform, claim.order_no) === wanted ||
    claim.items.some((item) => claimCompareValue(claim.platform, item.sub_order_id) === wanted)
  );
}

/** 为了定位最多自动加载的页数（含首页）；超过后保留目标，等用户点「加载更多」。 */
export const LOCATE_MAX_PAGES = 5;

/**
 * 定位的下一步：found 已找到；load 自动再取下一页；wait 保留目标、等用户手动加载（到上限或下一页失败）；
 * done 列表已取完仍没有，结束定位（只停在记录页签）。
 */
export type LocateStep = 'found' | 'load' | 'wait' | 'done';

export function locateStep(input: {
  found: boolean;
  hasNextPage: boolean;
  pagesLoaded: number;
  nextPageFailed: boolean;
}): LocateStep {
  if (input.found) return 'found';
  if (!input.hasNextPage) return 'done';
  if (input.nextPageFailed || input.pagesLoaded >= LOCATE_MAX_PAGES) return 'wait';
  return 'load';
}
