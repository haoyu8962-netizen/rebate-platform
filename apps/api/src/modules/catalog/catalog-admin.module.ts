// catalog's admin console routes: /admin/v1/product-pools* (B1-05q, CT-07d). app.module imports this
// module on the admin entry only and hands it GovernedUnion and RebateQuoter through `ports`, the
// configuration reader, admin's audit writer and parsing's link resolution, so catalog imports
// neither content, admin nor parsing. Permission checks go through platform's AdminOperationGuard.
// Without a database handle (isolated HTTP unit tests) the routes still register and every call
// fails closed (50001).
//
// Also compiled by the `test` project: a class decorator only (no parameter decorators or
// parameter properties; dependencies are injected through factories).
import type { DB as Database } from '@couli/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  FIELD_CRYPTO,
  REDIS,
  ROOT_LOGGER,
  type AppConfig,
  type AuditPort,
  type Clock,
  type FieldCrypto,
  type RedisHandle,
  type RootLogger,
} from '../platform/index.ts';
import { createCatalogCardEntry } from './application/card-entry.ts';
import { createCatalog } from './application/catalog.ts';
import type { ItemRefService } from './application/item-ref.ts';
import { PoolAdmin, type PoolAdminActor, type PoolAdminStore } from './application/pool-admin.ts';
import { searchPoolCandidates } from './application/pool-candidates.ts';
import { createPoolSource, type PoolLinkParser } from './application/pool-source.ts';
import {
  catalogCursorCodec,
  catalogItemRefs,
  catalogPidReader,
  UNAVAILABLE_CATALOG,
} from './catalog.module.ts';
import type { Catalog, CatalogWarning } from './domain/types.ts';
import type { SearchCursorCodec } from './search.ts';
import { AdminProductPoolsController } from './http/admin/product-pools.controller.ts';
import { RAW_REPARSE_NAMESPACE } from './application/raw-reparse.ts';
import { createUnionDetailUpstream } from './infra/detail-wiring.ts';
import { createKyselyPoolAdminStore } from './infra/kysely-pool-admin-store.ts';
import {
  PRODUCT_CACHE_NAMESPACE,
  cacheSearchUpstream,
  detailCacheDropper,
} from './infra/product-cache.ts';
import {
  SEARCH_REDIS_NAMESPACE,
  UNAVAILABLE_SEARCH_SESSIONS,
  createRedisSearchSessionStore,
  createUnionSearchUpstream,
} from './infra/search-wiring.ts';
import {
  CatalogConfigReader,
  GovernedUnion,
  RebateQuoter,
  createGuestViewerContext,
  type LinkRegistrar,
  type SourceLinkReader,
  type Viewer,
  type ViewerContext,
} from './ports.ts';

export interface CatalogAdminOptions {
  /** Modules exporting GovernedUnion and RebateQuoter. */
  readonly ports: DynamicModule;
  /** Binds the audit port to a transaction handle (app.module: admin's createAuditWriter). */
  readonly auditWriter: (db: Kysely<Database>, clock: Clock) => AuditPort;
  /** Content's reader (F1-02b), as CatalogModule.forRoot's. */
  readonly config: (db: Kysely<Database>, clock: Clock) => CatalogConfigReader;
  /** Parsing's resolution of a link or token (app.module). */
  readonly links: (db: Kysely<Database>, clock: Clock, logger: RootLogger) => PoolLinkParser;
}

/** The candidates register no link and read no source link: the two ports are never reached. */
const NO_REGISTRAR: LinkRegistrar = {
  register: () => Promise.reject(new Error('catalog: pool candidates register no link')),
};
const NO_SOURCE_LINKS: SourceLinkReader = {
  entrySource: () => Promise.reject(new Error('catalog: pool candidates have no source link')),
};

const refuse = (): Promise<never> =>
  Promise.reject(new Error('catalog: product pools need the database'));

const NO_DATABASE_POOLS: PoolAdminStore = {
  pools: refuse,
  pool: refuse,
  items: refuse,
  item: refuse,
  transaction: refuse,
};

const NO_DATABASE_LINKS: PoolLinkParser = {
  candidates: () => [],
  parse: refuse,
};

/** BR-PROD-08 ②: the admin is the requester of the candidates' session; never a user's identity. */
function adminRequester(actor: Pick<PoolAdminActor, 'appId' | 'adminId'>): ViewerContext {
  const viewer: Viewer = { appId: actor.appId, userId: `admin:${actor.adminId}`, deviceId: null };
  return { current: () => Promise.resolve(viewer) };
}

/** Builds the use case once per process from the entry's handles and app.module's ports. */
function poolAdmin(
  options: CatalogAdminOptions,
  appConfig: AppConfig,
  clock: Clock,
  logger: RootLogger,
  union: GovernedUnion,
  quoter: RebateQuoter,
  config: CatalogConfigReader,
  catalog: Catalog,
  warn: (event: CatalogWarning) => void,
  db?: Kysely<Database>,
  crypto?: FieldCrypto,
  redis?: RedisHandle,
): PoolAdmin {
  // Built on first use, not at startup: the keyring refusal of a misconfigured staging / prod must
  // not get ahead of the admin entry's own start checks; every call then fails closed.
  let tokens: ItemRefService | undefined;
  const tokenService = (): ItemRefService => (tokens ??= catalogItemRefs(appConfig, crypto));
  const itemRefs: ItemRefService = {
    issue: (claims) => tokenService().issue(claims),
    verify: (request) => tokenService().verify(request),
    read: (itemRef, appId) => tokenService().read(itemRef, appId),
  };
  const cache = redis === undefined ? null : redis.namespace(PRODUCT_CACHE_NAMESPACE);
  const search = redis === undefined ? null : redis.namespace(SEARCH_REDIS_NAMESPACE);
  const upstream = cacheSearchUpstream(
    createUnionSearchUpstream({ union, catalog, config, clock, ledger: search, logger }),
    { redis: cache, clock, config },
  );
  let codec: SearchCursorCodec | undefined;
  const cursorCodec = (): SearchCursorCodec => (codec ??= catalogCursorCodec(appConfig, crypto));
  const cursors: SearchCursorCodec = {
    encode: (value) => cursorCodec().encode(value),
    decode: (value) => cursorCodec().decode(value),
  };
  const pids = catalogPidReader(db, clock);
  const sessions =
    search === null ? UNAVAILABLE_SEARCH_SESSIONS : createRedisSearchSessionStore(search);
  return new PoolAdmin({
    clock,
    store:
      db === undefined
        ? NO_DATABASE_POOLS
        : createKyselyPoolAdminStore(
            db,
            (trx) => options.auditWriter(trx, clock),
            (trx) => createCatalog({ db: trx, clock, warn }),
          ),
    source: createPoolSource({
      clock,
      config,
      catalog,
      itemRefs,
      union,
      upstream: createUnionDetailUpstream({ union }),
      links: db === undefined ? NO_DATABASE_LINKS : options.links(db, clock, logger),
      redis: redis === undefined ? null : redis.namespace(RAW_REPARSE_NAMESPACE),
      // B1-05zo: the add and the re-check refuse a blocked category (30147) before any write.
      category: { filter: catalog, logger },
    }),
    candidates: (query, actor) =>
      searchPoolCandidates(query, adminRequester(actor), {
        clock,
        config,
        pids,
        catalog,
        cards: createCatalogCardEntry({
          clock,
          viewerContext: createGuestViewerContext({ appId: actor.appId, deviceId: null }),
          quoter,
          registrar: NO_REGISTRAR,
          sourceLinks: NO_SOURCE_LINKS,
          itemRefs,
          logger,
        }),
        upstream,
        sessions,
        cursors,
        newSessionId: randomUUID,
        logger,
      }),
    dropDetailCache: detailCacheDropper(cache, logger),
  });
}

@Module({})
export class CatalogAdminModule {
  static forAdmin(options: CatalogAdminOptions): DynamicModule {
    return {
      module: CatalogAdminModule,
      imports: [options.ports],
      controllers: [AdminProductPoolsController],
      providers: [
        {
          provide: PoolAdmin,
          inject: [
            APP_CONFIG,
            CLOCK,
            ROOT_LOGGER,
            GovernedUnion,
            RebateQuoter,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
            { token: REDIS, optional: true },
          ],
          useFactory: (
            appConfig: AppConfig,
            clock: Clock,
            logger: RootLogger,
            union: GovernedUnion,
            quoter: RebateQuoter,
            db?: Kysely<Database>,
            crypto?: FieldCrypto,
            redis?: RedisHandle,
          ): PoolAdmin => {
            const config = db === undefined ? { configValue: refuse } : options.config(db, clock);
            const warn = (event: CatalogWarning): void => {
              logger.warn(
                { event: `catalog_${event.kind}`, product_key: event.key },
                'product_key alias chain not resolved',
              );
            };
            const catalog =
              db === undefined ? UNAVAILABLE_CATALOG : createCatalog({ db, clock, warn });
            return poolAdmin(
              options,
              appConfig,
              clock,
              logger,
              union,
              quoter,
              config,
              catalog,
              warn,
              db,
              crypto,
              redis,
            );
          },
        },
      ],
    };
  }
}
