// content's admin console routes: GET /admin/v1/platform-icons and its version history (F1-06w);
// registration, publish / rollback and restore-builtin (F1-06y); upload and save as version
// (F1-06x), whose cleaned files go to platform's MEDIA_STORE (provided globally by PlatformModule).
// F1-09e adds POST /admin/v1/pages/{page_key}/preview-tokens (content.page, audited).
// Page configuration /admin/v1/pages* (F1-09f): drafts, publish, gray, rollback and their reads.
// Popup asset upload POST /admin/v1/pages/popup-assets (F1-09r): checked Lottie JSON or picture to
// MEDIA_STORE under its digest, one audit row on the primary handle; no page is touched.
// Agreement versions /admin/v1/agreements* (F1-02p): list, one version, publish (totp step-up).
// Dictionary editing /admin/v1/dict-items* (F1-02t): list, save-and-publish, history, rollback;
// its keys are the union of contracts/texts.default.json and texts.admin.default.json (F1-02zd).
// Console dictionary GET /admin/v1/dict (F1-02zd): any permission point, uncached, primary handle.
// Article CMS /admin/v1/articles* (F1-02w): list, detail, create, save draft, publish, offline.
// Version settings /admin/v1/app-versions* (F1-02zc): list, one platform and channel, save (the
// totp tier only when the save raises min_supported_version). Saves take effect in the api
// entry's version gate and /v1/app-versions/check as its cache refreshes (≤ CONTENT_CACHE_TTL_MS).
// app.module imports this module on the admin entry only; the api and stream entries do not
// serve /admin/v1. Permission checks go through platform's AdminOperationGuard, which the admin
// module provides globally on the admin entry (content never imports admin).
// Reads use the primary handle DB (couli_app); DB_READ is deliberately not used. Without a
// database handle (isolated HTTP unit tests) the routes still register and every read fails
// closed (50001). Version urls use MEDIA_PUBLIC_BASE_URL as configured (no local default here),
// so staging / prod without it answer 50001 per request that carries a version.
// Writes append their audit row on their own transaction: app.module passes `auditWriter`, which
// binds admin's audit writer (the single writer of audit_logs) to a transaction handle; content
// never imports admin.
//
// Also compiled by the `test` project: a class decorator only (no parameter decorators or
// parameter properties; dependencies are injected through factories).
import { type DynamicModule, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  JOB_QUEUE,
  MEDIA_STORE,
  ROOT_LOGGER,
  type AppConfig,
  type JobQueue,
  getLinkPatterns,
  newUuidV7,
  type AuditPort,
  type Clock,
  type MediaStore,
} from '../platform/index.ts';
import { AgreementAdmin, type AgreementStore } from './application/agreement-admin.ts';
import { AdminAgreementsController } from './http/admin/agreements.controller.ts';
import {
  createKyselyAgreementAdminStore,
  isAgreementVersionTaken,
} from './infra/kysely-agreement-admin-store.ts';
import {
  PlatformIconUploader,
  type PlatformIconUploadStore,
} from './application/platform-icon-uploader.ts';
import { PlatformIconReader, type PlatformIconStore } from './application/platform-icon-reader.ts';
import {
  PlatformIconWriter,
  type PlatformIconWriteStore,
} from './application/platform-icon-writer.ts';
import { AdminPlatformIconsController } from './http/admin/platform-icons.controller.ts';
import {
  createKyselyPlatformIconStore,
  createKyselyPlatformIconUploadStore,
  createKyselyPlatformIconWriteStore,
} from './infra/kysely-platform-icon-store.ts';
import {
  KillSwitchAdmin,
  type KillSwitchAdminChecks,
  type KillSwitchStore,
} from './application/kill-switch-admin.ts';
import { AdminKillSwitchesController } from './http/admin/kill-switches.controller.ts';
import { createKyselyKillSwitchStore } from './infra/kysely-kill-switch-store.ts';
import {
  ConfigItemAdmin,
  combineConfigItemSaveChecks,
  type ConfigItemAdminChecks,
  type ConfigItemStore,
} from './application/config-item-admin.ts';
import { bridgeOriginsSaveCheck } from './application/bridge-origins-save-check.ts';
import { defaultAvatarSaveCheck } from './application/default-avatar-save-check.ts';
import { AdminConfigItemsController } from './http/admin/config-items.controller.ts';
import { createKyselyConfigItemStore } from './infra/kysely-config-item-store.ts';
import { PagePreviewService, type PagePreviewStore } from './application/page-preview.ts';
import { AdminPagePreviewTokensController } from './http/admin/page-preview-tokens.controller.ts';
import { createKyselyPagePreviewStore } from './infra/kysely-page-preview-store.ts';
import {
  PageConfigAdmin,
  type PageConfigStore,
  type PageSectionsCheck,
} from './application/page-config-admin.ts';
import { createPageSectionsCheck } from './application/page-sections-check.ts';
import { AdminPagesController } from './http/admin/pages.controller.ts';
import { PopupAssetUploader } from './application/popup-asset-uploader.ts';
import { AdminPopupAssetsController } from './http/admin/popup-assets.controller.ts';
import { homeSectionsSchema } from './infra/home-schema.ts';
import { createKyselyPageConfigStore } from './infra/kysely-page-config-store.ts';
import { DictItemAdmin, type DictItemStore } from './application/dict-item-admin.ts';
import { AdminDictItemsController } from './http/admin/dict-items.controller.ts';
import { createKyselyDictItemStore } from './infra/kysely-dict-item-store.ts';
import { defaultTexts } from './infra/texts-default.ts';
import { adminDefaultTexts, dictDefaultTexts } from './infra/admin-texts-default.ts';
import { AdminDictReader } from './application/admin-dict-reader.ts';
import { AdminDictController } from './http/admin/dict.controller.ts';
import { createKyselyDictStore } from './infra/kysely-dict-store.ts';
import { ADMIN_DICT } from './domain/dict/index.ts';
import { getBannedWords, getFundTermKeys } from './specs/text-specs.ts';
import { ArticleAdmin, type ArticleAdminStore } from './application/article-admin.ts';
import { AdminArticlesController } from './http/admin/articles.controller.ts';
import {
  createKyselyArticleAdminStore,
  isArticleVersionTaken,
} from './infra/kysely-article-admin-store.ts';
import { AppVersionAdmin, type AppVersionAdminStore } from './application/app-version-admin.ts';
import { AdminAppVersionsController } from './http/admin/app-versions.controller.ts';
import { createKyselyAppVersionAdminStore } from './infra/kysely-app-version-admin-store.ts';

/** Binds the audit port to a transaction handle (app.module: admin's createAuditWriter). */
export type ContentAuditWriterFactory = (db: Kysely<Database>, clock: Clock) => AuditPort;

/**
 * B2-11e: builds the switch checks (payout's 开启前置检查, BR-WDR-30) over the entry's database
 * handle; called only when the entry has one (without it, turning the auto payout switch on stays
 * refused).
 */
export type ContentKillSwitchChecksFactory = (
  db: Kysely<Database>,
  clock: Clock,
) => KillSwitchAdminChecks;

export interface ContentAdminOptions {
  readonly auditWriter: ContentAuditWriterFactory;
  /** B2-11e: config item write checks (payout's 保存时校验, BR-WDR-30); absent, none. */
  readonly configItemChecks?: ConfigItemAdminChecks;
  /** B2-11e: switch checks over the entry's database handle; absent, none. */
  readonly killSwitchChecks?: ContentKillSwitchChecksFactory;
}

const refuse = (): Promise<never> =>
  Promise.reject(new Error('content: platform icon reads need the database'));

const NO_DATABASE: PlatformIconStore = {
  icons: refuse,
  latestVersions: refuse,
  versionPage: refuse,
};

const NO_DATABASE_WRITES: PlatformIconWriteStore = {
  transaction: () => Promise.reject(new Error('content: platform icon writes need the database')),
};

const NO_DATABASE_UPLOADS: PlatformIconUploadStore = {
  configValue: () => Promise.reject(new Error('content: platform icon uploads need the database')),
  insertUpload: () => Promise.reject(new Error('content: platform icon uploads need the database')),
};

const NO_DATABASE_SWITCHES: KillSwitchStore = {
  rows: () => Promise.reject(new Error('content: kill switch reads need the database')),
  transaction: () => Promise.reject(new Error('content: kill switch writes need the database')),
};

const NO_DATABASE_CONFIG_ITEMS: ConfigItemStore = {
  rows: () => Promise.reject(new Error('content: config item reads need the database')),
  row: () => Promise.reject(new Error('content: config item reads need the database')),
  versions: () => Promise.reject(new Error('content: config item history needs the database')),
  transaction: () => Promise.reject(new Error('content: config item writes need the database')),
};

const NO_DATABASE_PREVIEWS: PagePreviewStore = {
  transaction: () => Promise.reject(new Error('content: preview tokens need the database')),
  consume: () => Promise.reject(new Error('content: page previews need the database')),
  sections: () => Promise.reject(new Error('content: page previews need the database')),
};

const refusePages = (): Promise<never> =>
  Promise.reject(new Error('content: page configuration needs the database'));

const NO_DATABASE_PAGES: PageConfigStore = {
  pages: refusePages,
  page: refusePages,
  versions: refusePages,
  version: refusePages,
  transaction: refusePages,
};

const refuseAgreements = (): Promise<never> =>
  Promise.reject(new Error('content: agreement versions need the database'));

const NO_DATABASE_AGREEMENTS: AgreementStore = {
  list: refuseAgreements,
  detail: refuseAgreements,
  transaction: refuseAgreements,
};

const refuseDict = (): Promise<never> =>
  Promise.reject(new Error('content: dictionary editing needs the database'));

const NO_DATABASE_DICT: DictItemStore = {
  read: refuseDict,
  history: refuseDict,
  transaction: refuseDict,
  appendAudit: refuseDict,
};

const refuseArticles = (): Promise<never> =>
  Promise.reject(new Error('content: the article CMS needs the database'));

const NO_DATABASE_ARTICLES: ArticleAdminStore = {
  list: refuseArticles,
  rows: refuseArticles,
  transaction: refuseArticles,
};

const refuseAppVersions = (): Promise<never> =>
  Promise.reject(new Error('content: version settings need the database'));

const NO_DATABASE_APP_VERSIONS: AppVersionAdminStore = {
  rows: refuseAppVersions,
  row: refuseAppVersions,
  transaction: refuseAppVersions,
};

const NO_DATABASE_AUDIT: AuditPort = {
  append: () => Promise.reject(new Error('content: popup asset uploads need the database')),
};

/** Monotonic milliseconds for the SVG conversion budget (not business time). */
const monotonicMs = (): number => performance.now();

/**
 * F1-02zzzb: content's own save checks run first (bridge_origins, then B2-03w's
 * me.default_avatar_url), then the assembler's checks.
 */
function withContentSaveChecks(checks: ConfigItemAdminChecks | undefined): ConfigItemAdminChecks {
  const save = checks?.save;
  return {
    ...checks,
    save:
      save === undefined
        ? combineConfigItemSaveChecks(bridgeOriginsSaveCheck(), defaultAvatarSaveCheck())
        : combineConfigItemSaveChecks(bridgeOriginsSaveCheck(), defaultAvatarSaveCheck(), save),
  };
}

@Module({})
export class ContentAdminModule {
  static forAdmin(options: ContentAdminOptions): DynamicModule {
    return {
      module: ContentAdminModule,
      controllers: [
        AdminPlatformIconsController,
        AdminKillSwitchesController,
        AdminConfigItemsController,
        AdminPagePreviewTokensController,
        AdminPagesController,
        AdminPopupAssetsController,
        AdminAgreementsController,
        AdminDictItemsController,
        AdminDictController,
        AdminArticlesController,
        AdminAppVersionsController,
      ],
      providers: [
        {
          // F1-02w /admin/v1/articles*: banned words are F1-02t's generated snapshot (L50), link
          // patterns are read per call, image hosts come from MEDIA_PUBLIC_BASE_URL (L27).
          provide: ArticleAdmin,
          inject: [APP_CONFIG, CLOCK, { token: DB, optional: true }],
          useFactory: (config: AppConfig, clock: Clock, db?: Kysely<Database>): ArticleAdmin =>
            new ArticleAdmin({
              store:
                db === undefined
                  ? NO_DATABASE_ARTICLES
                  : createKyselyArticleAdminStore(db, (trx) => options.auditWriter(trx, clock)),
              clock,
              mediaPublicBaseUrl: config.mediaPublicBaseUrl,
              linkPatterns: getLinkPatterns,
              bannedWords: getBannedWords,
              isVersionTaken: isArticleVersionTaken,
            }),
        },
        {
          provide: AgreementAdmin,
          inject: [APP_CONFIG, CLOCK, ROOT_LOGGER, { token: DB, optional: true }],
          useFactory: (
            config: AppConfig,
            clock: Clock,
            logger: Logger,
            db?: Kysely<Database>,
          ): AgreementAdmin =>
            new AgreementAdmin({
              store:
                db === undefined
                  ? NO_DATABASE_AGREEMENTS
                  : createKyselyAgreementAdminStore(db, (trx) => options.auditWriter(trx, clock)),
              clock,
              logger,
              mediaPublicBaseUrl: config.mediaPublicBaseUrl,
              linkPatterns: getLinkPatterns,
              newId: newUuidV7,
              isVersionTaken: isAgreementVersionTaken,
            }),
        },
        {
          provide: PagePreviewService,
          inject: [CLOCK, { token: DB, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<Database>): PagePreviewService =>
            new PagePreviewService({
              store:
                db === undefined
                  ? NO_DATABASE_PREVIEWS
                  : createKyselyPagePreviewStore(db, (trx) => options.auditWriter(trx, clock)),
              clock,
            }),
        },
        {
          // F1-09f /admin/v1/pages*: contracts/home-schema.json is read and compiled on the first
          // save or publish, so a broken contract file answers 50001 rather than stopping the entry.
          // F1-09r: a popup's props.lottie must name the media address of its sha256 (no fetch).
          // F1-09p: a scheduled publish enqueues its due job (queue page-schedule) on JOB_QUEUE in
          // the write transaction; the worker entry's ContentWorkerModule handles it.
          provide: PageConfigAdmin,
          inject: [
            APP_CONFIG,
            CLOCK,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
          ],
          useFactory: (
            config: AppConfig,
            clock: Clock,
            db?: Kysely<Database>,
            queue?: JobQueue,
          ): PageConfigAdmin => {
            let check: PageSectionsCheck | undefined;
            return new PageConfigAdmin(
              db === undefined
                ? NO_DATABASE_PAGES
                : createKyselyPageConfigStore(
                    db,
                    (trx) => options.auditWriter(trx, clock),
                    clock,
                    queue,
                  ),
              clock,
              (sections, unionHostBlock) =>
                (check ??= createPageSectionsCheck(
                  homeSectionsSchema(),
                  config.mediaPublicBaseUrl,
                ))(sections, unionHostBlock),
            );
          },
        },
        {
          provide: PopupAssetUploader,
          inject: [APP_CONFIG, CLOCK, MEDIA_STORE, ROOT_LOGGER, { token: DB, optional: true }],
          useFactory: (
            config: AppConfig,
            clock: Clock,
            media: MediaStore,
            logger: Logger,
            db?: Kysely<Database>,
          ): PopupAssetUploader =>
            new PopupAssetUploader({
              media,
              audit: db === undefined ? NO_DATABASE_AUDIT : options.auditWriter(db, clock),
              mediaPublicBaseUrl: config.mediaPublicBaseUrl,
              logger: logger.child({ module: 'content' }),
            }),
        },
        {
          provide: ConfigItemAdmin,
          inject: [CLOCK, ROOT_LOGGER, { token: DB, optional: true }],
          useFactory: (clock: Clock, logger: Logger, db?: Kysely<Database>): ConfigItemAdmin =>
            new ConfigItemAdmin(
              db === undefined
                ? NO_DATABASE_CONFIG_ITEMS
                : createKyselyConfigItemStore(db, (trx) => options.auditWriter(trx, clock)),
              clock,
              logger,
              withContentSaveChecks(options.configItemChecks),
            ),
        },
        {
          // F1-02t /admin/v1/dict-items*: the keys are both default files together (F1-02zd W5),
          // read on first use and re-checked on every call (a broken file answers 50001); the word
          // and fund term lists are generated snapshots (L28 / L50). admin_dict.* keys check the
          // admin_report words (dictTextScope, G5).
          provide: DictItemAdmin,
          inject: [CLOCK, { token: DB, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<Database>): DictItemAdmin => {
            const defaults = (): Readonly<Record<string, string>> =>
              dictDefaultTexts(defaultTexts, adminDefaultTexts);
            return new DictItemAdmin(
              db === undefined
                ? NO_DATABASE_DICT
                : createKyselyDictItemStore(db, (trx) => options.auditWriter(trx, clock)),
              clock,
              {
                defaults,
                fundTermKeys: getFundTermKeys,
                rules: () => ({ defaults: defaults(), words: getBannedWords() }),
              },
            );
          },
        },
        {
          // F1-02zd GET /admin/v1/dict: texts.admin.default.json on first use, no cache (G3);
          // version and admin_dict rows from one snapshot of the primary handle.
          provide: AdminDictReader,
          inject: [ROOT_LOGGER, { token: DB, optional: true }],
          useFactory: (logger: Logger, db?: Kysely<Database>): AdminDictReader =>
            new AdminDictReader(
              db === undefined ? null : createKyselyDictStore(db, { only: ADMIN_DICT }),
              adminDefaultTexts,
              logger.child({ module: 'content' }),
            ),
        },
        {
          provide: KillSwitchAdmin,
          inject: [CLOCK, ROOT_LOGGER, { token: DB, optional: true }],
          useFactory: (clock: Clock, logger: Logger, db?: Kysely<Database>): KillSwitchAdmin =>
            new KillSwitchAdmin(
              db === undefined
                ? NO_DATABASE_SWITCHES
                : createKyselyKillSwitchStore(db, (trx) => options.auditWriter(trx, clock)),
              clock,
              logger,
              // Without a database the checks are not built: turning the auto payout switch on
              // stays refused.
              db === undefined ? undefined : options.killSwitchChecks?.(db, clock),
            ),
        },
        {
          provide: PlatformIconReader,
          inject: [APP_CONFIG, { token: DB, optional: true }],
          useFactory: (config: AppConfig, db?: Kysely<Database>): PlatformIconReader =>
            new PlatformIconReader(
              db === undefined ? NO_DATABASE : createKyselyPlatformIconStore(db),
              config.mediaPublicBaseUrl,
            ),
        },
        {
          provide: PlatformIconWriter,
          inject: [APP_CONFIG, CLOCK, { token: DB, optional: true }],
          useFactory: (
            config: AppConfig,
            clock: Clock,
            db?: Kysely<Database>,
          ): PlatformIconWriter =>
            new PlatformIconWriter(
              db === undefined
                ? NO_DATABASE_WRITES
                : createKyselyPlatformIconWriteStore(db, (trx) => options.auditWriter(trx, clock)),
              clock,
              config.mediaPublicBaseUrl,
            ),
        },
        {
          provide: PlatformIconUploader,
          inject: [APP_CONFIG, CLOCK, MEDIA_STORE, { token: DB, optional: true }],
          useFactory: (
            config: AppConfig,
            clock: Clock,
            media: MediaStore,
            db?: Kysely<Database>,
          ): PlatformIconUploader =>
            new PlatformIconUploader({
              store:
                db === undefined ? NO_DATABASE_UPLOADS : createKyselyPlatformIconUploadStore(db),
              media,
              clock,
              mediaPublicBaseUrl: config.mediaPublicBaseUrl,
              newId: randomUUID,
              monotonicMs,
            }),
        },
        {
          // F1-02zc /admin/v1/app-versions*: store keys come from the generated APP_STORES table.
          provide: AppVersionAdmin,
          inject: [CLOCK, ROOT_LOGGER, { token: DB, optional: true }],
          useFactory: (clock: Clock, logger: Logger, db?: Kysely<Database>): AppVersionAdmin =>
            new AppVersionAdmin({
              store:
                db === undefined
                  ? NO_DATABASE_APP_VERSIONS
                  : createKyselyAppVersionAdminStore(db, (trx) => options.auditWriter(trx, clock)),
              clock,
              logger,
              newId: newUuidV7,
            }),
        },
      ],
    };
  }
}
