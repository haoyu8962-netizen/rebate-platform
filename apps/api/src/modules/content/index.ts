// Public surface of the content module; other modules import only from this file.
// Task F1-02b: read-only entry for the minimum supported version (app_versions, by platform and
// channel) and for business configuration (config_items, cached, with its version).
// F1-02e adds whole version rows using the same cache as the minimum-version reads.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../platform/index.ts';
import { CachedContentReader, type ContentReader } from './application/content-reader.ts';
import { createKyselyContentStore } from './infra/kysely-content-store.ts';

export type { ConfigValue, ContentConfig, ContentReader } from './application/content-reader.ts';
// F1-10b: emergency switch registry (规划/04 §10.2) and the switch read cache lifetime.
export { switchRegistry, switchSpecOf } from './domain/switch-registry.ts';
export type {
  SwitchDefault,
  SwitchPermission,
  SwitchSpec,
  SwitchValueType,
} from './domain/switch-registry.ts';
export { SWITCH_CACHE_TTL_MS, switchCacheTtlMs } from './domain/cache-policy.ts';
// B1-12z: the BR-TEXT-13 forbidden-word check and the BR-TEXT-12 fund term classification of
// template codes, for notification's console SMS registration (its save checks and its
// content.fund_terms gate read the same lists as the dictionary saves).
export { classifyTemplate, findBannedWords } from './domain/text-guard/index.ts';
export type { BannedWord, FundTermKeys, TextScope } from './domain/text-guard/index.ts';
export { getBannedWords, getFundTermKeys } from './specs/text-specs.ts';
export type { AppVersionRow } from './domain/app-version.ts';
// F1-06w: the admin console's platform mark reads, loaded by app.module on the admin entry only.
export { ContentAdminModule } from './content-admin.module.ts';
// B2-11e: forAdmin's options (the checks app.module injects into the console's config item and
// switch use cases), those use cases, and the configuration registry (pure data).
export type {
  ContentAdminOptions,
  ContentAuditWriterFactory,
  ContentKillSwitchChecksFactory,
} from './content-admin.module.ts';
export { ConfigItemAdmin, combineConfigItemSaveChecks } from './application/config-item-admin.ts';
export type {
  ConfigItemAdminChecks,
  ConfigItemSaveCheck,
} from './application/config-item-admin.ts';
// B1-05m: the ExternalPage url host checks (BR-ATTR-29 ①), for catalog's keyword shortcut saves.
export { isUnionHost, normalisedHttpsHost } from './domain/pages/validate/external-url.ts';
export { KillSwitchAdmin } from './application/kill-switch-admin.ts';
export type { KillSwitchAdminChecks } from './application/kill-switch-admin.ts';
export { configRegistry } from './domain/config-registry.ts';
export type { ConfigItemSpec, ConfigPermission } from './domain/config-registry.ts';
// F1-09p: scheduled page publish due jobs, loaded by app.module on the worker entry only.
export { ContentWorkerModule } from './content-worker.module.ts';
export { publishedPlatformIcons } from './application/published-platform-icons.ts';
export type {
  PublishedPlatformIconOptions,
  PublishedPlatformIcons,
} from './application/published-platform-icons.ts';
// B3-08i: the published help / rule articles reader app.module builds for the agent's rule chunk
// sync (read-only; D10-386).
// B3-08l: the apps that have such articles, the list the worker's rule sync visits (read-only).
export {
  createPublishedArticleAppsReader,
  createPublishedArticlesReader,
} from './application/published-articles.ts';
export type {
  PublishedArticle,
  PublishedArticleApps,
  PublishedArticlesReader,
  PublishedArticlesReaderOptions,
} from './application/published-articles.ts';
// F1-02c: GET /v1/config, loaded by app.module on the api entry only with identity's viewer.
export { ContentPublicModule } from './content-public.module.ts';
export type { ContentPublicPorts } from './content-public.module.ts';
// B1-05o: the published section read behind catalog's section items, assembled by app.module.
export { PageReader } from './application/page-reader.ts';
export { InviteRewardBudgetReader } from './application/invite-reward-budget-reader.ts';
export { createAgreementReader } from './application/agreement-reader.ts';
export type {
  AgreementReader,
  AgreementReaderOptions,
  CurrentAgreement,
} from './application/agreement-reader.ts';
export { agreementTextUrl } from './domain/agreements/text-url.ts';
export type { AgreementType } from './domain/agreements/index.ts';
// F1-09g: the cross-module reads app.module assembles for the page audience facts.
export type { AudienceUnionPlatform, PageAudienceReads } from './application/page-audience.ts';
export { createSystemSwitchWriter } from './application/system-switch-writer.ts';
export type {
  SystemSwitchInput,
  SystemSwitchResult,
  SystemSwitchWriter,
  SystemSwitchWriterOptions,
} from './application/system-switch-writer.ts';
// F1-02zzj (D10-281): union's dedicated write port for union.auth_alert_phones.
export {
  createUnionAlertPhonesWriter,
  UnionAlertPhonesConflictError,
  UnionAlertPhonesInputError,
} from './application/union-alert-phones-writer.ts';
export type {
  UnionAlertPhonesInput,
  UnionAlertPhonesKey,
  UnionAlertPhonesResult,
  UnionAlertPhonesValue,
  UnionAlertPhonesWriter,
  UnionAlertPhonesWriterOptions,
} from './application/union-alert-phones-writer.ts';

export interface ContentReaderOptions {
  /** Primary handle (ADR-0001 §4.2 #11); the reader only reads. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}

/**
 * A reader with its own cache. Its answers may be up to one cache lifetime old, so it is for
 * read paths only and never for validating a write (an admin save, for example, checks inside its
 * transaction by reading the table directly). Wire it as a singleton: one reader per process,
 * shared by every caller.
 */
export function createContentReader(options: ContentReaderOptions): ContentReader {
  const store = createKyselyContentStore(options.db);
  return new CachedContentReader(store, options.clock, store);
}
