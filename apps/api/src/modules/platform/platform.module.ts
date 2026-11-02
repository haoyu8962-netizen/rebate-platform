import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock } from './clock/index.ts';
import type { AppConfig } from './config/index.ts';
import {
  openPriorIdentityFieldCrypto,
  PRIOR_IDENTITY_FIELD_CRYPTO,
} from './config/keyring-prior-identity.ts';
import { openConfiguredFieldCrypto } from './config/keyring-startup.ts';
import { kmsAccessOf } from './kms/index.ts';
import type { FieldCrypto } from './crypto/index.ts';
import type { ConnectionConfig, DbHandles } from './db/index.ts';
import type { EntryName } from './entries.ts';
import { createEventBus } from './events/index.ts';
import { createExportStore, EXPORT_STORE } from './export-store/index.ts';
import { AbandonController } from './http/public/abandon.controller.ts';
import { createIdempotency } from './idempotency/index.ts';
import { IDEMPOTENCY } from './idempotency/token.ts';
import type { RootLogger } from './logging/index.ts';
import { createMediaStore, MEDIA_STORE } from './media/index.ts';
import { createQueueRuntime, type JobQueue } from './queue/index.ts';
import { createRedisHandle } from './redis/index.ts';

/** Nest injection tokens provided by `PlatformModule`. */
export const APP_CONFIG = Symbol('APP_CONFIG');
export const APP_ENTRY = Symbol('APP_ENTRY');
export const ROOT_LOGGER = Symbol('ROOT_LOGGER');
export const DB = Symbol('DB');
export const DB_READ = Symbol('DB_READ');
export { IDEMPOTENCY };
export const FIELD_CRYPTO = Symbol('FIELD_CRYPTO');
export const JOB_QUEUE = Symbol('JOB_QUEUE');
export const EVENT_BUS = Symbol('EVENT_BUS');
export const REDIS = Symbol('REDIS');
const DB_LIFECYCLE = Symbol('DB_LIFECYCLE');

export interface PlatformOptions {
  readonly entry: EntryName;
  readonly config: AppConfig;
  readonly clock: Clock;
  readonly logger: RootLogger;
  /** Supplied by the process runner; may be omitted by isolated HTTP unit tests. */
  readonly dbHandles?: DbHandles;
  /**
   * REDIS_URL of the entry (`ConnectionConfig.redisUrl`): provides `REDIS`. Null (payout) or
   * omitted (isolated HTTP unit tests): no `REDIS` provider.
   */
  readonly redisUrl?: ConnectionConfig['redisUrl'];
}

/**
 * Cross-cutting infrastructure shared by every module: configuration, clock, logger.
 * The process runner starts the queue after module handlers have registered, before serving traffic.
 */
@Module({})
export class PlatformModule {
  static forRoot(options: PlatformOptions): DynamicModule {
    const handles = options.dbHandles;
    const keyring = options.config.keyring;
    const cryptoProviders =
      keyring === null
        ? []
        : [
            {
              provide: FIELD_CRYPTO,
              useFactory: async () =>
                await openConfiguredFieldCrypto(
                  options.config.appEnv,
                  keyring,
                  kmsAccessOf(options.config),
                ),
            },
          ];
    // The second field keyring (B1-27e, config/keyring-prior-identity.ts §5): provided when it is
    // configured, and in local / test (generated per process). In staging / prod without it (only a
    // hand-built config gets there) the token is absent, so a provider that injects it fails.
    const appEnv = options.config.appEnv;
    const priorIdentityKeyring = options.config.priorIdentityKeyring ?? null;
    const providesPriorIdentity =
      priorIdentityKeyring !== null || appEnv === 'local' || appEnv === 'test';
    const priorIdentityProviders = providesPriorIdentity
      ? [
          {
            provide: PRIOR_IDENTITY_FIELD_CRYPTO,
            // Injecting FIELD_CRYPTO makes the main keyring open (and fail) first.
            inject: keyring === null ? [] : [FIELD_CRYPTO],
            useFactory: async () =>
              await openPriorIdentityFieldCrypto(
                appEnv,
                priorIdentityKeyring,
                keyring,
                kmsAccessOf(options.config),
              ),
          },
        ]
      : [];
    const queue =
      handles === undefined
        ? undefined
        : createQueueRuntime({
            entry: options.entry,
            db: handles.db,
            logger: options.logger,
            // B1-01zzk: QUEUE_CONCURRENCY_<Q> / QUEUE_DB_BUDGET only limit the worker's lanes.
            ...(options.entry === 'worker' && options.config.queueLimits !== undefined
              ? { limits: options.config.queueLimits }
              : {}),
          });
    const databaseProviders =
      handles === undefined
        ? []
        : [
            { provide: DB, useValue: handles.db },
            {
              provide: IDEMPOTENCY,
              // FIELD_CRYPTO (absent without a keyring) serves the keyed request digest of
              // requests with keyedRequestDigest (B1-01zzf); those fail closed without it.
              inject: [{ token: FIELD_CRYPTO, optional: true }],
              useFactory: (fieldCrypto?: FieldCrypto) =>
                createIdempotency({
                  db: handles.db,
                  clock: options.clock,
                  logger: options.logger,
                  fieldCrypto: fieldCrypto ?? null,
                }),
            },
            { provide: JOB_QUEUE, useValue: queue },
            {
              provide: EVENT_BUS,
              inject: [JOB_QUEUE, CLOCK],
              useFactory: (jobQueue: JobQueue, clock: Clock) =>
                createEventBus({ queue: jobQueue, clock }),
            },
            ...(options.entry === 'admin' && handles.dbRead !== null
              ? [{ provide: DB_READ, useValue: handles.dbRead }]
              : []),
            {
              provide: DB_LIFECYCLE,
              // Nest disposes the HTTP server before this hook. Earlier hooks would close the
              // database while HTTP requests were still running.
              useValue: {
                onApplicationShutdown: async () => {
                  await queue?.stop();
                  await handles.close();
                },
              },
            },
          ];
    const redisUrl = options.redisUrl ?? null;
    const redisProviders =
      redisUrl === null
        ? []
        : [
            {
              provide: REDIS,
              // Lazy handle: building it opens no connection, so entries start while Redis is
              // unreachable. Nest calls the handle's own onApplicationShutdown on close (after
              // HTTP entries stopped serving).
              useFactory: async () => {
                const handle = await createRedisHandle(
                  { entry: options.entry, redisUrl },
                  { logger: options.logger },
                );
                if (handle === null) throw new Error('Redis handle missing for a REDIS_URL');
                return handle;
              },
            },
          ];
    return {
      module: PlatformModule,
      global: true,
      // POST /v1/idempotency-keys/abandon (B1-02g) is an api route only. Without a database the
      // route stays registered (contract.test.ts: every implemented operation has exactly one api
      // route) and fails closed with 50001; the other entries never mount it.
      controllers: options.entry === 'api' ? [AbandonController] : [],
      providers: [
        { provide: APP_CONFIG, useValue: options.config },
        { provide: APP_ENTRY, useValue: options.entry },
        { provide: CLOCK, useValue: options.clock },
        { provide: ROOT_LOGGER, useValue: options.logger },
        // Content-addressed media store (F1-06z): memory stand-in in local / test; staging / prod
        // fail every put per request until the OSS adapter lands (never a startup refusal).
        {
          provide: MEDIA_STORE,
          useFactory: () =>
            createMediaStore(
              options.config.appEnv,
              options.config.mediaPublicBaseUrl,
              options.logger,
            ),
        },
        // Private export store (B1-34d): signed-link memory stand-in in local / test; staging / prod
        // fail every put / signedUrl per request until the OSS adapter lands (B1-30).
        {
          provide: EXPORT_STORE,
          inject: [CLOCK],
          useFactory: (clock: Clock) =>
            createExportStore({
              appEnv: options.config.appEnv,
              baseUrl: options.config.exportStoreBaseUrl,
              signingKey: options.config.exportStoreSigningKey,
              clock,
              logger: options.logger,
            }),
        },
        ...databaseProviders,
        ...redisProviders,
        ...cryptoProviders,
        ...priorIdentityProviders,
      ],
      exports: [
        APP_CONFIG,
        APP_ENTRY,
        CLOCK,
        ROOT_LOGGER,
        MEDIA_STORE,
        EXPORT_STORE,
        ...(keyring === null ? [] : [FIELD_CRYPTO]),
        ...(providesPriorIdentity ? [PRIOR_IDENTITY_FIELD_CRYPTO] : []),
        ...(redisUrl === null ? [] : [REDIS]),
        ...(handles === undefined ? [] : [DB, IDEMPOTENCY, JOB_QUEUE, EVENT_BUS]),
        ...(handles !== undefined && options.entry === 'admin' && handles.dbRead !== null
          ? [DB_READ]
          : []),
      ],
    };
  }
}
