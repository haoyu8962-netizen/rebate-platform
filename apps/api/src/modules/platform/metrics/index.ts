// Public surface of platform/metrics (B1-01zzh).
export {
  AGENT_TRACE_MISSING_GAUGE,
  createAgentTraceMissingCollector,
} from './agent-trace-missing.ts';
export type {
  AgentTraceMissingCount,
  AgentTraceMissingPort,
  AgentTraceMissingSnapshot,
} from './agent-trace-missing.ts';
export { cacheAutoPayoutCollector, collectAutoPayoutDaily } from './auto-payout.ts';
export type {
  AutoPayoutCapEntry,
  AutoPayoutCapFenOf,
  AutoPayoutCapSnapshot,
  AutoPayoutDailySnapshot,
} from './auto-payout.ts';
export { cacheFundCollector } from './cache.ts';
export { countPddServiceFeeMissing } from './pdd-service-fee.ts';
export { countServiceFeeMissing } from './service-fee-missing.ts';
export type { ServiceFeeMissingPlatform } from './service-fee-missing.ts';
export { collectWorkerMetrics } from './collect.ts';
export type { WorkerCollection, WorkerMetricsSnapshot } from './collect.ts';
export { collectRescanPositions } from './rescan-position.ts';
export type {
  NonSyncQueryKind,
  RescanPositionSample,
  RescanPositionSnapshot,
} from './rescan-position.ts';
export type { FundMetricsSnapshot } from './fund.ts';
export { cacheReviewOverdueCollector } from './review-overdue.ts';
export type { ReviewOverdueSnapshot } from './review-overdue.ts';
export { cacheWaterLowCollector } from './water-low.ts';
export type { WaterLowSnapshot } from './water-low.ts';
export { createMetricsRegistry } from './registry.ts';
export type {
  MetricsRegistry,
  MetricsRegistryOptions,
  TaobaoSearchMetricSample,
  TaobaoSearchMetricsSnapshot,
} from './registry.ts';
export { startMetricsServer } from './server.ts';
export type { MetricsServer, MetricsServerOptions } from './server.ts';
