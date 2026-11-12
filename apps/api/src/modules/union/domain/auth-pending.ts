// B1-22zc（编排 D10-1401；BR-ID-24 ①④；01 F-ADM-26 ①）：联盟账号「授权待处理」的唯一判定。
//
// auth_status 是 union_accounts 的存储列（active / expiring / expired），由 union 写入：
// 每日巡检按 union.auth_alert_days 写 expiring；到期、探测返回授权失效、调用返回授权失效时写 expired。
// BR-ID-24 ①④：探测超时、限流等非授权类失败不改 auth_status（只落 last_probe_ok=false），
// 所以「即将到期或探测失效」就是 auth_status ∈ {expiring, expired}，不看 last_probe_ok。
//
// 工作台卡 union_auth_expiring 的计数（application/auth-pending-count.ts）与后台联盟账号列表
// （application/admin-accounts.ts 的 list）的「待处理」行都用这里的定义，不另写第二份。

/** 计为「待处理」的 auth_status 取值。 */
export const UNION_AUTH_PENDING_STATUSES = ['expiring', 'expired'] as const;

export type UnionAuthPendingStatus = (typeof UNION_AUTH_PENDING_STATUSES)[number];

/** auth_status 属于「待处理」（expiring 或 expired）时为 true。 */
export function isUnionAuthPending(status: string): boolean {
  return (UNION_AUTH_PENDING_STATUSES as readonly string[]).includes(status);
}
