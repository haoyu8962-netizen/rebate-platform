// B1-22zc（编排 D10-1401；BR-ID-24 ①④；01 F-ADM-26 ①）：工作台卡 union_auth_expiring 的计数。
// 本 app 联盟账号里存储列 auth_status 属于「待处理」（domain/auth-pending.ts，expiring / expired）
// 的条数；后台联盟账号列表（admin-accounts.ts 的 list，不分页、不筛选）的待处理行用的是同一判定。
// 只读；按 (app_id, auth_status) 过滤，走 union_accounts_app_id_id_key（UNIQUE (app_id, id)，
// 用 app_id 前缀），在本 app 的行里再按 auth_status 过滤。
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { UNION_AUTH_PENDING_STATUSES } from '../domain/auth-pending.ts';

/** `appId` 的联盟账号中 auth_status ∈ {expiring, expired} 的条数。 */
export async function countUnionAuthPending(db: Kysely<DB>, appId: string): Promise<number> {
  const row = await db
    .withSchema('app')
    .selectFrom('union_accounts')
    .select((eb) => eb.fn.countAll<string | number | bigint>().as('count'))
    .where('app_id', '=', appId)
    .where('auth_status', 'in', UNION_AUTH_PENDING_STATUSES)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}
