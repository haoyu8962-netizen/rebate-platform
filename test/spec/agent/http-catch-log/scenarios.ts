// B3-08v: one failure per port at each fallback catch of agent/http/index.ts (brief §9.1, §9.3 1).
// Each scenario names the catch site, the operation, how the failure is injected and the answer
// the trunk gives for it (unchanged by this task: code, msg, JSON or not).
import { expect } from 'vitest';

import {
  AdmissionHeldError,
  AdmissionUnavailableError,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import {
  DETAIL,
  expectJsonError,
  expectStreamWithoutJson,
  failure,
  type FakeReply,
  type Fault,
  type Operation,
  type Rig,
} from './kit.ts';

export type Site = 'create' | 'current' | 'cancel' | 'admit' | 'outer';

export type Answer = { readonly json: number } | { readonly stream: true };

export interface Scenario {
  readonly title: string;
  readonly site: Site;
  readonly op: Operation;
  /** Makes the port of this scenario fail with `fault`. */
  readonly arrange: (r: Rig, fault: Fault) => void;
  readonly answer: Answer;
  /**
   * A fault fixed by the scenario (with its name); otherwise the caller picks the fault and the
   * scenario also takes values that are not Errors.
   */
  readonly fixed?: { readonly fault: () => Fault; readonly errorName: string };
  /** Further checks of the trunk behaviour (ports not called after the failure). */
  readonly also?: (r: Rig) => void;
}

/** The error name of the default injected failure. */
export const PORT_FAILURE = 'SyntheticPortFailure';

export const SCENARIOS: readonly Scenario[] = [
  {
    title: 'createSession：sessions.open 拒绝',
    site: 'create',
    op: 'create_session',
    arrange: (r, fault) => {
      r.sessions.fail.open = fault;
    },
    answer: { json: 50001 },
  },
  {
    title: 'createSession：① access.check 拒绝',
    site: 'create',
    op: 'create_session',
    arrange: (r, fault) => {
      r.access.fail = fault;
    },
    answer: { json: 50001 },
  },
  {
    title: 'currentSession：sessions.current 拒绝',
    site: 'current',
    op: 'current_session',
    arrange: (r, fault) => {
      r.sessions.fail.current = fault;
    },
    answer: { json: 50001 },
  },
  {
    title: 'currentSession：③ consent.check 拒绝',
    site: 'current',
    op: 'current_session',
    arrange: (r, fault) => {
      r.consent.fail = fault;
    },
    answer: { json: 50001 },
  },
  {
    title: 'cancelRun：取消端口拒绝（不发信号）',
    site: 'cancel',
    op: 'cancel_run',
    arrange: (r, fault) => {
      r.cancel.fail = fault;
    },
    answer: { json: 50001 },
    also: (r) => {
      expect(r.cancel.calls).toHaveLength(1);
      expect(r.signals.calls, 'no cancel signal after a failed cancel').toEqual([]);
    },
  },
  {
    title: 'cancelRun：sessions.ownsRun 拒绝（不调取消端口）',
    site: 'cancel',
    op: 'cancel_run',
    arrange: (r, fault) => {
      r.sessions.fail.ownsRun = fault;
    },
    answer: { json: 50001 },
    also: (r) => {
      expect(r.cancel.calls).toEqual([]);
      expect(r.signals.calls).toEqual([]);
    },
  },
  {
    title: 'sendMessage：admit 抛出其他错误 → 50001',
    site: 'admit',
    op: 'send_message',
    arrange: (r, fault) => {
      r.admission.fail = fault;
    },
    answer: { json: 50001 },
    also: (r) => {
      expect(r.admission.admits).toHaveLength(1);
      expect(r.runs.starts).toEqual([]);
    },
  },
  {
    title: "sendMessage：admit 抛 AdmissionUnavailableError('unknown') → 50401",
    site: 'admit',
    op: 'send_message',
    arrange: (r, fault) => {
      r.admission.fail = fault;
    },
    answer: { json: 50401 },
    fixed: {
      fault: () => new AdmissionUnavailableError('unknown'),
      errorName: 'AdmissionUnavailableError',
    },
    also: (r) => {
      expect(r.runs.starts).toEqual([]);
    },
  },
  {
    title: "sendMessage：admit 抛 AdmissionUnavailableError('rolled_back') → 50401",
    site: 'admit',
    op: 'send_message',
    arrange: (r, fault) => {
      r.admission.fail = fault;
    },
    answer: { json: 50401 },
    fixed: {
      fault: () => new AdmissionUnavailableError('rolled_back'),
      errorName: 'AdmissionUnavailableError',
    },
  },
  {
    title: 'sendMessage：admit 抛 AdmissionHeldError（待人工处理）→ 50001',
    site: 'admit',
    op: 'send_message',
    arrange: (r, fault) => {
      r.admission.fail = fault;
    },
    answer: { json: 50001 },
    fixed: { fault: () => new AdmissionHeldError(DETAIL), errorName: 'Error' },
  },
  {
    title: 'sendMessage：脱敏端口拒绝 → 50001，不受理',
    site: 'outer',
    op: 'send_message',
    arrange: (r, fault) => {
      r.redactor.fail = fault;
    },
    answer: { json: 50001 },
    also: (r) => {
      expect(r.admission.admits, 'admit not called').toEqual([]);
    },
  },
  {
    title: 'sendMessage：labels.current 拒绝 → 50001，不受理',
    site: 'outer',
    op: 'send_message',
    arrange: (r, fault) => {
      r.labels.fail.current = fault;
    },
    answer: { json: 50001 },
    also: (r) => {
      expect(r.admission.admits, 'admit not called').toEqual([]);
    },
  },
  {
    title: 'sendMessage：④ sessions.owned 拒绝 → 50001',
    site: 'outer',
    op: 'send_message',
    arrange: (r, fault) => {
      r.sessions.fail.owned = fault;
    },
    answer: { json: 50001 },
    also: (r) => {
      expect(r.admission.admits).toEqual([]);
    },
  },
  {
    title: 'sendMessage：② identity.check 拒绝 → 50001',
    site: 'outer',
    op: 'send_message',
    arrange: (r, fault) => {
      r.identity.fail = fault;
    },
    answer: { json: 50001 },
  },
  {
    title: 'sendMessage：RunManager.start 拒绝（SSE 已开始）→ 不再回 JSON，流照常收尾',
    site: 'outer',
    op: 'send_message',
    arrange: (r, fault) => {
      r.runs.fail = fault;
    },
    answer: { stream: true },
    also: (r) => {
      expect(r.runs.starts).toHaveLength(1);
    },
  },
];

/** The fault a scenario uses by default, and its error name. */
export function defaultFault(s: Scenario): { fault: Fault; errorName: string } {
  if (s.fixed !== undefined) return { fault: s.fixed.fault(), errorName: s.fixed.errorName };
  return { fault: failure(PORT_FAILURE), errorName: PORT_FAILURE };
}

/** The trunk's answer for the scenario. */
export function expectAnswer(s: Scenario, reply: FakeReply, r: Rig): void {
  if ('json' in s.answer) expectJsonError(reply, r.caller, s.answer.json);
  else expectStreamWithoutJson(reply);
  s.also?.(r);
}

/** One scenario per catch site, all with the default failure (same error name). */
export function onePerSite(): Scenario[] {
  const sites: Site[] = ['create', 'current', 'cancel', 'admit', 'outer'];
  return sites.map((site) => {
    const s = SCENARIOS.find((x) => x.site === site && x.fixed === undefined);
    expect(s, `a scenario at ${site}`).toBeDefined();
    return s!;
  });
}
