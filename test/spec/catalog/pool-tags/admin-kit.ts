// CT-07e unit kit: PoolAdmin (catalog/application/pool-admin.ts) over an in-memory store, the same
// seams as its own unit tests. Only the use case is under test: the store records what it is asked
// to write and answers with that row, so the wire item the use case returns shows the stored tags.
// The tags field is read and written through the local types below so that these files typecheck
// before the contract and the row types carry it.
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { expect, vi } from 'vitest';
import type { AuditInput } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  PoolAdmin,
  PoolFieldsError,
  type PoolAdminStore,
  type PoolAdminTx,
  type PoolItemListQuery,
  type PoolItemRow,
  type PoolItemWrite,
  type PoolRow,
} from '../../../../apps/api/src/modules/catalog/application/pool-admin.ts';
import type {
  PoolProduct,
  PoolSource,
} from '../../../../apps/api/src/modules/catalog/application/pool-source.ts';
import { CatalogError } from '../../../../apps/api/src/modules/catalog/domain/rules.ts';

export const NOW = new Date('2026-11-16T02:00:00.000Z');
export const POOL_ID = '0199f105-cccc-7000-8000-000000000001';
export const ACTOR = { appId: 'app_ct07e', adminId: 'admin_ct07e', ip: null };

/** adminAddPoolItem / adminUpdatePoolItem bodies and the list query with the new fields. */
export type AddBody = Schema<'AdminPoolItemAddRequest'> & { tags?: string[] };
export type UpdateBody = Schema<'AdminPoolItemUpdateRequest'> & { tags?: string[] };
export type ListQuery = PoolItemListQuery & { readonly tag?: string };

export const POOL: PoolRow = {
  app_id: ACTOR.appId,
  pool_id: POOL_ID,
  name: '合成商品池',
  status: 'active',
  revision: 1n,
  created_by: ACTOR.adminId,
  created_at: NOW,
  updated_at: NOW,
};

/** A stored row of tb:K1 with these tags. */
export function storedItem(tags: readonly string[], extra: Partial<PoolItemRow> = {}): PoolItemRow {
  return {
    app_id: ACTOR.appId,
    pool_id: POOL_ID,
    product_key: 'tb:K1',
    platform: 'taobao',
    raw_item_id: 'raw-K1',
    title: '合成商品',
    image: null,
    price_fen: 8800n,
    coupon_fen: 800n,
    final_price_fen: 8000n,
    commission_rate_bp: 1500,
    shop_name: null,
    quoted_at: NOW,
    status: 'online',
    sort: 1,
    start_at: null,
    end_at: null,
    invalid_reason: null,
    created_by: 'creator',
    created_at: NOW,
    updated_at: NOW,
    ...extra,
    tags: [...tags],
  } as PoolItemRow;
}

export const LIVE: PoolProduct = {
  kind: 'live',
  productKey: 'tb:K1',
  platform: 'taobao',
  rawItemId: 'fresh-K1',
  item: {
    platform: 'taobao',
    item_id: 'fresh-K1',
    title: '合成商品新标题',
    price_fen: 3990n,
    coupon_fen: 1000n,
    final_price_fen: 2990n,
    commission_rate_bp: 100n,
    quoted_at: NOW.toISOString(),
  },
};
export const OFF_SHELF: PoolProduct = { kind: 'off_shelf', productKey: 'tb:K1' };
export const EXPIRED: PoolProduct = {
  kind: 'not_passed',
  productKey: 'tb:K1',
  failure: 'ref_expired',
  refusal: new CatalogError(30143, 'synthetic expired'),
};

export const ADD = {
  link_text: 'https://demo.invalid/taobao/raw-K1',
  sort: 9,
  start_at: null,
  end_at: null,
};

export { tagsOf } from './model.ts';

export function harness(stored: PoolItemRow | null, product: PoolProduct = LIVE) {
  const audits: AuditInput[] = [];
  // The written row itself (no defaults filled in), so a write without tags shows as one.
  const answer = (row: PoolItemWrite): PoolItemRow => ({ ...row, quoted_at: NOW }) as PoolItemRow;
  const tx: PoolAdminTx = {
    insertPool: () => Promise.resolve(true),
    lockPool: () => Promise.resolve(POOL),
    updatePool: (row) => Promise.resolve(row),
    lockItem: () => Promise.resolve(stored),
    insertItem: (row) => Promise.resolve(answer(row)),
    updateItem: (row) => Promise.resolve(answer(row)),
    deleteItem: () => Promise.resolve(stored),
    takeOffline: () => Promise.resolve(),
    registerProductRef: () => Promise.resolve(),
    audit: (input) => {
      audits.push(input);
      return Promise.resolve();
    },
  };
  const insertItem = vi.spyOn(tx, 'insertItem');
  const updateItem = vi.spyOn(tx, 'updateItem');
  const store: PoolAdminStore = {
    pools: () => Promise.resolve({ rows: [POOL], total: 1 }),
    pool: () => Promise.resolve(POOL),
    items: () => Promise.resolve({ rows: stored === null ? [] : [stored], total: 1 }),
    item: () => Promise.resolve(stored),
    transaction: (work) => work(tx) as never,
  };
  const source: PoolSource = {
    fromLink: () => Promise.resolve(product),
    fromItemRef: () => Promise.resolve(product),
    recheck: () => Promise.resolve(product),
    current: () => Promise.resolve(product),
  };
  const admin = new PoolAdmin({
    store,
    source,
    clock: { now: () => NOW },
    candidates: () => Promise.resolve({ items: [], next_cursor: null }),
    dropDetailCache: () => Promise.resolve(),
  });
  return {
    admin,
    audits,
    insertItem,
    updateItem,
    /** The row of the only write. */
    written(): PoolItemWrite {
      const calls = [...insertItem.mock.calls, ...updateItem.mock.calls];
      expect(calls, 'exactly one item write').toHaveLength(1);
      return calls[0]![0];
    },
  };
}

/** The use case refused with 20001 and exactly these data.fields. */
export async function expectFields(run: Promise<unknown>, fields: readonly string[]) {
  let error: unknown;
  try {
    await run;
  } catch (caught) {
    error = caught;
  }
  expect(error, 'a refusal').toBeInstanceOf(Error);
  if (error instanceof PoolFieldsError) {
    expect([...error.fields]).toEqual(fields);
    return;
  }
  expect(error).toBeInstanceOf(CatalogError);
  expect(error).toMatchObject({ code: 20001, data: { fields } });
}
