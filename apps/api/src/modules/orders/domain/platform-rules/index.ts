// B1-08za: the platform differences of orders, one rule table per registered platform
// (`<platform>.ts`, each exporting `rules`). Domain code looks the platform up here and never
// compares platform names itself. Every value is the behaviour of the per-platform branches before
// the refactor (behaviour unchanged). Next to the tables live only their type (types.ts) and the
// order-parameter parsers (params.ts); nothing here imports the domain code that reads the tables.
import type { RegisteredPlatform } from '../../../union/index.ts';
import { rules as jd } from './jd.ts';
import { rules as pdd } from './pdd.ts';
import { rules as taobao } from './taobao.ts';
import type { PlatformRules } from './types.ts';

export type {
  AttributionRule,
  ClaimAuthRule,
  ItemIdField,
  MissingLinkBuyTypeBasis,
  PlatformRules,
} from './types.ts';

/**
 * The table, keyed by registered platform. The type makes a registered platform without an entry a
 * compile error; each entry is the very object its `<platform>.ts` exports.
 */
export const PLATFORM_RULES: Readonly<Record<RegisteredPlatform, PlatformRules>> = Object.freeze({
  jd: Object.freeze(jd),
  pdd: Object.freeze(pdd),
  taobao: Object.freeze(taobao),
});

export function platformRules(platform: RegisteredPlatform): PlatformRules {
  return PLATFORM_RULES[platform];
}

/**
 * The entry of a platform code that may not be registered (contract PlatformCode, a stored column
 * or a link_log's platform): null for an unregistered code, another spelling or null. Callers then
 * take none of the per-platform branches, as before the refactor.
 */
export function findPlatformRules(platform: string | null): PlatformRules | null {
  if (platform === null || !Object.hasOwn(PLATFORM_RULES, platform)) return null;
  return PLATFORM_RULES[platform as RegisteredPlatform];
}
