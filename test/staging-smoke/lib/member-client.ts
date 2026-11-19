// STAGING-SMOKE (QA-04b): the member side, called the way a native Android client calls it.
//
// - Device: device.json (0600) is reused across runs; POST /v1/devices only when it is missing or
//   belongs to another app_id, and once more when an answer is 10402 (BR-ID-09: register again,
//   replay once).
// - Signature (BR-ID-09; apps/api/src/modules/risk/domain/request-signature.ts): signing string =
//   upper-case method \n path with the raw query as sent \n X-Timestamp (10-digit seconds) \n X-Nonce
//   (32 lower-case hex) \n lowercase_hex(sha256(raw body bytes)); X-Sign = lowercase_hex(HMAC-SHA256(
//   install_secret, signing string)). Only operations marked x-signed in the contract are signed.
// - Idempotency-Key on x-idempotent operations; a replay after 10003 keeps the key (BR-ID-08).
// - Tokens: 10002 → one refresh (rotation, BR-ID-07) and one replay.
// - SMS (BR-ID-05: per phone 1 per 60 s, 5 per hour, 10 per day, over login and step_up together):
//   sends are spaced at least 61 s apart; one 42901 waits its Retry-After (at most 90 s) once.
//   The staging test phone gets no real SMS; its code is the node's fixed code (B1-02zza), which
//   still consumes the code just sent, so every verification is preceded by a send.
// Every secret (install_secret, tokens, signature, the phone, the code) is registered with the
// report's scrubber before it is used, so it cannot reach any output.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { call, okData, type CallResult } from './http.ts';
import {
  readDeviceCredential,
  writeDeviceCredential,
  type DeviceCredential,
} from './node-files.ts';
import { Fail, registerSecret } from './report.ts';

export const PLATFORM = 'android';
export const CHANNEL = 'official';
const SMS_SPACING_MS = 61_000;
const SMS_RETRY_CAP_SEC = 90;

export function signRequest(
  installSecret: string,
  method: string,
  target: string,
  timestamp: string,
  nonce: string,
  body: Buffer,
): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', Buffer.from(installSecret, 'utf8'))
    .update(`${method.toUpperCase()}\n${target}\n${timestamp}\n${nonce}\n${bodyHash}`)
    .digest('hex');
}

export function newIdempotencyKey(): string {
  return `smk_${randomBytes(16).toString('hex')}`;
}

export interface MemberRequest {
  readonly label: string;
  readonly body?: unknown;
  readonly auth?: boolean;
  readonly signed?: boolean;
  readonly idempotencyKey?: string;
  readonly stepUpToken?: string;
  /** Overrides X-App-Version for this request only (the 10405 probe). */
  readonly appVersion?: string;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  /** No refresh-and-replay on 10002 (checking that a revoked token is refused). */
  readonly noRefresh?: boolean;
}

export interface Tokens {
  readonly access: string;
  readonly refresh: string;
}

export class MemberClient {
  readonly #base: string;
  readonly #appId: string;
  #appVersion = '1.0.0';
  #device: DeviceCredential | null = null;
  #reRegistered = false;
  #tokens: Tokens | null = null;
  #lastSmsAt = 0;

  constructor(base: string, appId: string) {
    this.#base = base;
    this.#appId = appId;
  }

  get appVersion(): string {
    return this.#appVersion;
  }

  set appVersion(version: string) {
    this.#appVersion = version;
  }

  get tokens(): Tokens | null {
    return this.#tokens;
  }

  set tokens(tokens: Tokens | null) {
    if (tokens !== null) {
      registerSecret(tokens.access);
      registerSecret(tokens.refresh);
    }
    this.#tokens = tokens;
  }

  get hasDevice(): boolean {
    return this.#device !== null;
  }

  get deviceId(): string {
    if (this.#device === null) throw new Fail('no device registered');
    return this.#device.deviceId;
  }

  /** Loads device.json, or registers a device when there is none for this app_id. */
  async ensureDevice(): Promise<'reused' | 'registered'> {
    const stored = await readDeviceCredential();
    if (stored !== null && stored.appId === this.#appId) {
      registerSecret(stored.installSecret);
      this.#device = stored;
      return 'reused';
    }
    await this.#register(null);
    return 'registered';
  }

  async #register(deviceHash: string | null): Promise<void> {
    // A random identifier hashed like ANDROID_ID (BR-ID-09): stable for this node once stored.
    const hash =
      deviceHash ?? createHash('sha256').update(randomBytes(32).toString('hex')).digest('hex');
    const result = await this.#send('POST', '/v1/devices', {
      label: 'POST /v1/devices',
      body: { device_hash: hash, id_source: 'android_id' },
    });
    const data = okData(result, 'register device');
    const deviceId = data.device_id;
    const secret = data.install_secret;
    if (typeof deviceId !== 'string' || typeof secret !== 'string' || secret.length < 16) {
      throw new Fail('register device: device_id / install_secret missing');
    }
    registerSecret(secret);
    this.#device = { appId: this.#appId, deviceId, installSecret: secret, deviceHash: hash };
    await writeDeviceCredential(this.#device);
  }

  /** One request with the common headers; handles 10402 (once per run) and 10002 (once). */
  async request(method: string, target: string, options: MemberRequest): Promise<CallResult> {
    let result = await this.#send(method, target, options);
    if (result.code === 10402 && !this.#reRegistered && this.#device !== null) {
      this.#reRegistered = true;
      await this.#register(this.#device.deviceHash);
      result = await this.#send(method, target, options);
    }
    if (
      result.code === 10002 &&
      options.auth === true &&
      options.noRefresh !== true &&
      this.#tokens !== null
    ) {
      await this.refresh();
      result = await this.#send(method, target, options);
    }
    return result;
  }

  async #send(method: string, target: string, options: MemberRequest): Promise<CallResult> {
    const headers: Record<string, string> = {
      'X-App-Id': this.#appId,
      'X-Platform': PLATFORM,
      'X-App-Version': options.appVersion ?? this.#appVersion,
      'X-Channel': CHANNEL,
      'X-Trace-Id': randomUUID(),
      ...options.headers,
    };
    if (this.#device !== null) headers['X-Device-Id'] = this.#device.deviceId;
    let body: Buffer | undefined;
    if (options.body !== undefined) {
      body = Buffer.from(JSON.stringify(options.body), 'utf8');
      headers['content-type'] = 'application/json';
    }
    if (options.auth === true) {
      if (this.#tokens === null) throw new Fail(`${options.label}: not logged in`);
      headers.authorization = `Bearer ${this.#tokens.access}`;
    }
    if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;
    if (options.stepUpToken !== undefined) headers['X-Step-Up-Token'] = options.stepUpToken;
    if (options.signed === true) {
      if (this.#device === null) throw new Fail(`${options.label}: no device to sign with`);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = randomBytes(16).toString('hex');
      const sign = signRequest(
        this.#device.installSecret,
        method,
        target,
        timestamp,
        nonce,
        body ?? Buffer.alloc(0),
      );
      registerSecret(sign);
      headers['X-Timestamp'] = timestamp;
      headers['X-Nonce'] = nonce;
      headers['X-Sign'] = sign;
    }
    const callOptions = {
      label: options.label,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    };
    return call(this.#base, method, target, callOptions);
  }

  /** POST /v1/auth/refresh: rotates the refresh token (BR-ID-07). */
  async refresh(): Promise<Tokens> {
    if (this.#tokens === null) throw new Fail('refresh: not logged in');
    const result = await this.#send('POST', '/v1/auth/refresh', {
      label: 'POST /v1/auth/refresh',
      signed: true,
      body: { refresh_token: this.#tokens.refresh },
    });
    const data = okData(result, 'refresh');
    const access = data.access_token;
    const refresh = data.refresh_token;
    if (typeof access !== 'string' || typeof refresh !== 'string') {
      throw new Fail('refresh: token pair missing');
    }
    this.tokens = { access, refresh };
    return this.tokens;
  }

  /**
   * POST /v1/auth/sms-codes, spaced ≥ 61 s from the previous send of this run. login carries the
   * phone; step_up goes to the bound phone of the logged-in account and carries the action.
   */
  async sendSmsCode(
    purpose: 'login' | 'step_up',
    phone: string | null,
    action: 'withdraw' | 'payout_account_change' | null,
  ): Promise<Record<string, unknown>> {
    const wait = this.#lastSmsAt + SMS_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    const body: Record<string, unknown> = { purpose };
    if (phone !== null) body.phone = phone;
    if (action !== null) body.action = action;
    const options: MemberRequest = {
      label: 'POST /v1/auth/sms-codes',
      signed: true,
      auth: purpose === 'step_up',
      body,
    };
    let result = await this.request('POST', '/v1/auth/sms-codes', options);
    if (result.code === 42901) {
      const retryAfter = result.retryAfterSec ?? 60;
      if (retryAfter > SMS_RETRY_CAP_SEC) {
        throw new Fail(
          `sms code: 42901, Retry-After ${String(retryAfter)} s (hourly / daily SMS limit of the test phone?)`,
        );
      }
      await sleep((retryAfter + 1) * 1000);
      result = await this.request('POST', '/v1/auth/sms-codes', options);
    }
    this.#lastSmsAt = Date.now();
    return okData(result, 'sms code');
  }

  /** POST /v1/auth/step-up by SMS (fixed code of the staging test phone) with its summary. */
  async stepUp(
    action: 'withdraw' | 'payout_account_change',
    code: string,
    summary: Record<string, unknown>,
  ): Promise<string> {
    await this.sendSmsCode('step_up', null, action);
    const result = await this.request('POST', '/v1/auth/step-up', {
      label: 'POST /v1/auth/step-up',
      signed: true,
      auth: true,
      body: { action, code, summary },
    });
    const data = okData(result, `step-up ${action}`);
    const token = data.step_up_token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new Fail(`step-up ${action}: no step_up_token`);
    }
    registerSecret(token);
    if (typeof data.expire_at !== 'string') throw new Fail(`step-up ${action}: no expire_at`);
    return token;
  }
}
