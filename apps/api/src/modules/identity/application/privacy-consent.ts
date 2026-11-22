// Stage ⑦ (10004, privacy consent below legal.privacy.min_version) of the request decision order
// (规划/08 BR-ID-01 判定顺序, BR-ID-12; task B1-02zh, orchestrator rulings §9.2 / §9.3). The public
// entry points follow the frozen rule-test skeleton in test/spec/identity/privacy-min-version/**.
//
// Which routes: only the contract's x-auth login / phone / realname of the matched route
// (platform's contractAuthOf, over the generated table that includes planned operations); none,
// optional (every /v1/agent/ route included) and routes outside the contract are not judged and
// read nothing. The only exemption is POST /v1/auth/logout (one list, PRIVACY_EXEMPT below).
//
// The rule: legal.privacy.min_version through the configuration reader app.module assembles
// (content's reader). Missing → not judged, let through, a warn with the config_key only; present
// but not an int32 integer ≥ 1 → 50001. The missing-key warning is written once per assembled
// checks (per process): every login-level request of an unconfigured environment would otherwise
// add one, and production cannot lack the key (GET /v1/config answers 50001 without it, BR-ID-12).
// The user's current privacy state is the newest user-level row (server_at DESC, id DESC:
// currentStates' tie rule), never a device-level one (BR-ID-13). No row → let through;
// accepted=false or version < min_version → 10004.
//
// From the database, uncached: one consent_records read (LIMIT 1, consent_records_user_type_idx)
// per judged request. No configuration reader assembled (an app without content's reader or
// without a database) counts as the key missing: not judged, nothing read, no warning
// (orchestrator ruling, B1-02zh round 2). Only after a valid min_version has been read is the
// consent needed: then no database or a failing read answers 50001, as does a failing
// configuration read: never let through.
//
// Where (both paths, after ⑤ and before ⑧ ⑨; app.module puts them first in RiskModule's lists):
// - non-idempotent operations: the guard (beforeRateLimitGuards); it skips the contract's
//   x-idempotent operations, judged by the post-miss check;
// - idempotent operations: the post-miss check (beforeRateLimit), reading the configuration and the
//   consent on the claim's transaction (idempotencyPostMissTransaction()), never a second pooled
//   connection. 10004 is a 1xxxx: rolled back, no idempotency record, later checks never run.
//   Outside an HTTP request (jobs, direct calls of the idempotency service) it skips.
// Both paths refuse with the same contract envelope inside an HttpException (④a precedent, risk's
// minimum-version.ts), since RequestRejection carries no data.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no decorators.
import { HttpException } from '@nestjs/common';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  RequestRejection,
  contractAuthOf,
  idempotencyPostMissTransaction,
  tokenPrincipal,
  type IdempotencyPostMissCheck,
  type RootLogger,
  type TokenPrincipal,
} from '../../platform/index.ts';
import {
  RiskModule,
  contractMinimumVersionRoutes,
  type MinimumVersionRequest,
} from '../../risk/index.ts';

export interface PrivacyConsentInput {
  /** The configured legal.privacy.min_version value; undefined when the key is missing. */
  readonly minVersion: unknown;
  readonly current: { readonly accepted: boolean; readonly version: number } | null;
}

/** content's reader shape (configValue); null when the key is missing. */
export interface PrivacyConsentConfigReader {
  configValue(
    appId: string,
    key: string,
  ): Promise<{ readonly value: unknown; readonly version: number } | null>;
}

export interface PrivacyConsentOptions {
  readonly db: Kysely<DB> | null;
  /** pooled: the guard's reader; on: a fresh reader over the claim's transaction. */
  readonly config: {
    readonly pooled: PrivacyConsentConfigReader;
    readonly on: (handle: Kysely<DB>) => PrivacyConsentConfigReader;
  } | null;
  readonly logger: Pick<RootLogger, 'warn'>;
}

export interface PrivacyConsentChecks {
  readonly guard: {
    canActivate(context: {
      switchToHttp(): { getRequest(): MinimumVersionRequest };
    }): Promise<boolean>;
  };
  readonly postMiss: IdempotencyPostMissCheck;
}

/** Nest token of the assembled PrivacyConsentChecks (identity.module provides, app.module wires). */
export const PRIVACY_CONSENT_CHECKS = Symbol('PRIVACY_CONSENT_CHECKS');

const MIN_VERSION_KEY = 'legal.privacy.min_version';
const INT32_MAX = 2147483647;
/** identity's 10004 wording (landing-register.ts, realname.controller.ts). */
const CONSENT_REQUIRED_MSG = '请先阅读并同意相关授权';

/** The only routes of x-auth ≥ login that stage ⑦ lets through, `METHOD template`. */
const PRIVACY_EXEMPT: ReadonlySet<string> = new Set(['POST /v1/auth/logout']);

const unavailable = () => new RequestRejection(50001, 500, '服务端错误');

function privacyRequired(traceId: string): HttpException {
  return new HttpException(
    {
      code: 10004,
      msg: CONSENT_REQUIRED_MSG,
      data: { consent_type: 'privacy' },
      trace_id: traceId,
    },
    403,
  );
}

/**
 * BR-ID-12: an undefined minimum is not judged; an invalid one throws 50001; no current state
 * lets through; a withdrawn or older current state answers 10004.
 */
export function privacyConsentRefusal(input: PrivacyConsentInput): null | 10004 {
  const { minVersion, current } = input;
  if (minVersion === undefined) return null;
  if (
    typeof minVersion !== 'number' ||
    !Number.isInteger(minVersion) ||
    minVersion < 1 ||
    minVersion > INT32_MAX
  ) {
    throw unavailable();
  }
  if (current === null) return null;
  if (!current.accepted || current.version < minVersion) return 10004;
  return null;
}

let idempotentRoutes: ReadonlySet<string> | undefined;

/** The contract's x-idempotent operations, `METHOD template` (built once, on first use). */
function isIdempotentRoute(method: string, template: string): boolean {
  idempotentRoutes ??= new Set(
    contractMinimumVersionRoutes()
      .filter((route) => route.idempotent)
      .map((route) => `${route.method} ${route.path}`),
  );
  return idempotentRoutes.has(`${method} ${template}`);
}

/** The request's `METHOD template` when stage ⑦ judges it; else undefined. */
function judgedRoute(request: MinimumVersionRequest): string | undefined {
  const template = request.routeOptions.url;
  if (typeof template !== 'string') return undefined;
  const method = String(request.method).toUpperCase();
  const auth = contractAuthOf(method, template);
  if (auth !== 'login' && auth !== 'phone' && auth !== 'realname') return undefined;
  const route = `${method} ${template}`;
  return PRIVACY_EXEMPT.has(route) ? undefined : route;
}

/**
 * The judgement of ⑦ over one request with a verified token: legal.privacy.min_version through
 * `reader`, then the caller's newest user-level privacy row on `handle`. Throws the refusal
 * (10004 envelope, or 50001); resolves when let through.
 */
export type PrivacyConsentJudge = (
  request: MinimumVersionRequest,
  handle: Kysely<DB> | undefined | null,
  reader: () => PrivacyConsentConfigReader,
) => Promise<void>;

/**
 * The one judgement of ⑦, shared by the api entry's checks below and the stream entry's
 * /v1/agent/ checks (./agent-privacy-consent.ts, B3-08zi). The missing-key warning is written once
 * per judge, i.e. once per assembled checks.
 */
export function createPrivacyConsentJudge(
  options: Pick<PrivacyConsentOptions, 'logger'>,
): PrivacyConsentJudge {
  const { logger } = options;
  let missingWarned = false;

  async function minVersionOf(
    reader: () => PrivacyConsentConfigReader,
    appId: string,
  ): Promise<unknown> {
    let entry: { readonly value: unknown } | null;
    try {
      entry = await reader().configValue(appId, MIN_VERSION_KEY);
    } catch {
      throw unavailable();
    }
    if (entry === null) {
      if (!missingWarned) {
        missingWarned = true;
        logger.warn({ config_key: MIN_VERSION_KEY }, 'privacy_min_version_missing');
      }
      return undefined;
    }
    return entry.value;
  }

  async function currentOf(
    handle: Kysely<DB>,
    principal: TokenPrincipal,
  ): Promise<PrivacyConsentInput['current']> {
    try {
      const row = await handle
        .withSchema('app')
        .selectFrom('consent_records')
        .select(['accepted', 'version'])
        .where('app_id', '=', principal.app_id)
        .where('subject_type', '=', 'user')
        .where('user_id', '=', principal.uid)
        .where('type', '=', 'privacy')
        .orderBy('server_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row === undefined ? null : { accepted: row.accepted, version: row.version };
    } catch {
      throw unavailable();
    }
  }

  return async function judge(request, handle, reader) {
    // Stage ② has verified a token on every login-level route; none here fails closed.
    const principal = tokenPrincipal(request);
    if (principal === undefined) throw unavailable();
    const minVersion = await minVersionOf(reader, principal.app_id);
    if (minVersion === undefined) return;
    // Validate the minimum before reading the consent: an invalid value is 50001 regardless.
    privacyConsentRefusal({ minVersion, current: null });
    if (handle === undefined || handle === null) throw unavailable();
    const current = await currentOf(handle, principal);
    if (privacyConsentRefusal({ minVersion, current }) === 10004) {
      throw privacyRequired(request.id);
    }
  };
}

/** Contract-driven ⑦; app.module supplies both parts to risk's ordered lists. */
export function createPrivacyConsentChecks(options: PrivacyConsentOptions): PrivacyConsentChecks {
  const { db, config, logger } = options;
  const judge = createPrivacyConsentJudge({ logger });

  return {
    guard: {
      async canActivate(context) {
        const request = context.switchToHttp().getRequest();
        const route = judgedRoute(request);
        if (route === undefined) return true;
        const template = request.routeOptions.url as string;
        if (isIdempotentRoute(String(request.method).toUpperCase(), template)) return true;
        // No reader assembled: as if legal.privacy.min_version were missing (not judged).
        if (config === null) return true;
        await judge(request, db, () => config.pooled);
        return true;
      },
    },
    async postMiss() {
      const request = RiskModule.httpRequestInScope();
      if (request === undefined) return;
      if (judgedRoute(request) === undefined) return;
      // No reader assembled: as if legal.privacy.min_version were missing (not judged).
      if (config === null) return;
      const trx = idempotencyPostMissTransaction();
      if (trx === undefined) throw unavailable();
      await judge(request, trx, () => config.on(trx));
    },
  };
}
