// SMS codes (规划/08 BR-ID-05; 04 §6.1 POST /v1/auth/sms-codes): sending a code for login / bind /
// step_up, and «check and consume» for the endpoints that take one (B1-02j login, B1-02f step-up,
// B1-20 phone binding reuse verifyAndConsume and normalize_phone).
//
// send(), in the order of BR-ID-05 (signature ① and the token stages run before the controller):
//   1. normalize_phone → 20001 phone_invalid (no SMS, nothing counted);
//   2. prefix blocklist sms.blocked_prefixes of the request's app (08 default when the key is
//      missing or malformed) on the E.164 form → 44001, kind blocked_prefix (B1-03d records the
//      risk hit through hooks.blockedPrefix). Before deciding, hooks.blockedPrefixInForce asks
//      whether rule SMS_BLOCKED_PREFIX of the app takes part in judgements (B1-03zh, BR-ID-36
//      细则「规则清单的启停」): false → no prefix decision at all (no 44001, no hit), the request
//      goes on to step 3; no hook → in force;
//   3. insertion points, in order, each short-circuits: phoneBlocklist (44001, B1-03d) → captcha
//      (44003, B1-03g) → deviceQuota (42901, B1-03g). They get the request with the normalised
//      number, the device id and the client IP. A landing page send (channel=landing, B1-11g,
//      BR-ID-32: purpose=login, no signature, no device, no human verification) runs
//      phoneBlocklist and then landingQuota (42901: the two per-IP items only) instead of captcha
//      and deviceQuota; without a landingQuota hook it is refused (42901, Retry-After 5). Both
//      judge the per-IP items read-only and, admitted, hand back an attempt gate (B1-11g round 7);
//   4a. once the phone quota below is reserved, the gate commits the send's PG attempt (the IP's
//      count read again under its lock): refused → the phone reservation is released, 42901. A
//      request refused by any check writes no attempt. The committed attempt counts for the IP;
//      once the send is over the service writes its outcome — accepted, unknown (from the provider
//      call on, whatever happens), or failed (the provider definitely refused, or the service
//      stopped before calling it), which stops counting;
//   4. one atomic call reserves the per-phone quota (60 s / natural hour / natural day / rolling
//      24 h, uncommitted sends counted over [reservation, reservation + D], D = sendTimeoutMs +
//      SMS_IN_FLIGHT_MARGIN_MS) and stores the new random code as the reserved candidate of (app,
//      phone, purpose) (infra/sms-code-store.ts): a limit → 42901 with the latest release; a
//      candidate equal to a code the record still knows → another code is drawn (at most
//      SMS_CODE_DRAWS, then 50001); Redis unavailable or no reply → a best-effort release of the
//      token, then 42901, Retry-After 5, no SMS (the previous code stays valid);
//   5. mark (at most two attempts) turns the candidate into the sending one while the reservation
//      is within D: from here the previous code is void. No answer, a reservation too old, or the
//      candidate gone → release, 42901, Retry-After 5, no SMS. Before sending, the service checks
//      once more that no more than SMS_IN_FLIGHT_MARGIN_MS passed since the reservation (a stalled
//      process): otherwise release, 42901, no SMS. So the provider answers within D of the
//      reservation, the span the store counts an uncommitted send over;
//   6. the code goes to the sender port, bounded by sendTimeoutMs (a timeout is «unknown»):
//      - accepted or unknown (timeout, a thrown adapter error, any other answer): counted as sent
//        (ruling §9.5 #1) — the commit counts the send at the time the provider answered and puts
//        the candidate in force; it is retried once with the same token (idempotent, nothing is
//        resent). If it still fails, the reservation keeps counting conservatively and the
//        candidate stays the current code, so the answer is still 0. afterAccepted runs (B1-03g
//        counters; its failure is logged, never answered). resend_after_sec is the seconds until
//        the next send may go (≥ 60);
//      - rejected: the reservation and the candidate are dropped (nothing counted, the previous
//        code is in force again with the candidate's wrong tries added), the answer is 50001.
// Every release is retried once with the same token (idempotent); what a failed release leaves is
// listed in infra/sms-code-store.ts.
// verifyAndConsume(): see its comment.
//
// Staging test phones (B1-02zza, FU-STAGING-TEST-PHONE; approvals #48, ruling D10-611): only with
// appEnv 'staging' (re-checked on every call, and the service refuses to be built with test phones
// in any other environment), for a listed number and purpose login or step_up on the app route
// (not bind, not the landing page): send() runs every step above unchanged — the random code is
// drawn, stored as an HMAC and counted — and only step 6 does not call the sender: the delivery
// is taken as accepted. verifyAndConsume() also takes the node's fixed code for such a number
// (timingSafeEqual): equal → the current code of (app, phone, purpose) is consumed under the same
// expiry / single-use / five-wrong-tries rules; not equal → the ordinary check (a wrong try).
// The answer then carries staging_test_phone: true so the caller writes its audit line.
//
// Nothing is logged that identifies the number or the code: no phone in any form, no code, no
// captcha_token, no device id or IP (BR-ID-33). Codes and keys are HMACs made by the injected
// `hmac` (production: the field-encryption blind index, the same in every process).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators, no Nest.
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  RedisUnavailableError,
  type AppEnv,
  type Clock,
  type RedisHandle,
  type RootLogger,
  type StagingTestPhones,
} from '../../platform/index.ts';
import { normalize_phone } from '../domain/normalize-phone.ts';
import {
  SMS_BLOCKED_PREFIXES_KEY,
  SMS_CODE_DIGITS,
  SMS_CODE_LIFETIME_SECONDS,
  SMS_DEFAULT_BLOCKED_PREFIXES,
  SMS_RESEND_INTERVAL_MS,
  SMS_UNAVAILABLE_RETRY_AFTER_SECONDS,
  isBlockedPrefix,
  parseBlockedPrefixes,
  secondsUntil,
} from '../domain/sms-limits.ts';
import { createSmsCodeStore, type ReserveOutcome, type SmsKeys } from '../infra/sms-code-store.ts';

export type SmsPurpose = 'login' | 'bind' | 'step_up';
export type SmsDelivery = 'accepted' | 'rejected' | 'unknown';
export interface SmsMessage {
  readonly app_id: string;
  readonly phone: string;
  readonly purpose: SmsPurpose;
  readonly code: string;
}
/**
 * Sender port (identity today; the real provider adapter moves to notification, ruling §9.3 #6):
 * accepted, definitely rejected, or outcome unknown. An adapter that fails before anything left
 * the process (a configuration error, a refused credential, a malformed request it builds) must
 * answer `rejected`: a thrown error, a timeout or any other answer counts as sent (`unknown`).
 * A real adapter must finish or abort its provider call within sendTimeoutMs (an AbortSignal on
 * the HTTP request): the service stops waiting then and counts the send as unknown, and a call
 * that still reaches the provider later would be accepted outside the span the quota counts.
 */
export interface SmsSender {
  send(message: SmsMessage): Promise<SmsDelivery>;
}
export interface SmsRequest {
  readonly app_id: string;
  readonly phone: string;
  readonly purpose: SmsPurpose;
  readonly captcha_token?: string;
  readonly action?: string;
  /** The verified device of the request (stage ①), for the device limits of B1-03g. */
  readonly device_id?: string;
  /** The client IP Fastify reports, for the IP limits and captcha triggers of B1-03g. */
  readonly client_ip?: string;
  /**
   * Where the send comes from: the app route (default) or the landing page route (B1-11g,
   * BR-ID-32), which has no device and is judged by landingQuota instead of captcha/deviceQuota.
   */
  readonly channel?: 'app' | 'landing';
}
export type SmsResult =
  | {
      readonly code: 0;
      readonly data: { readonly resend_after_sec: number; readonly expires_in_sec: number };
    }
  | {
      readonly code: 20001;
      readonly data: { readonly fields: readonly string[]; readonly reason: 'phone_invalid' };
    }
  | {
      readonly code: 44001;
      readonly kind: 'blocked_prefix' | 'phone_blocklist';
      readonly data?: { readonly risk_msg_code: string };
    }
  | { readonly code: 44003 }
  | { readonly code: 42901; readonly retryAfterSec: number }
  | { readonly code: 50001 };
/** The send's committed attempt (B1-11g): counted for the IP until it is written failed. */
export interface SmsAttemptSlot {
  readonly code: 0;
  /** Writes the send's outcome on the attempt (a failed write leaves it pending, counted). */
  finish(outcome: 'accepted' | 'failed' | 'unknown'): Promise<void>;
}
/** The per-IP items passed (landingQuota / deviceQuota, B1-11g); commit makes it binding. */
export interface SmsAttemptGate {
  readonly code: 0;
  /** The IP's attempts read again under its lock: below the limit, the attempt is committed. */
  commit(): Promise<SmsAttemptSlot | Extract<SmsResult, { code: 42901 }>>;
}
/** The identity configuration port (content implements it; app.module assembles it). */
export interface SmsConfigReader {
  configValue(
    appId: string,
    key: string,
  ): Promise<{ readonly value: unknown; readonly version: number } | null>;
}
/** Ordered seams for B1-03d/g, after normalisation/prefix checks and before phone quota. */
export interface SmsHooks {
  /**
   * B1-03zh (BR-ID-36): whether the prefix rule (SMS_BLOCKED_PREFIX) of the request's app takes
   * part in judgements now; asked before the prefix decision. Absent → in force.
   */
  readonly blockedPrefixInForce?: (request: SmsRequest) => Promise<boolean>;
  /**
   * B1-03d: records the risk hit of a prefix refusal already decided here (no new decision). The
   * decision was taken on the rule in force (blockedPrefixInForce, the one status read of this
   * request, B1-03zh), so the recorder writes the hit without reading the status again.
   */
  readonly blockedPrefix?: (request: SmsRequest) => Promise<void>;
  readonly phoneBlocklist?: (
    request: SmsRequest,
  ) => Promise<Extract<SmsResult, { code: 44001 }> | null>;
  readonly captcha?: (request: SmsRequest) => Promise<Extract<SmsResult, { code: 44003 }> | null>;
  /**
   * B1-03g: the app route's 42901 step. null = admitted without an attempt (no client IP, or a
   * risk port without attempts); a gate = admitted, its attempt committed later (B1-11g).
   */
  readonly deviceQuota?: (
    request: SmsRequest,
  ) => Promise<Extract<SmsResult, { code: 42901 }> | SmsAttemptGate | null>;
  /**
   * B1-11g: the landing page send's 42901 step before the phone quota (the per-IP items only).
   * Admitted, it returns the attempt gate.
   */
  readonly landingQuota?: (
    request: SmsRequest,
  ) => Promise<Extract<SmsResult, { code: 42901 }> | SmsAttemptGate>;
  readonly afterAccepted?: (request: SmsRequest) => Promise<void>;
}
export interface SmsCodeOptions {
  readonly clock: Clock;
  readonly redis: RedisHandle;
  readonly sender: SmsSender;
  readonly config: SmsConfigReader;
  readonly logger: RootLogger;
  readonly hmac: (text: string) => string;
  readonly hooks?: SmsHooks;
  /**
   * Longest wait for the sender, in milliseconds (default SMS_SEND_TIMEOUT_MS); far below the
   * 60-second window, so a slow provider cannot let a second request for the phone through.
   */
  readonly sendTimeoutMs?: number;
  /**
   * B1-02zza (D10-611): APP_ENV of the entry. The staging test phones are honoured only when it is
   * 'staging'; absent counts as not staging.
   */
  readonly appEnv?: AppEnv;
  /**
   * B1-02zza (FU-STAGING-TEST-PHONE, approvals #48): numbers whose app login / step_up codes are
   * not handed to the sender (the random code is still drawn, stored and counted, every check and
   * limit still runs) and whose check also takes the fixed code. Given with an appEnv other than
   * 'staging', the service refuses to be built. Absent or null: none.
   */
  readonly stagingTestPhones?: StagingTestPhones | null;
}
/**
 * The answer of verifyAndConsume. `staging_test_phone: true` only on 0 for a staging test phone
 * (B1-02zza): the login / step-up service writes its pino audit line (staging_test_phone_login).
 */
export interface SmsVerifyResult {
  readonly code: 0 | 20002 | 20003;
  readonly staging_test_phone?: true;
}
/**
 * Options of one verifyAndConsume call. `stagingTestCode: false` turns the staging fixed code off
 * for that call (identity.module passes it for the landing page registration, which is outside
 * D10-611's scope); absent → on (still only staging, a listed number, login / step_up).
 */
export interface SmsVerifyOptions {
  readonly stagingTestCode?: boolean;
}
export interface SmsCodeService {
  send(request: SmsRequest): Promise<SmsResult>;
  verifyAndConsume(
    request: Pick<SmsMessage, 'app_id' | 'phone' | 'purpose' | 'code'>,
    options?: SmsVerifyOptions,
  ): Promise<SmsVerifyResult>;
}

/** B1-02zza: event (and message) of the pino audit line of a staging test phone's success. */
export const STAGING_TEST_PHONE_AUDIT_EVENT = 'staging_test_phone_login';

/** Default bound of one send (review round 1 S3-2). */
export const SMS_SEND_TIMEOUT_MS = 10_000;
/**
 * Added to sendTimeoutMs for the in-flight bound D of an uncommitted send: the mark attempts before
 * the send and the clock read after it (review round 2).
 */
export const SMS_IN_FLIGHT_MARGIN_MS = 5_000;
/** Codes drawn before a run of collisions answers 50001 (review round 1). */
export const SMS_CODE_DRAWS = 8;
/** Attempts of mark and of commit with the same token (the first and one retry). */
const ATTEMPTS = 2;

const CODE_FORMAT = /^[0-9]{6}$/;
/** Purposes a staging test phone covers (D10-611: app login and step_up; never bind). */
const TEST_PHONE_PURPOSES: ReadonlySet<SmsPurpose> = new Set<SmsPurpose>(['login', 'step_up']);
const CODE_SPACE = 10 ** SMS_CODE_DIGITS;
const DELIVERIES: ReadonlySet<unknown> = new Set(['accepted', 'rejected', 'unknown']);
const TIMED_OUT = Symbol('timed out');

function newCode(): string {
  return String(randomInt(0, CODE_SPACE)).padStart(SMS_CODE_DIGITS, '0');
}

function errorClass(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || error.name;
  return error === null ? 'null' : typeof error;
}

export function createSmsCodeService(options: SmsCodeOptions): SmsCodeService {
  const { clock, sender, config, logger } = options;
  const hooks = options.hooks ?? {};
  const sendTimeoutMs = options.sendTimeoutMs ?? SMS_SEND_TIMEOUT_MS;
  if (!Number.isSafeInteger(sendTimeoutMs) || sendTimeoutMs < 1) {
    throw new TypeError('createSmsCodeService: sendTimeoutMs must be a positive integer');
  }
  // B1-02zza: test phones only in staging; anywhere else (absent appEnv included) refuse to build.
  const testPhones = options.stagingTestPhones ?? null;
  if (testPhones !== null) {
    if (options.appEnv !== 'staging') {
      throw new TypeError(
        'createSmsCodeService: staging test phones are only allowed when APP_ENV=staging',
      );
    }
    if (typeof testPhones.code !== 'string' || !CODE_FORMAT.test(testPhones.code)) {
      throw new TypeError('createSmsCodeService: the staging fixed code must be 6 ASCII digits');
    }
  }
  const testPhoneSet: ReadonlySet<string> = new Set(testPhones?.phones ?? []);
  const fixedCode = testPhones === null ? null : Buffer.from(testPhones.code, 'utf8');
  /** Whether (phone, purpose) is a staging test phone's; appEnv is judged again on every call. */
  const isTestPhone = (phone: string, purpose: SmsPurpose): boolean =>
    options.appEnv === 'staging' &&
    fixedCode !== null &&
    TEST_PHONE_PURPOSES.has(purpose) &&
    testPhoneSet.has(phone);
  const store = createSmsCodeStore(options.redis, {
    inFlightMs: sendTimeoutMs + SMS_IN_FLIGHT_MARGIN_MS,
  });
  // Domain-separated inputs of the one injected HMAC; app ids are [a-z0-9_] and purposes fixed.
  const phoneKey = (phone: string): string => options.hmac(`phone:${phone}`);
  const keysOf = (appId: string, purpose: SmsPurpose, phone: string): SmsKeys => {
    const key = phoneKey(phone);
    return { phoneKey: key, codeKey: `${appId}:${purpose}:${key}` };
  };
  const codeHash = (appId: string, purpose: SmsPurpose, phone: string, code: string): string =>
    options.hmac(`code:${appId}:${phone}:${purpose}:${code}`);
  const nowMs = (): number => clock.now().getTime();

  async function blockedPrefixes(appId: string): Promise<readonly string[]> {
    const entry = await config.configValue(appId, SMS_BLOCKED_PREFIXES_KEY);
    if (entry === null) return SMS_DEFAULT_BLOCKED_PREFIXES;
    const prefixes = parseBlockedPrefixes(entry.value);
    if (prefixes !== null) return prefixes;
    logger.warn(
      { app_id: appId, config_key: SMS_BLOCKED_PREFIXES_KEY, config_version: entry.version },
      'sms_config_invalid',
    );
    return SMS_DEFAULT_BLOCKED_PREFIXES;
  }

  async function deliver(message: SmsMessage, testPhone: boolean): Promise<SmsDelivery> {
    const fields = { app_id: message.app_id, purpose: message.purpose };
    // B1-02zza: a staging test phone's code never goes to the sender; it counts as accepted.
    if (testPhone && isTestPhone(message.phone, message.purpose)) {
      logger.info(fields, 'sms_staging_test_phone_not_sent');
      return 'accepted';
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const sending = Promise.resolve().then(() => sender.send(message));
      // A send still running after the timeout must not surface as an unhandled rejection.
      sending.catch(() => undefined);
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), sendTimeoutMs);
      });
      const delivery: unknown = await Promise.race([sending, timeout]);
      if (delivery === TIMED_OUT) {
        logger.warn({ ...fields, timeout_ms: sendTimeoutMs }, 'sms_delivery_timeout');
        return 'unknown';
      }
      if (DELIVERIES.has(delivery)) return delivery as SmsDelivery;
      logger.warn(fields, 'sms_delivery_unexpected');
    } catch (error) {
      logger.warn({ ...fields, error_class: errorClass(error) }, 'sms_delivery_failed');
    } finally {
      clearTimeout(timer);
    }
    return 'unknown';
  }

  /** Runs a store step, retried once on a Redis failure; null when it did not answer. */
  async function retried<T>(step: () => Promise<T>): Promise<T | null> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await step();
      } catch (error) {
        if (!(error instanceof RedisUnavailableError)) throw error;
        if (attempt >= ATTEMPTS) return null;
      }
    }
  }

  /** The outcome of an attempt slot; a failure is only logged (the row stays pending, counted). */
  async function finishSlot(
    slot: SmsAttemptSlot,
    outcome: 'accepted' | 'failed' | 'unknown',
    fields: object,
  ): Promise<void> {
    try {
      await slot.finish(outcome);
    } catch (error) {
      logger.warn({ ...fields, error_class: errorClass(error) }, 'sms_attempt_slot_finish_failed');
    }
  }

  /** Release of a send that never went out (or was refused), retried once; failure only logged. */
  async function releaseQuietly(keys: SmsKeys, token: string, fields: object): Promise<void> {
    try {
      if ((await retried(() => store.release(keys, token, nowMs()))) !== null) return;
      logger.warn({ ...fields, reason: 'unavailable' }, 'sms_release_failed');
    } catch (error) {
      logger.warn({ ...fields, error_class: errorClass(error) }, 'sms_release_failed');
    }
  }

  return Object.freeze({
    async send(request: SmsRequest): Promise<SmsResult> {
      const normalized = normalize_phone(request.phone);
      if (normalized.code !== 0) {
        return { code: 20001, data: { fields: ['phone'], reason: 'phone_invalid' } };
      }
      const phone = normalized.phone;
      const { app_id: appId, purpose } = request;
      const checked: SmsRequest = { ...request, phone };

      // A disabled prefix rule decides nothing (BR-ID-36): asked before the decision.
      const prefixInForce = (await hooks.blockedPrefixInForce?.(checked)) ?? true;
      if (prefixInForce && isBlockedPrefix(phone, await blockedPrefixes(appId))) {
        logger.info({ app_id: appId, purpose, kind: 'blocked_prefix' }, 'sms_code_blocked');
        // B1-03d: the risk hit of this decision (its own short transaction; a failure rejects,
        // since every hit must be recorded, BR-ID-36).
        await hooks.blockedPrefix?.(checked);
        return { code: 44001, kind: 'blocked_prefix' };
      }
      const blocked = (await hooks.phoneBlocklist?.(checked)) ?? null;
      if (blocked !== null) return blocked;
      let gate: SmsAttemptGate | null = null;
      let slot: SmsAttemptSlot | null = null;
      if (request.channel === 'landing') {
        // BR-ID-32: no human verification and no device step; the per-IP items must be judged.
        if (hooks.landingQuota === undefined) {
          logger.error({ app_id: appId, purpose }, 'sms_landing_quota_missing');
          return { code: 42901, retryAfterSec: SMS_UNAVAILABLE_RETRY_AFTER_SECONDS };
        }
        const verdict = await hooks.landingQuota(checked);
        if (verdict.code === 42901) return verdict;
        gate = verdict;
      } else {
        const captcha = (await hooks.captcha?.(checked)) ?? null;
        if (captcha !== null) return captcha;
        const device = (await hooks.deviceQuota?.(checked)) ?? null;
        if (device !== null && device.code === 42901) return device;
        gate = device;
      }

      // The attempt's outcome; anything that ends before the provider call is failed (nothing sent).
      let outcome: 'accepted' | 'failed' | 'unknown' = 'failed';
      const quotaAndSend = async (): Promise<SmsResult> => {
        const keys = keysOf(appId, purpose, phone);
        const token = randomBytes(16).toString('hex');
        const reservedAt = nowMs();
        let reservation: ReserveOutcome = { kind: 'collision' };
        let code = '';
        try {
          for (let draw = 0; draw < SMS_CODE_DRAWS && reservation.kind === 'collision'; draw++) {
            code = newCode();
            const hash = codeHash(appId, purpose, phone, code);
            reservation = await store.reserve(keys, token, hash, purpose, reservedAt);
          }
        } catch (error) {
          if (!(error instanceof RedisUnavailableError)) throw error;
          logger.warn({ app_id: appId, purpose, reason: error.reason }, 'sms_quota_unavailable');
          // The call may have run with its reply lost: undo it, so that nothing counts and the
          // reserved candidate goes (the code in force was never void).
          await releaseQuietly(keys, token, { app_id: appId, purpose });
          return { code: 42901, retryAfterSec: SMS_UNAVAILABLE_RETRY_AFTER_SECONDS };
        }
        if (reservation.kind === 'collision') {
          logger.error({ app_id: appId, purpose, draws: SMS_CODE_DRAWS }, 'sms_code_collision');
          return { code: 50001 };
        }
        if (reservation.kind === 'limited') {
          const retryAfterSec = secondsUntil(reservation.releaseAtMs, reservedAt);
          logger.info(
            { app_id: appId, purpose, retry_after_sec: retryAfterSec },
            'sms_code_limited',
          );
          return { code: 42901, retryAfterSec };
        }
        // 4a. The phone quota is held: commit the attempt (counted for the IP from here on).
        if (gate !== null) {
          const committed = await gate.commit();
          if (committed.code === 42901) {
            await releaseQuietly(keys, token, { app_id: appId, purpose });
            return committed;
          }
          slot = committed;
        }

        // From here the candidate is the current code; without that, no SMS goes out.
        const marked = await retried(() => store.mark(keys, token, nowMs()));
        if (marked !== true) {
          logger.warn(
            { app_id: appId, purpose, reason: marked === null ? 'unavailable' : 'refused' },
            'sms_mark_failed',
          );
          await releaseQuietly(keys, token, { app_id: appId, purpose });
          return { code: 42901, retryAfterSec: SMS_UNAVAILABLE_RETRY_AFTER_SECONDS };
        }
        // A process that stalled since the reservation could let the provider answer after
        // reservation + D, outside the span an uncommitted send is counted over: do not send.
        const late = nowMs() - reservedAt;
        if (late > SMS_IN_FLIGHT_MARGIN_MS) {
          logger.warn({ app_id: appId, purpose, late_ms: late }, 'sms_send_late');
          await releaseQuietly(keys, token, { app_id: appId, purpose });
          return { code: 42901, retryAfterSec: SMS_UNAVAILABLE_RETRY_AFTER_SECONDS };
        }

        // From the provider call on, the attempt may have sent: never failed unless refused.
        outcome = 'unknown';
        const delivery = await deliver(
          { app_id: appId, phone, purpose, code },
          request.channel !== 'landing',
        );
        outcome = delivery === 'rejected' ? 'failed' : delivery;
        if (delivery === 'rejected') {
          // A failed release leaves the send counted and the candidate current: stricter, not looser.
          await releaseQuietly(keys, token, { app_id: appId, purpose });
          logger.warn({ app_id: appId, purpose }, 'sms_code_rejected');
          return { code: 50001 };
        }

        // The 60-second window and the committed code's lifetime start when the provider answered.
        const acceptedAt = nowMs();
        let releaseAt = await retried(() => store.commit(keys, token, acceptedAt));
        if (releaseAt === null) {
          // The reservation still counts (conservatively) and the candidate is current.
          logger.error({ app_id: appId, purpose }, 'sms_commit_failed');
          releaseAt = Math.max(reservation.releaseAtMs, acceptedAt + SMS_RESEND_INTERVAL_MS);
        }
        // The SMS went out (or may have): the post-acceptance counters see it either way, and
        // their failure does not change the answer.
        try {
          await hooks.afterAccepted?.(checked);
        } catch (error) {
          logger.error(
            { app_id: appId, purpose, error_class: errorClass(error) },
            'sms_after_accepted_failed',
          );
        }
        logger.info({ app_id: appId, purpose, delivery }, 'sms_code_sent');
        return {
          code: 0,
          data: {
            resend_after_sec: Math.max(
              SMS_RESEND_INTERVAL_MS / 1000,
              secondsUntil(releaseAt, acceptedAt),
            ),
            expires_in_sec: SMS_CODE_LIFETIME_SECONDS,
          },
        };
      };
      try {
        return await quotaAndSend();
      } finally {
        // The attempt keeps counting whatever happened; only its status is written.
        if (slot !== null) await finishSlot(slot, outcome, { app_id: appId, purpose });
      }
    },

    /**
     * 0 when the code matches the current code of (app, phone, purpose), which is consumed; 20002
     * when a current code exists and this one is wrong (counted; the fifth wrong try voids the
     * code); 20003 when there is no current code (never sent, expired after 300 s, replaced,
     * consumed, void) or the submitted code is one of those. Redis failures reject.
     * The caller normalises the number first (normalize_phone) and answers 20001 phone_invalid
     * itself when it does not normalise; such a number has no code here and answers 20003.
     */
    async verifyAndConsume(
      request: Pick<SmsMessage, 'app_id' | 'phone' | 'purpose' | 'code'>,
      verifyOptions?: SmsVerifyOptions,
    ): Promise<SmsVerifyResult> {
      const normalized = normalize_phone(request.phone);
      if (normalized.code !== 0) return { code: 20003 };
      const { app_id: appId, purpose, code } = request;
      const phone = normalized.phone;
      // B1-02zza: the fixed code of a staging test phone consumes the current code (same expiry,
      // single use and wrong-try limit); any other value is checked as usual below.
      const given =
        typeof code === 'string' && verifyOptions?.stagingTestCode !== false
          ? Buffer.from(code, 'utf8')
          : null;
      if (
        given !== null &&
        fixedCode !== null &&
        isTestPhone(phone, purpose) &&
        given.length === fixedCode.length &&
        timingSafeEqual(given, fixedCode)
      ) {
        const consumed = await store.consumeCurrent(keysOf(appId, purpose, phone).codeKey, nowMs());
        if (consumed !== 'consumed') return { code: 20003 };
        return { code: 0, staging_test_phone: true };
      }
      // A value that cannot be a code is a wrong try without being hashed.
      const hash =
        typeof code === 'string' && CODE_FORMAT.test(code)
          ? codeHash(appId, purpose, phone, code)
          : '';
      const outcome = await store.verify(keysOf(appId, purpose, phone).codeKey, hash, nowMs());
      if (outcome === 'consumed') return { code: 0 };
      if (outcome === 'wrong') return { code: 20002 };
      return { code: 20003 };
    },
  });
}
