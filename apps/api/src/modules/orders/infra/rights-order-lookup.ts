import type { DB } from '@couli/db';
import type { Kysely, Selectable } from 'kysely';
import type { RegisteredPlatform } from '../../union/index.ts';
import { findPlatformRules } from '../domain/platform-rules/index.ts';
import { orderKeyMatch } from './pipeline-store.ts';

export interface RightsOrderLookupInput {
  readonly app_id: string;
  readonly platform: RegisteredPlatform;
  readonly platform_order_no: string;
}

export type RightsOrderLookupResult =
  | { readonly kind: 'found'; readonly order: Selectable<DB['orders']> }
  | { readonly kind: 'sub_order_no_missing' }
  | { readonly kind: 'not_found' };

/**
 * 平台单号的比较用规范形态：拼多多去掉全部连字符（存储侧也按同样规则规范化后再比较），
 * 其他平台原样（保留连字符与前导零）。不假设连字符的位置，也不转 number。查规则表的 orderNoStripHyphens。
 */
export function normalizeOrderNo(platform: RegisteredPlatform, platformOrderNo: string): string {
  return findPlatformRules(platform)?.orderNoStripHyphens === true
    ? platformOrderNo.replaceAll('-', '')
    : platformOrderNo;
}

type OrderNoColumn = 'sub_order_id' | 'parent_order_id';

/**
 * Read-only sub_order_id lookup within app + platform. PDD adapters store order_sn verbatim
 * (with hyphens), so for PDD both the stored column and the input are hyphen-stripped before
 * comparing: replace(col, '-', '') = <normalized input>. An exact branch is kept next to it in one
 * UNION ALL statement (redundant for matching; it keeps a bound equality on the number). Taobao /
 * JD compare the stored value verbatim.
 * B1-09x (D10-853): the exact sub-number match goes through order_keys and reads orders by its PK
 * (orderKeyMatch; one statement, same row as comparing orders.sub_order_id); the exact parent probe
 * uses orders_parent_order_idx. The pdd hyphen-stripped branches keep their scan
 * (FU-PDD-ORDERNO-NORMALIZED-INDEX).
 * A parent-only hit is diagnostic, never a list of children or a command target.
 * This result is NOT a locked snapshot: caller must lockOrderKey and reread FOR UPDATE
 * before sending a command through the settlement ports.
 */
export async function findOrderForRights(
  db: Kysely<DB>,
  input: RightsOrderLookupInput,
): Promise<RightsOrderLookupResult> {
  const no = normalizeOrderNo(input.platform, input.platform_order_no);
  const strip = findPlatformRules(input.platform)?.orderNoStripHyphens === true;
  const scoped = () =>
    db
      .withSchema('app')
      .selectFrom('orders')
      .where('app_id', '=', input.app_id)
      .where('platform', '=', input.platform);
  const exactSub = () =>
    scoped().where((eb) =>
      orderKeyMatch(eb, { app_id: input.app_id, platform: input.platform, sub_order_ids: no }),
    );
  const exactParent = () =>
    scoped().where('parent_order_id', 'is not', null).where('parent_order_id', '=', no);
  const stripped = (column: OrderNoColumn) =>
    scoped().where((eb) =>
      eb(eb.fn<string>('replace', [eb.ref(column), eb.val('-'), eb.val('')]), '=', no),
    );

  const subQuery = strip
    ? exactSub().selectAll().unionAll(stripped('sub_order_id').selectAll())
    : exactSub().selectAll();
  const order = await subQuery.executeTakeFirst();
  if (order !== undefined) return { kind: 'found', order };

  // Diagnostic probe only: a parent hit is reported, never expanded to its children.
  const parentQuery = strip
    ? exactParent()
        .select('sub_order_id')
        .unionAll(stripped('parent_order_id').select('sub_order_id'))
    : exactParent().select('sub_order_id');
  const parent = await parentQuery.limit(1).executeTakeFirst();
  return parent === undefined ? { kind: 'not_found' } : { kind: 'sub_order_no_missing' };
}
