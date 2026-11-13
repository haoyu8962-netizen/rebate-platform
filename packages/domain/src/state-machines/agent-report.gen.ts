// 生成物，勿手改。来源：specs/state-machines/agent-report.yaml（字段 report_status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type AgentReportState =
  | 'pending'
  | 'handled';

export const AGENT_REPORT_STATES: readonly AgentReportState[] = ['pending', 'handled'];

export type AgentReportEvent =
  | 'REPORT'
  | 'HANDLE';

export const AGENT_REPORT_EVENTS: readonly AgentReportEvent[] = ['REPORT', 'HANDLE'];

export interface AgentReportTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (AgentReportState | null | '*')[];
  readonly event: AgentReportEvent | null;
  readonly to: AgentReportState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const AGENT_REPORT_TRANSITIONS: readonly AgentReportTransitionRow[] = [
  {
    id: 'AR1',
    from: [null],
    event: 'REPORT',
    to: 'pending',
    guard: '调用方本人会话里的助手消息（BR-AI-20），首次举报：写 reported、report_reason、reported_at（注入时钟）；48 小时时限从此刻起算',
    test_id: 'AC-B3-08zf#16',
  },
  {
    id: 'AR2',
    from: ['pending'],
    event: 'HANDLE',
    to: 'handled',
    guard: '后台处理人查看对话后标记已处理并填写处理说明（BR-ID-15 ④ 细则）：写 report_handler_id、report_handled_at（注入时钟）、report_note，row_version 条件写并加一，写审计（审计由调用方负责）',
    test_id: 'AC-B3-08zf#16',
  },
];

export type AgentReportTransitionResult =
  | { ok: true; to: AgentReportState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionAgentReport(from: AgentReportState | null, event: AgentReportEvent): AgentReportTransitionResult {
  for (const row of AGENT_REPORT_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as AgentReportState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  return { ok: false, reason: 'illegal', id: null };
}
