// B1-06f: the Taobao open — a composition over the shared open core (owner, re-check, idempotency,
// logs, attempts; link-open-requote.ts) and the jd / pdd wired conversion (link-open-wiring.ts),
// adding a Taobao conversion port with its own authorization. The re-check core itself knows no
// authorization; jd opens are served exactly as before, pdd opens get the Pinduoduo filing check
// (B1-06v, link-open-pdd-auth.ts).
// Order of one Taobao open (BR-ATTR-05 细则「open 业务校验的先后」; B1-22m, D10-239 T2 + T3c):
// ownership (10001 / 30144, owner stage) → convert.enabled.taobao and path admission (50301) →
// the account this open uses (no Taobao union account at all → 50301 with a warning) →
// authorization (30153 / 30101 / 30102) → the active promotion slot of that account, read only on
// the branch authorization lets through (none → 50301 with a warning) → re-check price
// (30141 / 30602 / 50303) → instruction. A refusal never reads a slot.
// Authorization (BR-ATTR-05, BR-ID-17, BR-ID-18, BR-ID-24 ④) is judged on the identity snapshot's
// user (the sharer on another user's share link):
// - another user's share link whose sharer has no active binding (any status, blocked included,
//   whatever the site authorization) → 30102 reason=sharer_auth_invalid, no state; no_rebate is
//   ignored there (BR-ATTR-05 ①).
// - blocked → 30153; an explicit no_rebate open goes out instead, logged with no_rebate_reason
//   binding_blocked (decided here, never the client's value).
// - unbound / pending_auth / released → 30101, invalid → 30102: while the site authorization of
//   the account this authorization uses (union-auth-reads.ts) is expired, reason=auth_unavailable
//   with no state, no_rebate included; otherwise an explicit no_rebate open goes out, else a
//   one-time state bound to uid + device + the link this open serves (union-auth-state.ts).
// - active → the instruction with the snapshot user's relation_id (only that user's active
//   binding in this app), paired only with a slot of the binding's union account (taobaoTaoke).
// The instruction (BR-ATTR-27 Taobao row; 02 §5.1): no union link API is called (the Taobao
// adapter's convert / resolveLink are never used). Our own promotion link of this link's user and
// scene (links.promo_url) usable before links.expire_at → openByUrl with no commission parameter,
// followed on app clients by the same URL as an h5 step; otherwise openByCode on the detail page
// with taoke {pid of the scene's active slot, relation_id of the snapshot user} — no_rebate uses
// the self_buy slot with no user parameter and never the promotion link. h5 / web get only the
// promotion link (h5), else 50301. Whether the SDK returns to the app is CAP-TB-11, not promised;
// prod hands out no Taobao path until it is verified (link-open-wiring.ts admission).
// B1-19d (BR-ATTR-02, BR-ATTR-07, BR-ATTR-08, BR-ID-17): the slot is the scene's active slot of
// the account this open uses (union-auth-reads.ts authAccountId: the unreleased binding's, else
// the account of the platform's current self_buy slot, else its earliest registered account by
// union_accounts created_at, id ascending) — read with the union port's account filter, so
// another account's earlier-activated slot never wins and never stands in when the account has
// none (50301). taobaoTaoke's account check stays as the last line.
// B1-22m: the slot is read after the authorization gate, on the allowed branches only (active,
// after its relation_id; blocked + no_rebate; no_rebate under a usable site authorization). The
// cached instruction is still read only after authorize returns (link-open-requote.ts), with the
// same cache key and tag (R-12).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { UnionPidRow } from '../../union/index.ts';
import {
  CONVERT_CACHE_TTL_SEC,
  MAX_CONVERT_CACHE_TTL_SEC,
  intSetting,
  isSwitchOn,
} from '../domain/rules.ts';
import {
  convertOffReasonKey,
  convertPausedData,
  type ConvertPausedData,
} from './convert-paused.ts';
import type { LinkOpenService } from './link-open.ts';
import type { LinkOpenOwnerResult } from './link-open-owner.ts';
import { createPddAuthorization } from './link-open-pdd-auth.ts';
import {
  openScopedConfig,
  openScopedPids,
  prepareAccountSlots,
  type LinkOpenReadPlan,
} from './link-open-reads.ts';
import type {
  LinkOpenAuthorization,
  LinkOpenAuthorizationInput,
  LinkOpenConversionInput,
  LinkOpenConversionPort,
  LinkOpenJump,
} from './link-open-requote.ts';
import {
  createWiredLinkOpen,
  type WiredConversion,
  type WiredLinkOpenOptions,
} from './link-open-wiring.ts';
import { AuthConfigError, createUnionAuthReads, type AuthClient } from './union-auth-reads.ts';
import {
  AUTH_STATE_TTL_MS,
  authAppRefs,
  deviceClientOf,
  insertAuthSession,
  newAuthState,
  syntheticAuthUrl,
} from './union-auth-state.ts';
import type { UnionAuthUrlOptions } from './union-auth-url.ts';

/** B1-06f: composition boundary; authorization must not enter the shared requote core. */
export type TaobaoLinkOpenOptions = WiredLinkOpenOptions &
  Pick<UnionAuthUrlOptions, 'appEnv' | 'authApps'>;

type PidScene = Parameters<WiredLinkOpenOptions['pids']['getActivePid']>[0]['pidScene'];
type Step = LinkOpenJump['primary'];

const PLATFORM = 'taobao';
const SWITCH = 'convert.enabled.taobao';
const AUTH_CLIENTS: readonly AuthClient[] = ['ios', 'android', 'harmony'];
/** contracts BaichuanTaoke.pid. */
const PID = /^mm_\d+_\d+_\d+$/;
const PID_MAX = 64;
/** contracts BaichuanTaoke.relation_id and BaichuanOpen.item_id / url bounds. */
const RELATION_MAX = 32;
const ITEM_MAX = 64;
const URL_MAX = 2048;

function paused(
  message: string,
  data?: ConvertPausedData,
): Error & { readonly code: 50301; readonly data?: ConvertPausedData } {
  return Object.assign(new Error(message), {
    code: 50301 as const,
    ...(data === undefined ? {} : { data }),
  });
}

/** What this open's authorization settled on, per owner stage result. */
export interface TaobaoAuthorized {
  /** The snapshot user's active relation_id; null for a no_rebate open (no user parameter). */
  readonly relationId: string | null;
  /** union_account_id of the active binding the relation_id belongs to; null with no relation. */
  readonly bindingAccountId: string | null;
  /** The active slot selected for this open (the scene's, or self_buy for no_rebate). */
  readonly slot: Pick<UnionPidRow, 'pid' | 'union_account_id'>;
}

/**
 * BR-ATTR-07: a relation_id means something only under the union account its binding belongs to,
 * so an attributed openByCode pairs it only with a slot of that same account. The slot is read
 * with the binding's account filter (B1-19d); this check stays as the last line: a slot of
 * another account is still refused (null → 50301 with a warning), never a cross-account pid +
 * relation_id. No relation (no_rebate): the slot alone.
 */
export function taobaoTaoke(
  decided: TaobaoAuthorized,
): { readonly pid: string; readonly relation_id?: string } | null {
  const { relationId, bindingAccountId, slot } = decided;
  if (relationId === null) return { pid: slot.pid };
  if (bindingAccountId === null || slot.union_account_id !== bindingAccountId) return null;
  return { pid: slot.pid, relation_id: relationId };
}

/**
 * The cache tag of a Taobao open (link-open-requote.ts cacheTag; also its single-flight name):
 * a cached instruction is reused only when it was built for the same relation_id and binding
 * account (BR-ID-17: a rebind within the TTL is a miss) and the same selected active slot and its
 * account (BR-ATTR-05: a slot retired and replaced within the TTL is a miss) — no_rebate included,
 * which carries the self_buy slot and no user parameter. Not authorized: a tag no stored entry has.
 */
export function taobaoCacheTag(decided: TaobaoAuthorized | undefined, noRebate: boolean): string {
  if (decided === undefined) return 'unauthorized';
  const slot = [decided.slot.union_account_id, decided.slot.pid];
  if (noRebate) return JSON.stringify(['no_rebate', ...slot]);
  if (decided.relationId === null) return 'unauthorized';
  return JSON.stringify(['relation', decided.bindingAccountId, decided.relationId, ...slot]);
}

/**
 * Our own promotion link of the opened link (decision D7-4 #6): both columns set, an https URI of
 * at most 2048 characters, and the injected clock still before links.expire_at (W_link).
 */
function promoOf(link: LinkOpenOwnerResult['link'], nowMs: number): string | null {
  const url = link.promo_url;
  if (url === null || link.promo_url_fetched_at === null) return null;
  if (typeof url !== 'string' || url.length === 0 || url.length > URL_MAX) return null;
  if (!(nowMs < link.expire_at.getTime())) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === 'https:' && parsed.host !== '' ? url : null;
}

/** A paused conversion (50301), as the open's and the shop entry's stages throw it. */
export function isTaobaoPaused(error: unknown): boolean {
  return error instanceof Error && (error as { readonly code?: unknown }).code === 50301;
}

interface TaobaoWarn {
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

/**
 * The scene's active promotion slot of the account in use (B1-19d); none, or not a Taobao pid
 * → 50301 with a warning. Never another account's slot nor another scene's. Shared by the open
 * and the shop entry (B1-06zg: self_buy only), so both read the slot the same way.
 */
export async function taobaoActivePid(
  pids: WiredLinkOpenOptions['pids'],
  logger: TaobaoWarn,
  appId: string,
  pidScene: string,
  accountId: string,
): Promise<UnionPidRow> {
  const row = await pids.getActivePid({
    appId,
    platform: PLATFORM,
    pidScene: pidScene as PidScene,
    purpose: 'convert',
    unionAccountId: accountId,
  });
  if (
    row === null ||
    row.status !== 'active' ||
    row.app_id !== appId ||
    row.platform !== PLATFORM ||
    row.pid_scene !== pidScene ||
    typeof row.pid !== 'string' ||
    row.pid.length > PID_MAX ||
    !PID.test(row.pid)
  ) {
    logger.warn(
      {
        event: 'linking.open.no_active_pid',
        app_id: appId,
        platform: PLATFORM,
        pid_scene: pidScene,
      },
      'linking: no active taobao promotion slot for the open',
    );
    throw paused('linking: no active promotion slot');
  }
  return row;
}

/**
 * The user's own active Taobao binding in this app; its relation_id within the contract, else
 * 50301 with a warning. Shared by the open (the snapshot user) and the shop entry (the caller).
 */
export async function taobaoActiveRelation(
  executor: Kysely<DB>,
  logger: TaobaoWarn,
  appId: string,
  userId: string,
): Promise<{ readonly relationId: string; readonly bindingAccountId: string }> {
  const row = await executor
    .selectFrom('union_bindings')
    .select(['relation_id', 'union_account_id'])
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .where('platform', '=', PLATFORM)
    .where('status', '=', 'active')
    .executeTakeFirst();
  const relation = row?.relation_id ?? null;
  if (row === undefined || relation === null || relation === '' || relation.length > RELATION_MAX) {
    logger.warn(
      { event: 'linking.open.relation_unavailable', app_id: appId, platform: PLATFORM },
      'linking: active taobao binding without a usable relation_id',
    );
    throw paused('linking: active binding without a usable relation_id');
  }
  return { relationId: relation, bindingAccountId: row.union_account_id };
}

/** What issuing a Taobao authorization state reads. */
export interface TaobaoAuthIssueDeps {
  readonly config: WiredLinkOpenOptions['config'];
  readonly pids: WiredLinkOpenOptions['pids'];
  readonly clock: WiredLinkOpenOptions['clock'];
  readonly appEnv: TaobaoLinkOpenOptions['appEnv'];
  readonly authApps: TaobaoLinkOpenOptions['authApps'];
}

/**
 * 30101 / 30102 with a one-time state bound to uid + device (+ the link an open serves; null for
 * the shop entry, which has no link). A caller that is not the user, or has no usable device,
 * answers 10001; a device without an app client has no authorization path (50301).
 */
export async function issueTaobaoAuthState(
  deps: TaobaoAuthIssueDeps,
  executor: Kysely<DB>,
  input: {
    readonly appId: string;
    readonly caller: { readonly userId: string | null; readonly deviceId: string | null };
    readonly userId: string;
    readonly code: 30101 | 30102;
    readonly linkId: string | null;
  },
): Promise<Extract<LinkOpenAuthorization, { kind: 'refused' }>> {
  const { config, pids, clock, appEnv, authApps } = deps;
  const { appId, caller, userId, code } = input;
  if (caller.deviceId === null || caller.userId !== userId) {
    return { kind: 'refused', code: 10001 };
  }
  let client: AuthClient | 'missing';
  try {
    client = await deviceClientOf(executor, appId, caller.deviceId);
  } catch (error) {
    // A device with no app client (h5 / web) has no authorization path in the open.
    if (error instanceof AuthConfigError) throw paused('linking: no taobao authorization path');
    throw error;
  }
  if (client === 'missing') return { kind: 'refused', code: 10001 };
  const reads = createUnionAuthReads({ db: executor, config, appEnv, pids, clock });
  const methods = await reads.configuredMethods(appId, client);
  const refs = await authAppRefs(authApps, appEnv, appId, client, methods);
  const now = clock.now();
  // A second reading of the injected clock, moved by the TTL (no `new Date` outside the clock).
  const expireAt = clock.now();
  expireAt.setTime(now.getTime() + AUTH_STATE_TTL_MS);
  const state = newAuthState();
  await insertAuthSession(executor, {
    state,
    appId,
    userId,
    deviceId: caller.deviceId,
    platform: PLATFORM,
    client,
    linkId: input.linkId,
    now,
    expireAt,
    methods,
    refs,
  });
  return {
    kind: 'refused',
    code,
    data: { auth_url: syntheticAuthUrl(PLATFORM, state), state, auth_methods: [...methods] },
  };
}

/** now + link.convert_cache_ttl_sec (default and ceiling 900 s), as the jd / pdd plans. */
export async function taobaoJumpExpiry(
  config: WiredLinkOpenOptions['config'],
  clock: WiredLinkOpenOptions['clock'],
  appId: string,
): Promise<Date> {
  const configured = intSetting(
    (await config.configValue(appId, CONVERT_CACHE_TTL_SEC))?.value,
    MAX_CONVERT_CACHE_TTL_SEC,
  );
  const sec =
    configured > 0 && configured <= MAX_CONVERT_CACHE_TTL_SEC
      ? configured
      : MAX_CONVERT_CACHE_TTL_SEC;
  const at = clock.now();
  at.setTime(at.getTime() + sec * 1000);
  return at;
}

/** The Taobao conversion port: admission, authorization and the Baichuan instruction. */
function createTaobaoConversion(
  options: TaobaoLinkOpenOptions,
  admission: WiredConversion['admission'],
) {
  const { clock, logger, authApps, appEnv } = options;
  // Inside the open's transaction these answer only from the pre-reads (link-open-reads.ts).
  const config = openScopedConfig(options.config);
  const pids = openScopedPids(options.pids);
  const authorized = new WeakMap<LinkOpenOwnerResult, TaobaoAuthorized>();

  async function prepare(plan: LinkOpenReadPlan): Promise<void> {
    const { appId } = plan;
    const scenes = new Set<string>(['self_buy']);
    for (const identity of plan.identities) {
      scenes.add(identity.noRebate ? 'self_buy' : identity.pidScene);
    }
    await Promise.allSettled([
      prepareAccountSlots(options.db, pids, { appId, platform: PLATFORM, scenes }),
      config.configValue(appId, SWITCH),
      // B1-06zl: the off reason a switched-off admit answers with.
      config.configValue(appId, convertOffReasonKey(PLATFORM)),
      config.configValue(appId, CONVERT_CACHE_TTL_SEC),
      ...AUTH_CLIENTS.map((client) =>
        config.configValue(appId, `union.taobao.auth_methods.${client}`),
      ),
      ...[...scenes].map((pidScene) =>
        pids.getActivePid({
          appId,
          platform: PLATFORM,
          pidScene: pidScene as PidScene,
          purpose: 'convert',
        }),
      ),
    ]);
  }

  async function admit(owner: LinkOpenOwnerResult, client: LinkOpenConversionInput['client']) {
    const value = await config.configValue(owner.link.app_id, SWITCH);
    if (!isSwitchOn(value?.value)) {
      throw paused(
        'linking: taobao conversion switched off',
        await convertPausedData(config, owner.link.app_id, PLATFORM),
      );
    }
    if (!admission.possible(PLATFORM, client)) {
      // TODO(规划/11 §4.5): 淘宝打开路径的生产放行 — blocked on CAP-TB-11 实测。
      throw paused('linking: no verified taobao jump path for this client');
    }
  }

  /** The scene's slot of the account in use; read only on an allowed branch (B1-22m). */
  const activePid = (appId: string, pidScene: string, accountId: string) =>
    taobaoActivePid(pids, logger, appId, pidScene, accountId);

  /** The snapshot user's own active binding in this app; its relation_id within the contract. */
  const activeRelation = (executor: Kysely<DB>, appId: string, userId: string) =>
    taobaoActiveRelation(executor, logger, appId, userId);

  async function authorize(input: LinkOpenAuthorizationInput): Promise<LinkOpenAuthorization> {
    const { caller, owner, noRebate, executor } = input;
    const { link, identitySnapshot: snapshot } = owner;
    const appId = link.app_id;
    const sharedByOther = snapshot.pid_scene === 'share' && snapshot.user_id !== caller.userId;
    const subject = snapshot.user_id;
    const reads = createUnionAuthReads({ db: executor, config, appEnv, pids, clock });
    // B1-19d: the account this open uses decides the slot; a guest's share link has no binding.
    const { status, accountId: bound } =
      subject === null
        ? { status: 'unbound', accountId: null }
        : await reads.binding(appId, subject, PLATFORM);
    const accountId = await reads.authAccountId(appId, PLATFORM, bound);
    // D10-239 T3c: no Taobao union account at all is a paused conversion, never 30101 / 30102.
    if (accountId === null) {
      logger.warn(
        { event: 'linking.open.no_union_account', app_id: appId, platform: PLATFORM },
        'linking: no taobao union account for the open',
      );
      throw paused('linking: no taobao union account');
    }
    // ⑦ The slot of the account in use, read only once the gate below lets the open through.
    const slotScene = noRebate ? 'self_buy' : snapshot.pid_scene;
    const slotOf = () => activePid(appId, slotScene, accountId);
    const unattributed = async (): Promise<TaobaoAuthorized> => ({
      relationId: null,
      bindingAccountId: null,
      slot: await slotOf(),
    });
    if (subject === null) {
      // Only a guest's unclaimed share link can name no user: its sharer has no binding.
      if (sharedByOther)
        return { kind: 'refused', code: 30102, data: { reason: 'sharer_auth_invalid' } };
      throw new Error('linking: an own taobao open without a snapshot user');
    }

    if (status === 'active') {
      // no_rebate carries no user parameter, so it needs no relation_id.
      const relation = noRebate ? null : await activeRelation(executor, appId, subject);
      authorized.set(
        owner,
        relation === null ? await unattributed() : { ...relation, slot: await slotOf() },
      );
      return { kind: 'allowed' };
    }
    // BR-ATTR-05 细则「别人的分享 link 不可用」: the sharer's status is never disclosed.
    if (sharedByOther) {
      return { kind: 'refused', code: 30102, data: { reason: 'sharer_auth_invalid' } };
    }
    if (status === 'blocked') {
      // BR-ID-18: an explicit no_rebate purchase goes out; the reason is the server's.
      if (noRebate) {
        authorized.set(owner, await unattributed());
        return { kind: 'allowed', noRebateReason: 'binding_blocked' };
      }
      // A banned user has no session (BR-ID-31); one still reaching here asks to log in.
      if (await reads.userBanned(appId, subject)) return { kind: 'refused', code: 10001 };
      return { kind: 'refused', code: 30153 };
    }
    const code = status === 'invalid' ? 30102 : 30101;
    // BR-ID-24 ④: the exception holds for no_rebate too.
    if (!(await reads.siteAuthAvailable(appId, PLATFORM, accountId))) {
      return { kind: 'refused', code, data: { reason: 'auth_unavailable' } };
    }
    if (noRebate) {
      authorized.set(owner, await unattributed());
      return { kind: 'allowed' };
    }
    return issue(executor, caller, owner, subject, code);
  }

  /** 30101 / 30102 with a one-time state bound to uid + device + the link this open serves. */
  function issue(
    executor: Kysely<DB>,
    caller: LinkOpenAuthorizationInput['caller'],
    owner: LinkOpenOwnerResult,
    userId: string,
    code: 30101 | 30102,
  ): Promise<LinkOpenAuthorization> {
    return issueTaobaoAuthState({ config, pids, clock, appEnv, authApps }, executor, {
      appId: owner.link.app_id,
      caller,
      userId,
      code,
      linkId: owner.link.link_id,
    });
  }

  /** now + link.convert_cache_ttl_sec (default and ceiling 900 s), as the jd / pdd plans. */
  const jumpExpiry = (appId: string) => taobaoJumpExpiry(config, clock, appId);

  async function convert(input: LinkOpenConversionInput): Promise<LinkOpenJump> {
    const { owner, noRebate, client } = input;
    const { link, identitySnapshot: snapshot } = owner;
    const appId = link.app_id;
    const decided = authorized.get(owner);
    if (decided === undefined) throw paused('linking: taobao open converted without authorization');
    const nowMs = clock.now().getTime();
    const expireAt = await jumpExpiry(appId);
    // Our promotion link only for this link's own user and scene, never for no_rebate.
    const promo =
      !noRebate && link.user_id === snapshot.user_id && link.pid_scene === snapshot.pid_scene
        ? promoOf(link, nowMs)
        : null;
    let steps: Step[];
    if (promo !== null) {
      // The plan never outlives the promotion link's W_link.
      if (link.expire_at.getTime() < expireAt.getTime()) expireAt.setTime(link.expire_at.getTime());
      const h5: Step = { type: 'h5', value: promo };
      steps =
        client === 'h5' || client === 'web'
          ? [h5]
          : [
              {
                type: 'sdk',
                value: promo,
                sdk: { provider: 'baichuan', open_by: 'url', url: promo },
              },
              h5,
            ];
    } else {
      if (client === 'h5' || client === 'web') {
        throw paused('linking: no taobao path for this client without our promotion link');
      }
      const itemId = link.raw_item_id;
      if (itemId === null || itemId === '' || itemId.length > ITEM_MAX) {
        throw new Error('linking: link has no taobao item id for the instruction');
      }
      if (!noRebate && decided.relationId === null) {
        throw paused('linking: no relation_id for an attributed taobao open');
      }
      const taoke = taobaoTaoke(noRebate ? { ...decided, relationId: null } : decided);
      if (taoke === null) {
        logger.warn(
          {
            event: 'linking.open.pid_account_mismatch',
            app_id: appId,
            platform: PLATFORM,
            pid_scene: snapshot.pid_scene,
          },
          'linking: the active taobao slot belongs to another union account than the binding',
        );
        throw paused('linking: active promotion slot of another union account');
      }
      steps = [
        {
          type: 'sdk',
          value: itemId,
          sdk: {
            provider: 'baichuan',
            open_by: 'code',
            page: 'detail',
            item_id: itemId,
            taoke,
          },
        },
      ];
    }
    const [primary, ...fallbacks] = steps as [Step, ...Step[]];
    const jump: LinkOpenJump = { primary, fallbacks, expire_at: expireAt.toISOString() };
    const admitted = admission.jump(PLATFORM, client, jump);
    if (admitted === null) throw paused('linking: no verified taobao jump path for this client');
    return admitted;
  }

  function cacheTag(owner: LinkOpenOwnerResult, noRebate: boolean): string | undefined {
    return taobaoCacheTag(authorized.get(owner), noRebate);
  }

  return { prepare, admit, authorize, cacheTag, convert };
}

/**
 * The open's conversion port over the wired jd / pdd one: Taobao's instruction and
 * authorization, Pinduoduo's filing check. Shared by the open and the convert (B1-06i), so the
 * two never judge differently.
 */
export function composeTaobaoConversion(
  options: TaobaoLinkOpenOptions,
  wired: WiredConversion,
): LinkOpenConversionPort {
  const taobao = createTaobaoConversion(options, wired.admission);
  // B1-06v (ruling D7-11 ⑨): Pinduoduo opens get the Pinduoduo filing check; jd passes.
  const pdd = createPddAuthorization(options);
  const isTaobao = (owner: LinkOpenOwnerResult) => owner.link.platform === PLATFORM;
  return {
    variant: wired.conversion.variant,
    async prepare(plan) {
      await Promise.allSettled([
        wired.conversion.prepare(plan),
        pdd.prepare(plan),
        ...(plan.platform === PLATFORM ? [taobao.prepare(plan)] : []),
      ]);
    },
    admit: (owner, client) =>
      isTaobao(owner) ? taobao.admit(owner, client) : wired.conversion.admit(owner, client),
    authorize: (input) => (isTaobao(input.owner) ? taobao.authorize(input) : pdd.authorize(input)),
    cacheTag: (owner, noRebate) =>
      isTaobao(owner) ? taobao.cacheTag(owner, noRebate) : pdd.cacheTag(owner, noRebate),
    convert: (input) =>
      isTaobao(input.owner) ? taobao.convert(input) : wired.conversion.convert(pdd.scoped(input)),
  };
}

export function createTaobaoLinkOpen(options: TaobaoLinkOpenOptions): LinkOpenService {
  return createWiredLinkOpen(options, (wired) => composeTaobaoConversion(options, wired));
}
