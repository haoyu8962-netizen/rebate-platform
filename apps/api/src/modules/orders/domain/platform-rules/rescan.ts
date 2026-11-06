// B1-04zm: the platform differences of the order rescan (规划/02 §7.1; D10-543), apart from
// PlatformRules: these are defaults of order_sync.rescan.<platform>.enabled / .days, not rules of the
// platform. Only the listed platforms ever rescan; any other code has no entry.
import type { RegisteredPlatform } from '../../../union/index.ts';

export interface RescanDefaults {
  readonly enabled: boolean;
  readonly days: number;
}

const RESCAN_DEFAULTS: Readonly<Partial<Record<RegisteredPlatform, RescanDefaults>>> =
  Object.freeze({
    jd: Object.freeze({ enabled: true, days: 30 }),
    // 02 §7.1 淘宝回扫三档先只做单档 30 天（D10-588 ③，三档见 FU-TB-RESCAN-TIERS）。
    taobao: Object.freeze({ enabled: true, days: 30 }),
    pdd: Object.freeze({ enabled: false, days: 90 }),
  });

/** The defaults of a platform that may rescan; null for any other code. */
export function rescanDefaults(platform: string): RescanDefaults | null {
  if (!Object.hasOwn(RESCAN_DEFAULTS, platform)) return null;
  return RESCAN_DEFAULTS[platform as RegisteredPlatform] ?? null;
}
