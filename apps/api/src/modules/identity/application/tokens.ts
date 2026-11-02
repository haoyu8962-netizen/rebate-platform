// Nest tokens of the identity module's SMS code wiring (identity.module.ts).

/**
 * The identity configuration port (SmsConfigReader of ./sms-codes.ts): content's reader, built by
 * the factory app.module hands to IdentityModule.forRoot; null when the process has no database.
 */
export const IDENTITY_CONFIG = Symbol('IDENTITY_CONFIG');

/** The SmsCodeService; null when the process has no Redis or no configuration reader. */
export const SMS_CODES = Symbol('SMS_CODES');

// Nest tokens of the session wiring (B1-02h, identity.module.ts).

/** The TokenKeyProvider (access-tokens.ts): configured key, or an ephemeral one in local / test. */
export const TOKEN_KEYS = Symbol('TOKEN_KEYS');

/** The TokenService that issues and verifies access tokens and issues refresh tokens. */
export const TOKEN_SERVICE = Symbol('TOKEN_SERVICE');

/** The stage ② ③ RequestCheck (createTokenCheck); app.module lists it right after the signature check. */
export const TOKEN_CHECK = Symbol('TOKEN_CHECK');

/** The Logout use case (logout.ts). */
/** The ReverifyService (reverify.ts); null when the process has no database or field cipher. */
export const REVERIFY = Symbol('IDENTITY_REVERIFY');

export const LOGOUT = Symbol('LOGOUT');

// Nest token of the SMS login wiring (B1-02j, identity.module.ts).

/** The SmsLoginService; null when the process has no database, Redis or field cipher. */
export const SMS_LOGIN = Symbol('SMS_LOGIN');

// Nest token of the refresh wiring (B1-02k, identity.module.ts).

/** The RefreshService; null when the process has no database, Redis or field cipher. */
export const REFRESH = Symbol('REFRESH');

// Nest tokens of the second-verification wiring (B1-02f, identity.module.ts).

/** The OauthAttemptService (oauth-attempts.ts); null when the process has no database or Redis. */
export const OAUTH_ATTEMPTS = Symbol('OAUTH_ATTEMPTS');
export const OAUTH_LOGIN = Symbol('OAUTH_LOGIN');

/**
 * The ThirdPartyIdentityPort (step-up.ts) app.module may hand to IdentityModule.forRoot; null
 * when none is given: the third-party step-up then answers 50305 (CT-15i provides the exchange).
 */
export const THIRD_PARTY_IDENTITY = Symbol('THIRD_PARTY_IDENTITY');

/** The StepUpService; null when the process has no database, Redis, field cipher or SMS codes. */
export const STEP_UP = Symbol('STEP_UP');

/** The H5TokenService (h5-token.ts); null when the process has no configuration reader. */
export const H5_TOKENS = Symbol('H5_TOKENS');

/** The ConsentService (consents.ts); null when the process has no database. */
export const CONSENTS = Symbol('CONSENTS');

/** recordConsent's clipboard_auto_import signature RequestCheck (consent-signature.ts, B1-02zc). */
export const CONSENT_SIGNATURE_CHECK = Symbol('CONSENT_SIGNATURE_CHECK');

// Nest token of the one-time tips wiring (B1-02s, identity.module.ts).

/** The TipsService (tips.ts); null when the process has no database. */
export const TIPS = Symbol('TIPS');

/** First phone binding; null without its storage and read ports. */
export const BIND_PHONE = Symbol('BIND_PHONE');
/** The current-user read service, or null without the database and assembled ports. */
export const ME = Symbol('IDENTITY_ME');
/** Cross-module read ports of GET /v1/me, assembled by app.module. */
export const ME_READ_PORTS = Symbol('IDENTITY_ME_READ_PORTS');
/** Nickname content review, selected by environment. */
export const NICKNAME_REVIEW = Symbol('IDENTITY_NICKNAME_REVIEW');
/** The nickname update service, or null without the database. */
export const UPDATE_NICKNAME = Symbol('IDENTITY_UPDATE_NICKNAME');
/** The real-name verifier (fake in local / test), or null when no vendor is assembled. */
export const REALNAME_VERIFIER = Symbol('IDENTITY_REALNAME_VERIFIER');
/** The real-name submission service, or null without the database or field cipher. */
export const SUBMIT_REALNAME = Symbol('IDENTITY_SUBMIT_REALNAME');
/** The labor agreement service (labor-agreement.ts), or null without the database or field cipher. */
export const LABOR_AGREEMENT = Symbol('IDENTITY_LABOR_AGREEMENT');
/** GET /v1/me/payout-account (payout-account.ts), or null without the database or field cipher. */
export const PAYOUT_ACCOUNT_READER = Symbol('IDENTITY_PAYOUT_ACCOUNT_READER');
/**
 * PUT /v1/me/payout-account (payout-bank-card.ts createPayoutAccountChange), or null without the
 * database, field cipher or blocklist.
 */
export const PAYOUT_ACCOUNT_CHANGE = Symbol('IDENTITY_PAYOUT_ACCOUNT_CHANGE');
/** The card BIN port (demo table in local / test), or null when no source is assembled. */
export const CARD_BIN = Symbol('IDENTITY_CARD_BIN');
/** The bank-card three-element verifier (fake in local / test), or null without a vendor. */
export const BANK_CARD_VERIFIER = Symbol('IDENTITY_BANK_CARD_VERIFIER');
/** The landing page's registration (POST /v1/invites/landing-register, B1-11h), or null. */
export const LANDING_REGISTER = Symbol('IDENTITY_LANDING_REGISTER');
/**
 * Account deletion apply / cancel / read (deletion-request.ts, B1-15d), or null without the
 * database.
 */
export const DELETION_REQUESTS = Symbol('IDENTITY_DELETION_REQUESTS');
