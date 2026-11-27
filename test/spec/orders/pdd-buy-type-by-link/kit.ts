import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Insertable, Kysely } from 'kysely';
import type { UnionOrderAttrParams } from '../../../../apps/api/src/modules/union/index.ts';
import { at } from '../attribution/kit.ts';

export const LK = 'q7w2e9';
export const GOODS_SIGN = 'test-order-goods-sign';
export const GOODS_ID = '123456789';
export const BEFORE_PAYMENT = '2026-10-14T12:00:00.000Z';

export function params(fields: Record<string, unknown> = {}): UnionOrderAttrParams {
  return {
    relation_id: null,
    sub_union_id: null,
    custom_parameters: JSON.stringify({ app: 'n', uid: 'abcd1234', ...fields }),
  };
}

export async function seedLink(
  db: Kysely<DB>,
  owner: { app_id: string; user_id: string },
  patch: Partial<Insertable<DB['links']>> = {},
) {
  return db
    .insertInto('links')
    .values({
      ...owner,
      link_id: randomUUID(),
      lk: LK,
      platform: 'pdd',
      scene: 'share',
      pid_scene: 'share',
      raw_item_id: GOODS_SIGN,
      product_key: 'pp:other',
      created_at: at(BEFORE_PAYMENT),
      updated_at: at(BEFORE_PAYMENT),
      expire_at: at('2026-11-01T00:00:00.000Z'),
      ...patch,
    })
    .returning('link_id')
    .executeTakeFirstOrThrow();
}
