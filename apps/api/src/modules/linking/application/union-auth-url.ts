// B1-06g: GET /v1/unions/{platform}/auth-url — issues a one-time authorization state
// (union_auth_sessions, BR-ID-17: bound to uid + device_id, link_id empty, 10 minutes, single use,
// consumed by bindings in B1-06h) with the client of the DEVICE RECORD and, for Taobao, the
// ordered auth_methods of union.taobao.auth_methods.<client> plus each method's server-side
// application reference (BR-ID-17 细则「授权方式」). Pinduoduo gets an auth_jump plan instead
// (BR-ID-22 细则). Refusals: a blocked binding of a user who is not banned → 30153 (checked first,
// BR-ID-24 ④); the site's own union authorization expired → for Taobao 30101 / 30102 with
// data.reason=auth_unavailable, for Pinduoduo 50301 with data.reason=maintenance (BR-ID-24 ④,
// 2026-10-08: the Pinduoduo authorization link depends on that authorization, so it is not the
// Taobao special case). Both are judged for the requested platform only, after 30153.
//
// Cross-module reads (devices, user_risk_state, union_bindings, union_accounts) are read-only
// selects scoped by app_id, plus union's read-only active-pid port; this module writes only
// union_auth_sessions. The site authorization judged is that of the union account this
// authorization actually uses (the unreleased binding's, else the platform's active self_buy pid's,
// else the platform's earliest registered account by union_accounts created_at, id ascending),
// never "any account still valid".
// B1-06zf (FU-PDD-AUTH-LINK, D10-647): the Pinduoduo auth_url / auth_jump is the filing link
// UnionAdapter.pddAuthorityUrl generates at this request for the identity the conversion uses
// (pdd-authority.ts pddAuthorityIdentity: this App, the self_buy slot of the account this
// authorization uses, custom_parameters {app, uid=attr_code, sc}, never a user_id). D10-662:
// auth_url and the h5 / universal-link steps carry the web address (mobile_short_url → url); the
// scheme step is the upstream schema_url as is (built from the web address only when there is
// none); the state is only in union_auth_sessions, never in the link. No slot or attr_code → 50301 maintenance; the port missing or failing → 50303; neither
// leaves a state. Taobao keeps its synthetic address (syntheticAuthUrl).
import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { AppEnv, Clock, HandlerResult, RootLogger } from '../../platform/index.ts';
import type { UnionPidService } from '../../union/index.ts';
import type { AttrCodeReader, CallerContext, LinkingConfigReader } from '../ports.ts';
import {
  appSchemeOf,
  buildDefaultLinkJump,
  pathsOf,
  type LinkConversionOptions,
} from './link-open-conversion.ts';
import {
  PDD,
  generatePddAuthorityLink,
  pddAuthorityIdentity,
  type PddAuthorityLink,
} from './pdd-authority.ts';
import { createJumpAdmission, type LinkOpenEnvironment } from './link-open-wiring.ts';
import { createLinkingPidReader } from '../infra/pid-reader.ts';
import { AuthConfigError, createUnionAuthReads, type AuthClient } from './union-auth-reads.ts';
import {
  AUTH_STATE_TTL_MS,
  authAppRefs,
  deviceClientOf,
  insertAuthSession,
  newAuthState,
  syntheticAuthUrl,
  type UnionAuthAppsPort,
} from './union-auth-state.ts';

export type { AuthClient, UnionAuthMethod } from './union-auth-reads.ts';

export interface UnionAuthUrlInput {
  readonly platform: 'taobao' | 'pdd';
  readonly reportedClient: AuthClient;
  readonly installed?: components['schemas']['InstalledState'];
  readonly traceId: string;
}

export interface UnionAuthUrlOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly callerContext: CallerContext;
  readonly config: LinkingConfigReader;
  readonly appEnv: AppEnv;
  /** Server-owned application configuration references, scoped to the issuing environment. */
  readonly authApps: UnionAuthAppsPort;
  /**
   * union's read-only active-pid query (the account channel registration uses); absent → the same
   * read-only reader built on this db.
   */
  readonly pids?: Pick<UnionPidService, 'getActivePid'>;
  /**
   * The open's jump environment (apps.json, verified paths per platform × client): the Pinduoduo
   * auth_jump is built and admitted exactly as the open's (BR-ATTR-27). Absent (no
   * LINK_OPEN_PORTS) → the bridge's apps.json outside prod; prod fails closed.
   */
  readonly jumpEnvironment?: LinkOpenEnvironment;
  /** Risk log of a declared X-Platform that disagrees with the device record (optional). */
  readonly logger?: Pick<RootLogger, 'warn'>;
  /**
   * B1-06zf: the governed union adapters the Pinduoduo filing link is generated through. Absent →
   * every Pinduoduo auth-url answers 50303 (no placeholder address, no state).
   */
  readonly registry?: LinkConversionOptions['registry'] | undefined;
  /** B1-06zf: identity's attr_code reader (the Pinduoduo identity's uid); absent → 50301. */
  readonly attrCodes?: AttrCodeReader | undefined;
}

export interface UnionAuthUrlService {
  get(input: UnionAuthUrlInput): Promise<HandlerResult>;
}

type AuthJumpPlan = components['schemas']['AuthJumpPlan'];
type AuthJumpStep = components['schemas']['AuthJumpStep'];

const STATUS: Readonly<Record<number, number>> = {
  0: 200,
  10001: 401,
  30101: 422,
  30102: 422,
  30153: 422,
  50001: 500,
  50301: 503,
  50303: 503,
};

/** Fallback texts only; clients show the dictionary text error.<code> (BR-TEXT-14). */
const MESSAGES: Readonly<Record<number, string>> = {
  0: 'ok',
  10001: '请先登录',
  30101: '淘宝暂时无法下单，请稍后再试',
  30102: '淘宝暂时无法下单，请稍后再试',
  30153: '该平台返利已被停用，请联系客服',
  50001: '服务端错误',
  50301: '该平台暂时无法购买，请稍后再试',
  50303: '暂时无法生成授权链接，请稍后再试',
};

function fail(code: number, traceId: string, data?: Record<string, unknown>): HandlerResult {
  return {
    status: STATUS[code] ?? 500,
    envelope: {
      code,
      msg: MESSAGES[code] ?? '服务端错误',
      ...(data === undefined ? {} : { data }),
      trace_id: traceId,
    },
  };
}

const AUTH_STEP_TYPES: ReadonlySet<string> = new Set<AuthJumpStep['type']>([
  'scheme',
  'universal_link',
  'h5',
]);

function authStep(step: { readonly type: string; readonly value: string }): AuthJumpStep {
  if (!AUTH_STEP_TYPES.has(step.type)) {
    throw new AuthConfigError('linking: the auth jump has a step an auth plan cannot carry');
  }
  return { type: step.type as AuthJumpStep['type'], value: step.value };
}

/**
 * Pinduoduo authorization jump (BR-ID-22 细则; 04 §7 30111): the open's own BR-ATTR-27 matrix by
 * the device record's client and installed (missing → unknown), over the authorization page's
 * paths; in prod only the paths the open admits (none admitted → AuthConfigError, no state).
 * Shared by auth-url and the Pinduoduo open's 30111 (B1-06v, link-open-pdd-auth.ts).
 * D10-662: the h5 / universal-link steps carry link.webUrl; the scheme step is link.scheme as the
 * union answered it (never wrapped again), else the apps.json scheme wrapping the web address.
 */
export function pddAuthJump(
  environment: { readonly appEnv: AppEnv; readonly jumpEnvironment?: LinkOpenEnvironment },
  link: PddAuthorityLink,
  client: AuthClient,
  installed: UnionAuthUrlInput['installed'],
  expireAt: Date,
): AuthJumpPlan {
  const { appEnv, jumpEnvironment } = environment;
  if (appEnv === 'prod' && jumpEnvironment === undefined) {
    throw new AuthConfigError('linking: no jump environment for the pdd auth jump in prod');
  }
  const jump = buildDefaultLinkJump({
    platform: 'pdd',
    client,
    installed: installed ?? 'unknown',
    paths: pddAuthPaths(link, appSchemeOf(jumpEnvironment?.apps, 'pdd')),
    expireAt: expireAt.toISOString(),
  });
  const admitted =
    jumpEnvironment === undefined
      ? jump
      : createJumpAdmission({ ...jumpEnvironment, appEnv }).jump('pdd', client, jump);
  if (admitted === null) {
    throw new AuthConfigError('linking: no verified pdd jump path for this client');
  }
  return {
    primary: authStep(admitted.primary),
    fallbacks: admitted.fallbacks.map(authStep),
    expire_at: admitted.expire_at,
  };
}

/** The authorization page's launch paths (D10-662): the upstream scheme as is, else derived. */
function pddAuthPaths(link: PddAuthorityLink, appScheme: string | null) {
  const paths = pathsOf('pdd', link.webUrl, appScheme);
  return link.scheme === null ? paths : { ...paths, scheme: link.scheme };
}

export function createUnionAuthUrl(options: UnionAuthUrlOptions): UnionAuthUrlService {
  const { db, clock, callerContext, config, appEnv, authApps, jumpEnvironment, logger } = options;
  const { registry, attrCodes } = options;
  const warn: LinkConversionOptions['logger'] = logger ?? { warn: () => undefined };
  const pids = options.pids ?? createLinkingPidReader(db, clock);
  // The same judgements the bindings submission makes (union-auth-reads.ts).
  const reads = createUnionAuthReads({ db, config, appEnv, pids, clock });

  async function issue(input: UnionAuthUrlInput): Promise<HandlerResult> {
    const caller = await callerContext.current();
    if (caller.userId === null || caller.deviceId === null) return fail(10001, input.traceId);
    const { appId, userId, deviceId } = caller;

    // The client is the device record's (BR-ID-17 细则), never the X-Platform declaration.
    const client = await deviceClientOf(db, appId, deviceId);
    if (client === 'missing') return fail(10001, input.traceId);
    if (client !== input.reportedClient) {
      logger?.warn(
        {
          event: 'linking.auth_url.client_mismatch',
          app_id: appId,
          device_id: deviceId,
          platform: input.platform,
          recorded_client: client,
          reported_client: input.reportedClient,
        },
        'linking: X-Platform disagrees with the device record; the record is used',
      );
    }

    const platform = input.platform;
    const { status, accountId: bound } = await reads.binding(appId, userId, platform);
    // A blocked binding answers 30153 before anything else (BR-ID-24 ④ keeps it for blocked).
    if (status === 'blocked') {
      // A banned user has no session (BR-ID-31); one still reaching here gets no state either.
      if (await reads.userBanned(appId, userId)) return fail(10001, input.traceId);
      return fail(30153, input.traceId);
    }
    const accountId = await reads.authAccountId(appId, platform, bound);
    if (!(await reads.siteAuthAvailable(appId, platform, accountId))) {
      // BR-ID-24 ④ (2026-10-08): Pinduoduo's authorization link depends on the site's
      // authorization → 50301 maintenance; the 30101 / 30102 special case is Taobao's only.
      if (platform === 'pdd') return fail(50301, input.traceId, { reason: 'maintenance' });
      return fail(status === 'invalid' ? 30102 : 30101, input.traceId, {
        reason: 'auth_unavailable',
      });
    }

    const methods = platform === 'taobao' ? await reads.configuredMethods(appId, client) : null;
    let pddLink: PddAuthorityLink | null = null;
    if (platform === 'pdd') {
      // The identity the conversion and the filing query use (no state exists yet).
      const identity = await pddAuthorityIdentity(
        { pids, attrCodes, logger: warn },
        {
          appId,
          userId,
          pidScene: 'self_buy',
          ...(accountId === null ? {} : { unionAccountId: accountId }),
          traceId: input.traceId,
          events: 'linking.auth_url',
        },
      );
      if (identity === 'no_pid' || identity === 'no_attr_code') {
        return fail(50301, input.traceId, { reason: 'maintenance' });
      }
      if (registry === undefined) {
        warn.warn(
          {
            event: 'linking.auth_url.pdd_authority_url_failed',
            app_id: appId,
            platform: PDD,
            trace_id: input.traceId,
            error_code: 'no_registry',
          },
          'linking: no union registry for the pdd authority link; no state issued',
        );
        return fail(50303, input.traceId);
      }
      // Generated now, at the user's request; never cached (D10-647 ③).
      pddLink = await generatePddAuthorityLink(
        { registry, logger: warn },
        { appId, identity, traceId: input.traceId, events: 'linking.auth_url' },
      );
      if (pddLink === null) return fail(50303, input.traceId);
    }
    // Built before the insert: a pdd jump that cannot be issued leaves no state behind.
    const now = clock.now();
    // A second reading of the injected clock, moved by the TTL (no `new Date` outside the clock).
    const expireAt = clock.now();
    expireAt.setTime(now.getTime() + AUTH_STATE_TTL_MS);
    const state = newAuthState();
    const authUrl = pddLink?.webUrl ?? syntheticAuthUrl('taobao', state);
    const authJump =
      methods === null && pddLink !== null
        ? pddAuthJump(
            { appEnv, ...(jumpEnvironment === undefined ? {} : { jumpEnvironment }) },
            pddLink,
            client,
            input.installed,
            expireAt,
          )
        : null;
    const refs =
      methods === null ? null : await authAppRefs(authApps, appEnv, appId, client, methods);

    await insertAuthSession(db, {
      state,
      appId,
      userId,
      deviceId,
      platform,
      client,
      linkId: null,
      now,
      expireAt,
      methods,
      refs,
    });

    const data =
      methods === null
        ? { auth_url: authUrl, state, auth_jump: authJump }
        : { auth_url: authUrl, state, auth_methods: [...methods] };
    return {
      status: 200,
      envelope: { code: 0, msg: MESSAGES[0]!, data, trace_id: input.traceId },
    };
  }

  return {
    async get(input) {
      try {
        return await issue(input);
      } catch (error) {
        if (error instanceof AuthConfigError) return fail(50001, input.traceId);
        throw error;
      }
    },
  };
}
