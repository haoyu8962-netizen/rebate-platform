// Test-stage placeholders; implementation replaces these exports with generated YAML output.
export type AgentReportState = 'pending' | 'handled';
export type AgentReportEvent = 'REPORT' | 'HANDLE';
export type AgentReportTransitionResult =
  | { ok: true; to: AgentReportState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal'; id: null };

export function transitionAgentReport(
  from: AgentReportState | null,
  event: AgentReportEvent,
): AgentReportTransitionResult {
  void from;
  void event;
  throw new Error('NotImplemented: transitionAgentReport');
}

// Function placeholders keep runtime imports defined without introducing constant initializers.
export function AGENT_REPORT_STATES(): never {
  throw new Error('NotImplemented: AGENT_REPORT_STATES');
}
export function AGENT_REPORT_EVENTS(): never {
  throw new Error('NotImplemented: AGENT_REPORT_EVENTS');
}
export function AGENT_REPORT_TRANSITIONS(): never {
  throw new Error('NotImplemented: AGENT_REPORT_TRANSITIONS');
}
