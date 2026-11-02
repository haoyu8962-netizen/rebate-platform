// B1-04zt: how far back a platform's order query answers (specs/union/jd.md: from ≥ 当前时刻 − 90
// 天), apart from PlatformRules: only the increment scheduler reads it. The adapter judges the same
// limit by itself; orders cannot read it from there. A platform without an entry has no limit here.
import type { RegisteredPlatform } from '../../../union/index.ts';

const DAY_MS = 86_400_000;

const ORDER_QUERY_LOOKBACK_MS: Readonly<Partial<Record<RegisteredPlatform, number>>> =
  Object.freeze({ jd: 90 * DAY_MS });

/** How far before now an order query may start; null for a platform without such a limit. */
export function orderQueryLookbackMs(platform: RegisteredPlatform): number | null {
  return ORDER_QUERY_LOOKBACK_MS[platform] ?? null;
}
