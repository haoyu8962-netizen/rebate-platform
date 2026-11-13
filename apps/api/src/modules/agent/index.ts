// The agent module's only public entry (apps/api/AGENTS.md): other modules import from here.
export { createAgentReportAdminPort } from './application/agent-report.ts';
export type {
  AgentReportAdminPort,
  HandleAgentReportInput,
  HandleAgentReportResult,
} from './application/agent-report.ts';
// B3-03d adds the HTTP layer and the session store; B3-03h the worker assembly of the left-over
// run sweeper (AgentModule.forWorker, agentSweeperToken); the HTTP mount is B3-03f.
// B3-09i: the deletion cleanup port of B3-09e (BR-AI-22), for app.module's deletionCleanupPorts.
export * from './http/index.ts';
export * from './store/index.ts';
export * from './agent.module.ts';
export * from './stream/mount/index.ts';
export {
  createAgentDataPurge,
  readAgentUserHashKey,
  agentUserHash,
  purgedCardText,
} from './deletion/index.ts';
export type {
  AgentDataPurge,
  PurgeAgentDataInput,
  PurgeAgentDataResult,
} from './deletion/index.ts';
// B3-08l: the worker's rule chunk sync (AgentModule.forWorker provides agentRuleSyncToken();
// app.module provides agentRuleArticlesToken(); entry.ts starts it). Contract: rag/chunks/worker.ts.
export {
  agentRuleArticlesToken,
  agentRuleSyncToken,
  createAgentRuleSyncRuntime,
} from './rag/chunks/index.ts';
export type {
  AgentRuleSyncRuntime,
  AgentRuleSyncRuntimeDeps,
  RuleSyncArticles,
  RuleSyncLoop,
  RuleSyncRound,
  RuleSyncSchedule,
  RuleSyncStartOptions,
  RuleSyncTimer,
} from './rag/chunks/index.ts';
// B1-27f: the Agent conversations section of a personal information copy (read only; app.module).
export * from './application/personal-data-copy-read.ts';
// B3-08z: the read-only port of the worker's couli_agent_trace_missing_runs (entry.ts injects it).
export { createPgAgentTraceMissingPort } from './store/trace-missing/index.ts';
export type {
  AgentTraceMissingReadPort,
  AgentTraceMissingRow,
  PgAgentTraceMissingPortDeps,
} from './store/trace-missing/index.ts';
