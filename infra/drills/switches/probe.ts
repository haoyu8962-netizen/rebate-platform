// Business probes of the kill-switch drill (QA-05c): what a real run observes per switch, only
// through endpoints the contracts already have (contracts/openapi.yaml). Which switch uses which
// probe, and which cannot be observed at all, is fixed in drill.ts (switchObservationOf).
//
// convert.enabled.<platform>: convertLink, POST /v1/links/convert (x-auth login, x-signed,
// x-idempotent). Switch off → 50301 with data.platform = that platform (error-codes.yaml 50301 ①,
// 规划/02 §14, BR-PROD-10); switch on → code 0 with a link_id. Each probe is a new request: new
// nonce, new Idempotency-Key, signature of BR-ID-09 over the exact body bytes sent.
//
// The probe user's access token and the device's install secret are credentials: they only travel
// in headers or the HMAC key and never reach an observation, an error message or the record.

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { switchSpecOf } from '../../../apps/api/src/modules/content/domain/switch-registry.ts';
import {
  assertSwitchTarget,
  SwitchDrillError,
  switchObservationOf,
  type Observation,
  type ProbeBudget,
  type SwitchTarget,
} from './drill.ts';

/** One signed request; the body is already the exact string that was signed. */
export interface SignedRequest {
  readonly method: 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly redirect: 'error';
  readonly timeoutMs: number;
}

export type SignedTransport = (
  request: SignedRequest,
) => Promise<{ readonly status: number; readonly body: unknown }>;

export interface ConvertProbeConfig {
  /** The user-facing API (`/v1`); same environment and allowlist rules as the admin target. */
  readonly target: SwitchTarget;
  readonly appId: string;
  readonly clientPlatform: 'ios' | 'android' | 'harmony' | 'h5';
  readonly appVersion: string;
  readonly deviceId: string;
  readonly installSecret: string;
  readonly userToken: string;
  /** Product url to convert, per platform (`convert.enabled.<platform>` keys of the run). */
  readonly urls: Readonly<Record<string, string>>;
}

export interface ConvertProbeOptions {
  readonly config: ConvertProbeConfig;
  readonly transport: SignedTransport;
  /** Wall clock for X-Timestamp (the server allows ±300 s). */
  readonly now: () => Date;
}

const CONVERT_PATH = '/v1/links/convert';
const CLIENT_PLATFORMS = new Set(['ios', 'android', 'harmony', 'h5']);
const APP_ID = /^[a-z0-9_]{1,32}$/u;
const APP_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const PRINTABLE = /^[\x21-\x7e]+$/u;
/** A probe never waits longer than this, even with a larger window left. */
const PROBE_TIMEOUT_CAP_MS = 5_000;
const CONVERSION_CLOSED = 50301;

function platformOf(key: string): string | null {
  const spec = switchSpecOf(key);
  if (spec?.pattern !== 'convert.enabled.<platform>') return null;
  return key.slice('convert.enabled.'.length);
}

/** BR-ID-09: lowercase_hex(HMAC-SHA256(utf8(install_secret), signing string)). */
export function signRequest(
  installSecret: string,
  parts: { method: string; pathWithQuery: string; timestamp: string; nonce: string; body: string },
): string {
  const bodyHash = createHash('sha256').update(parts.body, 'utf8').digest('hex');
  const signing = [parts.method, parts.pathWithQuery, parts.timestamp, parts.nonce, bodyHash].join(
    '\n',
  );
  return createHmac('sha256', Buffer.from(installSecret, 'utf8')).update(signing).digest('hex');
}

function validConfig(config: ConvertProbeConfig, keys: readonly string[]): boolean {
  if (
    !APP_ID.test(config.appId) ||
    !CLIENT_PLATFORMS.has(config.clientPlatform) ||
    !APP_VERSION.test(config.appVersion) ||
    !PRINTABLE.test(config.deviceId) ||
    !PRINTABLE.test(config.installSecret) ||
    !PRINTABLE.test(config.userToken)
  ) {
    return false;
  }
  return keys.every((key) => {
    const platform = platformOf(key);
    const url = platform === null ? undefined : config.urls[platform];
    if (url === undefined) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && url.length <= 2048;
    } catch {
      return false;
    }
  });
}

/**
 * The probe for the `convert_link` switches among `keys`. Refuses (probe_unavailable) when a key
 * is not a convert switch or the configuration is incomplete, before any request.
 */
export function createConvertProbe(
  options: ConvertProbeOptions,
  keys: readonly string[],
): (key: string, budget?: ProbeBudget) => Promise<Observation> {
  const { config } = options;
  assertSwitchTarget(config.target);
  if (keys.some((key) => switchObservationOf(key)?.kind !== 'convert_link')) {
    throw new SwitchDrillError('probe_unavailable');
  }
  if (!validConfig(config, keys)) throw new SwitchDrillError('probe_unavailable');
  const url = `${config.target.baseUrl}${CONVERT_PATH}`;

  return async (key, budget) => {
    const platform = platformOf(key);
    const productUrl = platform === null ? undefined : config.urls[platform];
    if (platform === null || productUrl === undefined || !keys.includes(key)) {
      throw new SwitchDrillError('probe_unavailable');
    }
    const body = JSON.stringify({ platform, url: productUrl, scene: 'h5', installed: 'unknown' });
    const timestamp = String(Math.floor(options.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const sign = signRequest(config.installSecret, {
      method: 'POST',
      pathWithQuery: CONVERT_PATH,
      timestamp,
      nonce,
      body,
    });
    let response: { readonly status: number; readonly body: unknown };
    try {
      response = await options.transport({
        method: 'POST',
        url,
        headers: {
          Authorization: `Bearer ${config.userToken}`,
          'X-App-Id': config.appId,
          'X-Platform': config.clientPlatform,
          'X-App-Version': config.appVersion,
          'X-Device-Id': config.deviceId,
          'X-Timestamp': timestamp,
          'X-Nonce': nonce,
          'X-Sign': sign,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
        redirect: 'error',
        timeoutMs: Math.max(
          1,
          Math.min(budget?.timeoutMs ?? PROBE_TIMEOUT_CAP_MS, PROBE_TIMEOUT_CAP_MS),
        ),
      });
    } catch {
      throw new SwitchDrillError('api_error', 'probe transport');
    }
    const envelope = response.body as { code?: unknown; data?: unknown } | null | undefined;
    const code = typeof envelope === 'object' && envelope !== null ? envelope.code : undefined;
    if (typeof code !== 'number' || !Number.isInteger(code)) {
      throw new SwitchDrillError('api_error', 'probe malformed');
    }
    const data = (envelope?.data ?? null) as Record<string, unknown> | null;
    if (code === 0) {
      // Converted: the registered link must be there, or it is not the success it claims.
      if (response.status !== 200 || typeof data?.['link_id'] !== 'string') {
        throw new SwitchDrillError('api_error', 'probe malformed');
      }
      return { code };
    }
    if (code === CONVERSION_CLOSED && data?.['platform'] !== platform) {
      // 50301 without this platform is not the conversion pause of this switch.
      throw new SwitchDrillError('api_error', 'probe malformed');
    }
    // Any other code (login, signature, rate limit, 50001, 50303 …) is reported as it is: it is
    // neither the degradation nor the baseline, so it never passes either check.
    return { code };
  };
}
