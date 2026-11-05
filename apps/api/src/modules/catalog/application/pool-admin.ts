// B1-05q (CT-07d): the console's product pools, permission point content.pool. catalog is the
// single writer of product_pools and pool_items; every write shares one transaction with its audit
// row. The union is asked before the transaction opens and nothing waits on it inside: the unique
// key (app_id, pool_id, product_key) decides between two concurrent adds of one product. Every
// write first locks all rows of the key in pool order, so the off-shelf write cannot deadlock.
//
//   add     pool → window → product (link, token or pick) → new key inserts, a key in the pool
//           overwrites sort, start_at and end_at and takes the re-check's answer (BR-PROD-08 ③)
//   off shelf (BR-PROD-05 结果分类 ①): every item of that key in the app goes offline with the
//           reason, also when the add itself ends in 30141
//   not passed (ref_expired, 结果分类 ②; a flagged price): only this row stays or goes offline
//           with the reason, its price untouched and the overwrite standing; a new key is refused
//           with the source's code, nothing written
import type { Schema } from '@couli/contracts-ts';
import { fenToJsonNumber } from '@couli/money';
import type { AuditInput, Clock } from '../../platform/index.ts';
import type { Platform } from '../../union/index.ts';
import { toPlusEight } from '../domain/card.ts';
import { CatalogError } from '../domain/rules.ts';
import type { ProductCapabilities, ProductRef } from '../domain/types.ts';
import type { PoolCandidateList, PoolCandidateQuery } from './pool-candidates.ts';
import { poolRawFetchedMs } from './pool-read.ts';
import type { PoolProduct, PoolSource } from './pool-source.ts';

export type PoolStatus = Schema<'AdminProductPoolStatus'>;
export type PoolItemStatus = Schema<'AdminPoolItemStatus'>;

export interface PoolAdminActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface PoolListQuery {
  readonly status?: PoolStatus;
  readonly page?: number;
  readonly page_size?: number;
}

export interface PoolItemListQuery {
  readonly status?: PoolItemStatus;
  readonly page?: number;
  readonly page_size?: number;
}

export interface PoolRow {
  readonly app_id: string;
  readonly pool_id: string;
  readonly name: string;
  readonly status: string;
  readonly revision: bigint;
  readonly created_by: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface PoolItemRow {
  readonly app_id: string;
  readonly pool_id: string;
  readonly product_key: string;
  readonly platform: string;
  readonly raw_item_id: string;
  readonly title: string;
  readonly image: string | null;
  readonly price_fen: bigint;
  readonly coupon_fen: bigint;
  readonly final_price_fen: bigint;
  /** BR-PRICE-07 needs it to quote a pool card; null until a refresh or re-check answers. */
  readonly commission_rate_bp: number | null;
  /** The union's shop name of the latest live answer (B1-05zd); null when it gave none. */
  readonly shop_name: string | null;
  readonly quoted_at: Date;
  readonly status: string;
  readonly sort: number;
  readonly start_at: Date | null;
  readonly end_at: Date | null;
  readonly invalid_reason: string | null;
  readonly created_by: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** The columns a write sets; instants may be the submitted strings. */
export type PoolItemWrite = Omit<
  PoolItemRow,
  'quoted_at' | 'start_at' | 'end_at' | 'created_at' | 'updated_at'
> & {
  readonly quoted_at: Date | string;
  readonly start_at: Date | string | null;
  readonly end_at: Date | string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
};

export interface PoolPage<T> {
  readonly rows: readonly T[];
  readonly total: number;
}

export interface PoolAdminReads {
  pools(
    appId: string,
    status: PoolStatus | undefined,
    page: number,
    pageSize: number,
  ): Promise<PoolPage<PoolRow>>;
  pool(appId: string, poolId: string): Promise<PoolRow | null>;
  items(
    appId: string,
    poolId: string,
    status: PoolItemStatus | undefined,
    page: number,
    pageSize: number,
  ): Promise<PoolPage<PoolItemRow>>;
  item(appId: string, poolId: string, productKey: string): Promise<PoolItemRow | null>;
}

export interface PoolAdminTx {
  /** False when the app already has a pool with this id (nothing written). */
  insertPool(row: PoolRow): Promise<boolean>;
  /** FOR UPDATE; null when the app has no such pool. */
  lockPool(appId: string, poolId: string): Promise<PoolRow | null>;
  updatePool(row: PoolRow): Promise<PoolRow>;
  /** FOR UPDATE on every item of the key in this app, pool_id ascending; this pool's, or null. */
  lockItem(appId: string, poolId: string, productKey: string): Promise<PoolItemRow | null>;
  /** The inserted row; null when a concurrent add won the unique key (nothing written). */
  insertItem(row: PoolItemWrite): Promise<PoolItemRow | null>;
  updateItem(row: PoolItemWrite): Promise<PoolItemRow>;
  /** The removed row; null when there was none. */
  deleteItem(appId: string, poolId: string, productKey: string): Promise<PoolItemRow | null>;
  /** BR-PROD-05 结果分类 ①: every item of the key in this app, whichever pool holds it. */
  takeOffline(appId: string, productKey: string, reason: string, now: Date): Promise<void>;
  /** catalog's registerProductRef on this transaction. */
  registerProductRef(ref: ProductRef, capabilities: ProductCapabilities): Promise<void>;
  audit(input: AuditInput): Promise<void>;
}

export interface PoolAdminStore extends PoolAdminReads {
  transaction<T>(work: (tx: PoolAdminTx) => Promise<T>): Promise<T>;
}

export interface PoolAdminOptions {
  readonly store: PoolAdminStore;
  readonly clock: Clock;
  readonly source: PoolSource;
  readonly candidates: (
    query: PoolCandidateQuery,
    actor: Pick<PoolAdminActor, 'appId' | 'adminId'>,
  ) => Promise<PoolCandidateList>;
  /** BR-PROD-07 主动失效 of the detail cache; a failure only leaves the entry to expire. */
  readonly dropDetailCache: (appId: string, productKey: string) => Promise<void>;
}

/** 20001 with data.fields. */
export class PoolFieldsError extends Error {
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super('catalog: product pool fields refused');
    this.name = 'PoolFieldsError';
    this.fields = fields;
  }
}

/** 20902 data.resource=product_pool. */
export class PoolConflictError extends Error {
  constructor() {
    super('catalog: product pool changed');
    this.name = 'PoolConflictError';
  }
}

/** 30701: no such pool, or no such item in it. */
export class PoolNotFoundError extends Error {
  constructor() {
    super('catalog: product pool or item not found');
    this.name = 'PoolNotFoundError';
  }
}

/** BR-PROD-05 结果分类 ①: the reason shown to the operator. */
export const POOL_OFF_SHELF_REASON = '联盟返回下架';
/** BR-PROD-05 结果分类 ②, the same text as 30143. */
export const POOL_REF_EXPIRED_REASON = '商品信息已失效，请重新搜索';
/** The union flagged the price of this answer (price_status=anomaly). */
export const POOL_PRICE_ANOMALY_REASON = '联盟返回的价格异常';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const POOL_CAPABILITIES: ProductCapabilities = Object.freeze({
  parseEnabled: true,
  searchEnabled: false,
});

function instant(value: Date): string {
  return toPlusEight(value.getTime());
}

function nullableInstant(value: Date | null): string | null {
  return value === null ? null : instant(value);
}

function poolOf(row: PoolRow): Schema<'AdminProductPool'> {
  return {
    pool_id: row.pool_id,
    name: row.name,
    status: row.status as PoolStatus,
    revision: Number(row.revision),
    created_at: instant(row.created_at),
    updated_at: instant(row.updated_at),
  };
}

function itemOf(row: PoolItemRow): Schema<'AdminPoolItem'> {
  return {
    product_key: row.product_key,
    platform: row.platform as Schema<'AdminPoolItem'>['platform'],
    title: row.title,
    image: row.image,
    price_fen: fenToJsonNumber(row.price_fen),
    coupon_fen: fenToJsonNumber(row.coupon_fen),
    final_price_fen: fenToJsonNumber(row.final_price_fen),
    quoted_at: instant(row.quoted_at),
    status: row.status as PoolItemStatus,
    sort: row.sort,
    start_at: nullableInstant(row.start_at),
    end_at: nullableInstant(row.end_at),
    invalid_reason: row.invalid_reason,
    created_by: row.created_by,
    created_at: instant(row.created_at),
    updated_at: instant(row.updated_at),
  };
}

/** The audit snapshot of an item: its wire shape and its pool, never the raw ID (BR-PROD-05). */
function itemSnapshot(row: PoolItemRow): AuditInput['after'] {
  return { pool_id: row.pool_id, ...itemOf(row) };
}

function assertWindow(start: Date | string | null, end: Date | string | null): void {
  if (start === null || end === null) return;
  const startMs = typeof start === 'string' ? Date.parse(start) : start.getTime();
  const endMs = typeof end === 'string' ? Date.parse(end) : end.getTime();
  if (endMs <= startMs) throw new PoolFieldsError(['end_at']);
}

function liveFields(product: Extract<PoolProduct, { kind: 'live' }>) {
  const { item } = product;
  return {
    raw_item_id: product.rawItemId,
    title: item.title,
    image: item.main_image_url ?? null,
    price_fen: item.price_fen,
    coupon_fen: item.coupon_fen,
    final_price_fen: item.final_price_fen,
    commission_rate_bp: Number(item.commission_rate_bp),
    // B1-05zd: the latest answer's own shop name, null when absent; nothing fills it from elsewhere.
    shop_name: item.shop_name ?? null,
    quoted_at: item.quoted_at,
    status: 'online',
    invalid_reason: null,
  };
}

function refOf(
  appId: string,
  product: Extract<PoolProduct, { kind: 'live' }>,
  now: Date,
): ProductRef {
  return {
    appId,
    platform: product.platform,
    productKey: product.productKey,
    rawItemId: product.rawItemId,
    rawFetchedAt: product.item.quoted_at,
    receivedAt: now.toISOString(),
    // Never the operator's text: it may carry another promoter's parameters (BR-PROD-05).
    canonicalUrl: null,
    title: product.item.title,
    shopId: null,
    shopType: null,
    source: 'pool',
  };
}

interface Window {
  readonly sort: number;
  readonly start_at: string | null;
  readonly end_at: string | null;
}

export class PoolAdmin {
  readonly #options: PoolAdminOptions;

  constructor(options: PoolAdminOptions) {
    this.#options = options;
  }

  async listPools(appId: string, query: PoolListQuery): Promise<Schema<'AdminProductPoolList'>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const { rows, total } = await this.#options.store.pools(appId, query.status, page, pageSize);
    return { items: rows.map(poolOf), page, page_size: pageSize, total };
  }

  async getPool(appId: string, poolId: string): Promise<Schema<'AdminProductPool'>> {
    return poolOf(await this.#existing(appId, poolId));
  }

  async createPool(
    actor: PoolAdminActor,
    input: Schema<'AdminProductPoolCreateRequest'>,
  ): Promise<Schema<'AdminProductPool'>> {
    if (!UUID_V7.test(input.pool_id)) throw new PoolFieldsError(['pool_id']);
    const name = input.name.trim();
    if (name === '') throw new PoolFieldsError(['name']);
    const now = this.#options.clock.now();
    const row: PoolRow = {
      app_id: actor.appId,
      pool_id: input.pool_id,
      name,
      status: input.status ?? 'active',
      revision: 0n,
      created_by: actor.adminId,
      created_at: now,
      updated_at: now,
    };
    return this.#options.store.transaction(async (tx) => {
      if (!(await tx.insertPool(row))) throw new PoolConflictError();
      const pool = poolOf(row);
      await tx.audit({
        appId: actor.appId,
        actor: actor.adminId,
        action: 'product_pool_create',
        target: `product_pool:${row.pool_id}`,
        before: null,
        after: pool,
        ip: actor.ip,
      });
      return pool;
    });
  }

  async updatePool(
    actor: PoolAdminActor,
    poolId: string,
    input: Schema<'AdminProductPoolUpdateRequest'>,
  ): Promise<Schema<'AdminProductPool'>> {
    const name = input.name?.trim();
    if (name === '') throw new PoolFieldsError(['name']);
    if (!UUID.test(poolId)) throw new PoolNotFoundError();
    return this.#options.store.transaction(async (tx) => {
      const before = await tx.lockPool(actor.appId, poolId);
      if (before === null) throw new PoolNotFoundError();
      if (Number(before.revision) !== input.expected_revision) throw new PoolConflictError();
      const after = await tx.updatePool({
        ...before,
        name: name ?? before.name,
        status: input.status ?? before.status,
        revision: before.revision + 1n,
        updated_at: this.#options.clock.now(),
      });
      const pool = poolOf(after);
      await tx.audit({
        appId: actor.appId,
        actor: actor.adminId,
        action: 'product_pool_update',
        target: `product_pool:${poolId}`,
        before: poolOf(before),
        after: pool,
        ip: actor.ip,
      });
      return pool;
    });
  }

  async listItems(
    appId: string,
    poolId: string,
    query: PoolItemListQuery,
  ): Promise<Schema<'AdminPoolItemList'>> {
    await this.#existing(appId, poolId);
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const { rows, total } = await this.#options.store.items(
      appId,
      poolId,
      query.status,
      page,
      pageSize,
    );
    return { items: rows.map(itemOf), page, page_size: pageSize, total };
  }

  async addItem(
    actor: PoolAdminActor,
    poolId: string,
    input: Schema<'AdminPoolItemAddRequest'>,
  ): Promise<Schema<'AdminPoolItem'>> {
    const { appId } = actor;
    await this.#existing(appId, poolId);
    assertWindow(input.start_at, input.end_at);
    const window: Window = { sort: input.sort, start_at: input.start_at, end_at: input.end_at };
    const { source, store } = this.#options;
    const product =
      input.item_ref === undefined
        ? await source.fromLink(appId, input.link_text!)
        : await source.fromItemRef(appId, input.item_ref);
    const row = await store.transaction((tx) => this.#place(tx, actor, poolId, product, window));
    if (product.kind === 'off_shelf') await this.#dropCache(appId, product.productKey);
    if (row === null) {
      if (product.kind === 'not_passed') throw product.refusal;
      throw new CatalogError(30141, 'pool: a new key is off the shelf');
    }
    return itemOf(row);
  }

  async updateItem(
    actor: PoolAdminActor,
    poolId: string,
    productKey: string,
    input: Schema<'AdminPoolItemUpdateRequest'>,
  ): Promise<Schema<'AdminPoolItem'>> {
    const { appId } = actor;
    const stored = await this.#existingItem(appId, poolId, productKey);
    assertWindow(...windowAfter(stored, input));
    const recheck =
      input.status === 'online' && stored.status === 'offline' ? await this.#recheck(stored) : null;
    const row = await this.#options.store.transaction(async (tx) => {
      const before = await tx.lockItem(appId, poolId, productKey);
      if (before === null) throw new PoolNotFoundError();
      const [startAt, endAt] = windowAfter(before, input);
      assertWindow(startAt, endAt);
      const now = this.#options.clock.now();
      if (recheck !== null && recheck.kind === 'off_shelf') {
        await tx.takeOffline(appId, recheck.productKey, POOL_OFF_SHELF_REASON, now);
      }
      if (recheck !== null && recheck.kind === 'live') {
        await tx.registerProductRef(refOf(appId, recheck, now), POOL_CAPABILITIES);
      }
      const after = await tx.updateItem({
        ...before,
        sort: input.sort ?? before.sort,
        start_at: startAt,
        end_at: endAt,
        ...(recheck === null
          ? { status: input.status === 'offline' ? 'offline' : before.status }
          : recheckFields(recheck)),
        updated_at: now,
      });
      await tx.audit({
        appId,
        actor: actor.adminId,
        action: 'pool_item_update',
        target: `pool_item:${poolId}:${productKey}`,
        before: itemSnapshot(before),
        after: itemSnapshot(after),
        ip: actor.ip,
      });
      return after;
    });
    if (recheck !== null && recheck.kind === 'off_shelf') {
      await this.#dropCache(appId, recheck.productKey);
    }
    return itemOf(row);
  }

  async removeItem(
    actor: PoolAdminActor,
    poolId: string,
    productKey: string,
  ): Promise<Schema<'AdminPoolItem'>> {
    const { appId } = actor;
    if (!UUID.test(poolId)) throw new PoolNotFoundError();
    return this.#options.store.transaction(async (tx) => {
      const removed = await tx.deleteItem(appId, poolId, productKey);
      if (removed === null) throw new PoolNotFoundError();
      await tx.audit({
        appId,
        actor: actor.adminId,
        action: 'pool_item_remove',
        target: `pool_item:${poolId}:${productKey}`,
        before: itemSnapshot(removed),
        after: null,
        ip: actor.ip,
      });
      return itemOf(removed);
    });
  }

  searchCandidates(
    actor: Pick<PoolAdminActor, 'appId' | 'adminId'>,
    query: PoolCandidateQuery,
  ): Promise<PoolCandidateList> {
    return this.#options.candidates(query, actor);
  }

  /** The row of an add; null when a new key is off the shelf or did not pass (no row written). */
  async #place(
    tx: PoolAdminTx,
    actor: PoolAdminActor,
    poolId: string,
    product: PoolProduct,
    window: Window,
  ): Promise<PoolItemRow | null> {
    const { appId } = actor;
    const { productKey } = product;
    const now = this.#options.clock.now();
    let before = await tx.lockItem(appId, poolId, productKey);
    if (product.kind === 'off_shelf') {
      await tx.takeOffline(appId, productKey, POOL_OFF_SHELF_REASON, now);
      if (before === null) return null;
    } else if (product.kind === 'not_passed') {
      if (before === null) return null;
    } else {
      await tx.registerProductRef(refOf(appId, product, now), POOL_CAPABILITIES);
      if (before === null) {
        const inserted = await tx.insertItem({
          app_id: appId,
          pool_id: poolId,
          product_key: productKey,
          platform: product.platform,
          ...liveFields(product),
          ...window,
          created_by: actor.adminId,
          created_at: now,
          updated_at: now,
        });
        if (inserted !== null) {
          await this.#auditAdd(tx, actor, null, inserted);
          return inserted;
        }
        // A concurrent add of this product committed first: this one is the overwrite.
        before = await tx.lockItem(appId, poolId, productKey);
        if (before === null) throw new Error('catalog: pool item vanished during an add');
      }
    }
    const after = await tx.updateItem({
      ...before,
      ...window,
      ...recheckFields(product),
      updated_at: now,
    });
    await this.#auditAdd(tx, actor, before, after);
    return after;
  }

  async #auditAdd(
    tx: PoolAdminTx,
    actor: PoolAdminActor,
    before: PoolItemRow | null,
    after: PoolItemRow,
  ): Promise<void> {
    await tx.audit({
      appId: actor.appId,
      actor: actor.adminId,
      action: 'pool_item_add',
      target: `pool_item:${after.pool_id}:${after.product_key}`,
      before: before === null ? null : itemSnapshot(before),
      after: itemSnapshot(after),
      ip: actor.ip,
    });
  }

  #recheck(stored: PoolItemRow): Promise<PoolProduct> {
    return this.#options.source.recheck({
      appId: stored.app_id,
      platform: stored.platform as Platform,
      productKey: stored.product_key,
      rawItemId: stored.raw_item_id,
      fetchedAt: toPlusEight(poolRawFetchedMs(stored)),
      title: stored.title,
    });
  }

  async #dropCache(appId: string, productKey: string): Promise<void> {
    await this.#options.dropDetailCache(appId, productKey);
  }

  async #existing(appId: string, poolId: string): Promise<PoolRow> {
    const row = UUID.test(poolId) ? await this.#options.store.pool(appId, poolId) : null;
    if (row === null) throw new PoolNotFoundError();
    return row;
  }

  async #existingItem(appId: string, poolId: string, productKey: string): Promise<PoolItemRow> {
    const row = UUID.test(poolId)
      ? await this.#options.store.item(appId, poolId, productKey)
      : null;
    if (row === null) throw new PoolNotFoundError();
    return row;
  }
}

/** The window a change leaves: a field absent from the body keeps its value, null clears it. */
function windowAfter(
  row: PoolItemRow,
  input: Schema<'AdminPoolItemUpdateRequest'>,
): [Date | string | null, Date | string | null] {
  return [
    input.start_at === undefined ? row.start_at : input.start_at,
    input.end_at === undefined ? row.end_at : input.end_at,
  ];
}

/** What a re-check changes: passed refreshes the item, not passed leaves its price alone. */
function recheckFields(result: PoolProduct) {
  switch (result.kind) {
    case 'live':
      return liveFields(result);
    case 'off_shelf':
      return { status: 'offline', invalid_reason: POOL_OFF_SHELF_REASON };
    case 'not_passed':
      return {
        status: 'offline',
        invalid_reason:
          result.failure === 'price_anomaly' ? POOL_PRICE_ANOMALY_REASON : POOL_REF_EXPIRED_REASON,
      };
  }
}
