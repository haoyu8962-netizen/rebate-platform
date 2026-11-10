// union_bindings.status legality (规划/08 BR-ID-19 唯一与冷却, BR-ID-20 blocked / 释放 / 重置授权 /
// 停用与恢复返利, BR-ID-21 巡检失效, BR-ID-31 封禁与解封; shape: 规划/04 §4.4 union_binding_status).
// Pure: no Nest, no data access, erasable syntax only.
//
// CT-10a: the transition table is the generated union-binding state machine
// (specs/state-machines/union-binding.yaml U1–U10 → @couli/domain transitionUnionBinding); this file
// keeps no table of its own (B1-06zm; approvals #26 superseded). canTransitionBinding is a thin
// forwarder kept for linking's writers and CT-10a's compat test: it names the one event entering
// `to` and asks the generated transition() at every call. linking (the table's only writer) applies
// it before its row_version CAS.
//
// - from = null means no row yet (U1: a user authorization inserts the row active directly).
// - unbound and pending_auth are entered by no event (BR-ID-19 细则); cooling is not a status.
// - the same status again is not a transition (no event leaves a status for itself).
import {
  UNION_BINDING_STATES,
  transitionUnionBinding,
  type UnionBindingEvent,
  type UnionBindingState,
} from '@couli/domain';

export type BindingStatus = UnionBindingState;

/** The generated machine's events, each entering exactly one status (union-binding.yaml). */
function eventInto(to: BindingStatus): UnionBindingEvent | null {
  switch (to) {
    case 'active':
      return 'ACTIVATE';
    case 'invalid':
      return 'INVALIDATE';
    case 'blocked':
      return 'BLOCK';
    case 'released':
      return 'RELEASE';
    default:
      return null;
  }
}

export function isBindingStatus(value: unknown): value is BindingStatus {
  return typeof value === 'string' && (UNION_BINDING_STATES as readonly string[]).includes(value);
}

/** True for a legal change of union_bindings.status; from = null means no row exists yet. */
export function canTransitionBinding(from: unknown, to: unknown): boolean {
  if (!isBindingStatus(to)) return false;
  if (from !== null && !isBindingStatus(from)) return false;
  const event = eventInto(to);
  if (event === null) return false;
  const result = transitionUnionBinding(from, event);
  return result.ok && !result.noop && result.to === to;
}
