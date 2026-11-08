// The worker's agent trace missing gauge (B3-08za registration for B3-08z; BR-AI-19; D10-1060,
// D10-1087): couli_agent_trace_missing_runs, one sample per app_id. Meaning (B3-08z owns the query
// and its semantics): runs ended more than 24 hours ago that emitted cards yet have no card rows;
// sessions erased from their user are not counted. The value comes from agent's read-only port,
// injected by entry.ts (platform imports no business module, agent internals included). Only the
// worker exports it; couli.yaml alerts on it > 0 (an operations alert, muted at night).
//
// Error handling is the registry's frozen one (as for every other worker collector): a rejected
// or throwing collection rejects render(), so the scrape fails visibly and no 0 is made up. A
// collector built without its port rejects every call. Until B3-08z wires it, entry.ts does not
// pass collectAgentTraceMissing at all, so the worker's /metrics has no such series and every other
// metric renders as before.
// TODO(规划/11 §2.3): agent's read-only countMissing query and its wiring in entry.ts — blocked on
// B3-08z (entry.ts and agent/store are outside B3-08za's paths).
import type { Clock } from '../clock/index.ts';

/** One app_id's count from agent's read-only port. */
export interface AgentTraceMissingCount {
  readonly app_id: string;
  readonly runs: number;
}

/** Agent's read-only port (B3-08z implements it; platform only declares its shape). */
export interface AgentTraceMissingPort {
  /** Read-only; `now` is the injected Clock's instant, never the database's now(). */
  countMissing(now: Date): Promise<readonly AgentTraceMissingCount[]>;
}

/** One scrape's values. */
export interface AgentTraceMissingSnapshot {
  /** app_id → runs missing their trace; an app_id the port does not return has no sample. */
  readonly missingRuns: Readonly<Record<string, number>>;
}

/** The gauge and its label. */
export const AGENT_TRACE_MISSING_GAUGE = {
  name: 'couli_agent_trace_missing_runs',
  help: 'Agent runs ended more than 24 hours ago that emitted cards yet have no card rows, per app_id; erased sessions are not counted (BR-AI-19).',
  label: 'app_id',
} as const;

/**
 * The worker's collectAgentTraceMissing over agent's read-only port. Without a port every call
 * rejects (no 0 is made up); the registry turns that into a failed scrape like any other collector.
 */
export function createAgentTraceMissingCollector(
  port: AgentTraceMissingPort | undefined,
  clock: Clock,
): () => Promise<AgentTraceMissingSnapshot> {
  return async () => {
    if (port === undefined) {
      throw new Error('agent trace missing port is not wired');
    }
    const rows = await port.countMissing(clock.now());
    const missingRuns: Record<string, number> = {};
    for (const { app_id: appId, runs } of rows) missingRuns[appId] = runs;
    return { missingRuns };
  };
}
