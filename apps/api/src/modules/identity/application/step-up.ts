// Second verification (规划/08 BR-ID-08 step-up, BR-ID-04 细则「提交时先校验、后消费」; 04 §6.1
// POST /v1/auth/step-up; orchestrator ruling B1-02f §9.2). Stages ① (signature) and ② ③ (token)
// already ran; the contract schema (oneOf of four closed branches) refused a body mixing two ways.
//
// SMS (`action`, `code`): only for an account with a bound phone (none → 20001 fields=[code]). The
// number is the account's own (users.phone_cipher, decrypted here), never one from the request;
// the code is checked and consumed with purpose=step_up through the SMS code service (20002 wrong,
// 20003 none current / expired / consumed). Then the token is issued.
// Third party (`provider`, `attempt_id` and that provider's credential fields): only for an account
// without a bound phone (a bound phone → 20001 fields=[provider], nothing consumed). The attempt is
// checked and consumed for (app, provider, purpose=step_up, device, uid, action) (20004 / 50001,
// the attempt left intact on a mismatch); only then the identity is exchanged through the
// ThirdPartyIdentityPort (CT-15i performs the exchange and verification): absent port, an
// «unavailable» answer or a thrown error → 50305 data.provider; «invalid» → 20004; an identity
// other than this account's user_oauth(provider).union_id → 20004 data.reason=identity_mismatch.
// After consumption nothing is restored: a retry needs a new attempt. B1-20b (Codex money r1 S2):
// action=phone_change is never issued this way (no phone to change): once the attempt matched and
// was consumed → 20001 data.fields=[action], no exchange, no token.
//
// step_up_token: ES256 with the access token's key and issuer, aud=step_up, claims uid, app_id,
// sid, device_id, action, jti (random UUID), iat, exp = iat + auth.step_up_ttl_sec (default 300).
// Only issued here; its jti is consumed by the operations that require it (BR-ID-08), not here.
// B1-20b (Codex money r1 S0 #2): a phone_change token issued by SMS also carries the claim
// `phone_binding` (phone-change-binding.ts: the hash of its jti and the checked number's
// phone_hmac), which the change compares under its lock with the number it replaces.
// Nothing is logged: no code, phone, token or credential.
//
// Business digest (B1-02zzzb; BR-ID-08 细则「绑定业务摘要」; contract POST /v1/auth/step-up
// `summary`, CT-26c): judged first, before either way reads, checks or consumes anything (a code or
// an attempt is only consumed for a body that can be issued). Only payout_account_change is bound:
// it must carry a `summary` of the payout_account_change shape (alipay / bank_card / wechat); a
// missing one or another shape → 20001 data.fields=[summary], nothing issued or consumed. withdraw,
// phone_change and account_deletion carry no summary and are issued as before without a digest;
// any summary with them → 20001 data.fields=[summary]. The server computes the digest
// (domain/step-up-digest.ts) and signs it as the string claim `summary`: the Alipay logon id /
// card number is normalised as the payout account save normalises it (BR-WDR-02) and only its
// blind index (the payout_accounts contexts) enters the claim, never the plaintext and never a
// client fingerprint; WeChat takes the attempt_id. An Alipay logon id that cannot be normalised
// has no fingerprint → 20001 data.fields=[summary]. The digest and the account are never logged.
//
// Phone change switch (B1-20b, BR-ID-06 细则「第 1 步就返回 30414」, D10-2189): action=phone_change
// while account.phone_change_enabled is the boolean false → 30414, after 10405 (stage ④a, before
// this service) and the 10403 app check, before the summary, the code or the attempt is read,
// checked or consumed (no error counted). Without the switch option the change counts as on.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import { randomUUID } from 'node:crypto';
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { normalizeBankCardNo } from '@couli/domain';
import type { Clock, FieldCrypto, RootLogger, TokenPrincipal } from '../../platform/index.ts';
import { blocklistHmacContexts } from '../../risk/index.ts';
import { normalizeAlipayLogonId } from '../domain/alipay-logon.ts';
import { maskPhone } from '../domain/mask-phone.ts';
import { PHONE_CIPHER_CONTEXT } from '../domain/registration.ts';
import {
  STEP_UP_PHONE_BINDING_CLAIM,
  STEP_UP_SUMMARY_CLAIM,
  isDigestAction,
  payoutAccountDigest,
  wechatPayoutDigest,
} from '../domain/step-up-digest.ts';
import { STEP_UP_AUDIENCE, signScopedToken, type TokenKeyProvider } from './access-tokens.ts';
import { configuredSeconds, instantPlus } from './config-seconds.ts';
import type { OauthAttemptService } from './oauth-attempts.ts';
import { phoneChangeBinding } from './phone-change-binding.ts';
import { PHONE_CHANGE_DISABLED, type PhoneChangeSwitch } from './phone-change-switch.ts';
import {
  STAGING_TEST_PHONE_AUDIT_EVENT,
  type SmsCodeService,
  type SmsConfigReader,
} from './sms-codes.ts';
import { replaceAppleRefreshToken } from '../infra/oauth-accounts.ts';

export type ThirdPartyCredentials =
  | { readonly provider: 'wechat'; readonly code: string }
  | {
      readonly provider: 'apple';
      readonly identity_token: string;
      readonly authorization_code: string;
    }
  | { readonly provider: 'huawei'; readonly authorization_code: string };

/** CT-15i performs the exchange and verification; absence must fail closed with 50305. */
export interface ThirdPartyIdentityPort {
  exchange(
    input: ThirdPartyCredentials & { readonly nonce: string },
  ): Promise<ThirdPartyIdentity | { readonly unavailable: true } | { readonly invalid: true }>;
}

/** Credentials have already been verified by the adapter; never accept a client identity. */
export interface ThirdPartyIdentity {
  readonly union_id: string;
  readonly open_id?: string;
  readonly apple_refresh_token?: string;
}

export interface StepUpCommand {
  readonly body: Schema<'StepUpRequest'>;
  readonly principal: TokenPrincipal;
  readonly verifiedDevice: { readonly appId: string; readonly deviceId: string };
}

export type StepUpResult =
  | { readonly code: 0; readonly data: Schema<'StepUpData'> }
  | { readonly code: 10403 | 20002 | 20003 | 30414 | 50001 }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } }
  | { readonly code: 20004; readonly data?: { readonly reason: 'identity_mismatch' } }
  | { readonly code: 50305; readonly data: { readonly provider: Schema<'LoginProvider'> } };

export interface StepUpService {
  verify(command: StepUpCommand): Promise<StepUpResult>;
}

export interface StepUpOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly keys: TokenKeyProvider;
  readonly config: SmsConfigReader;
  readonly sms: SmsCodeService;
  readonly attempts: OauthAttemptService;
  readonly thirdPartyIdentity?: ThirdPartyIdentityPort;
  /** account.phone_change_enabled (B1-20b); absent → on. */
  readonly phoneChange?: PhoneChangeSwitch;
  /**
   * B1-02zza (D10-611): where the pino audit line of a staging test phone's step-up goes
   * (event staging_test_phone_login, purpose step_up). identity.module passes the root logger.
   */
  readonly logger?: RootLogger;
}

/** Configuration key of the step_up_token lifetime (BR-ID-08). */
export const STEP_UP_TTL_KEY = 'auth.step_up_ttl_sec';
/** BR-ID-08: a step_up_token is valid for 5 minutes unless the app configures otherwise. */
export const STEP_UP_DEFAULT_TTL_SECONDS = 300;

type SmsBody = Schema<'StepUpBySmsRequest'>;
type OauthBody =
  | Schema<'StepUpByWechatRequest'>
  | Schema<'StepUpByAppleRequest'>
  | Schema<'StepUpByHuaweiRequest'>;

/** The credential fields of a provider's body, as login, step-up and re-verification carry them. */
type OauthCredentialFields =
  | Pick<Schema<'ReverifyByOauthWechat'>, 'provider' | 'code'>
  | Pick<Schema<'ReverifyByOauthApple'>, 'provider' | 'identity_token' | 'authorization_code'>
  | Pick<Schema<'ReverifyByOauthHuawei'>, 'provider' | 'authorization_code'>;

function isSmsBody(body: SmsBody | OauthBody): body is SmsBody {
  return !('provider' in body);
}

/** B1-20b: phone_change by the third-party way (an account without a phone) is refused. */
const PHONE_CHANGE_BY_THIRD_PARTY = Object.freeze({
  code: 20001,
  data: Object.freeze({ fields: Object.freeze(['action']) }),
} as const);

const SUMMARY_REFUSED = Object.freeze({
  code: 20001,
  data: Object.freeze({ fields: Object.freeze(['summary']) }),
} as const);

/** A string field of an untrusted object, or undefined. */
function stringField(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

/**
 * The digest claim of this body (file header), undefined for an action that is not bound, or
 * 20001 fields=[summary]. Reads nothing and writes nothing; the shapes are re-checked here even
 * though the contract schema validated them.
 */
export function stepUpDigest(
  crypto: Pick<FieldCrypto, 'blindIndex'>,
  action: string,
  summary: unknown,
): { readonly code: 0; readonly digest: string | undefined } | typeof SUMMARY_REFUSED {
  if (!isDigestAction(action)) {
    return summary === undefined ? { code: 0, digest: undefined } : SUMMARY_REFUSED;
  }
  if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) {
    return SUMMARY_REFUSED;
  }
  const value = summary as Readonly<Record<string, unknown>>;
  const method = value['payout_method'];
  const contexts = blocklistHmacContexts();
  if (method === 'alipay') {
    const logon = stringField(value, 'alipay_logon_id');
    if (logon === undefined) return SUMMARY_REFUSED;
    const normalized = normalizeAlipayLogonId(logon);
    if (normalized.code !== 0) return SUMMARY_REFUSED;
    return {
      code: 0,
      digest: payoutAccountDigest('alipay', crypto.blindIndex(normalized.logon, contexts.alipay)),
    };
  }
  if (method === 'bank_card') {
    const cardNo = stringField(value, 'card_no');
    if (cardNo === undefined) return SUMMARY_REFUSED;
    const normalized = normalizeBankCardNo(cardNo);
    if (normalized.length === 0) return SUMMARY_REFUSED;
    return {
      code: 0,
      digest: payoutAccountDigest('bank_card', crypto.blindIndex(normalized, contexts.bank_card)),
    };
  }
  if (method === 'wechat') {
    const attemptId = stringField(value, 'attempt_id');
    if (attemptId === undefined) return SUMMARY_REFUSED;
    return { code: 0, digest: wechatPayoutDigest(attemptId) };
  }
  return SUMMARY_REFUSED;
}

/** The provider's credential fields of the body, without action and attempt_id. */
export function credentialsOf(body: OauthCredentialFields): ThirdPartyCredentials {
  switch (body.provider) {
    case 'wechat':
      return { provider: 'wechat', code: body.code };
    case 'apple':
      return {
        provider: 'apple',
        identity_token: body.identity_token,
        authorization_code: body.authorization_code,
      };
    case 'huawei':
      return { provider: 'huawei', authorization_code: body.authorization_code };
  }
}

export function createStepUpService(options: StepUpOptions): StepUpService {
  const { db, clock, crypto, keys, config, sms, attempts, thirdPartyIdentity } = options;

  async function account(
    principal: TokenPrincipal,
  ): Promise<{ phone_hmac: string | null; phone_cipher: Buffer | null } | undefined> {
    return db
      .selectFrom('users')
      .select(['phone_hmac', 'phone_cipher'])
      .where('app_id', '=', principal.app_id)
      .where('id', '=', principal.uid)
      .executeTakeFirst();
  }

  async function issue(
    principal: TokenPrincipal,
    action: Schema<'StepUpAction'>,
    digest: string | undefined,
    /** B1-20b: the checked number of a phone_change by SMS (phone-change-binding.ts). */
    phoneHmac?: string,
  ): Promise<StepUpResult> {
    const ttlSeconds = await configuredSeconds(
      config,
      principal.app_id,
      STEP_UP_TTL_KEY,
      STEP_UP_DEFAULT_TTL_SECONDS,
    );
    const now = clock.now();
    const issuedAt = Math.floor(now.getTime() / 1000);
    const jti = randomUUID();
    const binding =
      action === 'phone_change' && phoneHmac !== undefined
        ? { [STEP_UP_PHONE_BINDING_CLAIM]: phoneChangeBinding(jti, phoneHmac) }
        : {};
    const token = await signScopedToken(keys, {
      audience: STEP_UP_AUDIENCE,
      claims: {
        uid: principal.uid,
        app_id: principal.app_id,
        sid: principal.sid,
        device_id: principal.device_id,
        action,
        jti,
        ...(digest === undefined ? {} : { [STEP_UP_SUMMARY_CLAIM]: digest }),
        ...binding,
      },
      issuedAt,
      ttlSeconds,
    });
    const expireAt = instantPlus(now, (issuedAt + ttlSeconds) * 1000 - now.getTime());
    return { code: 0, data: { step_up_token: token, expire_at: expireAt.toISOString() } };
  }

  async function bySms(
    principal: TokenPrincipal,
    body: SmsBody,
    digest: string | undefined,
  ): Promise<StepUpResult> {
    const user = await account(principal);
    if (user === undefined || user.phone_hmac === null || user.phone_cipher === null) {
      return { code: 20001, data: { fields: ['code'] } };
    }
    const phone = crypto.decrypt(user.phone_cipher.toString('utf8'), PHONE_CIPHER_CONTEXT);
    const verified = await sms.verifyAndConsume({
      app_id: principal.app_id,
      phone,
      purpose: 'step_up',
      code: body.code,
    });
    if (verified.code !== 0) return { code: verified.code };
    const issued = await issue(principal, body.action, digest, user.phone_hmac);
    if (verified.staging_test_phone === true && issued.code === 0) {
      // B1-02zza (D10-611 (4)): the audit line of a staging test phone's step-up; masked number
      // only, never the full number or the code.
      options.logger?.info(
        {
          event: STAGING_TEST_PHONE_AUDIT_EVENT,
          app_id: principal.app_id,
          purpose: 'step_up',
          is_new_user: false,
          phone_masked: maskPhone(phone),
          user_id: principal.uid,
        },
        STAGING_TEST_PHONE_AUDIT_EVENT,
      );
    }
    return issued;
  }

  async function byThirdParty(
    principal: TokenPrincipal,
    device: { readonly appId: string; readonly deviceId: string },
    body: OauthBody,
    digest: string | undefined,
  ): Promise<StepUpResult> {
    const user = await account(principal);
    // BR-ID-08: the third-party way is only for an account without a bound phone.
    if (user === undefined || user.phone_hmac !== null) {
      return { code: 20001, data: { fields: ['provider'] } };
    }
    const consumed = await attempts.consume({
      app_id: principal.app_id,
      provider: body.provider,
      purpose: 'step_up',
      device_id: device.deviceId,
      uid: principal.uid,
      action: body.action,
      attempt_id: body.attempt_id,
    });
    if (consumed.code !== 0) return { code: consumed.code };
    // B1-20b (Codex money r1 S2 #4; BR-ID-08): the third-party way is for account_deletion only —
    // an account without a phone has no number to change, so phone_change is never issued here.
    // Judged after the attempt matched (an attempt of another action stays 20004, its holder can
    // still use it); the matched phone_change attempt is consumed and no exchange is made.
    if (body.action === 'phone_change') return PHONE_CHANGE_BY_THIRD_PARTY;
    const unavailable: StepUpResult = { code: 50305, data: { provider: body.provider } };
    if (thirdPartyIdentity === undefined) return unavailable;
    let identity: Awaited<ReturnType<ThirdPartyIdentityPort['exchange']>>;
    try {
      identity = await thirdPartyIdentity.exchange({
        ...credentialsOf(body),
        nonce: consumed.data.nonce,
      });
    } catch {
      // A provider timeout or failure is «unavailable» (BR-ID-04 细则 失败处理); not logged here.
      return unavailable;
    }
    if ('unavailable' in identity) return unavailable;
    if (!('union_id' in identity)) return { code: 20004 };
    const binding = await db
      .selectFrom('user_oauth')
      .select('union_id')
      .where('app_id', '=', principal.app_id)
      .where('user_id', '=', principal.uid)
      .where('provider', '=', body.provider)
      .executeTakeFirst();
    if (binding === undefined || binding.union_id !== identity.union_id) {
      return { code: 20004, data: { reason: 'identity_mismatch' } };
    }
    if (body.provider === 'apple' && identity.apple_refresh_token !== undefined) {
      const refreshToken = identity.apple_refresh_token;
      // Read configuration and sign before taking a pooled transaction connection.
      // The token is returned only after the binding update commits.
      const issued = await issue(principal, body.action, digest);
      return db.transaction().execute(async (trx) => {
        await replaceAppleRefreshToken(
          trx,
          {
            app_id: principal.app_id,
            user_id: principal.uid,
            union_id: identity.union_id,
            refresh_token: refreshToken,
          },
          { clock, crypto },
        );
        return issued;
      });
    }
    return issue(principal, body.action, digest);
  }

  return Object.freeze({
    async verify(command: StepUpCommand): Promise<StepUpResult> {
      const { principal, verifiedDevice } = command;
      // The token and the signing device must be of one app (BR-ID-07); from here on
      // principal.app_id is that checked app_id (attempt keys, users, user_oauth, the token).
      if (principal.app_id !== verifiedDevice.appId) return { code: 10403 };
      const body = command.body as SmsBody | OauthBody;
      const { phoneChange } = options;
      if (
        body.action === 'phone_change' &&
        phoneChange !== undefined &&
        !(await phoneChange.enabled(principal.app_id))
      ) {
        return PHONE_CHANGE_DISABLED;
      }
      // B1-02zzzb: the summary before either way reads, checks or consumes anything.
      const digest = stepUpDigest(crypto, body.action, body.summary);
      if (digest.code !== 0) return digest;
      return isSmsBody(body)
        ? bySms(principal, body, digest.digest)
        : byThirdParty(principal, verifiedDevice, body, digest.digest);
    },
  });
}
