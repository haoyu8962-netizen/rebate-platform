// 生成物，勿手改。来源：specs/state-machines/union-binding.yaml（字段 status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type UnionBindingState =
  | 'unbound'
  | 'pending_auth'
  | 'active'
  | 'invalid'
  | 'released'
  | 'blocked';

export const UNION_BINDING_STATES: readonly UnionBindingState[] = ['unbound', 'pending_auth', 'active', 'invalid', 'released', 'blocked'];

export type UnionBindingEvent =
  | 'ACTIVATE'
  | 'INVALIDATE'
  | 'BLOCK'
  | 'RELEASE';

export const UNION_BINDING_EVENTS: readonly UnionBindingEvent[] = ['ACTIVATE', 'INVALIDATE', 'BLOCK', 'RELEASE'];

export interface UnionBindingTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (UnionBindingState | null | '*')[];
  readonly event: UnionBindingEvent | null;
  readonly to: UnionBindingState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const UNION_BINDING_TRANSITIONS: readonly UnionBindingTransitionRow[] = [
  {
    id: 'U1',
    from: [null],
    event: 'ACTIVATE',
    to: 'active',
    guard: '用户授权成功且通过唯一校验，直接插入 active 行（授权进行中只记在 union_auth_sessions，pending_auth 不产生；冷却结束后他人或本人授权同一 relation_id 也是新建行，BR-ID-19）',
    test_id: 'SM-UB-U1',
  },
  {
    id: 'U2',
    from: ['unbound'],
    event: 'ACTIVATE',
    to: 'active',
    guard: '用户授权成功且通过唯一校验；unbound 不落库、现写者不产生，0018 CHECK 允许的投影值作为显式边保留（BR-ID-19 细则「unbound 不落库」）',
    test_id: 'SM-UB-U2',
  },
  {
    id: 'U3',
    from: ['pending_auth'],
    event: 'ACTIVATE',
    to: 'active',
    guard: '用户授权成功且通过唯一校验；pending_auth 为保留取值、不产生，存量行仍经此入口（BR-ID-19 细则「pending_auth 不产生」）',
    test_id: 'SM-UB-U3',
  },
  {
    id: 'U4',
    from: ['invalid'],
    event: 'ACTIVATE',
    to: 'active',
    guard: '淘宝重新授权拿到同一 relation_id，更新原行、不改 bound_at（不同 relation_id 视同换绑返回 30151、原行保持 invalid，BR-ID-21）；拼多多等其他联盟解封或恢复返利后直接回到 active（BR-ID-20）',
    test_id: 'SM-UB-U4',
  },
  {
    id: 'U5',
    from: ['released'],
    event: 'ACTIVATE',
    to: 'active',
    guard: '本人在冷却期内（cooldown_until > now，由调用方判断）且尚未绑定其他账号时授权回原 relation_id，原行恢复 active，清空 released_at 与 cooldown_until（BR-ID-19）',
    test_id: 'SM-UB-U5',
  },
  {
    id: 'U6',
    from: ['active'],
    event: 'INVALIDATE',
    to: 'invalid',
    guard: '每日巡检判定淘宝备案失效：复核为未备案或 relation_id 不一致，或可匹配 link_log 但 relation_id 为空的订单连续 3 笔；查询失败不改状态（BR-ID-21）',
    test_id: 'SM-UB-U6',
  },
  {
    id: 'U7',
    from: ['blocked'],
    event: 'INVALIDATE',
    to: 'invalid',
    guard: '淘宝绑定 blocked_reason=ban 在解封后（BR-ID-31）、blocked_reason=admin_disable 经后台「恢复返利」改为 invalid，用户须重新授权（BR-ID-20）；deletion 不走此边',
    test_id: 'SM-UB-U7',
  },
  {
    id: 'U8',
    from: ['pending_auth', 'active', 'invalid'],
    event: 'BLOCK',
    to: 'blocked',
    guard: '封禁（ban）、后台「停用返利」（admin_disable）或注销（deletion），同次写 blocked_reason；被封禁用户注销时保持 ban（BR-ID-20）',
    test_id: 'SM-UB-U8',
  },
  {
    id: 'U9',
    from: ['active', 'invalid'],
    event: 'RELEASE',
    to: 'released',
    guard: '后台「重置授权」（reason=admin_reset，只作用于 active、invalid），写 released_at=操作时刻、cooldown_until=released_at + bind.rebind_cooldown_days（BR-ID-20）',
    test_id: 'SM-UB-U9',
  },
  {
    id: 'U10',
    from: ['blocked'],
    event: 'RELEASE',
    to: 'released',
    guard: '只限 blocked_reason=deletion：每日释放任务在注销 done_at 满 180 天后置 released，released_at=任务运行时刻、cooldown_until=released_at + bind.rebind_cooldown_days；ban、admin_disable 永不自动释放（BR-ID-20）',
    test_id: 'SM-UB-U10',
  },
];

export type UnionBindingTransitionResult =
  | { ok: true; to: UnionBindingState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionUnionBinding(from: UnionBindingState | null, event: UnionBindingEvent): UnionBindingTransitionResult {
  for (const row of UNION_BINDING_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as UnionBindingState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  return { ok: false, reason: 'illegal', id: null };
}
