// B3-08x helpers (unit tier). The B3-08v kit (../http-catch-log/kit.ts) wires limits.current() to
// always succeed, so this rig builds the same fakes with limits.current() failing. The kit's
// expectOneErrorLine requires the whole log to be one line; the brief asks for exactly one error
// line (brief §9.3), so expectLimitsLine counts error lines and scans every line for leaks.
import { expect } from 'vitest';

import { createAgentHttp } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  BEARER_LIKE,
  DETAIL,
  FakeAdmission,
  FakeCancel,
  FakeLabels,
  FakeRedactor,
  FakeRuns,
  FakeSessions,
  FakeSignals,
  Gate,
  RecordingLogger,
  START_MS,
  USER_TEXT,
  member,
  newId,
  serialize,
  stringsOf,
  texts,
  type Fault,
  type Rig,
} from '../http-catch-log/kit.ts';

type AgentLogger = Pick<RootLogger, 'warn' | 'error'>;

/** A logger whose every call throws; counts the calls. */
export class ThrowingLogger {
  calls = 0;
  readonly logger = {
    warn: () => this.boom(),
    error: () => this.boom(),
  } as unknown as AgentLogger;
  boom(): never {
    this.calls += 1;
    throw new Error('synthetic logger failure');
  }
}

export interface LimitsRig extends Rig {
  /** The app id of every limits.current() call. */
  limitReads: string[];
}

/** A rig whose limits.current() rejects with `fault`; `sink` null means no logger is injected. */
export function limitsRig(fault: Fault, sink: RecordingLogger | ThrowingLogger | null): LimitsRig {
  const limitReads: string[] = [];
  const r: Omit<Rig, 'http'> = {
    caller: member(),
    access: new Gate(),
    identity: new Gate(),
    consent: new Gate(),
    sessions: new FakeSessions(),
    admission: new FakeAdmission(),
    runs: new FakeRuns(),
    cancel: new FakeCancel(),
    signals: new FakeSignals(),
    redactor: new FakeRedactor(),
    labels: new FakeLabels(),
    log: sink instanceof RecordingLogger ? sink : null,
    sessionId: newId(),
    runId: newId(),
  };
  r.sessions.mine.add(r.sessionId);
  r.sessions.runs.add(r.runId);
  const http = createAgentHttp({
    access: r.access,
    identity: r.identity,
    consent: r.consent,
    sessions: r.sessions,
    admission: r.admission,
    runs: r.runs,
    cancel: (query) => r.cancel.cancel(query),
    signals: r.signals,
    limits: {
      current: (appId) => {
        limitReads.push(appId);
        return Promise.reject(fault);
      },
    },
    body: () => () => Promise.resolve({ kind: 'done', finishReason: 'stop' }),
    redactor: r.redactor,
    labels: r.labels,
    settings: { textMaxCodePoints: 500 },
    texts,
    ids: newId,
    clock: { now: () => new Date(START_MS) },
    ...(sink === null ? {} : { logger: sink.logger }),
  });
  return { ...r, http, limitReads };
}

/** The injected failure's text, whole and in pieces: a truncated copy is a leak too. */
const LEAK_PIECES: readonly string[] = [
  DETAIL,
  USER_TEXT,
  BEARER_LIKE,
  ...USER_TEXT.split(' '),
  ...BEARER_LIKE.split(/[ .]/),
];

/**
 * Exactly one error line, naming the operation, the limits stage and the error's name; no line of
 * any level carries the failure's text or the identifiers, and no Error object reaches the logger.
 */
export function expectLimitsLine(
  log: RecordingLogger,
  options: { errorName: string; forbidden: readonly string[] },
): void {
  const errors = log.errors();
  expect(errors, 'exactly one error line').toHaveLength(1);
  const entry = errors[0]!;
  expect(entry.args[0], 'operation, stage and error name of the line').toMatchObject({
    op: 'send_message',
    stage: 'limits',
    error_name: options.errorName,
  });
  expect(stringsOf(entry), 'the event name is in the line').toContain('agent_http_failed');
  for (const line of log.entries) {
    const text = serialize(line);
    for (const piece of [...LEAK_PIECES, ...options.forbidden]) {
      expect(text, 'the line carries none of the failure text or identifiers').not.toContain(piece);
    }
    expect(
      line.args.some((a) => a instanceof Error),
      'no Error object handed to the logger',
    ).toBe(false);
  }
}
