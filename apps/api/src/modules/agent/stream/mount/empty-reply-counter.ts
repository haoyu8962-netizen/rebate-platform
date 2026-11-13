// B1-01zzv（BR-AI-01 不空回复计数接 /metrics）：stream 入口进程内唯一的不空回复计数器。
// - 模块级单例：每个 createAgentStreamRuntime 都用这一个（再建运行体不清零、不替换）。
// - AgentModule.forStream 以 agentEmptyReplyCounterToken() 提供并导出它；entry.ts 在 stream 入口按令牌
//   取只读的 total()，交给 platform 指标注册表的 collectAgentReplyEmpty（couli_agent_reply_empty_total）。
// - record() 只在 agent 内部调用（agent-body.ts 的 emptyReplyPort），签名同 EmptyReplyCounter。
import type { EmptyReplyCounter } from '../../orchestrator/core/intent-fallback.ts';

/** Read-only view handed to the metrics registry; record() stays inside agent. */
export interface AgentEmptyReplyCounter {
  total(): number;
}

const AGENT_EMPTY_REPLY_COUNTER = Symbol('AGENT_EMPTY_REPLY_COUNTER');

let count = 0;

const counter: EmptyReplyCounter & AgentEmptyReplyCounter = {
  record() {
    count += 1;
  },
  total: () => count,
};

/** Stable Nest token for the process-local counter shared by stream runtimes. */
export function agentEmptyReplyCounterToken(): symbol {
  return AGENT_EMPTY_REPLY_COUNTER;
}

/** The process-local counter itself (the same object on every call). */
export function agentEmptyReplyCounter(): EmptyReplyCounter & AgentEmptyReplyCounter {
  return counter;
}
