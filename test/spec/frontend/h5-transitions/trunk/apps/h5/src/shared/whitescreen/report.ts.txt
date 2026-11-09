import type { WhitescreenReport } from './index.ts';

/**
 * Reporting port for white-screen events. Intentionally a no-op: no network request is sent until
 * the reporting channel is approved and connected (Sentry / analytics are a new third party that
 * the owner decides, 规划/03 §8.1). Callers and tests inject their own `report`.
 * TODO(规划/11 §5.1): Connect the approved reporting channel — blocked on Sentry / analytics approval.
 */
export function defaultReport(event: WhitescreenReport): void {
  void event;
}
