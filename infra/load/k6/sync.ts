// k6 entry of QA-06c: admin manual order sync at 3 x its local peak share. Parameters and
// thresholds live in sync.config.json next to this file; the pure builders are sync-options.ts.
// Only loopback or the infra/fault WireMock (09 README §0.2 hard rule 5); prod is refused at init.
import { check } from 'k6';
import http from 'k6/http';
import {
  buildSyncLimitsRequest,
  buildSyncOptions,
  buildSyncRequest,
  syncLimitsFromResponse,
  syncNeedsLimits,
  syncResponseOk,
  type SyncConfig,
  type SyncLimits,
} from './sync-options.ts';

const config = JSON.parse(open('./sync.config.json')) as SyncConfig;
export const options = buildSyncOptions(config);
// Init checks (config, target, token) run before k6 starts any load, in both body forms.
const limitsRequest = buildSyncLimitsRequest(config, __ENV);
// The order_nos form needs no limits, so its request is built (and validated) once here.
const fixedRequest = syncNeedsLimits(config) ? undefined : buildSyncRequest(config, __ENV);

/**
 * Window form only: read the per-platform limits once and validate the window against them, so a
 * 401 or a window before earliest_from fails the run before any load instead of every iteration.
 */
export function setup(): SyncLimits | undefined {
  if (fixedRequest !== undefined) return undefined;
  const response = http.request(limitsRequest.method, limitsRequest.url, null, {
    ...limitsRequest.params,
    responseType: 'text',
    responseCallback: http.expectedStatuses(200),
  });
  const limits = syncLimitsFromResponse(response);
  buildSyncRequest(config, __ENV, limits);
  return limits;
}

export function sync(limits?: SyncLimits): void {
  const request = fixedRequest ?? buildSyncRequest(config, __ENV, limits);
  // One request per iteration: no retry, no redirect, no Idempotency-Key or step-up header.
  const response = http.request(request.method, request.url, request.body, {
    ...request.params,
    responseType: 'text',
    responseCallback: http.expectedStatuses(200),
  });
  check(response, { 'sync: valid business response': (value) => syncResponseOk(value) });
}
