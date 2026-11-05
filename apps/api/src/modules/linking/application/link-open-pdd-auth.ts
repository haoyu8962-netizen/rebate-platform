// B1-06v: the Pinduoduo filing (备案) check of an open — a composition over the wired jd / pdd open
// (link-open-wiring.ts) adding the conversion port's authorize / cacheTag / prepare hooks, as the
// Taobao composition does (link-open-taobao.ts, which delegates its Pinduoduo opens here). The
// shared re-check core and the jd / pdd conversion itself know no authorization.
// Order of one Pinduoduo open: ownership (owner stage) → convert.enabled.pdd and path admission
// (50301) → this check (⑥, then ⑦ the slot, B1-22n) → re-check price → conversion (orchestrator
// ruling D7-4 ②⑤).
// The check is judged on the identity snapshot's user, at (user, platform) granularity
// (TODO(规划/11 §4.5): BR-ID-22 的 (user, pid) 粒度 — blocked on union_bindings 加 pid 维度的迁移):
// - another user's share link (BR-ATTR-05 细则「别人的分享 link 不可用」, ruling D7-11 ①): the
//   sharer's stored binding only, never queried; not active (blocked included) → 30111
//   data.reason=sharer_auth_invalid, no auth_jump and no state; no_rebate is ignored there. Active
//   → 50301 reason=maintenance while the site authorization of the account it uses is expired.
// - own open: blocked → 30153 (a banned user: 10001) before anything else, except an explicit
//   no_rebate purchase, which goes out logged with no_rebate_reason=binding_blocked (BR-ID-18, the
//   server's value, never the client's). Then the site authorization of the account this
//   authorization uses (union-auth-reads.ts authAccountId) expired → 50301 reason=maintenance
//   (BR-ID-24 ④: conversion and the authority query depend on it), no_rebate included. no_rebate
//   and active go on; any other status (unbound, pending_auth, invalid, released, no row) asks the
//   union authority port (UnionAdapter.queryPddAuthority, an idempotent governed read) with the
//   same server-built identity the conversion uses (custom_parameters {app, uid=attr_code, sc},
//   never a user_id; no attr_code → 50301; no active slot of the scene → 50301 maintenance,
//   D10-654 below): authorized → the binding is written active (below) and the open goes on; not
//   authorized →
//   30111 with data.auth_jump only, a one-time state bound to uid + device record + the link this
//   open serves (BR-ID-22 细则, the auth-url jump construction); the port missing or failing →
//   50303, nothing written.
// Binding writes (single writer linking; approvals #26): every status written is first judged by
// canTransitionBinding, then a row_version compare-and-set; the unreleased row (pending_auth /
// invalid) is set active in place, else a stored `unbound` row (a projection value, judged as no
// binding), else a new active row of the account used — released history is never touched. The
// write runs under a savepoint inside the open's transaction (ruling D7-11 ④; no second pooled
// connection): a concurrent writer winning the unique index re-reads and decides on what won.
// B1-06z (BR-ID-18): a write that makes the binding active resolves the user's unresolved pdd
// conflict rows in the same savepoint (bound_active); a row found already active resolves nothing.
// An own blocked user's no_rebate refused for maintenance carries the server's no_rebate_reason.
// B1-06x: the identity, the authority query and the activation are pdd-authority.ts's, shared with
// the authorization page refresh (union-bindings-pdd.ts); behaviour here is unchanged.
// F1-07c: the activation takes the user lock and reads the risk state after it; a user banned
// meanwhile gets the banned user's answer (10001) and nothing is written.
// B1-19d (BR-ATTR-02, BR-ATTR-07, BR-ATTR-08, BR-ID-17): every slot this check and the
// conversion use is the scene's active slot of the account this authorization uses (authAccountId
// above; after an activation, the binding's account), read with the union port's account filter;
// that account having none → 50301, never another account's slot or another scene's. The
// conversion gets the account through LinkOpenConversionInput.unionAccountId.
// B1-22n (BR-ATTR-05 细则「open 业务校验的先后」⑥ → ⑦ → ⑧; D10-239 T3a / T3b):
// - ⑦ before ⑧: an allowed jd / pdd open first builds, without converting, the identity its
//   conversion would use (link-open-conversion.ts createConversionPrecheck: the scene's active slot
//   of the account in use, self_buy for no_rebate; attr_code; the jd user key mode); none → 50301
//   (a blocked user's no_rebate keeps no_rebate_reason=binding_blocked) before any cache, price or
//   union call. Jd has no ⑥: it is checked here too, so every composition routing jd through this
//   hook (createPddAuthLinkOpen, link-open-taobao.ts) gets it. Cache reads and keys unchanged (R-12).
// - ⑥ before ⑦ (D10-262 / D10-263, D10-654): a binding not active whose account in use has no
//   active slot of the link's scene is not queried (local configuration before external calls)
//   and never activated, nor is another scene's slot used: 50301 data.reason=maintenance, no state,
//   no union call at all. With the slot: one filing query, then ⑦ as above. An active binding
//   goes straight to ⑦ (no slot → 50301).
// B1-06zf (FU-PDD-AUTH-LINK, D10-647): the 30111 auth_jump is built over the filing link
// UnionAdapter.pddAuthorityUrl generates at that moment for the identity just queried
// (pdd-authority.ts generatePddAuthorityLink, D10-662: the h5 step the web address
// mobile_short_url → url, the scheme step the upstream schema_url as is); the
// state lives only in union_auth_sessions. Generation missing or failing → 50303, nothing written.
import type { UnionPidRow } from '../../union/index.ts';
import {
  createConversionPrecheck,
  effectiveNoRebate,
  type LinkingUnionIdentity,
} from './link-open-conversion.ts';
import type { LinkOpenService } from './link-open.ts';
import type { LinkOpenOwnerResult } from './link-open-owner.ts';
import {
  openScopedAttrCodes,
  openScopedPids,
  prepareAccountSlots,
  type LinkOpenReadPlan,
} from './link-open-reads.ts';
import type {
  LinkOpenAuthorization,
  LinkOpenAuthorizationInput,
  LinkOpenConversionInput,
} from './link-open-requote.ts';
import { createWiredLinkOpen, type WiredLinkOpenOptions } from './link-open-wiring.ts';
import {
  PDD,
  activatePddBinding,
  generatePddAuthorityLink,
  pddAuthorityIdentity,
  pddBindingRows,
  queryPddAuthority,
} from './pdd-authority.ts';
import {
  AuthConfigError,
  UNRELEASED,
  createUnionAuthReads,
  type AuthClient,
} from './union-auth-reads.ts';
import {
  AUTH_STATE_TTL_MS,
  deviceClientOf,
  insertAuthSession,
  newAuthState,
} from './union-auth-state.ts';
import { pddAuthJump, type UnionAuthUrlOptions } from './union-auth-url.ts';

export type PddAuthLinkOpenOptions = WiredLinkOpenOptions & Pick<UnionAuthUrlOptions, 'appEnv'>;

type PidScene = Parameters<WiredLinkOpenOptions['pids']['getActivePid']>[0]['pidScene'];

const PLATFORM = PDD;

const SHARER_INVALID: LinkOpenAuthorization = {
  kind: 'refused',
  code: 30111,
  data: { reason: 'sharer_auth_invalid' },
};
const MAINTENANCE: LinkOpenAuthorization = {
  kind: 'refused',
  code: 50301,
  data: { reason: 'maintenance' },
};
const QUERY_FAILED: LinkOpenAuthorization = { kind: 'refused', code: 50303 };
/** ⑦: no usable slot (or identity) for the conversion; no data, as the conversion's own 50301. */
const NO_SLOT: LinkOpenAuthorization = { kind: 'refused', code: 50301 };

function paused(message: string): Error & { readonly code: 50301 } {
  return Object.assign(new Error(message), { code: 50301 as const });
}

/**
 * The cache tag of a Pinduoduo open (link-open-requote.ts cacheTag): a cached jump is reused only
 * when built for the same active binding and account and the same selected slot (BR-ID-17: a
 * rebind within the TTL is a miss); no_rebate by its slot alone. Not authorized: a tag no stored
 * entry has.
 */
export function pddCacheTag(
  decided:
    | {
        readonly binding: { readonly id: string; readonly accountId: string } | null;
        readonly slot: Pick<UnionPidRow, 'pid' | 'union_account_id'> | null;
      }
    | undefined,
  noRebate: boolean,
): string {
  if (decided === undefined) return 'unauthorized';
  const slot = [decided.slot?.union_account_id ?? null, decided.slot?.pid ?? null];
  if (noRebate) return JSON.stringify(['no_rebate', ...slot]);
  if (decided.binding === null) return 'unauthorized';
  return JSON.stringify(['binding', decided.binding.id, decided.binding.accountId, ...slot]);
}

/** The Pinduoduo filing check as conversion-port hooks; other platforms pass through. */
export function createPddAuthorization(options: PddAuthLinkOpenOptions) {
  const { clock, logger, registry, appEnv, environment } = options;
  // Inside the open's transaction these answer only from the pre-reads (link-open-reads.ts).
  const pids = openScopedPids(options.pids);
  const attrCodes = openScopedAttrCodes(options.attrCodes);
  const decisions = new WeakMap<LinkOpenOwnerResult, Parameters<typeof pddCacheTag>[0]>();
  /** B1-19d: the account each allowed open converts with (LinkOpenConversionInput). */
  const accounts = new WeakMap<LinkOpenOwnerResult, string>();
  /** B1-22n: ⑦, the conversion's identity built ahead of the re-check. */
  const precheck = createConversionPrecheck(options);

  /**
   * ⑦ for this open: null when the conversion's identity builds, else the 50301 refusal. B1-22u
   * (D10-434): a read failing with anything but 50301 (a database timeout, the union pid service
   * failing) is the conversion's temporary failure, 50303 — as the same read failing inside the
   * conversion — refused (one link_log, nothing else written), never rethrown into a 500. The log
   * carries the error's code only, never its text (a driver's text may hold a DSN).
   */
  async function slotRefusal(
    input: LinkOpenAuthorizationInput,
    noRebate: boolean,
    accountId: string | undefined,
    blocked = false,
  ): Promise<LinkOpenAuthorization | null> {
    try {
      await precheck({
        owner: input.owner,
        // BR-ATTR-05 ①: another user's share link keeps the sharer's attribution.
        noRebate: effectiveNoRebate(input.caller, input.owner, noRebate),
        traceId: input.traceId,
        ...(accountId === undefined ? {} : { unionAccountId: accountId }),
      });
      return null;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      let refused = NO_SLOT;
      if (code !== 50301) {
        logger.warn(
          {
            event: 'linking.open.precheck_read_failed',
            app_id: input.owner.link.app_id,
            platform: input.owner.link.platform,
            trace_id: input.traceId,
            error_code:
              typeof code === 'string' || typeof code === 'number' ? String(code) : 'unknown',
          },
          'linking: identity read failed before the re-check',
        );
        refused = QUERY_FAILED;
      }
      return blocked ? { ...refused, noRebateReason: 'binding_blocked' } : refused;
    }
  }

  /**
   * authAccountId's self_buy slot, and every account's slots of the plan's scenes (B1-19d); the
   * unscoped scenes' slots and attr_codes are the wired prepare's.
   */
  async function prepare(plan: LinkOpenReadPlan): Promise<void> {
    if (plan.platform !== PLATFORM) return;
    const scenes = new Set<string>(['self_buy']);
    for (const identity of plan.identities) {
      scenes.add(identity.noRebate ? 'self_buy' : identity.pidScene);
    }
    await Promise.allSettled([
      pids.getActivePid({
        appId: plan.appId,
        platform: PLATFORM,
        pidScene: 'self_buy',
        purpose: 'convert',
      }),
      prepareAccountSlots(options.db, pids, { appId: plan.appId, platform: PLATFORM, scenes }),
    ]);
  }

  /** The slot the conversion will use (validated again there); null when there is none. */
  async function slotOf(appId: string, pidScene: string, accountId: string) {
    try {
      const row = await pids.getActivePid({
        appId,
        platform: PLATFORM,
        pidScene: pidScene as PidScene,
        purpose: 'convert',
        unionAccountId: accountId,
      });
      return row === null ? null : { pid: row.pid, union_account_id: row.union_account_id };
    } catch {
      return null;
    }
  }

  async function allow(
    input: LinkOpenAuthorizationInput,
    noRebate: boolean,
    binding: { readonly id: string; readonly accountId: string } | null,
    accountId: string,
    blocked = false,
  ): Promise<LinkOpenAuthorization> {
    const { owner } = input;
    const refused = await slotRefusal(input, noRebate, accountId, blocked);
    if (refused !== null) return refused;
    const { link, identitySnapshot } = owner;
    const pidScene = noRebate ? 'self_buy' : identitySnapshot.pid_scene;
    const slot = await slotOf(link.app_id, pidScene, accountId);
    decisions.set(owner, { binding, slot });
    accounts.set(owner, accountId);
    return blocked ? { kind: 'allowed', noRebateReason: 'binding_blocked' } : { kind: 'allowed' };
  }

  /**
   * 30111 with an auth_jump whose state is bound to uid + device record + the served link. B1-06zf
   * (D10-647): the jump is built over the filing link pddAuthorityUrl generates now for the
   * identity this open just queried (never cached, never carrying the state); the port missing or
   * failing → 50303, no state written.
   */
  async function issue(
    input: LinkOpenAuthorizationInput,
    userId: string,
    identity: LinkingUnionIdentity,
  ): Promise<LinkOpenAuthorization> {
    const { caller, owner, executor } = input;
    const appId = owner.link.app_id;
    if (caller.deviceId === null || caller.userId !== userId) {
      return { kind: 'refused', code: 10001 };
    }
    let client: AuthClient | 'missing';
    try {
      client = await deviceClientOf(executor, appId, caller.deviceId);
    } catch (error) {
      // A device with no app client (h5 / web) has no authorization path in the open.
      if (error instanceof AuthConfigError) throw paused('linking: no pdd authorization path');
      throw error;
    }
    if (client === 'missing') return { kind: 'refused', code: 10001 };
    const now = clock.now();
    // A second reading of the injected clock, moved by the TTL (no `new Date` outside the clock).
    const expireAt = clock.now();
    expireAt.setTime(now.getTime() + AUTH_STATE_TTL_MS);
    const authLink = await generatePddAuthorityLink(
      { registry, logger },
      { appId, identity, traceId: input.traceId, events: 'linking.open' },
    );
    if (authLink === null) return QUERY_FAILED;
    const state = newAuthState();
    let authJump;
    try {
      authJump = pddAuthJump(
        { appEnv, jumpEnvironment: environment },
        authLink,
        client,
        input.installed,
        expireAt,
      );
    } catch (error) {
      if (error instanceof AuthConfigError) throw paused('linking: no admitted pdd auth jump');
      throw error;
    }
    await insertAuthSession(executor, {
      state,
      appId,
      userId,
      deviceId: caller.deviceId,
      platform: PLATFORM,
      client,
      linkId: owner.link.link_id,
      now,
      expireAt,
      methods: null,
      refs: null,
    });
    return { kind: 'refused', code: 30111, data: { auth_jump: authJump } };
  }

  async function authorize(input: LinkOpenAuthorizationInput): Promise<LinkOpenAuthorization> {
    const { caller, owner, noRebate, executor } = input;
    if (owner.link.platform !== PLATFORM) {
      // B1-22n: jd has no authorization (⑥); its slot (⑦) is still settled before the re-check.
      if (owner.link.platform !== 'jd') return { kind: 'allowed' };
      return (await slotRefusal(input, noRebate, undefined)) ?? { kind: 'allowed' };
    }
    const { link, identitySnapshot: snapshot } = owner;
    const appId = link.app_id;
    const subject = snapshot.user_id;
    const reads = createUnionAuthReads({
      db: executor,
      config: options.config,
      appEnv,
      pids,
      clock,
    });
    const sharedByOther = snapshot.pid_scene === 'share' && subject !== caller.userId;
    if (subject === null) {
      // Only a guest's unclaimed share link can name no user: its sharer has no binding.
      if (sharedByOther) return SHARER_INVALID;
      throw new Error('linking: an own pdd open without a snapshot user');
    }
    const rows = await pddBindingRows(executor, appId, subject);
    const unreleased = rows.find((row) => UNRELEASED.includes(row.status));
    const status = unreleased?.status ?? 'unbound';
    const bound = unreleased === undefined ? null : unreleased.union_account_id;
    const active =
      unreleased?.status === 'active' ? { id: unreleased.id, accountId: bound! } : null;

    // BR-ATTR-05 细则: judged on the sharer's stored binding; its status is never disclosed.
    if (sharedByOther && status !== 'active') return SHARER_INVALID;
    if (status === 'blocked' && !noRebate) {
      // A banned user has no session (BR-ID-31); one still reaching here asks to log in.
      if (await reads.userBanned(appId, subject)) return { kind: 'refused', code: 10001 };
      return { kind: 'refused', code: 30153 };
    }
    // BR-ID-24 ④: the account this authorization uses, never "any account still valid".
    const accountId = await reads.authAccountId(appId, PLATFORM, bound);
    if (accountId === null || !(await reads.siteAuthAvailable(appId, PLATFORM, accountId))) {
      // A blocked user's no_rebate purchase refused here is still logged with the server's reason.
      return noRebate && status === 'blocked'
        ? { ...MAINTENANCE, noRebateReason: 'binding_blocked' }
        : MAINTENANCE;
    }
    if (noRebate) return allow(input, true, null, accountId, status === 'blocked');
    if (active !== null) return allow(input, false, active, active.accountId);

    const identity = await pddAuthorityIdentity(
      { pids, attrCodes, logger },
      {
        appId,
        userId: subject,
        pidScene: snapshot.pid_scene,
        unionAccountId: accountId,
        traceId: input.traceId,
        events: 'linking.open',
      },
    );
    // D10-654 (superseding D10-262 / D10-263's 30111): the account in use has no active slot of the
    // scene → 50301 maintenance, as ⑦ (logged by pddAuthorityIdentity); not queried, no state.
    if (identity === 'no_pid') return MAINTENANCE;
    if (identity === 'no_attr_code') throw paused('linking: attr_code unavailable');
    const authorized = await queryPddAuthority(
      { registry, logger },
      { appId, identity, traceId: input.traceId, events: 'linking.open' },
    );
    if (authorized === null) return QUERY_FAILED;
    if (!authorized) return issue(input, subject, identity);
    const custom = JSON.stringify(identity.custom_parameters);
    const written = await activatePddBinding(executor, clock, {
      appId,
      userId: subject,
      accountId,
      custom,
    });
    if (written.kind === 'blocked') return { kind: 'refused', code: 30153 };
    // F1-07c: banned meanwhile (read after the user lock): the banned user's answer, as above.
    if (written.kind === 'banned') return { kind: 'refused', code: 10001 };
    return allow(input, false, { id: written.id, accountId: written.accountId }, written.accountId);
  }

  function cacheTag(owner: LinkOpenOwnerResult, noRebate: boolean): string | undefined {
    if (owner.link.platform !== PLATFORM) return undefined;
    return pddCacheTag(decisions.get(owner), noRebate);
  }

  /** B1-19d: the conversion input with this open's account in use (Pinduoduo opens only). */
  function scoped<T extends LinkOpenConversionInput>(input: T): T {
    if (input.owner.link.platform !== PLATFORM) return input;
    const unionAccountId = accounts.get(input.owner);
    if (unionAccountId === undefined) {
      // A Pinduoduo open always passes authorize first; converting without it is a fault.
      throw paused('linking: pdd open converted without authorization');
    }
    return { ...input, unionAccountId };
  }

  return { prepare, authorize, cacheTag, scoped };
}

export function createPddAuthLinkOpen(options: PddAuthLinkOpenOptions): LinkOpenService {
  return createWiredLinkOpen(options, (wired) => {
    const pdd = createPddAuthorization(options);
    return {
      ...wired.conversion,
      async prepare(plan) {
        await Promise.allSettled([wired.conversion.prepare(plan), pdd.prepare(plan)]);
      },
      authorize: pdd.authorize,
      cacheTag: pdd.cacheTag,
      convert: (input) => wired.conversion.convert(pdd.scoped(input)),
    };
  });
}
