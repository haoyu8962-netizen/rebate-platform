// Invite reward records (BR-INV-24): the list query, display names of the enums and the amounts
// and times as shown. Amounts are integer fen and only go through @couli/money.
import type { Schema } from '@couli/contracts-ts';
import { formatYuanAdmin, parseFen } from '@couli/money';
import { inviteRewardsTexts as t } from '../../texts/invite-rewards.ts';

export type Reward = Schema<'AdminInviteReward'>;
export type RewardStatus = Schema<'AdminInviteRewardStatus'>;
export type RewardBudget = Schema<'AdminInviteRewardBudget'>;
type PartyResult = Schema<'AdminInviteRewardPartyResult'>;
type SkipReason = Schema<'AdminInviteRewardSkipReason'>;
type VoidReason = Schema<'AdminInviteRewardVoidReason'>;
type BindSource = Schema<'AdminInviteRewardBindSource'>;

export const REWARDS_URL = '/admin/v1/invite-rewards';
/** Address of the record subpage (a subpage of 配置中心, no sidebar item). */
export const INVITE_REWARDS_PATH = '/invite-rewards';
/** page_size of the list (contract ≤ 200). */
export const PAGE_SIZE = 20;
export const STATUSES: readonly RewardStatus[] = [
  'qualified',
  'deferred',
  'processed',
  'voided',
  'expired',
];

export function rewardUrl(inviteeId: string): string {
  return `${REWARDS_URL}/${encodeURIComponent(inviteeId)}`;
}

/** The filters as typed; empty ones are left out of the query. */
export interface Filters {
  readonly invitee: string;
  readonly inviter: string;
  readonly status: RewardStatus | undefined;
  /** +08:00 calendar days YYYY-MM-DD, both inclusive. */
  readonly from: string | undefined;
  readonly to: string | undefined;
}

export const NO_FILTERS: Filters = {
  invitee: '',
  inviter: '',
  status: undefined,
  from: undefined,
  to: undefined,
};

/** A start day later than the end day is never sent (the server would refuse it, 20001). */
export function rangeInvalid(filters: Filters): boolean {
  return filters.from !== undefined && filters.to !== undefined && filters.from > filters.to;
}

/** Query parameters of the filters (page and page_size are added by the caller). */
export function queryOf(filters: Filters): Record<string, string> {
  const query: Record<string, string> = {};
  const invitee = filters.invitee.trim();
  const inviter = filters.inviter.trim();
  if (invitee !== '') query['invitee_id'] = invitee;
  if (inviter !== '') query['inviter_id'] = inviter;
  if (filters.status !== undefined) query['status'] = filters.status;
  if (filters.from !== undefined) query['qualified_from'] = filters.from;
  if (filters.to !== undefined) query['qualified_to'] = filters.to;
  return query;
}

/** Admin display of an amount in fen; the dash when it is not an integer fen amount. */
export function amountLabel(value: unknown): string {
  try {
    return formatYuanAdmin(parseFen(value));
  } catch {
    return t.dash;
  }
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** YYYY-MM-DD HH:mm in Beijing time; null shows the dash. */
export function beijingTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return t.dash;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const date = new Date(ms + BEIJING_OFFSET_MS);
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

function lookup(map: Readonly<Record<string, string>>, code: string | null): string {
  if (code === null) return t.dash;
  return Object.hasOwn(map, code) ? (map[code] ?? t.dash) : t.dash;
}

export function statusLabel(status: RewardStatus): string {
  return lookup(t.status, status);
}

export function resultLabel(result: PartyResult | null): string {
  return result === null ? t.noResult : lookup(t.result, result);
}

export function skipReasonLabel(reason: SkipReason | null): string {
  return lookup(t.skipReason, reason);
}

export function voidReasonLabel(reason: VoidReason | null): string {
  return lookup(t.voidReason, reason);
}

export function bindSourceLabel(source: BindSource): string {
  return lookup(t.bindSource, source);
}

/** One party's result with its own reason (never the other party's): 「不发 · 同设备」. */
export function partyLabel(result: PartyResult | null, reason: SkipReason | null): string {
  const shown = resultLabel(result);
  return result === 'skipped' && reason !== null
    ? `${shown}${t.separator}${skipReasonLabel(reason)}`
    : shown;
}

export function inviterParty(reward: Reward): string {
  return partyLabel(reward.inviter_result, reward.inviter_skip_reason);
}

export function inviteeParty(reward: Reward): string {
  return partyLabel(reward.invitee_result, reward.invitee_skip_reason);
}

/** Status with the void reason of a voided record: 「已作废 · 触发订单被扣回」. */
export function statusWithReason(reward: Reward): string {
  const shown = statusLabel(reward.status);
  return reward.status === 'voided' && reward.void_reason !== null
    ? `${shown}${t.separator}${voidReasonLabel(reward.void_reason)}`
    : shown;
}
