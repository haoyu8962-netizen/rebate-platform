import { randomBytes, randomUUID } from 'node:crypto';
import { type DynamicModule, type Provider, HttpException, Module, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { DB as Database } from '@couli/db';
import {
  ProductKeyUnderivable,
  deriveProductKey,
  isAtLeastAge,
  orderKey,
  type UnionProductPayload,
} from '@couli/domain';
import { addFen, parseFen } from '@couli/money';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  ADMIN_ACTIVE_STATUS,
  ADMIN_CHECK,
  AdminAuthModule,
  AdminModule,
  ExportWorkerModule,
  createAdminDisplayNameReader,
  createAdminProfiles,
  createAdminVerifyPhoneReader,
  createAuditWriter,
  createOrderHoldAuditReader,
  createSystemAuditWriter,
} from './modules/admin/index.ts';
import {
  AgentModule,
  agentCallerReaderToken,
  agentConsentReaderToken,
  agentContentReaderToken,
  agentStreamPortsToken,
  agentTraceRetentionDays,
  agentTraceRetentionKey,
  createAgentDataPurge,
  createPersonalDataCopyAgentReader,
  createProductionStreamAssembly,
  type AgentConsentReaderFactory,
  type AgentContentReader,
  type AgentStreamProvidedPorts,
  type StreamReviewOptions,
} from './modules/agent/index.ts';
import {
  CatalogAdminModule,
  CatalogModule,
  CatalogWorkerModule,
  GovernedUnion,
  POOL_EXTRA_JOBS,
  type PoolExtraJobs,
  PRODUCT_CACHE_NAMESPACE,
  LinkRegistrar,
  RebateQuoter,
  ViewerContext,
  createCatalog,
  createCatalogCardEntry,
  createDbCatalogProductReader,
  createUnionDetailUpstream,
  createUnionSearchUpstream,
  createDemoRebateQuoter,
  deleteFavoritesForUser,
  createItemRefService,
  processItemRefCipher,
  searchConfigSaveCheck,
  type Catalog,
  type CatalogCardEntry,
  type PoolLinkParser,
  type CatalogConfigReader,
  type CatalogWarning,
  type ProductCapabilities,
  type ProductRef,
  type RegisterLinkInput,
  type SectionItemsPages,
} from './modules/catalog/index.ts';
import {
  createSelfRebateEstimateReader,
  createBeneficiaryShareReader,
  COMMISSION_QUOTE_CONFIG_KEYS,
  createCommissionEstimates,
  createCommissionRebateQuoter,
  createCommissionSnapshotPort,
  createRuleSetReader,
  createSnapshotBeneficiaryResolver,
  findBannedRunStart,
  listBannedForfeitedShares,
  appendBeneficiaryEvent,
  readCommissionAttribution,
  readCommissionSnapshot,
  readTljDeductFen,
  TljDeductionMissing,
  type CommissionOrderSnapshotPort,
  type RuleSetReader,
} from './modules/commission/index.ts';
import {
  ContentAdminModule,
  ContentPublicModule,
  ContentWorkerModule,
  PageReader,
  combineConfigItemSaveChecks,
  configRegistry,
  createContentReader,
  createSystemSwitchWriter,
  switchSpecOf,
  type ContentAdminOptions,
  type ContentReader,
  type PageAudienceReads,
} from './modules/content/index.ts';
import { HealthModule } from './modules/health/index.ts';
// The token of B1-27e's second keyring (not on the platform barrel): the isolated store of the
// real-name correction (B1-27a) encrypts with it.
import { PRIOR_IDENTITY_FIELD_CRYPTO } from './modules/platform/config/index.ts';
import { SMS_CODE_LIFETIME_SECONDS } from './modules/identity/domain/sms-limits.ts';
import {
  GrowthModule,
  appendLevelChange,
  createFirstAppLoginReview,
  createInviteBinder,
  createInviteRewardBudgetReader,
  createInviteRewardExpiry,
  createInviteRewardPayout,
  createInviteRewardQualifier,
  createInviteRewardScanner,
  inviteRewardScannerToken,
  createLandingInviteBinder,
  createMyInviteReader,
  createParentRelationReader,
  createRegistrationInviteBinding,
  createGrowthHistory,
  detachChildrenOfDeleted,
  readPersonalDataCopyInvite,
  type ParentRelationReader,
  type InviteBinder,
  type InviteBinderDeps,
  type MyInviteReader,
  type InviteRewardQualifier,
  type InviteRewardScanner,
} from './modules/growth/index.ts';
import {
  createPushSessionValidity,
  createPersonalDataCopySources,
  type DataCopyCodeSender,
  type DataCopyInbox,
  type IdentityDataCopyPorts,
  createWithdrawSubjectReader,
  createPayeeBindingHistoryReader,
  laborAgreementSigned,
  IdentityAdminModule,
  IdentityModule,
  createExportUsersReader,
  createRealnameExportBatchReader,
  IdentityWorkerModule,
  IdentityDeletionExpiryModule,
  ME_READ_PORTS,
  createMaskedPhoneReader,
  normalize_phone,
  CONSENT_SIGNATURE_CHECK,
  TOKEN_CHECK,
  STEP_UP_CHECK,
  IDENTITY_LEVEL_CHECKS,
  PRIVACY_CONSENT_CHECKS,
  DELETION_STAGE_CHECKS,
  createRealnameReader,
  createWithdrawPayeeSnapshotReader,
  lockUsersForUpdate,
  withStepUp,
  createRealnameStatusReader,
  createSmsSender,
  createThirdPartyIdentity,
  smsSenderToken,
  createIdentityAttrCodeReader,
  isRecordConsentRoute,
  createIdentityCallerContext,
  createAiConsentReader,
  createAgentCallerReader,
  createIdentityViewerContext,
  createSameDeviceLoginReader,
  createUserLevelReader,
  createInviteBackfillActivityReader,
  createInviteLoginDevicesReader,
  createDeletionStageReader,
  createOrderUserReader,
  createUserDeletionStatusReader,
  createRealnameStatusBatchReader,
  createRealnameIdentityKeyReader,
  createMinorStatusBatchReader,
  createInviteRewardLoginIpsReader,
  createInviteRewardDeletedPhoneReader,
  revokeSessionsByUser,
  unbindRevoked,
  unconfiguredAppleTokenRevoker,
  type AfterSessionsRevoked,
  type AppleTokenRevoker,
  type DeletionCleanupPorts,
  type DeletionClosingAdjustmentPrefill,
  type DeletionClosingAdjustmentReader,
  type WithdrawalSucceededReader,
  type IdentityAttrCodeReader,
  type IdentityConfigReader,
  type IdentityContext,
  type LaborAgreementConfigReader,
  type DeletionBalanceReader,
  type DeletionCalendarConfigReader,
  type DeletionProgressNotice,
  type AdminDataCopyRegistrants,
  type WithdrawalInFlightReader,
  type WithdrawalNonTerminalReader,
  type LandingInvitePort,
  type LandingRegisterConfigReader,
  type IdentityRequest,
  type FirstAppLoginReview,
  type InitialLevelLog,
  type RegistrationInviteBindingPort,
  type SessionPushTokens,
  type UserLevelReader,
  type IdentityLevelChecks,
  type PrivacyConsentChecks,
  type DeletionStageChecks,
  type PrivacyConsentOptions,
  type AccountAssetsPort,
  type AccountRiskPort,
  type MeReadPorts,
  type MeUnionBindingStatus,
  type PayoutAccountConfigPort,
  type PersonalDataCopySources,
  createReverifyGate,
  readDeletionRequestOwners,
} from './modules/identity/index.ts';
import {
  EarningsSummaryModule,
  LedgerAdminModule,
  LedgerAssetSnapshotModule,
  LedgerDailyCheckModule,
  LedgerModule,
  WalletLedgerModule,
  WalletSummaryModule,
  closingAdjustmentGate,
  createLedger,
  getAssetSnapshotStatus,
  getOrderNets,
  hasUserBalanceEntries,
  prefillClosingAdjustment,
  readForfeitAmount,
  readPersonalDataCopyLedgerEntries,
  readUnionAuthoritativeOrderKeys,
  registerReconDiff,
  registerReconDiffOnce,
  type EarningsSummaryDependencies,
  type WalletLedgerDependencies,
  type WalletSummaryDependencies,
  type ClosingAdjustmentAuditPort,
  readOrderFiguresLedger,
} from './modules/ledger/index.ts';
// B1-02zn: GET /v1/me's balance reads the wallet summary query through ledger's read-only entry.
import { getWalletSummary } from './modules/ledger/read.ts';
import { readOrder } from './modules/orders/infra/pipeline-store.ts';
import { PaymentModule } from './modules/payment/index.ts';
import {
  readAlipayWaterLevel,
  AUTO_PAYOUT_SAVE_KEYS,
  PayoutAdminModule,
  PayoutModule,
  autoPayoutWriteRefusals,
  createReconPassedDays,
  readAutoPayoutEnableCheck,
  createFeeTaxCalculator,
  type PayoutConfigPort,
  createWithdrawApply,
  createWithdrawRiskFlags,
  createWithdrawRiskFactsReader,
  createBalanceRecoveredHook,
  createPersonalDataCopyWithdrawalsReader,
  createPayoutAttemptsStore,
  type AutoPayoutPorts,
  createWithdrawalInFlightReader,
  createWithdrawHolds,
  createWithdrawHoldsReader,
  createWithdrawalProvenSuccess,
  holdActive,
  releaseWithdrawHoldsBySource,
  createWithdrawRules,
  createWithdrawSwitchCheck,
  isWithdrawalApplication,
  createWithdrawUsageReader,
  generateOutBizNo,
  createTaxExportReader,
  readPaidWithdrawalAt,
  readPaidWithdrawalSummaries,
  readPaidWithdrawalTotal,
  type DecryptWithdrawalAccount,
  type PayoutProcessOptions,
  type PayoutQueuePausePort,
  type ReverifyGatePort,
  type WithdrawApplyService,
  type WithdrawBlockedHits,
  type WithdrawRulesOptions,
  type WithdrawRulesService,
  readWithdrawalAdjustRefs,
} from './modules/payout/index.ts';
import {
  LINK_LANDING_PORTS,
  LINK_OPEN_PORTS,
  LINK_REGISTRATIONS,
  LinkingAdminModule,
  LinkingModule,
  createOrderBindingReader,
  createClaimEntryReader,
  createClaimEvidenceReader,
  createLinkLogMomentReader,
  createOrderSourceReader,
  blockForBan,
  restoreAfterUnban,
  createOrderLinkReader,
  createPendingAttemptStore,
  createUnionAuthReads,
  type UnionAuthReads,
  createUnavailableAttrCodeReader,
  PROMO_PREFETCH_JOB,
  createLinkRegistration,
  createPromoPrefetch,
  createPromoPrefetchHandler,
  createPromoPrefetchLimiter,
  createSourceLinkReader,
  inOpenReads,
  loadLinkOpenApps,
  openScopedConfig,
  openScopedReader,
  type LinkConvertPorts,
  type LinkLandingPorts,
  type LinkOpenPorts,
  type LinkOpenQuoteReads,
  type LinkOpenReadPlan,
  type LinkRegistrations,
  type LinkSharePorts,
  needsTaobaoReauth,
  blockForDeletion,
  createLandingLinks,
} from './modules/linking/index.ts';
import {
  FeedbackModule,
  deleteFeedbackForUser,
  type FeedbackAccountReader,
  type FeedbackLinkReader,
} from './modules/feedback/index.ts';
import {
  NotificationAdminModule,
  NotificationModule,
  bindPushTokensForSession,
  createSiteAuthAlertPort,
  createEntrySmsSender,
  createDemoMobPush,
  createLiveTemplateSmsSender,
  createNotifySmsTestSender,
  createPushSendCore,
  type PushSendCore,
  createRegisteredTemplateResolver,
  createTemplateSmsSender,
  deletePushTokensForUser,
  unbindPushTokensForSession,
  writeDeletionProgressMessage,
  type AliyunSmsFetch,
  type NotifySmsTestSender,
  type TemplateSmsSender,
  type VerifyCodeSmsSender,
  recordBalanceAdjustedMessage,
} from './modules/notification/index.ts';
import {
  createSelfPurchaseOrderReader,
  OrdersAdminModule,
  OrdersModule,
  orderSyncToken,
  type AdminClaimPorts,
  type AdminOrderPorts,
  type AdminOrderWritePorts,
  type OrderFiguresReader,
  createInviteRewardOrderFacts,
  type ClaimEvidenceFactory,
  createOrderQueries,
  createClawbackPendingPort,
  createOrderSourcePorts,
  type OrderSourcePorts,
  type OrderRebateAssembly,
  type OrderRebatePortFactory,
  type PlatformRestoreDiffPort,
  readPersonalDataCopyOrders,
  type OrdersWorkerOptions,
  readExistingOrderKeys,
} from './modules/orders/index.ts';
import {
  ParsingError,
  ParsingLinkRegistrars,
  ParsingModule,
  createParsing,
  extractCandidates,
  parseToken,
  parseUrl,
  type ParseScene,
  type ParsingOptions,
} from './modules/parsing/index.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  FIELD_CRYPTO,
  EVENT_BUS,
  PlatformModule,
  JOB_QUEUE,
  REDIS,
  ROOT_LOGGER,
  SENSITIVE_KEYS,
  createResilienceRegistry,
  quotaShares,
  systemScheduler,
  type AppConfig,
  type AuditPort,
  type Clock,
  type FieldCrypto,
  type EventBus,
  type IdempotencyPostMissCheck,
  type JobQueue,
  type PlatformOptions,
  type QuotaLimiter,
  type RedisHandle,
  type RootLogger,
  REQUEST_CHECKS,
  type RequestCheck,
  type RequestCheckPlan,
  isContractSignedRoute,
  isHttpEntry,
  createImportStore,
} from './modules/platform/index.ts';
import {
  blocklistHmacContexts,
  createBlocklistMatchReader,
  createAppealPrevStateReader,
  createOrderBlocklistPorts,
  createRiskStateBatchReader,
  RiskAdminModule,
  RiskAppealsAdminModule,
  RiskRulesAdminModule,
  type AdminAppealsReadPorts,
  type AdminAppealsWritePorts,
  RiskModule,
  RiskScanModule,
  SIGNATURE_CHECK,
  createBlocklistService,
  createWithdrawalReviewHits,
  createInviteRelationHitWriter,
  createRiskRuleStatusReader,
  createSameDeviceAccountsCheck,
  createRiskStateService,
  createDeviceRegistrationRisk,
  createSmsRisk,
  riskStateServiceToken,
  ephemeralSmsRiskIndex,
  unkeyedDeviceRegistrationIndex,
  type DeviceRegistrationRisk,
  type SmsRisk,
  createRateLimitThresholdReader,
  type MinimumVersionReaders,
  type RateLimitThresholdReaders,
  type BlocklistService,
  type RiskStateService,
  createOrderAppealReader,
} from './modules/risk/index.ts';
import {
  SettlementAdminModule,
  SettlementModule,
  createAttributionRebatePort,
  createEarningsOrdersSource,
  createOrderFiguresReader,
  createPendingEarningsSource,
  createBeneficiaryGate,
  createClawbackOrder,
  createRebateAdminCommandPort,
  createRebatePort,
  createRightsCommandPort,
  type ClawbackOrder,
  type RebatePort,
  readOrderIdsByKey,
} from './modules/settlement/index.ts';
import {
  REGISTERED_PLATFORMS,
  UNION_ENDPOINTS,
  UNION_REGISTRY,
  UnionAdminModule,
  UnionAuthModule,
  UnionModule,
  createGovernedAdapter,
  createUnionPidService,
  createUnionQuotaSource,
  isRegisteredPlatform,
  type RegisteredPlatform,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionMode,
  type UnionQuotaDeps,
  type UnionQuotaSource,
  type UnionRegistry,
} from './modules/union/index.ts';

/**
 * The request check plan bootstrap installs before Fastify parses a body (规划/08 BR-ID-01):
 * on the `api` entry, which serves every x-signed operation, ① the request signature first
 * (bootstrap refuses a plan where it is not), then identity's consent signature check (B1-02zc:
 * recordConsent's clipboard_auto_import requests, signed over the raw body although the operation
 * is x-signed false), then identity's token stages ② ③. They run on every matched route; only the
 * contract x-signed routes and recordConsent have their body buffered before the checks (the
 * signature covers it), so ② ③ answer any other unsigned route from its headers alone, before its
 * body is read or validated, and its body keeps Fastify's own handling. ① skips unsigned routes;
 * ② ③ act by the route's contract x-auth and leave routes outside the contract alone.
 * The factory stays synchronous (its async dependencies are providers of their own).
 * On the `admin` entry (F1-06k) the only check is admin's: the whitelist on every /admin/v1
 * route, then the admin_token on the contract admin / super routes (BR-ID-34); it reads headers
 * and the client address only, so no body is buffered.
 * The stream pre-parsing plan installs identity's token stages ② ③: Agent routes are unsigned
 * and x-auth optional. Risk's ordered guards run afterwards, as on api, including minimum
 * versions, restricted sessions and bans. The admin entry covers its levels through its check.
 */
function requestChecks(options: PlatformOptions): Provider {
  if (options.entry === 'api') {
    return {
      provide: REQUEST_CHECKS,
      inject: [SIGNATURE_CHECK, CONSENT_SIGNATURE_CHECK, TOKEN_CHECK],
      useFactory: (
        signature: RequestCheck,
        consentSignature: RequestCheck,
        token: RequestCheck,
      ): RequestCheckPlan => ({
        // ① signature; then recordConsent's clipboard_auto_import signature (B1-02zc: the same
        // checks over the raw bytes on that one unsigned route), still before ② ③.
        checks: [signature, consentSignature, token],
        // The x-signed routes, plus recordConsent alone among the unsigned ones (its
        // clipboard_auto_import requests are signed over the raw body, B1-02zc).
        bufferWhen: (method, template) =>
          isContractSignedRoute(method, template) || isRecordConsentRoute(method, template),
      }),
    };
  }
  if (options.entry === 'admin') {
    return {
      provide: REQUEST_CHECKS,
      inject: [ADMIN_CHECK],
      useFactory: (admin: RequestCheck): RequestCheckPlan => ({
        checks: [admin],
        bufferWhen: () => false,
      }),
    };
  }
  if (options.entry === 'stream') {
    return {
      provide: REQUEST_CHECKS,
      inject: [TOKEN_CHECK],
      useFactory: (token: RequestCheck): RequestCheckPlan => ({
        checks: [token],
        bufferWhen: () => false,
      }),
    };
  }
  return { provide: REQUEST_CHECKS, useValue: { checks: [] } satisfies RequestCheckPlan };
}

/** Identity services and checks without its /v1 routes, which belong to api. */
function streamIdentityModule(): DynamicModule {
  return {
    ...IdentityModule.forRoot({
      // B1-02zj (D10-255 ①): stream only verifies access tokens (public key + kid, never signs).
      tokens: 'verify',
      config: {
        inject: [CLOCK, { token: DB, optional: true }],
        useFactory: (clock: Clock, db?: Kysely<Database>): IdentityConfigReader | null =>
          db === undefined ? null : createContentReader({ db, clock }),
      },
    }),
    controllers: [],
  };
}

/**
 * Stream shares api's minimum-version / restricted-session and ban guards, without risk's
 * appeals routes. Agent owns admission and rate limits (BR-AI-23); no api rate-limit mapping or
 * identity level / step-up checks are supplied to this entry.
 * Stage ⑥ (deletion cooling / processing, B1-15m) is the only check in both lists: after ⑤, it
 * refuses /v1/agent/ writes carrying a verified token with 10007 (BR-ID-01, BR-ID-27); ⑦ ⑧ ⑨ and
 * step-up stay off this entry.
 */
/**
 * B2-11d (规划/08 BR-WDR-30, BR-WDR-17): content's console writes with payout's checks. Config item
 * writes (single, batch, rollback) run payout's 保存时校验 over the configuration they would leave;
 * turning withdraw.auto_payout.enabled on asks payout's 开启前置检查 for the caller's app, reading
 * its keys through content's reader and the reconciliation days through payout's real port over
 * app.payout_recon_runs (B2-07d, D10-408). Without a database handle the switch keeps its refusal.
 * They go to ContentAdminModule.forAdmin as options (B2-11e).
 */
function contentAdminChecks(): Pick<ContentAdminOptions, 'configItemChecks' | 'killSwitchChecks'> {
  // B1-05m: one save hook, payout's check and catalog's search.hot_words / search.keyword_routes
  // check (D10-419 (a) 2), each run only for writes of its own keys.
  const save = combineConfigItemSaveChecks(
    { keys: AUTO_PAYOUT_SAVE_KEYS, refusals: autoPayoutWriteRefusals },
    searchConfigSaveCheck(),
  );
  return {
    configItemChecks: { save },
    killSwitchChecks: (db, clock) => {
      const recon = createReconPassedDays({ clock });
      const config = {
        configValue: (appId: string, key: string, handle: Kysely<Database>) =>
          createContentReader({ db: handle, clock }).configValue(appId, key),
      };
      return {
        autoPayoutEnable: (appId) => readAutoPayoutEnableCheck(appId, db, { config, recon }),
      };
    },
  };
}

function streamRiskModule(
  identity: DynamicModule,
  contentReader: SharedContentReader,
): DynamicModule {
  const noRateLimits = {
    groupFor: async () => null,
    rules: async () => [],
  };
  return {
    ...RiskModule.forRoot({
      imports: [identity],
      beforeRateLimit: {
        inject: [DELETION_STAGE_CHECKS],
        useFactory: (deletion: DeletionStageChecks) => [deletion.postMiss],
      },
      beforeRateLimitGuards: {
        inject: [DELETION_STAGE_CHECKS],
        useFactory: (deletion: DeletionStageChecks) => [deletion.guard],
      },
      minimumVersions: {
        inject: [CLOCK, { token: DB, optional: true }],
        useFactory: (clock: Clock, db?: Kysely<Database>): MinimumVersionReaders | null =>
          db === undefined
            ? null
            : {
                pooled: contentReader(db, clock),
                on: (handle) => createContentReader({ db: handle, clock }),
              },
      },
      rateLimit: {
        thresholds: {
          useFactory: (): RateLimitThresholdReaders => ({
            pooled: noRateLimits,
            on: () => noRateLimits,
          }),
        },
      },
    }),
    controllers: [],
  };
}

/**
 * B1-13e: content's reader on the caller's handle (B1-11d precedent): a plain read each time,
 * never a second pooled connection while the caller's transaction is held. Shared by the api
 * entry's IdentityModule and the worker's IdentityWorkerModule (B1-13g).
 */
const payoutAccountConfig = {
  inject: [CLOCK],
  useFactory: (clock: Clock): PayoutAccountConfigPort => ({
    configValue: (appId, key, handle) =>
      createContentReader({ db: handle, clock }).configValue(appId, key),
  }),
};

/**
 * B1-27a (BR-ID-25 细则「实名更正」, BR-ID-31 ID-number dimension; D10-185): whether an ID number is
 * on an active, unexpired id_no entry of the app's blocklist, read only on the caller's handle (the
 * console-side 44001 / identity_blacklisted records no risk_hits and is not appealable, BR-ID-36;
 * risk's BlocklistService.check would record one). Both digests the code base uses for this
 * dimension are matched: realname.id_no_hmac (what the withdrawal check compares,
 * risk/ports/blocklist-match.ts) and risk's own blocklist.id_no context.
 * TODO(规划/11 §2.3): 把只读的身份证维度黑名单匹配移入 risk 并从其 index.ts 导出 — blocked on risk 模块不在本任务路径内
 */
function correctionIdNoBlocklist(deps: { readonly clock: Clock; readonly crypto: FieldCrypto }) {
  const context = blocklistHmacContexts().id_no;
  return {
    async listed(
      handle: Kysely<Database>,
      input: { readonly appId: string; readonly idNo: string; readonly idNoHmac: string },
    ): Promise<boolean> {
      const digests = [...new Set([input.idNoHmac, deps.crypto.blindIndex(input.idNo, context)])];
      const row = await handle
        .withSchema('app')
        .selectFrom('blocklist')
        .select('id')
        .where('app_id', '=', input.appId)
        .where('dimension', '=', 'id_no')
        .where('value_hmac', 'in', digests)
        .where('status', '=', 'active')
        .where('expire_at', '>', deps.clock.now())
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}

/**
 * The user's withdrawals as identity's deletion flows see them, on the caller's transaction:
 * POST /v1/me/deletion asks hasInFlight (B1-15d, D10-97: 30412), the worker's cooling-period
 * expiry asks hasNonTerminal (B1-15f, BR-ID-27: any non-terminal one, ban-frozen included, defers
 * processing), the deletion cleanup asks hasSucceeded (B1-15g / B1-27j, D10-137 ②). All three are
 * payout's reader (B2-05e).
 */
const deletionWithdrawals = {
  inject: [CLOCK],
  useFactory: (
    clock: Clock,
  ): WithdrawalInFlightReader & WithdrawalNonTerminalReader & WithdrawalSucceededReader => ({
    // B2-05e (D-W04): payout's reader — hasInFlight ignores a member under a manual hold.
    // B1-27j (D10-137 ②): its hasSucceeded (PAID_API / PAID_MANUAL) keeps the real name on
    // deletion (tax_retained).
    ...createWithdrawalInFlightReader({ clock }),
  }),
};

/**
 * The user's available_fen for the deletion flows (B1-15d 30416 on the api entry; B1-15f's expiry
 * re-check on the worker): the ledger's getBalances on the caller's transaction (bigint fen; no
 * account → 0n).
 */
const deletionBalance = {
  inject: [CLOCK],
  useFactory: (clock: Clock): DeletionBalanceReader => {
    const ledger = createLedger({ clock });
    return {
      async availableFen(trx, input) {
        const balances = await ledger.getBalances(trx, {
          appId: input.appId,
          userIds: [input.userId],
        });
        const own = balances.find(
          (row) => row.app_id === input.appId && row.user_id === input.userId,
        );
        return own === undefined ? 0n : own.available_fen;
      },
    };
  },
};

/**
 * B1-15i: the DELETION_PROGRESS inbox message (BR-TEXT-23) identity writes on its deletion
 * transactions (requested / cancelled on the api entry, cancelled_negative on the worker's expiry):
 * notification's writeDeletionProgressMessage on the caller's transaction, timestamps from the
 * Clock. Depends on CLOCK only (both entries' identity modules can inject it).
 */
const deletionProgressNotice = {
  inject: [CLOCK],
  useFactory: (clock: Clock): DeletionProgressNotice => ({
    async write(trx, input) {
      await writeDeletionProgressMessage(trx, input, { clock });
    },
  }),
};

/**
 * B1-15g: the owning modules' shares of the deletion cleanup (identity's DeletionCleanupPorts, on
 * identity's cleanup transaction). growth's detachChildrenOfDeleted (B1-15n), notification's
 * deletePushTokensForUser (F1-02zzk), linking's blockForDeletion (B1-06zc) and catalog's
 * deleteFavoritesForUser (B1-28f) and feedback's deleteFeedbackForUser (B1-28p) are shipped; the others are unavailable markers: the rest of the
 * cleanup still commits, but the request stays in processing (cleaned_at NULL) with a daily
 * identity_deletion_cleanup_blocked line until the owner ships and is assembled here. agent's
 * slot follows the configuration (agentDeletionCleanup).
 */
const deletionCleanupPorts = {
  inject: [APP_CONFIG, ROOT_LOGGER, { token: DB, optional: true }],
  useFactory: (
    config: AppConfig | undefined,
    logger: RootLogger,
    database?: unknown,
  ): DeletionCleanupPorts => ({
    linking: blockForDeletion,
    growth: detachChildrenOfDeleted,
    // F1-02zzk: notification deletes the user's push tokens in the app (BR-ID-28, BR-ID-30).
    notification: deletePushTokensForUser,
    // B3-09j (BR-AI-22): agent's purge under AGENT_USER_HASH_KEY; unavailable while it is unset.
    agent: agentDeletionCleanup(config, logger, database),
    // B1-28f: every favorite of the user in the app (BR-ID-28).
    catalog: deleteFavoritesForUser,
    // B1-28p: the user's product feedback records in the app; guest records stay (BR-ID-28).
    feedback: deleteFeedbackForUser,
  }),
};

/**
 * B1-28p: feedback's link check through linking's read of app.links (the landing's lookup by app
 * and link_id), on the handle feedback passes (its idempotency transaction).
 */
const feedbackLinks: FeedbackLinkReader = {
  async linkInApp(handle, appId, linkId) {
    return (await createLandingLinks(handle).find(appId, linkId)) !== null;
  },
};

/**
 * B1-28p (money r1 S1, BR-ID-28): feedback's read of the submitting account's deletion status
 * through identity's read port (users.status), on feedback's transaction after it has locked the
 * users row; undefined when the user is not in the app. The reader runs every query on the
 * executor it is given (its `db` option is never queried).
 */
const feedbackAccounts: FeedbackAccountReader = {
  async deletionStatus(trx, appId, userId) {
    const statuses = await createUserDeletionStatusReader({ db: trx }).read(trx, {
      app_id: appId,
      user_ids: [userId],
    });
    return statuses.get(userId);
  },
};

/**
 * B3-09j (BR-AI-22): the agent slot of deletionCleanupPorts. With config.agentUserHashKey, agent's
 * purgeAgentDataForUser over that key; without it (null / absent; prod never gets here, loadConfig
 * refuses), an unavailable marker, plus one warn that never carries a key value when a database is
 * configured. Without a database the deletion processing does not run, so there is no warn
 * (D10-334, identity [AC-B1-15f#29]). A missing config (a caller resolving no APP_CONFIG) counts as
 * keyless.
 */
export function agentDeletionCleanup(
  config: AppConfig | undefined,
  logger: RootLogger,
  database?: unknown,
): DeletionCleanupPorts['agent'] {
  const key = config?.agentUserHashKey ?? null;
  if (key !== null && key.trim() !== '') {
    return createAgentDataPurge({ userHashKey: key }).purgeAgentDataForUser;
  }
  if (database === undefined || database === null) return { unavailable: 'AGENT_USER_HASH_KEY' };
  // Names the variable only, never a value.
  logger.warn(
    { event: 'agent_deletion_cleanup_unavailable' },
    'AGENT_USER_HASH_KEY is not set: agent data purge on account deletion stays unavailable',
  );
  return { unavailable: 'AGENT_USER_HASH_KEY' };
}

/**
 * B1-15g (D10-137 ①, BR-FUND-24 ⑧): the closing adjustment gate of the deletion completion.
 * B2-12d: ledger's closingAdjustmentGate on identity's completion transaction (users row locked;
 * the balance row locked by the gate): a PENDING ACCOUNT_CLOSED form or a balance ≠ 0 → pending,
 * otherwise done (an approved ACCOUNT_CLOSED decrease exists) or none_needed. Replaces the stand-in
 * closingAdjustmentFromBalance (still exported by identity).
 */
const deletionClosingAdjustment = {
  inject: [],
  useFactory: (): DeletionClosingAdjustmentReader => ({
    closingAdjustmentState: (trx, input) => closingAdjustmentGate(trx, input),
  }),
};

/**
 * B2-12d (BR-FUND-24 ⑧, D10-590 ③): ledger's prefill of the PENDING ACCOUNT_CLOSED decrease, on
 * identity's transaction (users row locked): by the cooling-period expiry as the request enters
 * processing, and by the processing round while the closing gate is pending (at most one new form
 * per accounting day). BR-FUND-24 ①「全程写 audit_logs」: a landed insert writes one system audit
 * record (system:ledger, adjustment_prefill) on the same transaction through admin's system
 * audit writer, as payout's went-negative rejection does.
 */
const deletionClosingPrefill = {
  inject: [CLOCK],
  useFactory: (clock: Clock): DeletionClosingAdjustmentPrefill => {
    const writer = createSystemAuditWriter({ clock, sensitiveKeys: SENSITIVE_KEYS });
    const audit: ClosingAdjustmentAuditPort = {
      appendAction: (trx, input) => writer.appendAction(trx, input),
    };
    return { prefill: (trx, input) => prefillClosingAdjustment(trx, input, { audit }) };
  },
};

/**
 * B1-15g (BR-ID-27): the Sign in with Apple revocation. Unconfigured until the Apple keys and a
 * recorded exchange exist: every attempt fails (three failures → failed, alerted, done not
 * blocked). Never an implementation that pretends to succeed.
 */
const deletionAppleRevoker = {
  inject: [],
  useFactory: (): AppleTokenRevoker => unconfiguredAppleTokenRevoker(),
};

/** B1-15g: the push token unbinding of the sessions the deletion cleanup revokes (as for a ban). */
const deletionAfterRevoked = {
  inject: [CLOCK],
  useFactory: (clock: Clock): AfterSessionsRevoked => unbindRevoked(sessionPushTokens(clock)),
};

/**
 * B1-27f (BR-ID-40 导出范围): the sources of a personal information copy for B1-27h's generation —
 * identity's createPersonalDataCopySources over the process field cipher, with the owners'
 * read-only files from their index.ts: orders' readPersonalDataCopyOrders, ledger's
 * readPersonalDataCopyLedgerEntries, payout's createPersonalDataCopyWithdrawalsReader (the payee
 * snapshot decrypted with the payout_accounts.* contexts, as the withdrawal reads), agent's
 * createPersonalDataCopyAgentReader (the clock) and growth's readPersonalDataCopyInvite.
 */
export function personalDataCopySources(
  clock: Clock,
  crypto: FieldCrypto,
): PersonalDataCopySources {
  const contexts = blocklistHmacContexts();
  const agent = createPersonalDataCopyAgentReader({ clock });
  return createPersonalDataCopySources({
    crypto,
    orders: readPersonalDataCopyOrders,
    ledger: readPersonalDataCopyLedgerEntries,
    withdrawals: createPersonalDataCopyWithdrawalsReader({
      decrypt: (cipher, method) => {
        const context =
          method === 'alipay'
            ? contexts.alipay
            : method === 'bank_card'
              ? contexts.bank_card
              : null;
        if (context === null) throw new Error('payout: no cipher context for the payout method');
        return crypto.decrypt(cipher.toString('utf8'), context);
      },
    }),
    // agent.trace.retention_days read here, through content's config_items reader on the caller's
    // handle (fresh per call, uncached; a READ ONLY transaction included), and resolved by agent's
    // pure agentTraceRetentionDays; agent's reader gets only the number, never a config port.
    agent: async (handle, subject) => {
      const item = await createContentReader({ db: handle, clock }).configValue(
        subject.appId,
        agentTraceRetentionKey(),
      );
      return agent(handle, subject, { retentionDays: agentTraceRetentionDays(item?.value) });
    },
    invite: readPersonalDataCopyInvite,
  });
}

/** Runs on the caller's transaction, or on a read-only one of its own. */
function onReadTransaction<T>(
  db: Kysely<Database>,
  run: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  if (db.isTransaction) return run(db as Transaction<Database>);
  return db.transaction().setAccessMode('read only').execute(run);
}

/**
 * The order figures' snapshot port (B1-09p): reserve ratio, ratios and forfeited shares, which are
 * immutable, from the version-independent read. A changed estimate moves orders.commission_version
 * ahead of the stored amount rows (D10-317), and readCommissionSnapshot refuses that; the figures
 * take no amount from those rows, so such an order keeps its figures. No snapshot yet is null.
 */
async function orderFiguresSnapshot(
  trx: Transaction<Database>,
  input: { readonly appId: string; readonly orderId: string },
) {
  try {
    await readTljDeductFen(trx, input);
  } catch (error) {
    if (error instanceof TljDeductionMissing) return null;
    throw error;
  }
  return readCommissionAttribution(trx, input);
}

/** settlement's order figures over the owners' read ports (B1-09p, D10-551 item 9, D10-558). */
function orderFiguresReader(db: Kysely<Database>, clock: Clock): OrderFiguresReader {
  return createOrderFiguresReader({
    db,
    clock,
    config: {
      get: async (appId, key) =>
        (await createContentReader({ db, clock }).configValue(appId, key))?.value,
    },
    readSnapshot: orderFiguresSnapshot,
    readTljDeductFen,
    ledger: readOrderFiguresLedger,
    appeals: createOrderAppealReader(db),
  });
}

/**
 * GET /v1/wallet/summary's owner-module ports (B2-04y; BR-FUND-18), on the entry's database:
 * - estimates: settlement's PendingEarningsSource (S3), built per read over the read transaction
 *   with content's configuration reader and commission's snapshot and tlj_deduct_fen read ports;
 * - risk_paused_reason: risk's batch state reader; a stored frozen state answers account_frozen;
 * - withdraw_enabled: withdraw.enabled through content's reader, the registry default when unset.
 */
function walletSummaryDependencies(db: Kysely<Database>, clock: Clock): WalletSummaryDependencies {
  const pendingSource = (trx: Transaction<Database>) =>
    createPendingEarningsSource({
      clock,
      config: {
        get: async (appId, key) =>
          (await createContentReader({ db: trx, clock }).configValue(appId, key))?.value,
      },
      readSnapshot: readCommissionSnapshot,
      // commission's read port: the sub-order's immutable tlj_deduct_fen on the same transaction
      // (an absent split throws: never a default 0, BR-CALC-02).
      readTljDeductFen,
    });
  const riskStates = createRiskStateBatchReader({ db });
  const withdrawHolds = createWithdrawHoldsReader();
  const withdrawDefault = switchSpecOf('withdraw.enabled')?.defaultValue;
  return {
    clock,
    pendingEarnings: {
      readUser: (handle, input) =>
        onReadTransaction(handle, async (trx) => {
          const own = await pendingSource(trx).forUser(trx, {
            appId: input.appId,
            userId: input.userId,
          });
          return {
            estimated_fen: own.estimated_fen,
            pending_credit_fen: own.pending_credit_fen,
            pending_credit_paused_fen: own.pending_credit_paused_fen,
            next_credit_period: own.next_credit_period,
            credit_overdue: own.credit_overdue,
          };
        }),
      readAppTotals: (handle, input) =>
        onReadTransaction(handle, (trx) => pendingSource(trx).forApp(trx, { appId: input.appId })),
    },
    withdrawals: {
      // B2-05p (BR-FUND-18): Σ amount_fen of PAID_API / PAID_MANUAL, on the summary's read transaction.
      readPaidTotal: readPaidWithdrawalTotal,
    },
    risk: {
      async readPauseReason(handle, subject) {
        const states = await riskStates.read(handle, {
          appId: subject.appId,
          userIds: [subject.userId],
        });
        if (states.get(subject.userId)?.state === 'frozen') return 'account_frozen';
        // B2-05p (BR-FUND-18, BR-WDR-05): every effective hold is account_frozen to the user, whatever
        // its reason (the source is not disclosed); judged row by row on the injected Clock.
        // The reader's port is shared with the apply rules; it reads only appId and userId.
        const holds = await withdrawHolds.read(handle, { ...subject, deviceId: '' });
        const now = clock.now();
        return holds.some((hold) => holdActive(hold, now)) ? 'account_frozen' : null;
      },
    },
    config: {
      async readWithdrawEnabled(appId) {
        const item = await createContentReader({ db, clock }).configValue(
          appId,
          'withdraw.enabled',
        );
        const value = item === null ? withdrawDefault : item.value;
        // Anything but a boolean is a broken setting: the button greys out, balances still show.
        return value === true;
      },
    },
  };
}

/**
 * GET /v1/earnings/summary's owner-module ports (B2-13a; BR-FUND-25), on the entry's database:
 * - order facts (paid counts and estimated shares): settlement's earnings reads over the read
 *   transaction, priced with commission's snapshot and tlj_deduct_fen read ports (BR-CALC-02);
 * - switches: earnings.dashboard.enabled / referral_visible through content's reader, default on
 *   (a missing item or anything but false counts as on, like the client's derived entry key).
 */
function earningsSummaryDependencies(
  db: Kysely<Database>,
  clock: Clock,
): EarningsSummaryDependencies {
  const orders = createEarningsOrdersSource({
    readSnapshot: readCommissionSnapshot,
    readTljDeductFen,
  });
  // One cached reader for this entry (switch cache lifetime, like the client configuration).
  const reader = createContentReader({ db, clock });
  return {
    clock,
    orders: {
      read: (handle, input) => onReadTransaction(handle, (trx) => orders.read(trx, input)),
    },
    config: {
      async readSwitches(appId) {
        const enabled = await reader.configValue(appId, 'earnings.dashboard.enabled');
        const referral = await reader.configValue(appId, 'earnings.dashboard.referral_visible');
        return {
          enabled: enabled?.value !== false,
          referralVisible: referral?.value !== false,
        };
      },
    },
  };
}

/**
 * GET /v1/wallet/ledger's owner-module read ports (B2-04zc; BR-FUND-15 / BR-TEXT-19), on the read
 * transaction ledger passes: payout's paid withdrawals (one WITHDRAW_PAID summary entry each, and
 * the paid_at of the member's own one a cursor names) and settlement's order_key → order_id for the
 * self / share entries' links.
 */
const walletLedgerDependencies: WalletLedgerDependencies = {
  withdrawals: { readPaid: readPaidWithdrawalSummaries, readPaidAt: readPaidWithdrawalAt },
  orders: { readOrderIds: readOrderIdsByKey },
};

/**
 * B1-15f: the working-day calendar of the deletion overdue alarm (calendar.cn_holidays.<year>,
 * calendar.cn_makeup_workdays.<year>) through content's reader; without a database there is no
 * expiry to read it (every read answers null).
 */
/** The two points a wecom_session copy is downloaded under (BR-ID-40 细则「企业微信会话交付的下载」). */
const DATA_COPY_DOWNLOAD_POINTS = ['user.data_export', 'pii.reveal_phone'] as const;

/**
 * identity's copy request registrants (B1-27c) over admin's reads, on the handle the caller passes
 * (the registration's transaction): an active account that is super or ticks both download
 * points; current names as admin's display name reader gives them.
 */
const dataCopyRegistrants: AdminDataCopyRegistrants = {
  async canDownload(db, appId, adminId) {
    const profiles = createAdminProfiles({ db });
    const profile = await profiles.byId(appId, adminId);
    if (profile === undefined || profile.status !== ADMIN_ACTIVE_STATUS) return false;
    if (profile.isSuper) return true;
    const ticked = new Set(await profiles.permissionKeys(appId, adminId));
    return DATA_COPY_DOWNLOAD_POINTS.every((point) => ticked.has(point));
  },
  names: (db, appId, adminIds) => createAdminDisplayNameReader(db).displayNames(appId, adminIds),
};

const deletionCalendarConfig = {
  inject: [CLOCK, { token: DB, optional: true }],
  useFactory: (clock: Clock, db?: Kysely<Database>): DeletionCalendarConfigReader => {
    if (db === undefined) return { configValue: () => Promise.resolve(null) };
    const reader = createContentReader({ db, clock });
    return { configValue: (appId, key) => reader.configValue(appId, key) };
  },
};

/**
 * The identity module of the `api` entry. Its configuration port (sms.blocked_prefixes, BR-ID-05;
 * the minimum supported version of the session scope, BR-ID-01 细则「受限会话」) is content's cached
 * reader of config_items and app_versions: content implements the port's shape without importing
 * identity (same assembly as the risk ports, F1-02b). No database handle (isolated HTTP unit
 * tests): no reader, and the SMS code route answers 50001.
 * Its blocklist port is risk's blocklist service (B1-03d: SMS send, SMS login before creating an
 * account, the same-device limit), built here so identity and risk stay plain ports to each
 * other; without a database or field cipher there is none.
 * Its device registration ports are risk's (B1-03f: device.ip_register_per_hour and
 * device.hash_hot_alert_count through content's configValue, Redis sets keyed by the field
 * cipher's blind index), built through risk's index.ts; without Redis they refuse (42901) and the
 * hot-hash count is a no-op; without a database the thresholds are the defaults.
 * Its SMS send risk is risk's (B1-03g: sms.device_distinct_phones_per_hour, sms.ip_sends_per_hour,
 * the per-IP new-account limit and the daily budget alert through content's configValue; phones and
 * IPs as the field cipher's blind index, a process-local key in local / test without a keyring);
 * without Redis every send is refused (42901).
 * Its push token port is notification's binding and conditional unbinding commands (B1-12b,
 * BR-ID-07 细则「推送令牌与会话」), assembled here over the Clock so identity never imports
 * notification (and notification nothing of identity): login binds, logout, the refresh reuse
 * revocation and the revocation entries by user / by device unbind, in the session's transaction.
 * Its real-name status port (stage ⑨, B1-02za) is the default reader (none) until B1-13d.
 * Its invite binding port (BR-INV-06, B1-11d) is growth's binder on the register channel, over
 * config_items read on the registration transaction, Redis, the field cipher's blind index, identity's login-device and
 * order / claim readers and risk's fresh state read, each bound to the registration transaction;
 * without a database, Redis or the field cipher there is none (invite_bind { failed, 50001 }).
 * Its first App login review (BR-INV-09, B1-11f) is growth's landing-bind same-device review over
 * identity's login-device reader and risk's invite-relation hit writer, all on the login
 * transaction; the SMS and the third-party login both run it.
 */
function identityModule(contentReader: SharedContentReader): DynamicModule {
  return IdentityModule.forRoot({
    accountAssets: {
      useFactory: (): AccountAssetsPort => ({
        async countOrders(db, account) {
          const row = await db
            .withSchema('app')
            .selectFrom('orders')
            .select((eb) => eb.fn.countAll<string>().as('count'))
            .where('app_id', '=', account.app_id)
            .where('user_id', '=', account.user_id)
            .executeTakeFirstOrThrow();
          return Number(row.count);
        },
        // B1-20e: any claim of the account as the applicant, whatever its status (read only).
        async hasClaims(db, account) {
          const row = await db
            .withSchema('app')
            .selectFrom('claims')
            .select('id')
            .where('app_id', '=', account.app_id)
            .where('user_id', '=', account.user_id)
            .limit(1)
            .executeTakeFirst();
          return row !== undefined;
        },
        // B1-20e: any entry on the account's balance, through the ledger's read-only export.
        hasLedgerEntries: (db, account) =>
          hasUserBalanceEntries(db, { appId: account.app_id, userId: account.user_id }),
      }),
    },
    accountRisk: {
      inject: [CLOCK, { token: EVENT_BUS, optional: true }],
      useFactory: (clock: Clock, events?: EventBus): AccountRiskPort | null =>
        events === undefined
          ? null
          : {
              async isBanned(db, account) {
                // Bind the exported reader to the caller's transaction: no second connection.
                const risk = createRiskStateService({ db, clock, events });
                const snapshot = await risk.readRiskState(account, { fresh: true });
                if (snapshot.state === 'banned') return true;
                if (snapshot.state !== 'appealing') return false;
                // Reuse risk's exported request check for the pre-appeal state. This is only a
                // read probe; its synthetic principal is never used for authentication or writes.
                try {
                  await risk.checkRequest(
                    {
                      id: '',
                      method: 'POST',
                      routeOptions: { url: '/v1/me/phone' },
                      headers: {},
                      principal: {
                        uid: account.user_id,
                        app_id: account.app_id,
                        sid: '',
                        device_id: '',
                        scp: 'full',
                      },
                    },
                    db,
                  );
                  return false;
                } catch (error) {
                  if (error instanceof HttpException) {
                    const body = error.getResponse();
                    if (typeof body === 'object' && 'code' in body && body.code === 10006)
                      return true;
                  }
                  throw error;
                }
              },
            },
    },
    thirdPartyIdentity: {
      inject: [APP_CONFIG, ROOT_LOGGER],
      useFactory: (config: AppConfig, logger: RootLogger) =>
        createThirdPartyIdentity(config.appEnv, logger),
    },
    config: {
      inject: [CLOCK, { token: DB, optional: true }],
      useFactory: (clock: Clock, db?: Kysely<Database>): IdentityConfigReader | null =>
        db === undefined ? null : createContentReader({ db, clock }),
    },
    payoutAccountConfig,
    blocklist: {
      inject: [
        CLOCK,
        ROOT_LOGGER,
        { token: DB, optional: true },
        { token: FIELD_CRYPTO, optional: true },
      ],
      useFactory: (
        clock: Clock,
        logger: RootLogger,
        db?: Kysely<Database>,
        crypto?: FieldCrypto,
      ): BlocklistService | null =>
        db === undefined || crypto === undefined
          ? null
          : createBlocklistService({ db, clock, crypto, logger }),
    },
    deviceRegistration: {
      inject: [
        CLOCK,
        ROOT_LOGGER,
        { token: DB, optional: true },
        { token: REDIS, optional: true },
        { token: FIELD_CRYPTO, optional: true },
      ],
      useFactory: (
        clock: Clock,
        logger: RootLogger,
        db?: Kysely<Database>,
        redis?: RedisHandle,
        crypto?: FieldCrypto,
      ): DeviceRegistrationRisk =>
        createDeviceRegistrationRisk({
          clock,
          logger,
          redis: redis ?? null,
          config:
            db === undefined
              ? { configValue: () => Promise.resolve(null) }
              : createContentReader({ db, clock }),
          crypto: crypto ?? unkeyedDeviceRegistrationIndex(),
        }),
    },
    smsRisk: {
      inject: [
        CLOCK,
        ROOT_LOGGER,
        { token: DB, optional: true },
        { token: REDIS, optional: true },
        { token: FIELD_CRYPTO, optional: true },
      ],
      useFactory: (
        clock: Clock,
        logger: RootLogger,
        db?: Kysely<Database>,
        redis?: RedisHandle,
        crypto?: FieldCrypto,
      ): SmsRisk =>
        createSmsRisk({
          clock,
          logger,
          redis: redis ?? null,
          config:
            db === undefined
              ? { configValue: () => Promise.resolve(null) }
              : createContentReader({ db, clock }),
          crypto: crypto ?? ephemeralSmsRiskIndex(),
          // B1-11g: the PG-authoritative per-IP attempts (no database → every send refused).
          db: db ?? null,
        }),
    },
    // Through identity's index.ts, as for the admin entry (one sender factory for both entries).
    smsSender: {
      inject: [APP_CONFIG, ROOT_LOGGER, CLOCK, { token: DB, optional: true }],
      useFactory: entrySmsSender,
    },
    pushTokens: {
      inject: [CLOCK],
      useFactory: sessionPushTokens,
    },
    // Stage ⑨'s real-name status port (B1-02za), also GET /v1/me's realname_status: app.realname
    // read on the caller's handle, uncached (B1-13d).
    realnameStatus: { useFactory: createRealnameStatusReader },
    // Stage ⑦ (B1-02zh): legal.privacy.min_version through content's reader. pooled: the shared
    // cached reader for the guard; on: a fresh reader over the idempotency claim's transaction for
    // the post-miss check (no second pooled connection while holding one). No database: null (⑦
    // not judged).
    privacyConsentConfig: {
      inject: [CLOCK, { token: DB, optional: true }],
      useFactory: (clock: Clock, db?: Kysely<Database>): PrivacyConsentOptions['config'] =>
        db === undefined
          ? null
          : {
              pooled: contentReader(db, clock),
              on: (handle) => createContentReader({ db: handle, clock }),
            },
    },
    // BR-WDR-31 (B1-13h): the labor agreement's configuration on the caller's handle (connection
    // or transaction), as inviteBinderDeps: a fresh reader per read, so no cache and no second
    // pooled connection; identity never reads config_items itself.
    // B1-11h: the landing registration's keys (legal versions, landing.ip_register_limit) on the
    // caller's handle, uncached, as laborAgreementConfig below.
    landingConfig: {
      inject: [CLOCK],
      useFactory: (clock: Clock): LandingRegisterConfigReader => ({
        configValue: (appId, key, handle) =>
          createContentReader({ db: handle, clock }).configValue(appId, key),
      }),
    },
    // B1-11h: growth's landing channel (precheck, binding) over the binder's read ports, each
    // bound to the landing transaction; without Redis, the field cipher or the event bus there is
    // none and the route answers 50001.
    landingInvite: {
      inject: [
        CLOCK,
        ROOT_LOGGER,
        { token: REDIS, optional: true },
        { token: FIELD_CRYPTO, optional: true },
        { token: EVENT_BUS, optional: true },
        { token: DB, optional: true },
      ],
      useFactory: (
        clock: Clock,
        logger: RootLogger,
        redis?: RedisHandle,
        crypto?: FieldCrypto,
        events?: EventBus,
        db?: Kysely<Database>,
      ): LandingInvitePort | null => {
        if (redis === undefined || crypto === undefined || events === undefined) {
          logger.info(
            {
              redis: redis !== undefined,
              field_crypto: crypto !== undefined,
              event_bus: events !== undefined,
            },
            'landing_invite_unassembled',
          );
          return null;
        }
        return createLandingInviteBinder({
          clock,
          logger,
          redis,
          crypto,
          ...growthReadPorts(clock, crypto, events),
          // BR-INV-24 ① (B1-35): the reward qualification in the landing transaction.
          ...(db === undefined
            ? {}
            : { inviteReward: inviteRewardQualifier(clock, logger, db, crypto) }),
        });
      },
    },
    laborAgreementConfig: {
      inject: [CLOCK],
      useFactory: (clock: Clock): LaborAgreementConfigReader => ({
        configValue: (appId, key, handle) =>
          createContentReader({ db: handle, clock }).configValue(appId, key),
      }),
    },
    initialLevelLog: {
      inject: [],
      useFactory: (): InitialLevelLog => ({
        append: (trx, input) =>
          appendLevelChange(trx, {
            ...input,
            from_level: null,
            source: 'register',
            operator: 'system',
            reason: null,
          }),
      }),
    },
    inviteBinding: {
      inject: [
        CLOCK,
        ROOT_LOGGER,
        { token: DB, optional: true },
        { token: REDIS, optional: true },
        { token: FIELD_CRYPTO, optional: true },
        { token: EVENT_BUS, optional: true },
      ],
      useFactory: (
        clock: Clock,
        logger: RootLogger,
        db?: Kysely<Database>,
        redis?: RedisHandle,
        crypto?: FieldCrypto,
        events?: EventBus,
      ): RegistrationInviteBindingPort | null => {
        if (
          db === undefined ||
          redis === undefined ||
          crypto === undefined ||
          events === undefined
        ) {
          logger.info(
            {
              db: db !== undefined,
              redis: redis !== undefined,
              field_crypto: crypto !== undefined,
              event_bus: events !== undefined,
            },
            'invite_binding_unassembled',
          );
          return null;
        }
        return createRegistrationInviteBinding(
          createInviteBinder(inviteBinderDeps(clock, logger, db, redis, crypto, events)),
          // The registration's client IP reaches the invite reward qualification (B1-35).
          { forwardClientIp: true },
        );
      },
    },
    withdrawalInFlight: deletionWithdrawals,
    deletionBalance,
    deletionProgress: deletionProgressNotice,
    // Runs only on the login's own transaction (no handle of its own), so it needs no database.
    firstAppLoginReview: {
      inject: [CLOCK],
      useFactory: (clock: Clock): FirstAppLoginReview => {
        // risk's rule status reader (B1-03zh, BR-ID-36) for the judgement; the hit writer is told
        // the judgement's answer (decided_in_force) and does not read again. It reads only through
        // the login's transaction.
        const rules = createRiskRuleStatusReader({ clock });
        return createFirstAppLoginReview({
          clock,
          loginDevices: createInviteLoginDevicesReader(),
          hitWriter: createInviteRelationHitWriter({ clock, rules }),
          ruleInForce: (trx, key) => rules.isEnabled(key, trx),
        });
      },
    },
  });
}

/**
 * growth's binding core dependencies (B1-11d), shared by the register channel (identity's
 * inviteBinding port) and the backfill route (GrowthModule, B1-11e): config_items, identity's
 * login-device and order / claim readers and risk's fresh state read, each bound to the caller's
 * transaction (no second pooled connection while it is held), Redis and the field cipher's blind
 * index.
 */
function inviteBinderDeps(
  clock: Clock,
  logger: RootLogger,
  db: Kysely<Database>,
  redis: RedisHandle,
  crypto: FieldCrypto,
  events: EventBus,
): InviteBinderDeps {
  return {
    clock,
    logger,
    redis,
    crypto,
    loginDevices: createInviteLoginDevicesReader(),
    activity: (trx) => createInviteBackfillActivityReader(trx),
    ...growthReadPorts(clock, crypto, events),
    inviteReward: inviteRewardQualifier(clock, logger, db, crypto),
  };
}

/**
 * BR-INV-24 ① (B1-35): growth's invite reward qualifier for the three self-service binding
 * channels, over config_items read on the binding transaction (a fresh content reader per call,
 * as growthReadPorts) and the field cipher's blind index of the bind IP. The binders call it after
 * the relation log, under their own savepoint.
 */
function inviteRewardQualifier(
  clock: Clock,
  logger: RootLogger,
  db: Kysely<Database>,
  crypto: FieldCrypto,
): InviteRewardQualifier {
  return createInviteRewardQualifier({
    db,
    clock,
    logger,
    crypto,
    config: transactionConfig(clock),
  });
}

/** content's config_items reader bound to the caller's transaction (fresh per call, uncached). */
function transactionConfig(clock: Clock): InviteBinderDeps['config'] {
  return {
    configValue: (appId, key, trx) =>
      createContentReader({ db: trx, clock }).configValue(appId, key),
  };
}

@Module({})
class InviteRewardWorkerModule {}

/**
 * The worker's invite reward scanner (B1-35 §9.2 第 9 条; BR-INV-24 ④ and 「有效期」): growth's
 * payout over orders' fact port, identity's login-device / login-IP / retained-phone / deletion
 * readers, risk's fresh state read and BR-ID-37 check (configuration through content's reader on
 * the judging transaction), and growth's daily expiry. Without a database, the field cipher or the
 * event bus the provider is null and entry.ts starts no loop.
 * TODO(规划/11 §2.3): grantWriter（REWARD 凭证写入） — blocked on B2-16b; until then every payout
 * is deferred with a warn (invite_reward_writer_unavailable), nothing is released or paid.
 */
function inviteRewardWorkerModule(): DynamicModule {
  return {
    module: InviteRewardWorkerModule,
    global: true,
    providers: [
      {
        provide: inviteRewardScannerToken(),
        inject: [
          CLOCK,
          ROOT_LOGGER,
          { token: DB, optional: true },
          { token: FIELD_CRYPTO, optional: true },
          { token: EVENT_BUS, optional: true },
        ],
        useFactory: (
          clock: Clock,
          logger: RootLogger,
          db?: Kysely<Database>,
          crypto?: FieldCrypto,
          events?: EventBus,
        ): InviteRewardScanner | null => {
          if (db === undefined || crypto === undefined || events === undefined) {
            logger.info(
              {
                db: db !== undefined,
                field_crypto: crypto !== undefined,
                event_bus: events !== undefined,
              },
              'invite_reward_worker_unassembled',
            );
            return null;
          }
          const reads = growthReadPorts(clock, crypto, events);
          const base = { db, clock, logger, config: transactionConfig(clock) };
          const orders = createInviteRewardOrderFacts();
          const payout = createInviteRewardPayout({
            ...base,
            orders,
            crypto,
            loginDevices: createInviteLoginDevicesReader(),
            loginIps: createInviteRewardLoginIpsReader(),
            deletedPhone: createInviteRewardDeletedPhoneReader(),
            deletionStatus: createUserDeletionStatusReader({ db }),
            readRisk: reads.readRisk,
            verifiedBirthDate: reads.verifiedBirthDate,
            multiAccount: createSameDeviceAccountsCheck({
              clock,
              logger,
              logins: createSameDeviceLoginReader(),
              config: (handle) => createContentReader({ db: handle, clock }),
            }),
          });
          return createInviteRewardScanner({
            db,
            clock,
            logger,
            payout,
            expiry: createInviteRewardExpiry({ ...base, orders }),
          });
        },
      },
    ],
    exports: [inviteRewardScannerToken()],
  };
}

/**
 * The reads growth's binding core (B1-11d) and invite page (B1-11j) share, each on the caller's
 * transaction (no second pooled connection while it is held) and uncached: config_items through
 * content's reader (a fresh reader per call, so the value is never older than the transaction),
 * risk's fresh state read, identity's realname reader (B1-13d) for the verified birth date —
 * the decrypted name is dropped here and the birth date never reaches a log or a response — and
 * identity's deletion-stage reader (B1-15c) for the one subject on the trx (absent → none). Every
 * growth channel is assembled from here: register and backfill (inviteBinderDeps), landing and the
 * invite page.
 */
function growthReadPorts(
  clock: Clock,
  crypto: FieldCrypto,
  events: EventBus,
): Pick<InviteBinderDeps, 'config' | 'readRisk'> &
  Required<Pick<InviteBinderDeps, 'verifiedBirthDate' | 'readDeletionStage'>> {
  const realname = createRealnameReader(crypto);
  return {
    config: {
      configValue: (appId, key, trx) =>
        createContentReader({ db: trx, clock }).configValue(appId, key),
    },
    readRisk: (trx, subject) =>
      createRiskStateService({ db: trx, clock, events }).readRiskState(subject, {
        fresh: true,
      }),
    verifiedBirthDate: async (trx, subject) =>
      (await realname.verified(trx, subject))?.birth_date ?? null,
    readDeletionStage: async (trx, subject) =>
      (
        await createDeletionStageReader({ db: trx }).read(trx, {
          appId: subject.app_id,
          userIds: [subject.user_id],
        })
      ).get(subject.user_id) ?? 'none',
  };
}

/**
 * growth's routes (B1-11e): POST /v1/me/inviter runs growth's binding core on the backfill channel
 * over the same dependencies as the register channel. Without a database, Redis, the field cipher
 * or the event bus there is no core and the route answers 50001.
 */
function growthModule(): DynamicModule {
  return GrowthModule.forRoot({
    inviteBinder: {
      inject: [
        CLOCK,
        ROOT_LOGGER,
        { token: DB, optional: true },
        { token: REDIS, optional: true },
        { token: FIELD_CRYPTO, optional: true },
        { token: EVENT_BUS, optional: true },
      ],
      useFactory: (
        clock: Clock,
        logger: RootLogger,
        db?: Kysely<Database>,
        redis?: RedisHandle,
        crypto?: FieldCrypto,
        events?: EventBus,
      ): InviteBinder | null => {
        if (
          db === undefined ||
          redis === undefined ||
          crypto === undefined ||
          events === undefined
        ) {
          logger.info(
            {
              route: '/v1/me/inviter',
              db: db !== undefined,
              redis: redis !== undefined,
              field_crypto: crypto !== undefined,
              event_bus: events !== undefined,
            },
            'invite_backfill_unassembled',
          );
          return null;
        }
        return createInviteBinder(inviteBinderDeps(clock, logger, db, redis, crypto, events));
      },
    },
    // GET /v1/invites/me (B1-11j): no Redis needed; without a database, the field cipher (realname
    // birth date) or the event bus (risk's reader) there is no read and the route answers 50001.
    myInvite: {
      inject: [
        CLOCK,
        ROOT_LOGGER,
        { token: DB, optional: true },
        { token: FIELD_CRYPTO, optional: true },
        { token: EVENT_BUS, optional: true },
      ],
      useFactory: (
        clock: Clock,
        logger: RootLogger,
        db?: Kysely<Database>,
        crypto?: FieldCrypto,
        events?: EventBus,
      ): MyInviteReader | null => {
        if (db === undefined || crypto === undefined || events === undefined) {
          logger.info(
            {
              route: '/v1/invites/me',
              db: db !== undefined,
              field_crypto: crypto !== undefined,
              event_bus: events !== undefined,
            },
            'my_invite_unassembled',
          );
          return null;
        }
        return createMyInviteReader({
          clock,
          logger,
          db,
          ...growthReadPorts(clock, crypto, events),
        });
      },
    },
  });
}

/**
 * F1-09g / F1-09j: the reads behind content's page audience facts, over linking's, identity's and
 * growth's exported read ports (content imports none of them).
 */
function pageAudienceReads(
  db: Kysely<Database>,
  config: ContentReader,
  appConfig: AppConfig,
  clock: Clock,
): PageAudienceReads {
  // Built on first use: entries and tests that never serve a page need no query builder here.
  let unionReads: UnionAuthReads | undefined;
  const reads = (): UnionAuthReads =>
    (unionReads ??= createUnionAuthReads({
      db: db.withSchema('app'),
      clock,
      config,
      appEnv: appConfig.appEnv,
      // binding() has no PID dependency. Refuse accidental use of an auth command here.
      pids: { getActivePid: () => Promise.reject(new Error('pages: binding projection only')) },
    }));
  const activity = createInviteBackfillActivityReader(db);
  // Built on first use, like the union reads above.
  let parentReader: ParentRelationReader | undefined;
  const parents = (): ParentRelationReader =>
    (parentReader ??= createParentRelationReader({ db: db.withSchema('app') }));
  return {
    unionBindingStatus: async (appId, userId, platform) =>
      (await reads().binding(appId, userId, platform)).status,
    orderCount: (appId, userId) => activity.orderCount({ appId, userId }),
    // F1-09j: growth's current-relation reader (B1-11n). No row in this app → no parent (false);
    // a read error propagates, and content turns it into an unknown fact with a warn.
    hasParent: async (appId, userId) =>
      (await parents().relationOf({ appId, userId }))?.has_parent ?? false,
  };
}

@Module({})
class IdentityMePortsModule {}

/**
 * GET /v1/me read ports: the guard's risk service and linking's binding projection. This global
 * assembly imports risk's export so identity needs no reverse module import into risk.
 */
function identityMePorts(risk: DynamicModule): DynamicModule {
  return {
    module: IdentityMePortsModule,
    global: true,
    imports: [risk],
    providers: [
      {
        provide: ME_READ_PORTS,
        inject: [APP_CONFIG, CLOCK, riskStateServiceToken(), { token: DB, optional: true }],
        useFactory: (
          appConfig: AppConfig,
          clock: Clock,
          riskState: RiskStateService | null,
          db?: Kysely<Database>,
        ): MeReadPorts | null => {
          if (db === undefined || riskState === null) return null;
          const reads = createUnionAuthReads({
            db: db.withSchema('app'),
            clock,
            config: createContentReader({ db, clock }),
            appEnv: appConfig.appEnv,
            // binding() has no PID dependency. Refuse accidental use of an auth command here.
            pids: { getActivePid: () => Promise.reject(new Error('me: binding projection only')) },
          });
          const walletDependencies = walletSummaryDependencies(db, clock);
          return {
            risk: riskState,
            activity: createInviteBackfillActivityReader(db),
            balance: {
              // B1-02zn (BR-FUND-18, ADD-06): the same query and owner ports as
              // GET /v1/wallet/summary, read only, by the token's app_id + user_id; a failed read
              // propagates (never zeros).
              async balanceOf(subject) {
                const summary = await getWalletSummary(
                  db,
                  { appId: subject.appId, userId: subject.userId },
                  walletDependencies,
                );
                return {
                  available_fen: summary.available_fen,
                  withdrawable_fen: summary.withdrawable_fen,
                  estimated_total_fen: summary.estimated_total_fen,
                };
              },
            },
            unionBindings: {
              async statusOf(subject, platform): Promise<MeUnionBindingStatus> {
                const { status } = await reads.binding(subject.appId, subject.userId, platform);
                switch (status) {
                  case 'unbound':
                  case 'pending_auth':
                  case 'active':
                  case 'invalid':
                  case 'released':
                  case 'blocked':
                    return status;
                  default:
                    throw new Error('me: invalid union binding status');
                }
              },
            },
          };
        },
      },
    ],
    exports: [ME_READ_PORTS],
  };
}

/** Synthetic config key of the demo quoter's rule (DemoQuoteRule); never a commission rule. */
const DEMO_QUOTE_RULE_KEY = 'demo.rebate_quote_rule';

/**
 * The quota of every governed union adapter of every entry (规划/02 §6.2; D10-446 ①): one bucket
 * per endpoint.quotaKey (app × platform), split by purpose with the MVP shares. The only place
 * these numbers live; CAP-*-12 change the numbers only.
 * TODO(规划/11 §4.5): 配额桶容量 — blocked on CAP-TB-12、CAP-JD-12、CAP-PDD-12 配额口径
 */
const UNION_QUOTA = { capacity: 100, refillPerSecond: 10, stage: 'mvp' } as const;

/**
 * B1-22v: the union quota bucket of one endpoint from the entry's one union quota source
 * (createUnionQuotaSource, built once in AppModule.forEntry): with REDIS the Redis token bucket
 * shared by api, stream and worker (one namespace, endpoint.quotaKey = app × platform) on the
 * entry's CLOCK, refused on a Redis failure (R-04); without REDIS the entry's single platform
 * fallback (D10-460: in-process buckets in local / test, every token refused in staging / prod).
 */
function unionQuota(
  endpoint: UnionEndpoint,
  deps: UnionQuotaDeps,
  source: UnionQuotaSource,
): QuotaLimiter {
  return source.limiter(
    {
      bucketKey: endpoint.quotaKey,
      capacity: UNION_QUOTA.capacity,
      refillPerSecond: UNION_QUOTA.refillPerSecond,
      shares: quotaShares(UNION_QUOTA.stage),
    },
    deps,
  );
}

/**
 * Every registered union adapter wrapped once by union's governance layer (规划/02 §6.2): one
 * breaker pair per platform for the whole process, so an outage seen by one request opens the
 * breaker for the next (B1-05j); the quota bucket of each platform is shared by every process
 * (B1-22v, unionQuota).
 */
function governedUnion(
  registry: UnionRegistry,
  endpoints: readonly UnionEndpoint[],
  quotaDeps: UnionQuotaDeps,
  source: UnionQuotaSource,
): GovernedUnion {
  const scheduler = systemScheduler();
  const adapters = new Map<RegisteredPlatform, UnionAdapter>();
  for (const platform of REGISTERED_PLATFORMS) {
    const endpoint = endpoints.find((entry) => entry.platform === platform);
    if (endpoint === undefined) continue;
    const quota = unionQuota(endpoint, quotaDeps, source);
    adapters.set(
      platform,
      createGovernedAdapter(registry.get(platform), { endpoint, scheduler, quota }),
    );
  }
  return {
    adapter(platform) {
      const adapter = adapters.get(platform);
      if (adapter === undefined) throw new Error(`union: no endpoint for ${platform}`);
      return adapter;
    },
  };
}

/** B1-09n: what the blacklist step reads of the worker entry; see orderSyncWorker. */
interface OrderSyncKeyring {
  readonly crypto: FieldCrypto | undefined;
  readonly appEnv: AppConfig['appEnv'];
  readonly logger: Pick<RootLogger, 'warn'>;
}

/** B1-09n: the entry's field keyring; undefined (step ③ skipped) only in local / test. */
export function orderBlacklistKeyring(entry: OrderSyncKeyring): FieldCrypto | undefined {
  if (entry.crypto !== undefined) return entry.crypto;
  if (entry.appEnv !== 'local' && entry.appEnv !== 'test') {
    throw new Error('orders: the blacklist step needs the field keyring outside local / test');
  }
  entry.logger.warn({ step: 'blacklist' }, 'order_blacklist_step_skipped');
  return undefined;
}

/** The app whose config_items rows hold order_sync.rescan.*; the config port takes no App. */
const ORDER_SYNC_APP_ID = 'couli';

/**
 * B1-08n: the worker's order-sync ports, assembled here so orders never imports identity or
 * linking: identity's attr_code → user reader, linking's relation_id binding reader, and the
 * quota bucket per platform of the worker's own governed adapters (`quota`, B1-22v: the shared
 * union bucket of unionQuota, the same bucket as the api's and the stream's; see orderSyncWorker).
 * B1-08q: the source backfill ports (orderSourcePorts).
 * B1-08w: commission's snapshot port (orderSnapshotPort) for step ⑥ and the compensation retry.
 * B1-08zc: ledger's recon diff registration as orders' platform-restore port (orderPlatformRestorePort).
 * B1-04zr: rescanConfig, content's config_items of ORDER_SYNC_APP_ID. Building it reads nothing;
 * every get reads again (a fresh content reader per call, so a changed row is seen on the next
 * round). An absent key is undefined, so orders' own defaults apply; a failed read propagates
 * unchanged, so the rescan skips the platform for that round instead of taking the default.
 * B1-09n: `rebate`, the entry's rebatePortFactory; `blocklist`, risk's order-side ports over the
 * entry's field keyring (`keyring` answers undefined only in local / test without one, and step ③
 * is then skipped); suffixVoidEnabled, content's attr.blacklist.order_suffix_void_enabled of the
 * order's App, anything but true being off (08's default; BR-ATTR-26).
 * B1-10n: `rightsImports`, what the rights_import job needs; see orderSyncWorker.
 * B1-04zza: `rightsSync`, settlement's rights.record for the refund / punishment sync; see
 * orderSyncWorker.
 */
function orderSyncPorts(
  union: DynamicModule,
  quota: OrdersWorkerOptions['quota'],
  keyring: () => FieldCrypto | undefined,
  rebate: OrderRebatePortFactory,
  rightsImports: NonNullable<OrdersWorkerOptions['rightsImports']>,
  rightsSync: NonNullable<OrdersWorkerOptions['rightsSync']>,
): OrdersWorkerOptions {
  return {
    union,
    users: (db) => createOrderUserReader(db),
    bindings: (db) => createOrderBindingReader(db),
    quota,
    sources: (db, clock, logger) => orderSourcePorts(db, clock, logger),
    snapshots: (db, clock, logger) => orderSnapshotPort(db, clock, logger),
    platformRestore: (clock) => orderPlatformRestorePort(clock),
    rebate,
    rightsImports,
    rightsSync,
    blocklist: (_db, clock) => {
      const crypto = keyring();
      return crypto === undefined ? undefined : createOrderBlocklistPorts({ clock, crypto });
    },
    suffixVoidEnabled: (db, clock) => async (appId) =>
      (
        await createContentReader({ db, clock }).configValue(
          appId,
          'attr.blacklist.order_suffix_void_enabled',
        )
      )?.value === true,
    rescanConfig: (db, clock) => ({
      get: async (key) =>
        (await createContentReader({ db, clock }).configValue(ORDER_SYNC_APP_ID, key))?.value,
    }),
  };
}

/**
 * B1-22v: OrdersModule.forWorker over orderSyncPorts, whose runtime provider additionally receives
 * the entry's CLOCK, ROOT_LOGGER and REDIS (orders' own module does not inject REDIS). They are
 * handed to the quota port just before the runtime is built (the runtime calls `quota` once per
 * endpoint while it is assembled), so the worker's buckets are the shared union buckets.
 * B1-09n: the provider also receives FIELD_CRYPTO and APP_CONFIG, for the blacklist step's keyring.
 * Outside local / test a missing keyring refuses the runtime (the worker does not start), the same
 * rule as linking's and agent's item_ref: production never loses step ③ silently. In local / test
 * without one the step is skipped with one warning line, as a config without keys is normal there.
 * B1-10n: the sync's rebate hook is the factory's port followed by the clawback's onUpdated: rebate
 * first (R9b copies the amount rows and totals of the new commission_version), because the clawback
 * reads the snapshot of the current version (D10-565). One clawback serves that hook and the rights
 * command of the rights_import job; both are built once, when the runtime is. The beneficiary gate
 * needs the field keyring: without one (local / test only, see above) neither is built, with one
 * warning line, and the settle worker does not run there either, so no order is credited.
 * B1-04zza: the refund / punishment sync gets its own rights command over the same clawback and
 * rebate port (undefined where the clawback is not built: no rights / punish timer there).
 */
function orderSyncWorker(
  union: DynamicModule,
  source: UnionQuotaSource,
  rebate: (assembly: OrderRebateAssembly) => ProductionRebatePort,
): DynamicModule {
  let entry: (UnionQuotaDeps & OrderSyncKeyring) | undefined;
  let wired:
    | { readonly port: ProductionRebatePort; readonly clawback: ClawbackOrder | undefined }
    | undefined;
  const wire = (assembly: OrderRebateAssembly) => {
    if (wired !== undefined) return wired;
    if (entry === undefined) throw new Error('orders: the clawback needs the worker entry');
    const port = rebate(assembly);
    if (entry.crypto === undefined) {
      entry.logger.warn({ step: 'clawback' }, 'order_clawback_skipped');
      wired = { port, clawback: undefined };
      return wired;
    }
    const clawback = orderClawback(assembly, entry.crypto);
    wired = {
      clawback,
      port: {
        ...port,
        onUpdated: async (trx, change, statusSource) => {
          await port.onUpdated(trx, change, statusSource);
          await clawback.onUpdated(trx, change, statusSource);
        },
      },
    };
    return wired;
  };
  const rightsImports: NonNullable<OrdersWorkerOptions['rightsImports']> = (assembly) => {
    const { port, clawback } = wire(assembly);
    if (clawback === undefined || entry === undefined) return undefined;
    const { clock, logger, events } = assembly;
    return {
      store: createImportStore({ appEnv: entry.appEnv, logger }),
      rights: createRightsCommandPort({
        clock,
        logger,
        events,
        clawback,
        rebate: port,
        audit: createSystemAuditWriter({ clock, sensitiveKeys: SENSITIVE_KEYS }),
      }),
    };
  };
  const rightsSync: NonNullable<OrdersWorkerOptions['rightsSync']> = (assembly) => {
    const { port, clawback } = wire(assembly);
    if (clawback === undefined) return undefined;
    const { clock, logger, events } = assembly;
    return createRightsCommandPort({
      clock,
      logger,
      events,
      clawback,
      rebate: port,
      audit: createSystemAuditWriter({ clock, sensitiveKeys: SENSITIVE_KEYS }),
    });
  };
  const keyring = (): FieldCrypto | undefined => {
    if (entry === undefined) throw new Error('orders: the blacklist step needs the worker entry');
    return orderBlacklistKeyring(entry);
  };
  const module = OrdersModule.forWorker(
    orderSyncPorts(
      union,
      (endpoint) => {
        if (entry === undefined) throw new Error('orders: union quota needs the worker entry');
        return unionQuota(endpoint, entry, source);
      },
      keyring,
      (assembly) => wire(assembly).port,
      rightsImports,
      rightsSync,
    ),
  );
  const runtime = orderSyncToken();
  return {
    ...module,
    providers: (module.providers ?? []).map((provider): Provider => {
      if (
        typeof provider !== 'object' ||
        provider.provide !== runtime ||
        !('useFactory' in provider)
      ) {
        return provider;
      }
      const inject = provider.inject ?? [];
      const build = provider.useFactory;
      return {
        provide: runtime,
        inject: [
          ...inject,
          CLOCK,
          ROOT_LOGGER,
          APP_CONFIG,
          { token: REDIS, optional: true },
          { token: FIELD_CRYPTO, optional: true },
        ],
        useFactory: (...args: unknown[]): unknown => {
          const [clock, logger, config, redis, crypto] = args.slice(inject.length) as [
            Clock,
            RootLogger,
            AppConfig,
            RedisHandle | undefined,
            FieldCrypto | undefined,
          ];
          entry = {
            clock,
            logger,
            redis: redis ?? undefined,
            crypto: crypto ?? undefined,
            appEnv: config.appEnv,
          };
          return build(...args.slice(0, inject.length));
        },
      };
    }),
  };
}

/**
 * B1-06zd (D10-510): the promotion link prefetch job on queue pool-refresh, whose one handler is
 * catalog's. Governed apart from the refresh's adapters: the quota bucket is shared, the breaker
 * is not, so a failing convert does not open the circuit on the refresh's reads.
 */
function promoPrefetchJobs(source: UnionQuotaSource): Provider {
  return {
    provide: POOL_EXTRA_JOBS,
    inject: [
      UNION_REGISTRY,
      UNION_ENDPOINTS,
      CLOCK,
      ROOT_LOGGER,
      { token: DB, optional: true },
      { token: REDIS, optional: true },
    ],
    useFactory: (
      registry: UnionRegistry,
      endpoints: readonly UnionEndpoint[],
      clock: Clock,
      logger: RootLogger,
      db?: Kysely<Database>,
      redis?: RedisHandle,
    ): PoolExtraJobs => {
      if (db === undefined) return new Map();
      const governed = governedUnion(registry, endpoints, { clock, logger, redis }, source);
      const handler = createPromoPrefetchHandler({
        db,
        clock,
        logger,
        registry: { get: (platform) => governed.adapter(platform) },
      });
      return new Map([[PROMO_PREFETCH_JOB, handler]]);
    },
  };
}

/**
 * B1-08zc: orders' platform-restore port (BR-FUND-22) — ledger's registerReconDiffOnce on the
 * caller's transaction (the order's lock transaction) with the worker's CLOCK; recon_diffs stays
 * ledger's table (04: registered through ledger's command). The input (type platform_restore,
 * source R1, ref_type order, keys) is built by orders and passed through unchanged; the result is
 * mapped to { inserted, id }. Building reads nothing.
 */
function orderPlatformRestorePort(clock: Clock): PlatformRestoreDiffPort {
  return {
    register: async (trx, input) => {
      const registration = await registerReconDiffOnce(trx, input, { clock });
      return { inserted: registration.inserted, id: registration.row.id };
    },
  };
}

/** The order read and fee rule of commission's estimates, for both ports below. */
const orderEstimateSource = {
  readOrder: (trx: Transaction<Database>, ref: { appId: string; orderId: string; attrAt: Date }) =>
    readOrder(trx, { app_id: ref.appId, order_id: ref.orderId, attr_at: ref.attrAt }),
};

/**
 * B1-08w: orders' commission snapshot port (BR-ATTR-01 ⑥, BR-CALC-10) — commission's
 * createCommissionSnapshotPort over the B2-03p beneficiary resolver (growth's level / parent
 * history, identity's users.status deletion reader), with the worker's CLOCK and ROOT_LOGGER. The
 * resolver and its two readers are built once here and shared by every call; building reads
 * nothing, and every read runs on the caller's transaction (the order's lock transaction).
 * B2-03q (D10-568): the return type keeps refresh required; without it a created snapshot would
 * leave the order at version 0 or without rows of its current version, and nothing would throw.
 */
export function orderSnapshotPort(
  db: Kysely<Database>,
  clock: Clock,
  logger: RootLogger,
): CommissionOrderSnapshotPort {
  const beneficiaries = createSnapshotBeneficiaryResolver({
    growth: createGrowthHistory({ logger }),
    deletion: createUserDeletionStatusReader({ db }),
  });
  return createCommissionSnapshotPort({
    clock,
    logger,
    beneficiaries,
    ...orderEstimateSource,
  });
}

/** B1-10n: the sync's hooks plus the R6 / R7 command of the rights command. */
type ProductionRebatePort = ReturnType<OrderRebatePortFactory> & Pick<RebatePort, 'apply'>;

/**
 * B1-10n: settlement's post-credit clawback (R8 / R9 / R9b) on the worker, over the same owners'
 * exports as the settle handler's credit. Building it reads nothing. orders' own pending port takes
 * CLAWBACK_NO_COMMISSION. config.get takes no transaction, as in rebatePortFactory.
 */
function orderClawback(assembly: OrderRebateAssembly, crypto: FieldCrypto): ClawbackOrder {
  const { db, clock, logger, events } = assembly;
  return createClawbackOrder({
    clock,
    logger,
    events,
    // D10-587: the bus publishes account.went_negative, the hook lifts NEGATIVE_BALANCE.
    ledger: createLedger({
      clock,
      eventBus: events,
      balanceRecoveredHook: createBalanceRecoveredHook({ clock }),
    }),
    gate: createBeneficiaryGate({
      clock,
      lockUsers: lockUsersForUpdate,
      deletionStatus: createUserDeletionStatusReader({ db }),
      realnameStatus: createRealnameStatusBatchReader({ db }),
      riskState: createRiskStateBatchReader({ db }),
      minors: createMinorStatusBatchReader({ crypto }),
    }),
    readSnapshot: readCommissionSnapshot,
    // commission's writer takes the clock as its third argument, as in the settle handler.
    appendBeneficiaryEvent: (trx, input) => appendBeneficiaryEvent(trx, input, { clock }),
    pending: createClawbackPendingPort({ clock }),
    config: {
      get: async (appId, key) =>
        (await createContentReader({ db, clock }).configValue(appId, key))?.value,
    },
  });
}

/**
 * B1-09n (D10-548, D10-550, FU-REBATE-PORT-WIRING): the production rebate port. One factory per
 * entry (AppModule.forEntry): its first call builds settlement's port, every later call returns
 * that instance whatever it is given, so the order sync and B1-10n's rights port share one.
 * Building reads nothing.
 * - estimates: commission's port over the same order read and fee rule as orderSnapshotPort.
 * - audit: admin's system audit on the caller's transaction (commits and rolls back with the hold).
 * - config: content's config_items, read again on every call on `db`: the port's config.get takes
 *   no transaction, so like the sync's source ports it uses a second pool connection.
 * - onBlacklistHit: settlement has no such method. Its apply with BLACKLIST_HIT is R6 from
 *   UNATTRIBUTED, ESTIMATED and WAITING, decided before any base is read, so the amounts stay null.
 *   orders calls it only for an uncredited order; a credited one gets the review event from orders
 *   and no amount changes (BR-ATTR-26).
 */
export function rebatePortFactory(): (assembly: OrderRebateAssembly) => ProductionRebatePort {
  let port: ProductionRebatePort | undefined;
  return ({ db, clock, logger, events }) => {
    if (port !== undefined) return port;
    const rebate = createRebatePort({
      clock,
      logger,
      events,
      config: {
        get: async (appId, key) =>
          (await createContentReader({ db, clock }).configValue(appId, key))?.value,
      },
      estimates: createCommissionEstimates({ clock, ...orderEstimateSource }),
      audit: createSystemAuditWriter({ clock, sensitiveKeys: SENSITIVE_KEYS }),
    });
    port = {
      ...rebate,
      onBlacklistHit: (trx, hit) =>
        rebate.apply(
          trx,
          {
            appId: hit.app_id,
            orderId: hit.order_id,
            attrAt: hit.attr_at,
            estBefore: null,
            estAfter: null,
            settleCommissionFen: null,
          },
          'BLACKLIST_HIT',
        ),
    };
    return port;
  };
}

/**
 * B1-10c: the claim evidence ports over the acceptance transaction — linking's raw reads, and the
 * BR-PROD-03 product key of an order whose product_key column is empty: catalog's platforms row
 * gives key_prefix, raw_item_id is the taobao item_id or the pdd goods_id (待裁定 2); other
 * platforms, a missing prefix or an underivable id give null (that item is weak at best). A read
 * error of either rejects (the acceptance rolls back, 50001).
 */
const claimEvidencePorts: ClaimEvidenceFactory = (trx, clock) => {
  const catalog = createCatalog({ db: trx, clock, warn: () => undefined });
  return {
    reads: createClaimEvidenceReader(trx),
    deriveProductKey: async ({ platform, raw_item_id }) => {
      const payload: UnionProductPayload | null =
        platform === 'taobao'
          ? { item_id: raw_item_id }
          : platform === 'pdd'
            ? { goods_id: raw_item_id }
            : null;
      if (payload === null) return null;
      const row = (await catalog.listPlatforms()).find((entry) => entry.code === platform);
      try {
        return deriveProductKey({ platform, keyPrefix: row?.key_prefix ?? null }, payload);
      } catch (error) {
        if (error instanceof ProductKeyUnderivable) return null;
        throw error;
      }
    },
  };
};
/**
 * B1-03zd: risk's appeal console read ports — identity's masked phones (decrypted and masked inside
 * identity, BR-ID-33), its BR-ID-05 normaliser and the accounts holding a phone blind index now
 * (users.phone_hmac), admin's display names and orders' sub-order numbers. Every read is scoped by
 * app_id; building them reads nothing.
 */
function adminAppealReadPorts(db: Kysely<Database>, crypto: FieldCrypto): AdminAppealsReadPorts {
  const phones = createMaskedPhoneReader(db, crypto);
  const names = createAdminDisplayNameReader(db);
  return {
    maskedPhones: (appId, userIds) => phones.maskedPhones(appId, userIds),
    adminNames: (appId, adminIds) => names.displayNames(appId, adminIds),
    async subOrderNos(appId, orderIds) {
      const result = new Map<string, string>();
      if (orderIds.length === 0) return result;
      const rows = await db
        .withSchema('app')
        .selectFrom('orders')
        .select(['order_id', 'sub_order_id'])
        .where('app_id', '=', appId)
        .where('order_id', '=', sql<string>`ANY(${[...new Set(orderIds)]}::uuid[])`)
        .execute();
      for (const row of rows) result.set(row.order_id, row.sub_order_id);
      return result;
    },
    async usersByPhoneHmac(appId, phoneHmac) {
      const rows = await db
        .withSchema('app')
        .selectFrom('users')
        .select('id')
        .where('app_id', '=', appId)
        .where('phone_hmac', '=', phoneHmac)
        .execute();
      return rows.map((row) => row.id);
    },
    normalizePhone(input) {
      const normalized = normalize_phone(input);
      return normalized.code === 0 ? normalized.phone : null;
    },
  };
}
/**
 * B1-03ze: risk's appeal console write port — the owner of a sub-order of this app whose rebate
 * risk control voided (rebate_status VOID, reason BLACKLIST; BR-ATTR-26), the order target of a
 * registered appeal. Building it reads nothing.
 */
function adminAppealWritePorts(db: Kysely<Database>): AdminAppealsWritePorts {
  return {
    async voidedOrderOwner(appId, orderId) {
      const row = await db
        .withSchema('app')
        .selectFrom('orders')
        .select('user_id')
        .where('app_id', '=', appId)
        .where('order_id', '=', orderId)
        .where('rebate_status', '=', 'VOID')
        .where('reason', '=', 'BLACKLIST')
        .executeTakeFirst();
      return row?.user_id ?? null;
    },
  };
}
/**
 * B1-10j: orders' console claim review ports — identity's masked phones (BR-ID-33, decrypted and
 * masked inside identity; without the field cipher a phone read fails closed), admin's reviewer
 * display names and linking's link_logs time and scene. Building them reads nothing.
 */
function adminClaimPorts(db: Kysely<Database>, crypto: FieldCrypto | null): AdminClaimPorts {
  const phones = createMaskedPhoneReader(db, crypto);
  const names = createAdminDisplayNameReader(db);
  const links = createLinkLogMomentReader(db);
  return {
    phones: (appId, userIds) => phones.maskedPhones(appId, userIds),
    reviewerNames: (appId, adminIds) => names.displayNames(appId, adminIds),
    linkMoments: (appId, ids) => links.moments(appId, ids),
  };
}
/**
 * B1-10i: orders' console order reads (GET /admin/v1/orders, /admin/v1/orders/{order_id}):
 * identity's masked phones, admin's latest order_hold audit and display names, the commission
 * snapshot (commission_splits, as stored: commission exports no plain snapshot reader that needs
 * no amount version), the link's link_logs time, event and scene (the 50 newest, records without
 * a scene left out; linking exports no reader by link_id) and content's credit.enabled.<platform>.
 * Every read is scoped by app_id; building them reads nothing.
 */
function adminOrderPorts(
  db: Kysely<Database>,
  crypto: FieldCrypto | null,
  clock: Clock,
): AdminOrderPorts {
  const phones = createMaskedPhoneReader(db, crypto);
  const names = createAdminDisplayNameReader(db);
  const holds = createOrderHoldAuditReader(db);
  return {
    phones: (appId, userIds) => phones.maskedPhones(appId, userIds),
    adminNames: (appId, adminIds) => names.displayNames(appId, adminIds),
    latestHold: (appId, orderId) => holds.latestHold(appId, orderId),
    async commissionSplit(appId, orderId) {
      const row = await db
        .withSchema('app')
        .selectFrom('commission_splits')
        .select([
          'rule_version_id',
          'order_type',
          'raw_n_fen',
          'subsidy_commission_fen',
          'reserve_bp',
          'reserve_fen',
          'tlj_deduct_fen',
          'base_fen',
          'platform_retain_fen',
          'beneficiaries',
          'created_at',
        ])
        .where('app_id', '=', appId)
        .where('order_id', '=', orderId)
        .executeTakeFirst();
      return row ?? null;
    },
    async linkLogs(appId, linkId, limit) {
      return db
        .withSchema('app')
        .selectFrom('link_logs')
        .select(['created_at as at', 'event', 'scene'])
        .where('app_id', '=', appId)
        .where('link_id', '=', linkId)
        .where('scene', 'is not', null)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
    },
    async creditEnabled(appId, platform) {
      const entry = await createContentReader({ db, clock }).configValue(
        appId,
        `credit.enabled.${platform}`,
      );
      return entry?.value === true;
    },
    figures: orderFiguresReader(db, clock),
  };
}
/**
 * B1-10m: the real ports of the console's order and claim writes — admin's audit writer on the
 * write's transaction and its permission keys, settlement's attribution (R3 / R3b) and hold (R11)
 * commands, risk's state and identity's deletion stage of an assignment's target on the write's
 * transaction, and the snapshot and source ports the sync uses. pidSceneOn reads union_pids by
 * (app_id, platform, pid), unique across the app (orders carry no union_account_id; union exports
 * no reader without it) and with every status counted, the pipeline's rule (BR-ATTR-02): a retired
 * taolijin slot still gives its scene, else the order would be priced as a plain rebate
 * (BR-CALC-19). Building them reads nothing. Every read of an attribution runs on its transaction
 * (settle.period_basis, the source ports, the slot's scene): holding the order's locks it never
 * waits for a second connection, so concurrent writes cannot exhaust the admin pool and hang.
 */
function adminOrderWritePorts(
  db: Kysely<Database>,
  clock: Clock,
  logger: RootLogger,
): AdminOrderWritePorts {
  const profiles = createAdminProfiles({ db });
  const attributionOn = (trx: Transaction<Database>) =>
    createAttributionRebatePort({
      logger,
      config: {
        get: async (appId, key) =>
          (await createContentReader({ db: trx, clock }).configValue(appId, key))?.value,
      },
    });
  return {
    auditOn: (trx) => createAuditWriter({ db: trx, clock, sensitiveKeys: SENSITIVE_KEYS }),
    attribution: {
      onClaimApproved: (trx, input) => attributionOn(trx).onClaimApproved(trx, input),
      onAdminAssigned: (trx, input) => attributionOn(trx).onAdminAssigned(trx, input),
    },
    hold: { rebate: createRebateAdminCommandPort({ clock, logger }) },
    targets: {
      risk: {
        read: (executor, input) =>
          createRiskStateBatchReader({ db: executor }).read(executor, input),
      },
      deletion: {
        read: (executor, input) =>
          createDeletionStageReader({ db: executor }).read(executor, input),
      },
    },
    permissions: (appId, adminId) => profiles.permissionKeys(appId, adminId),
    snapshots: orderSnapshotPort(db, clock, logger),
    sourcesOn: (trx) => orderSourcePorts(trx, clock, logger),
    pidSceneOn: (trx) => async (order) => {
      if (order.pid === null || order.pid === '') return null;
      const row = await trx
        .withSchema('app')
        .selectFrom('union_pids')
        .select('pid_scene')
        .where('app_id', '=', order.app_id)
        .where('platform', '=', order.platform)
        .where('pid', '=', order.pid)
        .executeTakeFirst();
      return row?.pid_scene ?? null;
    },
  };
}

/**
 * B1-08q: orders' source backfill ports (BR-ATTR-15) over linking's link_logs reader, catalog's
 * platforms (key_prefix) and content's config_items. Building them reads nothing; every call
 * reads again (a fresh content reader per call, so a changed config_items row is seen at once;
 * listPlatforms reads the table on every call). Read failures propagate unchanged.
 */
function orderSourcePorts(
  db: Kysely<Database>,
  clock: Clock,
  logger: RootLogger,
): OrderSourcePorts {
  const logs = createOrderSourceReader(db);
  const catalog = createCatalog({
    db,
    clock,
    warn: (event: CatalogWarning) => {
      logger.warn(
        { event: `catalog_${event.kind}`, product_key: event.key },
        'product_key alias chain not resolved',
      );
    },
  });
  return createOrderSourcePorts({
    linkLogs: (input) => logs.linkLogs(input),
    linkByCode: (input) => logs.linkByCode(input),
    keyPrefix: async (platform) =>
      (await catalog.listPlatforms()).find((row) => row.code === platform)?.key_prefix ?? null,
    configValue: (appId, key) => createContentReader({ db, clock }).configValue(appId, key),
  });
}

/** The strongest union mode configured: one live endpoint makes the whole process live. */
function unionModeOf(endpoints: readonly UnionEndpoint[]): UnionMode {
  if (endpoints.some((entry) => entry.mode === 'live')) return 'live';
  return endpoints.some((entry) => entry.mode === 'replay') ? 'replay' : 'demo';
}

const UNAVAILABLE_QUOTE_CONFIG: CatalogConfigReader = {
  configValue: () => Promise.reject(new Error('quoter: no database handle in this process')),
};

/** The quoter's configuration reader: one per process, shared with the open's pre-reads. */
const QUOTE_CONFIG = Symbol('QUOTE_CONFIG');

/**
 * Every key the demo quoter reads (card-assembler.ts: its rule and the tech fee; since D10-641 no
 * quote reads the taobao compare ratio). An open pre-reads them before its transaction (B1-06m); a
 * key missing here fails that open's re-check closed instead of borrowing a second connection. The
 * commission quoter's keys are its own COMMISSION_QUOTE_CONFIG_KEYS.
 */
const DEMO_QUOTE_KEYS = [DEMO_QUOTE_RULE_KEY, 'tech_fee_bp'] as const;

/** The process quoter and the pre-reads an open makes for it (LINK_OPEN_PORTS.quoteReads). */
interface QuoterWiring {
  readonly quoter: RebateQuoter;
  readonly quoteReads: LinkOpenQuoteReads;
}

const QUOTER_WIRING = Symbol('QUOTER_WIRING');

/**
 * B2-03d: the commission rule versions as an open sees them. Outside an open every call reads
 * straight through (the quoter selects at its own quote instant). Inside an open the read is
 * memoized per app by the open's scope, and cut at the open's own pre-read instant (the Clock
 * read before the port, each open anew): a version that only becomes effective after that
 * instant is invisible for the whole open, so a future version revoked after the pre-read can
 * never be quoted from (BR-CALC-11, BR-CALC-20); the quoter then selects the latest version in
 * force from what is left.
 */
function openScopedRules(rules: RuleSetReader, clock: Clock): RuleSetReader {
  return {
    publishedVersions: (appId) =>
      openScopedReader(rules, JSON.stringify([appId]), 'commission rule versions', async () => {
        if (!inOpenReads()) return rules.publishedVersions(appId);
        const at = clock.now().getTime();
        const versions = await rules.publishedVersions(appId);
        return versions.filter((version) => version.effective_from.getTime() <= at);
      }),
  };
}

/** B2-03d: user levels, memoized per (app, user) inside an open; read through elsewhere. */
function openScopedLevels(levels: UserLevelReader): UserLevelReader {
  return {
    levelOf: (subject) =>
      openScopedReader(levels, JSON.stringify([subject.appId, subject.userId]), 'user level', () =>
        levels.levelOf({ appId: subject.appId, userId: subject.userId }),
      ),
  };
}

/** The non-guest viewers an open may quote for: the caller and every owner identity. */
function planUsers(plan: LinkOpenReadPlan): string[] {
  const users = new Set<string>();
  if (plan.callerUserId !== null) users.add(plan.callerUserId);
  for (const identity of plan.identities) {
    if (identity.userId !== null) users.add(identity.userId);
  }
  return [...users];
}

/**
 * B2-03d (BR-CALC-20): the process RebateQuoter. APP_ENV=prod or any live union endpoint takes
 * commission's real quoter over the rule versions, user levels and quote configuration, each
 * wrapped in the open's read scope; it needs the database handle and refuses to start without
 * one (never the demo quoter instead). Every other environment keeps the demo quoter.
 * The real quoter is stateless (live only, B2-03n), so concurrent opens and search cards never
 * answer for each other. An open's pre-reads go through the wrapped ports (the
 * AsyncLocalStorage scope of link-open-reads.ts), so inside an open's transaction the quoter
 * answers only from them and outside an open it reads straight through. Pre-read failures are settled and surface where
 * the transaction reads them (B1-06m).
 */
function assembleQuoter(
  config: AppConfig,
  endpoints: readonly UnionEndpoint[],
  quoteConfig: CatalogConfigReader,
  clock: Clock,
  db?: Kysely<Database>,
): QuoterWiring {
  if (config.appEnv !== 'prod' && unionModeOf(endpoints) !== 'live') {
    return {
      quoter: createDemoRebateQuoter({
        appEnv: config.appEnv,
        unionMode: unionModeOf(endpoints),
        config: quoteConfig,
        ruleConfigKey: DEMO_QUOTE_RULE_KEY,
      }),
      quoteReads: {
        prepare: async (plan) => {
          await Promise.allSettled(
            DEMO_QUOTE_KEYS.map((key) => quoteConfig.configValue(plan.appId, key)),
          );
        },
      },
    };
  }
  if (db === undefined) {
    throw new Error(
      'quoter: the commission rebate quoter (prod or a live union endpoint) needs a database handle',
    );
  }
  const rules = openScopedRules(createRuleSetReader({ db }), clock);
  const levels = openScopedLevels(createUserLevelReader({ db }));
  const quoter = createCommissionRebateQuoter({ rules, levels, config: quoteConfig, clock });
  return {
    quoter,
    quoteReads: {
      prepare: async (plan) => {
        const { appId } = plan;
        await Promise.allSettled([
          rules.publishedVersions(appId),
          ...planUsers(plan).map((userId) => levels.levelOf({ appId, userId })),
          ...COMMISSION_QUOTE_CONFIG_KEYS.map((key) => quoteConfig.configValue(appId, key)),
        ]);
      },
    },
  };
}

/**
 * Jump paths verified per platform and client for prod (B1-06e fund review S2): none yet, so a
 * prod open hands out no jump and answers 50301; non-prod hands out the default matrix.
 * TODO(规划/11 §4.5): 按实测登记已验证的外跳路径 — blocked on CAP-JD-11、CAP-PDD-11
 */
const VERIFIED_JUMP_PATHS: LinkOpenPorts['verifiedPaths'] = {};

/** parseUrl resolves and derives only; it never assembles a card (B1-07a), so none is given. */
const NO_PARSE_CARDS: CatalogCardEntry = {
  assemble: () => Promise.reject(new Error('linking: the by-URL port assembles no card')),
};

/**
 * B1-15w: the share's ports — identity's realname reader for the verified birth date (BR-INV-19 /
 * BR-ID-26); the decrypted name is dropped here and the birth date never reaches a log.
 */
function sharePorts(db: Kysely<Database>, crypto: FieldCrypto): LinkSharePorts {
  const realname = createRealnameReader(crypto);
  return {
    verifiedBirthDate: async (appId, userId) =>
      (await realname.verified(db, { app_id: appId, user_id: userId }))?.birth_date ?? null,
  };
}

/**
 * B1-06i: the convert's ports — catalog over the database handle, the item_ref service of the
 * open, and parsing's by-URL port (parseUrl over content's configuration reader and the same
 * governed adapters), so linking imports neither catalog's providers nor parsing.
 */
function convertPorts(
  db: Kysely<Database>,
  clock: Clock,
  logger: RootLogger,
  union: GovernedUnion,
  itemRefs: LinkConvertPorts['itemRefs'],
): LinkConvertPorts {
  const products = createCatalog({
    db,
    clock,
    warn: (event: CatalogWarning) => {
      logger.warn(
        { event: `catalog_${event.kind}`, product_key: event.key },
        'product_key alias chain not resolved',
      );
    },
  });
  const config = createContentReader({ db, clock });
  return {
    products,
    itemRefs,
    urlParser: {
      parseUrl: (url, context) =>
        parseUrl(
          {
            config,
            catalog: products,
            cards: NO_PARSE_CARDS,
            clock,
            getGovernedAdapter: (platform) => union.adapter(platform),
            logger,
          },
          url,
          context,
        ),
    },
  };
}

/**
 * B1-05q: the product pool's add resolves a link or token as parseInput does: parsing's candidates,
 * parseUrl and parseToken over content's configuration reader, with the union calls catalog passes
 * (it keeps a key whose detail is refused). No card is assembled, no link registered.
 */
function poolLinkParser(db: Kysely<Database>, clock: Clock, logger: RootLogger): PoolLinkParser {
  const config = createContentReader({ db, clock });
  const catalog = createCatalog({
    db,
    clock,
    warn: (event: CatalogWarning) => {
      logger.warn(
        { event: `catalog_${event.kind}`, product_key: event.key },
        'product_key alias chain not resolved',
      );
    },
  });
  return {
    candidates: extractCandidates,
    parse: async (candidate, getGovernedAdapter, context) => {
      const options = {
        config,
        catalog,
        cards: NO_PARSE_CARDS,
        clock,
        getGovernedAdapter,
        logger,
      };
      try {
        const product =
          candidate.kind === 'tpwd'
            ? await parseToken(options, candidate.raw, context)
            : await parseUrl(options, candidate.raw, context);
        return { ok: true, ...product };
      } catch (error: unknown) {
        if (error instanceof ParsingError) return { ok: false, code: error.code };
        throw error;
      }
    },
  };
}

@Module({})
class CatalogAdminPortsModule {}

/**
 * B1-05q: the admin entry's union ports for the product pool: the same governed adapters (shared
 * quota source) and quoter assembly as catalogPorts, without linking: the console registers no link.
 */
function catalogAdminPorts(union: DynamicModule, source: UnionQuotaSource): DynamicModule {
  return {
    module: CatalogAdminPortsModule,
    imports: [union],
    providers: [
      {
        provide: GovernedUnion,
        inject: [
          UNION_REGISTRY,
          UNION_ENDPOINTS,
          CLOCK,
          ROOT_LOGGER,
          { token: REDIS, optional: true },
        ],
        useFactory: (
          registry: UnionRegistry,
          endpoints: readonly UnionEndpoint[],
          clock: Clock,
          logger: RootLogger,
          redis?: RedisHandle,
        ): GovernedUnion => governedUnion(registry, endpoints, { clock, logger, redis }, source),
      },
      {
        provide: QUOTE_CONFIG,
        inject: [CLOCK, { token: DB, optional: true }],
        useFactory: (clock: Clock, db?: Kysely<Database>): CatalogConfigReader =>
          db === undefined ? UNAVAILABLE_QUOTE_CONFIG : createContentReader({ db, clock }),
      },
      {
        provide: RebateQuoter,
        inject: [APP_CONFIG, UNION_ENDPOINTS, QUOTE_CONFIG, CLOCK, { token: DB, optional: true }],
        useFactory: (
          config: AppConfig,
          endpoints: readonly UnionEndpoint[],
          quoteConfig: CatalogConfigReader,
          clock: Clock,
          db?: Kysely<Database>,
        ): RebateQuoter => assembleQuoter(config, endpoints, quoteConfig, clock, db).quoter,
      },
    ],
    exports: [GovernedUnion, RebateQuoter],
  };
}

@Module({})
class CatalogWorkerPortsModule {}

/** B1-05r: the worker entry's governed adapters for the pool refresh (shared quota source). */
function catalogWorkerPorts(union: DynamicModule, source: UnionQuotaSource): DynamicModule {
  return {
    module: CatalogWorkerPortsModule,
    imports: [union],
    providers: [
      {
        provide: GovernedUnion,
        inject: [
          UNION_REGISTRY,
          UNION_ENDPOINTS,
          CLOCK,
          ROOT_LOGGER,
          { token: REDIS, optional: true },
        ],
        useFactory: (
          registry: UnionRegistry,
          endpoints: readonly UnionEndpoint[],
          clock: Clock,
          logger: RootLogger,
          redis?: RedisHandle,
        ): GovernedUnion => governedUnion(registry, endpoints, { clock, logger, redis }, source),
      },
      promoPrefetchJobs(source),
    ],
    exports: [GovernedUnion, POOL_EXTRA_JOBS],
  };
}

@Module({})
class CatalogPortsModule {}

/**
 * Global providers of catalog's search ports, assembled here so catalog and linking never import
 * each other (no forwardRef):
 * - GovernedUnion: union adapters wrapped once per process (also for later parsing wiring);
 * - LinkRegistrar: linking's card registration in the search scene (BR-PRICE-12), per request;
 * - RebateQuoter: commission's real quoter under APP_ENV=prod or any live union endpoint (it
 *   needs the database handle), the demo quoter (synthetic rule values) elsewhere; one process
 *   quoter shared by search, detail, parse cards and the open (assembleQuoter, B2-03d);
 * - LINK_OPEN_PORTS: linking's open (B1-06w) — the same governed adapters and quoter, an
 *   item_ref issuer, contracts/apps.json and the prod-verified jump paths; and the convert's
 *   catalog, item_ref verifier and parsing's by-URL port (B1-06i);
 * - LINK_LANDING_PORTS: linking's landing card (B1-06j) — catalog's read-only product port
 *   (product_refs, else one detail on the same governed adapters; never a write or conversion);
 * - the linking module itself is re-exported, so its SourceLinkReader is visible to catalog.
 */
function catalogPorts(
  union: DynamicModule,
  linking: DynamicModule,
  source: UnionQuotaSource,
): DynamicModule {
  return {
    module: CatalogPortsModule,
    global: true,
    imports: [union, linking],
    providers: [
      {
        provide: GovernedUnion,
        inject: [
          UNION_REGISTRY,
          UNION_ENDPOINTS,
          CLOCK,
          ROOT_LOGGER,
          { token: REDIS, optional: true },
        ],
        useFactory: (
          registry: UnionRegistry,
          endpoints: readonly UnionEndpoint[],
          clock: Clock,
          logger: RootLogger,
          redis?: RedisHandle,
        ): GovernedUnion => governedUnion(registry, endpoints, { clock, logger, redis }, source),
      },
      {
        provide: LinkRegistrar,
        inject: [LINK_REGISTRATIONS],
        useFactory: (registrations: LinkRegistrations): LinkRegistrar => {
          const registration = registrations.forContext({ scene: 'search' });
          return { register: (input: RegisterLinkInput) => registration.register(input) };
        },
      },
      {
        // Inside an open it answers only from the open's pre-reads; elsewhere it reads through.
        provide: QUOTE_CONFIG,
        inject: [CLOCK, { token: DB, optional: true }],
        useFactory: (clock: Clock, db?: Kysely<Database>): CatalogConfigReader =>
          db === undefined
            ? UNAVAILABLE_QUOTE_CONFIG
            : openScopedConfig(createContentReader({ db, clock })),
      },
      {
        provide: QUOTER_WIRING,
        inject: [APP_CONFIG, UNION_ENDPOINTS, QUOTE_CONFIG, CLOCK, { token: DB, optional: true }],
        useFactory: assembleQuoter,
      },
      {
        provide: RebateQuoter,
        inject: [QUOTER_WIRING],
        useFactory: (wiring: QuoterWiring): RebateQuoter => wiring.quoter,
      },
      {
        provide: LINK_OPEN_PORTS,
        inject: [
          GovernedUnion,
          QUOTER_WIRING,
          APP_CONFIG,
          CLOCK,
          ROOT_LOGGER,
          { token: FIELD_CRYPTO, optional: true },
          { token: DB, optional: true },
        ],
        useFactory: (
          union: GovernedUnion,
          wiring: QuoterWiring,
          config: AppConfig,
          clock: Clock,
          logger: RootLogger,
          crypto?: FieldCrypto,
          db?: Kysely<Database>,
        ): LinkOpenPorts => {
          if (crypto === undefined && config.appEnv !== 'local' && config.appEnv !== 'test') {
            throw new Error('linking: item_ref needs the field keyring outside local / test');
          }
          // The re-checked card's item_ref is never sent by an open; it is issued as for any card.
          // The convert verifies the tapped card's token with the same keyring (BR-PROD-11).
          const itemRefs = createItemRefService({ crypto: crypto ?? processItemRefCipher() });
          return {
            union,
            quoter: wiring.quoter,
            itemRefs,
            quoteReads: wiring.quoteReads,
            apps: loadLinkOpenApps(),
            verifiedPaths: VERIFIED_JUMP_PATHS,
            ...(db === undefined
              ? {}
              : { convert: convertPorts(db, clock, logger, union, itemRefs) }),
            // B1-15w: POST /v1/shares reads the verified birth date (BR-INV-19) through identity's
            // realname reader; without the field keyring it cannot, and every share fails closed.
            ...(db === undefined || crypto === undefined ? {} : { shares: sharePorts(db, crypto) }),
          };
        },
      },
      {
        provide: LINK_LANDING_PORTS,
        inject: [
          GovernedUnion,
          CLOCK,
          { token: DB, optional: true },
          { token: REDIS, optional: true },
        ],
        useFactory: (
          union: GovernedUnion,
          clock: Clock,
          db?: Kysely<Database>,
          redis?: RedisHandle,
        ): LinkLandingPorts =>
          db === undefined
            ? {
                // No database handle: no product_refs and no jd mode, so no product fields.
                products: {
                  read: () =>
                    Promise.resolve({ title: null, image: null, shopName: null, shopType: null }),
                },
              }
            : {
                // B1-05g: the union fallback reads through the shared detail cache.
                products: createDbCatalogProductReader({
                  db,
                  union,
                  config: createContentReader({ db, clock }),
                  clock,
                  cache: redis === undefined ? null : redis.namespace(PRODUCT_CACHE_NAMESPACE),
                }),
              },
      },
    ],
    exports: [
      GovernedUnion,
      LinkRegistrar,
      RebateQuoter,
      LINK_OPEN_PORTS,
      LINK_LANDING_PORTS,
      linking,
    ],
  };
}

/**
 * Parsing's card-time link registration (POST /v1/inputs/parse, B1-07b): linking's per-request
 * registration in the request's entry scene (clipboard / search / share_ext), assembled here so
 * parsing never imports linking. Global beside catalogPorts, whose linking export it uses.
 * ViewerContext (B1-07c) is identity's request identity, as for search and detail, so the route's
 * cards are quoted and registered for the request's viewer.
 */
@Module({})
class ParsingPortsModule {}

function parsingPorts(): DynamicModule {
  return {
    module: ParsingPortsModule,
    global: true,
    providers: [
      {
        provide: ParsingLinkRegistrars,
        inject: [LINK_REGISTRATIONS],
        useFactory: (registrations: LinkRegistrations): ParsingLinkRegistrars => ({
          forScene(scene: ParseScene): LinkRegistrar {
            const registration = registrations.forContext({ scene });
            return { register: (input: RegisterLinkInput) => registration.register(input) };
          },
        }),
      },
      { provide: ViewerContext, ...identityViewer },
    ],
    exports: [ParsingLinkRegistrars, ViewerContext],
  };
}

/** Agent search pages: the tool's page size when it gives none (the tool always gives one). */
const AGENT_SEARCH_PAGE_SIZE = 20;

/** B3-03n: a search card's product reference comes from a served search (BR-PROD-10). */
const AGENT_SEARCH_REF_CAPABILITIES: ProductCapabilities = Object.freeze({
  parseEnabled: false,
  searchEnabled: true,
});

/**
 * B3-03n · BR-AI-04 / BR-AI-05: a search card delivered by the Agent (scene retrieval, a candidate
 * reference of source search) writes its product reference through catalog's registerProductRef,
 * the one product_refs writer, once its link is registered (the commit of a deferred card, or the
 * card itself): a candidate never delivered writes nothing. A later get_rebate_quote by
 * context.product_key then finds the stored raw id and reads a fresh price. A failed reference
 * write is logged and leaves the card as it is (that quote fails as before).
 */
function withSearchProductRefs(
  entry: CatalogCardEntry,
  catalog: Pick<Catalog, 'registerProductRef'>,
  logger: RootLogger,
): CatalogCardEntry {
  const register = async (ref: ProductRef): Promise<void> => {
    try {
      await catalog.registerProductRef(ref, AGENT_SEARCH_REF_CAPABILITIES);
    } catch (error) {
      logger.warn(
        {
          platform: ref.platform,
          product_key: ref.productKey,
          error_name: error instanceof Error ? error.name : typeof error,
        },
        'agent_search_product_ref_failed',
      );
    }
  };
  return {
    async assemble(input) {
      const result = await entry.assemble(input);
      if (input.scene !== 'retrieval' || input.ref.source !== 'search') return result;
      if (result.kind === 'card') {
        await register(input.ref);
        return result;
      }
      if (result.kind !== 'prepared') return result;
      const commit = result.commit;
      let registered: Promise<void> | undefined;
      return {
        ...result,
        async commit() {
          const card = await commit();
          registered ??= register(input.ref);
          await registered;
          return card;
        },
      };
    },
  };
}

/**
 * B3-03j: the stream entry's Agent business ports (agentStreamPortsToken()), assembled here so
 * agent imports neither union, catalog, linking, parsing nor identity, over the same building
 * blocks as the api entry: the process's governed union adapters (governedUnion), the process
 * quoter (assembleQuoter: demo outside prod / live, commission's otherwise), the item_ref keyring
 * rule of LINK_OPEN_PORTS, and parsing's parseUrl / parseToken options (no card assembly there).
 * - searchProducts: one uncached union page per platform (the Agent re-reads every call; no HTTP
 *   search session, no detail cache). The union DTO has no category or sales yet.
 * - readProduct: a fresh union detail by the app's stored product reference (product_refs), never
 *   a displayed price; no reference → the lookup fails and the tool answers tool_failed.
 * - cards(context, registration): built per tool call from that call's server-side identity,
 *   linking's registration in scene agent with the call's agent session (register only, never a
 *   conversion: TRADE-03); attr_code through identity's reader, pids through union's pid service.
 *   B3-03n: a delivered search card also writes its product_refs row (withSearchProductRefs).
 * Without a database handle the value is null (the stream runtime is null then as well).
 */
@Module({})
class AgentStreamPortsModule {}

/**
 * B3-03m (BR-AI-18; owner D10-135 ②): the stream entry's content safety review configuration,
 * read by loadConfig (platform/config/agent-review.ts). Only staging / prod carry the AccessKey
 * pair and the endpoint; local / test, or no configuration, hand over the environment alone, so
 * the review stays fail-closed with no network request. Values are never logged.
 * TODO(规划/11 §6): 真实调用验证 — blocked on 负责人在 staging 放入阿里云内容安全 Key
 */
function agentStreamSafety(config: AppConfig): StreamReviewOptions {
  const review = config.agentReview ?? null;
  if (review === null || (config.appEnv !== 'staging' && config.appEnv !== 'prod')) {
    return { appEnv: config.appEnv };
  }
  return { appEnv: config.appEnv, credentials: review.credentials, endpoint: review.endpoint };
}

type AgentDailyCounter = NonNullable<AgentStreamProvidedPorts['dailyCounter']>;

/** Redis namespace of the Agent's per-day counters (explain_order by number, BR-AI-07 判定 4). */
const AGENT_DAILY_COUNTER_NAMESPACE = 'agent_daily';

/** INCR, then the key's expiry from ARGV[1] (the Redis handle's TTL argument); the new count. */
const AGENT_DAILY_COUNTER_SCRIPT = `local n = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return n`;

/**
 * B3-08g: the Agent's daily counter over the process Redis. The TTL is the whole seconds from the
 * injected clock's now to `expireAt` (at least 1), so the key expires at expireAt (the next +08:00
 * midnight the quota passes). Fail-closed: no Redis, a Redis failure or a reply that is not a
 * positive count rejects, and the order tool answers tool_failed; nothing counts in memory.
 */
function agentDailyCounter(clock: Clock, redis: RedisHandle | undefined): AgentDailyCounter {
  return {
    async incr(key, expireAt) {
      if (redis === undefined) throw new Error('agent: the daily counter needs Redis');
      const ttlSeconds = Math.max(
        1,
        Math.ceil((expireAt.getTime() - clock.now().getTime()) / 1_000),
      );
      const reply = await redis
        .namespace(AGENT_DAILY_COUNTER_NAMESPACE)
        .eval(AGENT_DAILY_COUNTER_SCRIPT, { keys: [key], args: [], ttlSeconds });
      if (typeof reply !== 'number' || !Number.isSafeInteger(reply) || reply < 1) {
        throw new Error('agent: the daily counter answered no count');
      }
      return reply;
    },
  };
}

function agentStreamPorts(union: DynamicModule, source: UnionQuotaSource): DynamicModule {
  return {
    module: AgentStreamPortsModule,
    global: true,
    imports: [union],
    providers: [
      {
        provide: agentStreamPortsToken(),
        inject: [
          APP_CONFIG,
          UNION_REGISTRY,
          UNION_ENDPOINTS,
          CLOCK,
          ROOT_LOGGER,
          { token: FIELD_CRYPTO, optional: true },
          { token: DB, optional: true },
          { token: REDIS, optional: true },
          { token: JOB_QUEUE, optional: true },
        ],
        useFactory: (
          appConfig: AppConfig,
          registry: UnionRegistry,
          endpoints: readonly UnionEndpoint[],
          clock: Clock,
          logger: RootLogger,
          crypto?: FieldCrypto,
          db?: Kysely<Database>,
          redis?: RedisHandle,
          queue?: JobQueue,
        ): AgentStreamProvidedPorts | null => {
          if (db === undefined) return null;
          if (crypto === undefined && appConfig.appEnv !== 'local' && appConfig.appEnv !== 'test') {
            throw new Error('agent: item_ref needs the field keyring outside local / test');
          }
          const union = governedUnion(registry, endpoints, { clock, logger, redis }, source);
          const config = createContentReader({ db, clock });
          const catalog = createCatalog({
            db,
            clock,
            warn: (event: CatalogWarning) => {
              logger.warn(
                { event: `catalog_${event.kind}`, product_key: event.key },
                'product_key alias chain not resolved',
              );
            },
          });
          const { quoter } = assembleQuoter(appConfig, endpoints, config, clock, db);
          const itemRefs = createItemRefService({ crypto: crypto ?? processItemRefCipher() });
          const attrCodes = createIdentityAttrCodeReader(db);
          const pidService = createUnionPidService({
            db,
            clock,
            superVerifier: { verify: () => Promise.resolve(null) },
            auditWriter: () => ({
              append: () =>
                Promise.reject(new Error('agent: union pid writes are not served here')),
            }),
          });
          const pids = { getActivePid: pidService.getActivePid.bind(pidService) };
          // B1-06zd: get_rebate_quote's detail links (ref.source detail) offer their prefetch.
          const promoPrefetch =
            queue === undefined
              ? undefined
              : createPromoPrefetch({
                  db,
                  clock,
                  config,
                  pids,
                  queue,
                  limiter: createPromoPrefetchLimiter(redis),
                  logger,
                });
          const sourceLinks = createSourceLinkReader(db);
          const search = createUnionSearchUpstream({
            union,
            catalog,
            config,
            clock,
            ledger: null,
            logger,
          });
          const detail = createUnionDetailUpstream({ union });
          const parsing: ParsingOptions = {
            config,
            catalog,
            cards: NO_PARSE_CARDS,
            clock,
            getGovernedAdapter: (platform) => union.adapter(platform),
            logger,
          };
          // B3-08g: the order tools' read ports, the same building blocks as OrdersModule.forRoot
          // on the api entry (content's reader, linking's order-link and claim-entry readers).
          const claimEntries = createClaimEntryReader(db);
          const orderQueries = createOrderQueries({
            db,
            clock,
            config,
            figures: orderFiguresReader(db, clock),
            links: createOrderLinkReader(db),
            claimEntry: claimEntries,
          });
          return {
            platforms: REGISTERED_PLATFORMS,
            async searchProducts(query, context, page) {
              const result = await search.search({
                appId: context.appId,
                platform: query.platform,
                keyword: query.q,
                pageNo: page,
                pageSize: query.limit ?? AGENT_SEARCH_PAGE_SIZE,
                sort: query.sort === 'sales_desc' ? 'sales_desc' : 'relevance',
                ...(query.price_min_fen === undefined ? {} : { priceMinFen: query.price_min_fen }),
                // The uncached union side reads no promotion slot (search-wiring.ts).
                promotionSlot: '',
              });
              // TODO(规划/11 §4.5): 候选的类目 ID 与销量 — blocked on 联盟 DTO 增加类目与销量字段（UnionItem 目前没有）
              return result.items.map((candidate) => ({
                ...candidate,
                categoryId: '',
                sales: null,
              }));
            },
            async readProduct(productKey, context) {
              const key = await catalog.resolveProductKey(productKey);
              const prefix = key.slice(0, key.indexOf(':'));
              const platform = (await catalog.listPlatforms()).find(
                (row) => row.key_prefix === prefix,
              )?.code;
              if (platform === undefined || !isRegisteredPlatform(platform)) {
                throw new Error('agent: product platform has no union adapter');
              }
              const ref = await catalog.readProductRef({
                appId: context.appId,
                platform,
                productKey: key,
              });
              if (ref === null) throw new Error('agent: product has no stored reference');
              const jdMode =
                platform === 'jd'
                  ? ((await config.configValue(context.appId, 'product_key.jd.mode'))?.value ??
                    'item')
                  : undefined;
              const item = await detail.detail({
                appId: context.appId,
                productKey: key,
                platform,
                rawItemId: ref.rawItemId,
                ...(jdMode === undefined ? {} : { jdMode: String(jdMode) }),
              });
              if (item.platform !== platform)
                throw new Error('agent: union detail platform differs');
              // One fresh snapshot: the card's quote and the link's snapshot come from this read.
              return {
                item,
                ref: {
                  ...ref,
                  // B1-06zd: the Agent's product detail, whatever card first stored the reference.
                  source: 'detail',
                  rawFetchedAt: item.quoted_at,
                  receivedAt: clock.now().toISOString(),
                },
              };
            },
            parsing,
            cards(context, registration) {
              const caller = {
                appId: context.appId,
                userId: context.userId,
                deviceId: context.deviceId,
              };
              const current = () => Promise.resolve(caller);
              const registrar = createLinkRegistration({
                db,
                clock,
                callerContext: { current },
                attrCodes,
                config,
                pids,
                context: registration,
                logger,
                ...(promoPrefetch === undefined ? {} : { promoPrefetch }),
              });
              const entry = createCatalogCardEntry({
                clock,
                logger,
                viewerContext: { current },
                quoter,
                registrar,
                sourceLinks,
                itemRefs,
              });
              return withSearchProductRefs(entry, catalog, logger);
            },
            orders: {
              searchForAgent: (subject, search) => orderQueries.searchForAgent(subject, search),
              findOwnByNumber: (subject, query) => orderQueries.findOwnByNumber(subject, query),
              get: (subject, orderId) => orderQueries.get(subject, orderId),
            },
            claimEntries: { read: (input) => claimEntries.read(input) },
            dailyCounter: agentDailyCounter(clock, redis),
          };
        },
      },
    ],
    exports: [agentStreamPortsToken()],
  };
}

/**
 * B3-08k (D10-294; BR-AI-02 ③; rule tests test/spec/agent/foreign-db-handoff/**): the readers
 * agent reads through, assembled here so agent never hands its database handle to content or
 * identity. Each is null without a database handle (agent's runtimes are null then as well).
 * - agentContentReaderToken() (stream and worker entries): configValue is the entry's shared,
 *   cached content reader (on stream the same instance as risk's pooled minimum-version reader):
 *   the consent version, the daily limits and every read of the production assembly;
 *   freshConfigValue builds a content reader per call (no cache of its own), so agent's switches
 *   are read anew behind agent's own 1 s cache (createAgentConfigReader, followup 23), exactly as
 *   agent's per-call reader did before.
 * - agentCallerReaderToken() (stream): identity's createAgentCallerReader over the handle's app
 *   schema (the AGENT_CALLER provider's reader).
 * - agentConsentReaderToken() (stream): identity's createAiConsentReader bound to the handle;
 *   agent hands it the consent version source only.
 */
@Module({})
class AgentReadersModule {}

function agentReaders(
  entry: 'stream' | 'worker',
  contentReader: SharedContentReader,
): DynamicModule {
  const content = {
    provide: agentContentReaderToken(),
    inject: [CLOCK, { token: DB, optional: true }],
    useFactory: (clock: Clock, db?: Kysely<Database>): AgentContentReader | null => {
      if (db === undefined) return null;
      const handle = db;
      const shared = contentReader(handle, clock);
      return {
        configValue: (appId, key) => shared.configValue(appId, key),
        freshConfigValue: (appId, key) =>
          createContentReader({ db: handle, clock }).configValue(appId, key),
      };
    },
  };
  const caller = {
    provide: agentCallerReaderToken(),
    inject: [{ token: DB, optional: true }],
    useFactory: (db?: Kysely<Database>) =>
      db === undefined ? null : createAgentCallerReader({ db: db.withSchema('app') }),
  };
  const consent = {
    provide: agentConsentReaderToken(),
    inject: [{ token: DB, optional: true }],
    useFactory: (db?: Kysely<Database>): AgentConsentReaderFactory | null => {
      if (db === undefined) return null;
      const handle = db;
      return ({ currentVersion }) => createAiConsentReader({ db: handle, currentVersion });
    },
  };
  const providers = entry === 'stream' ? [content, caller, consent] : [content];
  return {
    module: AgentReadersModule,
    global: true,
    providers,
    exports: providers.map((provider) => provider.provide),
  };
}

/**
 * The risk module of the `api` entry: stage ① (device signing keys from identity) and stage ④a,
 * whose minimum supported version port is content's reader of app_versions (same assembly as
 * identityModule(); risk never imports content, B1-03c): cached on the pool for the guard, and
 * built over the idempotency claim's transaction for the post-miss hook. No database handle: no reader, and a
 * request that needs the minimum answers 50001.
 * Stage ⑬ (rate limits, B1-03e): its thresholds port reads `rate_limit.ops` and
 * `rate_limit.<group>` through content's cached configValue; no database handle: the code
 * defaults only. Its buckets use REDIS (none: stage ⑬ is not installed).
 * Same-device multi-account check (BR-ID-37, B1-03k): sameDeviceAccountsCheckToken(), over
 * identity's login reader and content's configuration reader bound to the caller's handle.
 * Appeals (POST / GET /v1/me/appeals, B1-03i): the deadline calendar through content's reader
 * bound to the submission's transaction.
 * The guard's pooled minimum-version reader is the same instance as the one behind GET
 * /v1/app-versions/check (F1-02e followup), so both answer from one cache.
 */
function riskModule(identity: DynamicModule, contentReader: SharedContentReader): DynamicModule {
  return RiskModule.forRoot({
    imports: [identity],
    // ⑥ deletion cooling / processing (B1-15e), ⑦ privacy consent (B1-02zh), then ⑧ ⑨ identity
    // level (B1-02za), before ⑫ step-up (B1-02y) on the idempotent path; the deletion, privacy and
    // level guards, in that order, between ⑤ and ⑬ on the non-idempotent path. The list order is
    // the decision order.
    beforeRateLimit: {
      inject: [DELETION_STAGE_CHECKS, PRIVACY_CONSENT_CHECKS, IDENTITY_LEVEL_CHECKS, STEP_UP_CHECK],
      useFactory: (
        deletion: DeletionStageChecks,
        privacy: PrivacyConsentChecks,
        level: IdentityLevelChecks,
        stepUp: IdempotencyPostMissCheck,
      ) => [
        deletion.postMiss,
        privacy.postMiss,
        level.postMiss,
        // The withdrawal application judged its step-up already (beforeRiskState below); judging
        // it again here would try to reserve the same token twice and refuse with 10003.
        (request) => (isWithdrawalApplication(request) ? Promise.resolve() : stepUp(request)),
      ],
    },
    // BR-WDR-03 ① ② ③ (B2-05d): for POST /v1/withdrawals only, the withdraw switch (30306, stored
    // with the key) and then the step-up token (10003, identity's stage ⑫ check) are judged after
    // ④a and before ⑤ (banned, 10006) — 08 orders ① ② ahead of ③ for withdrawals, where the global
    // order (BR-ID-01) puts ⑤ before ⑫. Both are no-ops for every other operation.
    beforeRiskState: {
      inject: [CLOCK, ROOT_LOGGER, STEP_UP_CHECK],
      useFactory: (clock: Clock, logger: RootLogger, stepUp: IdempotencyPostMissCheck) => [
        createWithdrawSwitchCheck({
          config: {
            configValue: (appId, key, handle) =>
              createContentReader({ db: handle, clock }).configValue(appId, key),
          },
          logger: logger.child({ module: 'payout' }),
        }),
        (request) => (isWithdrawalApplication(request) ? stepUp(request) : Promise.resolve()),
      ],
    },
    beforeRateLimitGuards: {
      inject: [DELETION_STAGE_CHECKS, PRIVACY_CONSENT_CHECKS, IDENTITY_LEVEL_CHECKS],
      useFactory: (
        deletion: DeletionStageChecks,
        privacy: PrivacyConsentChecks,
        level: IdentityLevelChecks,
      ) => [deletion.guard, privacy.guard, level.guard],
    },
    minimumVersions: {
      inject: [CLOCK, { token: DB, optional: true }],
      // pooled: the guard's cached reader; on: a fresh reader over the idempotency claim's
      // transaction for the post-miss hook (no second pooled connection while holding one).
      useFactory: (clock: Clock, db?: Kysely<Database>): MinimumVersionReaders | null =>
        db === undefined
          ? null
          : {
              pooled: contentReader(db, clock),
              on: (handle) => createContentReader({ db: handle, clock }),
            },
    },
    rateLimit: {
      thresholds: {
        inject: [CLOCK, { token: DB, optional: true }],
        // pooled: the guard's cached reader; on: a fresh reader over the idempotency claim's
        // transaction for the post-miss hook (no second pooled connection while holding one).
        useFactory: (clock: Clock, db?: Kysely<Database>): RateLimitThresholdReaders | null =>
          db === undefined
            ? null
            : {
                pooled: createRateLimitThresholdReader(createContentReader({ db, clock })),
                on: (handle) =>
                  createRateLimitThresholdReader(createContentReader({ db: handle, clock })),
              },
      },
    },
    // BR-ID-37 (B1-03k): identity's login reader; configuration through content's reader over
    // the caller's handle, so the check reads and writes on the caller's transaction only.
    sameDevice: {
      logins: createSameDeviceLoginReader(),
      config: {
        inject: [CLOCK],
        useFactory: (clock: Clock) => (handle: Kysely<Database>) =>
          createContentReader({ db: handle, clock }),
      },
    },
    // Appeals (BR-ID-36, B1-03i): the deadline's working-day calendar (calendar.cn_holidays.<year>,
    // calendar.cn_makeup_workdays.<year>) through content's reader over the submission's handle.
    appeals: {
      config: {
        inject: [CLOCK],
        useFactory: (clock: Clock) => (handle: Kysely<Database>) =>
          createContentReader({ db: handle, clock }),
      },
    },
  });
}

/**
 * The admin entry's console module (F1-06k, F1-06l). The sms step-up tier sends through identity's
 * SmsSender port, provided here under identity's sender token as identity provides it on the api
 * entry (the fake adapter in local / test, whose outbox tests read), so admin never imports
 * identity.
 */
function adminAuthModule(): DynamicModule {
  return AdminAuthModule.forRoot({
    // B1-34a: the audit search derives a configuration record's permission point from it.
    configPermissions: new Map(configRegistry().map((item) => [item.key, item.permission])),
    smsSender: {
      provide: smsSenderToken(),
      inject: [APP_CONFIG, ROOT_LOGGER, CLOCK, { token: DB, optional: true }],
      useFactory: entrySmsSender,
    },
  });
}

/** Production transport of the SendSms channel: the platform fetch, called lazily. */
const smsFetch: AliyunSmsFetch = (url, init) => globalThis.fetch(url, init);

/**
 * The verification code sender of an entry (B1-12w, D10-315): the Aliyun SendSms channel on
 * notification's SMS failover when loadConfig read all four SMS_ variables; otherwise identity's
 * createSmsSender (local / test fake, or the staging / prod sender that rejects every message and
 * warns at startup). One sender (and breaker) per entry process.
 * B1-12y (D10-316 ①, D10-337 ②): with a database, SMS_CODE's signature name and template CODE come
 * from the app's in-use notify_templates registration, the deployment's SMS_SIGN_NAME /
 * SMS_TEMPLATE_VERIFY_CODE only standing in when the app has none.
 */
function entrySmsSender(
  config: AppConfig,
  logger: RootLogger,
  clock: Clock,
  db?: Kysely<Database>,
): VerifyCodeSmsSender {
  const sms = config.sms ?? undefined;
  const resolver =
    sms === undefined || db === undefined
      ? undefined
      : createRegisteredTemplateResolver({
          db,
          logger,
          deployVerifyCode: { signName: sms.signName, templateCode: sms.verifyCodeTemplate },
        });
  const sender = createEntrySmsSender({
    sms,
    ...(resolver === undefined ? {} : { resolver }),
    fallback: () => createSmsSender(config.appEnv, logger),
    registry: createResilienceRegistry(),
    scheduler: systemScheduler(),
    fetch: smsFetch,
    clock,
    nonce: randomUUID,
    messageId: randomUUID,
  });
  if (sms !== undefined)
    logger.info({ app_env: config.appEnv, provider: 'aliyun' }, 'sms_sender_live');
  return sender;
}

/**
 * The admin entry's sender of the console's SMS registration test messages (B1-12z, D10-335 ③):
 * the fake in local / test (scripted by the HTTP tests), the Aliyun SendSms channel on staging /
 * prod when loadConfig read all four SMS_ variables, otherwise a sender that refuses every message
 * (announced once). One sender (and breaker) per entry process.
 */
function notifySmsTestSender(
  config: AppConfig,
  logger: RootLogger,
  clock: Clock,
): NotifySmsTestSender {
  return createNotifySmsTestSender({
    appEnv: config.appEnv,
    sms: config.sms ?? undefined,
    logger,
    registry: createResilienceRegistry,
    scheduler: systemScheduler,
    fetch: smsFetch,
    clock,
    nonce: randomUUID,
    messageId: randomUUID,
  });
}

/**
 * The worker's site union authorization alert SMS sender (B1-22b, B1-12y): on staging / prod with
 * all four SMS_ variables, the Aliyun SendSms channel with the signature name and template CODE of
 * each code's in-use notify_templates registration (none → not sent) and the BizId written to
 * notify_logs; otherwise createTemplateSmsSender (the fake in local / test, a rejecting sender
 * announced once elsewhere).
 */
function siteAuthSmsSender(
  config: AppConfig,
  appEnv: AppConfig['appEnv'],
  db: Kysely<Database>,
  clock: Clock,
  logger: RootLogger,
): TemplateSmsSender {
  const sms = config.sms ?? undefined;
  if (appEnv === 'local' || appEnv === 'test' || sms === undefined) {
    return createTemplateSmsSender(appEnv, logger);
  }
  logger.info({ app_env: appEnv, provider: 'aliyun' }, 'template_sms_sender_live');
  return createLiveTemplateSmsSender({
    sms,
    resolver: createRegisteredTemplateResolver({ db, logger }),
    db,
    registry: createResilienceRegistry(),
    scheduler: systemScheduler(),
    fetch: smsFetch,
    clock,
    nonce: randomUUID,
    messageId: randomUUID,
    logger,
  });
}

/**
 * B1-27h (BR-ID-40 细则「交付（默认）」; BR-TEXT-23 细则「个人信息副本的交付通知」): the ports of
 * identity's copy worker on the worker entry.
 * - sources: personalDataCopySources (B1-27f) over the process field cipher.
 * - sms: the extraction code (template DATA_COPY_CODE, {code, expires_at}). local / test: a fake that
 *   accepts every message and keeps nothing (identity's verification code fake has no templates,
 *   notification's template fake renders only the site auth alerts); staging / prod: the entry's
 *   template SMS sender (siteAuthSmsSender: Aliyun by registration when the SMS_ variables are
 *   loaded, rejecting otherwise; an unregistered template is refused, D10-316).
 * - inbox: notification's push sending core over identity's push session validity; the channel is
 *   the demonstration MobPush (accepting on local / test, rejecting elsewhere: the push log fails,
 *   the inbox message stays).
 *   TODO(规划/11 §2.3): 真实推送通道 — blocked on MobPush 适配器任务
 * - auditWriter: admin's writer with platform logging's SENSITIVE_KEYS.
 */
export function dataCopyPorts(config: AppConfig): IdentityDataCopyPorts {
  return {
    sources: (clock, crypto) => personalDataCopySources(clock, crypto),
    sms: ({ db, clock, logger, appEnv }): DataCopyCodeSender => {
      if (appEnv === 'local' || appEnv === 'test') {
        return { send: async () => 'accepted' };
      }
      return siteAuthSmsSender(config, appEnv, db, clock, logger);
    },
    inbox: (clock, appEnv): DataCopyInbox => {
      const core = createPushSendCore({
        clock,
        channel: createDemoMobPush({
          status: appEnv === 'local' || appEnv === 'test' ? 'accepted' : 'rejected',
        }),
        sessionValidity: createPushSessionValidity(clock),
      });
      return {
        record: (trx, input) => core.record(trx, input),
        dispatch: (db, event) => core.dispatch(db, event),
      };
    },
    auditWriter: (db, clock) => createAuditWriter({ db, clock, sensitiveKeys: SENSITIVE_KEYS }),
  };
}

/**
 * B1-12u: notification's push sending core on the worker entry (withdrawal result messages), over
 * identity's push session validity. The channel is the demonstration MobPush, as dataCopyPorts:
 * accepting on local / test, rejecting elsewhere (the push log fails, the inbox message stays).
 * TODO(规划/11 §2.3): 真实推送通道 — blocked on MobPush 适配器任务
 */
export function workerPushSendCore(config: AppConfig): (clock: Clock) => PushSendCore {
  return (clock) =>
    createPushSendCore({
      clock,
      channel: createDemoMobPush({
        status: config.appEnv === 'local' || config.appEnv === 'test' ? 'accepted' : 'rejected',
      }),
      sessionValidity: createPushSessionValidity(clock),
    });
}

/**
 * Root module, assembled per process entry. Every HTTP entry serves the health probe; the `api`
 * entry also serves the /v1 identity routes, the risk module's request signature check, whose
 * device port identity implements, identity's token check, and the risk module's stage ④a gate
 * (minimum supported version and restricted session, 10405; B1-03c). The stream entry shares
 * identity's checks and risk's guards without their public routes or the signature check.
 * The union module (adapter registry
 * and endpoint configuration) loads where union platforms are called: `api` (search, linking) and `worker` (order sync); the
 * other worker entries load only the platform and admin modules.
 * The admin module provides the platform audit port on every entry (F1-06b).
 * The catalog module (platform dictionary, product_refs, aliases, category blocklist) loads on
 * `api`, where search, detail and parsing run; its configuration port is content's reader,
 * assembled here so catalog never imports content (B1-05c).
 * The linking module (card-time link registration, B1-06c) loads on `api` beside catalog; its
 * configuration port is content's reader too, assembled here so linking never imports content.
 * The parsing module (parse_input core, B1-07a) loads on `api` as well; its configuration port
 * (parse.tpwd.enabled, product_key.jd.mode) is content's reader, so parsing never imports content.
 * On `api`, catalogPorts makes the governed union adapters, linking's registrar and the demo
 * quoter global, for catalog's GET /v1/products/search (B1-05j) and parsing's POST
 * /v1/inputs/parse (B1-07b), which registers its links through parsingPorts in the request's scene.
 * Business modules are added to the entries that own them by their tasks (规划/02 §4.1).
 */
/**
 * B1-02m: identity's request identity for catalog's ViewerContext and linking's CallerContext
 * (the token principal, else the verified device's guest, else the X-App-Id guest), resolved per
 * request, and its users.attr_code reader for linking's AttrCodeReader (unavailable without a
 * database handle, as linking's default). identity implements the ports structurally.
 */
/**
 * F1-02e followup: one cached content reader per assembled app, handed to both risk's
 * minimum-version gate (pooled) and ContentPublicModule (GET /v1/app-versions/check, GET
 * /v1/config), so an admin change to a minimum version reaches both at the same refresh.
 */
/**
 * B2-04ze (D10-443): SettlementModule.forWorker with the owners' exports (worker entry only).
 * content's switches are read fresh on the worker's handle (the executor caches at most 10 s).
 */
function settlementWorkerModule(): DynamicModule {
  return SettlementModule.forWorker({
    platforms: REGISTERED_PLATFORMS,
    readAttribution: readCommissionAttribution,
    readSnapshot: readCommissionSnapshot,
    readTljDeductFen,
    appendBeneficiaryEvent,
    readUnionAuthoritative: readUnionAuthoritativeOrderKeys,
    snapshotStatus: getAssetSnapshotStatus,
    registerDiff: registerReconDiff,
    readOrderNets: getOrderNets,
    // D10-587: the bus publishes account.went_negative, the hook lifts NEGATIVE_BALANCE.
    ledger: (clock, eventBus) =>
      createLedger({
        clock,
        ...(eventBus === undefined ? {} : { eventBus }),
        balanceRecoveredHook: createBalanceRecoveredHook({ clock }),
      }),
    lockUsers: lockUsersForUpdate,
    deletionStatus: (db) => createUserDeletionStatusReader({ db }),
    realnameStatus: (db) => createRealnameStatusBatchReader({ db }),
    riskState: (db) => createRiskStateBatchReader({ db }),
    minors: (crypto) => createMinorStatusBatchReader({ crypto }),
    config: (db, clock) => ({
      get: async (appId, key) =>
        (await createContentReader({ db, clock }).configValue(appId, key))?.value,
    }),
  });
}

type SharedContentReader = (db: Kysely<Database>, clock: Clock) => ContentReader;
/**
 * B2-07e: an audit port whose actor may be written as `admin:<admin_users.id>` (payout's hold
 * release records the releasing account that way on the hold row); audit_logs.admin_id is the
 * account itself. A plain id passes through unchanged.
 */
function adminActorAudit(writer: AuditPort): AuditPort {
  return {
    append: (input) =>
      writer.append(
        input.actor.startsWith('admin:')
          ? { ...input, actor: input.actor.slice('admin:'.length) }
          : input,
      ),
  };
}

function sharedContentReader(): SharedContentReader {
  let shared:
    | { readonly db: Kysely<Database>; readonly clock: Clock; readonly reader: ContentReader }
    | undefined;
  return (db, clock) => {
    if (shared === undefined || shared.db !== db || shared.clock !== clock) {
      shared = { db, clock, reader: createContentReader({ db, clock }) };
    }
    return shared.reader;
  };
}

const identityViewer = {
  scope: Scope.REQUEST,
  inject: [REQUEST],
  useFactory: (request: IdentityRequest): IdentityContext => createIdentityViewerContext(request),
};
/**
 * B1-05o: linking's card registration in the feed scene for the home material feed, so its links
 * are recorded as scene=feed (BR-ATTR-08), not as the global LinkRegistrar's search scene.
 */
const feedLinkRegistrar = {
  inject: [LINK_REGISTRATIONS],
  useFactory: (registrations: LinkRegistrations): LinkRegistrar => {
    const registration = registrations.forContext({ scene: 'feed' });
    return { register: (input: RegisterLinkInput) => registration.register(input) };
  },
};
/**
 * B1-05o: catalog's published sections over content's PageReader. The version and the
 * min_app_version gate read the same headers as getPage, so a guest keeps the gray bucket of its
 * X-Device-Id on this unsigned route, where identity's viewer knows no device (contract
 * listPageSectionItems: "the same rule as getPage"); the viewer's deviceId is not used here.
 */
const sectionPages = {
  scope: Scope.REQUEST,
  inject: [REQUEST, PageReader],
  useFactory: (request: IdentityRequest, reader: PageReader): SectionItemsPages => {
    const header = (name: string): string | undefined => {
      const value = request.headers?.[name];
      return typeof value === 'string' && value !== '' ? value : undefined;
    };
    return {
      section: async ({ appId, pageKey, sectionId }) => {
        const section = await reader.section(
          appId,
          pageKey,
          sectionId,
          header('x-device-id') ?? null,
          { platform: header('x-platform') ?? '', appVersion: header('x-app-version') },
        );
        return section === null ? null : { dataSource: section['data_source'] };
      },
    };
  },
};
const identityCaller = {
  scope: Scope.REQUEST,
  inject: [REQUEST],
  useFactory: (request: IdentityRequest): IdentityContext => createIdentityCallerContext(request),
};
const identityAttrCodes = {
  inject: [{ token: DB, optional: true }],
  useFactory: (db?: Kysely<Database>): IdentityAttrCodeReader =>
    db === undefined ? createUnavailableAttrCodeReader() : createIdentityAttrCodeReader(db),
};

/** identity's push token port onto notification's commands (B1-12b), for every entry that ends sessions. */
function sessionPushTokens(clock: Clock): SessionPushTokens {
  return {
    bind: (trx, session) => bindPushTokensForSession(trx, session, clock),
    unbind: (trx, session) => unbindPushTokensForSession(trx, session, clock),
  };
}

/**
 * B2-05c: the withdrawal rules use case of the api entry (GET /v1/withdrawals/rules; the same
 * validator POST /v1/withdrawals runs, B2-05d). Every port reads on the caller's handle: content's
 * configuration reader (withdraw.*; a plain read each time, as payoutAccountConfig), risk's state
 * and appeal readers, the read-only blocklist match, identity's real-name, payout-account and
 * labor-agreement ports, ledger's getBalances, the module's own usage / holds readers, the default
 * fee / tax calculator (0 / 0, BR-WDR-19 / 20) and identity's re-verification gate (BR-WDR-03 ③b).
 * Without a database or a keyring the entry gets no use case (the controller answers 50001).
 */
/**
 * BR-WDR-03 ⑬ 细则 (B2-05c): the member's self-purchase orders of the last 90 × 24 hours that are
 * received and still rebate-worthy (orders' port), and the member's own rebate share of them —
 * the credited net from the ledger once CREDITED (已入账金额), the commission snapshot's amount at the
 * order's version before (当前预估). Read on the caller's handle; the ledger's order nets want a
 * transaction, so a pool handle (GET /v1/withdrawals/rules) opens a short read-only one.
 */
function selfPurchasePort(): WithdrawRulesOptions['selfPurchase'] {
  const orders = createSelfPurchaseOrderReader();
  const estimate = createSelfRebateEstimateReader();
  async function creditedSelfNet(
    handle: Kysely<Database>,
    appId: string,
    userId: string,
    platform: string,
    subOrderId: string,
  ): Promise<bigint> {
    const selection = { appId, orderKey: orderKey(platform, subOrderId) };
    const nets = handle.isTransaction
      ? await getOrderNets(handle as Transaction<Database>, selection)
      : await handle.transaction().execute((trx) => getOrderNets(trx, selection));
    const own = nets.beneficiaries.find(
      (b) => b.beneficiary_user_id === userId && b.role === 'self',
    );
    return own === undefined || own.net_fen < 0n ? 0n : own.net_fen;
  }
  return {
    async read(handle, input) {
      const rows = await orders.read(handle, {
        appId: input.appId,
        userId: input.userId,
        now: input.now,
      });
      let amount = 0n;
      for (const row of rows) {
        const share =
          row.rebate_status === 'CREDITED'
            ? await creditedSelfNet(
                handle,
                input.appId,
                input.userId,
                row.platform,
                row.sub_order_id,
              )
            : await estimate.read(handle, {
                appId: input.appId,
                orderId: row.order_id,
                commissionVersion: row.commission_version,
                userId: input.userId,
              });
        amount = addFen(amount, share);
      }
      return { count: rows.length, amount_fen: amount };
    },
  };
}

/** The ports of the withdrawal rules chain (B2-05c), shared by the rules and the application use case. */
function withdrawRuleOptions(
  clock: Clock,
  logger: RootLogger,
  db: Kysely<Database>,
  crypto: FieldCrypto,
): WithdrawRulesOptions {
  const reverify: ReverifyGatePort = createReverifyGate({ clock });
  const realname = createRealnameReader(crypto);
  const payoutLogger = logger.child({ module: 'payout' });
  const config: PayoutConfigPort = {
    configValue: (appId, key, handle) =>
      createContentReader({ db: handle, clock }).configValue(appId, key),
  };
  return {
    clock,
    logger: payoutLogger,
    config,
    risk: createRiskStateBatchReader({ db }),
    appeal: createAppealPrevStateReader(),
    // B2-11f (BR-ID-36): a dimension whose rule is disabled does not refuse the application.
    blocklist: createBlocklistMatchReader({ rules: createRiskRuleStatusReader({ clock }) }),
    reverify,
    realname: { read: realname.read, verified: realname.verified },
    subject: createWithdrawSubjectReader(),
    laborAgreementSigned,
    ledger: createLedger({ clock }),
    holds: createWithdrawHoldsReader(),
    usage: createWithdrawUsageReader(),
    selfPurchase: selfPurchasePort(),
    // B2-08c (BR-WDR-20): the tax from content's tax.SERVICE_FEE.* keys (none / flat_rate /
    // cumulative over tax_ytd and the in-flight withdrawals), the identity dimension through
    // identity's realname-identity-key port; never a rate in code.
    feeTax: createFeeTaxCalculator({
      config,
      identityKey: createRealnameIdentityKeyReader(),
      logger: payoutLogger,
    }),
  };
}

/**
 * B2-05q (BR-ID-36 细则「被拦截请求申诉」提现提交类): the hit record of a withdrawal application
 * refused with 44001, through risk's blocklist service in a short transaction of its own (the
 * controller calls it after the application's transaction has ended). The decision already found
 * the rule in force, so the decided write is used and the status is not read again. The related
 * phone is the account's current one as identity stores it: users.phone_hmac and the masked number
 * of identity's port (nothing is decrypted here); an account without a phone leaves both empty.
 * The digest and the masked number are read on one snapshot (a REPEATABLE READ, read-only
 * transaction that ends before the hit is written): a phone change committed between the two
 * reads can never pair the old digest with the new masked number (money r1 S1).
 */
function withdrawBlockedHits(deps: {
  db: Kysely<Database>;
  clock: Clock;
  crypto: FieldCrypto;
  logger: RootLogger;
}): WithdrawBlockedHits {
  const { db, crypto } = deps;
  const blocklist = createBlocklistService(deps);
  return {
    async record(input) {
      if (blocklist.recordDecidedHit === undefined) {
        throw new Error('payout: the blocklist service cannot record a decided hit');
      }
      const related = await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .setAccessMode('read only')
        .execute(async (snapshot) => {
          const user = await snapshot
            .withSchema('app')
            .selectFrom('users')
            .select('phone_hmac')
            .where('app_id', '=', input.appId)
            .where('id', '=', input.userId)
            .executeTakeFirst();
          const hmac = user?.phone_hmac ?? null;
          if (hmac === null) return null;
          const phones = await createMaskedPhoneReader(snapshot, crypto).maskedPhones(input.appId, [
            input.userId,
          ]);
          const masked = phones.get(input.userId) ?? null;
          return masked === null ? null : { hmac, masked };
        });
      await blocklist.recordDecidedHit({
        app_id: input.appId,
        request_type: 'withdraw',
        user_id: input.userId,
        amount_fen: input.amountFen,
        related_phone_digest: related,
        dimension: input.hit.dimension,
        value_hmac: input.hit.value_hmac,
        rule_id: input.hit.rule_id,
      });
    },
  };
}

/** The nil UUID: `deviceId` of a walk that lists its devices in `deviceIds` instead (not read). */
const NO_DEVICE = '00000000-0000-0000-0000-000000000000';

/**
 * B2-11c: the ports of payout's withdrawal.created consumer (BR-WDR-30) on the worker entry:
 * content's configuration reader on the decision's transaction, risk's state and appeal readers,
 * the BR-WDR-29 facts reader with commission's and identity's ports (as W1's snapshot), ⑩ the
 * verified realname's birth date (BR-ID-26, 18 at the decision instant; no verified record → not
 * adult; without the field keyring the check throws and the decision is retried), and ⑫ the live
 * BR-WDR-29 ⑨ blacklist_hit: risk's blocklist match over the member's phone, id number, every
 * device of the member and the snapshot payee HMAC. B2-05q (BR-ID-36): match() is the same walk
 * and names the first target that hit; blacklistHits is risk's writer of that hit on the decision's
 * transaction.
 */
function autoPayoutPorts(deps: {
  db: Kysely<Database>;
  clock: Clock;
  crypto: FieldCrypto | undefined;
}): AutoPayoutPorts {
  const { db, clock, crypto } = deps;
  const realname = crypto === undefined ? null : createRealnameReader(crypto);
  // B2-11f (BR-ID-36): a dimension whose rule is disabled is no ⑨ hit.
  const blocklist = createBlocklistMatchReader({ rules: createRiskRuleStatusReader({ clock }) });
  type BlacklistSubject = Parameters<AutoPayoutPorts['blacklist']['hit']>[1];
  /**
   * One walk of risk's blocklist match over the member's phone, id number, every device of the
   * member's sessions and the payee account (B1-03zj, D10-731 ①: the order ③a uses — phone → id_no
   * → device → payee — so ⑨ names the dimension ③a would; each rule status read once per walk).
   */
  async function overDevices<T>(
    handle: Kysely<Database>,
    input: BlacklistSubject,
    check: (subject: Parameters<typeof blocklist.read>[1]) => Promise<T | null>,
  ): Promise<T | null> {
    const method =
      input.payoutMethod === 'alipay' ||
      input.payoutMethod === 'bank_card' ||
      input.payoutMethod === 'wechat'
        ? input.payoutMethod
        : null;
    // D10-571 (B1-03zi): every device of the member's sessions, revoked ones included, no time
    // window, as BR-ID-28's deletion does. ⑨ only sends the withdrawal to manual review. Ordered by
    // id so that, among several listed devices, the one named is the same on every run.
    const devices = await handle
      .withSchema('app')
      .selectFrom('sessions')
      .select('device_id')
      .distinct()
      .where('app_id', '=', input.appId)
      .where('user_id', '=', input.userId)
      .orderBy('device_id')
      .execute();
    return check({
      appId: input.appId,
      userId: input.userId,
      deviceId: NO_DEVICE,
      deviceIds: devices.map((device) => device.device_id),
      payeeHmac: input.payeeHmac,
      payoutMethod: method,
      now: clock.now(),
    });
  }
  return {
    config: {
      configValue: (appId, key, handle) =>
        createContentReader({ db: handle, clock }).configValue(appId, key),
      // The decision's group in one statement: one snapshot of config_items, so a batch save is
      // seen whole or not at all (BR-WDR-30 可追溯). The same rows content's configValue reads.
      async configValues(appId, keys, handle) {
        if (keys.length === 0) return new Map();
        const rows = await handle
          .withSchema('app')
          .selectFrom('config_items')
          .select(['key', 'value', 'version'])
          .where('app_id', '=', appId)
          .where('key', 'in', [...keys])
          .execute();
        return new Map(rows.map((row) => [row.key, { value: row.value, version: row.version }]));
      },
    },
    risk: createRiskStateBatchReader({ db }),
    appeal: createAppealPrevStateReader(),
    facts: createWithdrawRiskFactsReader({
      shares: createBeneficiaryShareReader(),
      payeeHistory: createPayeeBindingHistoryReader(),
    }),
    adult: {
      async isAdult(handle, input) {
        if (realname === null) throw new Error('payout: the adult check needs the field keyring');
        const verified = await realname.verified(handle, {
          app_id: input.appId,
          user_id: input.userId,
        });
        return verified !== null && isAtLeastAge(verified.birth_date, 18, input.at);
      },
    },
    blacklist: {
      async hit(handle, input) {
        return (
          (await overDevices(handle, input, (subject) => blocklist.read(handle, subject))) !== null
        );
      },
      async match(handle, input) {
        const { match } = blocklist;
        if (match === undefined) throw new Error('payout: the blocklist reader has no match()');
        return overDevices(handle, input, (subject) => match(handle, subject));
      },
    },
    blacklistHits: createWithdrawalReviewHits({ clock }),
  };
}

/**
 * The payee snapshot decryption over the process's field cipher (payout_accounts.* contexts, the
 * same the binding used): the api entry's records (B2-05f) and the payout entry's transfer (B2-06f).
 */
const payeeDecrypt = {
  inject: [{ token: FIELD_CRYPTO, optional: true }],
  useFactory: (crypto?: FieldCrypto): DecryptWithdrawalAccount | null => {
    if (crypto === undefined) return null;
    const contexts = blocklistHmacContexts();
    return (cipher: Buffer, method: string) => {
      const context =
        method === 'alipay' ? contexts.alipay : method === 'bank_card' ? contexts.bank_card : null;
      if (context === null) throw new Error('payout: no cipher context for the payout method');
      return crypto.decrypt(cipher.toString('utf8'), context);
    };
  },
};

const QUEUE_PAUSED_KEY = 'payout.queue_paused';
const QUEUE_PAUSED_ON = sql<Database['config_items']['value']>`'true'::jsonb`;

/**
 * B2-06f (BR-WDR-17 / BR-WDR-28, D10-398 ②): the worker's system write of payout.queue_paused =
 * true for the payout process's `pause` job (payout-landing), on the worker's couli_app transaction
 * (config_items SELECT / INSERT / UPDATE 0010:92, config_item_versions SELECT / INSERT 0033:47), in
 * the shape of content's system switch write (row lock first, version + 1, a config_item_versions
 * row by `system` with reason `<source>:<reason>`). Only the safe direction; releasing the pause
 * stays an admin write with step-up. The payout process (couli_payout, SELECT only) never calls it.
 */
function payoutQueuePause(clock: Clock): PayoutQueuePausePort {
  return {
    async pause(trx, input) {
      const app = trx.withSchema('app');
      const at = clock.now();
      const reason = `${input.source}:${input.reason}`;
      const history = async (version: number): Promise<void> => {
        await app
          .insertInto('config_item_versions')
          .values({
            app_id: input.appId,
            key: QUEUE_PAUSED_KEY,
            version,
            value: QUEUE_PAUSED_ON,
            updated_by: 'system',
            updated_by_admin_id: null,
            reason,
            created_at: at,
          })
          .execute();
      };
      const lock = () =>
        app
          .selectFrom('config_items')
          .select(['value', 'version'])
          .where('app_id', '=', input.appId)
          .where('key', '=', QUEUE_PAUSED_KEY)
          .forUpdate()
          .executeTakeFirst();
      let before = await lock();
      if (before === undefined) {
        const inserted = await app
          .insertInto('config_items')
          .values({
            app_id: input.appId,
            key: QUEUE_PAUSED_KEY,
            value: QUEUE_PAUSED_ON,
            version: 1,
            row_version: 0,
            updated_by: 'system',
            created_at: at,
            updated_at: at,
          })
          .onConflict((oc) => oc.columns(['app_id', 'key']).doNothing())
          .returning(['version'])
          .executeTakeFirst();
        if (inserted !== undefined) {
          await history(inserted.version);
          return { changed: true };
        }
        // A concurrent first write committed in between: lock that row and decide again.
        before = await lock();
        if (before === undefined) throw new Error('payout: queue_paused row vanished');
      }
      if (before.value === true) return { changed: false };
      const updated = await app
        .updateTable('config_items')
        .set((eb) => ({
          value: QUEUE_PAUSED_ON,
          version: eb('version', '+', 1),
          row_version: eb('row_version', '+', 1),
          updated_by: 'system',
          updated_at: at,
        }))
        .where('app_id', '=', input.appId)
        .where('key', '=', QUEUE_PAUSED_KEY)
        .where('version', '=', before.version)
        .returning(['version'])
        .executeTakeFirst();
      if (updated === undefined) throw new Error('payout: locked queue_paused row changed');
      await history(updated.version);
      return { changed: true };
    },
  };
}

/**
 * B2-06f: the payout entry's ports (BR-WDR-13 / BR-WDR-14): content's configuration read straight
 * from PG on the caller's handle each time (no cache, no Redis), identity's users lock (the query
 * job's port) and the payee decryption. The member review and the persisted pause are the
 * worker's (D10-398; PayoutModule.forWorker below).
 */
/**
 * B2-02q: the audit of the daily ledger check's ledger_mismatch holds. audit_logs.admin_id is a
 * non-null reference to admin_users and a hold added by the system has no admin, so its
 * withdraw_hold.add record is an info line with the hold's ids only (as payout's B2-07c system
 * holds; the hold row keeps created_by and source_ref).
 */
function ledgerCheckHoldAudit(logger: RootLogger): AuditPort {
  return {
    append(input) {
      logger.info(
        { app_id: input.appId, actor: input.actor, action: input.action, target: input.target },
        'withdraw_hold_system_audit',
      );
      return Promise.resolve();
    },
  };
}

/**
 * B2-02q (BR-FUND-19): the worker's daily ledger check on queue ledger-check, with the two ports
 * of the B2-02p execution step: payout's withdraw holds under identity's users lock (reason
 * ledger_mismatch, created_by system, set by the execution step) and content's system switch
 * writer for settle.auto.enabled (off only; reopening stays an admin step-up write).
 */
function ledgerDailyCheckModule(): DynamicModule {
  return LedgerDailyCheckModule.forWorker({
    holds: (clock, logger) =>
      createWithdrawHolds({ clock, lockUsersForUpdate, audit: ledgerCheckHoldAudit(logger) }),
    autoSettlement: (clock, logger) => createSystemSwitchWriter({ clock, logger }),
  });
}

/**
 * B2-04zo (BR-FUND-18, BR-FUND-20): the worker's asset daily snapshot schedule, over settlement's
 * PendingEarningsSource (built per read, config reads on the snapshot's read transaction, as
 * walletSummaryDependencies does) and content's ledger.advance_alert_fen, unset = no alert.
 */
function ledgerAssetSnapshotModule(): DynamicModule {
  return LedgerAssetSnapshotModule.forWorker({
    pendingEarnings: (clock) => {
      const pendingSource = (trx: Transaction<Database>) =>
        createPendingEarningsSource({
          clock,
          config: {
            get: async (appId, key) =>
              (await createContentReader({ db: trx, clock }).configValue(appId, key))?.value,
          },
          readSnapshot: readCommissionSnapshot,
          readTljDeductFen,
        });
      return {
        readUser: (handle, input) =>
          onReadTransaction(handle, (trx) => pendingSource(trx).forUser(trx, input)),
        readAppTotals: (handle, input) =>
          onReadTransaction(handle, (trx) => pendingSource(trx).forApp(trx, input)),
      };
    },
    advanceAlertFen: (db, clock) => async (appId) => {
      // A new reader per read: a changed threshold applies to the next day at once.
      const item = await createContentReader({ db, clock }).configValue(
        appId,
        'ledger.advance_alert_fen',
      );
      return item === null ? null : parseFen(item.value);
    },
  });
}

function payoutProcessOptions(): PayoutProcessOptions {
  return {
    lockUsersForUpdate,
    config: (_db, clock) => ({
      configValue: (appId, key, handle) =>
        createContentReader({ db: handle, clock }).configValue(appId, key),
    }),
    decryptPayee: payeeDecrypt,
  };
}

function payoutModule(): DynamicModule {
  return PayoutModule.forRoot({
    rules: {
      inject: [
        CLOCK,
        ROOT_LOGGER,
        { token: DB, optional: true },
        { token: FIELD_CRYPTO, optional: true },
      ],
      useFactory: (
        clock: Clock,
        logger: RootLogger,
        db?: Kysely<Database>,
        crypto?: FieldCrypto,
      ): WithdrawRulesService | null => {
        if (db === undefined || crypto === undefined) return null;
        return createWithdrawRules(withdrawRuleOptions(clock, logger, db, crypto));
      },
    },
    // B2-05d: identity's step-up wrapper (stage ⑫ context, token consumed on code 0) is handed
    // in here so payout never imports identity's barrel (Nest controllers) into the test project.
    stepUp: withStepUp,
    // B2-05f: the snapshot decryption of the records (payout_accounts.* cipher contexts, the same
    // the binding used); registered once for read.ts, used by the two GET handlers.
    reads: payeeDecrypt,
    // The application use case runs on the idempotency claim's transaction (the controller's
    // executeInTransaction); the freeze voucher and the two events share it.
    apply: {
      inject: [
        CLOCK,
        ROOT_LOGGER,
        { token: DB, optional: true },
        { token: FIELD_CRYPTO, optional: true },
        { token: EVENT_BUS, optional: true },
      ],
      useFactory: (
        clock: Clock,
        logger: RootLogger,
        db?: Kysely<Database>,
        crypto?: FieldCrypto,
        eventBus?: EventBus,
      ): WithdrawApplyService | null => {
        if (db === undefined || crypto === undefined) return null;
        const rules = withdrawRuleOptions(clock, logger, db, crypto);
        return createWithdrawApply({
          rules,
          ledger: createLedger({
            clock,
            ...(eventBus === undefined ? {} : { eventBus }),
            balanceRecoveredHook: createBalanceRecoveredHook({ clock }),
          }),
          lockUsersForUpdate,
          snapshot: createWithdrawPayeeSnapshotReader(crypto),
          outBizNo: () => generateOutBizNo(randomBytes),
          ...(eventBus === undefined ? {} : { eventBus }),
          // B2-05q (BR-ID-36): the hit record of an application refused with 44001.
          blockedHits: withdrawBlockedHits({ db, clock, crypto, logger }),
          // B2-11a: the BR-WDR-29 snapshot at BR-WDR-03 ⑭; thresholds through content's reader on
          // the W1 transaction, ③ through risk's BR-ID-37 check judged on that transaction.
          riskFlags: createWithdrawRiskFlags({
            config: rules.config,
            logger: rules.logger,
            sameDevice: createSameDeviceAccountsCheck({
              clock,
              logger,
              logins: createSameDeviceLoginReader(),
              config: (handle) => createContentReader({ db: handle, clock }),
            }),
            facts: createWithdrawRiskFactsReader({
              shares: createBeneficiaryShareReader(),
              payeeHistory: createPayeeBindingHistoryReader(),
            }),
          }),
        });
      },
    },
  });
}

@Module({})
export class AppModule {
  static forEntry(options: PlatformOptions): DynamicModule {
    const contentReader = sharedContentReader();
    // One module object for both imports, so Nest builds the identity module once.
    const identity =
      options.entry === 'api'
        ? identityModule(contentReader)
        : options.entry === 'stream'
          ? streamIdentityModule()
          : undefined;
    const risk =
      identity === undefined
        ? undefined
        : options.entry === 'stream'
          ? streamRiskModule(identity, contentReader)
          : riskModule(identity, contentReader);
    // Stage ⑦ (B1-02zh) is not assembled on stream: it judges only x-auth login / phone / realname
    // routes, and every /v1/agent/ route is optional.
    // Stage ⑥ (B1-15m) is assembled on stream alone, in streamRiskModule's two lists.
    // One module object per import: Nest builds union and linking once. B1-22q: union reads
    // price.taobao.* (BR-PRICE-02) through content's configuration reader, per call.
    const union =
      options.entry === 'api' ||
      options.entry === 'worker' ||
      options.entry === 'stream' ||
      options.entry === 'admin'
        ? UnionModule.forRoot(undefined, { config: contentReader })
        : undefined;
    // B1-22v (D10-460): one union quota source per entry, so an entry without REDIS builds at most
    // one fallback whichever of its modules asks first.
    const unionQuotaSource = createUnionQuotaSource(options.config.appEnv);
    // B1-09n: the entry's one rebate port factory; B1-10n's rights port takes this same one.
    const rebatePort = rebatePortFactory();
    const linking =
      options.entry === 'api'
        ? LinkingModule.forRoot((db, clock) => createContentReader({ db, clock }), {
            callerContext: identityCaller,
            attrCodeReader: identityAttrCodes,
          })
        : undefined;
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(options),
        // Provides the platform AUDIT_PORT globally on every entry (F1-06b).
        AdminModule,
        ...(isHttpEntry(options.entry) ? [HealthModule] : []),
        // The /admin/v1 login routes, the admin request check and CORS policy (F1-06k); step-up
        // and me/permissions (F1-06l), whose sms tier sends through identity's SMS sender.
        ...(options.entry === 'admin' ? [adminAuthModule()] : []),
        // content's /admin/v1 routes (platform marks, F1-06w / F1-06y), guarded through
        // platform's AdminOperationGuard, which adminAuthModule provides on this entry only. Its
        // writes append audit rows through admin's writer bound to their own transaction.
        ...(options.entry === 'admin'
          ? [
              ContentAdminModule.forAdmin({
                auditWriter: (db, clock) =>
                  createAuditWriter({ db, clock, sensitiveKeys: SENSITIVE_KEYS }),
                ...contentAdminChecks(),
              }),
            ]
          : []),
        // catalog's /admin/v1 product pools (B1-05q, content.pool): guarded by AdminOperationGuard;
        // each write and its audit row commit together. Adds and re-checks read the union through
        // this entry's own governed adapters (shared quota bucket) and parsing's link resolution.
        ...(options.entry === 'admin' && union !== undefined
          ? [
              CatalogAdminModule.forAdmin({
                ports: catalogAdminPorts(union, unionQuotaSource),
                auditWriter: (db, clock) =>
                  createAuditWriter({ db, clock, sensitiveKeys: SENSITIVE_KEYS }),
                config: (db, clock) => createContentReader({ db, clock }),
                links: poolLinkParser,
              }),
            ]
          : []),
        // identity's /admin/v1 user reveal (F1-07a, BR-ID-33): guarded by AdminOperationGuard,
        // audited through the global AUDIT_PORT before the value is returned.
        // The edit of member information (B1-27b, BR-ID-44): the user fields, the old phone's
        // deleted identity, identity's revocation of every session of the user (with the push
        // token unbinding, as for a ban) and the audit row (admin's writer bound to the save's
        // transaction) commit together; risk's blocklist refuses a listed number (44001).
        ...(options.entry === 'admin'
          ? [
              IdentityAdminModule.forAdmin({
                auditWriter: (db, clock) =>
                  createAuditWriter({ db, clock, sensitiveKeys: SENSITIVE_KEYS }),
                revokeSessions: (clock) => (trx, input) =>
                  revokeSessionsByUser(trx, input, clock, unbindRevoked(sessionPushTokens(clock))),
                blocklist: (deps) => createBlocklistService(deps),
                // B1-27a (BR-ID-25 细则「实名更正」): payout's readers judge the non-terminal
                // withdrawals (30419) and the paid-out ones (the old identity's isolated copy).
                withdrawals: (clock) => createWithdrawalInFlightReader({ clock }),
                idNoBlocklist: correctionIdNoBlocklist,
                priorIdentityCrypto: PRIOR_IDENTITY_FIELD_CRYPTO,
                // B1-27c (BR-ID-40 细则「企业微信会话交付的下载」「重新登记与登记人停用」): admin's reads
                // of the registrants and content's working-day calendar.
                dataCopyRegistrants,
                dataCopyCalendar: (db, clock) => {
                  const reader = createContentReader({ db, clock });
                  return { configValue: (appId, key) => reader.configValue(appId, key) };
                },
              }),
            ]
          : []),
        // linking's /admin/v1 union authorization management (F1-07c, BR-ID-20): guarded by
        // AdminOperationGuard; each change and its audit row (admin's writer bound to the change's
        // transaction) commit together; the reset's cooldown reads content's configuration.
        ...(options.entry === 'admin'
          ? [
              LinkingAdminModule.forAdmin({
                auditWriter: (db, clock) =>
                  createAuditWriter({ db, clock, sensitiveKeys: SENSITIVE_KEYS }),
                configReader: (db, clock) => createContentReader({ db, clock }),
              }),
            ]
          : []),
        // union's /admin/v1/union-pids (B1-22h, BR-ATTR-02, BR-ATTR-28) and /admin/v1/union-accounts
        // (B1-22d, BR-ID-24 ③): guarded by AdminOperationGuard (union.pid, union.account_auth);
        // each change and its audit row (admin's writer bound to the change's transaction) commit
        // together. The accounts read content's configuration (attr.jd.user_key_mode,
        // union.auth_alert_*); the site OAuth providers are the local / test fake only.
        ...(options.entry === 'admin'
          ? [
              UnionAdminModule.forAdmin({
                auditWriter: (db, clock) =>
                  createAuditWriter({ db, clock, sensitiveKeys: SENSITIVE_KEYS }),
                config: (db, clock) => createContentReader({ db, clock }),
              }),
            ]
          : []),
        // risk's /admin/v1 ban / unban / freeze / unfreeze (F1-07d, BR-ID-31): guarded by
        // AdminOperationGuard; the state change, identity's revocation of every session of the
        // user (with the push token unbinding, as on the api entry), linking's binding ports and
        // the audit row (admin's writer bound to the change's transaction) commit together. Its
        // risk state writer stamps REDIS so the api entry's cached states end at once.
        ...(options.entry === 'admin'
          ? [
              RiskAdminModule.forAdmin({
                auditWriter: (db, clock) =>
                  createAuditWriter({ db, clock, sensitiveKeys: SENSITIVE_KEYS }),
                revokeSessions: (clock) => (trx, input) =>
                  revokeSessionsByUser(trx, input, clock, unbindRevoked(sessionPushTokens(clock))),
                blockForBan,
                restoreAfterUnban,
              }),
            ]
          : []),
        // risk's /admin/v1 appeal console reads (B1-03zd, CT-24r; BR-ID-36): guarded by
        // AdminOperationGuard (risk.appeal, read only); identity's masked phones, normaliser and
        // phone holders, admin's display names and orders' sub-order numbers through ports; only a
        // phone lookup that finds something writes an audit row (AUDIT_PORT).
        // B1-03ze: the console writes (register, claim, resolve; risk.appeal, and risk.ban /
        // risk.freeze / risk.blocklist with their totp step-up for a revocation): each write, its
        // risk state change, linking's restoreAfterUnban and its audit rows (admin's writer bound
        // to the write's transaction) commit together; the calendar is content's reader.
        ...(options.entry === 'admin'
          ? [
              RiskAppealsAdminModule.forAdmin({
                ports: adminAppealReadPorts,
                writes: {
                  auditWriter: (db, clock) =>
                    createAuditWriter({ db, clock, sensitiveKeys: SENSITIVE_KEYS }),
                  restoreAfterUnban,
                  // appeal.resolved need_reauth: linking's Taobao binding read (SELECT only).
                  taobaoReauth: needsTaobaoReauth,
                  ports: adminAppealWritePorts,
                  config: (db, clock) => createContentReader({ db, clock }),
                },
              }),
            ]
          : []),
        // risk's /admin/v1 rule list and enable / disable (B1-03zg, CT-24f; BR-ID-36): guarded by
        // AdminOperationGuard (config.risk; the list read only, each enable / disable with its totp
        // step-up); the compare-and-set change and its audit row (admin's writer bound to the
        // change's transaction) commit together.
        ...(options.entry === 'admin'
          ? [
              RiskRulesAdminModule.forAdmin({
                auditWriter: (db, clock) =>
                  createAuditWriter({ db, clock, sensitiveKeys: SENSITIVE_KEYS }),
              }),
            ]
          : []),
        // orders' /admin/v1 claim review reads (B1-10j; BR-ATTR-30): guarded by AdminOperationGuard;
        // the applicant's masked phone through identity's port (decrypted and masked there), the
        // reviewer's display name through admin's, the evidence records' time and scene through
        // linking's. Reads only, no audit row. B1-10i: the order list and detail on the same
        // module (order.view, or user.lookup with user_id), over adminOrderPorts. B1-10m: the
        // claim item and order writes on the same module, over adminOrderWritePorts.
        ...(options.entry === 'admin'
          ? [
              OrdersAdminModule.forAdmin({
                ports: adminClaimPorts,
                orderPorts: adminOrderPorts,
                writePorts: adminOrderWritePorts,
              }),
            ]
          : []),
        // notification's /admin/v1/notify-channels (B1-12z, CT-24t; BR-TEXT-20 细则「短信渠道登记与
        // 后台渠道开关」): guarded by AdminOperationGuard; each write and its audit row (admin's
        // writer bound to the write's transaction) commit together. The registration test SMS goes
        // to the operator's verify phone, read through admin's reader; SMS_CODE previews are
        // checked against identity's BR-ID-05 code validity.
        ...(options.entry === 'admin'
          ? [
              NotificationAdminModule.forAdmin({
                auditWriter: (db, clock) =>
                  createAuditWriter({ db, clock, sensitiveKeys: SENSITIVE_KEYS }),
                verifyPhones: (db, crypto) => createAdminVerifyPhoneReader({ db, crypto }),
                testSender: notifySmsTestSender,
                codeTtlSec: SMS_CODE_LIFETIME_SECONDS,
              }),
            ]
          : []),
        // payment's /admin/v1 original-route refund (B2-15e; BR-PAY-06): guarded by
        // AdminOperationGuard (pay.refund, no step-up), under platform idempotency (subject
        // a:<admin_users.id>); the refund row, its first refund.query job and the audit row
        // (admin's writer bound to the creating transaction) commit together before the channel
        // is called. B2-15f: the pay order / anomaly reads (pay.view) and the manual settlement of
        // a needs_manual pay order (pay.resolve, step-up totp; BR-PAY-05 ③): PO2 / PO3 and the
        // audit row commit together, over content's shared configuration reader.
        ...(options.entry === 'admin'
          ? [
              PaymentModule.forAdmin({
                auditWriter: (db, clock) =>
                  createAuditWriter({ db, clock, sensitiveKeys: SENSITIVE_KEYS }),
                config: (db, clock) => contentReader(db, clock),
              }),
            ]
          : []),
        // B2-09a: ledger's R1–R3 recon diff reads (fund.recon or fund.view, read only, no audit).
        // B2-09b: the close (fund.recon, no step-up, platform idempotency): the diff row, payout's
        // release of the holds whose source is the diff (users rows locked first, one
        // withdraw_hold.release audit each) and the recon_diff_close audit row (admin's writer
        // bound to the closing transaction) commit together.
        ...(options.entry === 'admin'
          ? [
              LedgerAdminModule.forAdmin({
                // B2-12c: the manual adjustments (BR-FUND-24): the entry's ledger with the bus and
                // payout's recovery hook (D10-587); identity's users lock, deletion status and
                // deletion requests, payout's linked withdrawals, orders' order_keys and
                // notification's BALANCE_ADJUSTED inbox message, all on the caller's handle.
                adjustments: {
                  ledger: ({ clock, eventBus }) =>
                    createLedger({
                      clock,
                      eventBus,
                      balanceRecoveredHook: createBalanceRecoveredHook({ clock }),
                    }),
                  ports: {
                    lockUsers: (trx, input) => lockUsersForUpdate(trx, input),
                    userStatus: (executor, input) =>
                      createUserDeletionStatusReader({ db: executor as Kysely<Database> }).read(
                        executor,
                        { app_id: input.appId, user_ids: input.userIds },
                      ),
                    withdrawals: readWithdrawalAdjustRefs,
                    deletionOwners: readDeletionRequestOwners,
                    orderKeys: readExistingOrderKeys,
                    message: (trx, input) => recordBalanceAdjustedMessage(trx, input),
                  },
                },
                // B2-04zs: the fund ledger overview reads payout's W and P and admin's names.
                waterLevel: readAlipayWaterLevel,
                adminNames: createAdminDisplayNameReader,
                auditWriter: (db, clock) =>
                  createAuditWriter({ db, clock, sensitiveKeys: SENSITIVE_KEYS }),
                holdRelease: (clock) => ({
                  releaseBySource: (trx, input) =>
                    releaseWithdrawHoldsBySource(
                      {
                        clock,
                        lockUsersForUpdate,
                        // B2-07e: the write-off releases as `admin:<admin_users.id>` (the hold
                        // row's released_by, task §9.2); the audit row's admin_id is the account.
                        audit: adminActorAudit(
                          createAuditWriter({ db: trx, clock, sensitiveKeys: SENSITIVE_KEYS }),
                        ),
                      },
                      trx,
                      input,
                    ),
                }),
                // B2-07e (BR-WDR-08 W11, D10-428): payout's W11 on the write-off transaction —
                // users row → ledger.lockBalances, the CAS to PAID_API, the success voucher, the
                // attempt-append job for the payout process and the wallet event; the switch
                // payout.proven_success_writeoff.enabled through content's reader.
                writeOff: ({ clock, queue, eventBus, logger }) =>
                  createWithdrawalProvenSuccess({
                    ledger: createLedger({
                      clock,
                      eventBus,
                      balanceRecoveredHook: createBalanceRecoveredHook({ clock }),
                    }),
                    lockUsersForUpdate,
                    config: {
                      configValue: (appId, key, handle) =>
                        createContentReader({ db: handle, clock }).configValue(appId, key),
                    },
                    queue,
                    eventBus,
                    // B2-08b: the same port for W11's tax_ytd row; the missing-real-name throw
                    // rolls the write-off back. B2-08f: its warn line tax_ytd_identity_missing
                    // goes to the entry's logger (ids and year only), as W5's does.
                    identityKey: createRealnameIdentityKeyReader(),
                    logger: logger.child({ module: 'payout' }),
                  }),
              }),
            ]
          : []),
        // B2-09c: payout's withdrawal reads (withdraw.review or fund.view, read only, no audit):
        // the user's masked phone through identity's port, the payee snapshot decrypted only to
        // be masked (alipay / bank_card contexts of the binding; a WeChat openid is not decrypted).
        ...(options.entry === 'admin'
          ? [
              PayoutAdminModule.forAdmin({
                phones: (db, crypto) => {
                  const reader = createMaskedPhoneReader(db, crypto);
                  return (appId, userIds) => reader.maskedPhones(appId, userIds);
                },
                decryptPayee: (crypto) => payeeDecrypt.useFactory(crypto ?? undefined),
                // B2-09i: the W entry's audit record and the name of who entered it.
                auditWriter: (db, clock) =>
                  createAuditWriter({ db, clock, sensitiveKeys: SENSITIVE_KEYS }),
                adminNames: createAdminDisplayNameReader,
                // B2-09k: the review's W2 and W3 (identity's lock, the ledger with payout's recovery
                // hook, content's config read on the caller's handle).
                lockUsersForUpdate,
                ledger: ({ clock, eventBus }) =>
                  createLedger({
                    clock,
                    eventBus,
                    balanceRecoveredHook: createBalanceRecoveredHook({ clock }),
                  }),
                config: (clock) => ({
                  configValue: (appId, key, handle) =>
                    createContentReader({ db: handle, clock }).configValue(appId, key),
                }),
                // B2-09l: EXECUTE's withdrawal block, read on the caller's transaction.
                risk: (db) => createRiskStateBatchReader({ db }),
                appeal: createAppealPrevStateReader,
                // B2-09m: W8's tax_ytd row, the same port as W11.
                identityKey: createRealnameIdentityKeyReader(),
              }),
            ]
          : []),
        // B2-09d: settlement's monthly bill reads (settle.bill or fund.view, read only, no audit):
        // the bill status derived from the latest round of batches at the injected clock.
        // B2-09f: the five writes (settle.bill, step-up totp), admin's audit writer on each
        // command's transaction; content's switches read fresh on the given handle, ledger's
        // snapshot status and diff registration, commission's snapshot reads. The batches are run
        // by the worker (B2-04ze), not from here.
        ...(options.entry === 'admin'
          ? [
              SettlementAdminModule.forAdmin({
                auditWriter: (db, clock) =>
                  createAuditWriter({ db, clock, sensitiveKeys: SENSITIVE_KEYS }),
                config: (db, clock) => ({
                  get: async (appId, key) =>
                    (await createContentReader({ db, clock }).configValue(appId, key))?.value,
                }),
                snapshotStatus: getAssetSnapshotStatus,
                readSnapshot: readCommissionSnapshot,
                readTljDeductFen,
                registerDiff: registerReconDiff,
                readUnionAuthoritative: readUnionAuthoritativeOrderKeys,
                // B2-09g: the account-appeal restore (order.restore, step-up totp): identity's
                // users row lock and deletion status, commission's attribution read and event
                // writer, the ledger with the negative-balance recovery of payout. B2-09ga
                // (D10-482): the BeneficiaryGate's readers, for the member identified as a minor.
                lockUsers: lockUsersForUpdate,
                deletionStatus: (db) => createUserDeletionStatusReader({ db }),
                realnameStatus: (db) => createRealnameStatusBatchReader({ db }),
                riskState: (db) => createRiskStateBatchReader({ db }),
                minors: (crypto) => createMinorStatusBatchReader({ crypto }),
                readRestoreSnapshot: readCommissionAttribution,
                appendBeneficiaryEvent,
                ledger: ({ clock, eventBus }) =>
                  createLedger({
                    clock,
                    eventBus,
                    balanceRecoveredHook: createBalanceRecoveredHook({ clock }),
                  }),
                // B2-04zr: the operators' names on the union collection records.
                adminNames: createAdminDisplayNameReader,
              }),
            ]
          : []),
        // content's GET /v1/config (F1-02c): agent availability and the h5_release bucket read
        // identity's request viewer (token principal, else the X-App-Id guest). GET
        // /v1/pages/{page_key} (F1-09d) reads the same viewer for its login condition.
        ...(options.entry === 'api'
          ? [
              ContentPublicModule.forApi({
                viewerContext: identityViewer,
                contentReader: {
                  inject: [CLOCK, { token: DB, optional: true }],
                  useFactory: (clock: Clock, db?: Kysely<Database>): ContentReader | null =>
                    db === undefined ? null : contentReader(db, clock),
                },
                // F1-09g: page audience facts over linking's binding projection and identity's
                // order count (both scoped by app_id and user_id).
                audienceReads: {
                  inject: [APP_CONFIG, CLOCK, { token: DB, optional: true }],
                  useFactory: (
                    appConfig: AppConfig,
                    clock: Clock,
                    db?: Kysely<Database>,
                  ): PageAudienceReads | null =>
                    db === undefined
                      ? null
                      : pageAudienceReads(db, contentReader(db, clock), appConfig, clock),
                },
                // F1-02zp / B1-35: GET /v1/config's invite.reward_enabled reads growth's available
                // total budget (total − reserved − granted), config_items on its own read transaction.
                inviteRewardBudget: {
                  inject: [CLOCK, { token: DB, optional: true }],
                  useFactory: (clock: Clock, db?: Kysely<Database>) =>
                    db === undefined
                      ? null
                      : createInviteRewardBudgetReader({ db, config: transactionConfig(clock) }),
                },
              }),
              NotificationModule.forApi((db, clock) => createContentReader({ db, clock })),
              // GET /v1/orders and /v1/orders/{order_id} over the shared OrderQueries (B1-08l):
              // content's configuration reader and linking's order-link reader as its ports.
              // GET /v1/orders/pending-tracks and its dismiss (B1-08m) over linking's open
              // attempts port. POST /v1/orders/claims settles claim evidence (B1-10c) over
              // linking's raw reads and catalog's platforms on its acceptance transaction.
              // GET /v1/orders?scope=self's claim_entry_pinned (B1-10h, BR-ATTR-17) over linking's
              // claim-entry reader (link_logs jump-outs, union_bindings).
              OrdersModule.forRoot({
                config: (db, clock) => createContentReader({ db, clock }),
                figures: orderFiguresReader,
                links: (db) => createOrderLinkReader(db),
                claimEntry: (db) => createClaimEntryReader(db),
                attempts: (db) => createPendingAttemptStore(db),
                evidence: claimEvidencePorts,
              }),
            ]
          : []),
        ...(identity === undefined || risk === undefined ? [] : [identity, risk]),
        ...(options.entry === 'api' && risk !== undefined ? [identityMePorts(risk)] : []),
        // growth's POST /v1/me/inviter (B1-11e): on the api entry, beside identity and risk, whose
        // global guard and idempotency post-miss hooks run stages ①–⑧ before it.
        ...(options.entry === 'api' ? [growthModule()] : []),
        // payout's GET /v1/withdrawals/rules (B2-05c): on the api entry, beside identity and risk.
        ...(options.entry === 'api' ? [payoutModule()] : []),
        // GET /v1/wallet/summary (B2-04y): ledger's read.ts query over the owners' ports.
        ...(options.entry === 'api'
          ? [WalletSummaryModule.forApi({ dependencies: walletSummaryDependencies })]
          : []),
        // GET /v1/earnings/summary (B2-13a): ledger's credited sums and settlement's order facts.
        ...(options.entry === 'api'
          ? [EarningsSummaryModule.forApi({ dependencies: earningsSummaryDependencies })]
          : []),
        // GET /v1/wallet/ledger (B2-04zc): ledger's available entries, payout's paid withdrawals and
        // settlement's order ids.
        ...(options.entry === 'api'
          ? [WalletLedgerModule.forApi({ dependencies: walletLedgerDependencies })]
          : []),
        // feedback's POST /v1/products/{product_key}/feedback (B1-28p): on the api entry, beside
        // identity and risk, over content's shared configuration reader (feedback.enabled,
        // feedback.daily_limit_per_device) and linking's read of app.links.
        ...(options.entry === 'api'
          ? [
              FeedbackModule.forApi({
                config: (db, clock) => contentReader(db, clock),
                links: feedbackLinks,
                accounts: feedbackAccounts,
              }),
            ]
          : []),
        // payment's /v1/pay/orders routes (B2-15b): on the api entry, over content's shared
        // configuration reader (pay.enabled, pay.channel_enabled.*, pay.biz.*.platforms,
        // pay.order_ttl_minutes, pay.query_schedule, pay.<pay_channel>.success_states). B2-15c:
        // the channel notification entry POST /notify/pay/<channel> too, in a process with a
        // database (outside the client contract; nothing to verify or keep without one).
        ...(options.entry === 'api'
          ? [
              PaymentModule.forApi({
                config: (db, clock) => contentReader(db, clock),
                notifyEntry: options.dbHandles !== undefined,
              }),
            ]
          : []),
        ...(union === undefined ? [] : [union]),
        // The ledger posting port (B2-02f) on every entry that books money: settlement (worker),
        // withdrawals (api, payout) and adjustments (admin); the stream entry books nothing.
        ...(options.entry === 'stream' ? [] : [LedgerModule.forRoot()]),
        // payout's recovery port for that ledger (B2-05k, BR-WDR-05 (a)): the posting that takes a
        // member's available back to >= 0 clears the member's NEGATIVE_BALANCE blocks.
        ...(options.entry === 'stream' ? [] : [PayoutModule.recovery()]),
        // The payout process's queue `payout` (B2-06f, BR-WDR-13 / BR-WDR-14): the runtime under
        // payoutRuntimeToken(); entry.ts starts it with the PAYOUT_MODE decision before the queue.
        ...(options.entry === 'payout' ? [PayoutModule.forPayout(payoutProcessOptions())] : []),
        // Freeze expiry and the daily risk alerts (BR-ID-36, B1-03j): the risk-scan queue's
        // handler, worked by the worker entry only; entry.ts seeds the chain after the queue starts.
        ...(options.entry === 'worker'
          ? [
              // B1-03z: appeal.resolved → appeal_restore differences of revoked ban appeals
              // (BR-FUND-22 / BR-CALC-13 细则「申诉恢复」) over commission's read-only ports and
              // ledger's FORFEIT voucher amount (D10-432).
              RiskScanModule.forWorker({
                appealRestoreShares: listBannedForfeitedShares,
                appealRestoreRunStart: findBannedRunStart,
                appealRestoreForfeitedAmount: readForfeitAmount,
              }),
              // payment's queue `pay` (B2-15c / B2-15d / B2-15e): order.query (the result judgement and
              // the query rhythm), biz.reconcile (the business object's fulfilment), order.close (the
              // close flow) and refund.query (the refund result, reading pay.<pay_channel>.refund_*_states)
              // over content's shared configuration reader.
              PaymentModule.forWorker({ config: (db, clock) => contentReader(db, clock) }),
              // B3-08k: content's reads for the sweeper's daily limits, assembled here.
              agentReaders('worker', contentReader),
              AgentModule.forWorker(),
              // risk.state_changed → RISK_STATE_CHANGED inbox message (B1-12g, BR-TEXT-23).
              // Its unbanned {need_reauth} reads linking's Taobao binding port (SELECT only).
              // B1-12u: wallet.withdrawal_changed → WD_SUCCESS / WD_REJECTED / WD_FAILED (BR-TEXT-09,
              // BR-WDR-26) over notification's push sending core (workerPushSendCore).
              NotificationModule.forWorker({
                taobaoReauthReader: needsTaobaoReauth,
                pushSendCore: workerPushSendCore(options.config),
              }),
              // account.went_negative → the member's withdrawals re-checked under the locks
              // (B2-05e, BR-WDR-05 (a)); payout_attempts read through payout's own store (B2-06c).
              // B2-11c (BR-WDR-30): withdrawal.created → the automatic payout decision; B2-06f
              // (D10-398): the transfer review (payout-review, BR-WDR-13 ③ under the users lock) and the
              // persisted pause (payout-landing `pause`) on couli_app.
              PayoutModule.forWorker({
                lockUsersForUpdate,
                // B2-08b (BR-WDR-20, D10-181 ①): identity's realname-identity-key port — the
                // landing job keeps tax_ytd per verified real name (payout imports no identity).
                identityKey: createRealnameIdentityKeyReader(),
                attempts: createPayoutAttemptsStore(),
                // B2-09p (BR-WDR-10, D10-619): the system rejection's audit record.
                systemAudit: (clock) =>
                  createSystemAuditWriter({ clock, sensitiveKeys: SENSITIVE_KEYS }),
                autoPayout: autoPayoutPorts,
                config: (_db, clock) => ({
                  configValue: (appId, key, handle) =>
                    createContentReader({ db: handle, clock }).configValue(appId, key),
                }),
                risk: {
                  read: (executor, input) =>
                    createRiskStateBatchReader({ db: executor }).read(executor, input),
                },
                appeal: createAppealPrevStateReader(),
                pauseQueue: payoutQueuePause,
              }),
              // B2-02q (BR-FUND-19): the daily ledger check at 01:00 +08:00 for D−1 (queue
              // ledger-check), its seed / heal timer and the B2-02p ports assembled above.
              ledgerDailyCheckModule(),
              // B2-04zo (BR-FUND-18): the asset daily snapshot timer, D+1 00:01 +08:00 per app.
              ledgerAssetSnapshotModule(),
              // B2-04ze (D10-443): settlement's queue settle (bill / batch_execute), its daily bill
              // seed and due batch scan, over the owners' exports. readAttribution must be
              // commission's readCommissionAttribution (HANDOFF 10-27). Switches as they are:
              // content's stored value, credit.enabled.<platform> unset = off, so nothing credits
              // by default.
              settlementWorkerModule(),
              // Admin data exports (B1-34e, BR-ID-42): the export queue's generate / expire
              // handler over identity's batch users projection (decrypted and masked there) and
              // content's configuration reader (admin.export.* overrides of the code defaults).
              // Nothing is seeded: jobs come from the creating and the done transactions.
              ExportWorkerModule.forWorker({
                users: (db, crypto) => createExportUsersReader({ db, crypto }),
                // B2-08e (BR-WDR-21): the quarterly tax detail, both ports on the field cipher.
                tax: (crypto) => ({
                  withdrawals: createTaxExportReader({
                    decrypt: payeeDecrypt.useFactory(crypto)!,
                  }),
                  realnames: createRealnameExportBatchReader({ crypto }),
                }),
                config: (db, clock) => createContentReader({ db, clock }),
                configPermissions: new Map(
                  configRegistry().map((item) => [item.key, item.permission]),
                ),
              }),
              // The site union authorization check (B1-22b, BR-ID-24): the union-auth queue's
              // handler, its chain seed and self-heal timer; alerts through notification's port
              // and the entry's template SMS sender (B1-12y: the Aliyun channel by registration on
              // staging / prod with the SMS_ variables; the fake in local / test; a rejecting
              // sender announced once otherwise).
              UnionAuthModule.forWorker({
                config: (db, clock) => createContentReader({ db, clock }),
                alerts: ({ db, clock, logger, appEnv }) =>
                  createSiteAuthAlertPort({
                    db,
                    clock,
                    logger,
                    sms: siteAuthSmsSender(options.config, appEnv, db, clock, logger),
                  }),
              }),
            ]
          : []),
        // The scheduled takeover / recheck of the paid bank-card verification records (B1-13g,
        // BR-WDR-02 ⑦): worker entry only, without the HTTP IdentityModule; entry.ts starts the
        // timer after the risk-scan heal and stops it first on shutdown.
        // B1-27h: the same module also works the data-copy queue (personal information copies,
        // BR-ID-40): generation and delivery over the copy sources, the extraction code SMS, the
        // inbox message and admin's audit writer assembled here (dataCopyPorts).
        ...(options.entry === 'worker'
          ? [
              IdentityWorkerModule.forWorker({
                payoutAccountConfig,
                dataCopy: dataCopyPorts(options.config),
                // B1-02zw: the Apple revocation of a console phone change, on the data-copy queue.
                apple: deletionAppleRevoker,
              }),
            ]
          : []),
        // Scheduled page publish due jobs (F1-09p): the page-schedule queue's handler, worked by the
        // worker entry only; the admin entry's publish enqueues them in its write transaction.
        ...(options.entry === 'worker' ? [ContentWorkerModule.forWorker()] : []),
        // The cooling-period expiry of deletion requests (B1-15f, BR-ID-27): worker entry only;
        // entry.ts starts its 60-second timer after the payout verification recheck. The same
        // timer's round first processes the requests in processing (B1-15g: cleanup, Apple, done).
        ...(options.entry === 'worker'
          ? [
              IdentityDeletionExpiryModule.forWorker({
                calendarConfig: deletionCalendarConfig,
                withdrawals: deletionWithdrawals,
                balance: deletionBalance,
                cleanup: deletionCleanupPorts,
                funds: deletionClosingAdjustment,
                closingPrefill: deletionClosingPrefill,
                apple: deletionAppleRevoker,
                afterRevoked: deletionAfterRevoked,
                deletionProgress: deletionProgressNotice,
              }),
            ]
          : []),
        // growth's invite reward scanner (B1-35, BR-INV-24): worker entry only; entry.ts starts its
        // 60-second loop after the queue runs and stops it first on shutdown.
        ...(options.entry === 'worker' ? [inviteRewardWorkerModule()] : []),
        // Order sync (B1-08n): the order-sync handler and its scheduler, worked by the worker
        // entry only over its own governed union adapters; entry.ts starts the scheduler after
        // the queue runs. B1-08w: with commission's snapshot port, so step ⑥ and the snapshot
        // compensation retry (its 15-minute scan, started with the scheduler) run here. B1-09n:
        // with settlement's rebate port and risk's blacklist step.
        ...(options.entry === 'worker' && union !== undefined
          ? [orderSyncWorker(union, unionQuotaSource, rebatePort)]
          : []),
        // catalog's product pool refresh (B1-05r, BR-PRICE-11): queue pool-refresh and its seed
        // timer, worker entry only, on this entry's own governed adapters (shared quota bucket).
        // Its handler also works the promotion link prefetch jobs (B1-06zd).
        ...(options.entry === 'worker' && union !== undefined
          ? [
              CatalogWorkerModule.forWorker({
                ports: catalogWorkerPorts(union, unionQuotaSource),
                config: (db, clock) => createContentReader({ db, clock }),
              }),
            ]
          : []),
        // B3-03j: the Agent's business ports (union / catalog / linking / parsing) and its
        // production assembly; B3-03m: input check and sentence review over the Aliyun content
        // safety review (fail-closed without its configuration); model routing stays minimal
        // (B3-03k). B3-08k: the content, caller and consent readers agent reads through.
        ...(options.entry === 'stream' && union !== undefined
          ? [
              agentStreamPorts(union, unionQuotaSource),
              agentReaders('stream', contentReader),
              AgentModule.forStream({
                assembly: createProductionStreamAssembly,
                safety: agentStreamSafety(options.config),
              }),
            ]
          : []),
        ...(options.entry === 'api' && union !== undefined && linking !== undefined
          ? [
              catalogPorts(union, linking, unionQuotaSource),
              CatalogModule.forRoot((db, clock) => createContentReader({ db, clock }), {
                viewerContext: identityViewer,
                sectionPages,
                feedLinkRegistrar,
              }),
              linking,
              parsingPorts(),
              // createParsing from parsing's public surface, so the route builds its service
              // through index.ts like any other caller.
              ParsingModule.forRoot((db, clock) => createContentReader({ db, clock }), {
                createParsing,
                localItemRefCipher: processItemRefCipher,
              }),
            ]
          : []),
      ],
      providers: isHttpEntry(options.entry) ? [requestChecks(options)] : [],
    };
  }
}
