// B1-04zz: which platform raises the service-fee-missing alert, apart from PlatformRules: it says
// which metric exists, not how the platform behaves. couli_pdd_service_fee_missing_total counts
// pinduoduo only. A taobao order without a fee goes to SERVICE_FEE_RATE_MISSING instead; its
// monitoring is tracked as FU-TB-FEE-MISSING-METRIC.
// B1-08zy (FU-TB-FEE-MISSING-METRIC): serviceFeeMissingCounts decides both counters for a later
// report: couli_service_fee_missing_total{platform} for every platform whose fee is deducted (pdd,
// taobao), and the old pdd counter with its pdd_service_fee_missing log for pinduoduo only.
import type { RegisteredPlatform } from '../../../union/index.ts';
import { findPlatformRules } from './index.ts';

/** The platform label values of couli_service_fee_missing_total (same as platform/metrics). */
export type ServiceFeeMissingLabel = Extract<RegisteredPlatform, 'pdd' | 'taobao'>;

/** Whether a later sync missing the service fee counts and alerts: only pdd. */
export function alertsServiceFeeMissing(platform: RegisteredPlatform): boolean {
  return platform === 'pdd';
}

/** A later report of an order already stored (the update path). */
export interface ServiceFeeMissingCheck {
  readonly platform: RegisteredPlatform;
  /** The report's service fee; undefined is missing, like null. */
  readonly incomingServiceFeeFen: bigint | null | undefined;
  /** The report's estimate; undefined is missing, like null. */
  readonly incomingEstCommissionFen: bigint | null | undefined;
  /** The stored estimate before this report. */
  readonly currentEstCommissionFen: bigint | null;
}

/** What that report counts. */
export interface ServiceFeeMissingCounts {
  /** The platform label couli_service_fee_missing_total counts; null when nothing is counted. */
  readonly metricPlatform: ServiceFeeMissingLabel | null;
  /** Whether couli_pdd_service_fee_missing_total counts and pdd_service_fee_missing is logged. */
  readonly legacyPdd: boolean;
}

/** The counters a later report missing the service fee raises (B1-08zy). */
export function serviceFeeMissingCounts(check: ServiceFeeMissingCheck): ServiceFeeMissingCounts {
  const { platform } = check;
  // Same condition as B1-08zh: the fee is deducted on this platform, the report has neither fee nor
  // estimate (a fee of 0 is present, not missing), and the stored order already has an estimate.
  const missing =
    findPlatformRules(platform)?.serviceFeeDeducted === true &&
    (check.incomingServiceFeeFen ?? null) === null &&
    (check.incomingEstCommissionFen ?? null) === null &&
    check.currentEstCommissionFen !== null;
  if (!missing || !isServiceFeeMissingLabel(platform)) return NOT_COUNTED;
  return { metricPlatform: platform, legacyPdd: alertsServiceFeeMissing(platform) };
}

const NOT_COUNTED: ServiceFeeMissingCounts = Object.freeze({
  metricPlatform: null,
  legacyPdd: false,
});

function isServiceFeeMissingLabel(
  platform: RegisteredPlatform,
): platform is ServiceFeeMissingLabel {
  return platform === 'pdd' || platform === 'taobao';
}
