// B1-08zy (FU-TB-FEE-MISSING-METRIC): process-local counter couli_service_fee_missing_total with one
// label, platform (pdd / taobao: the platforms whose commission has the service fee deducted). One
// increment per report that lacks the service fee on an order that already has an estimate. No
// amount, no order number. The old couli_pdd_service_fee_missing_total (pdd-service-fee.ts) stays
// alongside it for now. Rule tests: test/spec/orders/service-fee-missing-metric/.

/** The platform label values of couli_service_fee_missing_total. */
export type ServiceFeeMissingPlatform = 'pdd' | 'taobao';

/** Exposition order of the label values. */
const PLATFORMS: readonly ServiceFeeMissingPlatform[] = ['pdd', 'taobao'];

/** Counts so far; taobao is exported at 0 before its first count, pdd is absent until then (D10-1051). */
const missing = new Map<ServiceFeeMissingPlatform, number>();

/** One series of couli_service_fee_missing_total. */
export interface ServiceFeeMissingSample {
  readonly platform: ServiceFeeMissingPlatform;
  readonly value: number;
}

/** Adds one to the series of `platform`. */
export function countServiceFeeMissing(platform: ServiceFeeMissingPlatform): void {
  missing.set(platform, (missing.get(platform) ?? 0) + 1);
}

/**
 * Every series to export: taobao is always there (0 until counted, D10-1051); pdd appears only after
 * its first count (D10-1003, keeps worker /metrics free of platform="pdd" until then).
 */
export function serviceFeeMissingSamples(): readonly ServiceFeeMissingSample[] {
  return PLATFORMS.flatMap((platform) => {
    const value = missing.get(platform) ?? (platform === 'taobao' ? 0 : undefined);
    return value === undefined ? [] : [{ platform, value }];
  });
}
