// B1-05r (BR-PRICE-11, BR-PROD-05, BR-PROD-07, F-ADM-10): queue pool-refresh of the worker entry,
// written as settlement/worker/schedule.ts. One round every pool.refresh_interval_sec per app: time
// is cut into slots of that length, and a slot holds one `refresh` job per (app_id, product_key)
// with an online row, payload { app_id, product_key, platform }. One job per key keeps a long list
// inside the queue's expiry and lets a retry repeat one key only. The union is asked once per job on
// the quota purpose pool_refresh and the answer is written back to every online row of that key. The
// seed decides from the database and pgboss.job only, never from process memory. The queue is
// `standard`, where platform/queue refuses a singletonKey, so a job's id is derived from (app, slot,
// key): pgboss.job keeps it in every state, a send of a known id inserts nothing even when two seeds
// race, and a key that failed or found nothing waits for the next slot.
//
//   live     price_fen, coupon_fen, final_price_fen, commission_rate_bp, shop_name (NULL when the
//            answer has none) and quoted_at of the online rows; raw_item_id stays (quoted_at moved, the raw ID did not, BR-PROD-05)
//   off shelf BR-PROD-05 ①: every row of the key offline with the reason
//   not passed ②, an anomalous price, and a temporary failure ③: nothing changes, age does the rest
//
// Union failures complete the delivery: the next round is the retry. Anything else (a database
// failure, a bug) fails it and takes the queue's retries.
import { createHash } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type {
  Clock,
  JobHandler,
  JobPayload,
  JobQueue,
  RedisNamespace,
} from '../../platform/index.ts';
import { isPriceAnomaly, isRegisteredPlatform, type UnionItemDetail } from '../../union/index.ts';
import { POOL_OFF_SHELF_REASON } from '../application/pool-admin.ts';
import { createPoolSource, type PoolProduct, type PoolSource } from '../application/pool-source.ts';
import type { Catalog } from '../domain/types.ts';
import { createUnionDetailUpstream } from '../infra/detail-wiring.ts';
import type { CatalogConfigReader, GovernedUnion, PoolExtraJobs } from '../ports.ts';
import { isFeedFailure } from '../search.ts';

/** pino's two-argument shape. */
export interface PoolRefreshLogger {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
}

export interface PoolRefreshOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly logger: PoolRefreshLogger;
  readonly config: Pick<CatalogConfigReader, 'configValue'>;
  readonly catalog: Pick<
    Catalog,
    'listPlatforms' | 'resolveProductKey' | 'readProductRef' | 'takeRawItemId'
  >;
  readonly union: GovernedUnion;
  /** BR-PROD-07 主动失效 of the detail cache. */
  readonly dropDetailCache: (appId: string, productKey: string) => Promise<void>;
  /** The re-parse lock's store (RAW_REPARSE_NAMESPACE); absent, nothing is locked. */
  readonly redis?: RedisNamespace | null;
}

const QUEUE = 'pool-refresh';
const JOB = 'refresh';
const PURPOSE = 'pool_refresh';
const INTERVAL_KEY = 'pool.refresh_interval_sec';
/** BR-PRICE-11 pool.refresh_interval_sec default. */
const DEFAULT_INTERVAL_SEC = 3600;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function nonEmptyText(payload: JobPayload, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`pool-refresh: payload field ${field} is not a nonempty string`);
  }
  return value;
}

/** Whole intervals since the epoch: one app's rounds, whatever the worker did in between. */
async function slotOf(options: PoolRefreshOptions, appId: string): Promise<number> {
  const value = (await options.config.configValue(appId, INTERVAL_KEY))?.value;
  const seconds =
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? value
      : DEFAULT_INTERVAL_SEC;
  return Math.floor(options.clock.now().getTime() / (seconds * 1000));
}

/** The one job id of (app, slot, key), in the UUID shape the queue takes. */
function jobId(appId: string, slot: number, productKey: string): string {
  const hex = createHash('sha256')
    .update(JSON.stringify([JOB, appId, slot, productKey]), 'utf8')
    .digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Of `ids`, those the queue holds in any state; the read only saves the sends of a quiet tick. */
async function queuedIds(db: Kysely<DB>, ids: readonly string[]): Promise<ReadonlySet<string>> {
  const { rows } = await sql<{ id: string }>`
    SELECT id::text AS id FROM pgboss.job
    WHERE name = ${QUEUE} AND id = ANY(${[...ids]}::uuid[])
  `.execute(db);
  return new Set(rows.map((row) => row.id));
}

/**
 * Sends the jobs of the round that is due; a round already queued, running or done sends none. A
 * failed send does not stop the others; the first failure is rethrown after all of them.
 */
export async function seedPoolRefresh(options: PoolRefreshOptions): Promise<void> {
  const { db, queue, logger } = options;
  const rows = await db
    .withSchema('app')
    .selectFrom('pool_items')
    .select(['app_id', 'product_key', 'platform'])
    .distinct()
    .where('status', '=', 'online')
    .orderBy('app_id')
    .orderBy('product_key')
    .execute();
  const apps = new Map<string, { readonly key: string; readonly platform: string }[]>();
  for (const { app_id: appId, product_key: key, platform } of rows) {
    // BR-PROD-03: a platform without a union adapter has nobody to ask.
    if (!isRegisteredPlatform(platform)) continue;
    const list = apps.get(appId) ?? [];
    list.push({ key, platform });
    apps.set(appId, list);
  }
  const failures: unknown[] = [];
  for (const [appId, items] of apps) {
    try {
      const slot = await slotOf(options, appId);
      const known = await queuedIds(
        db,
        items.map(({ key }) => jobId(appId, slot, key)),
      );
      for (const { key, platform } of items) {
        const id = jobId(appId, slot, key);
        if (known.has(id)) continue;
        await queue.send(
          QUEUE,
          JOB,
          { app_id: appId, product_key: key, platform },
          { trx: null, id },
        );
      }
    } catch (error: unknown) {
      failures.push(error);
      logger.warn(
        { job: JOB, app_id: appId, error_name: errorName(error) },
        'pool_refresh_seed_failed',
      );
    }
  }
  if (failures.length > 0) throw failures[0];
}

/**
 * BR-PROD-07 主动失效: what this answer ends for a card already cached, a coupon or the commission.
 * The online rows carry the same key, so one that held a coupon is enough.
 */
function endsAnOffer(
  item: UnionItemDetail,
  rows: readonly { readonly coupon_fen: bigint }[],
): boolean {
  return (
    item.commission_rate_bp === 0n ||
    (item.coupon_fen === 0n && rows.some((row) => row.coupon_fen > 0n))
  );
}

/** The price of the answer on every row of the key that is online now; true: drop the cache. */
async function writePrice(
  options: PoolRefreshOptions,
  appId: string,
  productKey: string,
  item: UnionItemDetail,
): Promise<boolean> {
  const { db, clock } = options;
  return db.transaction().execute(async (trx) => {
    // In pool order, as the admin writes lock them (pool-admin.ts): the two cannot deadlock.
    const rows = await trx
      .withSchema('app')
      .selectFrom('pool_items')
      .select(['coupon_fen'])
      .where('app_id', '=', appId)
      .where('product_key', '=', productKey)
      .where('status', '=', 'online')
      .orderBy('pool_id', 'asc')
      .forUpdate()
      .execute();
    await trx
      .withSchema('app')
      .updateTable('pool_items')
      .set({
        price_fen: item.price_fen,
        coupon_fen: item.coupon_fen,
        final_price_fen: item.final_price_fen,
        commission_rate_bp: Number(item.commission_rate_bp),
        // B1-05zd: the latest answer's shop name; absent there means NULL, not the old value.
        shop_name: item.shop_name ?? null,
        quoted_at: item.quoted_at,
        updated_at: clock.now(),
      })
      .where('app_id', '=', appId)
      .where('product_key', '=', productKey)
      .where('status', '=', 'online')
      .execute();
    return endsAnOffer(item, rows);
  });
}

/** BR-PROD-05 结果分类 ①: every row of the key in this app, whichever pool holds it. */
async function takeOffline(
  options: PoolRefreshOptions,
  appId: string,
  productKey: string,
): Promise<void> {
  const { db, clock } = options;
  await db.transaction().execute(async (trx) => {
    await trx
      .withSchema('app')
      .selectFrom('pool_items')
      .select('pool_id')
      .where('app_id', '=', appId)
      .where('product_key', '=', productKey)
      .orderBy('pool_id', 'asc')
      .forUpdate()
      .execute();
    await trx
      .withSchema('app')
      .updateTable('pool_items')
      .set({ status: 'offline', invalid_reason: POOL_OFF_SHELF_REASON, updated_at: clock.now() })
      .where('app_id', '=', appId)
      .where('product_key', '=', productKey)
      .execute();
  });
}

/** The title reparse needs (BR-PROD-05 重新解析步骤 2); null when no row is online any more. */
async function onlineTitle(
  db: Kysely<DB>,
  appId: string,
  productKey: string,
): Promise<string | null> {
  const row = await db
    .withSchema('app')
    .selectFrom('pool_items')
    .select('title')
    .where('app_id', '=', appId)
    .where('product_key', '=', productKey)
    .where('status', '=', 'online')
    .orderBy('pool_id', 'asc')
    .limit(1)
    .executeTakeFirst();
  return row?.title ?? null;
}

/** The pool's union side on the refresh's own quota purpose; no link or item_ref comes in here. */
function refreshSource(options: PoolRefreshOptions): PoolSource {
  const { clock, config, catalog, union, redis } = options;
  return createPoolSource({
    clock,
    config,
    catalog,
    union,
    upstream: createUnionDetailUpstream({ union, purpose: PURPOSE }),
    itemRefs: { read: () => null },
    links: {
      candidates: () => [],
      parse: () => Promise.reject(new Error('pool-refresh: no link is parsed here')),
    },
    purpose: PURPOSE,
    redis: redis ?? null,
  });
}

/**
 * The one handler of queue pool-refresh: its refresh job, and `extraJobs` by job name. The queue
 * settles and retries each job on its own, so every job kind decides its retries alone.
 */
export function createPoolRefreshJobHandler(
  options: PoolRefreshOptions,
  extraJobs: PoolExtraJobs = new Map(),
): JobHandler {
  const { db, logger, dropDetailCache } = options;
  const source = refreshSource(options);
  return async (job) => {
    if (job.name !== JOB) {
      const extra = extraJobs.get(job.name);
      if (extra === undefined) throw new Error(`pool-refresh: unknown job ${job.name}`);
      await extra(job);
      return;
    }
    const appId = nonEmptyText(job.payload, 'app_id');
    const productKey = nonEmptyText(job.payload, 'product_key');
    const platform = nonEmptyText(job.payload, 'platform');
    const fields = { job: JOB, app_id: appId, product_key: productKey };
    if (!isRegisteredPlatform(platform)) {
      throw new Error(`pool-refresh: platform ${platform} has no union adapter`);
    }
    const title = await onlineTitle(db, appId, productKey);
    if (title === null) return;

    let product: PoolProduct;
    try {
      product = await source.current({ appId, platform, productKey, title });
    } catch (error: unknown) {
      if (!isFeedFailure(error)) throw error;
      logger.warn({ ...fields, error_name: errorName(error) }, 'pool_refresh_union_failed');
      return;
    }
    switch (product.kind) {
      case 'live': {
        // pool-source only reads the union's flag; the three fields are checked here (BR-PRICE-01).
        if (isPriceAnomaly(product.item)) {
          logger.warn(fields, 'pool_refresh_price_anomaly');
          return;
        }
        if (await writePrice(options, appId, productKey, product.item)) {
          await dropDetailCache(appId, productKey);
        }
        logger.info(fields, 'pool_refresh_written');
        return;
      }
      case 'off_shelf':
        await takeOffline(options, appId, productKey);
        await dropDetailCache(appId, productKey);
        logger.info(fields, 'pool_refresh_off_shelf');
        return;
      case 'not_passed':
        logger.info({ ...fields, failure: product.failure }, 'pool_refresh_not_passed');
        return;
    }
  };
}
