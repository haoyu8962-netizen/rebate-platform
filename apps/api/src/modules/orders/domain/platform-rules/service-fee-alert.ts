// B1-04zz: which platform raises the service-fee-missing alert, apart from PlatformRules: it says
// which metric exists, not how the platform behaves. couli_pdd_service_fee_missing_total counts
// pinduoduo only. A taobao order without a fee goes to SERVICE_FEE_RATE_MISSING instead; its
// monitoring is tracked as FU-TB-FEE-MISSING-METRIC.
import type { RegisteredPlatform } from '../../../union/index.ts';

/** Whether a later sync missing the service fee counts and alerts: only pdd. */
export function alertsServiceFeeMissing(platform: RegisteredPlatform): boolean {
  return platform === 'pdd';
}
