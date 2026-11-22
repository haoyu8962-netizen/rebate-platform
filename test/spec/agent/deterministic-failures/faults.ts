import { GovernanceError } from '../../../../apps/api/src/modules/platform/http/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';

/** Normalized dependency faults at the internal ports. */
export function upstreamFailure(fault: 'timeout' | '5xx' | 'circuit_open'): Error {
  return fault === '5xx'
    ? new UnionError('upstream_unavailable', '合成上游 HTTP 503', 'taobao')
    : new GovernanceError(fault, 'union:taobao:online', `合成上游 ${fault}`);
}
