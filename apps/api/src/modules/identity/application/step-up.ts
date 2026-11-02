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
// After consumption nothing is restored: a retry needs a new attempt.
//
// step_up_token: ES256 with the access token's key and issuer, aud=step_up, claims uid, app_id,
// sid, device_id, action, jti (random UUID), iat, exp = iat + auth.step_up_ttl_sec (default 300).
// Only issued here; its jti is consumed by the operations that require it (BR-ID-08), not here.
// Nothing is logged: no code, phone, token or credential.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import { randomUUID } from 'node:crypto';
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, FieldCrypto, TokenPrincipal } from '../../platform/index.ts';
import { PHONE_CIPHER_CONTEXT } from '../domain/registration.ts';
import { STEP_UP_AUDIENCE, signScopedToken, type TokenKeyProvider } from './access-tokens.ts';
import { configuredSeconds, instantPlus } from './config-seconds.ts';
import type { OauthAttemptService } from './oauth-attempts.ts';
import type { SmsCodeService, SmsConfigReader } from './sms-codes.ts';
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
  | { readonly code: 10403 | 20002 | 20003 | 50001 }
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
  ): Promise<StepUpResult> {
    const ttlSeconds = await configuredSeconds(
      config,
      principal.app_id,
      STEP_UP_TTL_KEY,
      STEP_UP_DEFAULT_TTL_SECONDS,
    );
    const now = clock.now();
    const issuedAt = Math.floor(now.getTime() / 1000);
    const token = await signScopedToken(keys, {
      audience: STEP_UP_AUDIENCE,
      claims: {
        uid: principal.uid,
        app_id: principal.app_id,
        sid: principal.sid,
        device_id: principal.device_id,
        action,
        jti: randomUUID(),
      },
      issuedAt,
      ttlSeconds,
    });
    const expireAt = instantPlus(now, (issuedAt + ttlSeconds) * 1000 - now.getTime());
    return { code: 0, data: { step_up_token: token, expire_at: expireAt.toISOString() } };
  }

  async function bySms(principal: TokenPrincipal, body: SmsBody): Promise<StepUpResult> {
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
    return issue(principal, body.action);
  }

  async function byThirdParty(
    principal: TokenPrincipal,
    device: { readonly appId: string; readonly deviceId: string },
    body: OauthBody,
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
      const issued = await issue(principal, body.action);
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
    return issue(principal, body.action);
  }

  return Object.freeze({
    async verify(command: StepUpCommand): Promise<StepUpResult> {
      const { principal, verifiedDevice } = command;
      // The token and the signing device must be of one app (BR-ID-07); from here on
      // principal.app_id is that checked app_id (attempt keys, users, user_oauth, the token).
      if (principal.app_id !== verifiedDevice.appId) return { code: 10403 };
      const body = command.body as SmsBody | OauthBody;
      return isSmsBody(body)
        ? bySms(principal, body)
        : byThirdParty(principal, verifiedDevice, body);
    },
  });
}
