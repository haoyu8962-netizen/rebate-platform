// The invite landing page's registration (contract operation landingRegister, POST
// /v1/invites/landing-register; 08 BR-INV-05, BR-ID-32, BR-ID-04, BR-ID-12, BR-ID-31; task B1-11h,
// orchestrator ruling §9.2 / §9.3). x-auth none, not signed, no device, no version gate, nothing
// issued (no token, no cookie).
//
// register(command), the fixed order (the first hit answers; nothing after it runs):
//   ⓐ the route schema (20001) has run before the controller;
//   ⓑ agreed ≠ true → 10004 data.consent_type=agreement;
//   ⓒ normalize_phone → 20001 data { fields: [phone], reason: phone_invalid };
//   ⓔ configuration, read before the transaction on a pooled handle through the assembled reader
//     (content's, uncached): legal.agreement.version / legal.privacy.version (positive integers;
//     missing or malformed → 50001, no version is made up), landing.ip_register_limit (positive
//     integer, default 3; malformed → 3 with a warning naming the key only), and the registration
//     core's keys (snapshotRegistrationConfig). ⓑ ⓒ ⓔ answer before the idempotency module: nothing
//     stored, nothing counted, no code used up;
//   ⓓ platform idempotency, transactional mode (executeInTransaction; subject p:<phone_hmac> of
//     the normalised phone, keyed request digest): a missing / malformed key → 20001, a stored
//     answer is replayed byte for byte (nothing below runs again: no count, no code, no account);
//     code 0 and 3xxxx answers are stored, every other answer rolls the whole transaction back;
//   ⓕ growth's precheck (the port): 30408 → 42901 (+ Retry-After) → 30401 → 30401 (growth counts
//     its 30401, de-duplicated by the Idempotency-Key);
//   ⓖ verifyAndConsume (purpose login) → 20002 / 20003; the code is used up here, in Redis, so a
//     later rollback (44001, 5xxxx) does not bring it back;
//   then, after this flow's own savepoint (every answer but registered rolls back to it, so a 3xxxx
//   that the idempotency module commits never commits the account with it):
//   ⓗ an account of (app_id, phone_hmac) with status ≠ deleted → already_registered, nothing
//     written; only status = deleted accounts (deletion done, merge tombstones) leave the phone
//     free. A pending / cooling-period deletion still holds the phone, as BR-ID-27 treats the
//     same phone as a new user only after the deletion is done;
//   ⓘ 44001 (§9.3): first the phone blocklist (risk's matchRegistration, read on the transaction,
//     before the IP lock; the hit is recorded by risk after the transaction rolled back and released
//     its connection, never through a second pooled connection while it is held), then the IP
//     limit: the transaction-level advisory lock of (app_id, ip_hmac), the phone held again (a
//     concurrent registration of the same number committed while waiting → already_registered),
//     the count of app.landing_registrations with created_at in [now − 3600 s, now] ≥ the limit →
//     44001 data.risk_msg_code null;
//   ⓙ the account: registration.register (h5_landing, the body's channel, else X-Channel, else
//     NULL; no device, no invite code — the binding is not register's best-effort port but part of
//     this transaction), phone_taken (a concurrent first registration won) → already_registered;
//     then the consent lock and the two consent records (agreement, privacy; the current legal
//     versions, channel h5_landing, accepted, client_at = server_at = created_at = the instant of
//     the count), growth's binding (bound, else its 30401 / 50001), and the landing_registrations
//     row (created_at the same instant) → registered.
// Lock order (the line's rule): IP lock → users row (inserted) → consent lock → relation write lock.
// A thrown error anywhere rolls everything back (the global filter answers 50001).
//
// Nothing logged identifies the person: no phone in any form, no IP or its digest, no invite code,
// no SMS code — app id, codes, counts and the new account's id only.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators, no Nest.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type {
  Clock,
  FieldCrypto,
  HandlerResult,
  Idempotency,
  RootLogger,
} from '../../platform/index.ts';
import type { BlocklistService } from '../../risk/index.ts';
import { normalize_phone } from '../domain/normalize-phone.ts';
import { PHONE_BLIND_INDEX_CONTEXT } from '../domain/registration.ts';
import { insertConsentRecords, lockUserConsents } from '../infra/consent-records.ts';
import {
  countLandingRegistrations,
  insertLandingRegistration,
  landingSavepoint,
  lockLandingRegistrations,
  releaseLandingSavepoint,
  rollbackLandingSavepoint,
} from '../infra/landing-registrations.ts';
import { phoneHeld } from '../infra/registration-store.ts';
import type { LandingInvitePort, LandingRegisterConfigReader } from '../ports/landing-invite.ts';
import { snapshotRegistrationConfig, type RegistrationService } from './registration.ts';
import type { SmsCodeService, SmsConfigReader } from './sms-codes.ts';

export const LANDING_REGISTER_PATH = '/v1/invites/landing-register';
/** Blind-index context of the client IP in app.landing_registrations.ip_hmac. */
export const LANDING_REGISTRATIONS_IP_CONTEXT = 'landing_registrations.ip';
export const LEGAL_AGREEMENT_VERSION_KEY = 'legal.agreement.version';
export const LEGAL_PRIVACY_VERSION_KEY = 'legal.privacy.version';
export const LANDING_IP_REGISTER_LIMIT_KEY = 'landing.ip_register_limit';
/** BR-ID-32 default of landing.ip_register_limit. */
export const DEFAULT_LANDING_IP_REGISTER_LIMIT = 3;
const CONSENT_CHANNEL = 'h5_landing';
const INT32_MAX = 2_147_483_647;

/** Fallback texts (contracts/texts.default.json error.<code>; 50001 the global filter's text). */
const MESSAGES: Readonly<Record<number, string>> = Object.freeze({
  10004: '请先阅读并同意相关授权',
  20001: '请输入 11 位中国大陆手机号',
  20002: '验证码错误，请重新输入',
  20003: '验证码已失效，请重新获取',
  30401: '邀请码无效',
  30408: '邀请活动暂停',
  42901: '操作太频繁，请稍后再试',
  44001: '操作未通过安全校验',
  50001: '服务端错误',
});

/** contracts/error-codes.yaml http of each code this route answers. */
const STATUSES: Readonly<Record<number, number>> = Object.freeze({
  10004: 403,
  20001: 400,
  20002: 400,
  20003: 400,
  30401: 422,
  30408: 422,
  42901: 429,
  44001: 403,
  50001: 500,
});

export interface LandingRegisterCommand {
  /** X-App-Id (the page's app; no token, no device). */
  readonly app_id: string;
  /** Contract-validated body (LandingRegisterRequest). */
  readonly body: Schema<'LandingRegisterRequest'>;
  /** X-Channel, used when the body has no channel. */
  readonly header_channel?: string;
  /** Fastify's client address. */
  readonly client_ip: string;
  /** The Idempotency-Key header (undefined when absent or not a single string). */
  readonly idempotency_key: string | undefined;
  readonly trace_id: string;
}

export interface LandingEnvelope {
  readonly code: number;
  readonly msg: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly trace_id: string;
}

export type LandingRegisterAnswer =
  /** Answered before the idempotency module (ⓑ ⓒ ⓔ): thrown as an HttpException. */
  | { readonly kind: 'refused'; readonly status: number; readonly envelope: LandingEnvelope }
  /** The idempotency module's answer (handler, replay or its own), written as it is. */
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly body: string;
      /** Retry-After seconds of a 42901 answered by this call's handler. */
      readonly retryAfter?: number;
    };

export interface LandingRegisterService {
  register(command: LandingRegisterCommand): Promise<LandingRegisterAnswer>;
}

export interface LandingRegisterOptions {
  /** The pooled handle (schema app) the configuration is read on, before the transaction. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: Pick<FieldCrypto, 'blindIndex'>;
  readonly logger: RootLogger;
  readonly idempotency: Pick<Idempotency, 'executeInTransaction'>;
  readonly sms: Pick<SmsCodeService, 'verifyAndConsume'>;
  readonly registration: RegistrationService;
  /** The identity configuration port the registration keys are snapshotted from. */
  readonly registrationConfig: SmsConfigReader;
  /** The landing keys (legal versions, IP limit), read on `db`, uncached. */
  readonly config: LandingRegisterConfigReader;
  readonly invite: LandingInvitePort;
  /** risk's blocklist (B1-03d); absent or null: no blocklist (as the SMS login's port). */
  readonly blocklist?: Pick<BlocklistService, 'matchRegistration' | 'recordHits'> | null;
}

type Result = 'registered' | 'already_registered';

/** The answer of the flow inside the transaction. */
type Outcome =
  | { readonly code: 0; readonly result: Result }
  | { readonly code: 20002 | 20003 | 30401 | 30408 | 50001 }
  | { readonly code: 42901; readonly retryAfter: number }
  | {
      readonly code: 44001;
      readonly risk_msg_code: string | null;
      readonly afterRollback?: () => Promise<void>;
    };

interface Prepared {
  readonly appId: string;
  readonly phone: string;
  readonly phoneHmac: string;
  readonly ipHmac: string;
  readonly channel: string | undefined;
  readonly agreementVersion: number;
  readonly privacyVersion: number;
  readonly ipLimit: number;
  readonly registrationConfig: SmsConfigReader;
}

function envelopeOf(
  code: number,
  traceId: string,
  data?: Record<string, unknown>,
): LandingEnvelope {
  return {
    code,
    msg: MESSAGES[code] ?? MESSAGES[50001]!,
    ...(data === undefined ? {} : { data }),
    trace_id: traceId,
  };
}

function refused(
  code: number,
  traceId: string,
  data?: Record<string, unknown>,
): LandingRegisterAnswer {
  return {
    kind: 'refused',
    status: STATUSES[code] ?? 500,
    envelope: envelopeOf(code, traceId, data),
  };
}

/** A positive int4, else null. */
function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= INT32_MAX
    ? value
    : null;
}

export function createLandingRegisterService(
  options: LandingRegisterOptions,
): LandingRegisterService {
  const { db, clock, crypto, logger, idempotency, sms, registration, config, invite } = options;
  const blocklist = options.blocklist ?? null;

  /** A legal version (ⓔ): missing or malformed → null and a warning naming the key only. */
  async function legalVersion(appId: string, key: string): Promise<number | null> {
    const entry = await config.configValue(appId, key, db);
    const version = entry === null ? null : positiveInteger(entry.value);
    if (version === null) {
      logger.warn({ app_id: appId, config_key: key }, 'landing_register_config_invalid');
    }
    return version;
  }

  async function ipLimitOf(appId: string): Promise<number> {
    const entry = await config.configValue(appId, LANDING_IP_REGISTER_LIMIT_KEY, db);
    if (entry === null) return DEFAULT_LANDING_IP_REGISTER_LIMIT;
    const limit = positiveInteger(entry.value);
    if (limit !== null) return limit;
    logger.warn(
      { app_id: appId, config_key: LANDING_IP_REGISTER_LIMIT_KEY },
      'landing_register_config_invalid',
    );
    return DEFAULT_LANDING_IP_REGISTER_LIMIT;
  }

  /** ⓗ–ⓙ, after the savepoint. */
  async function createAccount(
    trx: Transaction<DB>,
    prepared: Prepared,
    inviterId: string,
    attemptKey: string,
    clientIp: string,
  ): Promise<Outcome> {
    const { appId, phone, phoneHmac, ipHmac } = prepared;
    const already: Outcome = { code: 0, result: 'already_registered' };

    // ⓗ the phone already has an account (not deleted).
    if (await phoneHeld(trx, appId, phoneHmac)) return already;

    // ⓘ the phone blocklist (BR-ID-31; read only, recorded after the rollback).
    if (blocklist !== null) {
      const block = await blocklist.matchRegistration(trx, {
        app_id: appId,
        phone_hmac: phoneHmac,
        related_phone: phone,
      });
      if (block !== null) {
        const hits = block.hits;
        return {
          code: 44001,
          risk_msg_code: block.data.risk_msg_code,
          afterRollback: async () => {
            await blocklist.recordHits(
              { app_id: appId, request_type: 'register', related_phone: phone },
              hits,
            );
          },
        };
      }
    }

    // ⓘ the IP limit: lock, then count, then create.
    await lockLandingRegistrations(trx, appId, ipHmac);
    // A registration of the same number committed while this one waited for the lock.
    if (await phoneHeld(trx, appId, phoneHmac)) return already;
    const now = clock.now();
    const count = await countLandingRegistrations(trx, appId, ipHmac, now);
    if (count >= prepared.ipLimit) {
      // TODO(规划/11 §2.3): 落地页同 IP 注册上限命中写 risk_hits 与申诉放行 — blocked on 后续 risk 任务
      logger.info({ app_id: appId, count, limit: prepared.ipLimit }, 'landing_register_ip_limited');
      return { code: 44001, risk_msg_code: null };
    }

    // ⓙ the account, its consents, the binding and the landing row.
    const created = await registration.register(trx, {
      app_id: appId,
      phone,
      register_method: 'h5_landing',
      ...(prepared.channel === undefined ? {} : { channel: prepared.channel }),
      client_ip: clientIp,
      config: prepared.registrationConfig,
    });
    if ('outcome' in created) return already;
    if (created.code !== 0) {
      if (created.code === 44001) {
        // No device: the same-device limit cannot apply; anything else is a defect.
        logger.warn({ app_id: appId }, 'landing_register_unexpected_device_limit');
      }
      return { code: 50001 };
    }
    const userId = created.user_id;
    await lockUserConsents(trx, appId, userId);
    await insertConsentRecords(
      trx,
      (
        [
          ['agreement', prepared.agreementVersion],
          ['privacy', prepared.privacyVersion],
        ] as const
      ).map(([type, version]) => ({
        app_id: appId,
        subject_type: 'user',
        user_id: userId,
        device_id: null,
        type,
        version,
        channel: CONSENT_CHANNEL,
        accepted: true,
        client_at: now,
        server_at: now,
        created_at: now,
      })),
    );
    const bound = await invite.bind(trx, {
      app_id: appId,
      user_id: userId,
      inviter_id: inviterId,
      phone_hmac: phoneHmac,
      client_ip: clientIp,
      attempt_key: attemptKey,
    });
    if (bound.result !== 'bound') {
      return { code: bound.code === 30401 ? 30401 : 50001 };
    }
    await insertLandingRegistration(trx, { appId, userId, ipHmac, createdAt: now });
    logger.info({ app_id: appId, user_id: userId }, 'landing_register_created');
    return { code: 0, result: 'registered' };
  }

  /** ⓕ–ⓙ: the idempotency module's handler. */
  async function handle(
    trx: Transaction<DB>,
    prepared: Prepared,
    command: LandingRegisterCommand,
    attemptKey: string,
  ): Promise<Outcome> {
    const { appId, phone, phoneHmac } = prepared;
    const pre = await invite.precheck(trx, {
      app_id: appId,
      phone_hmac: phoneHmac,
      client_ip: command.client_ip,
      invite_code: command.body.invite_code,
      attempt_key: attemptKey,
    });
    if (!pre.ok) {
      if (pre.code === 42901) {
        const seconds = pre.retry_after_seconds;
        if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
          throw new Error('identity: landing 42901 without retry_after_seconds');
        }
        return { code: 42901, retryAfter: Math.max(1, Math.ceil(seconds)) };
      }
      return { code: pre.code };
    }
    const verified = await sms.verifyAndConsume({
      app_id: appId,
      phone,
      purpose: 'login',
      code: command.body.sms_code,
    });
    if (verified.code !== 0) return { code: verified.code };

    await landingSavepoint(trx);
    const outcome = await createAccount(
      trx,
      prepared,
      pre.inviter_id,
      attemptKey,
      command.client_ip,
    );
    if (outcome.code === 0 && outcome.result === 'registered') {
      await releaseLandingSavepoint(trx);
    } else {
      await rollbackLandingSavepoint(trx);
    }
    return outcome;
  }

  function handlerResult(outcome: Outcome, traceId: string): HandlerResult {
    switch (outcome.code) {
      case 0:
        return {
          status: 200,
          envelope: { code: 0, msg: '', data: { result: outcome.result }, trace_id: traceId },
        };
      case 44001:
        return {
          status: 403,
          envelope: envelopeOf(44001, traceId, { risk_msg_code: outcome.risk_msg_code }),
        };
      default:
        return { status: STATUSES[outcome.code]!, envelope: envelopeOf(outcome.code, traceId) };
    }
  }

  return Object.freeze({
    async register(command: LandingRegisterCommand): Promise<LandingRegisterAnswer> {
      const appId = command.app_id;
      const traceId = command.trace_id;
      const body = command.body;

      // ⓑ the agreement box.
      if (body.agreed !== true) {
        return refused(10004, traceId, { consent_type: 'agreement' });
      }
      // ⓒ the phone.
      const normalized = normalize_phone(body.phone);
      if (normalized.code !== 0) {
        return refused(20001, traceId, { fields: ['phone'], reason: 'phone_invalid' });
      }
      const phone = normalized.phone;
      const phoneHmac = crypto.blindIndex(phone, PHONE_BLIND_INDEX_CONTEXT);

      // ⓔ configuration, before the transaction.
      const agreementVersion = await legalVersion(appId, LEGAL_AGREEMENT_VERSION_KEY);
      const privacyVersion = await legalVersion(appId, LEGAL_PRIVACY_VERSION_KEY);
      if (agreementVersion === null || privacyVersion === null) return refused(50001, traceId);
      const ipLimit = await ipLimitOf(appId);
      const registrationConfig = await snapshotRegistrationConfig(
        options.registrationConfig,
        appId,
      );
      const channel = body.channel ?? command.header_channel;
      const prepared: Prepared = {
        appId,
        phone,
        phoneHmac,
        ipHmac: crypto.blindIndex(command.client_ip, LANDING_REGISTRATIONS_IP_CONTEXT),
        channel: channel === undefined || channel === '' ? undefined : channel,
        agreementVersion,
        privacyVersion,
        ipLimit,
        registrationConfig,
      };

      // ⓓ idempotency, then ⓕ–ⓙ in its transaction.
      const key = command.idempotency_key;
      let retryAfter: number | undefined;
      let afterRollback: (() => Promise<void>) | undefined;
      const response = await idempotency.executeInTransaction(
        {
          appId,
          actor: { userId: null, deviceId: null, phoneHmac },
          method: 'POST',
          path: LANDING_REGISTER_PATH,
          key,
          body,
          traceId,
          keyedRequestDigest: true,
        },
        async (trx): Promise<HandlerResult> => {
          // The handler runs only with a well-formed key (20001 otherwise).
          if (key === undefined) throw new Error('identity: landing handler without a key');
          const outcome = await handle(trx, prepared, command, key);
          retryAfter = outcome.code === 42901 ? outcome.retryAfter : undefined;
          afterRollback = outcome.code === 44001 ? outcome.afterRollback : undefined;
          if (outcome.code !== 0) {
            logger.info({ app_id: appId, code: outcome.code }, 'landing_register_refused');
          }
          return handlerResult(outcome, traceId);
        },
      );
      const fromHandler = response.source === 'handler';
      // 44001 is never stored: the transaction has rolled back and released its connection.
      if (fromHandler && afterRollback !== undefined) await afterRollback();
      return {
        kind: 'response',
        status: response.status,
        body: response.body,
        ...(fromHandler && retryAfter !== undefined ? { retryAfter } : {}),
      };
    },
  });
}
