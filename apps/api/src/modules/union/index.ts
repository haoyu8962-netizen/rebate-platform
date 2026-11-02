// Public surface of the union module (规划/02 §4.1, §6). Other modules import only from this file.
export { createSiteReauth, SiteReauthError } from './auth-expiry/reauth.ts';
export type {
  ReauthMode,
  SiteOAuthProvider,
  SiteReauth,
  SiteReauthErrorCode,
  SiteReauthOptions,
} from './auth-expiry/reauth.ts';
// B1-22b: the site authorization check, its union-auth job chain and the alert phone codec.
export {
  UNION_AUTH_QUEUE,
  createSiteAuthMonitor,
  encodeAlertPhones,
  decodeAlertPhones,
  alertPhoneId,
} from './auth-expiry/service.ts';
export type {
  SiteAuthAccount,
  SiteAuthAlertPlanInput,
  SiteAuthAlerts,
  SiteAuthProbeResult,
  SiteAuthProbe,
  SiteAuthRefresher,
  SiteAuthMonitorOptions,
  SiteAuthMonitor,
  SiteAuthReauthMode,
  UnionAuthQueue,
} from './auth-expiry/service.ts';
export { UnionAuthModule, unionAuthMonitorToken } from './auth-expiry/union-auth.module.ts';
export type { UnionAuthModuleOptions } from './auth-expiry/union-auth.module.ts';
export {
  REGISTERED_PLATFORMS,
  UnionError,
  UnionIdentity,
  isPlatform,
  isRegisteredPlatform,
} from './domain/types.ts';
export type {
  BindReq,
  BindResult,
  CallCtx,
  ChannelCategoriesReq,
  ChannelRankingCategory,
  ChannelRankingEntry,
  ChannelRankingPage,
  ChannelRankingReq,
  ConvertReq,
  ConvertResult,
  IdentityClaims,
  ItemInput,
  ItemRef,
  MaterialReq,
  OrderInput,
  OrderPage,
  OrderQueryOpt,
  Page,
  PddAuthority,
  PddAuthorityUrl,
  PddPromotionUrlExtras,
  PddOrderFields,
  Platform,
  RegisteredPlatform,
  RejectedOrderRow,
  ResolvedLink,
  SearchQuery,
  TaobaoShareCode,
  TimeWindow,
  TljCreateReq,
  TljCreateResult,
  UnionAdapter,
  UnionEndpoint,
  UnionEnvironment,
  UnionErrorCode,
  UnionItem,
  UnionItemDetail,
  UnionMode,
  UnionOrder,
  UnionOrderAttrParams,
  UnionOrderNeutralFields,
  UnionPunish,
  UnionRefund,
} from './domain/types.ts';
export { makeUnionItem, makeUnionOrder } from './domain/dto.ts';
export { quoteN } from './domain/quote-n.ts';
export type { PddQuoteFactors, QuoteNInput } from './domain/quote-n.ts';
export { mapTaobaoPrice, isPriceAnomaly } from './domain/taobao-price.ts';
export type {
  PriceAnomalyReason,
  TaobaoPriceInput,
  TaobaoPriceOptions,
  TaobaoPriceResult,
  TaobaoPriceSettingsReader,
  TaobaoPriceWarning,
  TaobaoPromotion,
} from './domain/taobao-price.ts';
export {
  MAX_ITEM_IMAGES,
  MAX_ITEM_IMAGE_URL_LENGTH,
  normalizeItemImages,
} from './domain/item-images.ts';
export type { ItemImages, RawItemImages } from './domain/item-images.ts';
// B1-22q: price.taobao.* read through a union-defined config port (app.module passes ContentReader).
export { createTaobaoPriceSettings } from './application/taobao-price-settings.ts';
export type {
  TaobaoPriceConfigReader,
  TaobaoPriceSettings,
  TaobaoPriceSettingsOptions,
} from './application/taobao-price-settings.ts';
export { createUnionRegistry } from './infra/registry.ts';
// B1-04zy: the couli_taobao_search_total counter UnionModule provides, read by entry.ts on api.
export { taobaoSearchCounterToken } from './infra/taobao/search-counter.ts';
export type {
  TaobaoSearchCounter,
  TaobaoSearchMetricOutcome,
  TaobaoSearchMetricSource,
  TaobaoSearchSample,
} from './infra/taobao/search-counter.ts';
export { DemoUnionAdapter, DemoUnionError } from './infra/demo/demo-adapter.ts';
export type {
  DemoScenario,
  DemoUnionErrorCode,
  DemoUnionOptions,
  DemoUnionRegistryOptions,
} from './infra/demo/demo-adapter.ts';
export type { UnionRegistration, UnionRegistry } from './infra/registry.ts';
export { loadUnionEndpoints, parseUnionEndpoints } from './infra/endpoints.ts';
export { createGovernedAdapter } from './application/governed-adapter.ts';
// B1-22v: the union quota bucket shared by every process (Redis); without REDIS the entry's one
// platform fallback (D10-460: in-process in local / test, refused in staging / prod).
export { UNION_QUOTA_NAMESPACE, createUnionQuotaSource } from './application/shared-quota.ts';
export type { UnionQuotaDeps, UnionQuotaSource } from './application/shared-quota.ts';
// B1-08n: the order-sync wiring's union side (SyncAccessPort, pipeline readers, worker governance).
export {
  createUnionSyncAccess,
  createUnionOrderReaders,
  createGovernedSyncAdapter,
} from './application/order-sync-ports.ts';
export type {
  UnionOrderReaders,
  UnionSyncAccess,
  UnionSyncAccessOptions,
  UnionSyncAccount,
} from './application/order-sync-ports.ts';
export { UnionPidError, createUnionPidService } from './pids/service.ts';
export type {
  AccountRow as UnionAccountRow,
  ActivePidInput,
  ConfirmHjyInput,
  PidPlatform,
  PidRow as UnionPidRow,
  PidServiceDeps,
  PidStatus,
  PidWarnLogger,
  RegisterAccountInput,
  RegisterPidInput,
  SetPidStatusInput,
  SuperVerification,
  UnionAuditInput,
  UnionAuditWriter,
  UnionPidErrorCode,
  UnionPidService,
  VerifiedSuper,
  WhitelistInput,
  WriteContext as UnionWriteContext,
} from './pids/service.ts';
export type { GovernedAdapterOptions } from './application/governed-adapter.ts';
// B1-22p: material-channel ranking port (BR-TEXT-17 细则「联盟物料频道」), for catalog's hot list.
export { createUnionChannelRanking } from './application/channel-ranking.ts';
export type {
  ChannelRankingCategoriesInput,
  ChannelRankingPageInput,
  UnionChannelRanking,
  UnionChannelRankingOptions,
} from './application/channel-ranking.ts';
export {
  createUnionFileReplay,
  createUnionReplayClient,
  parseUnionRecordingProvenance,
  UnionReplayError,
} from './infra/replay.ts';
export type {
  UnionFileReplay,
  UnionFileReplayOptions,
  UnionLoadedRecording,
  UnionRecordingProvenance,
  UnionReplayClient,
  UnionReplayClientOptions,
  UnionReplayErrorCode,
  UnionReplayReport,
  UnionReplayRequest,
  UnionTransport,
  UnionTransportRequest,
  UnionTransportResponse,
} from './infra/replay.ts';
export {
  UNION_ENDPOINTS,
  UNION_ENDPOINTS_DIR,
  UNION_REGISTRY,
  UnionModule,
} from './union.module.ts';
export type { UnionModuleOptions } from './union.module.ts';
// B1-22h: the /admin/v1/union-pids routes, assembled by app.module on the admin entry only.
export { UnionAdminModule } from './union-admin.module.ts';
export type { UnionAdminOptions, UnionAuditWriterFactory } from './union-admin.module.ts';
