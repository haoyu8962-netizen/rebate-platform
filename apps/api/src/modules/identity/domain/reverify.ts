// The pure rules of the re-verification of a recycled phone (规划/08 BR-WDR-01 细则「旧手机号被二次放号
// 时的提现加验」): the judgement at session time, the frozen trusted identities and the method a
// flagged device has to use. No clock, no storage: the caller hands in instants and the +08:00 day.

/** BR-WDR-01 细则「加验依据」: five consecutive failures end self-service for the day. */
export const REVERIFY_FAIL_LIMIT = 5;

const DAY_MS = 86_400_000;
const PROVIDERS = ['wechat', 'apple', 'huawei'] as const;

export type ReverifyProvider = (typeof PROVIDERS)[number];

/** users.reverify_trusted (migration 0111). */
export interface TrustedIdentities {
  readonly realname: boolean;
  readonly providers: readonly ReverifyProvider[];
}

export interface DormantJudgement {
  /** withdraw.dormant_reverify_days; 0 is off. */
  readonly days: number;
  readonly now: Date;
  /** The stored values from before this login overwrites them. */
  readonly lastActiveAt: Date | null;
  readonly lastDeviceHash: string | null;
  readonly deviceHash: string | null;
  readonly flaggedAt: Date | null;
}

/**
 * BR-WDR-01 细则「判定」: flag when the switch is on, the account is not flagged yet, the last activity
 * is at least the switch's days old and the device differs. A missing stored value never flags
 * (D10-567 ③).
 */
export function isDormantLogin(input: DormantJudgement): boolean {
  const { days, now, lastActiveAt, lastDeviceHash, deviceHash, flaggedAt } = input;
  if (days <= 0 || flaggedAt !== null) return false;
  if (lastActiveAt === null || lastDeviceHash === null || deviceHash === null) return false;
  return now.getTime() - lastActiveAt.getTime() >= days * DAY_MS && lastDeviceHash !== deviceHash;
}

/** A stored snapshot; anything unreadable trusts nothing (self-service closed, manual only). */
export function trustedIdentitiesOf(value: unknown): TrustedIdentities {
  if (typeof value !== 'object' || value === null) return { realname: false, providers: [] };
  const { realname, providers } = value as { realname?: unknown; providers?: unknown };
  return {
    realname: realname === true,
    providers: Array.isArray(providers)
      ? PROVIDERS.filter((provider) => providers.includes(provider))
      : [],
  };
}

/** The failures of `today`: the count of an earlier day has already been reset at midnight. */
export function failuresOn(today: string, day: string | null, count: number): number {
  return day === today ? count : 0;
}

export type ReverifyRequirement =
  | {
      readonly method: 'id_number';
      readonly providers: readonly [];
      readonly fail_limit: number;
      readonly fail_remaining: number;
    }
  | {
      readonly method: 'oauth';
      readonly providers: readonly ReverifyProvider[];
      readonly fail_limit: number;
      readonly fail_remaining: number;
    }
  | {
      readonly method: 'manual';
      readonly providers: readonly [];
      readonly fail_limit: null;
      readonly fail_remaining: null;
    };

export const MANUAL_REQUIREMENT: ReverifyRequirement = {
  method: 'manual',
  providers: [],
  fail_limit: null,
  fail_remaining: null,
};

/** BR-WDR-01 细则「位置与返回码」: one method by priority; manual once today's limit is reached. */
export function reverifyRequirement(
  trusted: TrustedIdentities,
  failures: number,
): ReverifyRequirement {
  const remaining = REVERIFY_FAIL_LIMIT - failures;
  if (remaining <= 0) return MANUAL_REQUIREMENT;
  const counters = { fail_limit: REVERIFY_FAIL_LIMIT, fail_remaining: remaining };
  if (trusted.realname) return { method: 'id_number', providers: [], ...counters };
  if (trusted.providers.length > 0) {
    return { method: 'oauth', providers: trusted.providers, ...counters };
  }
  return MANUAL_REQUIREMENT;
}
