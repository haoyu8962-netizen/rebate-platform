// B1-08zzf：给拼多多单造 app.links 行（BR-ATTR-08：订单带 lk 时按登记的 link 判 buy_type）。只造数据，不做断言。
// 调用方保证：user_id 是该单按 uid 归属的用户、raw_item_id 是该单 goods_sign、created_at 不晚于该单 paid_at，
// pid_scene 取该单推广位原来的场景，判定结果与按推广位判一致。
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface PddLinkSeed {
  readonly app_id: string;
  readonly user_id: string;
  /** 1–16 位 [0-9a-z]；同一 App 内唯一（links_app_id_lk_key）。 */
  readonly lk: string;
  /** 拼多多存 goods_sign。 */
  readonly raw_item_id: string;
  readonly product_key?: string | null;
  readonly pid_scene: string;
  readonly created_at: Date;
}

/** 插一行 platform='pdd' 的 links，返回 link_id。 */
export async function seedPddLink(db: Kysely<DB>, seed: PddLinkSeed): Promise<string> {
  const row = await db
    .insertInto('links')
    .values({
      link_id: randomUUID(),
      app_id: seed.app_id,
      user_id: seed.user_id,
      lk: seed.lk,
      platform: 'pdd',
      scene: seed.pid_scene,
      pid_scene: seed.pid_scene,
      raw_item_id: seed.raw_item_id,
      product_key: seed.product_key ?? null,
      created_at: seed.created_at,
      updated_at: seed.created_at,
      expire_at: new Date('2027-01-01T00:00:00.000Z'),
    })
    .returning('link_id')
    .executeTakeFirstOrThrow();
  return row.link_id;
}
