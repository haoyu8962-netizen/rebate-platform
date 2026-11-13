/** Read-only view handed to the metrics registry; record() stays inside agent. */
export interface AgentEmptyReplyCounter {
  total(): number;
}

/** Stable Nest token for the process-local counter shared by stream runtimes. */
export function agentEmptyReplyCounterToken(): symbol {
  throw new Error('NotImplemented: agentEmptyReplyCounterToken');
}
