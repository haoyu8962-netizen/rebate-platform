// B1-06zg (S-17 S17-l1, D10-806 / D10-891 ②): 进店 POST /v1/products/{product_key}/shop/open
// (contracts/openapi.yaml openProductShop; BR-PRICE-21 细则「进店」, BR-ATTR-05 / BR-ATTR-08 进店例外,
// BR-ID-18 进店例外). Rule tests: test/spec/linking/shop-open/**.
// Order of one shop entry (each refusal answers before any later stage runs):
// not logged in (10001) → idempotency (replay / 20901 / 40901, platform idempotency) →
// shop.entry.enabled.<platform> strictly true and shop.entry.source.<platform> one of the
// adapter's shopConvertSources (else 30146 shop_entry_disabled) → convert.enabled.<platform>
// (50301, as the open) → the account in use (none → 50301) → authorization as the Taobao open
// (blocked → 30153; unbound / pending_auth / released → 30101, invalid → 30102, with a one-time
// state bound to uid + device and no link, or reason=auth_unavailable while the site
// authorization is expired; there is no no_rebate shop entry) → the caller's active relation_id
// and the self_buy slot of that binding's account (link-open-taobao.ts shared functions; none →
// 50301) → catalog's shopOf (null → 30146 shop_unavailable) → the reused plan within its
// expire_at, else the adapter's convertShop (any failure, or no convertShop → 50303) → jump.
// No link is registered, no link_logs / quote snapshot / link_jump, no scene (self_buy fixed);
// no refusal carries a shop address or any jump (确保转链).
// r2: the standard idempotency mode runs the entry; an attempt that must issue an authorization
// state reruns in the transactional mode so the state commits with the stored result, and the
// conversion never runs while a transaction is held (runShopEntry).
import type { DB } from '@couli/db';
import type { components } from '@couli/contracts-ts';
import type { Kysely } from 'kysely';
import type { ShopOf } from '../../catalog/index.ts';
import type {
  AppEnv,
  Clock,
  HandlerResult,
  Idempotency,
  IdempotentRequest,
  IdempotentResponse,
} from '../../platform/index.ts';
import {
  UnionIdentity,
  type CallCtx,
  type RegisteredPlatform,
  type UnionAdapter,
  type UnionPidService,
  type UnionRegistry,
} from '../../union/index.ts';
import { isSwitchOn } from '../domain/rules.ts';
import type { CallerContext, LinkingConfigReader } from '../ports.ts';
import { convertPausedData } from './convert-paused.ts';
import type { LinkOpenInput } from './link-open.ts';
import {
  isTaobaoPaused,
  issueTaobaoAuthState,
  taobaoActivePid,
  taobaoActiveRelation,
  taobaoJumpExpiry,
  taobaoTaoke,
} from './link-open-taobao.ts';
import { createUnionAuthReads } from './union-auth-reads.ts';
import type { UnionAuthAppsPort } from './union-auth-state.ts';

/** The jump plan of a shop entry (contracts JumpPlan, same shape as open). */
export type ShopOpenJump = components['schemas']['JumpPlan'];

/** The contract body of openProductShop, installed already defaulted to unknown by the controller. */
export type ShopOpenBody = components['schemas']['ShopOpenRequest'];

export interface ShopOpenInput {
  /** The path's product_key, decoded. */
  readonly productKey: string;
  readonly body: ShopOpenBody;
  readonly idempotencyKey: string;
  readonly traceId: string;
  /** Server-resolved client (X-Platform), never a body field. */
  readonly client: LinkOpenInput['client'];
}

/**
 * Reuse key of a converted shop link: the same app, union account, promotion slot, relation id and
 * shop within the plan's expire_at reuse the plan without calling convertShop again.
 */
export interface ShopOpenCacheKey {
  readonly appId: string;
  readonly platform: string;
  readonly unionAccountId: string;
  readonly pid: string;
  readonly relationId: string;
  readonly shopRef: string;
}

/**
 * Store of converted shop plans. It applies no TTL and no identity policy of its own: the service
 * checks the stored plan's expire_at against the injected clock.
 */
export interface ShopOpenCache {
  get(key: ShopOpenCacheKey): Promise<ShopOpenJump | null>;
  put(key: ShopOpenCacheKey, jump: ShopOpenJump): Promise<void>;
}

/** catalog's read-only shop port (B1-05zm, catalog/index.ts createShopOf). */
export interface ShopOpenShops {
  readonly shopOf: ShopOf;
}

export interface ShopOpenOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly callerContext: CallerContext;
  readonly config: LinkingConfigReader;
  readonly pids: Pick<UnionPidService, 'getActivePid'>;
  /** The governed adapters; only shopConvertSources and convertShop are used. */
  readonly registry: Pick<UnionRegistry, 'get'>;
  readonly shops: ShopOpenShops;
  readonly cache: ShopOpenCache;
  readonly idempotency: Pick<Idempotency, 'execute' | 'executeInTransaction'>;
  readonly logger: { warn(fields: Readonly<Record<string, unknown>>, message: string): void };
  readonly appEnv: AppEnv;
  readonly authApps: UnionAuthAppsPort;
}

/** HTTP injection token. The controller takes identity from CallerContext, never body fields. */
export class ShopOpenService {
  open(input: ShopOpenInput): Promise<HandlerResult> {
    void input;
    return Promise.reject(new Error('linking: shop open service is not composed in this process'));
  }
}

/**
 * The server-built identity of a shop conversion (BR-ATTR-05 进店例外): the caller's own user id
 * and active relation_id, with the self_buy slot of that binding's account. Built here only.
 */
class ShopUnionIdentity extends UnionIdentity {
  constructor(claims: {
    readonly appId: string;
    readonly userId: string;
    readonly promotionSlot: string;
    readonly relationId: string;
  }) {
    super({ ...claims, platform: 'taobao' });
  }
}

const PLATFORM = 'taobao';
const URL_MAX = 2048;

/** HTTP status per contracts/error-codes.yaml for every code a shop entry answers. */
const STATUS: Readonly<Record<number, number>> = {
  0: 200,
  10001: 401,
  30101: 422,
  30102: 422,
  30146: 422,
  30153: 422,
  50301: 503,
  50303: 503,
};

/** Fallback texts only; clients show the dictionary text error.<code> (BR-TEXT-14). */
const MESSAGES: Readonly<Record<number, string>> = {
  0: 'ok',
  10001: '请先登录',
  30101: '请先授权淘宝',
  30102: '淘宝授权已失效，请重新授权',
  30146: '暂时不能进入这家店铺',
  30153: '该平台返利已被停用，请联系客服',
  50301: '该平台暂时无法购买，请稍后再试',
  50303: '暂时不能进入这家店铺',
};

type Refusal = {
  readonly code: number;
  readonly data?: Readonly<Record<string, unknown>>;
};

class Refused extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(`linking: shop entry refused with ${refusal.code}`);
    this.refusal = refusal;
  }
}

function refuse(code: number, data?: Readonly<Record<string, unknown>>): never {
  throw new Refused(data === undefined ? { code } : { code, data });
}

function result(traceId: string, code: number, data?: unknown): HandlerResult {
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

/** The converted shop link: an absolute https URL of at most 2048 characters, else null. */
function shopUrlOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > URL_MAX) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.host !== '' ? value : null;
  } catch {
    return null;
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** The error class only: an upstream message may carry a shop address and is never logged. */
function reasonOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * Signal of a standard-mode attempt that reached the issuing of a one-time authorization state:
 * the attempt stores nothing, and the entry is run again in the transactional mode, so the state
 * and the stored result commit together (AGENTS.md §4 幂等落在 PG; a retry of the same key after a
 * lost first attempt finds either nothing — the state rolled back with it — or the stored state).
 */
export class ShopEntryNeedsAuthState extends Error {
  constructor() {
    super('linking: the shop entry issues an authorization state in a transaction');
    this.name = 'ShopEntryNeedsAuthState';
  }
}

/**
 * Signal of a transactional attempt that found the binding active (it changed since the standard
 * attempt): the conversion is never called while a transaction is held, so it rolls back and the
 * entry is run again in the standard mode.
 */
export class ShopEntryNeedsConvert extends Error {
  constructor() {
    super('linking: the shop entry converts outside any transaction');
    this.name = 'ShopEntryNeedsConvert';
  }
}

/** How one attempt of a shop entry runs: its executor and what it may do. */
export type ShopEntryMode = 'standard' | 'transactional' | 'final';

/**
 * Runs one shop entry under the idempotency record. The standard mode first (no transaction held
 * while the upstream conversion runs); when that attempt has to issue an authorization state it
 * throws ShopEntryNeedsAuthState (nothing stored, the processing row deleted) and the entry runs
 * again in the transactional mode, where the state is written through `trx` and commits with the
 * stored result. A transactional attempt that finds the binding active throws
 * ShopEntryNeedsConvert (rolled back) and one last standard attempt runs ('final': a second flip
 * answers 50301 unstored, so the loop is bounded).
 */
export async function runShopEntry(
  idempotency: Pick<Idempotency, 'execute' | 'executeInTransaction'>,
  request: IdempotentRequest,
  stage: (executor: Kysely<DB> | null, mode: ShopEntryMode) => Promise<HandlerResult>,
): Promise<IdempotentResponse> {
  try {
    return await idempotency.execute(request, () => stage(null, 'standard'));
  } catch (error) {
    if (!(error instanceof ShopEntryNeedsAuthState)) throw error;
  }
  try {
    return await idempotency.executeInTransaction(request, (trx) => stage(trx, 'transactional'));
  } catch (error) {
    if (!(error instanceof ShopEntryNeedsConvert)) throw error;
  }
  return idempotency.execute(request, () => stage(null, 'final'));
}

class ComposedShopOpen extends ShopOpenService {
  readonly #options: ShopOpenOptions;

  constructor(options: ShopOpenOptions) {
    super();
    this.#options = options;
  }

  override async open(input: ShopOpenInput): Promise<HandlerResult> {
    const { callerContext, idempotency } = this.#options;
    const caller = await callerContext.current();
    // BR-ID-02 进店行: login first, before any switch, authorization or idempotency record.
    if (caller.userId === null) return result(input.traceId, 10001);
    const userId = caller.userId;
    const request: IdempotentRequest = {
      appId: caller.appId,
      actor: { userId, deviceId: caller.deviceId, phoneHmac: null },
      method: 'POST',
      path: `/v1/products/${encodeURIComponent(input.productKey)}/shop/open`,
      key: input.idempotencyKey,
      body: input.body,
      traceId: input.traceId,
    };
    const response = await runShopEntry(idempotency, request, async (executor, mode) => {
      try {
        const jump = await this.#enter(input, { ...caller, userId }, executor, mode);
        return result(input.traceId, 0, { jump });
      } catch (error) {
        if (error instanceof Refused) {
          return result(input.traceId, error.refusal.code, error.refusal.data);
        }
        if (isTaobaoPaused(error)) return result(input.traceId, 50301);
        // A binding that flipped twice between attempts: unstored, the client may retry.
        if (mode === 'final' && error instanceof ShopEntryNeedsAuthState) {
          return result(input.traceId, 50301);
        }
        throw error;
      }
    });
    // Handler and replay alike: the stored body is the result, so a replay equals the first.
    const envelope = JSON.parse(response.body) as HandlerResult['envelope'];
    return { status: response.status, envelope };
  }

  /** The adapter of the platform when its shop entry is switched on with a declared source. */
  async #admit(appId: string, platform: string): Promise<UnionAdapter> {
    const { config, registry } = this.#options;
    const disabled = () => refuse(30146, { platform, reason: 'shop_entry_disabled' });
    // Default off (BR-PRICE-21 细则「进店」): only a strict true opens it.
    const enabled = await config.configValue(appId, `shop.entry.enabled.${platform}`);
    if (enabled?.value !== true) disabled();
    const source = (await config.configValue(appId, `shop.entry.source.${platform}`))?.value;
    if (!nonEmpty(source)) disabled();
    let adapter: UnionAdapter;
    try {
      adapter = registry.get(platform as RegisteredPlatform);
    } catch {
      return disabled();
    }
    const sources: readonly string[] = adapter.shopConvertSources ?? [];
    if (!sources.includes(source as string)) disabled();
    // TODO(规划/11 §2.3): 京东、拼多多进店的身份构造 — blocked on 09 登记两平台店铺推广链接的归因方式;
    // until then only Taobao's identity (the Taobao open's) is built.
    if (platform !== PLATFORM) disabled();
    return adapter;
  }

  async #enter(
    input: ShopOpenInput,
    caller: { readonly appId: string; readonly userId: string; readonly deviceId: string | null },
    executor: Kysely<DB> | null,
    mode: ShopEntryMode,
  ): Promise<ShopOpenJump> {
    const { clock, config, pids, shops, cache, logger, appEnv, authApps } = this.#options;
    const { appId, userId } = caller;
    const platform = input.body.platform;
    const adapter = await this.#admit(appId, platform);
    // convert.enabled.<platform> as the open (50301).
    // B1-06zl: data exactly { platform, reason }, reason from convert.off_reason.<platform>.
    if (!isSwitchOn((await config.configValue(appId, `convert.enabled.${PLATFORM}`))?.value)) {
      refuse(50301, { ...(await convertPausedData(config, appId, PLATFORM)) });
    }

    // Authorization as the Taobao open (link-open-taobao.ts authorize), the caller as subject;
    // the shop entry has no no_rebate branch (BR-ID-18 进店例外) and no sharer.
    // The transactional attempt reads and writes through its `trx` only.
    const db = executor ?? this.#options.db;
    const reads = createUnionAuthReads({ db, config, appEnv, pids, clock });
    const { status, accountId: bound } = await reads.binding(appId, userId, PLATFORM);
    const accountId = await reads.authAccountId(appId, PLATFORM, bound);
    if (accountId === null) {
      logger.warn(
        { event: 'linking.shop_open.no_union_account', app_id: appId, platform: PLATFORM },
        'linking: no taobao union account for the shop entry',
      );
      refuse(50301);
    }
    if (status === 'blocked') {
      // A banned user has no session (BR-ID-31); one still reaching here asks to log in.
      refuse((await reads.userBanned(appId, userId)) ? 10001 : 30153);
    }
    if (status !== 'active') {
      const code = status === 'invalid' ? 30102 : 30101;
      // BR-ID-24 ④: while the site authorization is expired, no state is issued.
      if (!(await reads.siteAuthAvailable(appId, PLATFORM, accountId))) {
        refuse(code, { reason: 'auth_unavailable' });
      }
      // The state is written only through the transaction that stores the result.
      if (mode !== 'transactional' || executor === null) throw new ShopEntryNeedsAuthState();
      const issued = await issueTaobaoAuthState({ config, pids, clock, appEnv, authApps }, db, {
        appId,
        caller,
        userId,
        code,
        linkId: null,
      });
      refuse(issued.code, issued.data);
    }
    // Never convert while holding the transaction: roll back and convert in the standard mode.
    if (mode === 'transactional') throw new ShopEntryNeedsConvert();

    // BR-ATTR-05 / BR-ATTR-08 进店例外: the caller's own relation_id with the self_buy slot of the
    // binding's account, the Taobao open's identity construction (taobaoTaoke's account check).
    const relation = await taobaoActiveRelation(db, logger, appId, userId);
    const slot = await taobaoActivePid(pids, logger, appId, 'self_buy', accountId);
    const taoke = taobaoTaoke({ ...relation, slot });
    if (taoke === null || taoke.relation_id === undefined) {
      logger.warn(
        {
          event: 'linking.shop_open.pid_account_mismatch',
          app_id: appId,
          platform: PLATFORM,
          pid_scene: 'self_buy',
        },
        'linking: the active taobao slot belongs to another union account than the binding',
      );
      refuse(50301);
    }

    const shop = await shops.shopOf(
      appId,
      input.productKey,
      ...(input.body.item_ref === undefined ? [] : [input.body.item_ref]),
    );
    if (shop === null || !nonEmpty(shop.shopRef) || !nonEmpty(shop.shopName)) {
      refuse(30146, { platform, reason: 'shop_unavailable' });
    }

    const key: ShopOpenCacheKey = {
      appId,
      platform: PLATFORM,
      unionAccountId: relation.bindingAccountId,
      pid: taoke.pid,
      relationId: taoke.relation_id,
      shopRef: shop.shopRef,
    };
    const cached = await cache.get(key);
    if (cached !== null && Date.parse(cached.expire_at) > clock.now().getTime()) return cached;

    const url = await this.#convert(adapter, input, {
      appId,
      userId,
      promotionSlot: taoke.pid,
      relationId: taoke.relation_id,
      shop,
    });
    const expireAt = await taobaoJumpExpiry(config, clock, appId);
    const h5 = { type: 'h5', value: url } as const;
    const jump: ShopOpenJump = {
      primary:
        input.client === 'h5' || input.client === 'web'
          ? h5
          : { type: 'sdk', value: url, sdk: { provider: 'baichuan', open_by: 'url', url } },
      fallbacks: input.client === 'h5' || input.client === 'web' ? [] : [h5],
      expire_at: expireAt.toISOString(),
    };
    await cache.put(key, jump);
    return jump;
  }

  /** convertShop with the server-built identity; any failure is 50303 with no address. */
  async #convert(
    adapter: UnionAdapter,
    input: ShopOpenInput,
    claims: {
      readonly appId: string;
      readonly userId: string;
      readonly promotionSlot: string;
      readonly relationId: string;
      readonly shop: { readonly shopRef: string; readonly shopName: string };
    },
  ): Promise<string> {
    const { logger } = this.#options;
    const { appId, shop } = claims;
    const failed = (reason: string): never => {
      logger.warn(
        { event: 'linking.shop_open.convert_failed', app_id: appId, platform: PLATFORM, reason },
        'linking: shop conversion failed; no shop address is returned',
      );
      return refuse(50303);
    };
    if (typeof adapter.convertShop !== 'function') return failed('no_convert_shop');
    const identity = new ShopUnionIdentity({
      appId,
      userId: claims.userId,
      promotionSlot: claims.promotionSlot,
      relationId: claims.relationId,
    });
    const ctx: CallCtx = { appId, requestId: input.traceId, purpose: 'online' };
    let converted: unknown;
    try {
      converted = await adapter.convertShop(
        { shopRef: shop.shopRef, shopName: shop.shopName },
        identity,
        ctx,
      );
    } catch (error) {
      return failed(reasonOf(error));
    }
    const url = shopUrlOf((converted as { readonly url?: unknown } | null)?.url);
    return url ?? failed('invalid_result');
  }
}

export function createShopOpen(options: ShopOpenOptions): ShopOpenService {
  return new ComposedShopOpen(options);
}
