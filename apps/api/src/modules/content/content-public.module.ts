// content's /v1 client routes (F1-02c, F1-02e, F1-02f, F1-09d, F1-09e, F1-02n, F1-02s): config,
// app-versions check, articles, pages, agreements, the text dictionary and the draft page preview
// (token only, no viewer context). Agreement and dictionary reads are cached per app_id like
// config reads; one agreement by type and version (F1-02ze) is read afresh on every request.
// app.module imports this module on
// the api entry only and passes identity's request viewer as the ConfigViewerContext provider
// (content never imports identity). Config reads use a process-wide ContentReader; article reads
// always query the primary handle DB afresh; page reads cache the page pointer and version rows
// (F1-09d) and filter per request. app.module may hand in the ContentReader so the version check
// shares one cache with risk's minimum-version gate (F1-02e followup). Without a database handle the routes still
// registers and every request fails closed (50001).
//
// Also compiled by the `test` project: a class decorator only (no parameter decorators or
// parameter properties; dependencies are injected through factories).
import { type DynamicModule, type FactoryProvider, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  getLinkPatterns,
  getMaterialChannels,
  loadConfigSignKey,
  ROOT_LOGGER,
  type AppConfig,
  type Clock,
  type RootLogger,
} from '../platform/index.ts';
import {
  ClientConfigService,
  ConfigViewerContext,
  type BridgeOriginsSource,
} from './application/client-config.ts';
import { BRIDGE_ORIGINS_KEY, BridgeOriginsSigner } from './domain/bridge-origins.ts';
import type { InviteRewardBudgetReader } from './application/invite-reward-budget-reader.ts';
import { ArticleReader } from './application/article-reader.ts';
import {
  PublicAgreementReader,
  kyselyPublicAgreementSource,
} from './application/agreement-reader.ts';
import {
  AgreementVersionReader,
  kyselyAgreementVersionSource,
} from './application/agreement-version-reader.ts';
import { AgreementsController } from './http/public/agreements.controller.ts';
import { DictReader } from './application/dict-reader.ts';
import { DictController } from './http/public/dict.controller.ts';
import { createKyselyDictStore } from './infra/kysely-dict-store.ts';
import { ADMIN_DICT } from './domain/dict/index.ts';
import { AppVersionCheckService } from './application/app-version-check.ts';
import { CachedContentReader, type ContentReader } from './application/content-reader.ts';
import { publishedPlatformIcons } from './application/published-platform-icons.ts';
import type { ClientConfig } from './domain/client-config.ts';
import { ConfigController } from './http/public/config.controller.ts';
import { ArticlesController } from './http/public/articles.controller.ts';
import { createKyselyArticleStore } from './infra/kysely-article-store.ts';
import { AppVersionsController } from './http/public/app-versions.controller.ts';
import { createKyselyContentStore } from './infra/kysely-content-store.ts';
import { PageReader } from './application/page-reader.ts';
import { createPageAudienceFacts, type PageAudienceReads } from './application/page-audience.ts';
import { PagesController } from './http/public/pages.controller.ts';
import { createKyselyPageStore } from './infra/kysely-page-store.ts';
import { PagePreviewService, type PagePreviewStore } from './application/page-preview.ts';
import { PagePreviewController } from './http/public/page-preview.controller.ts';
import { createKyselyPagePreviewStore } from './infra/kysely-page-preview-store.ts';

const UNAVAILABLE_READER: ContentReader = {
  appVersion: () => Promise.reject(new Error('content: version reads need the database')),
  minSupportedVersion: () => Promise.reject(new Error('content: config reads need the database')),
  configValue: () => Promise.reject(new Error('content: config reads need the database')),
};

const UNAVAILABLE_PREVIEWS: PagePreviewStore = {
  transaction: () => Promise.reject(new Error('content: preview tokens are not issued here')),
  consume: () => Promise.reject(new Error('content: page previews need the database')),
  sections: () => Promise.reject(new Error('content: page previews need the database')),
};

const CONTENT_READER = Symbol('CONTENT_READER');
const CONTENT_READER_SOURCE = Symbol('CONTENT_READER_SOURCE');

export interface ContentPublicPorts {
  /** Request-scoped provider of the caller (identity's viewer on the api entry). */
  readonly viewerContext: Omit<FactoryProvider<ConfigViewerContext>, 'provide'>;
  /**
   * The process-wide reader of config_items and app_versions (null: no database handle). When
   * absent the module builds its own over DB.
   */
  readonly contentReader?: Omit<FactoryProvider<ContentReader | null>, 'provide'>;
  /**
   * F1-09g: the cross-module reads behind the page audience facts (null: no database handle).
   * When absent, a logged-in viewer's facts are unknown and only `any` matches them.
   */
  readonly audienceReads?: Omit<FactoryProvider<PageAudienceReads | null>, 'provide'>;
  /**
   * F1-02zp (BR-INV-24): growth's total available invitation reward budget behind
   * /v1/config invite.reward_enabled. When absent (or null), reward_enabled is always false.
   */
  readonly inviteRewardBudget?: Omit<FactoryProvider<InviteRewardBudgetReader | null>, 'provide'>;
}

const AUDIENCE_READS = Symbol('AUDIENCE_READS');
const BRIDGE_ORIGINS_SIGNING = Symbol('BRIDGE_ORIGINS_SIGNING');

/**
 * F1-02zzzb: the bridge_origins signer of this process, built from platform's configuration signing
 * key (read once while the providers are created). A refused key (staging / prod without
 * CONFIG_SIGN_KEY_*, an unreadable or non-P-256 file) fails Nest's init, so the api entry refuses
 * to start before it listens; until then nothing is signed. The error text names the variables
 * only.
 */
interface BridgeOriginsSigning {
  signer(): BridgeOriginsSigner;
  onModuleInit(): void;
}

async function bridgeOriginsSigning(config: AppConfig): Promise<BridgeOriginsSigning> {
  let signer: BridgeOriginsSigner | null = null;
  let refusal: unknown = null;
  try {
    signer = new BridgeOriginsSigner(
      await loadConfigSignKey(config.appEnv, config.configSignKey ?? null),
    );
  } catch (error) {
    refusal = error;
  }
  return {
    signer: () => {
      if (signer === null) throw new Error('content: the configuration signing key is unavailable');
      return signer;
    },
    onModuleInit: () => {
      if (signer === null) throw refusal;
    },
  };
}
const INVITE_REWARD_BUDGET = Symbol('INVITE_REWARD_BUDGET');

/** F1-02zzzb: the row is read afresh from the primary handle on every request (never cached). */
function bridgeOriginsSource(
  db: Kysely<Database> | undefined,
  config: AppConfig,
  signing: BridgeOriginsSigning,
): BridgeOriginsSource {
  const store = db === undefined ? null : createKyselyContentStore(db);
  return {
    env: config.appEnv,
    item: (appId) =>
      store === null
        ? Promise.reject(new Error('content: config reads need the database'))
        : store.configItem(appId, BRIDGE_ORIGINS_KEY),
    signer: () => signing.signer(),
  };
}

function ownContentReader(db: Kysely<Database> | undefined, clock: Clock): ContentReader | null {
  if (db === undefined) return null;
  const store = createKyselyContentStore(db);
  return new CachedContentReader(store, clock, store);
}

@Module({})
export class ContentPublicModule {
  static forApi(ports: ContentPublicPorts): DynamicModule {
    return {
      module: ContentPublicModule,
      // B1-05o: global so that app.module can inject PageReader into catalog's section port.
      global: true,
      controllers: [
        ConfigController,
        ArticlesController,
        AppVersionsController,
        PagesController,
        PagePreviewController,
        AgreementsController,
        DictController,
      ],
      providers: [
        {
          // F1-09e previewPage: always the primary handle, never cached.
          provide: PagePreviewService,
          inject: [{ token: DB, optional: true }, CLOCK],
          useFactory: (db: Kysely<Database> | undefined, clock: Clock): PagePreviewService =>
            new PagePreviewService({
              store:
                db === undefined ? UNAVAILABLE_PREVIEWS : createKyselyPagePreviewStore(db, null),
              clock,
            }),
        },
        {
          provide: ArticleReader,
          inject: [{ token: DB, optional: true }, CLOCK],
          useFactory: (db: Kysely<Database> | undefined, clock: Clock): ArticleReader =>
            new ArticleReader(db === undefined ? null : createKyselyArticleStore(db), clock),
        },
        {
          // F1-02n GET /v1/agreements: cached per app_id for CONTENT_CACHE_TTL_MS (L11).
          provide: PublicAgreementReader,
          inject: [{ token: DB, optional: true }, CLOCK],
          useFactory: (db: Kysely<Database> | undefined, clock: Clock): PublicAgreementReader =>
            new PublicAgreementReader(
              db === undefined ? null : kyselyPublicAgreementSource(db),
              clock,
            ),
        },
        {
          // F1-02ze GET /v1/agreements/{type}: one query per request, never cached.
          provide: AgreementVersionReader,
          inject: [{ token: DB, optional: true }],
          useFactory: (db: Kysely<Database> | undefined): AgreementVersionReader =>
            new AgreementVersionReader(db === undefined ? null : kyselyAgreementVersionSource(db)),
        },
        {
          // F1-02s GET /v1/dict: cached per app_id for CONTENT_CACHE_TTL_MS (L11).
          provide: DictReader,
          inject: [{ token: DB, optional: true }, CLOCK, ROOT_LOGGER],
          useFactory: (
            db: Kysely<Database> | undefined,
            clock: Clock,
            logger: RootLogger,
          ): DictReader =>
            new DictReader(
              db === undefined ? null : createKyselyDictStore(db, { except: ADMIN_DICT }),
              clock,
              logger.child({ module: 'content' }),
            ),
        },
        {
          provide: AUDIENCE_READS,
          ...(ports.audienceReads ?? { useFactory: (): PageAudienceReads | null => null }),
        },
        {
          provide: PageReader,
          inject: [{ token: DB, optional: true }, CLOCK, AUDIENCE_READS, ROOT_LOGGER],
          useFactory: (
            db: Kysely<Database> | undefined,
            clock: Clock,
            reads: PageAudienceReads | null,
            logger: RootLogger,
          ): PageReader =>
            new PageReader(
              db === undefined ? null : createKyselyPageStore(db),
              clock,
              createPageAudienceFacts({ reads, logger: logger.child({ module: 'content' }) }),
            ),
        },
        {
          provide: CONTENT_READER_SOURCE,
          ...(ports.contentReader ?? {
            inject: [{ token: DB, optional: true }, CLOCK],
            useFactory: ownContentReader,
          }),
        },
        {
          provide: CONTENT_READER,
          inject: [CONTENT_READER_SOURCE],
          useFactory: (reader: ContentReader | null): ContentReader => reader ?? UNAVAILABLE_READER,
        },
        {
          provide: INVITE_REWARD_BUDGET,
          ...(ports.inviteRewardBudget ?? {
            useFactory: (): InviteRewardBudgetReader | null => null,
          }),
        },
        {
          provide: BRIDGE_ORIGINS_SIGNING,
          inject: [APP_CONFIG],
          useFactory: bridgeOriginsSigning,
        },
        {
          provide: ClientConfigService,
          inject: [
            CONTENT_READER,
            { token: DB, optional: true },
            ROOT_LOGGER,
            APP_CONFIG,
            INVITE_REWARD_BUDGET,
            BRIDGE_ORIGINS_SIGNING,
          ],
          useFactory: (
            reader: ContentReader,
            db: Kysely<Database> | undefined,
            logger: RootLogger,
            config: AppConfig,
            inviteRewardBudget: InviteRewardBudgetReader | null,
            signing: BridgeOriginsSigning,
          ): ClientConfigService =>
            new ClientConfigService({
              reader,
              inviteRewardBudget,
              bridgeOrigins: bridgeOriginsSource(db, config, signing),
              platformIcons: (appId) => {
                if (db === undefined) {
                  return Promise.reject(
                    new Error('content: platform icon reads need the database'),
                  );
                }
                return publishedPlatformIcons(
                  { db, mediaPublicBaseUrl: config.mediaPublicBaseUrl },
                  appId,
                );
              },
              linkPatterns: () => getLinkPatterns() as NonNullable<ClientConfig['link_patterns']>,
              materialChannels: getMaterialChannels,
              logger: logger.child({ module: 'content' }),
            }),
        },
        {
          provide: AppVersionCheckService,
          inject: [CONTENT_READER, ROOT_LOGGER],
          useFactory: (reader: ContentReader, logger: RootLogger): AppVersionCheckService =>
            new AppVersionCheckService(reader, logger.child({ module: 'content' })),
        },
        { ...ports.viewerContext, provide: ConfigViewerContext },
      ],
      exports: [PageReader],
    };
  }
}
