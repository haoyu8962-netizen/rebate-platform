import { type DynamicModule, type FactoryProvider, HttpException, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  EXPORT_STORE,
  FIELD_CRYPTO,
  IDEMPOTENCY,
  REDIS,
  ROOT_LOGGER,
  type AppConfig,
  type Clock,
  type ExportStore,
  type FieldCrypto,
  type Idempotency,
  type IdempotencyPostMissCheck,
  type RedisHandle,
  type RequestCheck,
  type RequestCheckInput,
  type RootLogger,
} from '../platform/index.ts';
import {
  DEVICE_SIGNING_KEYS,
  createRequestSignatureVerifier,
  type BlocklistService,
  type SmsRisk,
} from '../risk/index.ts';
import {
  H5_READ_ONLY_MSG,
  createTokenCheck,
  createTokenKeyProvider,
  createTokenService,
  createTokenVerifyKeyProvider,
  createTokenVerifyService,
  isSigningKeyProvider,
  verifyKeyConfigOf,
  type TokenKeyProvider,
  type TokenService,
  type TokenVerifyKeyConfig,
  type TokenVerifyKeyProvider,
} from './application/access-tokens.ts';
import { createConsentSignatureCheck } from './application/consent-signature.ts';
import { createConsentService, type ConsentService } from './application/consents.ts';
import {
  createLaborAgreementService,
  type LaborAgreementService,
} from './application/labor-agreement.ts';
import {
  createBindPhoneService,
  type BindPhoneService,
  type AccountAssetsPort,
  type AccountRiskPort,
} from './application/bind-phone.ts';
import { createTipsService, type TipsService } from './application/tips.ts';
import { createMeService, type MeService, type MeReadPorts } from './application/me.ts';
import {
  createPayoutAccountReader,
  type PayoutAccountConfigPort,
  type PayoutAccountReader,
} from './application/payout-account.ts';
import {
  createPayoutAccountChange,
  type PayoutAccountChange,
} from './application/payout-bank-card.ts';
import { createRealnameService, type RealnameService } from './application/realname.ts';
import {
  createDeletionRequestService,
  type DeletionRequestModuleOptions,
  type DeletionRequestService,
} from './application/deletion-request.ts';
import type { DeletionBalanceReader } from './ports/deletion-balance.ts';
import type { DeletionProgressNotice } from './ports/deletion-progress-notice.ts';
import type { WithdrawalInFlightReader } from './ports/withdrawal-in-flight.ts';
import type { RealnameVerifierPort } from './ports/realname-verifier.ts';
import type { BankCardVerifierPort, CardBinPort } from './ports/bank-card-verifier.ts';
import {
  registerLaborAgreementConfigReader,
  type LaborAgreementConfigReader,
} from './ports/labor-agreement.ts';
import { createRealnameVerifier } from './infra/fake-realname-verifier.ts';
import { createBankCardVerifier, createCardBin } from './infra/fake-bank-card-verifier.ts';
import { createRealnameReader } from './infra/realname-reader.ts';
import {
  createUpdateNicknameService,
  type UpdateNicknameService,
} from './application/update-nickname.ts';
import type { NicknameReviewPort } from './ports/nickname-review.ts';
import { createNicknameReview } from './infra/nickname-review.ts';
import { createH5TokenService, type H5TokenService } from './application/h5-token.ts';
import { STEP_UP_CHECK, createStepUpCheck } from './application/step-up-verify.ts';
import {
  IDENTITY_LEVEL_CHECKS,
  createDefaultRealnameStatusReader,
  createIdentityLevelChecks,
  type RealnameStatusReader,
} from './application/identity-level.ts';
import {
  PRIVACY_CONSENT_CHECKS,
  createPrivacyConsentChecks,
  type PrivacyConsentOptions,
} from './application/privacy-consent.ts';
import {
  DELETION_STAGE_CHECKS,
  createDeletionStageChecks,
  deletionStageChecksWithoutDatabase,
} from './application/deletion-guard.ts';
import {
  createOauthAttemptService,
  type OauthAttemptService,
} from './application/oauth-attempts.ts';
import {
  createStepUpService,
  type StepUpService,
  type ThirdPartyIdentityPort,
} from './application/step-up.ts';
import { DeviceSigningKeysService } from './application/device-signing-keys.service.ts';
import {
  DEVICE_REGISTRATION_RISK,
  INVALID_DEVICE_HASHES,
  RegisterDeviceService,
  type DeviceRegistrationPorts,
} from './application/register-device.service.ts';
import {
  createSmsCodeService,
  type SmsCodeService,
  type SmsConfigReader,
  type SmsSender,
} from './application/sms-codes.ts';
import { createLogout, type Logout } from './application/logout.ts';
import { createRefreshService, type RefreshService } from './application/refresh.ts';
import { createReverifyService, type ReverifyService } from './application/reverify.ts';
import { unbindRevoked, type SessionPushTokens } from './application/push-tokens.ts';
import { createRecordInitialLevel, type InitialLevelLog } from './application/initial-level-log.ts';
import {
  revokeSessionsByDevice,
  revokeSessionsByUser,
  type SessionRevokeReason,
} from './application/revoke-sessions.ts';
import {
  createDefaultInviteCodeFilter,
  createRegistrationService,
  type RegistrationOptions,
  type SensitiveWords,
} from './application/registration.ts';
import { createSmsLoginService, type SmsLoginService } from './application/sms-login.ts';
import {
  createLandingRegisterService,
  type LandingRegisterService,
} from './application/landing-register.ts';
import type { LandingInvitePort, LandingRegisterConfigReader } from './ports/landing-invite.ts';
import { LandingRegisterController } from './http/public/landing-register.controller.ts';
import type { FirstAppLoginReview } from './application/login-completion.ts';
import { createOauthLoginService, type OauthLoginService } from './application/oauth-login.ts';
import { identityRiskPorts, type IdentityRiskPorts } from './application/risk-ports.ts';
import { createSmsRiskPorts, type SmsRiskPorts } from './application/sms-risk-ports.ts';
import type { MinimumVersionReader } from './application/session-scope.ts';
import {
  BANK_CARD_VERIFIER,
  BIND_PHONE,
  CARD_BIN,
  CONSENTS,
  CONSENT_SIGNATURE_CHECK,
  DELETION_REQUESTS,
  H5_TOKENS,
  IDENTITY_CONFIG,
  LABOR_AGREEMENT,
  LANDING_REGISTER,
  LOGOUT,
  ME,
  ME_READ_PORTS,
  NICKNAME_REVIEW,
  OAUTH_ATTEMPTS,
  REALNAME_VERIFIER,
  SUBMIT_REALNAME,
  OAUTH_LOGIN,
  PAYOUT_ACCOUNT_CHANGE,
  PAYOUT_ACCOUNT_READER,
  REFRESH,
  REVERIFY,
  SMS_CODES,
  SMS_LOGIN,
  STEP_UP,
  THIRD_PARTY_IDENTITY,
  TIPS,
  TOKEN_CHECK,
  TOKEN_KEYS,
  TOKEN_SERVICE,
  UPDATE_NICKNAME,
} from './application/tokens.ts';
import { ConsentsController } from './http/public/consents.controller.ts';
import { BindPhoneController } from './http/public/bind-phone.controller.ts';
import { DevicesController } from './http/public/devices.controller.ts';
import { H5TokenController } from './http/public/h5-token.controller.ts';
import { OauthAttemptsController } from './http/public/oauth-attempts.controller.ts';
import { OauthLoginController } from './http/public/oauth-login.controller.ts';
import { StepUpController } from './http/public/step-up.controller.ts';
import { LogoutController } from './http/public/logout.controller.ts';
import { RefreshController } from './http/public/refresh.controller.ts';
import { ReverifyController } from './http/public/reverify.controller.ts';
import { LandingSmsCodesController } from './http/public/landing-sms-codes.controller.ts';
import { SmsCodesController } from './http/public/sms-codes.controller.ts';
import { SmsLoginController } from './http/public/sms-login.controller.ts';
import { TipsController } from './http/public/tips.controller.ts';
import { DataCopiesController } from './http/public/data-copies.controller.ts';
import {
  MY_DATA_COPIES,
  createMyDataCopies,
  type MyDataCopies,
} from './application/my-data-copies.ts';
import { MeController } from './http/public/me.controller.ts';
import { PayoutAccountController } from './http/public/payout-account.controller.ts';
import { RealnameController } from './http/public/realname.controller.ts';
import { LaborAgreementController } from './http/public/labor-agreement.controller.ts';
import { DeletionController } from './http/public/deletion.controller.ts';
import { DevicesRepository } from './infra/devices.repository.ts';
import { deviceHashOf } from './infra/login-accounts.ts';
import { createSmsSender, smsSenderToken } from './infra/fake-sms.ts';
import { loadInvalidDeviceHashSeeds } from './infra/invalid-device-hashes.ts';
import { createSessionLookup } from './infra/session-lookup.ts';
import { createSmsHmac } from './infra/sms-hmac.ts';

/**
 * The identity configuration port: business configuration by app and key (e.g.
 * sms.blocked_prefixes, BR-ID-05) and the minimum supported version that the session scope of a
 * login or refresh is judged against (BR-ID-01 细则「受限会话」, sessionScope).
 */
export type IdentityConfigReader = SmsConfigReader & MinimumVersionReader;

/**
 * withdrawalInFlight / deletionBalance (DeletionRequestModuleOptions, B1-15d): the two ports of
 * POST /v1/me/deletion, assembled by app.module (D10-97); missing → the application answers 50001.
 */
export interface IdentityModuleOptions extends DeletionRequestModuleOptions {
  /**
   * B1-02zj (D10-255 ①): 'verify' for an entry that only verifies access tokens (stream): its
   * TOKEN_KEYS hold JWT_KEY_ID and public keys only (JWT_PUBLIC_KEY_PEM, or derived from
   * JWT_PRIVATE_KEY_PEM) and its TOKEN_SERVICE refuses to sign; the step-up and h5_token issuers
   * are null. Absent: 'sign' (the api entry; JWT_PRIVATE_KEY_PEM + JWT_KEY_ID as before).
   */
  readonly tokens?: 'sign' | 'verify';
  readonly accountAssets?: Omit<FactoryProvider<AccountAssetsPort>, 'provide'>;
  readonly accountRisk?: Omit<FactoryProvider<AccountRiskPort | null>, 'provide'>;
  /**
   * Builds the identity configuration port (IdentityConfigReader): content's reader, assembled by
   * app.module (content implements the port's shape and imports nothing of identity). Null when
   * the process has no database.
   */
  readonly config: Omit<FactoryProvider<IdentityConfigReader | null>, 'provide'>;
  /**
   * Builds risk's blocklist service (B1-03d), assembled by app.module: SMS send, SMS login before
   * creating an account and the same-device limit use it (application/risk-ports.ts). Null when
   * the process has no database or field cipher; absent, the ports keep their defaults (no
   * blocklist, no release).
   */
  readonly blocklist?: Omit<FactoryProvider<BlocklistService | null>, 'provide'>;
  /**
   * Builds the payout-account configuration port (withdraw.payout_methods, the monthly change
   * limit; B1-13e): content's reader bound to the caller's handle, assembled by app.module.
   * Absent, the GET answer reads its limit from config_items directly (payout-account.ts).
   */
  readonly payoutAccountConfig?: Omit<FactoryProvider<PayoutAccountConfigPort>, 'provide'>;
  /**
   * Builds the third-party identity exchange of the step-up by re-authorization (CT-15i performs
   * the exchange and verification, BR-ID-04 细则). Absent (or null), the third-party step-up
   * answers 50305 after the attempt is consumed: no platform answer is ever faked here.
   */
  readonly thirdPartyIdentity?: Omit<FactoryProvider<ThirdPartyIdentityPort | null>, 'provide'>;
  /**
   * Builds risk's device registration ports (B1-03f: per-IP hourly cap, hot device_hash alert),
   * assembled by app.module through risk's index.ts. Absent, every registration is refused with
   * 42901 (never a registration without the cap).
   */
  readonly deviceRegistration?: Omit<FactoryProvider<DeviceRegistrationPorts>, 'provide'>;
  /**
   * Builds risk's SMS send risk (B1-03g: per-device distinct phones, per-IP sends and new accounts,
   * daily budget alerts), assembled by app.module through risk's index.ts. Absent, every SMS send
   * is refused with 42901 (never a send without the checks).
   */
  readonly smsRisk?: Omit<FactoryProvider<SmsRisk>, 'provide'>;
  /**
   * Builds the SMS sender port, assembled by app.module through identity's index.ts (as it does
   * for the admin entry). Absent, identity builds createSmsSender itself.
   */
  readonly smsSender?: Omit<FactoryProvider<SmsSender>, 'provide'>;
  /**
   * Builds the push token port (B1-12b: notification's binding and conditional unbinding
   * commands), assembled by app.module so identity never imports notification. The SMS login
   * binds through it, and logout, the refresh reuse revocation and the assembled revocation by
   * user / by device unbind through it, each in the session's own transaction. Absent (or null),
   * sessions are created and ended without touching push tokens.
   */
  readonly pushTokens?: Omit<FactoryProvider<SessionPushTokens | null>, 'provide'>;
  /**
   * Builds the real-name status port of stage ⑨ (B1-02za) and GET /v1/me, assembled by app.module
   * (the app.realname reader, B1-13d). Absent, the default reader (createDefaultRealnameStatusReader:
   * always none) is used.
   */
  readonly realnameStatus?: Omit<FactoryProvider<RealnameStatusReader>, 'provide'>;
  /**
   * The configuration readers of stage ⑦ (legal.privacy.min_version; B1-02zh): content's pooled
   * reader for the guard and a fresh reader over the claim's transaction for the post-miss check,
   * assembled by app.module. Absent or null (no database): stage ⑦ is not judged, as when
   * legal.privacy.min_version is missing.
   */
  readonly privacyConsentConfig?: Omit<FactoryProvider<PrivacyConsentOptions['config']>, 'provide'>;
  /** Register-time level log, assembled by app.module so identity never imports growth. */
  readonly initialLevelLog?: Omit<FactoryProvider<InitialLevelLog | null>, 'provide'>;
  /**
   * The registration core's invite binding port (BR-INV-06, B1-11d), assembled by app.module from
   * growth's binder so identity never imports growth. Absent or null: a new account sent with an
   * invite code answers invite_bind { failed, 50001 } with a warning, as before.
   */
  readonly inviteBinding?: Omit<FactoryProvider<RegistrationInviteBindingPort | null>, 'provide'>;
  /**
   * The first App login's landing-bind same-device review (BR-INV-09, B1-11f), assembled by
   * app.module from growth's review so identity never imports growth. The SMS and the third-party
   * login both run it in the login transaction (login-completion.ts selects the first App login of
   * a landing-bound account). Absent or null: no review (the relation stays).
   */
  readonly firstAppLoginReview?: Omit<FactoryProvider<FirstAppLoginReview | null>, 'provide'>;
  /**
   * The labor agreement's configuration reader (BR-WDR-31, B1-13h), assembled by app.module from
   * content's reader bound to the caller's handle (no second connection, no cache), so identity
   * never reads config_items. Also registered for the withdrawal port laborAgreementSigned. Absent
   * or null: GET and signature answer 50001 with a warning, the port rejects.
   */
  readonly laborAgreementConfig?: Omit<
    FactoryProvider<LaborAgreementConfigReader | null>,
    'provide'
  >;
  /**
   * growth's landing channel (B1-11h: the invite precheck before the SMS code and the binding in
   * the registration transaction), assembled by app.module so identity never imports growth.
   * Absent or null: POST /v1/invites/landing-register answers 50001.
   */
  readonly landingInvite?: Omit<FactoryProvider<LandingInvitePort | null>, 'provide'>;
  /**
   * The landing registration's configuration reader (legal versions, landing.ip_register_limit;
   * B1-11h): content's reader bound to the caller's handle, uncached, assembled by app.module so
   * identity never reads config_items. Absent or null: the route answers 50001.
   */
  readonly landingConfig?: Omit<FactoryProvider<LandingRegisterConfigReader | null>, 'provide'>;
}

/** RegistrationOptions['bindInvite'] as app.module assembles it (IdentityModuleOptions.inviteBinding). */
export type RegistrationInviteBindingPort = NonNullable<RegistrationOptions['bindInvite']>;

const REALNAME_STATUS_READER = Symbol('REALNAME_STATUS_READER');
const PRIVACY_CONSENT_CONFIG = Symbol('PRIVACY_CONSENT_CONFIG');

/** Revocation by user as assembled (Nest token: the function revokeSessionsByUser itself). */
export type AssembledRevokeByUser = (
  trx: Transaction<Database>,
  input: { app_id: string; user_id: string; reason: SessionRevokeReason },
) => Promise<string[]>;

/** Revocation by device as assembled (Nest token: the function revokeSessionsByDevice itself). */
export type AssembledRevokeByDevice = (
  trx: Transaction<Database>,
  input: { app_id: string; device_id: string; reason: SessionRevokeReason },
) => Promise<string[]>;

/** The ports without risk's assembly: refuse like an unavailable store (Retry-After 1). */
const REFUSING_DEVICE_REGISTRATION: DeviceRegistrationPorts = {
  reserve: () => Promise.resolve({ code: 42901, retryAfterSec: 1 }),
  release: () => Promise.resolve(),
  reconcile: () => Promise.resolve(),
  recordSuccess: () => Promise.resolve(),
};

/** The SMS send risk without risk's assembly: refuse like an unavailable store (Retry-After 1). */
const REFUSING_SMS_RISK: SmsRisk = {
  admit: () => Promise.resolve({ code: 42901, retryAfterSec: 1 }),
  checkAttempts: () => Promise.resolve({ code: 42901, retryAfterSec: 1 }),
  admitAttempt: () => Promise.resolve({ code: 42901, retryAfterSec: 1 }),
  admitDevice: () => Promise.resolve({ code: 42901, retryAfterSec: 1 }),
  finishAttempt: () => Promise.resolve(),
  recordAccepted: () => Promise.resolve(),
  recordRegistered: () => Promise.resolve(),
};

/**
 * 10403 with data.reason=h5_read_only (BR-ID-32 细则「只读作用域」) as an HttpException, which the
 * global error filter writes back with its data (a RequestRejection carries no data).
 */
function h5ReadOnlyRejection(request: RequestCheckInput): HttpException {
  return new HttpException(
    {
      code: 10403,
      msg: H5_READ_ONLY_MSG,
      data: { reason: 'h5_read_only' },
      trace_id: request.id,
    },
    403,
  );
}

/**
 * Identity (规划/02 §4.1): devices, SMS codes, SMS login (B1-02j), session tokens, refresh rotation
 * (B1-02k), logout, and (B1-02f) third-party authorization attempts, step-up, h5_token and consent
 * records, and (B1-02s) the one-time tip read states. Served by the `api` entry (/v1). The database handle, the field cipher
 * and Redis are optional at construction so that entries built without them (isolated HTTP unit
 * tests) still register the routes; a request that needs them fails at request time instead
 * (50001).
 * Exports the risk module's DEVICE_SIGNING_KEYS port (request signatures, BR-ID-09); app.module
 * passes this module to RiskModule.
 * Exports CONSENT_SIGNATURE_CHECK (B1-02zc), recordConsent's clipboard_auto_import signature,
 * which app.module places between the signature check and the token check.
 * Exports TOKEN_CHECK, the token stages ② ③ (BR-ID-01) that app.module places right after the
 * signature check in the api entry's REQUEST_CHECKS.
 * Push tokens (B1-12b): app.module hands in notification's commands as the push token port
 * (options.pushTokens); login binds, logout / reuse / revocation by user or device unbind, each in
 * the session's transaction. The assembled revocation entries are provided under the tokens
 * revokeSessionsByUser / revokeSessionsByDevice (the functions index.ts exports).
 * SMS: the sender under smsSenderToken() is the fake adapter in local / test (its outbox is the
 * only way to read a code there); the code service needs Redis and the configuration reader.
 * Tokens: the signing key (TOKEN_KEYS) is the configured JWT_* key, or one ephemeral key pair per
 * process in local / test; staging / prod without a key refuse to start. Its factory waits for
 * FIELD_CRYPTO (injected only for that), so a keyring that fails to open is the startup error an
 * entry reports, not the missing JWT key of the same environment.
 * B1-02zj (D10-255 ①): with options.tokens 'verify' (stream) TOKEN_KEYS hold public keys only and
 * TOKEN_SERVICE never signs (verifyOnlyKeys below); staging / prod then need JWT_KEY_ID and
 * JWT_PUBLIC_KEY_PEM (or the private key it is derived from), never the private key itself.
 */
/** The invite-code sensitive-word filter of the registration core (createDefaultInviteCodeFilter). */
const INVITE_CODE_WORDS = Symbol('INVITE_CODE_WORDS');
/** risk's blocklist service as app.module builds it (IdentityModuleOptions.blocklist), or null. */
const BLOCKLIST_SERVICE = Symbol('IDENTITY_BLOCKLIST_SERVICE');
/** identity's ports onto risk's blocklist (identityRiskPorts), or null without one. */
const RISK_PORTS = Symbol('IDENTITY_RISK_PORTS');
/** risk's SMS send risk as app.module builds it (IdentityModuleOptions.smsRisk). */
const SMS_RISK = Symbol('IDENTITY_SMS_RISK');
/** identity's ports onto risk's SMS send risk (createSmsRiskPorts). */
const SMS_RISK_PORTS = Symbol('IDENTITY_SMS_RISK_PORTS');
/** The push token port as app.module builds it (IdentityModuleOptions.pushTokens), or null. */
const PUSH_TOKENS = Symbol('IDENTITY_PUSH_TOKENS');
const INITIAL_LEVEL_LOG = Symbol('IDENTITY_INITIAL_LEVEL_LOG');
const INVITE_BINDING = Symbol('IDENTITY_INVITE_BINDING');
const FIRST_APP_LOGIN_REVIEW = Symbol('IDENTITY_FIRST_APP_LOGIN_REVIEW');
const ACCOUNT_ASSETS = Symbol('IDENTITY_ACCOUNT_ASSETS');
const ACCOUNT_RISK = Symbol('IDENTITY_ACCOUNT_RISK');
const LABOR_AGREEMENT_CONFIG = Symbol('IDENTITY_LABOR_AGREEMENT_CONFIG');
/** The payout-account configuration port (IdentityModuleOptions.payoutAccountConfig), or null. */
const PAYOUT_ACCOUNT_CONFIG = Symbol('IDENTITY_PAYOUT_ACCOUNT_CONFIG');
/** The in-flight withdrawal port (IdentityModuleOptions.withdrawalInFlight), or null. */
const WITHDRAWAL_IN_FLIGHT = Symbol('IDENTITY_WITHDRAWAL_IN_FLIGHT');
/** The deletion-time balance port (IdentityModuleOptions.deletionBalance), or null. */
const DELETION_BALANCE = Symbol('IDENTITY_DELETION_BALANCE');
/** The DELETION_PROGRESS inbox notice (IdentityModuleOptions.deletionProgress, B1-15i), or null. */
const DELETION_PROGRESS = Symbol('IDENTITY_DELETION_PROGRESS');
/** growth's landing channel (IdentityModuleOptions.landingInvite), or null. */
const LANDING_INVITE = Symbol('IDENTITY_LANDING_INVITE');
/** The landing configuration reader (IdentityModuleOptions.landingConfig), or null. */
const LANDING_CONFIG = Symbol('IDENTITY_LANDING_CONFIG');

/**
 * The signing key of the api entry (B1-02h): JWT_PRIVATE_KEY_PEM + JWT_KEY_ID, an ephemeral pair in
 * local / test without any JWT_* variable. B1-02zj: a configuration that only verifies
 * (JWT_PUBLIC_KEY_PEM without the private key: `jwt` null, `jwtVerify` set) is refused in every
 * environment, never replaced by an ephemeral key.
 */
function signingKeys(config: AppConfig): Promise<TokenKeyProvider> {
  if ((config.jwt ?? null) === null && (config.jwtVerify ?? null) !== null) {
    return Promise.reject(
      new Error(
        `JWT_PRIVATE_KEY_PEM must be set for an entry that signs access tokens (APP_ENV=${config.appEnv}); JWT_PUBLIC_KEY_PEM only verifies`,
      ),
    );
  }
  return createTokenKeyProvider(config.appEnv, config.jwt ?? null);
}

/**
 * The keys of an entry that only verifies (B1-02zj, D10-255 ①): `jwtVerify` (loadConfig), or the
 * public half of a hand-built `jwt`. Local / test without any JWT_* configuration keep the existing
 * per-process ephemeral key pair (no configured key exists to protect, and in-process fixtures
 * sign through this entry's TOKEN_SERVICE); staging / prod without one refuse to start, naming
 * JWT_PUBLIC_KEY_PEM.
 */
async function verifyOnlyKeys(
  config: AppConfig,
): Promise<TokenKeyProvider | TokenVerifyKeyProvider> {
  const signing = config.jwt ?? null;
  const verifying: TokenVerifyKeyConfig | null =
    config.jwtVerify ?? (signing === null ? null : verifyKeyConfigOf(signing));
  if (verifying === null && (config.appEnv === 'local' || config.appEnv === 'test')) {
    return createTokenKeyProvider(config.appEnv, null);
  }
  return createTokenVerifyKeyProvider(config.appEnv, verifying);
}

/**
 * Stage ⑫ on a verify-only entry: never assembled there (step-up stays off stream); if it ever
 * were, it fails closed instead of judging step-up tokens without the api's wiring.
 */
const verifyOnlyStepUpCheck: IdempotencyPostMissCheck = () =>
  Promise.reject(new Error('STEP_UP_CHECK is not available on an entry that only verifies tokens'));

@Module({})
export class IdentityModule {
  static forRoot(options: IdentityModuleOptions): DynamicModule {
    return {
      module: IdentityModule,
      controllers: [
        BindPhoneController,
        DevicesController,
        SmsCodesController,
        LandingSmsCodesController,
        LandingRegisterController,
        SmsLoginController,
        OauthLoginController,
        RefreshController,
        LogoutController,
        OauthAttemptsController,
        StepUpController,
        H5TokenController,
        ConsentsController,
        TipsController,
        MeController,
        RealnameController,
        ReverifyController,
        LaborAgreementController,
        PayoutAccountController,
        DeletionController,
        DataCopiesController,
      ],
      providers: [
        options.withdrawalInFlight === undefined
          ? { provide: WITHDRAWAL_IN_FLIGHT, useValue: null }
          : { ...options.withdrawalInFlight, provide: WITHDRAWAL_IN_FLIGHT },
        options.deletionBalance === undefined
          ? { provide: DELETION_BALANCE, useValue: null }
          : { ...options.deletionBalance, provide: DELETION_BALANCE },
        options.deletionProgress === undefined
          ? { provide: DELETION_PROGRESS, useValue: null }
          : { ...options.deletionProgress, provide: DELETION_PROGRESS },
        {
          // GET / POST /v1/me/deletion, POST /v1/me/deletion/cancel (B1-15d, BR-ID-27).
          provide: DELETION_REQUESTS,
          inject: [
            CLOCK,
            WITHDRAWAL_IN_FLIGHT,
            DELETION_BALANCE,
            DELETION_PROGRESS,
            { token: DB, optional: true },
          ],
          useFactory: (
            clock: Clock,
            withdrawalInFlight: WithdrawalInFlightReader | null,
            balance: DeletionBalanceReader | null,
            notice: DeletionProgressNotice | null,
            db?: Kysely<Database>,
          ): DeletionRequestService | null =>
            db === undefined
              ? null
              : createDeletionRequestService({
                  db,
                  clock,
                  withdrawalInFlight: withdrawalInFlight ?? null,
                  balance: balance ?? null,
                  notice: notice ?? null,
                }),
        },
        options.accountAssets === undefined
          ? { provide: ACCOUNT_ASSETS, useValue: null }
          : { ...options.accountAssets, provide: ACCOUNT_ASSETS },
        options.laborAgreementConfig === undefined
          ? { provide: LABOR_AGREEMENT_CONFIG, useValue: null }
          : { ...options.laborAgreementConfig, provide: LABOR_AGREEMENT_CONFIG },
        options.accountRisk === undefined
          ? { provide: ACCOUNT_RISK, useValue: null }
          : { ...options.accountRisk, provide: ACCOUNT_RISK },
        options.landingInvite === undefined
          ? { provide: LANDING_INVITE, useValue: null }
          : { ...options.landingInvite, provide: LANDING_INVITE },
        options.landingConfig === undefined
          ? { provide: LANDING_CONFIG, useValue: null }
          : { ...options.landingConfig, provide: LANDING_CONFIG },
        {
          provide: BIND_PHONE,
          inject: [
            CLOCK,
            SMS_CODES,
            BLOCKLIST_SERVICE,
            ACCOUNT_ASSETS,
            ACCOUNT_RISK,
            { token: FIELD_CRYPTO, optional: true },
            { token: REDIS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            sms: SmsCodeService | null,
            blocklist: BlocklistService | null,
            assets: AccountAssetsPort | null,
            risk: AccountRiskPort | null,
            crypto?: FieldCrypto,
            redis?: RedisHandle,
          ): BindPhoneService | null =>
            sms === null ||
            assets === null ||
            risk === null ||
            crypto === undefined ||
            redis === undefined
              ? null
              : createBindPhoneService({ clock, sms, blocklist, assets, risk, crypto, redis }),
        },
        // Read once while the entry starts; a missing or malformed list stops the entry.
        { provide: INVALID_DEVICE_HASHES, useFactory: () => loadInvalidDeviceHashSeeds() },
        DevicesRepository,
        options.deviceRegistration === undefined
          ? { provide: DEVICE_REGISTRATION_RISK, useValue: REFUSING_DEVICE_REGISTRATION }
          : { ...options.deviceRegistration, provide: DEVICE_REGISTRATION_RISK },
        RegisterDeviceService,
        DeviceSigningKeysService,
        { provide: DEVICE_SIGNING_KEYS, useExisting: DeviceSigningKeysService },
        { ...options.config, provide: IDENTITY_CONFIG },
        options.blocklist === undefined
          ? { provide: BLOCKLIST_SERVICE, useValue: null }
          : { ...options.blocklist, provide: BLOCKLIST_SERVICE },
        options.payoutAccountConfig === undefined
          ? { provide: PAYOUT_ACCOUNT_CONFIG, useValue: null }
          : { ...options.payoutAccountConfig, provide: PAYOUT_ACCOUNT_CONFIG },
        options.pushTokens === undefined
          ? { provide: PUSH_TOKENS, useValue: null }
          : { ...options.pushTokens, provide: PUSH_TOKENS },
        options.initialLevelLog === undefined
          ? { provide: INITIAL_LEVEL_LOG, useValue: null }
          : { ...options.initialLevelLog, provide: INITIAL_LEVEL_LOG },
        options.inviteBinding === undefined
          ? { provide: INVITE_BINDING, useValue: null }
          : { ...options.inviteBinding, provide: INVITE_BINDING },
        options.firstAppLoginReview === undefined
          ? { provide: FIRST_APP_LOGIN_REVIEW, useValue: null }
          : { ...options.firstAppLoginReview, provide: FIRST_APP_LOGIN_REVIEW },
        // The internal revocation entries (merge, ban, admin revocation by user or by device), as
        // the Nest container hands them out: the provider token is identity's exported function
        // itself, the value takes only (trx, input) — the Clock and the push token unbinding of
        // every revoked session (BR-ID-07 细则「被动结束会话时解绑」) are assembled here.
        {
          provide: revokeSessionsByUser,
          inject: [CLOCK, PUSH_TOKENS],
          useFactory:
            (clock: Clock, pushTokens: SessionPushTokens | null): AssembledRevokeByUser =>
            (trx, input) =>
              revokeSessionsByUser(
                trx,
                input,
                clock,
                pushTokens === null ? undefined : unbindRevoked(pushTokens),
              ),
        },
        {
          provide: revokeSessionsByDevice,
          inject: [CLOCK, PUSH_TOKENS],
          useFactory:
            (clock: Clock, pushTokens: SessionPushTokens | null): AssembledRevokeByDevice =>
            (trx, input) =>
              revokeSessionsByDevice(
                trx,
                input,
                clock,
                pushTokens === null ? undefined : unbindRevoked(pushTokens),
              ),
        },
        {
          provide: RISK_PORTS,
          inject: [BLOCKLIST_SERVICE, { token: FIELD_CRYPTO, optional: true }],
          useFactory: (
            risk: BlocklistService | null,
            fieldCrypto?: FieldCrypto,
          ): IdentityRiskPorts | null =>
            risk === null || fieldCrypto === undefined
              ? null
              : identityRiskPorts(risk, fieldCrypto),
        },
        options.smsRisk === undefined
          ? { provide: SMS_RISK, useValue: REFUSING_SMS_RISK }
          : { ...options.smsRisk, provide: SMS_RISK },
        {
          provide: SMS_RISK_PORTS,
          inject: [SMS_RISK, ROOT_LOGGER, { token: DB, optional: true }],
          useFactory: (risk: SmsRisk, logger: RootLogger, db?: Kysely<Database>): SmsRiskPorts =>
            createSmsRiskPorts({
              risk,
              logger,
              devices: {
                deviceHashOf: async (appId, deviceId) =>
                  db === undefined ? null : ((await deviceHashOf(db, appId, deviceId)) ?? null),
              },
            }),
        },
        options.smsSender === undefined
          ? {
              provide: smsSenderToken(),
              inject: [APP_CONFIG, ROOT_LOGGER],
              useFactory: (config: AppConfig, logger: RootLogger): SmsSender =>
                createSmsSender(config.appEnv, logger),
            }
          : { ...options.smsSender, provide: smsSenderToken() },
        {
          provide: SMS_CODES,
          inject: [
            APP_CONFIG,
            CLOCK,
            ROOT_LOGGER,
            smsSenderToken(),
            IDENTITY_CONFIG,
            RISK_PORTS,
            SMS_RISK_PORTS,
            { token: REDIS, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            config: AppConfig,
            clock: Clock,
            logger: RootLogger,
            sender: SmsSender,
            reader: SmsConfigReader | null,
            risk: IdentityRiskPorts | null,
            smsRisk: SmsRiskPorts,
            redis?: RedisHandle,
            fieldCrypto?: FieldCrypto,
          ): SmsCodeService | null =>
            redis === undefined || reader === null
              ? null
              : createSmsCodeService({
                  clock,
                  redis,
                  sender,
                  config: reader,
                  logger,
                  hmac: createSmsHmac(config.appEnv, fieldCrypto),
                  hooks: { ...(risk === null ? {} : risk.smsHooks), ...smsRisk.smsHooks },
                }),
        },
        {
          provide: TOKEN_KEYS,
          // FIELD_CRYPTO is resolved first (and unused): Nest creates providers concurrently, and
          // a staging / prod entry whose keyring cannot open must fail with that error.
          inject: [APP_CONFIG, { token: FIELD_CRYPTO, optional: true }],
          useFactory: (config: AppConfig): Promise<TokenKeyProvider | TokenVerifyKeyProvider> =>
            options.tokens === 'verify' ? verifyOnlyKeys(config) : signingKeys(config),
        },
        {
          provide: TOKEN_SERVICE,
          inject: [CLOCK, TOKEN_KEYS],
          useFactory: (
            clock: Clock,
            keys: TokenKeyProvider | TokenVerifyKeyProvider,
          ): TokenService =>
            isSigningKeyProvider(keys)
              ? createTokenService({ clock, keys })
              : createTokenVerifyService({ clock, keys }),
        },
        options.realnameStatus === undefined
          ? { provide: REALNAME_STATUS_READER, useFactory: createDefaultRealnameStatusReader }
          : { ...options.realnameStatus, provide: REALNAME_STATUS_READER },
        {
          // Stages ⑧ ⑨: the guard and the post-miss check app.module hands to RiskModule.
          provide: IDENTITY_LEVEL_CHECKS,
          inject: [REALNAME_STATUS_READER, { token: DB, optional: true }],
          useFactory: (realname: RealnameStatusReader, db?: Kysely<Database>) =>
            createIdentityLevelChecks({ db: db ?? null, realname }),
        },
        {
          // Stage ⑥: the guard and the post-miss check app.module hands to RiskModule before ⑦.
          // No database: the no-database test mode (deletion-guard.ts header), not judged.
          provide: DELETION_STAGE_CHECKS,
          inject: [{ token: DB, optional: true }],
          useFactory: (db?: Kysely<Database>) =>
            db === undefined
              ? deletionStageChecksWithoutDatabase()
              : createDeletionStageChecks({ db }),
        },
        options.privacyConsentConfig === undefined
          ? { provide: PRIVACY_CONSENT_CONFIG, useFactory: () => null }
          : { ...options.privacyConsentConfig, provide: PRIVACY_CONSENT_CONFIG },
        {
          // Stage ⑦: the guard and the post-miss check app.module hands to RiskModule before ⑧ ⑨.
          provide: PRIVACY_CONSENT_CHECKS,
          inject: [PRIVACY_CONSENT_CONFIG, ROOT_LOGGER, { token: DB, optional: true }],
          useFactory: (
            config: PrivacyConsentOptions['config'],
            logger: RootLogger,
            db?: Kysely<Database>,
          ) => createPrivacyConsentChecks({ db: db ?? null, config, logger }),
        },
        {
          provide: STEP_UP_CHECK,
          inject: [TOKEN_KEYS, CLOCK, ROOT_LOGGER, { token: REDIS, optional: true }],
          useFactory: (
            keys: TokenKeyProvider | TokenVerifyKeyProvider,
            clock: Clock,
            logger: RootLogger,
            redis?: RedisHandle,
          ) =>
            isSigningKeyProvider(keys)
              ? createStepUpCheck({ keys, clock, logger, redis: redis ?? null })
              : verifyOnlyStepUpCheck,
        },
        {
          provide: TOKEN_CHECK,
          inject: [TOKEN_SERVICE, { token: DB, optional: true }],
          useFactory: (tokens: TokenService, db?: Kysely<Database>): RequestCheck =>
            createTokenCheck({
              tokens,
              sessions: createSessionLookup(db),
              readOnlyRejection: h5ReadOnlyRejection,
            }),
        },
        // Read once while the entry starts (the invite-code seed list of the registration core).
        { provide: INVITE_CODE_WORDS, useFactory: () => createDefaultInviteCodeFilter() },
        {
          provide: SMS_LOGIN,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            IDENTITY_CONFIG,
            SMS_CODES,
            TOKEN_SERVICE,
            INVITE_CODE_WORDS,
            RISK_PORTS,
            SMS_RISK_PORTS,
            PUSH_TOKENS,
            INITIAL_LEVEL_LOG,
            INVITE_BINDING,
            FIRST_APP_LOGIN_REVIEW,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            reader: IdentityConfigReader | null,
            sms: SmsCodeService | null,
            tokens: TokenService,
            sensitiveWords: SensitiveWords,
            risk: IdentityRiskPorts | null,
            smsRisk: SmsRiskPorts,
            pushTokens: SessionPushTokens | null,
            initialLevelLog: InitialLevelLog | null,
            inviteBinding: RegistrationInviteBindingPort | null,
            firstAppLoginReview: FirstAppLoginReview | null,
            db?: Kysely<Database>,
            fieldCrypto?: FieldCrypto,
          ): SmsLoginService | null =>
            db === undefined || fieldCrypto === undefined || reader === null || sms === null
              ? null
              : createSmsLoginService({
                  db,
                  clock,
                  crypto: fieldCrypto,
                  logger,
                  versions: reader,
                  sms,
                  registration: createRegistrationService({
                    clock,
                    config: reader,
                    crypto: fieldCrypto,
                    logger,
                    sensitiveWords,
                    ...(risk === null ? {} : risk.registration),
                    ...smsRisk.registration,
                    ...(initialLevelLog === null
                      ? {}
                      : { recordInitialLevel: createRecordInitialLevel(initialLevelLog) }),
                    ...(inviteBinding === null ? {} : { bindInvite: inviteBinding }),
                  }),
                  ...(risk === null ? {} : risk.login),
                  // Registration keys are snapshotted before the login transaction opens.
                  config: reader,
                  tokens,
                  ...(pushTokens === null ? {} : { pushTokens }),
                  ...(firstAppLoginReview === null ? {} : { firstAppLoginReview }),
                }),
        },
        {
          // POST /v1/invites/landing-register (B1-11h): its own registration core instance with the
          // same ports as the SMS login's, except the invite binding (the landing binding is part
          // of the landing transaction, growth's landing port, never register's best-effort port).
          provide: LANDING_REGISTER,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            IDENTITY_CONFIG,
            SMS_CODES,
            INVITE_CODE_WORDS,
            RISK_PORTS,
            SMS_RISK_PORTS,
            INITIAL_LEVEL_LOG,
            BLOCKLIST_SERVICE,
            LANDING_INVITE,
            LANDING_CONFIG,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
            { token: IDEMPOTENCY, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            reader: IdentityConfigReader | null,
            sms: SmsCodeService | null,
            sensitiveWords: SensitiveWords,
            risk: IdentityRiskPorts | null,
            smsRisk: SmsRiskPorts,
            initialLevelLog: InitialLevelLog | null,
            blocklist: BlocklistService | null,
            invite: LandingInvitePort | null,
            config: LandingRegisterConfigReader | null,
            db?: Kysely<Database>,
            fieldCrypto?: FieldCrypto,
            idempotency?: Idempotency,
          ): LandingRegisterService | null =>
            db === undefined ||
            fieldCrypto === undefined ||
            idempotency === undefined ||
            reader === null ||
            sms === null ||
            invite === null ||
            config === null
              ? null
              : createLandingRegisterService({
                  db,
                  clock,
                  crypto: fieldCrypto,
                  logger,
                  idempotency,
                  sms,
                  registration: createRegistrationService({
                    clock,
                    config: reader,
                    crypto: fieldCrypto,
                    logger,
                    sensitiveWords,
                    ...(risk === null ? {} : risk.registration),
                    ...smsRisk.registration,
                    ...(initialLevelLog === null
                      ? {}
                      : { recordInitialLevel: createRecordInitialLevel(initialLevelLog) }),
                  }),
                  registrationConfig: reader,
                  config,
                  invite,
                  blocklist,
                }),
        },
        {
          // The reuse revocation unbinds the session's push tokens (afterRevoked, B1-12b).
          provide: REFRESH,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            IDENTITY_CONFIG,
            TOKEN_SERVICE,
            PUSH_TOKENS,
            { token: DB, optional: true },
            { token: REDIS, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            reader: IdentityConfigReader | null,
            tokens: TokenService,
            pushTokens: SessionPushTokens | null,
            db?: Kysely<Database>,
            redis?: RedisHandle,
            fieldCrypto?: FieldCrypto,
          ): RefreshService | null =>
            db === undefined || redis === undefined || fieldCrypto === undefined || reader === null
              ? null
              : createRefreshService({
                  db,
                  clock,
                  tokens,
                  crypto: fieldCrypto,
                  redis,
                  versions: reader,
                  logger,
                  ...(pushTokens === null ? {} : { afterRevoked: unbindRevoked(pushTokens) }),
                }),
        },
        options.thirdPartyIdentity === undefined
          ? { provide: THIRD_PARTY_IDENTITY, useValue: null }
          : { ...options.thirdPartyIdentity, provide: THIRD_PARTY_IDENTITY },
        {
          provide: OAUTH_ATTEMPTS,
          inject: [
            CLOCK,
            IDENTITY_CONFIG,
            { token: DB, optional: true },
            { token: REDIS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            reader: IdentityConfigReader | null,
            db?: Kysely<Database>,
            redis?: RedisHandle,
          ): OauthAttemptService | null =>
            db === undefined || redis === undefined || reader === null
              ? null
              : createOauthAttemptService({ db, redis, clock, config: reader }),
        },
        {
          provide: OAUTH_LOGIN,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            IDENTITY_CONFIG,
            OAUTH_ATTEMPTS,
            THIRD_PARTY_IDENTITY,
            TOKEN_SERVICE,
            INVITE_CODE_WORDS,
            RISK_PORTS,
            SMS_RISK_PORTS,
            PUSH_TOKENS,
            INITIAL_LEVEL_LOG,
            INVITE_BINDING,
            FIRST_APP_LOGIN_REVIEW,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            reader: IdentityConfigReader | null,
            attempts: OauthAttemptService | null,
            thirdPartyIdentity: ThirdPartyIdentityPort | null,
            tokens: TokenService,
            sensitiveWords: SensitiveWords,
            risk: IdentityRiskPorts | null,
            smsRisk: SmsRiskPorts,
            pushTokens: SessionPushTokens | null,
            initialLevelLog: InitialLevelLog | null,
            inviteBinding: RegistrationInviteBindingPort | null,
            firstAppLoginReview: FirstAppLoginReview | null,
            db?: Kysely<Database>,
            fieldCrypto?: FieldCrypto,
          ): OauthLoginService | null =>
            db === undefined || fieldCrypto === undefined || reader === null || attempts === null
              ? null
              : createOauthLoginService({
                  db,
                  clock,
                  crypto: fieldCrypto,
                  logger,
                  versions: reader,
                  config: reader,
                  attempts,
                  tokens,
                  ...(thirdPartyIdentity === null ? {} : { thirdPartyIdentity }),
                  ...(pushTokens === null ? {} : { pushTokens }),
                  ...(firstAppLoginReview === null ? {} : { firstAppLoginReview }),
                  ...(risk === null ? {} : risk.oauthLogin),
                  registration: createRegistrationService({
                    clock,
                    config: reader,
                    crypto: fieldCrypto,
                    logger,
                    sensitiveWords,
                    ...(risk === null ? {} : risk.registration),
                    ...smsRisk.registration,
                    ...(initialLevelLog === null
                      ? {}
                      : { recordInitialLevel: createRecordInitialLevel(initialLevelLog) }),
                    ...(inviteBinding === null ? {} : { bindInvite: inviteBinding }),
                  }),
                }),
        },
        {
          provide: STEP_UP,
          inject: [
            CLOCK,
            IDENTITY_CONFIG,
            TOKEN_KEYS,
            SMS_CODES,
            OAUTH_ATTEMPTS,
            THIRD_PARTY_IDENTITY,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            reader: IdentityConfigReader | null,
            keys: TokenKeyProvider | TokenVerifyKeyProvider,
            sms: SmsCodeService | null,
            attempts: OauthAttemptService | null,
            thirdPartyIdentity: ThirdPartyIdentityPort | null,
            db?: Kysely<Database>,
            fieldCrypto?: FieldCrypto,
          ): StepUpService | null =>
            // A verify-only entry signs no step_up_token (B1-02zj).
            !isSigningKeyProvider(keys) ||
            db === undefined ||
            fieldCrypto === undefined ||
            reader === null ||
            sms === null ||
            attempts === null
              ? null
              : createStepUpService({
                  db,
                  clock,
                  crypto: fieldCrypto,
                  keys,
                  config: reader,
                  sms,
                  attempts,
                  ...(thirdPartyIdentity === null ? {} : { thirdPartyIdentity }),
                }),
        },
        {
          // The three interfaces of the re-verification (B1-02zp, BR-WDR-01 细则).
          provide: REVERIFY,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            OAUTH_ATTEMPTS,
            THIRD_PARTY_IDENTITY,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            attempts: OauthAttemptService | null,
            thirdPartyIdentity: ThirdPartyIdentityPort | null,
            db?: Kysely<Database>,
            fieldCrypto?: FieldCrypto,
          ): ReverifyService | null =>
            db === undefined || fieldCrypto === undefined || attempts === null
              ? null
              : createReverifyService({
                  db,
                  clock,
                  crypto: fieldCrypto,
                  logger,
                  attempts,
                  ...(thirdPartyIdentity === null ? {} : { thirdPartyIdentity }),
                }),
        },
        {
          provide: H5_TOKENS,
          inject: [CLOCK, IDENTITY_CONFIG, TOKEN_KEYS, { token: DB, optional: true }],
          useFactory: (
            clock: Clock,
            reader: IdentityConfigReader | null,
            keys: TokenKeyProvider | TokenVerifyKeyProvider,
            db?: Kysely<Database>,
          ): H5TokenService | null =>
            // A verify-only entry signs no h5_token (B1-02zj).
            !isSigningKeyProvider(keys) || db === undefined || reader === null
              ? null
              : createH5TokenService({
                  clock,
                  keys,
                  sessions: createSessionLookup(db),
                  config: reader,
                }),
        },
        {
          // recordConsent's clipboard_auto_import signature (B1-02zc): risk's single-request
          // verifier over this module's device port, the same Redis nonce store as stage ①.
          provide: CONSENT_SIGNATURE_CHECK,
          inject: [DeviceSigningKeysService, CLOCK, { token: REDIS, optional: true }],
          useFactory: (
            devices: DeviceSigningKeysService,
            clock: Clock,
            redis?: RedisHandle,
          ): RequestCheck =>
            createConsentSignatureCheck(
              createRequestSignatureVerifier({
                devices,
                clock,
                ...(redis === undefined ? {} : { redis }),
              }),
            ),
        },
        {
          provide: CONSENTS,
          inject: [CLOCK, { token: DB, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<Database>): ConsentService | null =>
            db === undefined ? null : createConsentService({ db, clock }),
        },
        {
          // GET /v1/me/data-copies and its download (B1-27i, BR-ID-40 细则「在 App 内下载」).
          provide: MY_DATA_COPIES,
          inject: [CLOCK, EXPORT_STORE, { token: DB, optional: true }],
          useFactory: (
            clock: Clock,
            store: ExportStore,
            db?: Kysely<Database>,
          ): MyDataCopies | null =>
            db === undefined ? null : createMyDataCopies({ db, clock, store }),
        },
        {
          provide: TIPS,
          inject: [CLOCK, { token: DB, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<Database>): TipsService | null =>
            db === undefined ? null : createTipsService({ db, clock }),
        },
        {
          provide: NICKNAME_REVIEW,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig): NicknameReviewPort =>
            createNicknameReview(config.appEnv),
        },
        {
          provide: UPDATE_NICKNAME,
          inject: [CLOCK, ROOT_LOGGER, NICKNAME_REVIEW, { token: DB, optional: true }],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            review: NicknameReviewPort,
            db?: Kysely<Database>,
          ): UpdateNicknameService | null =>
            db === undefined ? null : createUpdateNicknameService({ db, clock, logger, review }),
        },
        {
          provide: ME,
          inject: [
            CLOCK,
            IDENTITY_CONFIG,
            ROOT_LOGGER,
            REALNAME_STATUS_READER,
            { token: DB, optional: true },
            { token: ME_READ_PORTS, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            config: SmsConfigReader | null,
            logger: RootLogger,
            status: RealnameStatusReader,
            db?: Kysely<Database>,
            ports?: MeReadPorts | null,
            crypto?: FieldCrypto,
          ): MeService | null =>
            // The age check of invite_code (BR-INV-19) decrypts the verified birth date (B1-13d's
            // reader); without the field cipher there is no GET /v1/me, as with real-name itself.
            db === undefined || config === null || ports == null || crypto === undefined
              ? null
              : createMeService({
                  db,
                  clock,
                  config,
                  logger,
                  realname: {
                    read: (handle, subject) => status.read(handle, subject),
                    verified: createRealnameReader(crypto).verified,
                  },
                  ...ports,
                }),
        },
        {
          // BR-ID-25: the fake two-element verifier in local / test; staging / prod have no vendor
          // yet (null → 50301), announced once while the entry starts.
          provide: REALNAME_VERIFIER,
          inject: [APP_CONFIG, ROOT_LOGGER],
          useFactory: (config: AppConfig, logger: RootLogger): RealnameVerifierPort | null => {
            const verifier = createRealnameVerifier(config.appEnv);
            if (verifier === null) logger.warn({}, 'realname_verifier_unconfigured');
            return verifier;
          },
        },
        {
          provide: SUBMIT_REALNAME,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            REALNAME_VERIFIER,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
            { token: REDIS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            verifier: RealnameVerifierPort | null,
            db?: Kysely<Database>,
            crypto?: FieldCrypto,
            redis?: RedisHandle,
          ): RealnameService | null =>
            db === undefined || crypto === undefined
              ? null
              : createRealnameService({
                  db,
                  clock,
                  crypto,
                  redis: redis ?? null,
                  verifier,
                  logger,
                }),
        },
        {
          // BR-WDR-31 (B1-13h): GET and signature of the labor agreement.
          provide: LABOR_AGREEMENT,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            LABOR_AGREEMENT_CONFIG,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            config: LaborAgreementConfigReader | null,
            db?: Kysely<Database>,
            crypto?: FieldCrypto,
          ): LaborAgreementService | null => {
            // The withdrawal port reads through the same assembly (ports/labor-agreement.ts).
            registerLaborAgreementConfigReader(config);
            return db === undefined || crypto === undefined
              ? null
              : createLaborAgreementService({ db, clock, crypto, logger, config });
          },
        },
        {
          provide: PAYOUT_ACCOUNT_READER,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            PAYOUT_ACCOUNT_CONFIG,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            config: PayoutAccountConfigPort | null,
            db?: Kysely<Database>,
            crypto?: FieldCrypto,
          ): PayoutAccountReader | null =>
            db === undefined || crypto === undefined
              ? null
              : createPayoutAccountReader({
                  db,
                  clock,
                  crypto,
                  logger,
                  ...(config === null ? {} : { config }),
                }),
        },
        {
          // BR-WDR-02 ⑥ (B1-13f): the demonstration BIN table in local / test; staging / prod
          // have no BIN source yet (null → 50301 before any reservation), announced once.
          provide: CARD_BIN,
          inject: [APP_CONFIG, ROOT_LOGGER],
          useFactory: (config: AppConfig, logger: RootLogger): CardBinPort | null => {
            const bin = createCardBin(config.appEnv);
            if (bin === null) logger.warn({}, 'card_bin_unconfigured');
            return bin;
          },
        },
        {
          // BR-WDR-02 ⑦ (B1-13f): the fake three-element verifier in local / test; staging / prod
          // have no vendor yet (null → 50301 before any reservation), announced once.
          provide: BANK_CARD_VERIFIER,
          inject: [APP_CONFIG, ROOT_LOGGER],
          useFactory: (config: AppConfig, logger: RootLogger): BankCardVerifierPort | null => {
            const verifier = createBankCardVerifier(config.appEnv);
            if (verifier === null) logger.warn({}, 'bank_card_verifier_unconfigured');
            return verifier;
          },
        },
        {
          // PUT /v1/me/payout-account (B1-13f): B1-13e's Alipay save and the bank-card flow.
          provide: PAYOUT_ACCOUNT_CHANGE,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            PAYOUT_ACCOUNT_CONFIG,
            BLOCKLIST_SERVICE,
            CARD_BIN,
            BANK_CARD_VERIFIER,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            config: PayoutAccountConfigPort | null,
            blocklist: BlocklistService | null,
            cardBin: CardBinPort | null,
            verifier: BankCardVerifierPort | null,
            db?: Kysely<Database>,
            crypto?: FieldCrypto,
          ): PayoutAccountChange | null =>
            db === undefined || crypto === undefined || blocklist === null
              ? null
              : createPayoutAccountChange({
                  db,
                  clock,
                  crypto,
                  logger,
                  blocklist,
                  cardBin,
                  verifier,
                  ...(config === null ? {} : { config }),
                }),
        },
        {
          provide: LOGOUT,
          inject: [CLOCK, PUSH_TOKENS, { token: DB, optional: true }],
          useFactory: (
            clock: Clock,
            pushTokens: SessionPushTokens | null,
            db?: Kysely<Database>,
          ): Logout => createLogout({ db, clock, pushTokens }),
        },
      ],
      exports: [
        DEVICE_SIGNING_KEYS,
        TOKEN_CHECK,
        CONSENT_SIGNATURE_CHECK,
        STEP_UP_CHECK,
        IDENTITY_LEVEL_CHECKS,
        PRIVACY_CONSENT_CHECKS,
        DELETION_STAGE_CHECKS,
      ],
    };
  }
}
