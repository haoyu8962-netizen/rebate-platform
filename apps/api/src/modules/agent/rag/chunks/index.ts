// B3-08i: rule chunk cutting and sync (no vectors, D10-194).
export { chunkArticle } from './chunk.ts';
export type { RuleChunkDraft, RuleChunkSource } from './chunk.ts';
export { syncRuleChunks } from './sync.ts';
export type { RuleChunkSyncOptions, RuleChunkSyncResult } from './sync.ts';
// B3-08m: search_rules' active chunks of one app (stream entry).
export { createActiveRuleChunksReader } from './active.ts';
// B3-08l: the worker's periodic sync (contract in ./worker.ts).
export {
  agentRuleArticlesToken,
  agentRuleSyncToken,
  createAgentRuleSyncRuntime,
} from './worker.ts';
export type {
  AgentRuleSyncRuntime,
  AgentRuleSyncRuntimeDeps,
  RuleSyncArticles,
  RuleSyncLoop,
  RuleSyncRound,
  RuleSyncSchedule,
  RuleSyncStartOptions,
  RuleSyncTimer,
} from './worker.ts';
