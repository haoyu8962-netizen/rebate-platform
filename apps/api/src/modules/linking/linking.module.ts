import type { DB as Database } from '@couli/db';
import { type DynamicModule, type FactoryProvider, Module, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { Kysely } from 'kysely';
import {
  SourceLinkReader,
  createCatalogCardEntry,
  type CardRebateQuoter,
  type Catalog,
  type CatalogProductReader,
  type CatalogProductSummary,
  type ItemRefService,
  type ViewerContext,
} from '../catalog/index.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  IDEMPOTENCY,
  JOB_QUEUE,
  REDIS,
  ROOT_LOGGER,
  type AppConfig,
  type Clock,
  type HandlerResult,
  type Idempotency,
  type JobQueue,
  type RedisHandle,
  type RootLogger,
  type VerifiedDevice,
} from '../platform/index.ts';
import {
  type RegisteredPlatform,
  type UnionAdapter,
  type UnionPidService,
} from '../union/index.ts';
import { LinkOpenService, type LinkOpenInput } from './application/link-open.ts';
import {
  LinkConvertService,
  createLinkConvert,
  type LinkConvertInput,
  type LinkConvertUrlParser,
} from './application/link-convert.ts';
import { createLinkOpenPrices } from './application/link-open-prices.ts';
import {
  createTaobaoLinkOpen,
  type TaobaoLinkOpenOptions,
} from './application/link-open-taobao.ts';
import { createLinkOpenFlights, type LinkOpenFlights } from './application/link-open-requote.ts';
// Through the module namespace, so the composition is observable where it is built.
import {
  type LinkOpenApps,
  type LinkOpenEnvironment,
  type LinkOpenQuoteReads,
} from './application/link-open-wiring.ts';
import {
  LINK_JUMP_REDIS_NAMESPACE,
  NO_JUMP_CACHE,
  createRedisJumpCache,
  type LinkJumpCache,
} from './infra/jump-cache.ts';
import {
  createLinkRegistration,
  createSourceLinkReader,
  type LinkRegistration,
  type RegistrationContext,
} from './application/link-registration.ts';
import {
  LinkLandingService,
  createLandingLinks,
  createLinkLanding,
  createSnapshotCardReader,
} from './application/link-landing.ts';
import { LinkLandingController } from './http/public/landing.controller.ts';
import { SharePageMaterials, SharePageService, createSharePage } from './application/share-page.ts';
import { SharePageController } from './http/public/share-page.controller.ts';
import {
  NO_SHARE_TICKET_STORE,
  SHARE_PAGE_REDIS_NAMESPACE,
  createRedisShareTicketStore,
} from './infra/share-page-store.ts';
import { createShareSharerBindings } from './infra/share-page-reads.ts';
import { StoredSharePageMaterials } from './infra/share-material-store.ts';
import {
  createPromoPrefetch,
  createPromoPrefetchLimiter,
  isProductDetailRoute,
} from './application/promo-prefetch.ts';
import { SharesService, createShares, type CreateShareInput } from './application/shares.ts';
import { SharesController } from './http/public/shares.controller.ts';
import { LinkOpenController } from './http/public/open.controller.ts';
import { LinkConvertController } from './http/public/convert.controller.ts';
import { UNION_AUTH_URL, UnionAuthUrlController } from './http/public/auth-url.controller.ts';
import { createUnionAuthUrl, type UnionAuthUrlService } from './application/union-auth-url.ts';
import { createDemoUnionAuthApps, type UnionAuthApps } from './infra/auth-apps.ts';
import { UNION_BINDINGS, UnionBindingsController } from './http/public/bindings.controller.ts';
import { createUnionBindings, type UnionBindingsService } from './application/union-bindings.ts';
import { createUnionBindingsWithPddQuery } from './application/union-bindings-pdd.ts';
import { createUnionAuthReads } from './application/union-auth-reads.ts';
import { UnionBindingExchanger } from './application/union-binding-exchanger.ts';
import { createLinkingPidReader } from './infra/pid-reader.ts';
import {
  AttrCodeReader,
  CallerContext,
  LinkingConfigReader,
  createGuestCallerContext,
  createUnavailableAttrCodeReader,
  type Caller,
} from './ports.ts';

/** Builds the configuration port; app.module.ts passes content's reader (F1-02b). */
export type LinkingConfigReaderFactory = (
  db: Kysely<Database>,
  clock: Clock,
) => LinkingConfigReader;

/** Per-request factory of card registrations: the scene belongs to the calling use case. */
export interface LinkRegistrations {
  forContext(context: RegistrationContext): LinkRegistration;
}

/** Nest injection tokens provided by `LinkingModule`. */
export const LINK_REGISTRATIONS = Symbol('LINK_REGISTRATIONS');
export const LINKING_PIDS = Symbol('LINKING_PIDS');
/** The open's ports outside linking, provided by app.module.ts (B1-06w). */
export const LINK_OPEN_PORTS = Symbol('LINK_OPEN_PORTS');
/** The landing card's ports outside linking, provided by app.module.ts (B1-06j). */
export const LINK_LANDING_PORTS = Symbol('LINK_LANDING_PORTS');
/**
 * B1-06g: the application references of the Taobao auth methods, optional; without it the demo
 * references of non-production environments are used (infra/auth-apps.ts).
 */
export const LINKING_AUTH_APPS = Symbol('LINKING_AUTH_APPS');
/** Process-wide open state: the shared single-flight windows and the Redis jump cache. */
const LINK_OPEN_PROCESS = Symbol('LINK_OPEN_PROCESS');

/**
 * B1-06w: what the open needs from other modules, assembled by the composition root so linking
 * imports neither the union registry nor catalog's providers. None of them may take a database
 * connection while the open holds its transaction (B1-06m): the union adapters call HTTP, the
 * quoter's rule versions, viewer levels and configuration are pre-read through quoteReads, the
 * item_ref issuer only encrypts.
 */
export interface LinkOpenPorts {
  /** The process's governed union adapters (one per platform, B1-05j). */
  readonly union: { adapter(platform: RegisteredPlatform): UnionAdapter };
  /** The quoter of catalog's card entry (commission's real quoter in prod / live, B2-03d). */
  readonly quoter: CardRebateQuoter;
  readonly itemRefs: Pick<ItemRefService, 'issue'>;
  readonly quoteReads: LinkOpenQuoteReads;
  /** contracts/apps.json as read when the entry started. */
  readonly apps: LinkOpenApps;
  /** Jump paths verified per platform and client (CAP-JD-11 / CAP-PDD-11). */
  readonly verifiedPaths: LinkOpenEnvironment['verifiedPaths'];
  /**
   * B1-06i: what POST /v1/links/convert resolves products with — catalog (platforms,
   * product_refs, the raw-ID order), the item_ref verifier and parsing's by-URL port. Absent (no
   * database handle) every convert fails closed with 50301.
   */
  readonly convert?: LinkConvertPorts;
  /**
   * B1-15w: what POST /v1/shares reads outside linking beyond the convert's ports — identity's
   * realname reader (the verified birth date, BR-INV-19). Absent (no database handle or field
   * keyring) every share fails closed with 50301.
   */
  readonly shares?: LinkSharePorts;
}

/** B1-15w: the share's ports outside linking, assembled by app.module.ts. */
export interface LinkSharePorts {
  /** The verified birth date (YYYY-MM-DD) of the user, or null when not verified. */
  verifiedBirthDate(appId: string, userId: string): Promise<string | null>;
}

/** B1-06i: the convert's ports outside linking, assembled by app.module.ts. */
export interface LinkConvertPorts {
  readonly products: Catalog;
  readonly itemRefs: ItemRefService;
  readonly urlParser: LinkConvertUrlParser;
}

/** B1-06j: what the landing card reads from other modules (catalog's read-only product port). */
export interface LinkLandingPorts {
  readonly products: Pick<CatalogProductReader, 'read'>;
}

const NO_PRODUCT: CatalogProductSummary = Object.freeze({
  title: null,
  image: null,
  shopName: null,
  shopType: null,
});

/** Without LINK_LANDING_PORTS (isolated HTTP unit tests) the product fields are null, never guessed. */
const NO_PRODUCTS: LinkLandingPorts['products'] = { read: () => Promise.resolve(NO_PRODUCT) };

interface LinkOpenProcess {
  readonly flights: LinkOpenFlights;
  readonly cache: LinkJumpCache;
}

type PidReader = Pick<UnionPidService, 'getActivePid'>;

function unavailable(): Promise<never> {
  return Promise.reject(new Error('linking: no database handle in this process'));
}

/** Entries built without database handles (isolated HTTP unit tests) fail at call time. */
const UNAVAILABLE_CONFIG: LinkingConfigReader = { configValue: unavailable };
const UNAVAILABLE_SOURCES: SourceLinkReader = { entrySource: unavailable };
const UNAVAILABLE_PIDS: PidReader = { getActivePid: unavailable };

/** A request without an app scope has no caller at all: every read of it fails closed. */
class UnscopedCallerContext extends CallerContext {
  current(): Promise<Caller> {
    return Promise.reject(new Error('linking: request carries no app scope'));
  }
}

interface ScopedRequest {
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  /** Set by the signature check (request-checks stage ①) once the device's signature verified. */
  readonly verifiedDevice?: VerifiedDevice;
}

/** A port provider without its token: the module supplies its own abstract class as `provide`. */
export type LinkingPortProvider<T> = Omit<FactoryProvider<T>, 'provide'>;

/**
 * Optional port replacements (B1-02m): app.module.ts passes identity's request-scoped caller and
 * its attr_code reader on the `api` entry. Each one absent keeps the default below unchanged.
 */
export interface LinkingPorts {
  readonly callerContext?: LinkingPortProvider<CallerContext>;
  readonly attrCodeReader?: LinkingPortProvider<AttrCodeReader>;
}

const GUEST_CALLER: FactoryProvider<CallerContext> = {
  provide: CallerContext,
  scope: Scope.REQUEST,
  inject: [REQUEST],
  useFactory: (request: ScopedRequest): CallerContext => {
    const appId = request.headers?.['x-app-id'];
    if (typeof appId !== 'string' || appId === '') return new UnscopedCallerContext();
    // B1-06w: the guest's device is the one the signature check verified for this app
    // (the open's idempotency subject); an unverified X-Device-Id is never trusted.
    const device = request.verifiedDevice;
    const deviceId = device !== undefined && device.appId === appId ? device.deviceId : null;
    return createGuestCallerContext({ appId, deviceId });
  },
};

const UNAVAILABLE_ATTR_CODES: FactoryProvider<AttrCodeReader> = {
  provide: AttrCodeReader,
  useFactory: createUnavailableAttrCodeReader,
};

/**
 * The open use case of a process without its ports (no database, idempotency or LINK_OPEN_PORTS:
 * isolated HTTP unit tests): every open fails closed with 50301 (conversion paused) — no cache,
 * no conversion, no link written.
 */
class PausedLinkOpen extends LinkOpenService {
  override open(input: LinkOpenInput): Promise<HandlerResult> {
    return Promise.resolve({
      status: 503,
      envelope: {
        code: 50301,
        msg: '该平台暂时无法购买，请稍后再试',
        trace_id: input.traceId,
      },
    });
  }
}

/** The convert of a process without its ports: 50301 like the open, nothing registered. */
class PausedLinkConvert extends LinkConvertService {
  override convert(input: LinkConvertInput): Promise<HandlerResult> {
    return Promise.resolve({
      status: 503,
      envelope: {
        code: 50301,
        msg: '该平台暂时无法购买，请稍后再试',
        trace_id: input.traceId,
      },
    });
  }
}

/** The share of a process without its ports: 50301 like the convert, nothing registered. */
class PausedShares extends SharesService {
  override create(input: CreateShareInput): Promise<HandlerResult> {
    return Promise.resolve({
      status: 503,
      envelope: {
        code: 50301,
        msg: '该平台维护中，请稍后再试',
        trace_id: input.traceId,
      },
    });
  }
}

/** The per-request dependencies the open and the convert are both composed from. */
interface LinkOpenParts {
  readonly db: Kysely<Database>;
  readonly idempotency: Idempotency;
  readonly ports: LinkOpenPorts;
  readonly process: LinkOpenProcess;
  readonly appConfig: AppConfig;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly callerContext: CallerContext;
  readonly attrCodes: AttrCodeReader;
  readonly config: LinkingConfigReader;
  readonly pids: PidReader;
  readonly sourceLinks: SourceLinkReader;
  readonly authApps: UnionAuthApps | undefined;
}

/** The open's options (B1-06w / B1-06f), shared by the convert (B1-06i). */
function openOptions(parts: LinkOpenParts): TaobaoLinkOpenOptions {
  const { db, idempotency, ports, process, appConfig, clock, logger } = parts;
  const { callerContext, attrCodes, config, pids, sourceLinks, authApps } = parts;
  // The card's viewer is the opener; inside the open the registrar only reserves the
  // renewed snapshot with the opened link's identity (openRegistrationScope).
  const viewerContext: ViewerContext = {
    current: async () => {
      const caller = await callerContext.current();
      return { appId: caller.appId, userId: caller.userId, deviceId: caller.deviceId };
    },
  };
  const registrar = createLinkRegistration({
    db,
    clock,
    callerContext,
    attrCodes,
    config,
    pids,
    context: { scene: 'search' },
    logger,
  });
  return {
    db,
    clock,
    callerContext,
    attrCodes,
    config,
    pids,
    catalog: createCatalogCardEntry({
      clock,
      viewerContext,
      quoter: ports.quoter,
      registrar,
      sourceLinks,
      itemRefs: ports.itemRefs,
      logger,
    }),
    prices: createLinkOpenPrices({ clock, union: ports.union }),
    cache: process.cache,
    idempotency,
    flights: process.flights,
    registry: { get: (platform) => ports.union.adapter(platform) },
    logger,
    quoteReads: ports.quoteReads,
    environment: {
      appEnv: appConfig.appEnv,
      apps: ports.apps,
      verifiedPaths: ports.verifiedPaths,
    },
    appEnv: appConfig.appEnv,
    authApps: authApps ?? createDemoUnionAuthApps(),
  };
}

/** The open's injection list, in the order openParts reads it. */
const OPEN_INJECT = [
  { token: DB, optional: true },
  { token: IDEMPOTENCY, optional: true },
  { token: LINK_OPEN_PORTS, optional: true },
  LINK_OPEN_PROCESS,
  APP_CONFIG,
  CLOCK,
  ROOT_LOGGER,
  CallerContext,
  AttrCodeReader,
  LinkingConfigReader,
  LINKING_PIDS,
  SourceLinkReader,
  { token: LINKING_AUTH_APPS, optional: true },
];

type OpenFactoryArgs = [
  Kysely<Database> | undefined,
  Idempotency | undefined,
  LinkOpenPorts | undefined,
  LinkOpenProcess,
  AppConfig,
  Clock,
  RootLogger,
  CallerContext,
  AttrCodeReader,
  LinkingConfigReader,
  PidReader,
  SourceLinkReader,
  UnionAuthApps | undefined,
];

/** null when a database, idempotency or LINK_OPEN_PORTS handle is missing. */
function openParts(...args: OpenFactoryArgs): LinkOpenParts | null {
  const [db, idempotency, ports, process, appConfig, clock, logger, ...rest] = args;
  const [callerContext, attrCodes, config, pids, sourceLinks, authApps] = rest;
  if (db === undefined || idempotency === undefined || ports === undefined) return null;
  return {
    db,
    idempotency,
    ports,
    process,
    appConfig,
    clock,
    logger,
    callerContext,
    attrCodes,
    config,
    pids,
    sourceLinks,
    authApps,
  };
}

/**
 * Linking (规划/02 §4.1), B1-06c: card-time link registration (catalog's LinkRegistrar) and the
 * read-only entry_source of a link (catalog's SourceLinkReader). Ports:
 * - CallerContext: by default a guest of the request's app (X-App-Id) and of the device its
 *   signature verified (none when unsigned); the `api` entry passes identity's (B1-02m);
 * - AttrCodeReader: by default unavailable; the `api` entry passes identity's (B1-02m); never a
 *   user_id fallback;
 * - LinkingConfigReader: built once per process by the factory app.module.ts passes (content).
 * B1-06w: POST /v1/links/{link_id}/open is served by the wired open (link-open-wiring.ts), built
 * per request from LINK_OPEN_PORTS (app.module.ts: governed union, quoter, item_ref issuer,
 * apps.json, verified jump paths), the process's Redis jump cache and single-flight windows.
 * B1-06j: GET /v1/links/{link_id} (link landing card) reads only: no registration, no link_log,
 * no conversion.
 * B1-15u: GET /v1/share-pages/{link_id} and POST /v1/share-pages/{link_id}/tpwd (share page
 * outside the app), over the same read ports plus the SharePageMaterials port and Redis tickets.
 * B1-15w: POST /v1/shares registers and converts the sharer's share link and writes its
 * share_materials row, which the share page's material provider reads.
 */
@Module({})
export class LinkingModule {
  static forRoot(configReader: LinkingConfigReaderFactory, ports?: LinkingPorts): DynamicModule {
    const callerContext: FactoryProvider<CallerContext> =
      ports?.callerContext === undefined
        ? GUEST_CALLER
        : { ...ports.callerContext, provide: CallerContext };
    const attrCodeReader: FactoryProvider<AttrCodeReader> =
      ports?.attrCodeReader === undefined
        ? UNAVAILABLE_ATTR_CODES
        : { ...ports.attrCodeReader, provide: AttrCodeReader };
    return {
      module: LinkingModule,
      controllers: [
        LinkOpenController,
        LinkConvertController,
        SharesController,
        LinkLandingController,
        SharePageController,
        UnionAuthUrlController,
        UnionBindingsController,
      ],
      providers: [
        {
          provide: LINK_OPEN_PROCESS,
          inject: [CLOCK, ROOT_LOGGER, { token: REDIS, optional: true }],
          useFactory: (clock: Clock, logger: RootLogger, redis?: RedisHandle): LinkOpenProcess => ({
            flights: createLinkOpenFlights(),
            cache:
              redis === undefined
                ? NO_JUMP_CACHE
                : createRedisJumpCache(redis.namespace(LINK_JUMP_REDIS_NAMESPACE), clock, logger),
          }),
        },
        {
          // Per request, like its CallerContext; the flights and the cache are the process's.
          provide: LinkOpenService,
          scope: Scope.REQUEST,
          inject: OPEN_INJECT,
          useFactory: (...args: OpenFactoryArgs): LinkOpenService => {
            const parts = openParts(...args);
            if (parts === null) return new PausedLinkOpen();
            // B1-06f: the wired open (createWiredLinkOpen) with the Taobao conversion port.
            return createTaobaoLinkOpen(openOptions(parts));
          },
        },
        {
          // B1-06i: POST /v1/links/convert, per request like the open, over the same parts and the
          // convert ports of LINK_OPEN_PORTS (catalog, item_ref verifier, parsing's by-URL port).
          provide: LinkConvertService,
          scope: Scope.REQUEST,
          inject: OPEN_INJECT,
          useFactory: (...args: OpenFactoryArgs): LinkConvertService => {
            const parts = openParts(...args);
            const convert = parts?.ports.convert;
            if (parts === null || convert === undefined) return new PausedLinkConvert();
            return createLinkConvert({
              ...openOptions(parts),
              products: convert.products,
              itemRefs: convert.itemRefs,
              quoter: parts.ports.quoter,
              urlParser: convert.urlParser,
            });
          },
        },
        {
          // B1-15w: POST /v1/shares, per request like the convert, over the same parts, the convert
          // ports (catalog, item_ref verifier), the process quoter, the auth-url service of the
          // request (30101 / 30111 states) and the share ports (verified birth date).
          provide: SharesService,
          scope: Scope.REQUEST,
          inject: OPEN_INJECT,
          useFactory: (...args: OpenFactoryArgs): SharesService => {
            const parts = openParts(...args);
            const convert = parts?.ports.convert;
            const shares = parts?.ports.shares;
            if (parts === null || convert === undefined || shares === undefined) {
              return new PausedShares();
            }
            const { db, clock, logger, appConfig, callerContext, config, pids, ports } = parts;
            const appEnv = appConfig.appEnv;
            return createShares({
              db,
              clock,
              appEnv,
              logger,
              callerContext,
              attrCodes: parts.attrCodes,
              config,
              pids,
              registry: { get: (platform) => ports.union.adapter(platform) },
              idempotency: parts.idempotency,
              products: convert.products,
              itemRefs: convert.itemRefs,
              quoter: ports.quoter,
              authUrl: createUnionAuthUrl({
                db,
                clock,
                callerContext,
                config,
                appEnv,
                authApps: parts.authApps ?? createDemoUnionAuthApps(),
                pids,
                jumpEnvironment: { appEnv, apps: ports.apps, verifiedPaths: ports.verifiedPaths },
                logger,
                registry: { get: (platform) => ports.union.adapter(platform) },
                attrCodes: parts.attrCodes,
              }),
              verifiedBirthDate: (appId, userId) => shares.verifiedBirthDate(appId, userId),
            });
          },
        },
        {
          // B1-06j: the landing card, per request like its CallerContext. Read-only: the links
          // row in the caller's app scope and a card priced from its quote snapshot (item_ref
          // issuer of LINK_OPEN_PORTS; product fields from catalog's read-only product port of
          // LINK_LANDING_PORTS; no conversion, no registration, no link_log).
          provide: LinkLandingService,
          scope: Scope.REQUEST,
          inject: [
            { token: DB, optional: true },
            { token: LINK_OPEN_PORTS, optional: true },
            { token: LINK_LANDING_PORTS, optional: true },
            CLOCK,
            CallerContext,
          ],
          useFactory: (
            db: Kysely<Database> | undefined,
            ports: LinkOpenPorts | undefined,
            landingPorts: LinkLandingPorts | undefined,
            clock: Clock,
            callerContext: CallerContext,
          ): LinkLandingService =>
            createLinkLanding({
              callerContext,
              links: db === undefined ? { find: unavailable } : createLandingLinks(db),
              cards:
                ports === undefined
                  ? { read: unavailable }
                  : createSnapshotCardReader({
                      clock,
                      itemRefs: ports.itemRefs,
                      products: landingPorts?.products ?? NO_PRODUCTS,
                    }),
            }),
        },
        // B1-15u / B1-15w: the share material of a share link — its app.share_materials row by
        // (app_id, link_id), else the D10-424 fallback (a Taobao link's promo_url, no token);
        // without a database handle the fallback alone. Replaceable by a provider of the same token.
        {
          provide: SharePageMaterials,
          inject: [{ token: DB, optional: true }],
          useFactory: (db: Kysely<Database> | undefined): SharePageMaterials =>
            db === undefined ? new SharePageMaterials() : new StoredSharePageMaterials(db),
        },
        {
          // B1-15u: GET /v1/share-pages/{link_id} and POST …/tpwd, one per process (no caller:
          // anonymous, the app is the request's X-App-Id). Read-only on the database: the links
          // row, the sharer's binding and the landing card port (no conversion, no registration,
          // no link_log); tickets and rate-limit buckets live in Redis. Without a database handle
          // every call fails at call time; without Redis no ticket is issued and every exchange
          // is refused (42901).
          provide: SharePageService,
          inject: [
            { token: DB, optional: true },
            { token: LINK_OPEN_PORTS, optional: true },
            { token: LINK_LANDING_PORTS, optional: true },
            { token: REDIS, optional: true },
            APP_CONFIG,
            CLOCK,
            ROOT_LOGGER,
            LinkingConfigReader,
            SharePageMaterials,
          ],
          useFactory: (
            db: Kysely<Database> | undefined,
            ports: LinkOpenPorts | undefined,
            landingPorts: LinkLandingPorts | undefined,
            redis: RedisHandle | undefined,
            appConfig: AppConfig,
            clock: Clock,
            logger: RootLogger,
            config: LinkingConfigReader,
            materials: SharePageMaterials,
          ): SharePageService =>
            createSharePage({
              clock,
              appEnv: appConfig.appEnv,
              logger,
              links: db === undefined ? { find: unavailable } : createLandingLinks(db),
              cards:
                ports === undefined
                  ? { read: unavailable }
                  : createSnapshotCardReader({
                      clock,
                      itemRefs: ports.itemRefs,
                      products: landingPorts?.products ?? NO_PRODUCTS,
                    }),
              bindings: db === undefined ? { active: unavailable } : createShareSharerBindings(db),
              materials,
              config,
              tickets:
                redis === undefined
                  ? NO_SHARE_TICKET_STORE
                  : createRedisShareTicketStore(redis.namespace(SHARE_PAGE_REDIS_NAMESPACE)),
            }),
        },
        {
          // B1-06g: GET /v1/unions/{platform}/auth-url, per request like its CallerContext.
          // Without a database handle (isolated HTTP unit tests) every call fails closed.
          provide: UNION_AUTH_URL,
          scope: Scope.REQUEST,
          inject: [
            { token: DB, optional: true },
            { token: LINKING_AUTH_APPS, optional: true },
            { token: LINK_OPEN_PORTS, optional: true },
            APP_CONFIG,
            CLOCK,
            ROOT_LOGGER,
            CallerContext,
            LinkingConfigReader,
            LINKING_PIDS,
            AttrCodeReader,
          ],
          useFactory: (
            db: Kysely<Database> | undefined,
            authApps: UnionAuthApps | undefined,
            ports: LinkOpenPorts | undefined,
            appConfig: AppConfig,
            clock: Clock,
            logger: RootLogger,
            callerContext: CallerContext,
            config: LinkingConfigReader,
            pids: PidReader,
            attrCodes: AttrCodeReader,
          ): UnionAuthUrlService =>
            db === undefined
              ? { get: unavailable }
              : createUnionAuthUrl({
                  db,
                  clock,
                  callerContext,
                  config,
                  appEnv: appConfig.appEnv,
                  authApps: authApps ?? createDemoUnionAuthApps(),
                  pids,
                  attrCodes,
                  // The pdd auth_jump uses the open's jump environment (apps.json, verified paths);
                  // B1-06zf: its filing link comes from the governed union adapters (none → 50303).
                  ...(ports === undefined
                    ? {}
                    : {
                        jumpEnvironment: {
                          appEnv: appConfig.appEnv,
                          apps: ports.apps,
                          verifiedPaths: ports.verifiedPaths,
                        },
                        registry: { get: (platform) => ports.union.adapter(platform) },
                      }),
                  logger,
                }),
        },
        {
          // B1-06h: the credential exchange, by default the governed Taobao adapter's channel
          // filing (the demo adapter outside prod); without LINK_OPEN_PORTS every exchange
          // rejects (50001). Replaceable by a later provider of the same class token.
          provide: UnionBindingExchanger,
          inject: [{ token: LINK_OPEN_PORTS, optional: true }],
          useFactory: (ports: LinkOpenPorts | undefined): UnionBindingExchanger =>
            new UnionBindingExchanger(() => {
              if (ports === undefined) return null;
              const adapter = ports.union.adapter('taobao');
              const bind = adapter.bindPublisher;
              return bind === undefined ? null : (req, ctx) => bind.call(adapter, req, ctx);
            }),
        },
        {
          // B1-06h: POST /v1/unions/{platform}/bindings and GET /v1/unions/bindings, per request
          // like its CallerContext. Without a database or idempotency handle every call fails
          // closed.
          provide: UNION_BINDINGS,
          scope: Scope.REQUEST,
          inject: [
            { token: DB, optional: true },
            { token: IDEMPOTENCY, optional: true },
            APP_CONFIG,
            CLOCK,
            ROOT_LOGGER,
            CallerContext,
            LinkingConfigReader,
            LINKING_PIDS,
            UnionBindingExchanger,
            AttrCodeReader,
            { token: LINK_OPEN_PORTS, optional: true },
          ],
          useFactory: (
            db: Kysely<Database> | undefined,
            idempotency: Idempotency | undefined,
            appConfig: AppConfig,
            clock: Clock,
            logger: RootLogger,
            callerContext: CallerContext,
            config: LinkingConfigReader,
            pids: PidReader,
            exchanger: UnionBindingExchanger,
            attrCodes: AttrCodeReader,
            ports: LinkOpenPorts | undefined,
          ): UnionBindingsService => {
            if (db === undefined || idempotency === undefined) {
              return { bind: unavailable, list: unavailable };
            }
            const options = {
              db,
              clock,
              callerContext,
              reads: createUnionAuthReads({ db, config, appEnv: appConfig.appEnv, pids, clock }),
              idempotency,
              exchanger,
              logger,
            };
            // B1-06x: the page refreshes the pdd filing through the same union registry, pid
            // reader and attr_codes the open uses; without LINK_OPEN_PORTS it only reads.
            return ports === undefined
              ? createUnionBindings(options)
              : createUnionBindingsWithPddQuery({
                  ...options,
                  registry: { get: (platform) => ports.union.adapter(platform) },
                  pids,
                  attrCodes,
                  config,
                  appEnv: appConfig.appEnv,
                });
          },
        },
        {
          provide: LinkingConfigReader,
          inject: [{ token: DB, optional: true }, CLOCK],
          useFactory: (db: Kysely<Database> | undefined, clock: Clock): LinkingConfigReader =>
            db === undefined ? UNAVAILABLE_CONFIG : configReader(db, clock),
        },
        attrCodeReader,
        {
          provide: LINKING_PIDS,
          inject: [{ token: DB, optional: true }, CLOCK],
          useFactory: (db: Kysely<Database> | undefined, clock: Clock): PidReader =>
            db === undefined ? UNAVAILABLE_PIDS : createLinkingPidReader(db, clock),
        },
        {
          provide: SourceLinkReader,
          inject: [{ token: DB, optional: true }],
          useFactory: (db: Kysely<Database> | undefined): SourceLinkReader =>
            db === undefined ? UNAVAILABLE_SOURCES : createSourceLinkReader(db),
        },
        callerContext,
        {
          provide: LINK_REGISTRATIONS,
          scope: Scope.REQUEST,
          inject: [
            { token: DB, optional: true },
            CLOCK,
            CallerContext,
            AttrCodeReader,
            LinkingConfigReader,
            LINKING_PIDS,
            ROOT_LOGGER,
            REQUEST,
            { token: JOB_QUEUE, optional: true },
            { token: REDIS, optional: true },
          ],
          useFactory: (
            db: Kysely<Database> | undefined,
            clock: Clock,
            callerContext: CallerContext,
            attrCodes: AttrCodeReader,
            config: LinkingConfigReader,
            pids: PidReader,
            logger: RootLogger,
            request: unknown,
            queue?: JobQueue,
            redis?: RedisHandle,
          ): LinkRegistrations => ({
            forContext(context: RegistrationContext): LinkRegistration {
              if (db === undefined) return { register: unavailable, entrySource: unavailable };
              // B1-06zd: only the detail route offers its link; favorites share its code path.
              const prefetch =
                queue !== undefined && isProductDetailRoute(request)
                  ? createPromoPrefetch({
                      db,
                      clock,
                      config,
                      pids,
                      queue,
                      limiter: createPromoPrefetchLimiter(redis),
                      logger,
                    })
                  : undefined;
              return createLinkRegistration({
                db,
                clock,
                callerContext,
                attrCodes,
                config,
                pids,
                context,
                // B1-08s: an exhausted lk issuance is alerted here (linking.link_code.exhausted).
                logger,
                ...(prefetch === undefined ? {} : { promoPrefetch: prefetch }),
              });
            },
          }),
        },
      ],
      exports: [LINK_REGISTRATIONS, SourceLinkReader, CallerContext, LinkingConfigReader],
    };
  }
}
