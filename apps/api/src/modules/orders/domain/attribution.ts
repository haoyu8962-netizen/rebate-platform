// B1-08h: pure attribution rules for one union sub-order (BR-ATTR-06/07/08). No I/O here; the
// pipeline feeds port rows in and writes the decision. Reused by B1-08i (unattributed re-run).
import type { RegisteredPlatform, UnionOrderAttrParams } from '../../union/index.ts';
import { findPlatformRules } from './platform-rules/index.ts';
import { parseJsonObject } from './platform-rules/params.ts';

export interface BindingRow {
  readonly user_id: string;
  readonly bound_at: Date | null;
  readonly released_at: Date | null;
  readonly cooldown_until: Date | null;
}

export type BindingDecision =
  | { readonly kind: 'matched'; readonly user_id: string }
  | { readonly kind: 'miss' | 'conflict'; readonly user_id: null };

export interface BuyTypeDecision {
  readonly buy_type: 'self' | 'share';
  readonly scene_basis: 'pid' | 'param' | 'fallback';
}

export interface BuyTypeLinkFacts {
  readonly user_id: string | null;
  readonly platform: string;
  readonly raw_item_id: string | null;
  readonly product_key: string | null;
  readonly created_at: Date;
  readonly pid_scene: string | null;
}

export interface BuyTypeLinkOrder {
  readonly user_id: string | null;
  readonly platform: RegisteredPlatform;
  readonly goods_sign: string | null;
  readonly product_key: string | null;
  readonly paid_at: Date | null;
}

export interface LinkBuyTypeDecision {
  readonly buy_type: BuyTypeDecision['buy_type'];
  readonly scene_basis: 'link' | 'fallback';
}

export function classifyBuyTypeByLink(
  order: BuyTypeLinkOrder,
  link: BuyTypeLinkFacts | null,
): LinkBuyTypeDecision {
  void order;
  void link;
  throw new Error('NotImplemented: classifyBuyTypeByLink');
}

// B1-08za：订单参数的解析器移到 platform-rules/params.ts（按平台的取值在 platform-rules/<platform>.ts），
// 这里按原名再导出。
export { JD_SUB_UNION, parseJsonObject } from './platform-rules/params.ts';

/**
 * BR-ATTR-06：从订单参数解析 attr_code；只看本平台自己的参数字段，解析失败返回 null。
 * 解析方式查规则表（platform-rules/<platform>.ts 的 attribution）：京东看 sub_union_id；拼多多看
 * custom_parameters（JSON 对象、app==="n"、uid 为 8 位字符串，uid 是 number 算失败）；淘宝走
 * relation_id 绑定（BR-ATTR-07），这里恒为 null。
 */
export function parseAttrCode(
  platform: RegisteredPlatform,
  params: UnionOrderAttrParams,
): string | null {
  const attribution = findPlatformRules(platform)?.attribution;
  return attribution?.kind === 'attr_code' ? attribution.parseAttrCode(params) : null;
}

/**
 * BR-ATTR-07：在 relation_id 命中的绑定里，取 bound_at 非空、bound_at ≤ attr_at、且
 * attr_end_at = COALESCE(cooldown_until, released_at) 为空或 attr_at < attr_end_at 的那些；
 * 不看当前 status。0 条 → miss；只有一个 user_id → matched；多个不同 user_id → conflict。
 */
export function resolveBinding(rows: readonly BindingRow[], attrAt: Date): BindingDecision {
  const at = attrAt.getTime();
  const users = new Set<string>();
  for (const row of rows) {
    if (row.bound_at === null) continue;
    if (row.bound_at.getTime() > at) continue;
    const end = row.cooldown_until ?? row.released_at;
    if (end !== null && !(at < end.getTime())) continue;
    users.add(row.user_id);
  }
  if (users.size === 0) return { kind: 'miss', user_id: null };
  if (users.size > 1) return { kind: 'conflict', user_id: null };
  const [userId] = users;
  return { kind: 'matched', user_id: userId! };
}

/** BR-ATTR-08 场景取值（推广位或参数）→ buy_type：share → share，其余 → self。 */
const SCENES: ReadonlyMap<string, 'self' | 'share'> = new Map([
  ['self_buy', 'self'],
  ['agent', 'self'],
  ['share', 'share'],
  ['taolijin', 'self'],
]);

/** pid_scene 是否是 BR-ATTR-08 写明的取值（四个场景或 fallback）；其余（如 query）由调用方告警。 */
export function isKnownPidScene(pidScene: string): boolean {
  return SCENES.has(pidScene) || pidScene === 'fallback';
}

/**
 * BR-ATTR-08：① 推广位 pid_scene 是四个场景之一 → 直接取（scene_basis=pid）；② pid_scene=fallback
 * 时读 custom_parameters.sc（只有规则表 sceneParamFallback 打开的平台：拼多多），取值在四个场景内 → 采用
 * （scene_basis=param）；③ 其余（sc 缺失、非法、sc=fallback、该平台不回退、未写明的 pid_scene 如 query）→
 * self / fallback。
 */
export function classifyBuyType(
  platform: RegisteredPlatform,
  pidScene: string,
  customParameters: string | null,
): BuyTypeDecision {
  const byPid = SCENES.get(pidScene);
  if (byPid !== undefined) return { buy_type: byPid, scene_basis: 'pid' };
  if (pidScene === 'fallback' && findPlatformRules(platform)?.sceneParamFallback === true) {
    const sc = parseJsonObject(customParameters)?.['sc'];
    const byParam = typeof sc === 'string' ? SCENES.get(sc) : undefined;
    if (byParam !== undefined) return { buy_type: byParam, scene_basis: 'param' };
  }
  return { buy_type: 'self', scene_basis: 'fallback' };
}
