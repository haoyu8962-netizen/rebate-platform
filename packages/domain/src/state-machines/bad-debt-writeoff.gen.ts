// 生成物，勿手改。来源：specs/state-machines/bad-debt-writeoff.yaml（字段 status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type BadDebtWriteoffState =
  | 'PENDING'
  | 'APPROVED'
  | 'CANCELLED';

export const BAD_DEBT_WRITEOFF_STATES: readonly BadDebtWriteoffState[] = ['PENDING', 'APPROVED', 'CANCELLED'];

export type BadDebtWriteoffEvent =
  | 'GENERATE'
  | 'APPROVE'
  | 'CANCEL';

export const BAD_DEBT_WRITEOFF_EVENTS: readonly BadDebtWriteoffEvent[] = ['GENERATE', 'APPROVE', 'CANCEL'];

export interface BadDebtWriteoffTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (BadDebtWriteoffState | null | '*')[];
  readonly event: BadDebtWriteoffEvent | null;
  readonly to: BadDebtWriteoffState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const BAD_DEBT_WRITEOFF_TRANSITIONS: readonly BadDebtWriteoffTransitionRow[] = [
  {
    id: 'BD1',
    from: [null],
    event: 'GENERATE',
    to: 'PENDING',
    guard: '每日 R3 后生成负余额报表：当前会计日 − negative_since ≥ ledger.bad_debt_days 且 |available_fen| ≥ ledger.bad_debt_min_fen 时生成候选单（记生成时金额与 negative_since，发起人为空）；同一账户同时最多 1 张 PENDING 候选单，已存在则不再生成；只适用于未注销用户',
    test_id: 'AC-B2-12a#35',
  },
  {
    id: 'BD2',
    from: ['PENDING'],
    event: 'APPROVE',
    to: 'APPROVED',
    guard: '超管或被勾选核销权限的账号 step-up 后批准（一人可完成，写审计）；批准时锁定并重读 available 与 frozen：frozen_fen > 0 且 ledger.bad_debt_require_no_frozen.enabled=on 时拒绝批准、候选单保持 PENDING（不是迁移）；frozen 为 0（或开关 off）且 available < 0 → 写 BAD_DEBT_WRITEOFF 凭证 BADDEBT:{account_id}:{candidate_id}（借 BAD_DEBT / 贷 USER_BALANCE.available，金额 = −当前 available_fen，不用候选单生成时的金额），使 available=0；给同实名、同设备、同收款账号的关联账户打风控标记',
    test_id: 'AC-B2-12a#35',
  },
  {
    id: 'BD3',
    from: ['PENDING'],
    event: 'CANCEL',
    to: 'CANCELLED',
    guard: '批准时重读 available ≥ 0（余额已回正）：候选单置 CANCELLED，不写凭证、不核销，写审计',
    test_id: 'AC-B2-12a#35',
  },
];

export type BadDebtWriteoffTransitionResult =
  | { ok: true; to: BadDebtWriteoffState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionBadDebtWriteoff(from: BadDebtWriteoffState | null, event: BadDebtWriteoffEvent): BadDebtWriteoffTransitionResult {
  for (const row of BAD_DEBT_WRITEOFF_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as BadDebtWriteoffState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  return { ok: false, reason: 'illegal', id: null };
}
