// 迁移 0153 给 couli_app 授 agent_runs.input_passed 列级 UPDATE（B3-08t，BR-AI-05 ⑤），冻结授权清单经此追加一列（D10-2465）。
export function allowAgentRunsInputPassed(updatable: { agent_runs: string[] }): void {
  updatable.agent_runs.push('input_passed');
}
