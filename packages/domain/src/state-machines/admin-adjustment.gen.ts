// 生成物，勿手改。来源：specs/state-machines/admin-adjustment.yaml（字段 status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type AdminAdjustmentState =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED';

export const ADMIN_ADJUSTMENT_STATES: readonly AdminAdjustmentState[] = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];

export type AdminAdjustmentEvent =
  | 'PREFILL'
  | 'SUBMIT'
  | 'APPROVE'
  | 'REJECT';

export const ADMIN_ADJUSTMENT_EVENTS: readonly AdminAdjustmentEvent[] = ['PREFILL', 'SUBMIT', 'APPROVE', 'REJECT'];

export interface AdminAdjustmentTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (AdminAdjustmentState | null | '*')[];
  readonly event: AdminAdjustmentEvent | null;
  readonly to: AdminAdjustmentState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const ADMIN_ADJUSTMENT_TRANSITIONS: readonly AdminAdjustmentTransitionRow[] = [
  {
    id: 'AA1',
    from: [null],
    event: 'PREFILL',
    to: 'PENDING',
    guard: '系统预填：用户进入注销 processing（注销处理中，BR-ID-28）且 available > 0 时，系统生成 ACCOUNT_CLOSED 调减单（发起人为空，金额在批准时按当时 available 取，对方科目 COMMISSION_REVENUE，关联注销单）；同一用户同时只有一张待批的 ACCOUNT_CLOSED 单；被驳回后注销完成门仍 pending 的，每个会计日补建一张（D10-590）',
    test_id: 'AC-B2-12a#28',
  },
  {
    id: 'AA2',
    from: [null],
    event: 'SUBMIT',
    to: 'APPROVED',
    guard: '人工一步提交并生效（含红冲单）：超管或被勾选人工调账权限的账号提交方向、金额（分，> 0）、原因码、关联单据、对方科目与内部说明，短信档 step-up（BR-ID-34）后，在同一事务内锁定并重读余额、写 ADMIN_ADJUST 凭证 ADJ:{adjust_id}（红冲单写 ADJ:{原 adjust_id}:REVERSE，只按原单整笔、方向相反、同一原单只能红冲一次），写审计；无权限拒绝并写审计；users.status 为 deleting（注销处理中）或已注销的用户不受理，只允许红冲 ACCOUNT_CLOSED 调减单本身',
    test_id: 'AC-B2-12a#28',
  },
  {
    id: 'AA3',
    from: ['PENDING'],
    event: 'APPROVE',
    to: 'APPROVED',
    guard: '批准预填单：超管或被勾选人工调账权限的账号短信档 step-up 后批准（一人可完成），在同一事务内锁定并重读当时 available 作为金额写 ADMIN_ADJUST 凭证 ADJ:{adjust_id}，回填金额、凭证与批准人，写审计；须在注销 done 前完成',
    test_id: 'AC-B2-12a#28',
  },
  {
    id: 'AA4',
    from: ['PENDING'],
    event: 'REJECT',
    to: 'REJECTED',
    guard: '驳回预填单：须填驳回原因，不需 step-up（短信档、动态码档都不要），不记账、不写凭证，只写审计；注销完成门继续 pending 并照常告警，次一会计日补建（D10-590）',
    test_id: 'AC-B2-12a#28',
  },
];

export type AdminAdjustmentTransitionResult =
  | { ok: true; to: AdminAdjustmentState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionAdminAdjustment(from: AdminAdjustmentState | null, event: AdminAdjustmentEvent): AdminAdjustmentTransitionResult {
  for (const row of ADMIN_ADJUSTMENT_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as AdminAdjustmentState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  return { ok: false, reason: 'illegal', id: null };
}
